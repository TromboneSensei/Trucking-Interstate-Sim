// career-ui.js - all the DOM for Owner-Operator mode: the full-screen
// truck-stop takeover, the Career tab in the bottom sheet, and the small
// always-visible HUD readout. Mirrors cb.js's precedent of a module
// owning its own panel outright rather than main.js reaching into it.
// career.js (no DOM) does all the actual state/economy work; this module
// is purely "read career.js, render it, and turn clicks into career.js
// calls."
"use strict";

import * as career from "./career.js";
import { pumpFuel, estimatedRangeMiles } from "./fleet.js";
import { generateContractOffers } from "./economy.js";

const careerEl = {
  btnCareer: document.getElementById("btn-career"),
  careerHud: document.getElementById("career-hud"),
  careerHudCash: document.getElementById("career-hud-cash"),
  careerHudFuel: document.getElementById("career-hud-fuel"),
  btnPullIn: document.getElementById("btn-pull-in"),
  hotshotHud: document.getElementById("career-hud-hotshot"),
  throttleGroup: document.getElementById("throttle-group"),
  overlay: document.getElementById("truckstop-overlay"),
  city: document.getElementById("truckstop-city"),
  clock: document.getElementById("truckstop-clock"),
  tabs: document.getElementById("truckstop-tabs"),
  content: document.getElementById("truckstop-content"),
  status: document.getElementById("truckstop-status"),
  btnClose: document.getElementById("btn-truckstop-close"),
  btnRollOut: document.getElementById("btn-roll-out"),
  careerTabBtn: document.getElementById("tab-btn-career"),
  tabCareer: document.getElementById("tab-career"),
};

const VENDORS = ["PUMPS", "STORE", "DINER", "SHOWERS", "SLEEPER", "MECHANIC", "BOARD"];
const VENDOR_LABEL = { PUMPS: "Pumps", STORE: "Store", DINER: "Diner", SHOWERS: "Showers", SLEEPER: "Sleeper", MECHANIC: "Mechanic", BOARD: "Board" };

let onStartCareer = null; // () => void - main.js decides which truck becomes the career truck
let onTimeAdvanced = null; // (newGameSeconds) => void - keeps main.js's state.gameSeconds in sync
let onRollOut = null; // () => void - main.js re-checks for a pending junction decision after resuming
let onCareerEnded = null; // () => void - reserved (Phase 11+), not fired yet

let open = false;
let activeVendor = "PUMPS";
let stopCtx = null; // { truck, graph, trucks, weather }
let fuelUnitsThisStop = 0; // tracked for the shower's "free with a big fill" perk

export function initCareerUI(callbacks) {
  onStartCareer = callbacks.onStartCareer;
  onTimeAdvanced = callbacks.onTimeAdvanced;
  onRollOut = callbacks.onRollOut;
  onCareerEnded = callbacks.onCareerEnded || null;

  careerEl.btnCareer.addEventListener("click", () => {
    if (career.isActive()) return; // already running one - button is purely a starter, not a toggle
    if (onStartCareer) onStartCareer();
  });
  careerEl.btnPullIn.addEventListener("click", () => {
    if (!stopCtx) return;
    const t = stopCtx.truck;
    if (t.agent) t.agent.pullInRequested = true;
  });
  careerEl.throttleGroup.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-throttle]");
    if (!btn) return;
    const p = career.getProfile();
    if (!p.active) return;
    p.throttle = btn.dataset.throttle;
    for (const c of careerEl.throttleGroup.children) c.classList.toggle("active", c === btn);
    if (lastHudTruck && lastHudTruck.agent) lastHudTruck.agent.recompute();
  });
  careerEl.btnClose.addEventListener("click", closeTruckStop);
  careerEl.btnRollOut.addEventListener("click", handleRollOut);

  careerEl.tabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-vendor]");
    if (!btn) return;
    switchVendor(btn.dataset.vendor);
  });

  // Delegated click for every vendor item grid - each button carries
  // data-action/data-arg so one listener covers PUMPS/STORE/DINER/
  // SHOWERS/SLEEPER/MECHANIC/BOARD without seven separate handlers.
  careerEl.content.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || btn.disabled) return;
    handleAction(btn.dataset.action, btn.dataset.arg);
  });

  // Career tab's own save/delete controls - separate listener since the
  // tab is visible any time (not just while a truck stop is open, unlike
  // careerEl.content above), so it can't rely on stopCtx being set.
  careerEl.tabCareer.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "save-career") {
      const ok = career.save();
      lastSaveOk = ok;
      renderCareerTab(career.getProfile(), lastCareerTruck);
    } else if (btn.dataset.action === "delete-save") {
      if (!confirm("Delete your saved career? This can't be undone.")) return;
      career.deleteSave();
      renderCareerTab(career.getProfile(), lastCareerTruck);
    }
  });
}

