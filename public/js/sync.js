/**
 * Clock synchronisation, NTP-style, over the existing WebSocket.
 *
 * Every phone runs its own clock, and those clocks disagree by anywhere from
 * milliseconds to minutes. Rather than trying to correct the device clock, we
 * measure our offset from the server's clock and translate on the fly. From
 * then on the whole app thinks in *server time*, which every phone in the room
 * agrees on to within a few milliseconds.
 *
 * One exchange:
 *
 *     t0 ──────────────▶ t1        t0, t3  local (this phone)
 *                          │       t1      remote (server)
 *     t3 ◀──────────────  ┘
 *
 *     rtt    = t3 - t0
 *     offset = t1 - (t0 + t3) / 2      assumes a symmetric round trip
 *
 * A single sample is badly contaminated by network jitter, so we keep a window
 * of them, throw away everything but the fastest quarter (a fast round trip has
 * less room to be asymmetric) and take the median of what's left.
 */

const WINDOW = 40;
const BURST_COUNT = 10;
const BURST_INTERVAL_MS = 120;
const STEADY_INTERVAL_MS = 2000;
const SETTLED_INTERVAL_MS = 5000;

/** Below this spread between good samples we consider the clock settled. */
const SETTLED_JITTER_MS = 12;

/** Offset changes larger than this are applied at once instead of eased in. */
const STEP_THRESHOLD_MS = 40;

export class Clock extends EventTarget {
  constructor(send) {
    super();
    this._send = send;
    /** @type {{rtt:number, offset:number, at:number}[]} */
    this.samples = [];
    this.offset = 0;
    this.rtt = 0;
    this.jitter = Infinity;
    this.settled = false;
    this.ready = false;
    this._pending = new Map();
    this._timer = null;
    this._sent = 0;
    this._readyResolve = null;
    this.whenReady = new Promise((resolve) => {
      this._readyResolve = resolve;
    });
  }

  start() {
    this.stop();
    this._sent = 0;
    this._schedule(0);
  }

  stop() {
    clearTimeout(this._timer);
    this._timer = null;
    this._pending.clear();
  }

  /** Discard everything and re-measure — used after a reconnect. */
  reset() {
    this.samples = [];
    this.settled = false;
    this.jitter = Infinity;
    this.start();
  }

  _schedule(delay) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._ping(), delay);
  }

  _ping() {
    const t0 = performance.now();
    this._pending.set(t0, true);
    this._sent++;
    this._send({ type: 'ping', t0 });

    // Drop any ping that never came back, so the map cannot grow forever.
    setTimeout(() => this._pending.delete(t0), 5000);

    const interval =
      this._sent < BURST_COUNT
        ? BURST_INTERVAL_MS
        : this.settled
          ? SETTLED_INTERVAL_MS
          : STEADY_INTERVAL_MS;
    this._schedule(interval);
  }

  /** Feed a `pong` straight from the socket. */
  onPong(msg) {
    const t0 = msg.t0;
    if (!this._pending.delete(t0)) return;

    const t3 = performance.now();
    const rtt = t3 - t0;
    // Both local stamps are `performance.now()`; lift them into epoch ms so
    // they are comparable with the server's clock.
    const localMid = performance.timeOrigin + (t0 + t3) / 2;
    const offset = msg.t1 - localMid;

    this.samples.push({ rtt, offset, at: t3 });
    if (this.samples.length > WINDOW) this.samples.shift();
    this._recompute();
  }

  _recompute() {
    if (this.samples.length < 3) return;

    // Keep the fastest quarter of the window: a round trip that spent less
    // time in the network had less opportunity to be lopsided.
    const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const keep = byRtt.slice(0, Math.max(3, Math.ceil(byRtt.length / 4)));

    const offsets = keep.map((s) => s.offset).sort((a, b) => a - b);
    const estimate = median(offsets);

    this.rtt = median(keep.map((s) => s.rtt).sort((a, b) => a - b));
    this.jitter = offsets[offsets.length - 1] - offsets[0];

    if (!this.ready || Math.abs(estimate - this.offset) > STEP_THRESHOLD_MS) {
      this.offset = estimate;
    } else {
      // Ease small corrections in, so a scheduled playhead is never yanked.
      this.offset += (estimate - this.offset) * 0.25;
    }

    this.settled = this.samples.length >= BURST_COUNT && this.jitter <= SETTLED_JITTER_MS;

    if (!this.ready && this.samples.length >= 5) {
      this.ready = true;
      this._readyResolve?.();
    }
    this.dispatchEvent(new CustomEvent('update'));
  }

  /** Current time on the server's clock, in epoch milliseconds. */
  now() {
    return performance.timeOrigin + performance.now() + this.offset;
  }

  /** Convert a server timestamp into this phone's `performance.now()` domain. */
  toLocal(serverTime) {
    return serverTime - this.offset - performance.timeOrigin;
  }

  /** Convert a local `performance.now()` value into server time. */
  toServer(perfTime) {
    return performance.timeOrigin + perfTime + this.offset;
  }

  /** Rough one-sigma confidence in the offset, in milliseconds. */
  get accuracyMs() {
    if (!this.samples.length) return Infinity;
    return Math.max(this.jitter / 2, this.rtt / 10);
  }
}

function median(sorted) {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
