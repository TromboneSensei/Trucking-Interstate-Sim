// main.js - boot + the single game loop. Ties the graph, fleet
// simulation, camera, renderer, and dashboard together.
import { buildGraph, WORLD_WIDTH, WORLD_HEIGHT, travelDirectionLabel } from "./geo.js";
import { spawnFleet, updateFleet, BASE_TIME_SCALE } from "./fleet.js";
import { Camera } from "./camera.js";
import { renderStaticBackground, renderCityGlow, buildEdgeList, drawFrame, truckWorldPos } from "./render.js";
import { createWeather, updateWeather } from "./weather.js";
import { chooseOffer } from "./economy.js";
import { initUI, openDetailsFor, refreshFollowedTruckDetails, refreshViewedCityDetails, renderDispatchTab, renderRankingsTab, renderEconomyTab, resetUIState, visibleTab } from "./ui.js";

const DECISION_TIMEOUT = 11; // seconds
// The load board gets longer than a junction call: picking a haul is a
// considered choice, not a reflex. On expiry the truck takes whatever
// chooseOffer() would have picked for it, so an unattended sim never stalls.
const CONTRACT_TIMEOUT = 20; // seconds
const TAP_TOLERANCE_PX = 26;

// Settings-panel defaults - also what the form resets to on first open.
// Everything here is applied at (re)boot time via bootSim(); nothing
// here is read mid-simulation.
const DEFAULT_SETTINGS = {
  fleetSize: 1000,
  startSeconds: 6 * 3600, // 6:00 AM
  defaultTimeScale: 1,
  showAllLabels: false,
  showMedians: true,
  showStateBorders: true,
  showDayNight: true,
  showCityLights: true,
  showHeadlights: true,
  showCongestion: true,
  showWeather: false,
  showRushHour: true,
};

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");

const el = {
  clock: document.getElementById("clock"),
  fleetCount: document.getElementById("fleet-count"),
  timeSlider: document.getElementById("time-slider"),
  timeReadout: document.getElementById("time-readout"),
  btnExitFollow: document.getElementById("btn-exit-follow"),
  btnNavToggle: document.getElementById("btn-nav-toggle"),
  decisionOverlay: document.getElementById("decision-overlay"),
  decisionOptions: document.getElementById("decision-options"),
  decisionTimerFill: document.getElementById("decision-timer-fill"),
  contractOverlay: document.getElementById("contract-overlay"),
  contractOptions: document.getElementById("contract-options"),
  contractCity: document.getElementById("contract-city"),
  contractTimerFill: document.getElementById("contract-timer-fill"),
  fatal: document.getElementById("fatal-error"),
  btnSettings: document.getElementById("btn-settings"),
  settingsOverlay: document.getElementById("settings-overlay"),
  settingFleetSize: document.getElementById("setting-fleet-size"),
  settingStartTime: document.getElementById("setting-start-time"),
  settingDefaultSpeed: document.getElementById("setting-default-speed"),
  settingDefaultSpeedVal: document.getElementById("setting-default-speed-val"),
  settingAllLabels: document.getElementById("setting-all-labels"),
  settingMedians: document.getElementById("setting-medians"),
  settingStateBorders: document.getElementById("setting-state-borders"),
  settingDayNight: document.getElementById("setting-day-night"),
  settingCityLights: document.getElementById("setting-city-lights"),
  settingHeadlights: document.getElementById("setting-headlights"),
  settingCongestion: document.getElementById("setting-congestion"),
  settingWeather: document.getElementById("setting-weather"),
  settingRushHour: document.getElementById("setting-rush-hour"),
  btnSettingsCancel: document.getElementById("btn-settings-cancel"),
  btnSettingsApply: document.getElementById("btn-settings-apply"),
  fpsCounter: document.getElementById("fps-counter"),
  dailyDigest: document.getElementById("daily-digest"),
};

