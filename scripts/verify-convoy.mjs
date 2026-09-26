// Phase 1 verify: the isDrafting/draftLeader stale-flag fix + convoy
// tethers. Run after `node scripts/build.mjs`:
//
//   node scripts/verify-convoy.mjs
//
// A fresh browser per section (see docs/director-mode-plan.md Appendix E -
// Chromium in this sandbox crashes after ~6 heavy page loads in one
// process).
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const URL = "file://" + path.join(ROOT, "dist", "interstate-fleet.html");
const SCREENSHOT_DIR = path.join(ROOT, "dist", "screenshots");

let chromium;
try {
  ({ chromium } = await import("/opt/node22/lib/node_modules/playwright/index.mjs"));
} catch {
  ({ chromium } = await import("playwright"));
}

let fails = 0;
const check = (cond, msg) => { if (cond) console.log("ok:", msg); else { console.error("FAIL:", msg); fails++; } };

async function freshPage(viewport = { width: 420, height: 900 }) {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" }).catch(() => chromium.launch());
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (t.includes("fonts.g") || t.includes("ERR_CONNECTION") || t.includes("net::ERR")) return;
    errors.push("CONSOLE: " + t);
  });
  await page.goto(URL);
  await page.waitForTimeout(1200);
  return { browser, page, errors };
}

