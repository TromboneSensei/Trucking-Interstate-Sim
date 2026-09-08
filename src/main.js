// main.js - boot + the single game loop. Ties the graph, fleet
// simulation, camera, renderer, and dashboard together.
import { buildGraph, WORLD_WIDTH, WORLD_HEIGHT, travelDirectionLabel, findPath, optimalRouteHours, WORST_CASE_SPEED_MULT } from "./geo.js";
import { spawnFleet, updateFleet, drainFleetEvents, BASE_TIME_SCALE, Truck, isCompanyTruck } from "./fleet.js";
import { Camera } from "./camera.js";
import { renderStaticBackground, renderCityGlow, buildEdgeList, drawFrame, truckWorldPos, truckPose } from "./render.js";
import { createWeather, updateWeather } from "./weather.js";
import { chooseOffer } from "./economy.js";
import { initCB, resetCB, updateCB } from "./cb.js";
import { initUI, openDetailsFor, refreshFollowedTruckDetails, refreshViewedCityDetails, renderDispatchTab, renderRankingsTab, renderEconomyTab, resetUIState, visibleTab } from "./ui.js";
import * as career from "./career.js";
import { initCareerUI, updateCareerHud, renderRigTab, renderFleetTab, renderBooksTab, renderWorldTab, isTruckStopOpen, openTruckStop, refreshTruckStop, closeTruckStop, wasStopDismissed } from "./career-ui.js";

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
  showCBRadio: true,
};

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");

const el = {
  clock: document.getElementById("clock"),
  fleetCount: document.getElementById("fleet-count"),
  timeSlider: document.getElementById("time-slider"),
  timeReadout: document.getElementById("time-readout"),
  speedPopover: document.getElementById("speed-popover"),
  speedPresets: document.getElementById("speed-presets"),
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
  cbFeed: document.getElementById("cb-feed"),
  cbUnread: document.getElementById("cb-unread"),
  settingCBRadio: document.getElementById("setting-cb-radio"),
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
// Network-wide congested-segment count, refreshed from drawFrame's return
// every frame and read by the Dispatch tab on its own slower UI tick -
// the renderer already computes it as part of the congestion overlay, so
// this avoids a second fleet-wide scan just for the HUD number.
let lastCongestedSegments = 0;

// Economy history: one sample every ECON_SAMPLE_MIN game-minutes, capped
// at 48 game-hours. Instantaneous readouts (the Dispatch tiles) can't show
// whether the network is speeding up or seizing; rates need two points in
// time, so they get recorded rather than recomputed.
const ECON_SAMPLE_MIN = 15;
const ECON_MAX_SAMPLES = 193; // 48h at 15-min spacing, plus one to diff against
let econHistory = [];
let lastEconSampleMin = -Infinity;

// Daily digest. Each truck carries its own per-day accumulators (see the
// `day*` fields on Truck), zeroed at every rollover, so midnight reports
// the DAY's operating numbers rather than all-time ones - which the
// Dispatch tab already shows and which stop being interesting once
// they're large. Per-truck rather than fleet-wide counters because the
// day's superlatives (Top Earner, Lead Foot) need to name the truck, not
// just the total.
let dayIndex = 0;
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
  // Set by tapping a corridor/highway row in the Dispatch drilldown - a set
  // of edgeList indices to highlight (render.js's drawRouteSpotlight) while
  // the camera flies to fit them (camera.frameBox). Cleared the moment the
  // camera leaves FRAME mode (dragging the map, or following a truck), same
  // spirit as followedTruckId's own drag-resync below.
  spotlightRoute: null,
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
  for (const t of trucks) {
    t.dayEarnings = 0;
    t.dayMiles = 0;
    t.dayDeliveries = 0;
    t.dayBreakdowns = 0;
    t.dayFuelSpend = 0;
  }
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

  let revenue = 0, deliveries = 0, breakdowns = 0, fuelExpense = 0;
  let topEarner = null, leadFoot = null, leadFootMph = 0;
  for (const t of trucks) {
    revenue += t.dayEarnings;
    deliveries += t.dayDeliveries;
    breakdowns += t.dayBreakdowns;
    fuelExpense += t.dayFuelSpend;
    // Company trucks (Phase 11 hires) are excluded from these fleet-wide
    // awards - a cash-subsidized player-owned rig would otherwise dominate
    // every superlative. They still count in the raw totals above (real
    // fleet activity), just never win Top Earner/Lead Foot.
    if (isCompanyTruck(t)) continue;
    if (t.dayEarnings > 0 && (!topEarner || t.dayEarnings > topEarner.dayEarnings)) topEarner = t;
    // Averaged over the WHOLE day, not just the hours spent rolling, so a
    // truck that parked for a long layover or sat on the shoulder is
    // correctly beaten by one that kept moving.
    const avgMph = t.dayMiles / 24;
    if (avgMph > leadFootMph) { leadFootMph = avgMph; leadFoot = t; }
  }

  const money = (n) => "$" + Math.round(n).toLocaleString();
  const award = (badge, title, name, detail) =>
    `<div class="digest-award"><span class="digest-badge">${badge}</span>
      <span><span class="digest-award-title">${title}</span>
      <span class="digest-award-val"><strong>${name}</strong> ${detail}</span></span></div>`;

  el.dailyDigest.innerHTML = `
    <div class="digest-title">Day ${finished} Complete</div>
    <div class="digest-line"><span>Gross revenue</span><span>${money(revenue)}</span></div>
    <div class="digest-line"><span>Loads delivered</span><span>${deliveries.toLocaleString()}</span></div>
    <div class="digest-line"><span>Total breakdowns</span><span>${breakdowns.toLocaleString()}</span></div>
    <div class="digest-line"><span>Fuel expense</span><span>${money(fuelExpense)}</span></div>
    ${topEarner || leadFoot ? `<div class="digest-awards">
      ${topEarner ? award("&#9733;", "Top Earner", topEarner.name, `+${money(topEarner.dayEarnings)}`) : ""}
      ${leadFoot ? award("&#9889;", "Lead Foot", leadFoot.name, `${Math.round(leadFootMph)}&nbsp;mph 24h&nbsp;avg &bull; ${Math.round(leadFoot.dayMiles).toLocaleString()}&nbsp;mi`) : ""}
    </div>` : ""}`;
  el.dailyDigest.classList.remove("hidden");

  if (digestTimer) clearTimeout(digestTimer);
  digestTimer = setTimeout(hideDigest, 9000);

  captureDayStart();
}