window.addEventListener("error", (e) => {
  el.fatal.textContent = "Fatal error: " + (e.error ? (e.error.stack || e.error.message) : e.message);
  el.fatal.classList.remove("hidden");
});

const graph = buildGraph();
let settings = { ...DEFAULT_SETTINGS };
let bgCanvas = null;
// Flat per-edge road list, built once from `graph` (never rebuilt - graph
// topology is settings-independent) and reused by drawRoads every frame.
const edgeList = buildEdgeList(graph);
// Pre-rendered city-light glow, rebuilt in bootSim alongside bgCanvas -
// unlike bgCanvas it doesn't depend on any setting today, but re-baking it
// on every Apply costs nothing next to respawning the whole fleet anyway.
let glowCanvas = null;
// Drifting weather systems - rebuilt per boot so a restart gets a fresh
// map, and shared by reference with both the sim and the renderer.
let weather = [];
let trucks = [];
// id -> truck lookup, rebuilt once whenever `trucks` itself is rebuilt
// (bootSim only) rather than re-scanned with .find() every frame - ids are
// assigned once (Truck constructor's nextId++) and never reused, so the
// cache stays valid for the whole life of a fleet.
let truckById = new Map();
// city name -> number of trucks parked there right now, rebuilt each frame
// for the map's label badges. Reused rather than reallocated: at 3000
// trucks this runs 60x a second.
const parkedCounts = new Map();

// Economy history: one sample every ECON_SAMPLE_MIN game-minutes, capped
// at 48 game-hours. Instantaneous readouts (the Dispatch tiles) can't show
// whether the network is speeding up or seizing; rates need two points in
// time, so they get recorded rather than recomputed.
const ECON_SAMPLE_MIN = 15;
const ECON_MAX_SAMPLES = 193; // 48h at 15-min spacing, plus one to diff against
let econHistory = [];
let lastEconSampleMin = -Infinity;

// Daily digest: the fleet-wide totals as they stood at the start of the
// current game-day, plus each truck's earnings at that moment, so the
// midnight rollover can report the DAY's deltas rather than all-time
// numbers (which the Dispatch tab already shows and which stop being
// interesting once they're large).
let dayIndex = 0;
let dayStart = { miles: 0, earnings: 0, contracts: 0 };
let dayStartEarningsById = new Map();
let digestTimer = null;

const state = {
  paused: false, // true only while a junction decision is pending (see showDecisionPanel/resolveDecision)
  settingsOpen: false, // true while the settings modal is up - also freezes the sim, independently of `paused`
  timeScale: settings.defaultTimeScale,
  gameSeconds: settings.startSeconds,
  followedTruckId: null,
  // Being followed just means the camera is locked on - purely a
  // spectator thing. controlledTruckId is a separate, narrower opt-in:
  // only the controlled truck's junctions ever pause the sim for a
  // player decision, armed explicitly via the details panel's Take
  // Control button.
  controlledTruckId: null,
  // What the Unit tab is currently showing - independent of
  // followedTruckId/controlledTruckId, so tapping a city to inspect it
  // doesn't get silently clobbered back to truck stats by the followed
  // truck's per-frame refresh (or vice versa).
  detailsView: null, // { kind: "truck", id } | { kind: "city", name } | null
  decisionTruck: null,
  decisionTimer: 0,
  // Same shape as the junction pair above, for the load board shown when
  // the controlled truck finishes a layover.
  contractTruck: null,
  contractTimer: 0,
  // Cargo-type id to spotlight on the map (everything else dims), or null.
  spotlightCargo: null,
};

// Records one economy sample when enough game-time has passed. Cheap
// (one pass over the fleet every 15 game-minutes, not every frame) and
// the buffer is capped, so this can run forever without growing.
function sampleEconomy() {
  const nowMin = state.gameSeconds / 60;
  if (nowMin - lastEconSampleMin < ECON_SAMPLE_MIN) return;
  lastEconSampleMin = nowMin;

  let earnings = 0, contracts = 0, speedSum = 0, rolling = 0;
  for (const t of trucks) {
    earnings += t.earnings;
    contracts += t.contractsCompleted;
    if (t.edge) { rolling++; speedSum += t.speed; }
  }
  econHistory.push({
    min: nowMin,
    earnings,
    contracts,
    avgSpeed: rolling ? speedSum / rolling : 0,
    rolling,
  });
  if (econHistory.length > ECON_MAX_SAMPLES) econHistory.shift();
}

