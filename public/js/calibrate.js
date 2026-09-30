/**
 * Acoustic alignment.
 *
 * Everything else in this app trusts the browser to say when sound actually
 * leaves the speaker. That trust is misplaced: `outputLatency` is undefined on
 * iOS Safari and wrong on plenty of Android builds, while the real path —
 * mixer, DSP, resampler, speaker driver — costs 50–150 ms. A phone that
 * underestimates its own latency schedules too late and then sits there, and
 * drift correction never notices, because the phone is measuring against its
 * own wrong idea of when its sound comes out. A constant bias is invisible from
 * the inside.
 *
 * So we measure from the outside. One device's microphone listens while each
 * phone in turn plays a short chirp at an agreed instant on the shared clock.
 * Cross-correlating the recording against the known chirp says when each phone
 * was *actually heard*.
 *
 * The trick that makes this trustworthy: we never need an absolute number. The
 * listener's own microphone latency, its input buffering, the constant offset
 * between the audio and wall clocks — all of it is the same for every
 * measurement, so it cancels when we align phones to the median of the group.
 * What remains is exactly what a person in the room hears: which phones are
 * early, which are late, including the speed of sound across the room.
 */

const CHIRP_SECONDS = 0.06;
const CHIRP_F0 = 1200;
const CHIRP_F1 = 6000;
const CHIRP_GAIN = 0.5;

/** How far either side of the expected arrival we search for the chirp. */
const SEARCH_WINDOW_MS = 260;

/**
 * How far above the noise the correlation peak must stand, in standard
 * deviations, to count as hearing the chirp at all.
 *
 * A z-score rather than a plain peak-to-average ratio, because the latter grows
 * with the width of the search window: a wider search gives noise more chances
 * to throw up a tall spike, so a fixed ratio silently becomes a false-positive
 * generator. Measured on synthetic recordings, pure noise peaks around z≈5
 * while a chirp from a quiet phone across a noisy room lands above z≈30, so 12
 * sits in open space between them.
 *
 * Erring toward rejection is deliberate: a phone reported as "not heard" is
 * left alone, whereas a false detection would confidently mis-trim it by
 * whatever a random noise peak happened to suggest.
 */
const MIN_PEAK_Z = 12;

// ---------------------------------------------------------------------------

/**
 * A linear sine sweep, Hann-windowed. A sweep correlates to a much sharper
 * peak than a click does and survives room noise far better, which is what
 * makes a few-millisecond measurement possible on a phone speaker.
 */
export function makeChirp(sampleRate) {
  const length = Math.round(CHIRP_SECONDS * sampleRate);
  const data = new Float32Array(length);
  const rate = (CHIRP_F1 - CHIRP_F0) / CHIRP_SECONDS;

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (CHIRP_F0 * t + (rate * t * t) / 2);
    const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (length - 1)));
    data[i] = Math.sin(phase) * window * CHIRP_GAIN;
  }
  return data;
}

export function chirpBuffer(ctx) {
  const data = makeChirp(ctx.sampleRate);
  const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buffer.copyToChannel(data, 0);
  return buffer;
}

// ---------------------------------------------------------------------------
// Speaker side
// ---------------------------------------------------------------------------

/**
 * Play the calibration chirp through exactly the same scheduling path as music,
 * trim included. The measurement therefore reports what is left over after the
 * current trim, which is what lets repeated runs converge instead of fighting
 * each other.
 */
export function playChirp(player, atServerTime) {
  const ctx = player.ctx;
  if (!ctx) return false;

  const source = ctx.createBufferSource();
  source.buffer = chirpBuffer(ctx);

  // Straight to the destination: never through the room's channel split or
  // volume, or a phone assigned to one side (or muted) could not be measured.
  const gain = ctx.createGain();
  gain.gain.value = 1;
  source.connect(gain).connect(ctx.destination);

  const target = player.serverToCtx(atServerTime - player.calibrationMs);
  const when = Math.max(target, ctx.currentTime + 0.01);
  source.start(when);
  source.onended = () => {
    try {
      gain.disconnect();
    } catch {
      /* already torn down */
    }
  };
  return true;
}

