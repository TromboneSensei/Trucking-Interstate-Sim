// career-ui.js - all the DOM for Owner-Operator mode: the full-screen
// truck-stop takeover, the four career bottom-sheet tabs (RIG/FLEET/
// BOOKS/WORLD, swapped in for the spectator set while a career is
// active), and the small always-visible status readout. Mirrors cb.js's
// precedent of a module owning its own panel outright rather than
// main.js reaching into it. career.js (no DOM) does all the actual
// state/economy work; this module is purely "read career.js, render it,
// and turn clicks into career.js calls."
"use strict";

import * as career from "./career.js";
import { pumpFuel, estimatedRangeMiles, FATIGUE_RECOVERY_PER_HOUR } from "./fleet.js";
import { generateContractOffers } from "./economy.js";
import { traitSummary } from "./driver.js";
import { openTab, preserveScroll } from "./ui.js";

const careerEl = {
  btnCareer: document.getElementById("btn-career"),
  // Read-only status while driving - no controls live here (throttle/
  // PULL IN moved into the RIG tab, full-size, where a thumb can
  // actually hit them). Tapping the bar opens RIG.
  careerStatus: document.getElementById("career-status"),
  careerStatusCash: document.getElementById("career-status-cash"),
  careerStatusFuel: document.getElementById("career-status-fuel"),
  careerStatusFatigue: document.getElementById("career-status-fatigue"),
  careerStatusDest: document.getElementById("career-status-dest"),
  careerStatusHotshot: document.getElementById("career-status-hotshot"),
  careerStatusHeat: document.getElementById("career-status-heat"),
  overlay: document.getElementById("truckstop-overlay"),
  city: document.getElementById("truckstop-city"),
  clock: document.getElementById("truckstop-clock"),
  tabs: document.getElementById("truckstop-tabs"),
  content: document.getElementById("truckstop-content"),
  status: document.getElementById("truckstop-status"),
  btnClose: document.getElementById("btn-truckstop-close"),
  btnRollOut: document.getElementById("btn-roll-out"),
  toast: document.getElementById("toast"),
  tabRig: document.getElementById("tab-rig"),
  tabFleet: document.getElementById("tab-fleet"),
  tabBooks: document.getElementById("tab-books"),
  tabWorld: document.getElementById("tab-world"),
  // #cb-feed is cb.js's one persistent feed element, captured once here -
  // renderWorldTab reparents it into World's own slot while a career is
  // active; updateCareerHud moves it back the moment the career ends
  // (see prevCareerActive below). Never destroyed, only relocated.
  cbFeed: document.getElementById("cb-feed"),
  tabCbHome: document.getElementById("tab-cb"),
};

// Down from 7 to 5: REST folds Showers+Sleeper (both are "recover" actions),
// SUPPLIES folds Store+Diner (both are "buy consumables" actions) - a phone
// width can't show 7 tabs without one scrolled off, and the two merges are
// natural (see the plan's truck-stop rework section).
const VENDORS = ["FUEL", "REST", "SUPPLIES", "SHOP", "LOADS"];
const VENDOR_LABEL = { FUEL: "Fuel", REST: "Rest", SUPPLIES: "Supplies", SHOP: "Shop", LOADS: "Loads" };

let onStartCareer = null; // () => void - main.js decides which truck becomes the career truck
let onTimeAdvanced = null; // (newGameSeconds) => void - keeps main.js's state.gameSeconds in sync
let onRollOut = null; // () => void - main.js re-checks for a pending junction decision after resuming
let onCareerEnded = null; // () => void - reserved, not fired yet
let onHireDriver = null; // (driver: DriverDNA) => {ok, reason?} - main.js is the only place that can actually construct a Truck and push it into the live fleet (career.js never touches `trucks`)
let onSwitchTruck = null; // (truckId) => {ok, reason?} - main.js owns state.decisionTruck/contractTruck (the only thing worth gating on - the truck-stop overlay already makes FLEET structurally unreachable while it's open) and the actual switchActiveTruck + followTruck call

let open = false;
let activeVendor = "FUEL";
let stopCtx = null; // { truck, graph, trucks, weather, boardOffers }
let fuelUnitsThisStop = 0; // tracked for the shower's "free with a big fill" perk
let hireCandidate = null; // the currently-rolled DriverDNA shown in FLEET's hiring section, re-rolled each time it renders fresh

export function initCareerUI(callbacks) {
  onStartCareer = callbacks.onStartCareer;
  onTimeAdvanced = callbacks.onTimeAdvanced;
  onHireDriver = callbacks.onHireDriver || null;
  onSwitchTruck = callbacks.onSwitchTruck || null;
  onRollOut = callbacks.onRollOut;
  onCareerEnded = callbacks.onCareerEnded || null;

  careerEl.btnCareer.addEventListener("click", () => {
    if (career.isActive()) {
      // Not a toggle for STARTING a career - but it doubles as the way
      // back into a truck stop the player dismissed with Leave Cab
      // (closeTruckStop no longer lets main.js silently re-open it every
      // frame - see dismissedParkedAt below). stopCtx still holds valid
      // graph/trucks/weather from the last time this stop legitimately
      // opened, so re-opening just replays that.
      if (!open && stopCtx && lastHudTruck && wasStopDismissed(lastHudTruck)) {
        openTruckStop(stopCtx.truck, stopCtx.graph, stopCtx.trucks, stopCtx.weather);
      }
      return;
    }
    if (onStartCareer) onStartCareer();
  });
  careerEl.careerStatus.addEventListener("click", () => {
    if (career.isActive()) openTab("rig");
  });
  careerEl.btnClose.addEventListener("click", closeTruckStop);
  careerEl.btnRollOut.addEventListener("click", handleRollOut);

  careerEl.tabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-vendor]");
    if (!btn) return;
    switchVendor(btn.dataset.vendor);
  });

  // Delegated click for every vendor item grid - each button carries
  // data-action/data-arg so one listener covers FUEL/REST/SUPPLIES/SHOP/
  // LOADS without five separate handlers. A "logically disabled" item
  // (can't afford it, wrong requirements) keeps its data-action and a
  // .disabled class instead of the native disabled attribute, plus a
  // data-reason - so clicking it still fires here and can toast WHY,
  // rather than silently doing nothing (native :disabled never dispatches
  // a click at all). An item with no data-action (MECHANIC's "Maxed out"
  // card) is simply inert, same as before.
  careerEl.content.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.classList.contains("disabled")) {
      if (btn.dataset.reason) toastNow(btn.dataset.reason);
      return;
    }
    handleAction(btn.dataset.action, btn.dataset.arg);
  });

  // RIG's own delegated listener - throttle (3 buttons, real numbers) and
  // PULL IN both live here now instead of static always-visible HUD
  // buttons, so both need to re-render RIG itself after acting.
  careerEl.tabRig.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || btn.disabled) return;
    const p = career.getProfile();
    if (btn.dataset.action === "throttle") {
      if (!p.active) return;
      p.throttle = btn.dataset.arg;
      if (lastHudTruck && lastHudTruck.agent) lastHudTruck.agent.recompute();
      renderRigTab(p, lastHudTruck, lastKnownGameSeconds);
    } else if (btn.dataset.action === "pull-in") {
      // lastHudTruck, not stopCtx.truck: stopCtx is only ever written by
      // openTruckStop, so on a fresh career (no stop has opened yet) or
      // right after a save reload (stopCtx still points at last
      // session's now-defunct Truck instance) reading it here would
      // silently no-op. lastHudTruck is refreshed every frame by
      // updateCareerHud regardless of whether a stop has ever opened.
      if (!lastHudTruck || !lastHudTruck.agent) return;
      lastHudTruck.agent.pullInRequested = true;
      renderRigTab(p, lastHudTruck, lastKnownGameSeconds);
    }
  });

  // FLEET's own delegated listener - hiring lives here now, not buried in
  // the truck stop's load board (it's about the whole company, not one
  // stop).
  careerEl.tabFleet.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || btn.disabled) return;
    if (btn.dataset.action === "reroll-hire") {
      hireCandidate = career.rollHireCandidate();
      renderFleetTab(career.getProfile(), lastTruckById);
    } else if (btn.dataset.action === "hire") {
      if (!hireCandidate || !onHireDriver) return;
      const res = onHireDriver(hireCandidate);
      if (res && res.ok) hireCandidate = null; // hired - next render rolls a fresh candidate
      renderFleetTab(career.getProfile(), lastTruckById);
    } else if (btn.dataset.action === "switch-truck") {
      if (!onSwitchTruck) return;
      const res = onSwitchTruck(btn.dataset.arg);
      if (res && res.ok) renderFleetTab(career.getProfile(), lastTruckById);
      else if (res && res.reason) toastNow(res.reason);
    } else if (btn.dataset.action === "set-logo-color") {
      const cur = career.getProfile().logo;
      career.setLogo(btn.dataset.arg, cur?.glyph || null);
      renderFleetTab(career.getProfile(), lastTruckById);
    } else if (btn.dataset.action === "set-logo-glyph") {
      const cur = career.getProfile().logo;
      const color = cur?.color || career.LOGO_PALETTE[0].color;
      career.setLogo(color, btn.dataset.arg || null);
      renderFleetTab(career.getProfile(), lastTruckById);
    }
  });

  // BOOKS' own save/delete controls - separate listener since the tab is
  // visible any time (not just while a truck stop is open), so it can't
  // rely on stopCtx being set.
  careerEl.tabBooks.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "save-career") {
      lastSaveOk = career.save();
      renderBooksTab(career.getProfile(), lastHudTruck);
    } else if (btn.dataset.action === "delete-save") {
      if (!confirm("Delete your saved career? This can't be undone.")) return;
      career.deleteSave();
      renderBooksTab(career.getProfile(), lastHudTruck);
    }
  });
}

