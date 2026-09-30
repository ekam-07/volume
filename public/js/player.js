import * as cache from './cache.js';

/**
 * Synchronised playback of a pre-downloaded track.
 *
 * Getting phones to start together is only half the problem. Each phone's
 * audio hardware runs off its own crystal, so after a minute two devices that
 * started perfectly aligned can be tens of milliseconds apart — which is the
 * difference between "one speaker" and "a flanger effect". So the player does
 * two things:
 *
 *   1. Starts at an exact instant on the shared clock, mapped through the
 *      device's real output latency.
 *   2. Keeps measuring where its own audio hardware has actually got to, and
 *      pulls itself back with tiny playback-rate nudges — or a hard reseek if
 *      it has fallen too far behind to nudge.
 */

/** Drift beyond this is corrected by restarting rather than nudging. */
const HARD_RESYNC_S = 0.06;
/** Drift below this is left alone; correcting it would be audible churn. */
const DEADBAND_S = 0.004;
/** Ceiling on the rate nudge. 0.4% is inaudible; 2% is a detuned instrument. */
const MAX_RATE_TRIM = 0.004;
const DRIFT_INTERVAL_MS = 500;

export class SyncPlayer extends EventTarget {
  /** @param {import('./sync.js').Clock} clock */
  constructor(clock) {
    super();
    this.clock = clock;
    this.ctx = null;
    this.buffer = null;
    this.trackId = null;
    this.source = null;

    this.channel = 'stereo';
    this.gain = 1;
    this.muted = false;
    /** Per-device latency trim in ms. Positive means "this phone is late". */
    this.calibrationMs = 0;

    this.driftMs = 0;
    this.playing = false;

    this._anchorServerTime = 0;
    this._anchorOffset = 0;
    this._loop = false;
    this._startCtxTime = 0;
    this._startTrackOffset = 0;
    this._rate = 1;
    this._driftTimer = null;
    this._chain = [];
  }

