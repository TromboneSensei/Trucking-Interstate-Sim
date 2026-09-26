// Phase 3 verify: the Director Mode framework (idle detection, camera
// takeover, travel/APEX/wake), exercised end-to-end with the Interchange
// shot - the only type this build ships. Phase 4 extends this file with
// per-shot-type assertions once the other four land.
//
//   node scripts/verify-director.mjs
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

// --- Section 1: manual start fades the UI and takes the camera ------------
{
  const { browser, page, errors } = await freshPage();
  await page.evaluate(() => director.start("manual"));
  await page.waitForTimeout(600); // past ENTERING's 350ms grace period, well into TRAVEL/SHOT
  const state1 = await page.evaluate(() => ({
    bodyHasClass: document.body.classList.contains("director"),
    sheetOpacity: getComputedStyle(document.getElementById("bottom-sheet")).opacity,
    cameraMode: camera.mode,
    shieldHidden: document.getElementById("director-shield").classList.contains("hidden"),
    active: director.isActive(),
  }));
  console.log(state1);
  check(state1.bodyHasClass, "body.director is set once active");
  check(state1.sheetOpacity === "0", `#bottom-sheet is fully faded (got opacity ${state1.sheetOpacity})`);
  check(state1.cameraMode === "DIRECTOR", `camera.mode is DIRECTOR (got ${state1.cameraMode})`);
  check(!state1.shieldHidden, "the input shield is visible while active");
  check(state1.active, "director.isActive() is true");
  check(errors.length === 0, "no page/console errors so far" + (errors.length ? ":\n  " + errors.join("\n  ") : ""));
  await browser.close();
}

// --- Section 2: forced long hop actually reaches the country view + APEX --
{
  const { browser, page, errors } = await freshPage();
  const result = await page.evaluate(async () => {
    const res = director.debug.forceShot("interchange", { longHop: true });
    const countryW = canvas.clientWidth / director.debug.countryZoom();
    const samples = [];
    let sawApex = false;
    const t0 = performance.now();
    while (performance.now() - t0 < 6000) {
      await new Promise((r) => requestAnimationFrame(r));
      samples.push(camera.zoom);
      if (director.debug.snapshot().phase === "SHOT") break;
    }
    // countryZoom() itself is the widest (smallest camera.zoom) view this
    // build ever frames - the flight should get at least close to it, not
    // just "wider than the shot's own zoom".
    return { res, minZoom: Math.min(...samples), countryZoom: countryW > 0 ? canvas.clientWidth / countryW : 0, finalPhase: director.debug.snapshot().phase };
  });
  console.log(result);
  check(result.res === "ok", `forceShot('interchange', {longHop:true}) returns "ok" (got "${result.res}")`);
  check(result.finalPhase === "SHOT", `settled into SHOT within 6s (got "${result.finalPhase}")`);
  // The forced long hop must have zoomed out close to the country view at
  // some point - camera.zoom is smallest at the widest view, so this checks
  // it dropped to within a generous margin of the true country zoom.
  const dirCountryZoom = await page.evaluate(() => director.debug.countryZoom());
  check(result.minZoom <= dirCountryZoom * 1.3, `zoom reached near the country view (min zoom ${result.minZoom.toFixed(4)}, country zoom ${dirCountryZoom.toFixed(4)})`);
  check(errors.length === 0, "no page/console errors" + (errors.length ? ":\n  " + errors.join("\n  ") : ""));
  await browser.close();
}

// --- Section 2b: screenshot the APEX hold itself, at phone and desktop -----
// The plan calls for a screenshot "during a shot, at the apex, and right
// after wake" at both viewport sizes - Section 2 above only proves the
// numbers (zoom reached near country view), this actually looks at it.
async function screenshotApex(viewport, outPath) {
  const { browser, page, errors } = await freshPage(viewport);
  await page.evaluate(() => director.debug.forceShot("interchange", { longHop: true }));
  // Poll for the actual APEX segment (not a zoom-proximity heuristic - a
  // forced long hop's own legA can be a near-zero-distance flight whenever
  // the boot camera already happens to sit near the country view, which
  // would satisfy a zoom-based check before the HUD has even started
  // fading and well before the real static hold begins).
  const t0 = Date.now();
  let reachedApex = false;
  while (Date.now() - t0 < 5000) {
    const segKind = await page.evaluate(() => director.debug.snapshot().travelSegKind);
    if (segKind === "apex") { reachedApex = true; break; }
    await page.waitForTimeout(40);
  }
  // Give the HUD's opacity transition (--dur-3, 300ms) time to finish, and
  // land mid-hold rather than on the very first apex frame.
  await page.waitForTimeout(350);
  await page.screenshot({ path: outPath });
  check(reachedApex, `apex segment was reached (${viewport.width}x${viewport.height})`);
  check(errors.length === 0, `no page/console errors for the ${viewport.width}x${viewport.height} apex screenshot` + (errors.length ? ":\n  " + errors.join("\n  ") : ""));
  await browser.close();
}
await screenshotApex({ width: 420, height: 900 }, path.join(SCREENSHOT_DIR, "director-apex-phone.png"));
await screenshotApex({ width: 1280, height: 800 }, path.join(SCREENSHOT_DIR, "director-apex-desktop.png"));

