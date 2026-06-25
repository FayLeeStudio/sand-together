// Sand Together — shared deterministic falling-sand simulation (the CA core).
//
// SINGLE SOURCE OF TRUTH for the physics: the server `require`s this file and the web
// page loads it via <script src="/sim.js">. Keeping ONE copy is the hard prerequisite
// for lockstep determinism — two diverging copies would drift apart bit by bit. No build
// step (CLAUDE.md): this is a plain UMD module, hand-editable, served same-origin.
//
// The grid is a PURE FUNCTION of (rngState + the ordered input events). The ONLY
// randomness is fall()'s left/right slide, drawn from a seeded integer PRNG (mulberry32),
// consumed in a fixed scan order — so a server and a client fed the same seed + same
// inputs reach a bit-identical grid (verify with checksum()). Privacy red line holds: the
// grid stores only colour slots 0..4 — never key contents.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Sand = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // --- shared contract constants (must be identical on server + client; frontend.md) ---
  const W = 80;                                       // grid columns (fixed contract)
  const ROOM_COLORS = ["amber", "teal", "violet", "rose"]; // slot 1..4 = grid value
  const SPOUT_X = { 1: 30, 2: 50, 3: 10, 4: 70 };     // pour column per slot, evenly spaced centre-out
  const SPOUT_MAX = 5;                                // pour brush cap (N×N)
  const SURFACE_MIN_CELLS = 6;                        // a row needs this many grains to count as the surface
  const SPAWN_ROW = 2;                                // top boundary for the pour source
  const SPAWN_GAP = 75;                               // pour this far above the settled surface (matches camera anchor)
  const GRAIN_QUEUE_CAP = 600;                        // max grains buffered per player

  const colorSlot = (c) => Math.max(1, ROOM_COLORS.indexOf(c) + 1); // colour name → grid value 1..4

  // SandSim owns the deterministic state: the active grid, the archive bands, the PRNG
  // stream, the frame counter, and the per-player SIM roster (colour + pour queue/brush/
  // debug toggles). It advances ONLY via step() + the apply* event methods, so the server
  // and every client evolve it identically. Networking, persistence and player NAMES live
  // outside (the server wraps this); the sim never sees a name or a socket.
  class SandSim {
    constructor(opts = {}) {
      opts = opts || {};
      this.W = W;
      this.H = opts.H || 300;                  // active grid rows (the client shows a window of it)
      this.COMPRESS_ROWS = opts.COMPRESS_ROWS || 64;     // rows folded into one band
      this.COMPRESS_MARGIN = opts.COMPRESS_MARGIN || 40; // archive when a packed layer reaches this near the top
      this.FLOOD_ROWS_PER_TICK = opts.FLOOD_ROWS_PER_TICK || 6; // debug fast bottom-fill rate
      this.DEFAULT_SPOUT = opts.DEFAULT_SPOUT || 1;      // out-of-the-box brush size
      this.grid = new Uint8Array(this.W * this.H);       // the one active grid (0=empty, 1..4=slot)
      this.bands = [];                         // Stage 3 archive: [{rows,n,cells:Uint8Array(rows*W)}], 0 = deepest
      this.frame = 0;                          // tick counter (drives scan parity)
      // Seed source needn't be deterministic (only the STREAM from a seed must be); a
      // fresh server room passes a crypto seed, a client passes the snapshot's rngState.
      this.rngState = (opts.rngState != null ? opts.rngState : (Math.random() * 0x100000000)) >>> 0;
      this.members = {};                       // id -> { color } (sim-only slice of the roster)
      this.queues = {};                        // id -> grains pending spawn
      this.spoutSize = {};                     // id -> N (pour brush size 1..SPOUT_MAX)
      this.pouring = {};                       // id -> bool (debug: keep the spout saturated)
      this.flooding = {};                      // id -> bool (debug: fast bottom-fill)
    }

    // ---- deterministic event application (server + client call these identically) ----
    addMember(id, color) { this.members[id] = { color: color || ROOM_COLORS[0] }; }
    removeMember(id) {
      delete this.members[id]; delete this.queues[id];
      delete this.spoutSize[id]; delete this.pouring[id]; delete this.flooding[id];
    }
    enqueue(id, delta) { if (delta > 0) this.queues[id] = Math.min((this.queues[id] || 0) + delta, GRAIN_QUEUE_CAP); }
    setSpout(id, size) { this.spoutSize[id] = Math.max(1, Math.min(SPOUT_MAX, size | 0)); }
    setPour(id, on) { this.pouring[id] = !!on; }
    setFlood(id, on) { this.flooding[id] = !!on; }
    reset() { this.grid.fill(0); this.bands = []; }    // empty the canvas + archive

    // ---- PRNG + checksum ----
    // mulberry32 step: integer-only (deterministic across JS engines — no float, no
    // Math.random). Advances rngState, returns a uint32. The CA draws it ONLY in fall(),
    // in a fixed scan order, so the random stream is reproducible.
    nextU32() {
      let t = (this.rngState = (this.rngState + 0x6D2B79F5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    }
    // FNV-1a over the grid bytes — a cheap divergence detector. Two nodes running the same
    // seeded sim on the same ordered inputs MUST agree here on every tick.
    checksum() {
      let h = 0x811c9dc5; const g = this.grid;
      for (let i = 0; i < g.length; i++) { h ^= g[i]; h = Math.imul(h, 0x01000193); }
      return h >>> 0;
    }

    // ---- surface probes ----
    surface() { // first row (top→down) with enough sand to be a real surface (not falling grains)
      const W = this.W, H = this.H, g = this.grid;
      for (let y = 0; y < H; y++) {
        const b = y * W; let n = 0;
        for (let x = 0; x < W; x++) if (g[b + x] && ++n >= SURFACE_MIN_CELLS) return y;
      }
      return H;
    }
    packedTop() { // first row (top→down) that is at least HALF full — a genuinely packed layer
      const W = this.W, H = this.H, g = this.grid, need = W >> 1;
      for (let y = 0; y < H; y++) {
        const b = y * W; let n = 0;
        for (let x = 0; x < W; x++) if (g[b + x] && ++n >= need) return y;
      }
      return H;
    }

    // ---- pour + physics ----
    // Refill the N×N brush footprint at (sr, x0-centred) from `max` grains; returns how
    // many were placed. The brush is N tall so the stream stays continuous for N≥2.
    brush(slot, x0, sr, N, max) {
      const W = this.W, H = this.H, g = this.grid;
      let placed = 0; const half = (N - 1) >> 1;
      for (let r = 0; r < N && placed < max; r++) {
        const rb = (sr + r) * W;
        if (rb < 0 || rb + W > W * H) continue;
        for (let c = 0; c < N && placed < max; c++) {
          const xx = x0 - half + c;
          if (xx < 0 || xx >= W) continue;
          if (g[rb + xx] === 0) { g[rb + xx] = slot; placed++; }
        }
      }
      return placed;
    }
    spawn() {
      const sr = Math.max(SPAWN_ROW, this.surface() - SPAWN_GAP); // source rides just above the peak
      for (const id of Object.keys(this.members).sort()) { // sorted = deterministic multi-player order
        const slot = colorSlot(this.members[id].color);
        const x0 = SPOUT_X[slot] || 40;
        const N = this.spoutSize[id] || this.DEFAULT_SPOUT;
        if (this.pouring[id]) { this.brush(slot, x0, sr, N, N * N); continue; } // debug: tap full open
        const q = this.queues[id] || 0;
        if (q <= 0) continue;
        this.queues[id] = q - this.brush(slot, x0, sr, N, q); // pour from your keystroke queue
      }
    }
    floodFill() { // debug fast-fill: pack the lowest empty cells (no pour/physics)
      const W = this.W, H = this.H, g = this.grid;
      for (const id of Object.keys(this.flooding).sort()) {
        if (!this.flooding[id] || !this.members[id]) continue;
        const slot = colorSlot(this.members[id].color);
        let budget = this.FLOOD_ROWS_PER_TICK * W;
        for (let y = H - 1; y >= 0 && budget > 0; y--) {
          const b = y * W;
          for (let x = 0; x < W && budget > 0; x++) if (g[b + x] === 0) { g[b + x] = slot; budget--; }
        }
      }
    }
    physics() {
      const W = this.W, H = this.H, ltr = (this.frame & 1) === 0;
      for (let y = H - 2; y >= 0; y--) {
        if (ltr) { for (let x = 0; x < W; x++) this.fall(x, y); }
        else { for (let x = W - 1; x >= 0; x--) this.fall(x, y); }
      }
    }
    fall(x, y) {
      const W = this.W, g = this.grid, i = y * W + x, c = g[i];
      if (!c) return;
      const below = i + W;
      if (g[below] === 0) { g[below] = c; g[i] = 0; return; }
      const dl = x > 0 && g[below - 1] === 0;
      const dr = x < W - 1 && g[below + 1] === 0;
      if (dl && dr) { if ((this.nextU32() & 1) === 0) g[below - 1] = c; else g[below + 1] = c; g[i] = 0; }
      else if (dl) { g[below - 1] = c; g[i] = 0; }
      else if (dr) { g[below + 1] = c; g[i] = 0; }
    }

    // One deterministic tick: spawn → debug flood → 2 gravity sub-steps (gentler fall).
    // Archiving is SEPARATE (maybeArchive) so the server can broadcast the per-cell patch
    // FIRST (clients reach the pre-shift grid), then apply the same shift on the `band`.
    step() {
      this.frame++;
      this.spawn();
      this.floodFill();
      this.physics(); this.physics();
    }
    // If a packed layer crowds the top, fold the bottom COMPRESS_ROWS rows VERBATIM into a
    // band (lossless — the exact pixels) and shift the active grid DOWN to free the top.
    // Returns the new band {rows,n,cells} (caller broadcasts/persists) or null if nothing
    // was archived. Deterministic: every node computes the identical fold.
    maybeArchive() {
      const K = this.COMPRESS_ROWS, W = this.W, H = this.H, g = this.grid;
      if (!(H > K)) return null;
      if (this.packedTop() > this.COMPRESS_MARGIN) return null;
      const cells = g.slice((H - K) * W, H * W); // exact bottom K rows (K*W bytes), lossless
      let n = 0; for (let i = 0; i < cells.length; i++) if (cells[i]) n++;
      if (n === 0) return null;                  // nothing settled down there yet
      this.bands.push({ rows: K, n, cells });
      g.copyWithin(K * W, 0, (H - K) * W);       // row y -> y+K (memmove handles the overlap)
      g.fill(0, 0, K * W);                        // free the top K rows
      return { rows: K, n, cells };
    }
  }

  return { W, ROOM_COLORS, SPOUT_X, SPOUT_MAX, SURFACE_MIN_CELLS, SPAWN_ROW, SPAWN_GAP, colorSlot, SandSim };
});