// ---------------------------------------------------------------------
// Daily digest
// ---------------------------------------------------------------------
function captureDayStart() {
  let miles = 0, earnings = 0, contracts = 0;
  dayStartEarningsById = new Map();
  for (const t of trucks) {
    miles += t.totalMilesDriven;
    earnings += t.earnings;
    contracts += t.contractsCompleted;
    dayStartEarningsById.set(t.id, t.earnings);
  }
  dayStart = { miles, earnings, contracts };
}

function hideDigest() {
  if (digestTimer) { clearTimeout(digestTimer); digestTimer = null; }
  el.dailyDigest.classList.add("hidden");
}

// Called once per frame; fires only on a midnight boundary.
function checkDayRollover() {
  const nowDay = Math.floor(state.gameSeconds / 86400);
  if (nowDay === dayIndex) return;
  const finished = dayIndex + 1; // the day that just ended, 1-based like the HUD clock
  dayIndex = nowDay;

  let miles = 0, earnings = 0, contracts = 0, best = null, bestGain = 0;
  for (const t of trucks) {
    miles += t.totalMilesDriven;
    earnings += t.earnings;
    contracts += t.contractsCompleted;
    const gain = t.earnings - (dayStartEarningsById.get(t.id) ?? t.earnings);
    if (gain > bestGain) { bestGain = gain; best = t; }
  }
  const dMiles = Math.max(0, miles - dayStart.miles);
  const dEarn = Math.max(0, earnings - dayStart.earnings);
  const dJobs = Math.max(0, contracts - dayStart.contracts);

  el.dailyDigest.innerHTML = `
    <div class="digest-title">Day ${finished} Complete</div>
    <div class="digest-line"><span>Miles driven</span><span>${Math.round(dMiles).toLocaleString()}</span></div>
    <div class="digest-line"><span>Revenue</span><span>$${Math.round(dEarn).toLocaleString()}</span></div>
    <div class="digest-line"><span>Loads delivered</span><span>${dJobs.toLocaleString()}</span></div>
    ${best ? `<div class="digest-star">Driver of the day: <strong>${best.name}</strong> &mdash; $${Math.round(bestGain).toLocaleString()}</div>` : ""}`;
  el.dailyDigest.classList.remove("hidden");

  if (digestTimer) clearTimeout(digestTimer);
  digestTimer = setTimeout(hideDigest, 9000);

  captureDayStart();
}

function getFollowedTruck() {
  return state.followedTruckId == null ? null : truckById.get(state.followedTruckId) || null;
}

function getControlledTruck() {
  return state.controlledTruckId == null ? null : truckById.get(state.controlledTruckId) || null;
}

// ---------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------
function resizeCanvas() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function fitZoom() {
  const availH = canvas.clientHeight * 0.55; // leave room for the bottom sheet
  return Math.min(canvas.clientWidth / WORLD_WIDTH, availH / WORLD_HEIGHT) * 0.92;
}

resizeCanvas();
const initialZoom = fitZoom();
const camera = new Camera(canvas, {
  x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2,
  zoom: initialZoom, minZoom: initialZoom * 0.6, maxZoom: 6,
  onTap: handleTap,
});
window.addEventListener("resize", () => { resizeCanvas(); });