// --- Section 3: caption shows non-empty text during SHOT -------------------
{
  const { browser, page, errors } = await freshPage();
  const res = await page.evaluate(() => director.debug.forceShot("interchange"));
  check(res === "ok", "forceShot('interchange') returns 'ok'");
  // Poll rather than a fixed sleep: a short hop's own flight is bounded by
  // FLIGHT_MAX_MS (2600ms), not FLIGHT_MIN_MS, so a worst-case pick (camera
  // start far from the chosen junction) plus DIR_CAPTION_IN_DELAY_MS (800ms)
  // can legitimately take up to ~3.4s before the caption shows.
  await page.evaluate(async () => {
    const t0 = performance.now();
    while (performance.now() - t0 < 4500) {
      if (document.getElementById("director-caption").classList.contains("show")) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(350); // the .show class only starts a --dur-3 (300ms) CSS opacity transition, doesn't set it instantly
  const caption = await page.evaluate(() => ({
    eyebrow: document.querySelector("#director-caption .dc-eyebrow").textContent,
    line: document.querySelector("#director-caption .dc-line").textContent,
    showClass: document.getElementById("director-caption").classList.contains("show"),
    opacity: getComputedStyle(document.getElementById("director-caption")).opacity,
  }));
  console.log(caption);
  check(caption.eyebrow.length > 0, `caption eyebrow is non-empty (got "${caption.eyebrow}")`);
  check(caption.line.length > 0, `caption line is non-empty (got "${caption.line}")`);
  check(caption.showClass, "caption has the .show class");
  check(parseFloat(caption.opacity) > 0.5, `caption is actually visible (opacity ${caption.opacity})`);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "director-shot.png") });
  check(errors.length === 0, "no page/console errors" + (errors.length ? ":\n  " + errors.join("\n  ") : ""));
  await browser.close();
}

// --- Section 4: clicking the shield wakes without selecting a truck --------
{
  const { browser, page, errors } = await freshPage();
  await page.evaluate(() => director.debug.forceShot("interchange"));
  await page.waitForTimeout(2000);
  const before = await page.evaluate(() => ({ followedTruckId: state.followedTruckId }));
  // A real click, not page.evaluate(() => el.click()): this specifically
  // tests that the shield's actionability (it must be visible, on top,
  // hit-testable) is what's under test, not just the JS handler existing.
  await page.click("#director-shield", { position: { x: 210, y: 400 } });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    active: director.isActive(),
    followedTruckId: state.followedTruckId,
    bodyHasClass: document.body.classList.contains("director"),
    returnVisible: document.getElementById("director-return").classList.contains("show"),
  }));
  console.log({ before, after });
  check(!after.active, "director.isActive() is false after clicking the shield");
  check(!after.bodyHasClass, "body.director is removed");
  // Interchange's subject is a road junction, never a truck - so this
  // specific shot type can never hand off a followed truck on wake. The
  // real thing under test is that the click did NOT fall through to the
  // canvas and select whatever truck happened to be under the tap point.
  check(after.followedTruckId == null, `no truck was accidentally selected by the waking click (got ${after.followedTruckId})`);
  check(after.returnVisible, "the return chip is visible after waking");
  check(errors.length === 0, "no page/console errors" + (errors.length ? ":\n  " + errors.join("\n  ") : ""));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "director-wake.png") });
  await browser.close();
}

// --- Section 4b: same shot + wake screenshots at desktop size --------------
{
  const { browser, page, errors } = await freshPage({ width: 1280, height: 800 });
  await page.evaluate(() => director.debug.forceShot("interchange"));
  await page.evaluate(async () => {
    const t0 = performance.now();
    while (performance.now() - t0 < 4500) {
      if (document.getElementById("director-caption").classList.contains("show")) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "director-shot-desktop.png") });
  await page.click("#director-shield", { position: { x: 640, y: 400 } });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "director-wake-desktop.png") });
  check(errors.length === 0, "no page/console errors (desktop shot+wake screenshots)" + (errors.length ? ":\n  " + errors.join("\n  ") : ""));
  await browser.close();
}