let lastCareerTruck = null; // stashed so the save/delete handlers above can re-render without main.js in the loop
let lastSaveOk = null;

export function isTruckStopOpen() { return open; }

export function openTruckStop(truck, graph, trucks, weather) {
  stopCtx = { truck, graph, trucks, weather };
  open = true;
  fuelUnitsThisStop = 0;
  activeVendor = truck.stopVendor || "PUMPS";
  careerEl.city.textContent = truck.parkedAt || "Truck Stop";
  careerEl.overlay.classList.remove("hidden");
  renderTabs();
  renderVendor();
  renderStatus();
}

export function closeTruckStop() {
  // "Leave Cab" without rolling out is just closing the overlay to look
  // at the map/dashboard - the truck is still parked and stopped. There
  // is deliberately no way to leave the truck MOVING without going
  // through ROLL OUT (ending a PLAYER stop always goes through
  // career.rollOut/takeOffer, never just closing this panel).
  open = false;
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
  // The row scrolls horizontally (7 vendors don't fit a phone width) - a
  // stop that opens straight onto a tab near the end (BOARD, on a
  // delivery arrival) would otherwise render with its own active tab
  // scrolled off-screen, no visual cue which vendor you're even looking
  // at. block:"nearest" only scrolls if it's actually out of view.
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

function statChip(label, value, color) {
  return `<div class="stat-chip"><span class="stat-label">${label}</span><span style="color:${color || "var(--ink)"}">${value}</span></div>`;
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
  const fn = { PUMPS: renderPumps, STORE: renderStore, DINER: renderDiner, SHOWERS: renderShowers, SLEEPER: renderSleeper, MECHANIC: renderMechanic, BOARD: renderBoard }[activeVendor];
  careerEl.content.innerHTML = fn ? fn() : "";
}

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
  const fillLevels = [
    { label: "Top 25%", units: Math.min(maxAffordable, truck.fuelCapacity * 0.25) },
    { label: "Top 50%", units: Math.min(maxAffordable, truck.fuelCapacity * 0.5) },
    { label: "Fill 'Er Up", units: maxAffordable },
  ];
  return `
    <div class="vendor-section-title">Diesel &mdash; $${price.toFixed(2)}/gal &bull; tank ${Math.round(truck.fuel)}% &bull; ~${range.toLocaleString()} mi range</div>
    <div class="vendor-grid">
      ${fillLevels.map((f) => `
        <button class="vendor-item" data-action="fuel" data-arg="${f.units.toFixed(2)}|${price}" ${f.units < 0.1 ? "disabled" : ""}>
          <span class="v-name">${f.label}</span>
          <span class="v-desc">+${Math.round(f.units)} gal</span>
          <span class="v-meta"><span></span><span class="v-price expense">$${Math.round(f.units * price).toLocaleString()}</span></span>
        </button>`).join("")}
    </div>
    <div class="vendor-section-title" style="margin-top:4px;">Cash on hand: $${Math.round(p.cash).toLocaleString()}</div>
  `;
}

function renderStore() {
  const { truck } = stopCtx;
  const p = career.getProfile();
  const rows = Object.entries(career.STORE_ITEMS).map(([kind, item]) => {
    const locked = (item.parkedOnly && truck.edge) || (item.repMin != null && p.reputation < item.repMin);
    const owned = item.permanent && p.upgrades[item.permanent];
    const disabled = locked || owned || p.cash < item.price;
    const desc = item.permanent ? "Permanent upgrade" : summarizeEffects(item);
    return `
      <button class="vendor-item${disabled ? " disabled" : ""}" data-action="store" data-arg="${kind}" ${disabled ? "disabled" : ""}>
        <span class="v-name">${item.label}${owned ? " &#10003;" : ""}</span>
        <span class="v-desc">${owned ? "Already own this" : desc}</span>
        <span class="v-meta"><span></span><span class="v-price expense">$${item.price}</span></span>
      </button>`;
  }).join("");
  return `<div class="vendor-section-title">Truck Stop Store</div><div class="vendor-grid">${rows}</div>`;
}

function summarizeEffects(item) {
  const bits = [];
  if (item.immediate) {
    if (item.immediate.fatigue) bits.push(`${item.immediate.fatigue} fatigue`);
    if (item.immediate.hunger) bits.push(`+${item.immediate.hunger} hunger`);
    if (item.immediate.morale) bits.push(`+${item.immediate.morale} morale`);
  }
  if (item.buffHours) bits.push(`${item.buffHours}h buff`);
  if (item.dui) bits.push(`DUI risk`);
  return bits.join(" &bull; ") || "&nbsp;";
}