let lastTruckById = null; // stashed so FLEET's own hire/reroll re-renders (no main.js round-trip) don't lose every hired truck's live status
let lastRigGraph = null; // stashed so RIG's own throttle/pull-in re-renders (no main.js round-trip) keep PULL IN's next-city subtitle working
let lastSaveOk = null;

export function isTruckStopOpen() { return open; }

// Which vendor tab to open on, on ARRIVAL only (switchVendor still works
// freely once the stop is open). A mid-route fuel/pull-in stop
// (stopVendor "PUMPS") can only ever mean one thing, so it's untouched. A
// genuine delivery arrival (stopVendor "BOARD") is otherwise a fine
// default - but if the player is also critically low on fuel/rest/food,
// forcing them to notice and click away from the load board first, in a
// moment that's supposed to read as "you just got here, you need gas,"
// is the wrong first screen. This never writes truck.stopVendor itself -
// that field stays exactly what fleet.js set it to, since career.js's
// delivery-credit check (tickNeeds) and the Roll Out gate below both key
// off that same field meaning "a load hasn't been taken yet."
function pickDefaultVendor(truck) {
  // truck.stopVendor is fleet.js/career.js's own field for WHY the truck
  // stopped ("BOARD" = arrived for a delivery, "PUMPS" = a fuel-critical
  // pull-in, null otherwise) - unrelated to and untouched by this UI's own
  // (renamed) vendor-tab keys below.
  if (truck.stopVendor !== "BOARD") return "FUEL";
  const p = career.getProfile();
  if (Math.round(truck.fuel) <= 15) return "FUEL";
  if (truck.fatigue > 70) return "REST";
  if (p.hunger < 20) return "SUPPLIES";
  return "LOADS";
}

export function openTruckStop(truck, graph, trucks, weather) {
  stopCtx = { truck, graph, trucks, weather, boardOffers: null };
  open = true;
  dismissedParkedAt = null; // a stop that's actually opening is (by definition) no longer dismissed
  fuelUnitsThisStop = 0;
  activeVendor = pickDefaultVendor(truck);
  careerEl.city.textContent = truck.parkedAt || "Truck Stop";
  careerEl.overlay.classList.remove("hidden");
  renderTabs();
  renderVendor();
  renderStatus();
}

// The parkedAt of the stop the player last closed with "Leave Cab" rather
// than ROLL OUT - main.js's per-frame open-check (main.js's career tick)
// consults wasStopDismissed() before calling openTruckStop again, so
// closing the overlay actually leaves the cab instead of being reopened
// the very next frame. Cleared whenever a stop legitimately opens or the
// truck rolls out to a new one, so it never suppresses a FUTURE stop -
// only the exact one the player just backed out of.
let dismissedParkedAt = null;

export function wasStopDismissed(truck) {
  return dismissedParkedAt != null && truck && truck.parkedAt === dismissedParkedAt;
}

export function closeTruckStop() {
  // "Leave Cab" without rolling out is just closing the overlay to look
  // at the map/dashboard - the truck is still parked and stopped. There
  // is deliberately no way to leave the truck MOVING without going
  // through ROLL OUT (ending a PLAYER stop always goes through
  // career.rollOut/takeOffer, never just closing this panel). Tap the
  // CAREER button (or the status bar) to get back in.
  open = false;
  if (stopCtx) dismissedParkedAt = stopCtx.truck.parkedAt;
  careerEl.overlay.classList.add("hidden");
}

function switchVendor(name) {
  activeVendor = name;
  renderTabs();
  renderVendor();
}