function getFollowedTruck() {
  return state.followedTruckId == null ? null : truckById.get(state.followedTruckId) || null;
}

function getCareerTruck() {
  const id = career.getCareerTruckId();
  return id == null ? null : truckById.get(id) || null;
}

// While a career is active, the career truck IS the controlled truck,
// full stop - state.controlledTruckId is entirely bypassed rather than
// cleared, which is what lets followTruck() (below) keep its existing
// "tapping a truck always drops controlledTruckId" behavior unmodified:
// tapping some OTHER truck while driving a career never actually costs
// the player anything, because getControlledTruck() never consulted
// controlledTruckId in the first place once career mode is on.
function getControlledTruck() {
  if (career.isActive()) return getCareerTruck();
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

// ---------------------------------------------------------------------
// Corridor / highway spotlight - tapping a "Busiest Corridor" or "Busiest
// Interstate" row in the Dispatch drilldown (ui.js) flies the camera to fit
// that segment (or the whole route) and dims everything that isn't part of
// it, the same tap-to-focus idea as a CB line's tap-to-follow. Unlike
// tap-to-follow this targets a fixed region of the map, not a moving truck,
// so it rides camera.js's one-shot FRAME mode rather than FOLLOW.
//
// unfollow() runs first in both: without it, a truck being followed would
// leave camera.mode at FOLLOW for one more frame after frameBox() sets it to
// FRAME (frameBox always wins, since it runs after), and the very next tick's
// isFollowMode resync (below, in frame()) would see mode!=FOLLOW while
// state.followedTruckId is still set and treat it as "camera fell off the
// truck" - clearing state via unfollow() a second time, which is harmless,
// but only by accident. Calling it here ourselves makes the transition
// explicit instead of relying on next-frame cleanup to paper over it.
// A single corridor segment is short enough that fitting it at frameBox's
// normal 0.85 fill crops right at its own two endpoints - exactly where the
// real towns it connects sit, with no room left on screen for their labels.
// A looser fill here backs the camera off enough to carry both neighboring
// towns into frame; forceLabels (below) is what actually guarantees they're
// drawn, since one of those towns can easily be a real-but-low-tier place
// (or a "Junction"-flagged tier-0 town like Mettler) that wouldn't clear the
// normal label-reveal zoom even with the extra room.
const CORRIDOR_FRAME_FILL = 0.55;

function frameAndHighlightCorridor(rec) {
  const idx = edgeList.indexByEdge.get(rec.edge);
  if (idx == null) return;
  unfollow();
  const e = edgeList.edges[idx];
  camera.frameBox(e.minX, e.minY, e.maxX, e.maxY, CORRIDOR_FRAME_FILL);
  state.spotlightRoute = { indices: new Set([idx]), forceLabels: new Set([e.from, e.to]) };
}

function frameAndHighlightHighway(rec) {
  const indices = new Set();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  edgeList.edges.forEach((e, i) => {
    if (e.kind !== "interstate" || e.baseRoute !== rec.route) return;
    indices.add(i);
    minX = Math.min(minX, e.minX); maxX = Math.max(maxX, e.maxX);
    minY = Math.min(minY, e.minY); maxY = Math.max(maxY, e.maxY);
  });
  if (!indices.size) return;
  unfollow();
  camera.frameBox(minX, minY, maxX, maxY);
  state.spotlightRoute = { indices };
}

// Starts a career with whatever truck is currently followed, or - if
// nothing's followed, or the followed truck is already someone else's
// career/disabled - picks a random eligible AI truck instead. Either way
// followTruck() immediately afterward gives the usual tap-a-truck UX
// (camera locks on, detail panel opens) for free.
//
// A saved profile from a previous session gets offered first - continuing
// re-attaches that profile's cash/stats/upgrades to a freshly spawned
// truck (see career.reattachTruck's doc comment for why it can't restore
// the old truck's exact position/contract, only the profile). Declining
// (or having no save) falls through to the ordinary fresh-start path.
function handleStartCareer() {
  const eligible = trucks.filter((t) => !t.agent && !t.disabledHoursLeft);
  if (career.hasSave() && confirm("Continue your saved career?")) {
    const truck = eligible[Math.floor(Math.random() * eligible.length)];
    if (truck && career.load()) {
      career.reattachTruck(truck);
      followTruck(truck);
      return;
    }
    // Corrupt/rejected save, or no eligible truck - fall through to fresh.
  }
  let truck = getFollowedTruck();
  if (!truck || truck.agent || truck.disabledHoursLeft > 0) {
    truck = eligible[Math.floor(Math.random() * eligible.length)];
  }
  if (!truck) return;
  career.startCareer(truck, graph);
  followTruck(truck);
}

// career.js rolls the candidate driver and handles the cash/id bookkeeping
// (confirmHire) but never touches `trucks` itself (see its own doc
// comment) - this is the one place that actually constructs the Truck and
// puts it into the live fleet, mirroring handleStartCareer's split with
// startCareer/reattachTruck above. Spawned at the career truck's current
// city (a hired driver reports to wherever the boss happens to be) as an
// ordinary, fully autopilot truck - `agent` stays null, so every existing
// AI system (contracts, fatigue, breakdowns, weather) treats it exactly
// like any of the other ~9999 trucks except for its "H-" id, which is what
// excludes it from fleet-wide rankings/digest awards (see fleet.js's
// isCompanyTruck and its two call sites).
function handleHireDriver(driver) {
  const ct = getCareerTruck();
  if (!ct) return null;
  const res = career.confirmHire(driver);
  if (!res.ok) return res;
  const t = new Truck(graph, ct.currentNode, Math.random, driver);
  t.id = res.id;
  trucks.push(t);
  truckById.set(t.id, t);
  return res;
}

// Fleet command (Phase 12): switching who the player is driving. career.js
// owns the actual demote/promote/settlement logic (switchActiveTruck) and
// never touches `trucks` itself; this is the one place that resolves the
// target truck from its id and updates the camera/details panel, mirroring
// handleHireDriver's split with confirmHire above.
//
// Only state.decisionTruck/contractTruck are worth gating on here - both
// freeze the whole sim and can currently only reference the career truck,
// so switching away mid-decision would strand it. The truck-stop overlay
// is already structurally unreachable while FLEET is open (z-index), so
// that path needs no check at all.
function handleSwitchTruck(newTruckId) {
  if (state.decisionTruck || state.contractTruck) {
    return { ok: false, reason: "Resolve your current junction/load choice first." };
  }
  const newTruck = truckById.get(newTruckId);
  if (!newTruck) return { ok: false, reason: "That truck is no longer in the fleet." };
  const oldTruck = getCareerTruck();
  career.switchActiveTruck(oldTruck, newTruck, state.gameSeconds);
  followTruck(newTruck);
  return { ok: true };
}

function toggleControl() {
  if (career.isActive()) return; // the old spectator Take-Control mechanic is superseded entirely once a career is running
  const followed = getFollowedTruck();
  if (!followed) return;
  state.controlledTruckId = state.controlledTruckId === followed.id ? null : followed.id;
  refreshFollowedTruckDetails(followed, state.controlledTruckId === followed.id);
}

function handleTap(wx, wy) {
  const tol = TAP_TOLERANCE_PX / camera.zoom;
  let best = null, bestDist = tol;
  for (const t of trucks) {
    // Parked trucks draw no dot (render.js) - let the tap fall through to
    // the city underneath, EXCEPT a career/company truck (t.agent), which
    // still draws (and must still be tappable) even while parked - see
    // render.js's matching exemption.
    if (t.parkedAt && !t.agent) continue;
    const p = truckPose(graph, t); // same corner-blended position the dot is actually drawn at (render.js)
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
  // Road Atlas upgrade (career.js STORE_ITEMS.ROAD_ATLAS, profile.upgrades.
  // atlas) - previously set a flag nothing read. Now it adds a worst-case
  // ETA next to each option's plain A* distance, so a Hotshot deadline can
  // be judged against a real bound rather than best-case miles alone. Only
  // for the player's own truck - it's a personal accessory, not fleet-wide
  // intel available to every AI decision.
  const showAtlas = career.isActive() && truck === getCareerTruck() && career.getProfile().upgrades.atlas && !!truck.contract;
  truck.pendingOptions.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.className = "decision-btn";
    const isPlanned = !!plannedEdge && opt.to === plannedEdge.to && opt.route === plannedEdge.route;
    if (isPlanned) btn.classList.add("planned");
    const isInterstate = opt.route.startsWith("I-");
    const label = shieldLabel(opt.route);
    let atlasHtml = "";
    if (showAtlas) {
      const rest = opt.to === truck.contract.destination ? [] : (findPath(graph, opt.to, truck.contract.destination) || []);
      const optimalHours = optimalRouteHours([opt, ...rest]);
      const worstHours = optimalHours / WORST_CASE_SPEED_MULT;
      atlasHtml = `<span class="datlas">\u{1F4D6} ${formatDriveHours(optimalHours)} best &bull; ${formatDriveHours(worstHours)} worst-case</span>`;
    }
    btn.innerHTML = `<div class="shield${isInterstate ? "" : " hwy"}"><span class="shield-num">${label.replace(/^I-/, "")}</span></div>
      <span class="droute">${routeWithDirection(opt)}</span>
      <span class="dcity">${isPlanned ? "Continue to " : "Re-route to "}${opt.control}</span>
      <span class="ddist">${Math.round(opt.miles)} mi to ${opt.to}</span>
      ${atlasHtml}
      <span class="dkey">[${idx + 1}]</span>`;
    btn.addEventListener("click", () => resolveDecision(opt));
    el.decisionOptions.appendChild(btn);
  });
  el.decisionOverlay.classList.remove("hidden");
}

