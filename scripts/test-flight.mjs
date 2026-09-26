// Phase 2 verify: src/flight.js's smooth zoom-pan math. Plain node, no
// browser, no build step needed - imports the module directly.
//
//   node scripts/test-flight.mjs
import { flightPath } from "../src/flight.js";

let fails = 0;
const check = (cond, msg) => { if (cond) console.log("ok:", msg); else { console.error("FAIL:", msg); fails++; } };

function sampleFinite(f, n = 200) {
  for (let i = 0; i <= n; i++) {
    const p = f(i / n);
    if (![p.x, p.y, p.w].every(Number.isFinite)) return false;
  }
  return true;
}

const CASES = {
  "same-point zoom-in": [{ x: 100, y: 100, w: 800 }, { x: 100, y: 100, w: 150 }],
  "same-point zoom-out": [{ x: 100, y: 100, w: 150 }, { x: 100, y: 100, w: 800 }],
  "long pan, narrow both ends": [{ x: 200, y: 300, w: 150 }, { x: 3700, y: 1900, w: 150 }],
  "pan to a wider view": [{ x: 200, y: 300, w: 150 }, { x: 2000, y: 1200, w: 3000 }],
};

for (const [name, [a, b]] of Object.entries(CASES)) {
  const f = flightPath(a, b);
  const s0 = f.at(0), s1 = f.at(1);
  const endErr = Math.max(
    Math.abs(s0.x - a.x), Math.abs(s0.y - a.y), Math.abs(s0.w - a.w),
    Math.abs(s1.x - b.x), Math.abs(s1.y - b.y), Math.abs(s1.w - b.w),
  );
  check(endErr < 1e-6, `${name}: at(0)/at(1) match the endpoints (max err ${endErr.toExponential(2)})`);
  check(sampleFinite(f.at), `${name}: no NaN/Infinity across 200 samples`);
}

// Long pan should visibly zoom OUT partway through (peak w above both
// endpoints) even though both endpoints are equally narrow - this is the
// "pull back to see where you're going" behavior the whole flight exists for.
{
  const f = flightPath({ x: 200, y: 300, w: 150 }, { x: 3700, y: 1900, w: 150 });
  let maxW = 0;
  for (let i = 0; i <= 200; i++) maxW = Math.max(maxW, f.at(i / 200).w);
  check(maxW > 150 * 1.5, `long pan peaks well above both endpoints' w=150 (peak ${maxW.toFixed(0)})`);
}

// A leg ending at the country view (the widest w anything in this game
// uses) should never overshoot past it - w rises (net) the whole way,
// with no oscillation, since there's nothing wider to peek at past 4000.
{
  const f = flightPath({ x: 300, y: 400, w: 140 }, { x: 2000, y: 1200, w: 4000 });
  let prevW = -Infinity, monotone = true;
  for (let i = 0; i <= 200; i++) {
    const w = f.at(i / 200).w;
    if (w < prevW - 1e-6) monotone = false;
    prevW = w;
  }
  check(monotone, "leg to the country view has monotonically non-decreasing w");
}

console.log(fails === 0 ? "\nFLIGHT MATH VERIFY PASSED" : `\nFLIGHT MATH VERIFY FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