function renderTabs() {
  careerEl.tabs.innerHTML = VENDORS.map((v) =>
    `<button class="vendor-tab-btn${v === activeVendor ? " active" : ""}" data-vendor="${v}">${VENDOR_LABEL[v]}</button>`
  ).join("");
  // All 5 fit a phone width now (down from 7), but this still guards a
  // stop that opens straight onto a tab near the end (LOADS, on a delivery
  // arrival) rendering with its own active tab scrolled off-screen, no
  // visual cue which vendor you're even looking at. block:"nearest" only
  // scrolls if it's actually out of view.
  const activeBtn = careerEl.tabs.querySelector(".vendor-tab-btn.active");
  if (activeBtn) activeBtn.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// One shared "advance time while parked" path for DINER/SHOWERS/SLEEPER -
// see career.js's advanceTime doc comment for why this can never be a
// flat clock add: it's a real bounded-substep fastForwardHours run, so
// the rest of the fleet keeps living while the player eats/showers/
// sleeps. `postRender` runs after time has actually passed and the
// vendor is asked to re-render itself against the new state.
function advanceAndRefresh(hours) {
  const { truck, graph, trucks, weather } = stopCtx;
  const result = career.advanceTime(graph, trucks, weather, truck, currentGameSeconds, hours, { showWeather: false, showRushHour: true });
  currentGameSeconds = result.gameSeconds;
  if (onTimeAdvanced) onTimeAdvanced(currentGameSeconds);
  renderVendor();
  renderStatus();
}

let currentGameSeconds = 0;
// Called every frame while the takeover is open (main.js) - keeps the
// header clock and footer status strip live even when nothing's been
// clicked, and is the ONLY place currentGameSeconds is set from outside
// (advanceAndRefresh keeps it in sync internally after its own jumps).
export function refreshTruckStop(gameSeconds) {
  if (!open) return;
  currentGameSeconds = gameSeconds;
  careerEl.clock.textContent = formatClockShort(gameSeconds);
  renderStatus();
}

function formatClockShort(gameSeconds) {
  let m = Math.floor((gameSeconds % 86400) / 60);
  let h = Math.floor(m / 60);
  m = m % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m < 10 ? "0" + m : m} ${ampm}`;
}

// hours (float) -> "3h 20m" / "45m" / "overdue" - shared by the truck
// stop's own clock-adjacent copy and RIG's ETA/hotshot/buff countdowns.
function formatHours(h) {
  if (h < 0) return "overdue";
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
}

// Shared stat-bar builder (RIG's vitals, BOOKS' XP progress). `valueLabel`
// overrides the default "NN%" readout (used for XP's "X / Y XP" phrasing);
// `sub` appends a bullet-separated hint after it (RIG's fuel range). `hero`
// (RIG's Fuel/Fatigue only) renders a taller, bigger-type bar - the two
// vitals players actually need to find at a glance, previously buried in a
// flat list of seven identical-looking rows.
function statBar(label, value01, color, sub, valueLabel, hero) {
  const shown = valueLabel || `${Math.round(value01 * 100)}%`;
  return `<div class="stat-bar-row${hero ? " hero" : ""}">
    <div class="stat-bar-label"><span>${label}</span><span>${shown}${sub ? " &bull; " + sub : ""}</span></div>
    <div class="stat-bar"><div class="stat-bar-fill" style="width:${Math.max(0, Math.min(100, value01 * 100))}%;background:${color}"></div></div>
  </div>`;
}

function statChip(label, value, color) {
  return `<div class="stat-chip"><span class="stat-label">${label}</span><span style="color:${color || "var(--ink)"}">${value}</span></div>`;
}

// Attribute-safe escaping for the disabled-reason strings baked into
// data-reason (they can contain a live dollar amount or a reputation
// number, never raw user input, but the quote still has to be escaped).
function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function renderStatus() {
  if (!stopCtx) return;
  const { truck } = stopCtx;
  const p = career.getProfile();
  const fuelPct = Math.round(truck.fuel);
  const fuelColor = fuelPct > 50 ? "var(--go)" : fuelPct > 15 ? "var(--caution)" : "var(--stop)";
  const fatigueColor = truck.fatigue > 70 ? "var(--stop)" : truck.fatigue > 40 ? "var(--caution)" : "var(--go)";
  const hungerColor = p.hunger < 20 ? "var(--stop)" : p.hunger < 45 ? "var(--caution)" : "var(--go)";
  const moraleColor = p.morale < 30 ? "var(--stop)" : p.morale < 55 ? "var(--caution)" : "var(--go)";
  careerEl.status.innerHTML = [
    statChip("Cash", "$" + Math.round(p.cash).toLocaleString(), p.cash < 0 ? "var(--stop)" : "var(--go)"),
    statChip("Fuel", fuelPct + "%", fuelColor),
    statChip("Fatigue", Math.round(truck.fatigue) + "%", fatigueColor),
    statChip("Hunger", Math.round(p.hunger) + "%", hungerColor),
    statChip("Morale", Math.round(p.morale) + "%", moraleColor),
  ].join("");

  // ROLL OUT is only meaningful once there's actually somewhere to roll
  // out TO: a mid-route stop always has one (the existing route), a
  // delivery stop (BOARD vendor) needs a load picked first.
  const canRollOut = truck.stopVendor !== "BOARD";
  careerEl.btnRollOut.disabled = !canRollOut;
  careerEl.btnRollOut.textContent = canRollOut ? "ROLL OUT" : "PICK A LOAD FIRST";
}

function renderVendor() {
  const fn = { FUEL: renderPumps, REST: renderRest, SUPPLIES: renderSupplies, SHOP: renderMechanic, LOADS: renderBoard }[activeVendor];
  careerEl.content.innerHTML = fn ? fn() : "";
}

// Every vendor-item button below follows the same pattern for a "logically
// disabled" item: keep data-action/data-arg (so the delegated click
// listener above still sees it), add the .disabled class instead of the
// native disabled attribute, and set data-reason to whatever {ok:false,
// reason} string the matching career.js call would have returned - so a
// tap on a greyed-out item explains itself instead of doing nothing.

const FUEL_PRICE_BASE = 3.5;
function renderPumps() {
  const { truck } = stopCtx;
  const p = career.getProfile();
  // Regional price variance, deterministic per city so it doesn't flicker
  // between renders - a light hash of the city name.
  let h = 0; for (const c of truck.parkedAt || "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const price = Math.round((FUEL_PRICE_BASE + ((h % 60) / 100 - 0.3)) * 100) / 100;
  const range = Math.round(estimatedRangeMiles(truck));
  const maxAffordable = career.maxAffordableFuelUnits(truck, price);
  const tankFull = truck.fuelCapacity - truck.fuel < 0.1;
  const brokeForFuel = !tankFull && maxAffordable < 0.1;
  const fillReason = tankFull ? "Tank's already full." : brokeForFuel ? "Can't afford any fuel." : "";
  const fillLevels = [
    { label: "Top 25%", units: Math.min(maxAffordable, truck.fuelCapacity * 0.25) },
    { label: "Top 50%", units: Math.min(maxAffordable, truck.fuelCapacity * 0.5) },
    { label: "Fill 'Er Up", units: maxAffordable },
  ];
  return `
    <div class="vendor-section-title">Diesel &mdash; $${price.toFixed(2)}/gal &bull; tank ${Math.round(truck.fuel)}% &bull; ~${range.toLocaleString()} mi range</div>
    <div class="vendor-grid">
      ${fillLevels.map((f) => {
        const disabled = f.units < 0.1;
        return `<button class="vendor-item${disabled ? " disabled" : ""}" data-action="fuel" data-arg="${f.units.toFixed(2)}|${price}"${disabled && fillReason ? ` data-reason="${escAttr(fillReason)}"` : ""}>
          <span class="v-name">${f.label}</span>
          <span class="v-desc">+${Math.round(f.units)} gal</span>
          <span class="v-meta"><span></span><span class="v-price expense">$${Math.round(f.units * price).toLocaleString()}</span></span>
        </button>`;
      }).join("")}
    </div>
    <div class="vendor-section-title" style="margin-top:4px;">Cash on hand: $${Math.round(p.cash).toLocaleString()}</div>
  `;
}

// REST = Showers + Sleeper - both are "recover" actions, and a phone-width
// vendor row can't show all 7 of the old vendors without one scrolling off.
const NAP_LENGTHS = [2, 4, 6, 8, 10];
function renderRest() {
  const { truck } = stopCtx;
  const p = career.getProfile();
  const free = fuelUnitsThisStop >= 40; // mirrors career.js's own (unexported) SHOWER_FREE_FUEL_UNITS
  const showerDisabled = !free && p.cash < 14;
  // Sleeper preview: current fatigue -> projected fatigue for each nap
  // length, using the truck's own live restMult (folds in the Sleeper Bunk
  // upgrade and any active buff like Sleep Aid) - the actual number that
  // hour of sleep will produce, not a flat/generic estimate.
  const restMult = truck.agent ? truck.agent.restMult : 1;
  const napRows = NAP_LENGTHS.map((hrs) => {
    const projected = Math.max(0, truck.fatigue - hrs * FATIGUE_RECOVERY_PER_HOUR * restMult);
    return `
      <button class="vendor-item" data-action="sleep" data-arg="${hrs}">
        <span class="v-name">${hrs}h Nap</span>
        <span class="v-desc">Fatigue ${Math.round(truck.fatigue)}% &rarr; ${Math.round(projected)}%</span>
        <span class="v-meta"><span>${hrs}h</span><span class="v-price">FREE</span></span>
      </button>`;
  }).join("");
  const motelDisabled = p.cash < 60;
  return `
    <div class="vendor-section-title">Showers</div>
    <div class="vendor-grid">
      <button class="vendor-item${showerDisabled ? " disabled" : ""}" data-action="shower" data-arg=""${showerDisabled ? ` data-reason="${escAttr("Can't afford it. ($14)")}"` : ""}>
        <span class="v-name">Hot Shower</span>
        <span class="v-desc">${free ? "Free - you filled up enough this stop" : "+15 morale"}</span>
        <span class="v-meta"><span>0.5h</span><span class="v-price ${free ? "" : "expense"}">${free ? "FREE" : "$14"}</span></span>
      </button>
    </div>
    <div class="vendor-section-title">Sleeper Cab &mdash; pick a nap length</div>
    <div class="vendor-grid">${napRows}</div>
    <div class="vendor-section-title">Motel</div>
    <div class="vendor-grid">
      <button class="vendor-item${motelDisabled ? " disabled" : ""}" data-action="motel" data-arg=""${motelDisabled ? ` data-reason="${escAttr("Can't afford it. ($60)")}"` : ""}>
        <span class="v-name">Motel Room</span>
        <span class="v-desc">Full fatigue clear, bigger morale/hunger top-up - real function beats a free nap</span>
        <span class="v-meta"><span>8h</span><span class="v-price expense">$60</span></span>
      </button>
    </div>`;
}

function summarizeEffects(item) {
  const bits = [];
  if (item.immediate) {
    if (item.immediate.fatigue) bits.push(`${item.immediate.fatigue} fatigue`);
    if (item.immediate.hunger) bits.push(`+${item.immediate.hunger} hunger`);
    if (item.immediate.morale) bits.push(`+${item.immediate.morale} morale`);
  }
  if (item.buffHours) bits.push(`${item.buffHours}h buff`);
  // A buff's sustained effects (fatigueMult/speedMult) and its expiry crash
  // used to be entirely invisible here - Energy Drink's and Trucker's
  // Choice's crash risk, and now Bottomless Cup's small sustained relief,
  // were all silently dropped from the shop listing despite being real.
  if (item.effects) {
    if (item.effects.fatigueMult) bits.push(`-${Math.round((1 - item.effects.fatigueMult) * 100)}% fatigue buildup`);
    if (item.effects.speedMult) bits.push(`+${Math.round((item.effects.speedMult - 1) * 100)}% speed`);
  }
  if (item.dui) bits.push(`DUI risk`);
  if (item.crash?.fatigue) bits.push(`crash: +${item.crash.fatigue} fatigue on wear-off`);
  return bits.join(" &bull; ") || "&nbsp;";
}

const STORE_CATEGORIES = [
  { key: "CAFFEINE", label: "Caffeine & Stimulants" },
  { key: "FOOD", label: "Snacks" },
  { key: "BOOZE", label: "Vices" },
  { key: "GEAR", label: "Gear" },
];

// SUPPLIES = Store + Diner - both are "buy a consumable" actions. The
// store's own 15 items are grouped by career.js's STORE_ITEMS[].cat rather
// than one long flat grid.
function renderSupplies() {
  const { truck, graph } = stopCtx;
  const p = career.getProfile();
  const node = graph.nodes[truck.parkedAt];
  const special = career.regionalSpecialFor(node);
  const dinerRows = Object.entries(career.DINER_MENU).map(([tier, item]) => {
    const disabled = p.cash < item.price;
    return `
      <button class="vendor-item${disabled ? " disabled" : ""}" data-action="diner" data-arg="${tier}"${disabled ? ` data-reason="${escAttr(`Can't afford it. ($${item.price})`)}"` : ""}>
        <span class="v-name">${item.label}</span>
        <span class="v-desc">${tier === "SITDOWN" ? "Today's special: " + special : `+${item.immediate.hunger} hunger &bull; ${item.hours}h`}</span>
        <span class="v-meta"><span>${item.hours}h</span><span class="v-price expense">$${item.price}</span></span>
      </button>`;
  }).join("");

  const catSections = STORE_CATEGORIES.map((cat) => {
    const rows = Object.entries(career.STORE_ITEMS).filter(([, item]) => item.cat === cat.key).map(([kind, item]) => {
      const parkedBlock = item.parkedOnly && truck.edge;
      const repBlock = item.repMin != null && p.reputation < item.repMin;
      const owned = item.permanent && p.upgrades[item.permanent];
      const cashBlock = p.cash < item.price;
      const disabled = parkedBlock || repBlock || owned || cashBlock;
      const reason = parkedBlock ? "Parked only - pull over first."
        : repBlock ? `Requires reputation ${item.repMin}+ (you're ${Math.round(p.reputation)}).`
        : cashBlock ? `Can't afford it. ($${item.price})`
        : "";
      const desc = owned ? "Already own this" : item.permanent ? "Permanent upgrade" : summarizeEffects(item);
      return `
        <button class="vendor-item${disabled ? " disabled" : ""}" data-action="store" data-arg="${kind}"${disabled && reason ? ` data-reason="${escAttr(reason)}"` : ""}>
          <span class="v-name">${item.label}${owned ? " &#10003;" : ""}</span>
          <span class="v-desc">${desc}</span>
          <span class="v-meta"><span></span><span class="v-price expense">$${item.price}</span></span>
        </button>`;
    }).join("");
    return rows ? `<div class="vendor-section-title">${cat.label}</div><div class="vendor-grid">${rows}</div>` : "";
  }).join("");

  return `<div class="vendor-section-title">Diner</div><div class="vendor-grid">${dinerRows}</div>${catSections}`;
}