  /**
   * Must be called from a user gesture. iOS will not let an AudioContext make
   * sound otherwise, and silently plays nothing rather than telling you.
   */
  async unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'playback' });
      this.input = this.ctx.createGain();
      this.input.channelCount = 2;
      this.input.channelCountMode = 'explicit';
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this._route(this.channel);
      this._applyGain();
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();

    // A zero-length blip completes the unlock on stubborn iOS versions.
    const blip = this.ctx.createBufferSource();
    blip.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    blip.connect(this.ctx.destination);
    blip.start(0);

    this._startDriftLoop();
    return this.ctx.state === 'running';
  }

  get ready() {
    return this.ctx?.state === 'running';
  }

  get outputLatencyMs() {
    if (!this.ctx) return 0;
    return ((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000;
  }

  // -- loading -------------------------------------------------------------

  /**
   * Download and decode a track in full before it is ever needed. Decoding
   * ahead of time is what makes tight sync possible: at the moment playback
   * starts, no phone is waiting on the network or the decoder.
   *
   * A phone that already holds the track skips the network entirely — see
   * cache.js. This is what makes a second listen, a page reload or a rejoin
   * instant instead of a fresh download.
   */
  async load(track, onProgress) {
    if (this.trackId === track.id && this.buffer) return this.buffer;
    if (!this.ctx) throw new Error('call unlock() first');

    const cached = await cache.get(track.id);
    if (cached) {
      onProgress?.(1, { fromCache: true });
      const buffer = await this.ctx.decodeAudioData(cached.slice(0));
      this.buffer = buffer;
      this.trackId = track.id;
      this.dispatchEvent(
        new CustomEvent('loaded', { detail: { track, duration: buffer.duration, fromCache: true } }),
      );
      return buffer;
    }

    const res = await fetch(track.url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);

    const total = Number(res.headers.get('content-length')) || track.bytes || 0;
    let received = 0;
    const chunks = [];
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(total ? received / total : 0);
    }

    const bytes = new Uint8Array(received);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }

    // decodeAudioData detaches the buffer it is given, so hand the cache its
    // own copy before decoding rather than after.
    await cache.put(track.id, bytes.buffer.slice(0));

    const buffer = await this.ctx.decodeAudioData(bytes.buffer);
    this.buffer = buffer;
    this.trackId = track.id;
    this.dispatchEvent(
      new CustomEvent('loaded', { detail: { track, duration: buffer.duration, fromCache: false } }),
    );
    return buffer;
  }

  get duration() {
    return this.buffer?.duration ?? 0;
  }

  // -- clock bridging ------------------------------------------------------

  /**
   * Relate the audio clock to the wall clock at the point sound leaves the
   * speaker. `getOutputTimestamp` reports exactly that — which sample was
   * audible, and when — so it already accounts for the output buffer. Where
   * it is missing or stubbed out, fall back to the declared latency.
   */
  _mapping() {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
      return { ctxTime: ts.contextTime, perfTime: ts.performanceTime };
    }
    return {
      ctxTime: this.ctx.currentTime,
      perfTime: performance.now() + this.outputLatencyMs,
    };
  }

  /** The AudioContext time at which audio must be scheduled to be *heard* at `serverTime`. */
  serverToCtx(serverTime) {
    const m = this._mapping();
    return m.ctxTime + (this.clock.toLocal(serverTime) - m.perfTime) / 1000;
  }

  // -- transport -----------------------------------------------------------

  /** Apply a room playback state. Idempotent — safe to call on every update. */
  apply(playback) {
    if (!this.ctx || !this.buffer) return;
    if (playback.trackId !== this.trackId) return;

    this._loop = Boolean(playback.loop);

    if (!playback.playing) {
      this.stop();
      this._anchorServerTime = playback.anchorServerTime;
      this._anchorOffset = playback.trackOffset;
      return;
    }

    const changed =
      !this.playing ||
      Math.abs(playback.anchorServerTime - this._anchorServerTime) > 1 ||
      Math.abs(playback.trackOffset - this._anchorOffset) > 0.001;
    if (!changed) return;

    this._anchorServerTime = playback.anchorServerTime;
    this._anchorOffset = playback.trackOffset;
    this._start();
  }

  _start() {
    this._teardownSource();

    // A positive calibration means this phone is heard late, so aim earlier.
    const targetServerTime = this._anchorServerTime - this.calibrationMs;
    let ctxStart = this.serverToCtx(targetServerTime);
    let trackOffset = this._anchorOffset;

    const earliest = this.ctx.currentTime + 0.03;
    if (ctxStart < earliest) {
      // The command arrived after its own start time — a late joiner, or a
      // phone that was backgrounded. Skip into the track instead of starting
      // late, so it lands in the same place as everyone else.
      trackOffset += earliest - ctxStart;
      ctxStart = earliest;
    }

    if (this._loop && this.buffer.duration > 0) {
      trackOffset %= this.buffer.duration;
    } else if (trackOffset >= this.buffer.duration) {
      this.stop();
      return;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.loop = this._loop;
    source.connect(this.input);
    source.onended = () => {
      if (this.source === source && !this._loop) {
        this.playing = false;
        this.dispatchEvent(new CustomEvent('ended'));
      }
    };
    source.start(ctxStart, trackOffset);

    this.source = source;
    this.playing = true;
    this._rate = 1;
    this._startCtxTime = ctxStart;
    this._startTrackOffset = trackOffset;
    this.driftMs = 0;
    this.dispatchEvent(new CustomEvent('started'));
  }

  stop() {
    this._teardownSource();
    this.playing = false;
    this.driftMs = 0;
    this.dispatchEvent(new CustomEvent('stopped'));
  }

  _teardownSource() {
    if (!this.source) return;
    const source = this.source;
    this.source = null;
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* never started */
    }
    try {
      source.disconnect();
    } catch {
      /* already detached */
    }
  }

  // -- drift correction ----------------------------------------------------

  _startDriftLoop() {
    clearInterval(this._driftTimer);
    this._driftTimer = setInterval(() => this._correctDrift(), DRIFT_INTERVAL_MS);
  }

  _correctDrift() {
    if (!this.playing || !this.source || !this.ctx) return;

    const m = this._mapping();
    const duration = this.buffer.duration;

    // Where this phone's hardware actually is, at the speaker.
    let actual = this._startTrackOffset + (m.ctxTime - this._startCtxTime) * this._rate;

    // Where the room says it should be, at that same instant.
    const serverAtOutput = this.clock.toServer(m.perfTime);
    let expected =
      this._anchorOffset +
      (serverAtOutput - (this._anchorServerTime - this.calibrationMs)) / 1000;

    if (this._loop && duration > 0) {
      actual = mod(actual, duration);
      expected = mod(expected, duration);
      // Do not read a wrap-around as a full-track drift.
      if (Math.abs(actual - expected) > duration / 2) {
        actual += actual < expected ? duration : -duration;
      }
    }

    const drift = actual - expected;
    this.driftMs = drift * 1000;

    if (!Number.isFinite(drift)) return;

    if (Math.abs(drift) > HARD_RESYNC_S) {
      this._start();
      return;
    }

    // Re-anchor the position maths at "now" before changing rate, so the two
    // stay consistent across the change.
    const nowCtx = this.ctx.currentTime;
    const posNow = this._startTrackOffset + (nowCtx - this._startCtxTime) * this._rate;

    let rate = 1;
    if (Math.abs(drift) > DEADBAND_S) {
      // Aim to absorb the error over roughly two correction cycles.
      const correction = -drift / (2 * (DRIFT_INTERVAL_MS / 1000));
      rate = 1 + clamp(correction, -MAX_RATE_TRIM, MAX_RATE_TRIM);
    }

    if (Math.abs(rate - this._rate) > 1e-6) {
      try {
        this.source.playbackRate.setValueAtTime(rate, nowCtx);
      } catch {
        this.source.playbackRate.value = rate;
      }
      this._rate = rate;
      this._startCtxTime = nowCtx;
      this._startTrackOffset = posNow;
    }

    this.dispatchEvent(new CustomEvent('drift', { detail: { driftMs: this.driftMs } }));
  }

  /** Current playhead in seconds, for the UI. */
  position() {
    if (!this.buffer) return 0;
    const base = this.playing
      ? this._anchorOffset + (this.clock.now() - this._anchorServerTime) / 1000
      : this._anchorOffset;
    if (this._loop && this.buffer.duration > 0) return mod(base, this.buffer.duration);
    return clamp(base, 0, this.buffer.duration);
  }

  // -- mixing --------------------------------------------------------------

  setChannel(channel) {
    if (channel === this.channel) return;
    this.channel = channel;
    if (this.ctx) this._route(channel);
  }

  /**
   * Split phones across the stereo image. Assigning half the room to "left"
   * and half to "right" is what makes a pile of phones sound wide rather than
   * merely loud. A side-assigned phone plays that one channel through both of
   * its own outputs.
   */
  _route(channel) {
    try {
      this.input.disconnect();
    } catch {
      /* nothing connected yet */
    }
    for (const node of this._chain) {
      try {
        node.disconnect();
      } catch {
        /* already detached */
      }
    }
    this._chain = [];

    if (channel === 'left' || channel === 'right') {
      const splitter = this.ctx.createChannelSplitter(2);
      const merger = this.ctx.createChannelMerger(2);
      const side = channel === 'left' ? 0 : 1;
      this.input.connect(splitter);
      splitter.connect(merger, side, 0);
      splitter.connect(merger, side, 1);
      merger.connect(this.master);
      this._chain = [splitter, merger];
    } else {
      this.input.connect(this.master);
    }
  }

  setGain(gain) {
    this.gain = clamp(gain, 0, 1);
    this._applyGain();
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    this._applyGain();
  }

  /**
   * Apply a speaker-latency trim. A restart is audible, so a small change is
   * handed to the drift loop instead: it already measures against the trim, so
   * it will glide the playhead across over the next second or so. Only a
   * correction too large to nudge away is worth a restart.
   */
  setCalibration(ms) {
    const next = clamp(ms, -500, 500);
    const delta = next - this.calibrationMs;
    if (delta === 0) return;
    this.calibrationMs = next;
    if (this.playing && Math.abs(delta) > HARD_RESYNC_S * 1000) this._start();
  }

  _applyGain() {
    if (!this.master) return;
    const target = this.muted ? 0 : this.gain;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(target, now + 0.05);
  }

  destroy() {
    clearInterval(this._driftTimer);
    this._teardownSource();
    this.ctx?.close?.();
  }
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function mod(n, m) {
  return ((n % m) + m) % m;
}
