import { SyncPlayer } from './player.js';
import { LiveReceiver, liveReceiveSupport } from './live.js';
import { playChirp, Metronome } from './calibrate.js';
import * as cache from './cache.js';

/**
 * Everything a phone needs to behave as one of the speakers: it watches room
 * state, keeps the right track downloaded and decoded, hands playback to the
 * file player or the live receiver, and reports back how well it is keeping up.
 *
 * Both the join page and the host page use this — a host phone is usually one
 * of the speakers too, and there is no reason for it to run different code.
 */
export class SpeakerEngine extends EventTarget {
  /**
   * @param {import('./net.js').Connection} connection
   * @param {{followRoster?: boolean, reportTelemetry?: boolean}} options
   *   `followRoster` makes this phone obey the channel/volume the host assigned
   *   it. The host's own local player sets those itself, so it opts out.
   */
  constructor(connection, { followRoster = true, reportTelemetry = true } = {}) {
    super();
    this.connection = connection;
    this.followRoster = followRoster;
    this.reportTelemetry = reportTelemetry;

    this.player = new SyncPlayer(connection.clock);
    this.receiver = new LiveReceiver(connection.clock);
    this.enabled = false;
    this.loading = null;
    this.loadProgress = 0;
    this.error = null;
    this.mode = 'file';
    /** Track ids this phone already holds, so the host can show readiness. */
    this.have = new Set();
    this._prefetching = false;
    this._prefetchQueue = [];

    this.metronome = new Metronome(this.player);

    connection.addEventListener('state', (e) => this._onState(e.detail));
    connection.addEventListener('roster', (e) => this._applyRoster(e.detail.speakers));
    connection.addEventListener('chunk', (e) => this.receiver.push(e.detail));

    // Alignment: sound a chirp at the requested instant so the listening device
    // can measure when this phone is actually heard.
    connection.addEventListener('calibrate:play', (e) => {
      if (this.enabled) playChirp(this.player, e.detail.atServerTime);
    });

    connection.addEventListener('calibrate:metronome', (e) => {
      if (!this.enabled) return;
      if (e.detail.on) this.metronome.start();
      else this.metronome.stop();
      this._emit();
    });

    for (const source of [this.player, this.receiver]) {
      source.addEventListener('drift', () => this._emit());
    }
    this.player.addEventListener('started', () => this._emit());
    this.player.addEventListener('stopped', () => this._emit());
    this.player.addEventListener('ended', () => this._emit());

    if (reportTelemetry) {
      setInterval(() => this._report(), 1500);
    }
  }

  /** Must be called from a tap. Returns true once the device will make sound. */
  async enable() {
    await this.player.unlock();
    this.enabled = this.player.ready;
    // Anything cached from a previous visit counts as ready immediately.
    for (const id of await cache.keys()) this.have.add(id);
    if (this.enabled && this.connection.state) this._onState(this.connection.state);
    this._emit();
    return this.enabled;
  }

  get driftMs() {
    if (this.mode === 'spotify') return NaN; // measured by the Spotify player instead
    return this.mode === 'live' ? this.receiver.driftMs : this.player.driftMs;
  }

  get playing() {
    if (this.mode === 'spotify') return false;
    return this.mode === 'live' ? this.receiver.active : this.player.playing;
  }

  /** One-word summary for the UI and for the host's roster. */
  get status() {
    if (!this.enabled) return 'muted';
    if (this.error) return 'error';
    if (this.loading) return 'loading';
    if (this.playing) return 'playing';
    return 'ready';
  }

  // -- room state ----------------------------------------------------------

  async _onState(state) {
    if (!state) return;
    this.mode = state.spotify?.active ? 'spotify' : state.live?.active ? 'live' : 'file';

    if (this.mode === 'spotify') {
      // Spotify plays through its own SDK on each device; this engine has no
      // part in it beyond getting out of the way.
      this.player.stop();
      this.receiver.stop();
      this._emit();
      return;
    }

    if (this.mode === 'live') {
      this.player.stop();
      if (this.enabled && !this.receiver.active) {
        const support = liveReceiveSupport();
        if (!support.ok) {
          this.error = support.reason;
          this._emit();
          return;
        }
        try {
          await this.receiver.start(state.live.meta);
          this.error = null;
        } catch (err) {
          this.error = err.message;
        }
      } else if (this.receiver.active && state.live.meta) {
        this.receiver.meta = state.live.meta;
      }
      this._emit();
      return;
    }

    if (this.receiver.active) this.receiver.stop();
    if (!this.enabled) return;

    const track = state.tracks.find((t) => t.id === state.playback.trackId);
    if (!track) {
      this.player.stop();
      this._emit();
      return;
    }

    if (this.player.trackId !== track.id) {
      await this._load(track);
      // A newer state may have overtaken us during the download.
      if (this.connection.state !== state) return this._onState(this.connection.state);
    }

    this.player.apply(state.playback);
    this._emit();
    this._prefetch(state.tracks, track.id);
  }