function renderMechanic() {
  const p = career.getProfile();
  const cost = career.repairCost(p.wear);
  const repairDisabled = p.wear < 1 || p.cash < cost;
  const repairReason = p.wear >= 1 && p.cash < cost ? `Can't afford it. ($${cost})` : "";
  const upgradeRows = Object.entries(career.UPGRADES).map(([key, def]) => {
    const tier = typeof p.upgrades[def.field] === "boolean" ? (p.upgrades[def.field] ? 1 : 0) : p.upgrades[def.field];
    if (tier >= def.maxTier) {
      return `<button class="vendor-item disabled" disabled><span class="v-name">${def.label}</span><span class="v-desc">Maxed out</span></button>`;
    }
    const upgradeCost = def.costs[tier];
    const levelReq = def.levelReq[tier];
    const locked = p.level < levelReq;
    const missingPrereq = def.requires && !p.upgrades[def.requires];
    const disabled = locked || missingPrereq || p.cash < upgradeCost;
    const reason = missingPrereq ? `Requires ${def.requiresLabel} first.` : locked ? `Requires level ${levelReq} (you're ${p.level}).` : p.cash < upgradeCost ? `Can't afford it. ($${upgradeCost.toLocaleString()})` : "";
    const effect = UPGRADE_EFFECT[key](p);
    return `
      <button class="vendor-item${disabled ? " disabled" : ""}" data-action="upgrade" data-arg="${key}"${disabled && reason ? ` data-reason="${escAttr(reason)}"` : ""}>
        <span class="v-name">${def.label}${def.maxTier > 1 ? ` (Tier ${tier + 1}/${def.maxTier})` : ""}</span>
        <span class="v-desc">${effect}</span>
        <span class="v-meta"><span></span><span class="v-price expense">$${upgradeCost.toLocaleString()}</span></span>
      </button>`;
  }).join("");
  return `
    <div class="vendor-section-title">Mechanic &mdash; rig condition: ${Math.round(100 - p.wear)}%</div>
    <div class="vendor-grid">
      <button class="vendor-item${repairDisabled ? " disabled" : ""}" data-action="repair" data-arg=""${repairDisabled && repairReason ? ` data-reason="${escAttr(repairReason)}"` : ""}>
        <span class="v-name">Full Once-Over</span>
        <span class="v-desc">${p.wear < 1 ? "Nothing needs fixing right now" : "Resets wear to 0"}</span>
        <span class="v-meta"><span></span><span class="v-price expense">$${cost}</span></span>
      </button>
    </div>
    <div class="vendor-section-title">Upgrades &mdash; Level ${p.level} (${p.xp.toLocaleString()} XP)</div>
    <div class="vendor-grid">${upgradeRows}</div>`;
}

// What buying the NEXT tier of each upgrade actually does, in plain terms -
// previously the mechanic panel showed only "Installed permanently" with no
// hint of the effect. TANK/RADAR read their real magnitudes off career.js's
// exported constants rather than duplicating the numbers here, so this
// can't drift out of sync with what buyUpgrade/tickNeeds/buyStoreItem
// actually do.
const UPGRADE_EFFECT = {
  ENGINE: () => "+2% cruise speed per tier",
  TIRES: () => "−10% wear buildup per tier",
  SLEEPER: () => "+15% rest recovery per tier",
  AERO: () => "−10% fuel burn",
  TANK: () => `+${career.TANK_UPGRADE_CAPACITY_BONUS}% fuel capacity`,
  APU: () => "+10% rest recovery (stacks with Sleeper Bunk)",
  // Tier 2 - strictly better than (and requires) the Store's own $180
  // Radar Detector, which stays at its own -45%/-50% (see the Store's
  // GEAR category). Buying both is a real upgrade path, not the same
  // flag bought twice.
  RADAR: () => `−${Math.round((1 - career.RADAR_TIER2_TICKET_MULT) * 100)}% ticket risk, −${Math.round((1 - career.RADAR_TIER2_DUI_MULT) * 100)}% DUI risk (supersedes the Store's Radar Detector)`,
};