function followTruck(truck) {
  state.followedTruckId = truck.id;
  state.controlledTruckId = null; // following defaults to spectate-only; Take Control is an explicit opt-in
  state.detailsView = { kind: "truck", id: truck.id };
  camera.follow(truckWorldPos(graph, truck)); // always starts flat FOLLOW - nav view is an explicit opt-in via btnNavToggle, never the default
  el.btnExitFollow.classList.remove("hidden");
  el.btnNavToggle.classList.remove("hidden");
  el.btnNavToggle.classList.remove("active");
  openDetailsFor(truck, "truck", false);
}

function unfollow() {
  if (state.detailsView && state.detailsView.kind === "truck" && state.detailsView.id === state.followedTruckId) {
    state.detailsView = null;
  }
  state.followedTruckId = null;
  state.controlledTruckId = null;
  camera.unfollow();
  el.btnExitFollow.classList.add("hidden");
  el.btnNavToggle.classList.add("hidden");
}
el.btnExitFollow.addEventListener("click", unfollow);
el.dailyDigest.addEventListener("click", hideDigest);

el.btnNavToggle.addEventListener("click", () => {
  if (!getFollowedTruck()) return; // button is hidden otherwise, but guard defensively
  const toNav = camera.mode !== "FOLLOW_NAV";
  camera.mode = toNav ? "FOLLOW_NAV" : "FOLLOW";
  el.btnNavToggle.classList.toggle("active", toNav);
});

function toggleControl() {
  const followed = getFollowedTruck();
  if (!followed) return;
  state.controlledTruckId = state.controlledTruckId === followed.id ? null : followed.id;
  refreshFollowedTruckDetails(followed, state.controlledTruckId === followed.id);
}

function handleTap(wx, wy) {
  const tol = TAP_TOLERANCE_PX / camera.zoom;
  let best = null, bestDist = tol;
  for (const t of trucks) {
    const p = truckWorldPos(graph, t);
    const d = Math.hypot(p.x - wx, p.y - wy);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  if (best) { followTruck(best); return; }

  let bestCity = null; bestDist = tol + 6;
  for (const name in graph.nodes) {
    const node = graph.nodes[name];
    if (node.t === 0) continue;
    const d = Math.hypot(node.x - wx, node.y - wy);
    if (d < bestDist) { bestDist = d; bestCity = node; }
  }
  if (bestCity) {
    state.detailsView = { kind: "city", name: bestCity.name };
    openDetailsFor(bestCity, "city", false, trucks, graph);
  }
}

// ---------------------------------------------------------------------
// Decision panel (paused-junction interaction for the followed truck)
// ---------------------------------------------------------------------
function shieldLabel(route) {
  return route.replace("US-", "US ").replace(" (West)", "").replace(" (East)", "");
}

// "North" -> "N", "Southwest" -> "SW". travelDirectionLabel already honors
// the route's fixed axis where one applies, so a north-south interstate
// reads N/S the whole way even through a stretch that briefly angles east.
const DIR_ABBR = {
  North: "N", South: "S", East: "E", West: "W",
  Northeast: "NE", Northwest: "NW", Southeast: "SE", Southwest: "SW",
};
function routeWithDirection(edge) {
  const dir = DIR_ABBR[travelDirectionLabel(edge)] || "";
  return shieldLabel(edge.route) + (dir ? " " + dir : "");
}

function showDecisionPanel(truck) {
  state.paused = true;
  state.decisionTruck = truck;
  state.decisionTimer = DECISION_TIMEOUT;

  el.decisionOptions.innerHTML = "";
  // rankAndCapOptions puts the truck's own planned next edge first, so
  // option 0 is by definition "stay on the pre-planned route". Anything
  // else re-routes, and resolveDecision recomputes the rest of the trip
  // from wherever the player sends it.
  const plannedEdge = truck.remainingPath[0];
  truck.pendingOptions.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.className = "decision-btn";
    const isPlanned = !!plannedEdge && opt.to === plannedEdge.to && opt.route === plannedEdge.route;
    if (isPlanned) btn.classList.add("planned");
    const isInterstate = opt.route.startsWith("I-");
    const label = shieldLabel(opt.route);
    btn.innerHTML = `<div class="shield${isInterstate ? "" : " hwy"}"><span class="shield-num">${label.replace(/^I-/, "")}</span></div>
      <span class="droute">${routeWithDirection(opt)}</span>
      <span class="dcity">${isPlanned ? "Continue to " : "Re-route to "}${opt.control}</span>
      <span class="ddist">${Math.round(opt.miles)} mi to ${opt.to}</span>
      <span class="dkey">[${idx + 1}]</span>`;
    btn.addEventListener("click", () => resolveDecision(opt));
    el.decisionOptions.appendChild(btn);
  });
  el.decisionOverlay.classList.remove("hidden");
}

