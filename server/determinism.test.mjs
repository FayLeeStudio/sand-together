// Determinism contract test — sync-architecture acceptance A: the sim is a PURE
// FUNCTION of (rngState + inputs). Drive the same seeded SandSim twice with identical
// inputs and assert the per-tick grid checksums match exactly; assert a DIFFERENT seed
// diverges (so the randomness is real, not a constant). Tests the SHARED sim.js directly
// (the same module the server requires and the client will <script src>), so this pins
// down the CA core in isolation from networking/persistence.
//   node server/determinism.test.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SandSim } = require("../sim.js");

let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? "  ok  " : " FAIL ") + m); };

// Build a seeded sim, add two pourers at different spouts, run N ticks feeding identical
// input each tick. Returns the full per-tick checksum trail (+ grain count) — same seed +
// same inputs ⇒ identical trail.
function run(seed, ticks) {
  const s = new SandSim({ rngState: seed >>> 0 }); // prod defaults (H=300, etc.)
  s.addMember("a", "amber");
  s.addMember("c", "violet");
  s.setSpout("a", 4);            // wider brush → more grains → exercises the random slide a lot
  s.setSpout("c", 4);
  const trail = [];
  for (let t = 0; t < ticks; t++) {
    s.enqueue("a", 12);          // identical, fully deterministic input every tick
    s.enqueue("c", 12);
    s.step();
    trail.push(s.checksum());
  }
  let grains = 0; for (const v of s.grid) if (v) grains++;
  return { trail, grains };
}

const N = 300;
const A = run(0x12345678, N);
const B = run(0x12345678, N);   // same seed + inputs as A
const C = run(0x9abcdef0, N);   // different seed

ok(A.grains > 0, "sand accumulated (the dl&&dr random slide branch is actually exercised)");
ok(A.trail.length === N && A.trail.every((h, i) => h === B.trail[i]), "same seed + same inputs ⇒ identical per-tick checksum trail");
ok(A.trail[N - 1] === B.trail[N - 1], "final grid checksum matches across two runs");
ok(C.trail[N - 1] !== A.trail[N - 1], "a different seed diverges (randomness is real, seed matters)");

console.log(`\n${fail ? "x" : "+"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
