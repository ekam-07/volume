/**
 * Live mode: the host's microphone (or a shared tab's audio) streamed to every
 * phone in near real time.
 *
 * This is a fundamentally looser kind of sync than file mode. In file mode
 * every phone already holds the whole song, so "start at 14:32:05.250" is all
 * the coordination anyone needs. Here the audio is still arriving while it
 * plays, so each phone has to hold a jitter buffer, and the room's alignment is
 * only as good as the slowest link. Expect a few hundred milliseconds of delay
 * and tens of milliseconds of spread — good for a live DJ or a speech, not for
 * making phones sound like one speaker.
 *
 * Every receiver aims at the same absolute target: "play the audio that was
 * captured `TARGET_DELAY_MS` ago on the shared clock". Because that target is
 * expressed in server time, phones converge on each other rather than each
 * drifting to its own buffer level.
 */

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
];

const SLICE_MS = 100;
/** How far behind capture every phone deliberately sits, to absorb jitter. */
const TARGET_DELAY_MS = 600;
/** Beyond this the receiver jumps instead of easing. */
const HARD_SEEK_S = 0.5;
const DEADBAND_S = 0.03;
const MAX_RATE_TRIM = 0.06;

export function liveBroadcastSupport() {
  if (typeof MediaRecorder === 'undefined') return { ok: false, reason: 'MediaRecorder unavailable' };
  const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported?.(m));
  if (!mimeType) return { ok: false, reason: 'no supported audio encoder' };
  return { ok: true, mimeType };
}

export function liveReceiveSupport() {
  const MS = window.ManagedMediaSource || window.MediaSource;
  if (!MS) {
    return { ok: false, reason: 'This browser cannot play a live stream (no MediaSource).' };
  }
  const mimeType = MIME_CANDIDATES.find((m) => MS.isTypeSupported?.(m));
  if (!mimeType) return { ok: false, reason: 'No compatible live audio format.' };
  return { ok: true, mimeType, managed: Boolean(window.ManagedMediaSource) };
}

// ---------------------------------------------------------------------------

export class LiveBroadcaster extends EventTarget {
  /** @param {import('./net.js').Connection} connection */
  constructor(connection) {
    super();
    this.connection = connection;
    this.recorder = null;
    this.stream = null;
    this.active = false;
  }

  /** @param {'microphone'|'tab'} source */
  async start(source = 'microphone') {
    const support = liveBroadcastSupport();
    if (!support.ok) throw new Error(support.reason);

    this.stream =
      source === 'tab'
        ? await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          })
        : await navigator.mediaDevices.getUserMedia({
            audio: {
              // All three of these are designed to make speech intelligible and
              // will happily destroy music. Off, every time.
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              channelCount: 2,
            },
          });

    if (!this.stream.getAudioTracks().length) {
      this.stop();
      throw new Error('That source has no audio. Tick "Share tab audio" when choosing a tab.');
    }
    // A tab share hands back a video track we have no use for.
    for (const track of this.stream.getVideoTracks()) track.stop();

    const audioOnly = new MediaStream(this.stream.getAudioTracks());
    this.recorder = new MediaRecorder(audioOnly, {
      mimeType: support.mimeType,
      audioBitsPerSecond: 160_000,
    });

    this.recorder.ondataavailable = async (event) => {
      if (!event.data?.size) return;
      const buffer = await event.data.arrayBuffer();
      this.connection.sendBinary(buffer);
    };
    this.recorder.onstop = () => this.stop();

    this.connection.send({ type: 'live:start' });
    this.recorder.start(SLICE_MS);
    // Stamp the moment capture began on the shared clock; receivers use it to
    // turn a media position into an absolute time.
    this.connection.send({
      type: 'live:meta',
      captureStartServerTime: this.connection.clock.now(),
      mimeType: support.mimeType,
      sliceMs: SLICE_MS,
      targetDelayMs: TARGET_DELAY_MS,
    });

    this.active = true;
    this.dispatchEvent(new CustomEvent('started', { detail: { mimeType: support.mimeType } }));
  }

  stop() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      try {
        this.recorder.stop();
      } catch {
        /* already stopping */
      }
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.recorder = null;
    this.stream = null;
    if (this.active) {
      this.active = false;
      this.connection.send({ type: 'live:stop' });
      this.dispatchEvent(new CustomEvent('stopped'));
    }
  }
}

// ---------------------------------------------------------------------------

export class LiveReceiver extends EventTarget {
  /** @param {import('./sync.js').Clock} clock */
  constructor(clock) {
    super();
    this.clock = clock;
    this.audio = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.active = false;
    this.meta = null;
    this.driftMs = 0;
    this.gain = 1;
    this.muted = false;
    this._timer = null;
    this._objectUrl = null;
  }

  get supported() {
    return liveReceiveSupport().ok;
  }