function renderDiner() {
  const { truck, graph } = stopCtx;
  const node = graph.nodes[truck.parkedAt];
  const special = career.regionalSpecialFor(node);
  const rows = Object.entries(career.DINER_MENU).map(([tier, item]) => `
    <button class="vendor-item" data-action="diner" data-arg="${tier}" ${career.getProfile().cash < item.price ? "disabled" : ""}>
      <span class="v-name">${item.label}</span>
      <span class="v-desc">${tier === "SITDOWN" ? "Today's special: " + special : `+${item.immediate.hunger} hunger &bull; ${item.hours}h`}</span>
      <span class="v-meta"><span>${item.hours}h</span><span class="v-price expense">$${item.price}</span></span>
    </button>`).join("");
  return `<div class="vendor-section-title">Diner</div><div class="vendor-grid">${rows}</div>`;
}

function renderShowers() {
  const free = fuelUnitsThisStop >= 40;
  return `
    <div class="vendor-section-title">Showers</div>
    <div class="vendor-grid">
      <button class="vendor-item" data-action="shower" data-arg="">
        <span class="v-name">Hot Shower</span>
        <span class="v-desc">${free ? "Free - you filled up enough this stop" : "+15 morale"}</span>
        <span class="v-meta"><span>0.5h</span><span class="v-price ${free ? "" : "expense"}">${free ? "FREE" : "$14"}</span></span>
      </button>
    </div>`;
}

const NAP_LENGTHS = [2, 4, 6, 8, 10];
function renderSleeper() {
  return `
    <div class="vendor-section-title">Sleeper Cab &mdash; pick a nap length</div>
    <div class="chip-row">
      ${NAP_LENGTHS.map((h) => `<button class="chip" data-action="sleep" data-arg="${h}">${h}h</button>`).join("")}
    </div>
    <div class="vendor-grid">
      <button class="vendor-item" data-action="motel" data-arg="">
        <span class="v-name">Motel Room</span>
        <span class="v-desc">Real bed - better recovery than the bunk</span>
        <span class="v-meta"><span>8h</span><span class="v-price expense">$60</span></span>
      </button>
    </div>`;
}

function renderMechanic() {
  const p = career.getProfile();
  const cost = career.repairCost(p.wear);
  const disabled = p.wear < 1 || p.cash < cost;
  return `
    <div class="vendor-section-title">Mechanic &mdash; rig condition: ${Math.round(100 - p.wear)}%</div>
    <div class="vendor-grid">
      <button class="vendor-item${disabled ? " disabled" : ""}" data-action="repair" data-arg="" ${disabled ? "disabled" : ""}>
        <span class="v-name">Full Once-Over</span>
        <span class="v-desc">${p.wear < 1 ? "Nothing needs fixing right now" : "Resets wear to 0"}</span>
        <span class="v-meta"><span></span><span class="v-price expense">$${cost}</span></span>
      </button>
    </div>`;
}

function renderBoard() {
  const { truck, graph } = stopCtx;
  if (truck.stopVendor !== "BOARD") {
    return `<div class="vendor-section-title">Load Board</div><div class="placeholder-text">Nothing to pick up here - you're between drops.</div>`;
  }
  const offers = generateContractOffers(graph, truck.parkedAt, 3, Math.random);
  if (!offers.length) return `<div class="vendor-section-title">Load Board</div><div class="placeholder-text">Nothing routable from here right now.</div>`;
  career.decorateHotshot(offers);
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
    const p = career.getProfile();
    if (p.cash < 60) return;
    p.cash -= 60; p.stats.totalSpent += 60;
    advanceAndRefresh(8);
  } else if (action === "repair") {
    career.repairAtMechanic(truck);
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
  if (onRollOut) onRollOut(waiting);
}

// --- HUD -------------------------------------------------------------

let lastHudTruck = null; // refreshed every frame (unlike lastCareerTruck, which only updates while the Career tab itself is rendered) - the throttle group lives in the always-visible top HUD, so it needs a reference that's never stale regardless of which tab is open

