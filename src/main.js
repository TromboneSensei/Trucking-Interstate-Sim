// main.js - boot + the single game loop. Ties the graph, fleet
// simulation, camera, renderer, and dashboard together.
import { buildGraph, WORLD_WIDTH, WORLD_HEIGHT } from "./geo.js";
import { spawnFleet, updateFleet, BASE_TIME_SCALE } from "./fleet.js";
import { Camera } from "./camera.js";
import { renderStaticBackground, drawFrame, truckWorldPos } from "./render.js";
import { initUI, openDetailsFor, refreshFollowedTruckDetails, renderDispatchTab } from "./ui.js";

const FLEET_SIZE = 150;
const DECISION_TIMEOUT = 11; // seconds
const TAP_TOLERANCE_PX = 26;

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
};

window.addEventListener("error", (e) => {
  el.fatal.textContent = "Fatal error: " + (e.error ? (e.error.stack || e.error.message) : e.message);
  el.fatal.classList.remove("hidden");
});

const graph = buildGraph();
const bgCanvas = renderStaticBackground(graph);
const trucks = spawnFleet(graph, FLEET_SIZE);

const state = {
  paused: false,
  timeScale: parseFloat(el.timeSlider.value),
  gameSeconds: 6 * 3600, // start at 6:00 AM
  followedTruckId: null,
  // Being followed just means the camera is locked on - purely a
  // spectator thing. controlledTruckId is a separate, narrower opt-in:
  // only the controlled truck's junctions ever pause the sim for a
  // player decision, armed explicitly via the details panel's Take
  // Control button.
  controlledTruckId: null,
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
  camera.follow(truckWorldPos(graph, truck));
  el.btnExitFollow.classList.remove("hidden");
  openDetailsFor(truck, "truck", false);
}

function unfollow() {
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
  if (bestCity) openDetailsFor(bestCity, "city", false);
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

el.fleetCount.textContent = `${trucks.length} UNITS`;

// ---------------------------------------------------------------------
// UI wiring + main loop
// ---------------------------------------------------------------------
initUI({ onSelectTruck: followTruck, onToggleControl: toggleControl });

let lastTime = performance.now();
let lastUiRefresh = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  try {
    if (state.paused) {
      state.decisionTimer -= dt;
      const pct = Math.max(0, state.decisionTimer / DECISION_TIMEOUT) * 100;
      el.decisionTimerFill.style.width = pct + "%";
      if (state.decisionTimer <= 0 && state.decisionTruck) {
        resolveDecision(state.decisionTruck.pendingOptions[0]);
      }
    } else {
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

    drawFrame(ctx, canvas, camera, graph, bgCanvas, trucks, followed);
    el.clock.textContent = formatClock(state.gameSeconds);

    // The followed truck's own numbers (speed, odometer, ETA) refresh
    // every frame so they read as genuinely live, not on a tick like the
    // fleet-wide rankings below (cheap either way, but a full re-sort of
    // 150 trucks every frame is unnecessary work for numbers no one is
    // watching that closely).
    if (followed) refreshFollowedTruckDetails(followed, state.controlledTruckId === followed.id);

    if (now - lastUiRefresh > 400) {
      lastUiRefresh = now;
      renderDispatchTab(trucks);
    }
  } catch (err) {
    el.fatal.textContent = "Runtime error: " + (err.stack || err.message);
    el.fatal.classList.remove("hidden");
    return;
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
