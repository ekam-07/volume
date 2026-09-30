/**
 * Does the chirp detector find a known answer?
 *
 * The dangerous failure mode for acoustic alignment is not "it errors" — it is
 * "it confidently returns a wrong number and silently mis-trims the room". So
 * synthesise recordings where the true arrival is known exactly, and check the
 * measurement against it under realistic insults: quiet signal, loud room,
 * clipping, and a chirp that never arrives at all.
 */
import { makeChirp, locateChirp } from '../public/js/calibrate.js';

const RATE = 48000;
const reference = makeChirp(RATE);

function build({ trueIndex, signalGain, noiseGain, lengthSeconds = 2 }) {
  const rec = new Float32Array(Math.round(RATE * lengthSeconds));
  for (let i = 0; i < rec.length; i++) rec[i] = (Math.random() * 2 - 1) * noiseGain;
  if (trueIndex !== null) {
    for (let i = 0; i < reference.length; i++) {
      rec[trueIndex + i] += reference[i] * signalGain;
    }
  }
  return rec;
}

function run(name, opts, expect) {
  const rec = build(opts);
  const half = Math.round(0.26 * RATE);
  // Search centred on a deliberately wrong guess, as in the real thing: we
  // only know when the chirp was *meant* to sound, not when it arrived.
  const guess = opts.trueIndex === null ? RATE : opts.trueIndex + (opts.guessErrorSamples ?? 0);
  const from = Math.max(0, guess - half);
  const to = Math.min(rec.length - reference.length, guess + half);

  const t0 = Date.now();
  const found = locateChirp(rec, reference, from, to);
  const ms = Date.now() - t0;

  if (expect === 'reject') {
    const pass = !found.ok;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ok=${found.ok} z=${found.z.toFixed(1)} (${ms}ms)`);
    return pass;
  }

  const errorSamples = found.index - opts.trueIndex;
  const errorMs = (errorSamples / RATE) * 1000;
  const pass = found.ok && Math.abs(errorMs) <= 0.5;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} err=${errorMs.toFixed(3)}ms z=${found.z.toFixed(1)} (${ms}ms)`,
  );
  return pass;
}

console.log(`chirp: ${reference.length} samples @ ${RATE}Hz\n`);

const results = [
  run('clean, loud', { trueIndex: 40000, signalGain: 0.8, noiseGain: 0.001 }, 'find'),
  run('quiet phone across the room', { trueIndex: 40000, signalGain: 0.05, noiseGain: 0.01 }, 'find'),
  run('noisy room', { trueIndex: 55000, signalGain: 0.3, noiseGain: 0.15 }, 'find'),
  run('very noisy room', { trueIndex: 55000, signalGain: 0.2, noiseGain: 0.3 }, 'find'),
  run('arrived 120ms late', { trueIndex: 50000, signalGain: 0.4, noiseGain: 0.02, guessErrorSamples: -5760 }, 'find'),
  run('arrived 120ms early', { trueIndex: 50000, signalGain: 0.4, noiseGain: 0.02, guessErrorSamples: 5760 }, 'find'),
  run('no chirp at all', { trueIndex: null, signalGain: 0, noiseGain: 0.1 }, 'reject'),
  run('silence', { trueIndex: null, signalGain: 0, noiseGain: 0.0000001 }, 'reject'),
];

// Repeatability: the same conditions must not wander between runs, since the
// room is trimmed by the median of three.
const spread = [];
for (let i = 0; i < 7; i++) {
  const rec = build({ trueIndex: 48000, signalGain: 0.15, noiseGain: 0.08 });
  const found = locateChirp(rec, reference, 48000 - 12000, 48000 + 12000);
  if (found.ok) spread.push(((found.index - 48000) / RATE) * 1000);
}
const jitter = spread.length ? Math.max(...spread) - Math.min(...spread) : Infinity;
const repeatable = spread.length === 7 && jitter <= 0.5;
console.log(
  `${repeatable ? 'PASS' : 'FAIL'}  ${'repeatability (7 runs)'.padEnd(34)} spread=${jitter.toFixed(3)}ms detected=${spread.length}/7`,
);

const passed = results.every(Boolean) && repeatable;
console.log(`\n${passed ? 'ALL PASS' : 'FAILURES'}`);
process.exit(passed ? 0 : 1);
