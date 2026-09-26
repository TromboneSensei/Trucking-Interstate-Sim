// Headless smoke test for the built game. Run after `node scripts/build.mjs`:
//
//   node scripts/smoke.mjs            # phone viewport (420x900)
//   node scripts/smoke.mjs --desktop  # 1280x800
//
// Boots dist/interstate-fleet.html, lets the sim run, clicks every
// spectator tab, quick-starts a career, clicks every career tab, and fails
// on any page error, console error, or visible #fatal-error. It is a
// tripwire, not a feature test - each feature gets its own verify script
// (see scripts/verify-*.mjs) built on the same pattern.
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const URL = "file://" + path.join(ROOT, "dist", "interstate-fleet.html");

let chromium;
try {
  ({ chromium } = await import("/opt/node22/lib/node_modules/playwright/index.mjs"));
} catch {
  ({ chromium } = await import("playwright"));
}

const desktop = process.argv.includes("--desktop");
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: desktop ? { width: 1280, height: 800 } : { width: 420, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  // The sandbox blocks Google Fonts; those failures are environment noise.
  if (t.includes("fonts.g") || t.includes("ERR_CONNECTION") || t.includes("net::ERR")) return;
  errors.push("CONSOLE: " + t);
});

let fails = 0;
const check = (cond, msg) => { if (cond) console.log("ok:", msg); else { console.error("FAIL:", msg); fails++; } };

await page.goto(URL);
await page.waitForTimeout(1500);

const booted = await page.evaluate(() => ({
  trucks: typeof trucks !== "undefined" ? trucks.length : -1,
  fatal: !document.getElementById("fatal-error").classList.contains("hidden"),
}));
check(booted.trucks > 0, `sim booted with a fleet (got ${booted.trucks} trucks)`);
check(!booted.fatal, "no fatal-error overlay after boot");

// A direct DOM click, not page.click(): the career truck can hit a
// junction requiring player input at any moment once Quick Start below
// starts a career, and Playwright's real click waits (up to its own
// timeout) for the tab button to be "visible, enabled and stable" with
// nothing overlapping it - a decision-overlay popping up over the sheet
// mid-loop blocks that indefinitely. This is a tab switch, not a touch-
// target test, so bypassing the actionability check is the correct fix,
// not a workaround.
const clickTab = (tab) => page.evaluate((t) => document.querySelector(`.tab-btn[data-tab="${t}"]`).click(), tab);

for (const tab of ["overview", "rankings", "economy", "cb"]) {
  await clickTab(tab);
  await page.waitForTimeout(300);
}
check(true, "clicked all spectator tabs");

await page.click("#btn-career");
await page.waitForTimeout(200);
await page.click("#btn-quick-start");
await page.waitForTimeout(800);
check(await page.evaluate(() => career.isActive()), "Quick Start career is active");
for (const tab of ["rig", "fleet", "books", "world"]) {
  await clickTab(tab);
  await page.waitForTimeout(300);
}
check(true, "clicked all career tabs");

const fatalAfter = await page.evaluate(() => !document.getElementById("fatal-error").classList.contains("hidden"));
check(!fatalAfter, "no fatal-error overlay at the end");
check(errors.length === 0, "no page/console errors" + (errors.length ? ":\n  " + errors.join("\n  ") : ""));

await browser.close();
console.log(fails === 0 ? "\nSMOKE PASSED" : `\nSMOKE FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