// The controlled truck has finished its layover and needs a load. Same
// contract that would have been picked for it by chooseOffer() is still
// used if the timer runs out, so walking away never wedges the sim.
function showContractPanel(truck) {
  state.paused = true;
  state.contractTruck = truck;
  state.contractTimer = CONTRACT_TIMEOUT;

  el.contractCity.textContent = truck.parkedAt || "";
  el.contractOptions.innerHTML = "";
  truck.pendingOffers.forEach((offer, idx) => {
    const btn = document.createElement("button");
    btn.className = "contract-btn";
    btn.style.setProperty("--cargo", offer.truckType.color);
    const rpm = offer.payout / Math.max(1, offer.optimalMiles);
    btn.innerHTML = `<span class="c-type">${offer.truckType.label}</span>
      <span class="c-cargo">${offer.cargo}</span>
      <span class="c-dest">&rarr; ${offer.destination}</span>
      <span class="c-meta"><span>${Math.round(offer.optimalMiles).toLocaleString()} mi &middot; $${rpm.toFixed(2)}/mi</span><span class="c-pay">$${offer.payout.toLocaleString()}</span></span>
      <span class="c-key">[${idx + 1}]</span>`;
    btn.addEventListener("click", () => resolveContract(offer));
    el.contractOptions.appendChild(btn);
  });
  el.contractOverlay.classList.remove("hidden");
}

function resolveContract(offer) {
  const truck = state.contractTruck;
  if (!truck) return;
  truck._takeContract(graph, offer, null);
  el.contractOverlay.classList.add("hidden");
  state.contractTruck = null;
  state.paused = false;
}

function resolveDecision(chosenEdge) {
  const truck = state.decisionTruck;
  if (!truck) return;
  truck.resolveDecision(graph, chosenEdge);
  el.decisionOverlay.classList.add("hidden");
  state.decisionTruck = null;
  state.paused = false;
}

window.addEventListener("keydown", (ev) => {
  const n = parseInt(ev.key, 10);
  if (state.decisionTruck) {
    if (n >= 1 && n <= state.decisionTruck.pendingOptions.length) resolveDecision(state.decisionTruck.pendingOptions[n - 1]);
    return;
  }
  if (state.contractTruck) {
    if (n >= 1 && n <= state.contractTruck.pendingOffers.length) resolveContract(state.contractTruck.pendingOffers[n - 1]);
  }
});

// ---------------------------------------------------------------------
// Time controls + clock display
// ---------------------------------------------------------------------
el.timeSlider.addEventListener("input", (e) => {
  state.timeScale = parseFloat(e.target.value);
  el.timeReadout.textContent = state.timeScale.toFixed(1) + "x";
});

function formatClock(gameSeconds) {
  const day = Math.floor(gameSeconds / 86400) + 1;
  let m = Math.floor((gameSeconds % 86400) / 60);
  let h = Math.floor(m / 60);
  m = m % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `DAY ${day} ${h}:${m < 10 ? "0" + m : m} ${ampm}`;
}