// ---------------------------------------------------------------------------
// Listener side
// ---------------------------------------------------------------------------

export class CalibrationListener {
  /**
   * @param {AudioContext} ctx  the listening device's own context
   * @param {import('./sync.js').Clock} clock
   */
  constructor(ctx, clock) {
    this.ctx = ctx;
    this.clock = clock;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.chunks = [];
    this.sampleRate = ctx.sampleRate;
    this.startCtxTime = null;
    this.samplesRecorded = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Every one of these would fight the measurement. Echo cancellation in
        // particular exists specifically to remove the sound of your own
        // speaker from the microphone — which is the entire signal here.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });

    this.source = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but universally available, and this is a
    // few seconds of one-off capture rather than a hot path.
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);

    this.node.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      if (this.startCtxTime === null) {
        // Treat this as the context time of sample zero. Any constant error
        // here is identical for every device measured, so it cancels.
        this.startCtxTime = this.ctx.currentTime;
      }
      this.chunks.push(new Float32Array(input));
      this.samplesRecorded += input.length;
      // Keep memory bounded on a long session; 60 s is far more than needed.
      if (this.samplesRecorded > this.sampleRate * 60) this._trim();
    };

    this.source.connect(this.node);
    // A muted sink keeps the node pulling without making the listener's own
    // device emit anything.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(this.ctx.destination);
    this._sink = sink;
  }

  _trim() {
    const keep = Math.floor(this.sampleRate * 30);
    const merged = this._merge();
    const dropped = Math.max(0, merged.length - keep);
    this.chunks = [merged.subarray(dropped).slice()];
    this.startCtxTime += dropped / this.sampleRate;
    this.samplesRecorded = this.chunks[0].length;
  }

  _merge() {
    if (this.chunks.length === 1) return this.chunks[0];
    const merged = new Float32Array(this.samplesRecorded);
    let at = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, at);
      at += chunk.length;
    }
    this.chunks = [merged];
    return merged;
  }

  stop() {
    try {
      this.node?.disconnect();
      this.source?.disconnect();
      this._sink?.disconnect();
    } catch {
      /* already detached */
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    if (this.node) this.node.onaudioprocess = null;
    this.node = null;
    this.source = null;
    this.stream = null;
  }

  /**
   * Find the chirp that was meant to sound at `expectedServerTime` and report
   * how far off it actually was, in milliseconds. Positive means late.
   */
  measure(expectedServerTime) {
    const recording = this._merge();
    if (!recording.length || this.startCtxTime === null) {
      return { ok: false, reason: 'nothing recorded' };
    }

    const reference = makeChirp(this.sampleRate);
    const expectedCtxTime = this._serverToCtx(expectedServerTime);
    const expectedIndex = Math.round((expectedCtxTime - this.startCtxTime) * this.sampleRate);
    const half = Math.round((SEARCH_WINDOW_MS / 1000) * this.sampleRate);

    const from = Math.max(0, expectedIndex - half);
    const to = Math.min(recording.length - reference.length, expectedIndex + half);
    if (to <= from) return { ok: false, reason: 'the recording did not cover that moment' };

    const found = locateChirp(recording, reference, from, to);
    if (!found.ok) return { ok: false, reason: 'could not hear it clearly', ratio: found.ratio };

    const arrivalCtxTime = this.startCtxTime + found.index / this.sampleRate;
    const offsetMs = (arrivalCtxTime - expectedCtxTime) * 1000;
    return { ok: true, offsetMs, ratio: found.ratio };
  }

  /** Same audio-clock-to-server-clock bridge the player uses. */
  _serverToCtx(serverTime) {
    const ts = this.ctx.getOutputTimestamp?.();
    const mapping =
      ts && ts.contextTime > 0 && ts.performanceTime > 0
        ? { ctxTime: ts.contextTime, perfTime: ts.performanceTime }
        : { ctxTime: this.ctx.currentTime, perfTime: performance.now() };
    return mapping.ctxTime + (this.clock.toLocal(serverTime) - mapping.perfTime) / 1000;
  }
}

