// main.js - boot + the single game loop. Ties the graph, fleet
// simulation, camera, renderer, and dashboard together.
import { buildGraph, WORLD_WIDTH, WORLD_HEIGHT } from "./geo.js";
import { spawnFleet, updateFleet, BASE_TIME_SCALE } from "./fleet.js";
import { Camera } from "./camera.js";
import { renderStaticBackground, drawFrame, truckWorldPos } from "./render.js";
import { initUI, openDetailsFor, refreshFollowedTruckDetails, refreshViewedCityDetails, renderDispatchTab, renderRankingsTab, resetUIState } from "./ui.js";

const DECISION_TIMEOUT = 11; // seconds
const TAP_TOLERANCE_PX = 26;

// Settings-panel defaults - also what the form resets to on first open.
// Everything here is applied at (re)boot time via bootSim(); nothing
// here is read mid-simulation.
const DEFAULT_SETTINGS = {
  fleetSize: 500,
  startSeconds: 6 * 3600, // 6:00 AM
  defaultTimeScale: 1,
  showAllLabels: false,
  showMedians: true,
  showStateBorders: true,
};

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");

const el = {
  clock: document.getElementById("clock"),
  fleetCount: document.getElementById("fleet-count"),
  timeSlider: document.getElementById("time-slider"),
  timeReadout: document.getElementById("time-readout"),
  btnExitFollow: document.getElementById("btn-exit-follow"),
  decisionOverlay: document.getElementById("decision-overlay"),
  decisionOptions: document.getElementById("decision-options"),
  decisionTimerFill: document.getElementById("decision-timer-fill"),
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
  btnSettingsCancel: document.getElementById("btn-settings-cancel"),
  btnSettingsApply: document.getElementById("btn-settings-apply"),
  fpsCounter: document.getElementById("fps-counter"),
};

window.addEventListener("error", (e) => {
  el.fatal.textContent = "Fatal error: " + (e.error ? (e.error.stack || e.error.message) : e.message);
  el.fatal.classList.remove("hidden");
});

const graph = buildGraph();
let settings = { ...DEFAULT_SETTINGS };
let bgCanvas = null;
let trucks = [];

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
};

function getFollowedTruck() {
  return state.followedTruckId == null ? null : trucks.find((t) => t.id === state.followedTruckId) || null;
}

function getControlledTruck() {
  return state.controlledTruckId == null ? null : trucks.find((t) => t.id === state.controlledTruckId) || null;
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
  camera.follow(truckWorldPos(graph, truck));
  el.btnExitFollow.classList.remove("hidden");
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
}
el.btnExitFollow.addEventListener("click", unfollow);

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

function showDecisionPanel(truck) {
  state.paused = true;
  state.decisionTruck = truck;
  state.decisionTimer = DECISION_TIMEOUT;

  el.decisionOptions.innerHTML = "";
  truck.pendingOptions.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.className = "decision-btn";
    const isStraight = opt.route === truck.edge.route;
    const isInterstate = opt.route.startsWith("I-");
    const label = shieldLabel(opt.route);
    btn.innerHTML = `<div class="shield${isInterstate ? "" : " hwy"}"><span class="shield-num">${label.replace(/^I-/, "")}</span></div>
      <span class="dcity">${isStraight ? "Continue " : "Turn to "}${opt.control}</span>
      <span class="ddist">${opt.dirLabel} &middot; ${Math.round(opt.miles)} mi to ${opt.to}</span>
      <span class="dkey">[${idx + 1}]</span>`;
    btn.addEventListener("click", () => resolveDecision(opt));
    el.decisionOptions.appendChild(btn);
  });
  el.decisionOverlay.classList.remove("hidden");
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
  if (!state.decisionTruck) return;
  const n = parseInt(ev.key, 10);
  if (n >= 1 && n <= state.decisionTruck.pendingOptions.length) resolveDecision(state.decisionTruck.pendingOptions[n - 1]);
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
  const fleetSize = Math.max(10, Math.min(2000, parseInt(el.settingFleetSize.value, 10) || DEFAULT_SETTINGS.fleetSize));
  const newSettings = {
    fleetSize,
    startSeconds: parseInt(el.settingStartTime.value, 10),
    defaultTimeScale: parseFloat(el.settingDefaultSpeed.value),
    showAllLabels: el.settingAllLabels.checked,
    showMedians: el.settingMedians.checked,
    showStateBorders: el.settingStateBorders.checked,
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
  trucks = spawnFleet(graph, settings.fleetSize);

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
  el.decisionOverlay.classList.add("hidden");
  el.fleetCount.textContent = `${trucks.length} UNITS`;

  camera.unfollow();
  const zoom = fitZoom();
  camera.x = WORLD_WIDTH / 2;
  camera.y = WORLD_HEIGHT / 2;
  camera.zoom = zoom;
  camera.baseZoom = zoom;
  camera.minZoom = zoom * 0.6;

  resetUIState();
  renderDispatchTab(trucks, graph);
  renderRankingsTab(trucks, graph);
}

// ---------------------------------------------------------------------
// UI wiring + main loop
// ---------------------------------------------------------------------
initUI({ onSelectTruck: followTruck, onToggleControl: toggleControl });
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
      state.decisionTimer -= dt;
      const pct = Math.max(0, state.decisionTimer / DECISION_TIMEOUT) * 100;
      el.decisionTimerFill.style.width = pct + "%";
      if (state.decisionTimer <= 0 && state.decisionTruck) {
        resolveDecision(state.decisionTruck.pendingOptions[0]);
      }
    } else if (!state.settingsOpen) {
      state.gameSeconds += dt * BASE_TIME_SCALE * state.timeScale;
      const decisionTruck = updateFleet(graph, trucks, dt, state.timeScale, getControlledTruck());
      if (decisionTruck) showDecisionPanel(decisionTruck);
    }

    const followed = getFollowedTruck();
    if (camera.mode === "FOLLOW" && followed) {
      camera.followTarget = truckWorldPos(graph, followed);
    } else if (camera.mode === "FOLLOW" && !followed) {
      unfollow();
    }
    camera.update();

    drawFrame(ctx, canvas, camera, graph, bgCanvas, trucks, followed, { showAllLabels: settings.showAllLabels });
    el.clock.textContent = formatClock(state.gameSeconds);

    // Whatever the Unit tab is currently showing refreshes live - a
    // followed truck's numbers every frame (speed/odometer/ETA are worth
    // that smoothness), a viewed city's on the same slower tick as the
    // fleet-wide rankings below (inbound/outbound counts don't need
    // frame-rate smoothness, and re-scanning all trucks for them every
    // frame would be wasted work for numbers no one watches that closely).
    if (state.detailsView && state.detailsView.kind === "truck") {
      const t = trucks.find((tt) => tt.id === state.detailsView.id);
      if (t) refreshFollowedTruckDetails(t, state.controlledTruckId === t.id);
    }

    if (now - lastUiRefresh > 400) {
      lastUiRefresh = now;
      renderDispatchTab(trucks, graph);
      renderRankingsTab(trucks, graph);
      if (state.detailsView && state.detailsView.kind === "city") {
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