  /**
   * Fetch the rest of the library in the background, once the track that is
   * actually playing is safe. This is what makes the next song start instantly
   * instead of making the room wait for a download — and a phone that already
   * holds a track skips it without touching the network.
   */
  async _prefetch(tracks, currentId) {
    this._prefetchQueue = tracks.filter((t) => t.id !== currentId && !this.have.has(t.id));
    if (this._prefetching) return;
    this._prefetching = true;

    try {
      while (this._prefetchQueue.length) {
        const track = this._prefetchQueue.shift();
        if (this.have.has(track.id)) continue;
        // Never compete with the track the room is listening to right now.
        if (this.loading) break;
        try {
          if (await cache.has(track.id)) {
            this.have.add(track.id);
            continue;
          }
          const res = await fetch(track.url);
          if (!res.ok) continue;
          const bytes = await res.arrayBuffer();
          if (await cache.put(track.id, bytes)) this.have.add(track.id);
          this._emit();
        } catch {
          // A failed prefetch is not an error the listener should ever see;
          // the track will simply download on demand instead.
        }
      }
    } finally {
      this._prefetching = false;
    }
  }

  async _load(track) {
    if (this.loading?.id === track.id) return this.loading.promise;
    this.error = null;
    this.loadProgress = 0;

    const promise = this.player
      .load(track, (p) => {
        this.loadProgress = p;
        this._emit();
      })
      .then(() => {
        this.have.add(track.id);
      })
      .catch((err) => {
        this.error = err.message;
      })
      .finally(() => {
        this.loading = null;
        this._emit();
      });

    this.loading = { id: track.id, promise };
    this._emit();
    return promise;
  }

  _applyRoster(speakers) {
    if (!this.followRoster || !this.connection.clientId) return;
    const me = speakers.find((s) => s.id === this.connection.clientId);
    if (!me) return;
    this.player.setChannel(me.channel);
    this.player.setGain(me.gain);
    this.player.setMuted(me.muted);
    this.player.setCalibration(me.calibrationMs);
    this.receiver.setGain(me.gain);
    this.receiver.setMuted(me.muted);
    this.assignment = me;
    this._emit();
  }

  // -- local controls (used by the host's own player) -----------------------

  setChannel(channel) {
    this.player.setChannel(channel);
  }

  setGain(gain) {
    this.player.setGain(gain);
    this.receiver.setGain(gain);
  }

  setMuted(muted) {
    this.player.setMuted(muted);
    this.receiver.setMuted(muted);
  }

  setCalibration(ms) {
    this.player.setCalibration(ms);
  }

  /**
   * Re-apply the room's current state from scratch. Used after a phone comes
   * back from the background, where the audio context was suspended and the
   * clock estimate has gone stale.
   */
  async resync() {
    if (this.player.ctx && this.player.ctx.state !== 'running') {
      await this.player.ctx.resume().catch(() => {});
    }
    if (this.connection.state) await this._onState(this.connection.state);
  }

  shutdown() {
    this.metronome.stop();
    this.receiver.stop();
    this.player.stop();
    this.enabled = false;
    this._emit();
  }

  // -- telemetry -----------------------------------------------------------

  _report() {
    if (!this.reportTelemetry) return;
    this.connection.send({
      type: 'status',
      rttMs: round(this.connection.clock.rtt),
      offsetMs: round(this.connection.clock.offset),
      driftMs: round(this.driftMs),
      state: this.status,
      buffered: round(this.loadProgress * 100),
      // Which tracks this phone already holds, so the host can see at a glance
      // who is ready before pressing play.
      have: [...this.have].slice(0, 60),
    });
  }

  _emit() {
    this.dispatchEvent(new CustomEvent('update'));
  }
}

function round(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}