// ---------------------------------------------------------------------
// Settings modal - pauses the sim while open (state.settingsOpen, kept
// separate from the junction-decision `state.paused` so the two can't
// stomp on each other), and Apply tears down + rebuilds the fleet under
// whatever was chosen.
// ---------------------------------------------------------------------
function openSettings() {
  if (state.decisionTruck) return; // don't stack over an active junction decision
  state.settingsOpen = true;
  el.settingFleetSize.value = settings.fleetSize;
  el.settingStartTime.value = String(settings.startSeconds);
  el.settingDefaultSpeed.value = String(settings.defaultTimeScale);
  el.settingDefaultSpeedVal.textContent = settings.defaultTimeScale.toFixed(1) + "×";
  el.settingAllLabels.checked = settings.showAllLabels;
  el.settingMedians.checked = settings.showMedians;
  el.settingStateBorders.checked = settings.showStateBorders;
  el.settingDayNight.checked = settings.showDayNight;
  el.settingCityLights.checked = settings.showCityLights;
  el.settingHeadlights.checked = settings.showHeadlights;
  el.settingCongestion.checked = settings.showCongestion;
  el.settingWeather.checked = settings.showWeather;
  el.settingRushHour.checked = settings.showRushHour;
  el.settingsOverlay.classList.remove("hidden");
}

function closeSettings() {
  state.settingsOpen = false;
  el.settingsOverlay.classList.add("hidden");
}

el.btnSettings.addEventListener("click", openSettings);
el.btnSettingsCancel.addEventListener("click", closeSettings);
el.settingsOverlay.addEventListener("click", (e) => { if (e.target === el.settingsOverlay) closeSettings(); });
el.settingDefaultSpeed.addEventListener("input", (e) => {
  el.settingDefaultSpeedVal.textContent = parseFloat(e.target.value).toFixed(1) + "×";
});

el.btnSettingsApply.addEventListener("click", () => {
  const fleetSize = Math.max(10, Math.min(5000, parseInt(el.settingFleetSize.value, 10) || DEFAULT_SETTINGS.fleetSize));
  const newSettings = {
    fleetSize,
    startSeconds: parseInt(el.settingStartTime.value, 10),
    defaultTimeScale: parseFloat(el.settingDefaultSpeed.value),
    showAllLabels: el.settingAllLabels.checked,
    showMedians: el.settingMedians.checked,
    showStateBorders: el.settingStateBorders.checked,
    showDayNight: el.settingDayNight.checked,
    showCityLights: el.settingCityLights.checked,
    showHeadlights: el.settingHeadlights.checked,
    showCongestion: el.settingCongestion.checked,
    showWeather: el.settingWeather.checked,
    showRushHour: el.settingRushHour.checked,
  };
  closeSettings();
  bootSim(newSettings);
});

// (Re)builds the whole fleet/world state from scratch under `newSettings`
// - both the very first boot and every "Apply & Restart Sim" run through
// here. `graph` itself never changes (topology is settings-independent);
// everything downstream of it (the pre-rendered background, the fleet,
// the clock/camera/UI state) gets torn down and rebuilt.
function bootSim(newSettings) {
  settings = newSettings;

  bgCanvas = renderStaticBackground(graph, settings);
  glowCanvas = renderCityGlow(graph);
  weather = createWeather();
  econHistory = [];
  lastEconSampleMin = -Infinity;
  dayIndex = Math.floor(settings.startSeconds / 86400);
  hideDigest();
  trucks = spawnFleet(graph, settings.fleetSize);
  truckById = new Map(trucks.map((t) => [t.id, t]));
  // Must come AFTER the fleet exists: it snapshots per-truck earnings to
  // diff against at midnight, so capturing it against the previous (or
  // empty) fleet would leave every truck's daily gain at zero and the
  // digest permanently without a driver of the day.
  captureDayStart();

  state.paused = false;
  state.settingsOpen = false;
  state.timeScale = settings.defaultTimeScale;
  state.gameSeconds = settings.startSeconds;
  state.followedTruckId = null;
  state.controlledTruckId = null;
  state.detailsView = null;
  state.decisionTruck = null;
  state.decisionTimer = 0;

  el.timeSlider.value = String(settings.defaultTimeScale);
  el.timeReadout.textContent = settings.defaultTimeScale.toFixed(1) + "x";
  el.btnExitFollow.classList.add("hidden");
  el.btnNavToggle.classList.add("hidden");
  el.btnNavToggle.classList.remove("active");
  el.decisionOverlay.classList.add("hidden");
  // Restarting mid-choice must also tear down the load board, or a dead
  // overlay stays pinned over the map referencing a truck that no longer
  // exists in the respawned fleet.
  el.contractOverlay.classList.add("hidden");
  state.contractTruck = null;
  el.fleetCount.textContent = `${trucks.length} UNITS`;

  camera.unfollow();
  const zoom = fitZoom();
  camera.x = WORLD_WIDTH / 2;
  camera.y = WORLD_HEIGHT / 2;
  camera.zoom = zoom;
  camera.baseZoom = zoom;
  camera.minZoom = zoom * 0.6;

  resetUIState();
  state.spotlightCargo = null;
  renderDispatchTab(trucks, graph);
  renderRankingsTab(trucks, graph);
  renderEconomyTab(trucks, graph, econHistory, null);
}

