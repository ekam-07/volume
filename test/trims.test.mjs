import { computeTrims } from '../public/js/align.js';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log('PASS ', name); pass++; }
  else { console.log('FAIL ', name, '\n       got', a, '\n       want', e); fail++; }
};

const trims = (results, speakers) =>
  computeTrims(results, speakers).adjustments.map(a => [a.id, a.calibrationMs, a.applied]);

// Median of +50/+10/+30 is +30: the late one starts 20ms earlier, the early one 20ms later.
check('aligns to the median',
  trims([{id:'a',offsetMs:50},{id:'b',offsetMs:10},{id:'c',offsetMs:30}],
        [{id:'a'},{id:'b'},{id:'c'}]),
  [['a',20,true],['b',-20,true],['c',0,true]]);

// The whole room late together is not misalignment — nothing should move.
check('ignores a shared offset',
  trims([{id:'a',offsetMs:200},{id:'b',offsetMs:200},{id:'c',offsetMs:200}],
        [{id:'a'},{id:'b'},{id:'c'}]),
  [['a',0,true],['b',0,true],['c',0,true]]);

// A second pass refines the first rather than restarting from zero.
check('accumulates onto existing trims',
  trims([{id:'a',offsetMs:5},{id:'b',offsetMs:-5},{id:'c',offsetMs:0}],
        [{id:'a',calibrationMs:80},{id:'b',calibrationMs:-40},{id:'c',calibrationMs:10}]),
  [['a',85,true],['b',-45,true],['c',10,true]]);

check('converged room stays put',
  trims([{id:'a',offsetMs:0},{id:'b',offsetMs:0}], [{id:'a',calibrationMs:120},{id:'b',calibrationMs:-30}]),
  [['a',120,true],['b',-30,true]]);

check('leaves unheard phones alone',
  trims([{id:'a',offsetMs:40},{id:'b',offsetMs:0},{id:'c',offsetMs:null}],
        [{id:'a'},{id:'b'},{id:'c',calibrationMs:77}]),
  [['a',20,true],['b',-20,true],['c',77,false]]);

// One outlier must not drag the group; median is robust where mean is not.
check('outlier does not drag the group',
  trims([{id:'a',offsetMs:0},{id:'b',offsetMs:2},{id:'c',offsetMs:1},{id:'d',offsetMs:400}],
        [{id:'a'},{id:'b'},{id:'c'},{id:'d'}]),
  [['a',-1,true],['b',1,true],['c',0,true],['d',399,true]]);

// Median of [900,0] is 450, so neither correction reaches the 500ms limit.
check('splits the difference between two',
  trims([{id:'a',offsetMs:900},{id:'b',offsetMs:0}], [{id:'a'},{id:'b'}]),
  [['a',450,true],['b',-450,true]]);

// Three phones put the median at 0, so the wild one needs +1400 and is capped.
check('trims are clamped to the safe range',
  trims([{id:'a',offsetMs:0},{id:'b',offsetMs:0},{id:'c',offsetMs:1400}],
        [{id:'a'},{id:'b'},{id:'c'}]),
  [['a',0,true],['b',0,true],['c',500,true]]);

check('spread is reported', computeTrims(
  [{id:'a',offsetMs:12},{id:'b',offsetMs:-38}], [{id:'a'},{id:'b'}]).spreadMs, 50);

for (const [name, results] of [
  ['refuses with nothing heard', [{id:'a',offsetMs:null},{id:'b',offsetMs:null}]],
  ['refuses with only one heard', [{id:'a',offsetMs:5},{id:'b',offsetMs:null}]],
]) {
  try { computeTrims(results, [{id:'a'},{id:'b'}]); console.log('FAIL ', name, '- did not throw'); fail++; }
  catch { console.log('PASS ', name); pass++; }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