// --- Section 5: the return chip flies back to the pre-director view -------
{
  const { browser, page, errors } = await freshPage();
  const before = await page.evaluate(() => {
    camera.mode = "FREE";
    camera.x = 1234; camera.y = 987; camera.zoom = 1.7;
    return { x: camera.x, y: camera.y, zoom: camera.zoom };
  });
  await page.evaluate(() => director.start("manual"));
  await page.waitForTimeout(2000);
  await page.evaluate(() => { document.getElementById("director-return").click(); });
  await page.waitForTimeout(1500); // returnToSnapshot's own flight is clamped to 500-900ms
  const after = await page.evaluate(() => ({ x: camera.x, y: camera.y, zoom: camera.zoom }));
  console.log({ before, after });
  const within5pct = (a, b) => Math.abs(a - b) <= Math.abs(b) * 0.05 + 0.5;
  check(within5pct(after.x, before.x) && within5pct(after.y, before.y) && within5pct(after.zoom, before.zoom),
    `camera returned within 5% of the pre-director view (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`);
  check(errors.length === 0, "no page/console errors" + (errors.length ? ":\n  " + errors.join("\n  ") : ""));
  await browser.close();
}

// --- Section 6: auto-start respects the idle threshold and the gates ------
{
  const { browser, page, errors } = await freshPage();
  const r1 = await page.evaluate(async () => {
    director.debug.setIdleMs(1500);
    const t0 = performance.now();
    while (performance.now() - t0 < 2200) await new Promise((r) => requestAnimationFrame(r));
    return director.isActive();
  });
  check(r1 === true, "auto-starts once idleMs is exceeded with nothing blocking it");
  await browser.close();
}
{
  const { browser, page, errors } = await freshPage();
  // Quick Start is the real, exercised path a career actually begins
  // through - more representative than calling career.startCareer directly
  // with an ad-hoc truck.
  await page.click("#btn-career");
  await page.waitForTimeout(200);
  await page.click("#btn-quick-start");
  await page.waitForTimeout(600);
  const blockedByCareer = await page.evaluate(async () => {
    director.debug.setIdleMs(1000);
    const t0 = performance.now();
    while (performance.now() - t0 < 1800) await new Promise((r) => requestAnimationFrame(r));
    return director.isActive();
  });
  check(blockedByCareer === false, "does NOT auto-start while a career is active");
  await browser.close();
}
{
  const { browser, page, errors } = await freshPage();
  const blockedBySettings = await page.evaluate(async () => {
    document.getElementById("btn-settings").click();
    director.debug.setIdleMs(1000);
    const t0 = performance.now();
    while (performance.now() - t0 < 1800) await new Promise((r) => requestAnimationFrame(r));
    return director.isActive();
  });
  check(blockedBySettings === false, "does NOT auto-start while the settings overlay is open");
  check(errors.length === 0, "no page/console errors" + (errors.length ? ":\n  " + errors.join("\n  ") : ""));
  await browser.close();
}

// --- Section 7: keydown wakes without also resolving a decision panel -----
{
  const { browser, page, errors } = await freshPage();
  await page.evaluate(() => director.start("manual"));
  await page.waitForTimeout(600);
  // A decision panel that's simply sitting in `state` (not necessarily the
  // one driving the visible overlay, since the shield covers everything
  // anyway) - what's under test is that resolveDecision's own digit-key
  // handler never fires for this keypress, not that a real decision panel
  // was on screen.
  const decisionArmed = await page.evaluate(() => {
    const t = trucks.find((tr) => tr.pendingOptions && tr.pendingOptions.length);
    if (t) { state.decisionTruck = t; return true; }
    return false;
  });
  const before = await page.evaluate(() => state.decisionTruck && state.decisionTruck.pendingOptions ? state.decisionTruck.pendingOptions[0] : null);
  await page.keyboard.press("1");
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    active: director.isActive(),
    decisionStillArmed: !!state.decisionTruck,
  }));
  console.log({ decisionArmed, after });
  check(!after.active, "director.isActive() is false after a keydown");
  if (decisionArmed) {
    check(after.decisionStillArmed, "the decision panel was NOT resolved by the wake keypress");
  }
  check(errors.length === 0, "no page/console errors" + (errors.length ? ":\n  " + errors.join("\n  ") : ""));
  await browser.close();
}

console.log(fails === 0 ? "\nDIRECTOR VERIFY PASSED" : `\nDIRECTOR VERIFY FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