// ---------------------------------------------------------------------
// UI wiring + main loop
// ---------------------------------------------------------------------
initUI({
  onSelectTruck: followTruck,
  onToggleControl: toggleControl,
  onSpotlightCargo: (id) => {
    state.spotlightCargo = state.spotlightCargo === id ? null : id;
    renderEconomyTab(trucks, graph, econHistory, state.spotlightCargo);
  },
  // A newly revealed panel has been going unrefreshed while hidden, so
  // force the periodic refresh to fire on the very next frame rather than
  // leaving it stale (or blank) for up to 400ms.
  onVisibleTabChange: () => { lastUiRefresh = 0; },
});
bootSim(DEFAULT_SETTINGS);

let lastTime = performance.now();
let lastUiRefresh = 0;
let lastFpsTime = performance.now();
let fpsFrameCount = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  fpsFrameCount++;
  if (now - lastFpsTime > 500) {
    el.fpsCounter.textContent = Math.round((fpsFrameCount * 1000) / (now - lastFpsTime)) + " FPS";
    lastFpsTime = now;
    fpsFrameCount = 0;
  }

  try {
    if (state.paused) {
      if (state.contractTruck) {
        state.contractTimer -= dt;
        el.contractTimerFill.style.width = Math.max(0, state.contractTimer / CONTRACT_TIMEOUT) * 100 + "%";
        if (state.contractTimer <= 0) {
          // Timed out: fall back to the driver's own preference rather than
          // just grabbing offer[0], so an unattended truck still behaves in
          // character.
          const t = state.contractTruck;
          resolveContract(chooseOffer(t.pendingOffers, t.driver) || t.pendingOffers[0]);
        }
      } else {
        state.decisionTimer -= dt;
        const pct = Math.max(0, state.decisionTimer / DECISION_TIMEOUT) * 100;
        el.decisionTimerFill.style.width = pct + "%";
        if (state.decisionTimer <= 0 && state.decisionTruck) {
          resolveDecision(state.decisionTruck.pendingOptions[0]);
        }
      }
    } else if (!state.settingsOpen) {
      state.gameSeconds += dt * BASE_TIME_SCALE * state.timeScale;
      const gameHours = (dt * BASE_TIME_SCALE * state.timeScale) / 3600;
      if (settings.showWeather) updateWeather(weather, gameHours);
      // Everything the simulation needs to know about the world outside
      // the trucks themselves. Passed fresh each tick rather than held in
      // fleet.js so the sim stays a pure function of its inputs - which is
      // what lets the headless regression harnesses run it with env=null
      // and get the original, environment-free behaviour.
      const env = {
        weather,
        showWeather: settings.showWeather,
        showRushHour: settings.showRushHour,
        gameSeconds: state.gameSeconds,
      };
      // updateFleet returns whichever truck needs the player: a junction
      // choice mid-route, or a load choice at the end of a layover. The
      // truck's own flags say which.
      const waiting = updateFleet(graph, trucks, dt, state.timeScale, getControlledTruck(), env);
      if (waiting && waiting.awaitingContract) showContractPanel(waiting);
      else if (waiting) showDecisionPanel(waiting);
      sampleEconomy();
      checkDayRollover();
    }

    const followed = getFollowedTruck();
    const isFollowMode = camera.mode === "FOLLOW" || camera.mode === "FOLLOW_NAV";
    if (isFollowMode && followed) {
      camera.followTarget = truckWorldPos(graph, followed);
      // Hold the last known heading while the truck is stopped/between
      // edges (edge briefly null) rather than snapping to 0 - avoids a
      // spurious rotation flash right as a truck departs/arrives a city.
      if (followed.edge) camera.targetHeading = (followed.edge.bearing * Math.PI) / 180;
    } else if (isFollowMode && !followed) {
      unfollow();
    } else if (!isFollowMode && state.followedTruckId != null) {
      // Camera dropped to FREE on its own (a drag on the canvas calls
      // camera.js's own internal unfollow() directly, decoupled from
      // this outer unfollow() which owns the HUD button visibility) -
      // resync state/UI to match rather than leaving stale RELEASE/NAV
      // VIEW buttons showing for a camera that's no longer following.
      unfollow();
    }
    camera.update();

    parkedCounts.clear();
    for (const t of trucks) {
      if (!t.parkedAt) continue;
      parkedCounts.set(t.parkedAt, (parkedCounts.get(t.parkedAt) || 0) + 1);
    }

    drawFrame(ctx, canvas, camera, graph, bgCanvas, edgeList, glowCanvas, trucks, followed, {
      showAllLabels: settings.showAllLabels,
      showMedians: settings.showMedians,
      showDayNight: settings.showDayNight,
      showCityLights: settings.showCityLights,
      showHeadlights: settings.showHeadlights,
      showCongestion: settings.showCongestion,
      showWeather: settings.showWeather,
      weather,
      spotlightCargo: state.spotlightCargo,
      parkedCounts,
      gameSeconds: state.gameSeconds,
      timeScale: state.timeScale,
    });
    el.clock.textContent = formatClock(state.gameSeconds);

    // Whatever the Unit tab is currently showing refreshes live - a
    // followed truck's numbers every frame (speed/odometer/ETA are worth
    // that smoothness), a viewed city's on the same slower tick as the
    // fleet-wide rankings below (inbound/outbound counts don't need
    // frame-rate smoothness, and re-scanning all trucks for them every
    // frame would be wasted work for numbers no one watches that closely).
    if (state.detailsView && state.detailsView.kind === "truck") {
      const t = truckById.get(state.detailsView.id);
      if (t) refreshFollowedTruckDetails(t, state.controlledTruckId === t.id);
    }

    if (now - lastUiRefresh > 400) {
      lastUiRefresh = now;
      // Only the tab the user is actually looking at gets rebuilt. These
      // renders wipe and repopulate a whole panel's DOM and the ranking
      // ones sort the entire fleet; doing that for two hidden panels 2.5
      // times a second was a large, invisible cost at 3000 trucks. Each
      // tab re-renders on the next tick after it's opened, so switching
      // still shows current numbers immediately.
      const tab = visibleTab();
      if (tab === "overview") renderDispatchTab(trucks, graph);
      else if (tab === "rankings") renderRankingsTab(trucks, graph);
      else if (tab === "economy") renderEconomyTab(trucks, graph, econHistory, state.spotlightCargo);
      if (tab === "details" && state.detailsView && state.detailsView.kind === "city") {
        refreshViewedCityDetails(graph.nodes[state.detailsView.name], graph, trucks);
      }
    }
  } catch (err) {
    el.fatal.textContent = "Runtime error: " + (err.stack || err.message);
    el.fatal.classList.remove("hidden");
    return;
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