/**
 * Sliding dot product of the recording against the reference chirp, over
 * [from, to]. Returns where the chirp starts, plus how far the peak stands
 * above the average — which is what distinguishes a real detection from a room
 * that was simply too noisy to measure. Pure, so it can be tested against
 * synthetic recordings with a known answer.
 */
export function locateChirp(signal, reference, from, to) {
  const { index, peak, mean, deviation } = correlate(signal, reference, from, to);
  const z = deviation > 0 ? (peak - mean) / deviation : 0;
  return { ok: z >= MIN_PEAK_Z, index, z, ratio: mean > 0 ? peak / mean : 0 };
}

function correlate(signal, reference, from, to) {
  const length = reference.length;
  let best = -Infinity;
  let bestIndex = from;
  let total = 0;
  let totalSquares = 0;
  let count = 0;

  for (let offset = from; offset <= to; offset++) {
    let sum = 0;
    // Stride 2 halves the work at no meaningful cost: the chirp is far wider
    // than two samples, so the peak cannot slip between them.
    for (let i = 0; i < length; i += 2) sum += signal[offset + i] * reference[i];
    const magnitude = Math.abs(sum);
    total += magnitude;
    totalSquares += magnitude * magnitude;
    count++;
    if (magnitude > best) {
      best = magnitude;
      bestIndex = offset;
    }
  }

  const mean = count ? total / count : 0;
  const variance = count ? Math.max(0, totalSquares / count - mean * mean) : 0;

  // Refine the winner at full resolution, since the coarse pass may have landed
  // a sample or two off the true peak.
  let refinedIndex = bestIndex;
  let refinedBest = -Infinity;
  const lo = Math.max(from, bestIndex - 4);
  const hi = Math.min(to, bestIndex + 4);
  for (let offset = lo; offset <= hi; offset++) {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += signal[offset + i] * reference[i];
    const magnitude = Math.abs(sum);
    if (magnitude > refinedBest) {
      refinedBest = magnitude;
      refinedIndex = offset;
    }
  }

  // Judge significance on the coarse pass, whose statistics describe the whole
  // window; the refinement only sharpens where the peak sits.
  return { index: refinedIndex, peak: best, mean, deviation: Math.sqrt(variance) };
}

// ---------------------------------------------------------------------------
// Line-up metronome
// ---------------------------------------------------------------------------

/**
 * A click on every second of the shared clock, scheduled exactly like music.
 * Walk the room while this runs: if any phone is audibly separate from the
 * others, that is real misalignment and no measurement is needed to believe it.
 */
export class Metronome {
  constructor(player) {
    this.player = player;
    this.running = false;
    this._timer = null;
    this._scheduledThrough = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._scheduledThrough = 0;
    this._tick();
    this._timer = setInterval(() => this._tick(), 250);
  }

  stop() {
    this.running = false;
    clearInterval(this._timer);
    this._timer = null;
  }

  _tick() {
    const player = this.player;
    const ctx = player.ctx;
    if (!ctx || !this.running) return;

    const now = player.clock.now();
    // Schedule every whole second of server time falling in the next 600 ms.
    const first = Math.ceil((now + 60) / 1000) * 1000;
    for (let at = first; at < now + 600; at += 1000) {
      if (at <= this._scheduledThrough) continue;
      this._scheduledThrough = at;
      this._click(ctx, player.serverToCtx(at - player.calibrationMs));
    }
  }

  _click(ctx, when) {
    if (when < ctx.currentTime + 0.005) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 2000;
    // A short percussive envelope: easy to localise by ear, hard to mistake
    // two of them a few milliseconds apart for one.
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(0.6, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.06);
    osc.onended = () => {
      try {
        gain.disconnect();
      } catch {
        /* already gone */
      }
    };
  }
}