  async start(meta) {
    const support = liveReceiveSupport();
    if (!support.ok) throw new Error(support.reason);
    this.stop();
    this.meta = meta ?? null;

    const MS = window.ManagedMediaSource || window.MediaSource;
    this.mediaSource = new MS();

    this.audio = new Audio();
    this.audio.autoplay = true;
    this.audio.preload = 'auto';
    this.audio.volume = this.muted ? 0 : this.gain;
    // ManagedMediaSource requires the element to be told it may go offscreen.
    this.audio.disableRemotePlayback = true;

    this._objectUrl = URL.createObjectURL(this.mediaSource);
    this.audio.src = this._objectUrl;

    await new Promise((resolve, reject) => {
      this.mediaSource.addEventListener('sourceopen', resolve, { once: true });
      this.mediaSource.addEventListener('error', reject, { once: true });
      setTimeout(() => reject(new Error('live stream did not open')), 5000);
    });

    const mimeType = meta?.mimeType && MS.isTypeSupported(meta.mimeType) ? meta.mimeType : support.mimeType;
    this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
    this.sourceBuffer.mode = 'sequence';
    this.sourceBuffer.addEventListener('updateend', () => this._drain());

    this.active = true;
    await this.audio.play().catch(() => {
      // Autoplay was refused; the caller unlocks audio from a gesture and the
      // next append will get it going.
    });

    clearInterval(this._timer);
    this._timer = setInterval(() => this._align(), 250);
    this.dispatchEvent(new CustomEvent('started'));
  }

  /** Feed one relayed chunk straight from the socket. */
  push(arrayBuffer) {
    if (!this.active) return;
    this.queue.push(arrayBuffer);
    if (this.queue.length > 200) this.queue.splice(0, this.queue.length - 100);
    this._drain();
  }

  _drain() {
    if (!this.sourceBuffer || this.sourceBuffer.updating || !this.queue.length) return;
    if (this.mediaSource?.readyState !== 'open') return;
    try {
      this.sourceBuffer.appendBuffer(this.queue.shift());
    } catch (err) {
      if (err?.name === 'QuotaExceededError') this._evict();
      else this.dispatchEvent(new CustomEvent('error', { detail: err }));
    }
  }

  /** Drop everything well behind the playhead so the buffer cannot grow forever. */
  _evict() {
    if (!this.sourceBuffer || this.sourceBuffer.updating || !this.audio) return;
    const cutoff = Math.max(0, this.audio.currentTime - 6);
    if (cutoff <= 0) return;
    try {
      this.sourceBuffer.remove(0, cutoff);
    } catch {
      /* nothing removable yet */
    }
  }

  _bufferedEnd() {
    const ranges = this.sourceBuffer?.buffered;
    if (!ranges?.length) return 0;
    return ranges.end(ranges.length - 1);
  }

  /**
   * Pull this phone toward the room's shared target position. Everyone solves
   * the same equation against the same clock, so they converge on each other,
   * not merely on "some sensible buffer level".
   */
  _align() {
    if (!this.active || !this.audio || !this.sourceBuffer) return;
    const bufferedEnd = this._bufferedEnd();
    if (!bufferedEnd) return;

    const targetDelayS = (this.meta?.targetDelayMs ?? TARGET_DELAY_MS) / 1000;

    let target;
    if (this.meta?.captureStartServerTime) {
      target = (this.clock.now() - this.meta.captureStartServerTime) / 1000 - targetDelayS;
    } else {
      // No capture stamp (joined mid-broadcast before meta arrived): fall back
      // to a fixed distance behind the live edge.
      target = bufferedEnd - targetDelayS;
    }
    target = Math.min(target, bufferedEnd - 0.05);
    if (target <= 0) return;

    const drift = this.audio.currentTime - target;
    this.driftMs = drift * 1000;

    if (Math.abs(drift) > HARD_SEEK_S) {
      this.audio.currentTime = target;
      this.audio.playbackRate = 1;
    } else if (Math.abs(drift) > DEADBAND_S) {
      this.audio.playbackRate = 1 + clamp(-drift * 0.5, -MAX_RATE_TRIM, MAX_RATE_TRIM);
    } else {
      this.audio.playbackRate = 1;
    }

    if (this.audio.paused) this.audio.play().catch(() => {});
    this._evict();
    this.dispatchEvent(new CustomEvent('drift', { detail: { driftMs: this.driftMs } }));
  }

  setGain(gain) {
    this.gain = clamp(gain, 0, 1);
    if (this.audio) this.audio.volume = this.muted ? 0 : this.gain;
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.audio) this.audio.volume = this.muted ? 0 : this.gain;
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
    this.active = false;
    this.queue = [];
    try {
      this.audio?.pause();
    } catch {
      /* not playing */
    }
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this._objectUrl = null;
    this.audio = null;
    this.sourceBuffer = null;
    this.mediaSource = null;
    this.driftMs = 0;
  }
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
