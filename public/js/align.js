import { CalibrationListener } from './calibrate.js';

/**
 * Run an alignment pass over the room.
 *
 * Each phone plays a chirp in turn while this device listens. The measured
 * arrival times are compared against each other — never against an absolute —
 * so the listener's own microphone latency, its input buffering and the offset
 * between its audio and wall clocks all cancel. Phones are then trimmed toward
 * the median of the group.
 *
 * The median rather than the mean, because one phone that fails to be heard
 * cleanly, or sits across the room behind a sofa, should not drag everyone
 * else out of alignment with it.
 *
 * Each pass measures what is left over *after* the trims already applied, and
 * adds to them. So a second run refines the first rather than fighting it, and
 * a room that is already aligned measures near zero and barely moves.
 */

const SETTLE_MS = 400;
const LEAD_MS = 900;
const GAP_MS = 750;
const REPEATS = 3;

/** Stand-in id for the listening device itself, when it is also a speaker. */
export const SELF_ID = '__self__';

/**
 * @param {object} options
 * @param {Array}  options.speakers  roster entries, optionally including one
 *   with `id === SELF_ID` for the listening phone's own output. It is measured
 *   like any other — a host that is also playing has exactly the same unknown
 *   speaker latency as everyone else, and leaving it out would align the room
 *   around a phone that is itself off.
 * @param {(atServerTime:number)=>void} [options.playLocally] sounds the chirp
 *   on this device, used for the SELF_ID entry.
 */
export async function alignRoom({ connection, player, speakers, playLocally, onProgress }) {
  if (!player.ctx) throw new Error('turn on playback on this phone first');
  if (!speakers.length) throw new Error('no phones to align');

  const listener = new CalibrationListener(player.ctx, connection.clock);
  await listener.start();

  const results = [];
  try {
    // Let the capture graph settle before the first chirp is scheduled.
    await sleep(SETTLE_MS);

    for (const [index, speaker] of speakers.entries()) {
      onProgress?.({
        phase: 'measuring',
        name: speaker.name,
        done: index,
        total: speakers.length,
      });

      const samples = [];
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        const at = connection.clock.now() + LEAD_MS;
        if (speaker.id === SELF_ID) playLocally?.(at);
        else connection.send({ type: 'calibrate:chirp', clientId: speaker.id, atServerTime: at });
        await sleep(LEAD_MS + GAP_MS);

        const measured = listener.measure(at);
        if (measured.ok) samples.push(measured.offsetMs);
      }

      results.push({
        id: speaker.id,
        name: speaker.name,
        // The median of the repeats rejects a one-off door slam or cough.
        offsetMs: samples.length ? median(samples) : null,
        samples,
        heard: samples.length,
      });
    }
  } finally {
    listener.stop();
  }

  const { adjustments, spreadMs, referenceMs } = computeTrims(results, speakers);

  for (const adjustment of adjustments) {
    if (!adjustment.applied) continue;
    if (adjustment.id === SELF_ID) {
      player.setCalibration(adjustment.calibrationMs);
      continue;
    }
    connection.send({
      type: 'setSpeaker',
      clientId: adjustment.id,
      calibrationMs: adjustment.calibrationMs,
    });
  }

  onProgress?.({ phase: 'done', done: speakers.length, total: speakers.length });
  return { adjustments, spreadMs, referenceMs };
}

/**
 * Turn measured arrival times into trims. Pure, because this is where a bug
 * would quietly mis-trim a whole room rather than throwing something visible.
 *
 * @param {{id:string, name:string, offsetMs:number|null}[]} results
 * @param {{id:string, calibrationMs?:number}[]} speakers
 */
export function computeTrims(results, speakers) {
  const heard = results.filter((r) => r.offsetMs !== null);
  if (heard.length < 2) {
    throw new Error(
      heard.length === 1
        ? 'only one phone could be heard — turn the volume up and try somewhere quieter'
        : 'could not hear the phones — turn their volume up and try somewhere quieter',
    );
  }

  const reference = median(heard.map((r) => r.offsetMs));

  const adjustments = results.map((result) => {
    const existing = speakers.find((s) => s.id === result.id)?.calibrationMs ?? 0;
    if (result.offsetMs === null) {
      // Never guess at a phone that could not be heard: leave it exactly as it
      // was rather than moving it on no evidence.
      return { ...result, applied: false, calibrationMs: existing, correctionMs: 0 };
    }
    // Positive means this phone was heard late, so it must start earlier —
    // which is exactly what a positive trim does. Added to the existing trim,
    // because the measurement already includes that trim's effect.
    const correction = result.offsetMs - reference;
    const calibrationMs = clamp(Math.round(existing + correction), -500, 500);
    return { ...result, applied: true, calibrationMs, correctionMs: Math.round(correction) };
  });

  const offsets = heard.map((r) => r.offsetMs);
  return {
    adjustments,
    spreadMs: Math.round(Math.max(...offsets) - Math.min(...offsets)),
    referenceMs: Math.round(reference),
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