export function updateCareerHud(profile, truck, gameSeconds) {
  lastHudTruck = truck;
  const active = profile.active;
  careerEl.btnCareer.classList.toggle("active", active);
  careerEl.btnCareer.textContent = active ? "\u{1F69B} " + (truck ? truck.name : "CAREER") : "\u{1F69B} CAREER";
  careerEl.careerHud.classList.toggle("hidden", !active);
  careerEl.careerTabBtn.classList.toggle("hidden", !active);
  careerEl.btnPullIn.classList.toggle("hidden", !truck || !truck.edge || (truck.agent && truck.agent.pullInRequested));
  if (!active || !truck) return;
  careerEl.careerHudCash.textContent = "$" + Math.round(profile.cash).toLocaleString();
  careerEl.careerHudCash.style.color = profile.cash < 0 ? "var(--stop)" : "var(--go)";
  const fuelPct = Math.round(truck.fuel);
  careerEl.careerHudFuel.textContent = `FUEL ${fuelPct}%`;
  careerEl.careerHudFuel.style.color = fuelPct > 20 ? "var(--ink)" : "var(--stop)";
  const hotshot = truck.contract && truck.contract.hotshot && truck.contract.deadlineGameSeconds != null && truck.stopVendor !== "BOARD";
  careerEl.hotshotHud.classList.toggle("hidden", !hotshot);
  if (hotshot) {
    const hoursLeft = (truck.contract.deadlineGameSeconds - gameSeconds) / 3600;
    careerEl.hotshotHud.textContent = hoursLeft > 0 ? `HOTSHOT ${hoursLeft.toFixed(1)}h left` : "HOTSHOT LATE";
  }
  // Keeps the highlighted chip in sync with profile.throttle even when it
  // changed by some path other than clicking here - a fresh startCareer/
  // reattachTruck, or a loaded save restoring a different value.
  for (const c of careerEl.throttleGroup.children) c.classList.toggle("active", c.dataset.throttle === profile.throttle);
}

// --- Career tab (bottom sheet) ---------------------------------------

export function renderCareerTab(profile, truck) {
  lastCareerTruck = truck;
  if (!profile.active) {
    careerEl.tabCareer.innerHTML = `<div class="placeholder-text">Not driving right now. Tap CAREER to sign on as an owner-operator.</div>`;
    return;
  }
  const statBar = (label, value01, color) => `<div class="stat-bar-row">
    <div class="stat-bar-label"><span>${label}</span><span>${Math.round(value01 * 100)}%</span></div>
    <div class="stat-bar"><div class="stat-bar-fill" style="width:${value01 * 100}%;background:${color}"></div></div>
  </div>`;
  const s = profile.stats;
  // Deliveries/earnings are read straight off the live truck rather than
  // a mirrored profile.stats counter - truck.contractsCompleted/earnings
  // (fleet.js) are already the single source of truth for THIS truck, so
  // duplicating them into profile.stats would just be a second number
  // that has to be kept in sync and can drift. profile.stats keeps the
  // fields no truck object has anywhere to live (rescues, onTimeDeliveries,
  // milesDriven-across-a-fleet) for once those exist (missions/hiring).
  const deliveries = truck ? truck.contractsCompleted : 0;
  const totalEarned = truck ? truck.earnings : 0;
  const logRows = profile.log.slice(0, 8).map((l) => `<div class="row-sub" style="padding:3px 0;">${l.text}</div>`).join("")
    || `<div class="placeholder-text">Quiet so far.</div>`;
  careerEl.tabCareer.innerHTML = `
    <div class="metric-grid" style="margin-bottom:12px;">
      <div class="metric-card good"><div class="metric-title">Cash</div><div class="metric-value">$${Math.round(profile.cash).toLocaleString()}</div></div>
      <div class="metric-card"><div class="metric-title">Level</div><div class="metric-value">${profile.level}</div></div>
      <div class="metric-card"><div class="metric-title">Deliveries</div><div class="metric-value">${deliveries}</div></div>
      <div class="metric-card"><div class="metric-title">Rescues</div><div class="metric-value">${s.rescues}</div></div>
      <div class="metric-card"><div class="metric-title">Total Earned</div><div class="metric-value">$${Math.round(totalEarned).toLocaleString()}</div></div>
      <div class="metric-card"><div class="metric-title">Total Spent</div><div class="metric-value">$${Math.round(s.totalSpent).toLocaleString()}</div></div>
    </div>
    <div class="section-label">Driver &amp; Rig</div>
    ${statBar("Hunger", profile.hunger / 100, "var(--go)")}
    ${statBar("Morale", profile.morale / 100, "var(--info)")}
    ${statBar("Condition", 1 - profile.wear / 100, "var(--caution)")}
    ${statBar("Heat", profile.heat / 100, "var(--stop)")}
    <div class="section-label">Recent Activity</div>
    ${logRows}
    <div class="section-label">Save</div>
    <div class="vendor-grid">
      <button class="vendor-item" data-action="save-career"><span class="v-name">Save Career</span><span class="v-desc">Keeps cash, stats and upgrades if you close the tab</span></button>
      <button class="vendor-item" data-action="delete-save"><span class="v-name">Delete Save</span><span class="v-desc">Wipes the saved profile - your current run keeps going</span></button>
    </div>
    ${lastSaveOk != null ? `<div class="row-sub" style="padding:4px 0;">${lastSaveOk ? "Saved." : "Save failed (storage full or unavailable)."}</div>` : ""}
  `;
}