// The controlled truck has finished its layover and needs a load. Same
// contract that would have been picked for it by chooseOffer() is still
// used if the timer runs out, so walking away never wedges the sim.
// "19h 40m" - drive-time estimate for a load-board offer, from
// economy.js's optimalHours (the same cost the A* router itself
// minimizes, so it already accounts for the highway-route time penalty).
function formatDriveHours(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

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
      <span class="c-meta"><span>${Math.round(offer.optimalMiles).toLocaleString()} mi &middot; ${formatDriveHours(offer.optimalHours)} &middot; $${rpm.toFixed(2)}/mi</span><span class="c-pay">$${offer.payout.toLocaleString()}</span></span>
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
  syncSpeedPresetHighlight();
});

// The chip IS #time-readout - tapping it opens/closes the popover holding
// the presets + the full slider, same corner-pin pattern as #btn-settings.
el.timeReadout.addEventListener("click", () => {
  el.speedPopover.classList.toggle("hidden");
});
el.speedPresets.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-speed]");
  if (!btn) return;
  state.timeScale = parseFloat(btn.dataset.speed);
  el.timeSlider.value = String(state.timeScale);
  el.timeReadout.textContent = state.timeScale.toFixed(1) + "x";
  syncSpeedPresetHighlight();
  el.speedPopover.classList.add("hidden");
});
function syncSpeedPresetHighlight() {
  for (const c of el.speedPresets.children) c.classList.toggle("active", parseFloat(c.dataset.speed) === state.timeScale);
}
// Tapping anywhere outside the chip/popover closes it - it's a transient
// picker, not a panel with its own dismiss control.
document.addEventListener("pointerdown", (e) => {
  if (el.speedPopover.classList.contains("hidden")) return;
  if (e.target === el.timeReadout || el.speedPopover.contains(e.target)) return;
  el.speedPopover.classList.add("hidden");
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
  // Don't stack over an active junction/load decision, or the truck-stop
  // takeover (which is already covering the whole screen anyway, but
  // this keeps state.settingsOpen from becoming true underneath it).
  if (state.decisionTruck || state.contractTruck || isTruckStopOpen()) return;
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
  el.settingCBRadio.checked = settings.showCBRadio;
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
  const fleetSize = Math.max(10, Math.min(10000, parseInt(el.settingFleetSize.value, 10) || DEFAULT_SETTINGS.fleetSize));
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
    showCBRadio: el.settingCBRadio.checked,
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

  // Apply & Restart respawns the WHOLE fleet with fresh ids (see below) -
  // the truck a career was driving doesn't survive that, so end the live
  // driving session cleanly. The profile itself (cash/upgrades/stats) is
  // untouched - same "the truck doesn't survive a reload, the profile
  // does" contract as career.js's own load(). If the truck stop happened
  // to be open, it's covering a fleet that's about to not exist.
  if (isTruckStopOpen()) closeTruckStop();
  if (career.isActive()) {
    const p = career.getProfile();
    career.detachAgent(getCareerTruck());
    p.active = false;
    p.truckId = null;
  }

  bgCanvas = renderStaticBackground(graph, settings);
  glowCanvas = renderCityGlow(graph);
  weather = createWeather();
  econHistory = [];
  lastEconSampleMin = -Infinity;
  dayIndex = Math.floor(settings.startSeconds / 86400);
  hideDigest();
  // The CB feed and the sim's event queue both hold references to trucks
  // from the fleet about to be replaced, so both are emptied here.
  resetCB();
  drainFleetEvents();
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
  state.spotlightRoute = null;

  el.timeSlider.value = String(settings.defaultTimeScale);
  el.timeReadout.textContent = settings.defaultTimeScale.toFixed(1) + "x";
  syncSpeedPresetHighlight();
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
  renderDispatchTab(trucks, graph, lastCongestedSegments);
  renderRankingsTab(trucks, graph);
  renderEconomyTab(trucks, graph, econHistory, null);
}

// ---------------------------------------------------------------------
// UI wiring + main loop
// ---------------------------------------------------------------------
// The feed lives in its own tab now, so it needs to know when it's the
// panel on screen (to clear its unread badge) and what to do when a line
// is tapped: fly the camera to the rig that said it and open its page,
// which is exactly followTruck.
initCB({
  feedEl: el.cbFeed,
  badgeEl: el.cbUnread,
  onSelectTruck: followTruck,
  // #cb-feed itself is reparented between #tab-cb (spectating) and the
  // World tab's own slot (driving) - see career-ui.js's renderWorldTab and
  // updateCareerHud - so "is the feed actually on screen" means either
  // tab, whichever currently hosts it.
  isFeedVisible: () => visibleTab() === "cb" || visibleTab() === "world",
});
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
  // Closing the detail sheet ends the inspection, so stop live-refreshing
  // a panel that isn't on screen. The camera deliberately keeps following
  // - browsing another tab while a rig stays centred is the point of the
  // sheet being a detour rather than a tab; Exit Follow is how you let go.
  onCloseDetails: () => { state.detailsView = null; },
  onSelectCorridor: frameAndHighlightCorridor,
  onSelectHighway: frameAndHighlightHighway,
});
initCareerUI({
  onStartCareer: handleStartCareer,
  // career-ui.js's truck-stop actions (eat/shower/sleep) advance time
  // through career.js's own advanceTime, entirely outside this file's
  // normal per-frame `state.gameSeconds +=` line - this is what keeps
  // main.js's own clock in sync with however far those calls actually
  // moved it.
  onTimeAdvanced: (gs) => { state.gameSeconds = gs; },
  // Rolling out (or taking a fresh load) can leave a junction decision
  // pending, exactly like updateFleet's normal return value would - reuse
  // the exact same decision panel rather than inventing a second one.
  onRollOut: (waiting) => { if (waiting && waiting.awaitingDecision) showDecisionPanel(waiting); },
  onHireDriver: handleHireDriver,
  onSwitchTruck: handleSwitchTruck,
});
// Autosave on the way out - a career the player forgot to save manually
// (closing the tab, navigating away) shouldn't just vanish. save() is a
// no-op-safe best-effort write (quota/private-mode failures are swallowed
// inside it), so there's nothing to check the result of here.
window.addEventListener("beforeunload", () => { if (career.isActive()) career.save(); });
bootSim(DEFAULT_SETTINGS);