// --- Section 1: isDrafting/draftLeader invariant + no phantom fuel discount ---
{
  const { browser, page, errors } = await freshPage();
  // A bigger fleet makes the invariant scan and the "find a drafter" hunt
  // below far less likely to come up empty on a given run.
  await page.evaluate(() => {
    document.getElementById("setting-fleet-size").value = "3000";
    document.getElementById("btn-settings-apply").click();
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => { state.timeScale = 8; });
  await page.waitForTimeout(15000); // real seconds; ~8x sim time to let drafting pairs actually form

  const result = await page.evaluate(() => {
    let anyDrafting = 0;
    // The ORIGINAL bug (fixed in fleet.js): isDrafting/draftLeader frozen
    // stale on the FOLLOWER after it left the interstate, parked, or hit an
    // edge with no lane group - assignments that used to only ever happen
    // deep inside the interstate/has-a-group branch, never on the early
    // returns above it. That class of bug shows up as one of these three
    // conditions on the truck the invariant is actually about.
    let followerBroken = 0;
    // NOT a bug: `draftLeader.edge !== t.edge` is a real, ordinary, single-
    // tick transient - fleet.js's Phase 1 (decide speed/lane, using this
    // tick's pre-move positions) can set draftLeader from a shared lane
    // group, and then Phase 2 (same tick) advances THAT LEADER onto its
    // next edge (or all the way to a parked delivery) before the follower,
    // still short of the edge's end, gets there itself - sometimes onto a
    // completely different route if the two trucks' own destinations
    // diverge at that junction. It self-corrects the very next tick's
    // Phase 1 recompute. This is exactly the case render.js's own
    // `draftLeader.edge === truck.edge` guard exists to keep off the map
    // (verified separately below by tethersDrawn) - counted and reported,
    // never failed on.
    let leaderMoved = 0;
    for (const t of trucks) {
      if (!t.isDrafting) continue;
      anyDrafting++;
      if (!t.edge || t.edge.kind !== "interstate" || t.parkedAt || !t.draftLeader) { followerBroken++; continue; }
      if (t.draftLeader.edge !== t.edge) leaderMoved++;
    }
    return { anyDrafting, followerBroken, leaderMoved, total: trucks.length };
  });
  console.log("drafting snapshot:", result);
  check(result.anyDrafting > 0, `at least one truck is drafting (got ${result.anyDrafting}/${result.total})`);
  check(result.followerBroken === 0, `no drafting truck has a bad follower-side state - non-interstate edge, parked, or null draftLeader (${result.followerBroken} did; this is the original bug's signature)`);
  console.log(`  (${result.leaderMoved}/${result.anyDrafting} show the leader having since moved to a new edge - an expected same-tick transient, not a failure; render.js's same-edge guard keeps these from drawing a tether)`);

  await browser.close();
}

// --- Section 2: tethers render when following a drafter, not when zoomed out ---
{
  const { browser, page, errors } = await freshPage();
  await page.evaluate(() => {
    document.getElementById("setting-fleet-size").value = "3000";
    document.getElementById("btn-settings-apply").click();
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => { state.timeScale = 8; });
  await page.waitForTimeout(15000);

  // Require the STRICT same-edge invariant at pick time (not just
  // isDrafting), or this can grab a truck mid-transient (see the
  // leaderMoved case above) and correctly get 0 tethers - proving nothing
  // about the drawing code.
  //
  // Drafting is "purely reactive... never sticky" by design (fleet.js's own
  // comment on applyFollowAndPassing) - a real valid pair can dissolve
  // within a fraction of a second of sim-time, so polling for tethersDrawn
  // AFTER picking one raced the simulation and flaked. Instead, the moment
  // a valid pair is found, freeze the sim (timeScale = 0) in that SAME
  // synchronous evaluate() call, before returning to Node - gameHours
  // becomes 0 (see fleet.js: `truck.s += truck.speed * gameHours`), so
  // truck.s stops advancing and the pair's gap/edge state literally cannot
  // change while frozen. No race is possible once this returns.
  let drafterId = null;
  for (let i = 0; i < 8 && drafterId == null; i++) {
    if (i > 0) await page.waitForTimeout(2000);
    drafterId = await page.evaluate(() => {
      const ZOOM = 10;
      // Well clear of both edge endpoints (city nodes bring junction
      // clutter: parked-count badges, other traffic funneling through),
      // AND no other truck dot anywhere near the tight zoom-10 view - a
      // pair on a busy corridor can pass both s-distance checks and still
      // land in a screenshot too crowded to visually confirm the line
      // against. Checked over every candidate until one is actually clear.
      const candidates = trucks.filter((t) => t.isDrafting && t.draftLeader && t.draftLeader.edge === t.edge
        && t.s > 8 && t.draftLeader.s > 8 && t.edge.miles > 30);
      const halfW = (420 / ZOOM) / 2, halfH = (900 * 0.55 / ZOOM) / 2; // rough visible half-extent above the bottom sheet
      for (const t of candidates) {
        const l = t.draftLeader;
        const pf = truckPose(graph, t), pl = truckPose(graph, l);
        // The tether is drawn BEFORE the truck dots (dots sit on top, by
        // design - see render.js), so a pair following at a tight gap has
        // its entire tether segment covered by the two dots' own radii,
        // with nothing visible in between despite tethersDrawn genuinely
        // counting it. 24 world units (dot radius 3.5 x2, generous margin)
        // ensures a real visible stretch of line survives outside both dots.
        const gap = Math.hypot(pf.x - pl.x, pf.y - pl.y);
        if (gap < 24) continue;
        const cx = (pf.x + pl.x) / 2, cy = (pf.y + pl.y) / 2;
        const crowded = trucks.some((other) => {
          if (other === t || other === l || (other.parkedAt && !other.agent)) return false;
          const po = truckPose(graph, other);
          return Math.abs(po.x - cx) < halfW && Math.abs(po.y - cy) < halfH;
        });
        if (crowded) continue;
        state.timeScale = 0;
        document.getElementById("daily-digest").classList.add("hidden");
        document.getElementById("payroll-alert").classList.add("hidden");
        setSheetMinimized(true);
        camera.mode = "FREE"; // no FOLLOW lerp involved - x/y are set directly, below
        camera.x = cx; camera.y = cy; camera.zoom = ZOOM;
        return t.id;
      }
      return null;
    });
  }
  check(drafterId != null, "found an isolated drafting pair (clear of a junction and other traffic) to inspect");

  if (drafterId != null) {
    // The picker above already froze time, hid the digest/payroll cards,
    // and minimized the sheet in the same synchronous call that confirmed
    // the pair - nothing left to do here but let the (now-frozen) scene
    // actually redraw once at the new camera position before reading it.
    await page.waitForTimeout(150);
    const maxTethers = await page.evaluate(() => lastFrameStats.tethersDrawn);
    check(maxTethers > 0, `tethersDrawn > 0 while centered tight on a frozen, isolated drafting pair (got ${maxTethers})`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "convoy-tether.png") });

    await page.evaluate(() => { camera.zoom = 0.4; });
    await page.waitForTimeout(200);
    const tethersZoomedOut = await page.evaluate(() => lastFrameStats.tethersDrawn);
    check(tethersZoomedOut === 0, `tethersDrawn === 0 at zoom 0.4 (got ${tethersZoomedOut})`);
  }

  check(errors.length === 0, "no page/console errors" + (errors.length ? ":\n  " + errors.join("\n  ") : ""));
  await browser.close();
}

console.log(fails === 0 ? "\nCONVOY VERIFY PASSED" : `\nCONVOY VERIFY FAILED (${fails})`);
console.log(`Screenshot: ${path.join(SCREENSHOT_DIR, "convoy-tether.png")}`);
process.exit(fails === 0 ? 0 : 1);