// Shared by FLEET's own render below - hiring is about the company as a
// whole, not any one stop, so it no longer lives on the load board.
function renderHiringSection() {
  if (!onHireDriver) return ""; // main.js didn't wire hiring in (shouldn't happen, but never render a dead button)
  const p = career.getProfile();
  if (!hireCandidate) hireCandidate = career.rollHireCandidate();
  const traits = traitSummary(hireCandidate).map((t) =>
    `<span class="chip active" style="cursor:default;background:${t.color};border-color:${t.color};">${t.label}</span>`
  ).join("") || `<span class="row-sub">No standout traits - a steady, ordinary driver.</span>`;
  const locked = p.level < career.HIRE_MIN_LEVEL;
  const cantAfford = !locked && p.cash < career.HIRE_COST;
  const disabled = locked || cantAfford;
  return `
    <div class="section-label">Hire a Driver &mdash; ${p.hiredTrucks.length} on payroll</div>
    <div class="vendor-grid">
      <div class="vendor-item" style="cursor:default;">
        <span class="v-name">Candidate</span>
        <div class="chip-row" style="margin:4px 0;">${traits}</div>
        <span class="v-desc">${locked ? `Requires level ${career.HIRE_MIN_LEVEL} (you're ${p.level})` : cantAfford ? `Can't afford it. ($${career.HIRE_COST.toLocaleString()})` : "Spawns as a new truck, hauling on its own from wherever you are now"}</span>
      </div>
      <button class="vendor-item${disabled ? " disabled" : ""}" data-action="hire" data-arg="" ${disabled ? "disabled" : ""}>
        <span class="v-name">Hire This Driver</span>
        <span class="v-desc">Signing bonus, one-time</span>
        <span class="v-meta"><span></span><span class="v-price expense">$${career.HIRE_COST.toLocaleString()}</span></span>
      </button>
      <button class="vendor-item" data-action="reroll-hire" data-arg="">
        <span class="v-name">Different Candidate</span>
        <span class="v-desc">Free - see who else is available</span>
      </button>
    </div>`;
}

function renderBoard() {
  const { truck, graph } = stopCtx;
  if (truck.stopVendor !== "BOARD") {
    return `<div class="vendor-section-title">Load Board</div><div class="placeholder-text">Nothing to pick up here - you're between drops.</div>`;
  }
  // Generated once per stop and cached on stopCtx (fresh again next stop,
  // since openTruckStop always makes a new stopCtx) - renderBoard used to
  // call generateContractOffers on every re-render, so any OTHER action at
  // this stop (buying fuel, a sandwich) silently re-rolled all three offers
  // and re-rolled whether any of them was a hotshot.
  if (!stopCtx.boardOffers) {
    const offers = generateContractOffers(graph, truck.parkedAt, 3, Math.random);
    career.decorateHotshot(offers);
    stopCtx.boardOffers = offers;
  }
  const offers = stopCtx.boardOffers;
  if (!offers.length) return `<div class="vendor-section-title">Load Board</div><div class="placeholder-text">Nothing routable from here right now.</div>`;
  const rows = offers.map((o, i) => {
    const rpm = o.payout / Math.max(1, o.optimalMiles);
    const hotshotBadge = o.hotshot
      ? `<span class="v-desc" style="color:var(--stop);font-weight:600;">HOTSHOT &bull; ${o.deadlineHours.toFixed(1)}h deadline &bull; +$${o.bonusPayout.toLocaleString()} on time</span>`
      : "";
    return `
      <button class="vendor-item" data-action="take-load" data-arg="${i}" style="--cargo:${o.truckType.color}">
        <span class="v-name">${o.cargo}</span>
        <span class="v-desc">&rarr; ${o.destination} &bull; ${Math.round(o.optimalMiles).toLocaleString()} mi &bull; $${rpm.toFixed(2)}/mi</span>
        ${hotshotBadge}
        <span class="v-meta"><span>${o.truckType.label}</span><span class="v-price">$${o.payout.toLocaleString()}</span></span>
      </button>`;
  }).join("");
  careerEl._lastOffers = offers; // stashed for the click handler (index-based lookup)
  return `<div class="vendor-section-title">Load Board &mdash; ${truck.parkedAt}</div><div class="vendor-grid">${rows}</div>`;
}

function handleAction(action, arg) {
  const { truck, graph } = stopCtx;
  if (action === "fuel") {
    const [unitsStr, priceStr] = arg.split("|");
    pumpFuel(truck, parseFloat(unitsStr), parseFloat(priceStr));
    fuelUnitsThisStop += parseFloat(unitsStr);
    renderVendor(); renderStatus();
  } else if (action === "store") {
    const res = career.buyStoreItem(truck, arg);
    if (res.ok && career.STORE_ITEMS[arg].buffHours) career.stampLatestBuffExpiry(currentGameSeconds, career.STORE_ITEMS[arg].buffHours);
    renderVendor(); renderStatus();
  } else if (action === "diner") {
    const res = career.eatAtDiner(truck, arg);
    if (res.ok) advanceAndRefresh(res.hours);
  } else if (action === "shower") {
    const res = career.takeShower(fuelUnitsThisStop);
    if (res.ok) advanceAndRefresh(res.hours);
  } else if (action === "sleep") {
    advanceAndRefresh(parseFloat(arg));
  } else if (action === "motel") {
    const res = career.stayAtMotel(truck);
    if (res.ok) advanceAndRefresh(res.hours);
  } else if (action === "repair") {
    career.repairAtMechanic(truck);
    renderVendor(); renderStatus();
  } else if (action === "upgrade") {
    career.buyUpgrade(truck, arg);
    renderVendor(); renderStatus();
  } else if (action === "take-load") {
    const offer = careerEl._lastOffers && careerEl._lastOffers[parseInt(arg, 10)];
    if (!offer) return;
    career.takeOffer(graph, truck, offer, currentGameSeconds);
    closeTruckStop();
    if (onRollOut) onRollOut(null); // no junction pending - a fresh contract always starts clean
  }
}

function handleRollOut() {
  if (careerEl.btnRollOut.disabled) return;
  const { graph, truck } = stopCtx;
  const waiting = career.rollOut(graph, truck);
  closeTruckStop();
  dismissedParkedAt = null; // actually rolling out (not just closing the overlay) - nothing to suppress reopening for anymore
  if (onRollOut) onRollOut(waiting);
}

// --- toast layer -------------------------------------------------------
//
// #toast (index.html/style.css) was fully styled but had no JS owner -
// career.js's drainRecentLog() was written for exactly this and never
// actually called. Every buy/ticket/settlement/level-up/hire already
// pushes through career.js's pushLog; this just surfaces that feed as
// brief on-screen toasts instead of requiring a trip into a tab to notice
// anything happened.
const TOAST_DURATION_MS = 3200;
let lastToastedAt = null; // lazy-initialized on the first check (see checkToasts) so a resumed/loaded career doesn't replay its entire history as a toast flood
let toastQueue = [];
let toastTimer = null;

function checkToasts() {
  const log = career.drainRecentLog(); // newest-first, unshift'd by pushLog
  if (lastToastedAt == null) {
    lastToastedAt = log.length ? log[0].at : Date.now();
    return;
  }
  if (!log.length || log[0].at <= lastToastedAt) return;
  const fresh = [];
  for (const entry of log) {
    if (entry.at <= lastToastedAt) break;
    fresh.push(entry);
  }
  lastToastedAt = log[0].at;
  toastQueue.push(...fresh.reverse()); // oldest-of-this-batch first, so they display in the order they happened
  if (!toastTimer) showNextToast();
}

function showNextToast() {
  const next = toastQueue.shift();
  if (!next) { toastTimer = null; careerEl.toast.classList.add("hidden"); return; }
  careerEl.toast.textContent = next.text;
  careerEl.toast.classList.remove("hidden");
  toastTimer = setTimeout(showNextToast, TOAST_DURATION_MS);
}

// Immediate, UI-only toast (a disabled vendor item's reason) - distinct
// from checkToasts' feed of career.js's persistent, save-able log. Shares
// the same queue/timer so a reason toast never overlaps or cuts off one
// that's already showing.
function toastNow(text) {
  toastQueue.push({ text });
  if (!toastTimer) showNextToast();
}

// --- Status bar + tab-set swap -----------------------------------------

let lastHudTruck = null; // refreshed every frame regardless of which tab is open - RIG's throttle/PULL IN handlers need a reference that's never stale
let lastKnownGameSeconds = 0; // ditto - BOOKS/FLEET's settlement countdown falls back to this when a click-triggered re-render doesn't have gameSeconds on hand
let prevCareerActive = false; // edge-detects the active flip, for the tab-set swap fallback and the CB-feed reparent-back-on-end below

export function updateCareerHud(profile, truck, gameSeconds) {
  lastHudTruck = truck;
  lastKnownGameSeconds = gameSeconds;
  const active = profile.active;
  // Stronger mode-shift: career mode was visually just "spectator mode
  // plus a HUD strip" - the status bar/#btn-career.active already use
  // --go as the "you're driving" accent (vs. --caution, the app's
  // ordinary chrome accent - see #top-bar/#truckstop-header), but
  // nothing else in the shell picked it up. This class lets the same
  // --go accent spread to the rest of the top-level chrome (style.css)
  // while a career is active, instead of introducing a new color.
  document.body.classList.toggle("career-mode", active);
  careerEl.btnCareer.classList.toggle("active", active);
  careerEl.btnCareer.textContent = active ? "\u{1F69B} " + (truck ? truck.name : "CAREER") : "\u{1F69B} CAREER";

  if (active !== prevCareerActive) {
    // Tab-set swap: spectator (Dispatch/Rankings/Economy/CB) and career
    // (Rig/Fleet/Books/World) tabs never show at once. If the tab the
    // sheet currently has open just got hidden by this flip, fall back
    // to a sane default instead of leaving the sheet on an invisible tab.
    for (const btn of document.querySelectorAll(".spectator-tab")) btn.classList.toggle("hidden", active);
    for (const btn of document.querySelectorAll(".career-tab")) btn.classList.toggle("hidden", !active);
    const activeBtn = document.querySelector(".tab-btn.active");
    if (activeBtn && activeBtn.classList.contains("hidden")) openTab(active ? "rig" : "overview");
    // Career just ended - move the CB feed back to its spectator home
    // before spectator tabs come back on screen, or #tab-cb would show
    // empty (World's own slot, wherever it last was, is about to stop
    // being re-rendered).
    if (prevCareerActive && !active) {
      careerEl.tabCbHome.appendChild(careerEl.cbFeed);
      if (onCareerEnded) onCareerEnded();
    }
    prevCareerActive = active;
  }

  careerEl.careerStatus.classList.toggle("hidden", !active);
  if (active) checkToasts();
  else careerEl.toast.classList.add("hidden");
  if (!active || !truck) return;

  careerEl.careerStatusCash.textContent = "$" + Math.round(profile.cash).toLocaleString();
  careerEl.careerStatusCash.style.color = profile.cash < 0 ? "var(--stop)" : "var(--go)";
  const fuelPct = Math.round(truck.fuel);
  careerEl.careerStatusFuel.textContent = `FUEL ${fuelPct}%`;
  careerEl.careerStatusFuel.style.color = fuelPct > 20 ? "var(--ink)" : "var(--stop)";
  const fatiguePct = Math.round(truck.fatigue);
  careerEl.careerStatusFatigue.textContent = `FATIGUE ${fatiguePct}%`;
  careerEl.careerStatusFatigue.style.color = fatiguePct > 70 ? "var(--stop)" : fatiguePct > 40 ? "var(--caution)" : "var(--ink)";
  careerEl.careerStatusDest.textContent = truck.contract && truck.edge ? `→ ${truck.contract.destination}` : truck.parkedAt || "";
  const hotshot = truck.contract && truck.contract.hotshot && truck.contract.deadlineGameSeconds != null && truck.stopVendor !== "BOARD";
  careerEl.careerStatusHotshot.classList.toggle("hidden", !hotshot);
  if (hotshot) {
    const hoursLeft = (truck.contract.deadlineGameSeconds - gameSeconds) / 3600;
    careerEl.careerStatusHotshot.textContent = hoursLeft > 0 ? `HOTSHOT ${hoursLeft.toFixed(1)}h` : "HOTSHOT LATE";
  }
  // Heat only appeared in the old Career tab, so a ticket used to arrive
  // with zero warning while driving - the one place the player was
  // actually looking. Shown once it's high enough to matter (tickNeeds'
  // own ticket-chance roll only starts above 40).
  careerEl.careerStatusHeat.classList.toggle("hidden", profile.heat <= 40);
}

// Remaining distance to the truck's contract destination: the tail of
// its current edge plus every edge still queued in remainingPath.
function remainingMilesOf(truck) {
  if (!truck.contract) return 0;
  let miles = truck.edge ? Math.max(0, truck.edge.miles - truck.s) : 0;
  for (const e of truck.remainingPath) miles += e.miles;
  return miles;
}

// --- RIG - the cockpit ---------------------------------------------------
//
// "What am I doing right now, how am I holding up, and what can I do
// about it?" Status + vitals + buffs are read-only; throttle and PULL IN
// are the only two driving decisions a player makes outside a truck stop,
// now full-size instead of squeezed into the old always-visible HUD.

export function renderRigTab(profile, truck, gameSeconds, graph) {
  if (graph) lastRigGraph = graph; else graph = lastRigGraph;
  if (!profile.active || !truck) {
    careerEl.tabRig.innerHTML = `<div class="placeholder-text">Not driving right now. Tap CAREER to sign on as an owner-operator.</div>`;
    return;
  }
  preserveScroll(careerEl.tabRig, () => {
    let statusHtml;
    if (truck.disabledHoursLeft > 0) {
      statusHtml = `<div class="detail-header"><div><div class="detail-title" style="color:var(--stop);">BROKEN DOWN</div><div class="detail-sub">${truck.disabledHoursLeft.toFixed(1)}h until you're rolling again</div></div></div>`;
    } else if (truck.parkedAt) {
      statusHtml = `<div class="detail-header"><div><div class="detail-title">PARKED &mdash; ${truck.parkedAt}</div><div class="detail-sub">${truck.contract ? "Load in the truck stop's board" : "No load yet"}</div></div></div>`;
    } else if (truck.contract && truck.edge) {
      const miles = remainingMilesOf(truck);
      const etaH = miles / Math.max(20, truck.speed || 55);
      statusHtml = `<div class="detail-header"><div><div class="detail-title">HAULING</div><div class="detail-sub">${truck.contract.cargo} &rarr; <strong style="color:var(--ink);">${truck.contract.destination}</strong> &bull; ${Math.round(miles).toLocaleString()} mi &bull; ETA ~${formatHours(etaH)}</div></div></div>`;
    } else {
      statusHtml = `<div class="detail-header"><div><div class="detail-title">ON THE ROAD</div></div></div>`;
    }

    const hotshot = truck.contract && truck.contract.hotshot && truck.contract.deadlineGameSeconds != null && truck.stopVendor !== "BOARD";
    const hotshotHtml = !hotshot ? "" : (() => {
      const hoursLeft = (truck.contract.deadlineGameSeconds - gameSeconds) / 3600;
      return `<div class="metric-card bad" style="margin-bottom:12px;">
        <div class="metric-title">Hotshot Deadline</div>
        <div class="metric-value">${hoursLeft > 0 ? formatHours(hoursLeft) : "LATE"}</div>
        <div class="metric-sub">+$${truck.contract.bonusPayout.toLocaleString()} on time</div>
      </div>`;
    })();

    const range = Math.round(estimatedRangeMiles(truck));
    // Fuel and Fatigue are the two numbers players actually need to find
    // in a hurry - hero bars, first, ahead of the other five compact rows.
    const heroVitalsHtml = [
      statBar("Fuel", truck.fuel / 100, truck.fuel > 50 ? "var(--go)" : truck.fuel > 15 ? "var(--caution)" : "var(--stop)", `~${range} mi`, undefined, true),
      statBar("Fatigue", truck.fatigue / 100, truck.fatigue > 70 ? "var(--stop)" : truck.fatigue > 40 ? "var(--caution)" : "var(--go)", undefined, undefined, true),
    ].join("");
    const vitalsHtml = [
      statBar("Hunger", profile.hunger / 100, profile.hunger < 20 ? "var(--stop)" : profile.hunger < 45 ? "var(--caution)" : "var(--go)"),
      statBar("Morale", profile.morale / 100, profile.morale < 30 ? "var(--stop)" : profile.morale < 55 ? "var(--caution)" : "var(--go)"),
      statBar("Heat", profile.heat / 100, profile.heat > 60 ? "var(--stop)" : profile.heat > 40 ? "var(--caution)" : "var(--go)"),
      statBar("Health", profile.health / 100, profile.health < 50 ? "var(--stop)" : profile.health < 80 ? "var(--caution)" : "var(--go)"),
      statBar("Condition", (100 - profile.wear) / 100, profile.wear > 60 ? "var(--stop)" : profile.wear > 30 ? "var(--caution)" : "var(--go)"),
    ].join("");

    const buffsHtml = !profile.buffs.length ? `<div class="placeholder-text">Nothing running.</div>` : profile.buffs.map((b) => {
      const hoursLeft = Math.max(0, (b.expiresAtGameSeconds - gameSeconds) / 3600);
      const item = career.STORE_ITEMS[b.kind];
      const crashNote = item?.crash ? " &bull; rough crash when it wears off" : "";
      return `<div class="row-sub" style="padding:3px 0;">${b.label} &mdash; ${formatHours(hoursLeft)} left${crashNote}</div>`;
    }).join("");

    // Condensed into one segmented row (was three separate cards) - the
    // combined effect caption now lives on one shared line below instead
    // of being repeated per button.
    const throttleDefs = [
      { key: "CONSERVE", label: "Conserve", sub: `${Math.round((career.THROTTLE_MULT.CONSERVE - 1) * 100)}% speed &bull; -10% fuel &bull; -10% wear`, color: "var(--go)" },
      { key: "LEGAL", label: "Legal", sub: "Cruise speed", color: "var(--caution)" },
      { key: "HAMMER", label: "Hammer", sub: `+${Math.round((career.THROTTLE_MULT.HAMMER - 1) * 100)}% speed &bull; +15% fuel &bull; +25% wear &bull; draws heat`, color: "var(--stop)" },
    ];
    const activeThrottle = throttleDefs.find((t) => t.key === profile.throttle) || throttleDefs[1];
    const throttleHtml = `<div class="throttle-row">${throttleDefs.map((t) =>
      `<button class="throttle-seg${profile.throttle === t.key ? " active" : ""}" data-action="throttle" data-arg="${t.key}" style="--seg-color:${t.color};">${t.label}</button>`
    ).join("")}</div>
    <div class="row-sub" style="margin:4px 0 0;">${activeThrottle.sub}</div>`;

    // PULL IN's subtitle names the actual next real town ahead (or the
    // existing disabled-state strings when those apply) instead of the
    // old generic "Stop at the next town" - `graph` comes from main.js's
    // TAB_RENDERERS map, or the stashed lastRigGraph on a self-triggered
    // re-render (see this function's own top).
    const pullInDisabled = !truck.edge || (truck.agent && truck.agent.pullInRequested);
    const pullInSub = !truck.edge ? "You're parked - nowhere to pull in to"
      : (truck.agent && truck.agent.pullInRequested) ? "Already pulling in…"
      : (() => {
          const nextCity = graph ? career.nextPullInStopCity(graph, truck) : null;
          return nextCity ? `(${nextCity})` : "No town on this route";
        })();

    const upgradeChips = [];
    if (profile.upgrades.engine) upgradeChips.push(`Engine ${"I".repeat(profile.upgrades.engine)}`);
    if (profile.upgrades.tires) upgradeChips.push(`Tires ${"I".repeat(profile.upgrades.tires)}`);
    if (profile.upgrades.sleeper) upgradeChips.push(`Sleeper ${"I".repeat(profile.upgrades.sleeper)}`);
    if (profile.upgrades.aero) upgradeChips.push("Aero Kit");
    if (profile.upgrades.tank) upgradeChips.push("Big Tank");
    if (profile.upgrades.apu) upgradeChips.push("APU");
    if (profile.upgrades.radar) upgradeChips.push("Radar Detector");
    if (profile.upgrades.radarTier2) upgradeChips.push("Scanner Suite");
    if (profile.upgrades.atlas) upgradeChips.push("Road Atlas");
    if (profile.upgrades.audiobook) upgradeChips.push("Audiobook");
    if (profile.upgrades.cbAntenna) upgradeChips.push("CB Antenna");
    const chipsHtml = upgradeChips.length
      ? upgradeChips.map((c) => `<span class="chip active" style="cursor:default;">${c}</span>`).join("")
      : `<span class="row-sub">No upgrades yet - visit the Mechanic.</span>`;
    const a = truck.agent;
    const multsHtml = !a ? "" : `<div class="row-sub" style="padding:3px 0;">Speed &times;${a.speedMult.toFixed(2)} &bull; Fuel &times;${a.burnMult.toFixed(2)} &bull; Wear &times;${a.wearMult.toFixed(2)} &bull; Rest &times;${a.restMult.toFixed(2)}</div>`;

    careerEl.tabRig.innerHTML = `
      ${throttleHtml}
      <button class="pull-in-btn" data-action="pull-in" ${pullInDisabled ? "disabled" : ""}>
        <span class="pull-in-title">Pull In</span>
        <span class="pull-in-sub">${pullInSub}</span>
      </button>
      ${statusHtml}
      ${hotshotHtml}
      <div class="section-label">Vitals</div>
      ${heroVitalsHtml}
      ${vitalsHtml}
      <div class="section-label">Running Now</div>
      ${buffsHtml}
      <div class="section-label">Your Rig</div>
      <div class="row-sub" style="padding:3px 0;">${truck.name}${profile.homeCity ? ` &bull; out of ${profile.homeCity}` : ""}</div>
      <div class="chip-row" style="margin:6px 0;">${chipsHtml}</div>
      ${multsHtml}
    `;
  });
}

// --- FLEET - your company -----------------------------------------------
//
// "Who works for me, where are they, what are they earning me?" Your own
// rig plus every hired driver, and the hiring flow itself - moved here
// from the truck stop's load board, since it's about the whole company
// rather than any one stop.

// Shared fallback rule for a company's visual identity - an existing save
// with no profile.logo yet (or before profile.companyName exists at all)
// renders a sensible placeholder rather than needing a migration. render.js's
// map beacon (once it lands) computes this same fallback independently
// rather than importing from here, since it can't import career-ui.js.
function effectiveLogo(profile) {
  const logo = profile.logo;
  return {
    color: logo?.color || "#3f6fb0",
    glyph: logo?.glyph || null,
    monogram: logo?.monogram || career.deriveMonogram(profile.companyName || profile.truckName),
  };
}

function logoBadgeHTML(profile, sizePx = 40) {
  const logo = effectiveLogo(profile);
  const fontPx = Math.round(sizePx * 0.5);
  return `<div class="company-badge" style="width:${sizePx}px;height:${sizePx}px;font-size:${fontPx}px;background:${logo.color};">${logo.glyph || logo.monogram}</div>`;
}

// Palette swatches + glyph buttons (glyph list plus the plain monogram as
// its own "no glyph" option) - free to change any time (see career.js's
// setLogo doc comment: a logo is cosmetic, no fee to gate it behind).
function renderLogoPickerSection(profile) {
  const logo = effectiveLogo(profile);
  const swatches = career.LOGO_PALETTE.map((p) =>
    `<button class="logo-swatch${logo.color === p.color ? " active" : ""}" data-action="set-logo-color" data-arg="${p.color}" title="${p.label}" style="background:${p.color};"></button>`
  ).join("");
  const glyphButtons = career.LOGO_GLYPHS.map((g) =>
    `<button class="logo-glyph-btn${logo.glyph === g ? " active" : ""}" data-action="set-logo-glyph" data-arg="${g}">${g}</button>`
  ).join("");
  const monogramButton = `<button class="logo-glyph-btn${!logo.glyph ? " active" : ""}" data-action="set-logo-glyph" data-arg="" title="Use your monogram instead">${logo.monogram}</button>`;
  return `
    <div class="section-label">Company Logo</div>
    <div class="logo-picker-row">
      ${logoBadgeHTML(profile, 48)}
      <div class="logo-picker-groups">
        <div class="logo-swatch-row">${swatches}</div>
        <div class="logo-glyph-row">${glyphButtons}${monogramButton}</div>
      </div>
    </div>`;
}

export function renderFleetTab(profile, truckById) {
  if (truckById) lastTruckById = truckById; else truckById = lastTruckById;
  if (!profile.active) {
    careerEl.tabFleet.innerHTML = `<div class="placeholder-text">Not driving right now. Tap CAREER to sign on as an owner-operator.</div>`;
    return;
  }
  preserveScroll(careerEl.tabFleet, () => {
    const truck = lastHudTruck;
    const pendingTotal = profile.hiredTrucks.reduce((sum, h) => {
      const t = truckById?.get(h.id);
      return sum + (t ? Math.max(0, t.earnings - (h.lastSettledEarnings ?? 0)) : 0);
    }, 0);
    const settlementIn = Math.max(0, career.SETTLEMENT_INTERVAL_HOURS * 3600 - (lastKnownGameSeconds - (profile.lastSettlementGameSeconds ?? lastKnownGameSeconds)));
    const companyHeaderHtml = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
      ${logoBadgeHTML(profile, 36)}
      <div class="detail-title" style="font-size:1rem;">${profile.companyName || (profile.truckName ? `${profile.truckName}'s Fleet` : "Your Fleet")}</div>
    </div>`;
    const headerHtml = `<div class="detail-sub" style="margin-bottom:10px;">${profile.hiredTrucks.length} truck${profile.hiredTrucks.length === 1 ? "" : "s"} on payroll &bull; $${Math.round(pendingTotal).toLocaleString()} pending &bull; settles in ~${Math.ceil(settlementIn / 3600)}h</div>`;

    const yourRigHtml = !truck ? "" : `
      <div class="list-row" style="border-left-color:var(--go);cursor:default;">
        <div style="flex:1;">
          <div class="row-main">${truck.name} <span class="row-sub">(You)</span></div>
          <div class="row-sub">${truck.parkedAt ? "parked at " + truck.parkedAt : truck.disabledHoursLeft > 0 ? "disabled roadside" : "hauling"} &bull; ${truck.contractsCompleted} loads</div>
        </div>
        <div class="row-value">$${Math.round(truck.earnings).toLocaleString()}<span class="row-value-unit">lifetime</span></div>
      </div>`;

    const hiredHtml = profile.hiredTrucks.map((h) => {
      const t = truckById?.get(h.id);
      if (!t) return `<div class="row-sub" style="padding:3px 0;">${h.id} - no longer in the fleet.</div>`;
      const status = t.parkedAt ? `parked at ${t.parkedAt}` : t.disabledHoursLeft > 0 ? "disabled roadside" : "hauling";
      const pending = Math.max(0, t.earnings - (h.lastSettledEarnings ?? 0));
      const traits = traitSummary(t.driver).map((tr) =>
        `<span class="chip active" style="cursor:default;background:${tr.color};border-color:${tr.color};padding:2px 6px;font-size:0.6rem;">${tr.label}</span>`
      ).join("");
      // Visible BEFORE tapping Drive - the real mitigation (alongside the
      // milesSinceStop reset on switch) for taking over a truck that's
      // been running unattended and might be low on fuel or exhausted.
      const fuelPct = Math.round(t.fuel);
      const fuelColor = fuelPct > 50 ? "var(--go)" : fuelPct > 15 ? "var(--caution)" : "var(--stop)";
      const fatiguePct = Math.round(t.fatigue);
      const fatigueColor = fatiguePct > 70 ? "var(--stop)" : fatiguePct > 40 ? "var(--caution)" : "var(--go)";
      const vitalsHtml = `<div style="margin-top:3px;font-family:var(--font-mono);font-size:0.66rem;font-weight:600;">
        <span style="color:${fuelColor};">FUEL ${fuelPct}%</span>
        <span style="color:${fatigueColor};margin-left:10px;">FATIGUE ${fatiguePct}%</span>
      </div>`;
      return `
        <div class="list-row" style="border-left-color:var(--info);align-items:flex-start;">
          <div style="flex:1;">
            <div class="row-main">${t.name} <span class="row-sub">(${h.id})</span></div>
            <div class="row-sub">${status} &bull; ${t.contractsCompleted} loads &bull; $${Math.round(pending).toLocaleString()} pending</div>
            ${vitalsHtml}
            ${traits ? `<div class="chip-row" style="margin-top:3px;">${traits}</div>` : ""}
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
            <div class="row-value">$${Math.round(t.earnings).toLocaleString()}<span class="row-value-unit">lifetime</span></div>
            <button class="pill-btn" data-action="switch-truck" data-arg="${h.id}" style="background:var(--go);font-size:0.62rem;padding:5px 9px;letter-spacing:0.03em;">Drive This Truck</button>
          </div>
        </div>`;
    }).join("") || `<div class="placeholder-text">No hired drivers yet.</div>`;

    careerEl.tabFleet.innerHTML = `
      ${companyHeaderHtml}
      ${headerHtml}
      <div class="section-label">Your Company</div>
      ${yourRigHtml}
      ${hiredHtml}
      ${renderHiringSection()}
      ${renderLogoPickerSection(profile)}
    `;
  });
}

// --- BOOKS - the ledger --------------------------------------------------
//
// "Am I making money, on what, and how close am I to the next level?"

export function renderBooksTab(profile, truck) {
  if (!profile.active) {
    careerEl.tabBooks.innerHTML = `<div class="placeholder-text">Not driving right now. Tap CAREER to sign on as an owner-operator.</div>`;
    return;
  }
  preserveScroll(careerEl.tabBooks, () => {
    const s = profile.stats;
    const totalEarned = truck ? truck.earnings : 0;
    const thresholds = career.LEVEL_XP_THRESHOLDS;
    const prevThreshold = thresholds[profile.level - 1] ?? 0;
    const nextThreshold = thresholds[profile.level];
    const xpProgress = nextThreshold != null ? Math.min(1, Math.max(0, (profile.xp - prevThreshold) / (nextThreshold - prevThreshold))) : 1;
    const xpLabel = nextThreshold != null ? `${profile.xp.toLocaleString()} / ${nextThreshold.toLocaleString()} XP` : `${profile.xp.toLocaleString()} XP — max level`;

    const logHtml = profile.log.slice(0, 8).map((l) => `<div class="row-sub" style="padding:3px 0;">${l.text}</div>`).join("")
      || `<div class="placeholder-text">Quiet so far.</div>`;

    careerEl.tabBooks.innerHTML = `
      <div class="metric-grid" style="margin-bottom:12px;">
        <div class="metric-card good"><div class="metric-title">Cash</div><div class="metric-value">$${Math.round(profile.cash).toLocaleString()}</div></div>
        <div class="metric-card"><div class="metric-title">Level</div><div class="metric-value">${profile.level}</div></div>
        <div class="metric-card"><div class="metric-title">Total Earned</div><div class="metric-value">$${Math.round(totalEarned).toLocaleString()}</div></div>
        <div class="metric-card"><div class="metric-title">Total Spent</div><div class="metric-value">$${Math.round(s.totalSpent).toLocaleString()}</div></div>
        ${profile.hiredTrucks.length ? `<div class="metric-card good"><div class="metric-title">Fleet Collected</div><div class="metric-value">$${Math.round(s.fleetEarningsCollected ?? 0).toLocaleString()}</div></div>` : ""}
        <div class="metric-card info"><div class="metric-title">Reputation</div><div class="metric-value">${Math.round(profile.reputation)}</div></div>
      </div>
      <div class="section-label">Progress</div>
      ${statBar("XP to next level", xpProgress, "var(--info)", null, xpLabel)}
      <div class="section-label">Career Stats</div>
      <div class="metric-grid" style="margin-bottom:12px;">
        <div class="metric-card"><div class="metric-title">Deliveries</div><div class="metric-value">${truck ? truck.contractsCompleted : 0}</div></div>
        <div class="metric-card"><div class="metric-title">On-Time Hotshots</div><div class="metric-value">${s.onTimeDeliveries}</div></div>
        <div class="metric-card"><div class="metric-title">Hotshot Bonus</div><div class="metric-value">$${Math.round(s.hotshotBonusEarned).toLocaleString()}</div></div>
        <div class="metric-card"><div class="metric-title">Fuel Bought</div><div class="metric-value">${Math.round(s.fuelUnitsBought).toLocaleString()} gal</div></div>
        <div class="metric-card${s.ticketsReceived ? " bad" : ""}"><div class="metric-title">Tickets</div><div class="metric-value">${s.ticketsReceived}</div></div>
        <div class="metric-card${s.duiCount ? " bad" : ""}"><div class="metric-title">DUIs</div><div class="metric-value">${s.duiCount}</div></div>
      </div>
      <div class="section-label">Recent Activity</div>
      ${logHtml}
      <div class="section-label">Save</div>
      <div class="vendor-grid">
        <button class="vendor-item" data-action="save-career"><span class="v-name">Save Career</span><span class="v-desc">Keeps cash, stats and upgrades if you close the tab</span></button>
        <button class="vendor-item" data-action="delete-save"><span class="v-name">Delete Save</span><span class="v-desc">Wipes the saved profile - your current run keeps going</span></button>
      </div>
      ${lastSaveOk != null ? `<div class="row-sub" style="padding:4px 0;">${lastSaveOk ? "Saved." : "Save failed (storage full or unavailable)."}</div>` : ""}
    `;
  });
}

// --- WORLD - the living sim, condensed -----------------------------------
//
// "What's going on out there?" A short fleet-wide status row plus the CB
// feed folded in (see careerEl.cbFeed's own doc comment) - the rest of
// what a spectator would want is one tap away if career mode ever ends.

export function renderWorldTab(trucks) {
  preserveScroll(careerEl.tabWorld, () => {
    let moving = 0, parked = 0, disabled = 0, speedSum = 0, speedCount = 0;
    for (const t of trucks) {
      if (t.disabledHoursLeft > 0) disabled++;
      else if (t.parkedAt) parked++;
      else { moving++; if (t.edge) { speedSum += t.speed; speedCount++; } }
    }
    const avgSpeed = speedCount ? Math.round(speedSum / speedCount) : 0;
    careerEl.tabWorld.innerHTML = `
      <div class="metric-grid" style="margin-bottom:12px;">
        <div class="metric-card"><div class="metric-title">Active Fleet</div><div class="metric-value">${trucks.length.toLocaleString()}</div></div>
        <div class="metric-card good"><div class="metric-title">Rolling</div><div class="metric-value">${moving.toLocaleString()}</div></div>
        <div class="metric-card"><div class="metric-title">Parked</div><div class="metric-value">${parked.toLocaleString()}</div></div>
        <div class="metric-card${disabled > 20 ? " bad" : ""}"><div class="metric-title">Disabled</div><div class="metric-value">${disabled.toLocaleString()}</div></div>
        <div class="metric-card"><div class="metric-title">Network Speed</div><div class="metric-value">${avgSpeed} mph</div></div>
      </div>
      <div class="section-label">CB Chatter</div>
      <div id="cb-feed-slot"></div>
    `;
    document.getElementById("cb-feed-slot").appendChild(careerEl.cbFeed);
  });
}