let lastTime = performance.now();
let lastUiRefresh = 0;
let lastFpsTime = performance.now();
let fpsFrameCount = 0;

// One renderer per bottom-sheet tab name, keyed exactly like visibleTab()'s
// return value - was an if/else chain that a career-mode tab set (RIG/
// FLEET/BOOKS/WORLD) would otherwise need its own branches threaded into.
// Each closure reads the enclosing module's live bindings at CALL time
// (trucks/graph/state/career.js's own module state), not at map-creation
// time, so this only needs to be built once.
const TAB_RENDERERS = {
  overview: () => renderDispatchTab(trucks, graph, lastCongestedSegments),
  rankings: () => renderRankingsTab(trucks, graph),
  economy: () => renderEconomyTab(trucks, graph, econHistory, state.spotlightCargo),
  rig: () => renderRigTab(career.getProfile(), getCareerTruck(), state.gameSeconds),
  fleet: () => renderFleetTab(career.getProfile(), truckById),
  books: () => renderBooksTab(career.getProfile(), getCareerTruck()),
  world: () => renderWorldTab(trucks),
};

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
    // Freeze precedence, most-exclusive first - exactly one branch below
    // ever runs per frame. truckStopOpen wins over everything: it's a
    // full-screen takeover (z-index above the map/sheet/settings, only
    // #fatal-error sits higher), and its own actions (buy/eat/sleep/roll
    // out) are what advance time while it's up - see career-ui.js and
    // career.js's advanceTime. `paused` (junction/load decision) and
    // `settingsOpen` are unchanged from before career mode existed,
    // except the decision-timeout branch now also checks whether the
    // truck waiting is the player's own career truck, which never
    // auto-times-out (a career player is never resolved against their
    // will - see the `isCareerDecision` check below).
    if (isTruckStopOpen()) {
      // Nothing to do - see the comment above.
    } else if (state.paused) {
      if (state.contractTruck) {
        // Can never be the career truck (career mode's own delivery flow
        // never sets awaitingContract - see fleet.js's _arriveAtDestination
        // agent branch), so this timeout is unconditionally safe as-is.
        state.contractTimer -= dt;
        el.contractTimerFill.style.width = Math.max(0, state.contractTimer / CONTRACT_TIMEOUT) * 100 + "%";
        if (state.contractTimer <= 0) {
          // Timed out: fall back to the driver's own preference rather than
          // just grabbing offer[0], so an unattended truck still behaves in
          // character.
          const t = state.contractTruck;
          resolveContract(chooseOffer(t.pendingOffers, t, graph) || t.pendingOffers[0]);
        }
      } else {
        const isCareerDecision = career.isActive() && state.decisionTruck === getCareerTruck();
        if (isCareerDecision) {
          el.decisionTimerFill.style.width = "100%"; // shown full/inert rather than left stale at whatever it last was
        } else {
          state.decisionTimer -= dt;
          const pct = Math.max(0, state.decisionTimer / DECISION_TIMEOUT) * 100;
          el.decisionTimerFill.style.width = pct + "%";
          if (state.decisionTimer <= 0 && state.decisionTruck) {
            resolveDecision(state.decisionTruck.pendingOptions[0]);
          }
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

      // Career mode's own per-frame work: needs (hunger/morale/heat/wear)
      // decay with real elapsed time exactly like the fleet itself does,
      // and a fresh "PLAYER" stop (nodeStopReason's agent branch, or the
      // delivery-arrival branch of _arriveAtDestination - see fleet.js)
      // is what triggers the truck-stop takeover. Checked AFTER
      // updateFleet so this tick's own arrival is caught immediately
      // rather than one frame late.
      if (career.isActive()) {
        const ct = getCareerTruck();
        if (ct) {
          career.tickNeeds(ct, gameHours, state.gameSeconds);
          career.checkSettlement(state.gameSeconds, trucks);
          // wasStopDismissed: without it, closing the overlay via "Leave
          // Cab" (rather than ROLL OUT) had no visible effect - this exact
          // check ran again the very next frame, ct.parkedAt/stopReason
          // were both still true (nothing about a PLAYER stop auto-clears
          // them), and openTruckStop got called right back.
          if (ct.parkedAt && ct.stopReason === "PLAYER" && !isTruckStopOpen() && !wasStopDismissed(ct)) {
            openTruckStop(ct, graph, trucks, weather);
          }
        }
      }
    }

    if (isTruckStopOpen()) refreshTruckStop(state.gameSeconds);
    updateCareerHud(career.getProfile(), getCareerTruck(), state.gameSeconds);

    const followed = getFollowedTruck();
    const isFollowMode = camera.mode === "FOLLOW" || camera.mode === "FOLLOW_NAV";
    if (isFollowMode && followed) {
      // includeJitter=false: White Line Fever's fatigue wobble (render.js)
      // is a cosmetic render-layer offset on the drawn dot. Feeding it into
      // the follow camera's own target used to low-pass it into a real
      // screen-space shake - the whole world (every OTHER truck on screen,
      // fatigued or not) visibly wobbled in sympathy whenever the player's
      // own truck crossed the fatigue threshold, which read as every truck
      // "copying" the player.
      const pose = truckPose(graph, followed, undefined, false);
      camera.followTarget = pose;
      // Hold the last known heading while the truck is stopped/between
      // edges (edge briefly null) rather than snapping to 0 - avoids a
      // spurious rotation flash right as a truck departs/arrives a city.
      if (followed.edge) camera.targetHeading = (pose.heading * Math.PI) / 180;
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
    // Same idea as the followedTruckId resync just above, for the corridor/
    // highway spotlight: the moment the camera leaves FRAME mode - dragging
    // the map, or a fresh followTruck()/frameBox() call moving it elsewhere -
    // the highlighted-edge set is stale and should stop dimming the map.
    if (camera.mode !== "FRAME" && state.spotlightRoute) state.spotlightRoute = null;
    camera.update();

    parkedCounts.clear();
    for (const t of trucks) {
      if (!t.parkedAt) continue;
      parkedCounts.set(t.parkedAt, (parkedCounts.get(t.parkedAt) || 0) + 1);
    }

    // Map beacon (Phase 12): recomputed fresh every frame rather than
    // cached - fleet size here is cash-gated (career truck + a handful of
    // hired drivers), so this Set is tiny. Computing the logo fallback
    // live (rather than persisting one on profile) means an existing save
    // with no profile.logo yet just renders a sensible placeholder badge,
    // no migration needed.
    let companyRenderOpts = null;
    if (career.isActive()) {
      const p = career.getProfile();
      companyRenderOpts = {
        truckIds: new Set([career.getCareerTruckId(), ...p.hiredTrucks.map((h) => h.id)]),
        color: p.logo?.color || "#3f6fb0",
        glyph: p.logo?.glyph || "\u{1F69B}",
        monogram: p.logo?.monogram || (p.truckName || "CO").slice(0, 2).toUpperCase(),
      };
    }

    const frameStats = drawFrame(ctx, canvas, camera, graph, bgCanvas, edgeList, glowCanvas, trucks, followed, {
      showAllLabels: settings.showAllLabels,
      showMedians: settings.showMedians,
      showDayNight: settings.showDayNight,
      showCityLights: settings.showCityLights,
      showHeadlights: settings.showHeadlights,
      showCongestion: settings.showCongestion,
      showWeather: settings.showWeather,
      weather,
      spotlightCargo: state.spotlightCargo,
      spotlightRoute: state.spotlightRoute,
      parkedCounts,
      gameSeconds: state.gameSeconds,
      timeScale: state.timeScale,
      company: companyRenderOpts,
    });
    lastCongestedSegments = frameStats.congestedSegments;
    el.clock.textContent = formatClock(state.gameSeconds);

    // CB radio. Runs after drawFrame so it can reuse that frame's own
    // cull box as its definition of "on screen", and is handed whatever
    // the sim emitted this tick (breakdowns, dry tanks) to rank against
    // its ambient chatter. Draining unconditionally - even with the feed
    // switched off - keeps fleet.js's bounded queue from sitting full of
    // stale trucks.
    updateCB(now, {
      enabled: settings.showCBRadio,
      graph,
      trucks,
      visibleTrucks: frameStats.visibleTrucks,
      viewport: frameStats.viewport,
      // CB Antenna upgrade (career.js profile.upgrades.cbAntenna) - widens
      // cb.js's own event-visibility box and raises its queue caps.
      antenna: career.isActive() && career.getProfile().upgrades.cbAntenna,
      camera,
      gameSeconds: state.gameSeconds,
      weather,
      showWeather: settings.showWeather,
      events: drainFleetEvents(),
    });

    // Whatever the Unit tab is currently showing refreshes live - a
    // followed truck's numbers every frame (speed/odometer/ETA are worth
    // that smoothness), a viewed city's on the same slower tick as the
    // fleet-wide rankings below (inbound/outbound counts don't need
    // frame-rate smoothness, and re-scanning all trucks for them every
    // frame would be wasted work for numbers no one watches that closely).
    if (state.detailsView && state.detailsView.kind === "truck") {
      const t = truckById.get(state.detailsView.id);
      // getControlledTruck() (not the raw controlledTruckId) so the
      // detail panel correctly shows "Controlling" for the career truck
      // too - controlledTruckId is bypassed entirely while career mode
      // is active (see getControlledTruck's own comment).
      if (t) refreshFollowedTruckDetails(t, getControlledTruck() === t);
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
      const renderTab = TAB_RENDERERS[tab];
      if (renderTab) renderTab();
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
