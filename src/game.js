// game.js - Interstate Hauler
// A node-to-node interstate trucking game rendered as a rotating 2.5D
// chase-cam map. Relies on globals from data.js and geo.js.
(function () {
"use strict";

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------
const UNITS_PER_MPH = 5.2;       // arcade world-units of road per mph per second
const DECISION_TRIGGER = 1300;    // world-units before a node to reveal the choice panel
const STOP_ZONE = 1000;           // world-units over which speed tapers down for a real junction
const DECISION_TIMEOUT = 11;      // seconds before auto-picking a default route
const ACCEL = 20;                 // mph/sec
const BRAKE = 42;                 // mph/sec
const COAST_DRAG = 4.5;           // mph/sec natural deceleration
const LANE_HALF_WIDTH = 46;       // world-units, how far the truck can drift laterally
const STEER_SPEED = 130;          // world-units/sec lateral, at full input
const TANK_CAPACITY = 150;        // gallons
const MPG = 6.4;
const FUEL_PRICE = 3.85;          // $/gallon
const STARTING_CASH = 600;
const START_CITY = "Chicago";

const driver = new DriverDNA();

// ---------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------
const sceneCanvas = document.getElementById("scene");
const sceneCtx = sceneCanvas.getContext("2d");
const mapCanvas = document.getElementById("minimap");
const mapCtx = mapCanvas.getContext("2d");

const el = {
  shield: document.getElementById("route-shield"),
  dir: document.getElementById("route-dir"),
  control: document.getElementById("route-control"),
  jobDest: document.getElementById("job-dest"),
  jobDist: document.getElementById("job-dist"),
  jobPay: document.getElementById("job-pay"),
  speedValue: document.getElementById("speed-value"),
  fuelFill: document.getElementById("fuel-fill"),
  cashValue: document.getElementById("cash-value"),
  decisionOverlay: document.getElementById("decision-overlay"),
  decisionOptions: document.getElementById("decision-options"),
  decisionTimerFill: document.getElementById("decision-timer-fill"),
  modal: document.getElementById("modal"),
  modalTitle: document.getElementById("modal-title"),
  modalBody: document.getElementById("modal-body"),
  modalBtn: document.getElementById("modal-btn"),
  jobCargo: document.getElementById("job-cargo"),
  driverLabel: document.getElementById("driver-label"),
  driverDesc: document.getElementById("driver-desc"),
  toast: document.getElementById("toast"),
  boot: document.getElementById("boot"),
  fatal: document.getElementById("fatal-error"),
  btnGas: document.getElementById("btn-gas"),
  btnBrake: document.getElementById("btn-brake"),
};

window.addEventListener("error", (e) => {
  el.fatal.textContent = "Fatal error: " + (e.error ? (e.error.stack || e.error.message) : e.message);
  el.fatal.classList.remove("hidden");
});

// ---------------------------------------------------------------------
// Graph + ribbon geometry
// ---------------------------------------------------------------------
const graph = buildGraph();
const ribbonCache = new Map();

function ribbonKey(a, b, route) {
  const pair = [a, b].sort();
  return `${route}::${pair[0]}|${pair[1]}`;
}

// Catmull-Rom evaluation for one interior segment (p1->p2) given neighbours.
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
  return { x, y };
}

function buildRibbon(edge) {
  const key = ribbonKey(edge.from, edge.to, edge.route);
  let cached = ribbonCache.get(key);
  if (!cached) {
    const rnd = mulberry32(hashStr(key));
    const len = Math.min(4200, Math.max(600, 320 + edge.miles * 1.55));
    const nMid = Math.max(1, Math.min(6, Math.round(len / 650)));
    const ctrl = [{ x: 0, y: 0 }];
    ctrl.push({ x: 0, y: len * 0.1 });
    const curviness = len * (0.05 + rnd() * 0.05);
    for (let i = 1; i <= nMid; i++) {
      const t = i / (nMid + 1);
      const sway = Math.sin(t * Math.PI) * curviness * (rnd() * 2 - 1);
      ctrl.push({ x: sway, y: len * (0.1 + t * 0.8) });
    }
    ctrl.push({ x: 0, y: len * 0.9 });
    ctrl.push({ x: 0, y: len });

    const ext = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]];
    const dense = [];
    const stepsPerSeg = 14;
    for (let i = 0; i < ext.length - 3; i++) {
      for (let s = 0; s < stepsPerSeg; s++) {
        const t = s / stepsPerSeg;
        dense.push(catmullRom(ext[i], ext[i + 1], ext[i + 2], ext[i + 3], t));
      }
    }
    dense.push(ctrl[ctrl.length - 1]);

    const cum = [0];
    for (let i = 1; i < dense.length; i++) {
      const dx = dense[i].x - dense[i - 1].x, dy = dense[i].y - dense[i - 1].y;
      cum.push(cum[i - 1] + Math.hypot(dx, dy));
    }
    cached = { points: dense, cum, length: cum[cum.length - 1], forwardKeyStartsAt: [edge.from, edge.to].sort()[0] };
    ribbonCache.set(key, cached);
  }
  // Orient the shared geometry to this edge's travel direction.
  const forward = cached.forwardKeyStartsAt === edge.from;
  return { ...cached, reversed: !forward };
}

function ribbonSample(ribbon, s) {
  s = Math.max(0, Math.min(ribbon.length, s));
  const sQuery = ribbon.reversed ? ribbon.length - s : s;
  const cum = ribbon.cum, pts = ribbon.points;
  // binary search
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < sQuery) lo = mid + 1; else hi = mid;
  }
  const i = Math.max(1, lo);
  const segLen = Math.max(1e-6, cum[i] - cum[i - 1]);
  const t = (sQuery - cum[i - 1]) / segLen;
  const a = pts[i - 1], b = pts[i];
  let x = a.x + (b.x - a.x) * t;
  let y = a.y + (b.y - a.y) * t;
  if (ribbon.reversed) x = -x;
  return { x, y };
}

// simpler + correct tangent helper (avoids the confusing inline expr above)
function ribbonPose(ribbon, s) {
  const eps = 8;
  const p0 = ribbonSample(ribbon, s - eps);
  const p1 = ribbonSample(ribbon, s + eps);
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  const mid = ribbonSample(ribbon, s);
  return { x: mid.x, y: mid.y, headingX: dx / len, headingY: dy / len };
}

// ---------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------
const state = {
  mode: "intro", // intro | drive | decision | delivered | gameover
  currentNode: START_CITY,
  edge: null,
  ribbon: null,
  s: 0,
  lane: 0,
  laneInput: 0,
  speed: 0,
  fuel: TANK_CAPACITY,
  cash: STARTING_CASH,
  camHeading: { x: 0, y: 1 },
  destination: null,
  job: null, // { optimalMiles, payout, milesDriven }
  decisionOptions: null,
  decisionTimer: 0,
  pendingEdge: null,
  pendingDelivery: false,
  decisionEvaluated: false,
  inputGas: false,
  inputBrake: false,
  toastTimer: 0,
};

function canRefuel(city) {
  return !!city && (city.t > 0 || (city.ind && city.ind.includes("Fuel")));
}

function pickEdgesFrom(node, excludeReverseOf) {
  const all = graph.adjacency[node] || [];
  const filtered = all.filter((e) => !(excludeReverseOf && e.to === excludeReverseOf.from && e.route === excludeReverseOf.route));
  return filtered.length ? filtered : all; // dead end -> allow U-turn
}

function weightedPick(list, weightFn, rnd) {
  const total = list.reduce((s, x) => s + weightFn(x), 0);
  let r = (rnd ? rnd() : Math.random()) * total;
  for (const item of list) {
    r -= weightFn(item);
    if (r <= 0) return item;
  }
  return list[list.length - 1];
}

function chooseDestination(excludeName) {
  const candidates = Object.values(graph.nodes).filter((n) => n.t <= 3 && n.name !== excludeName);
  return weightedPick(candidates, (n) => n.w * n.w).name;
}

function startJob(fromCity) {
  const dest = chooseDestination(fromCity);
  const path = shortestPath(graph, fromCity, dest);
  const optimalMiles = path ? path.reduce((s, e) => s + e.miles, 0) : haversineMiles(graph.nodes[fromCity], graph.nodes[dest]);
  const contract = buildContract(fromCity, dest, optimalMiles, graph.nodes[dest].t);
  state.destination = dest;
  state.job = {
    optimalMiles,
    payout: contract.payout,
    cargo: contract.cargo,
    truckType: contract.truckType,
    milesDriven: 0,
    remainingEstimate: optimalMiles,
  };
}

function enterEdge(edge) {
  state.edge = edge;
  state.ribbon = buildRibbon(edge);
  state.s = 0;
  state.decisionOptions = null;
  state.pendingEdge = null;
  state.pendingDelivery = false;
  state.decisionEvaluated = false;
  state.mode = "drive";
}

function beginDrive() {
  startJob(state.currentNode);
  const opts = pickEdgesFrom(state.currentNode, null);
  const first = weightedPick(opts, (e) => (graph.nodes[e.to].w || 1) + 1);
  enterEdge(first);
  el.boot.classList.add("hidden");
}

// Looks ahead once per edge, as the truck nears the upcoming node, and
// either queues the obvious continuation silently or raises the choice panel.
function evaluateAhead() {
  if (state.decisionEvaluated || !state.ribbon) return;
  const remaining = state.ribbon.length - state.s;
  if (remaining > DECISION_TRIGGER) return;
  state.decisionEvaluated = true;

  const node = state.edge.to;
  if (node === state.destination) {
    state.pendingDelivery = true;
    return;
  }
  const options = pickEdgesFrom(node, state.edge);
  if (options.length <= 1) {
    state.pendingEdge = options[0] || null;
    return;
  }
  presentDecision(options);
}

function refuelAt(node) {
  const city = graph.nodes[node];
  if (!canRefuel(city)) return;
  const need = TANK_CAPACITY - state.fuel;
  if (need <= 0.01) return;
  const affordableGallons = Math.min(need, state.cash / FUEL_PRICE);
  if (affordableGallons <= 0) {
    if (state.fuel <= 0.5) triggerGameOver("You ran out of fuel and cash near " + node + ". Game over.");
    return;
  }
  const cost = affordableGallons * FUEL_PRICE;
  state.fuel += affordableGallons;
  state.cash -= cost;
  if (affordableGallons < need - 0.5) {
    showToast(`Topped up ${affordableGallons.toFixed(0)} gal (that's all you could afford)`);
  }
}

function presentDecision(options) {
  // cap the panel to the most meaningful choices
  const ranked = [...options].sort((a, b) => (graph.nodes[b.control] ? graph.nodes[b.control].w : 0) - (graph.nodes[a.control] ? graph.nodes[a.control].w : 0));
  const shown = ranked.slice(0, 4);
  state.mode = "decision";
  state.decisionOptions = shown;
  state.decisionTimer = DECISION_TIMEOUT;
  renderDecisionPanel(shown);
  el.decisionOverlay.classList.remove("hidden");
}

function resolveDecision(edge) {
  el.decisionOverlay.classList.add("hidden");
  state.pendingEdge = edge;
  state.mode = "drive";
}

function completeDelivery() {
  state.mode = "delivered";
  const job = state.job;
  state.cash += job.payout;
  const efficiency = job.milesDriven > 0 ? Math.round((job.optimalMiles / job.milesDriven) * 100) : 100;
  showModal("Delivery Complete!", `
    <div class="row"><span>Delivered to</span><strong>${state.destination}</strong></div>
    <div class="row"><span>Miles driven</span><span>${job.milesDriven.toFixed(0)} mi</span></div>
    <div class="row"><span>Optimal route</span><span>${job.optimalMiles.toFixed(0)} mi</span></div>
    <div class="row"><span>Route efficiency</span><span>${efficiency}%</span></div>
    <div class="row"><span>Payout</span><strong>$${job.payout}</strong></div>
  `, () => {
    beginDrive();
  });
}

function triggerGameOver(msg) {
  state.mode = "gameover";
  showModal("Stranded", msg, () => {
    state.cash = STARTING_CASH;
    state.fuel = TANK_CAPACITY;
    beginDrive();
  });
}

// ---------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------
function showModal(title, bodyHtml, onContinue) {
  el.modalTitle.textContent = title;
  el.modalBody.innerHTML = bodyHtml;
  el.modal.classList.remove("hidden");
  el.modalBtn.onclick = () => {
    el.modal.classList.add("hidden");
    onContinue && onContinue();
  };
}

let toastTimeout = null;
function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.remove("hidden");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.toast.classList.add("hidden"), 2600);
}

function shieldHtml(kind, route) {
  const cls = kind === "interstate" ? "interstate" : "highway";
  return `<div class="shield ${cls}">${route.replace("US-", "US ").replace(" (West)", "").replace(" (East)", "")}</div>`;
}

function renderDecisionPanel(options) {
  el.decisionOptions.innerHTML = "";
  options.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.className = "decision-btn";
    const isStraight = state.edge && opt.route === state.edge.route;
    btn.innerHTML = `${shieldHtml(opt.kind, opt.route)}
      <span class="dcity">${isStraight ? "Continue " : "Turn to "}${opt.control}</span>
      <span class="ddist">${opt.dirLabel} · ${Math.round(opt.miles)} mi to ${opt.to}</span>
      <span class="dkey">[${idx + 1}]</span>`;
    btn.addEventListener("click", () => resolveDecision(opt));
    el.decisionOptions.appendChild(btn);
  });
}

function updateHud() {
  const e = state.edge;
  if (e) {
    el.shield.textContent = e.route.replace(" (West)", " W").replace(" (East)", " E");
    el.shield.className = "shield " + (e.kind === "interstate" ? "interstate" : "highway");
    el.dir.textContent = `${e.dirLabel}BOUND`;
    el.control.textContent = `→ ${e.control}`;
  }
  el.jobDest.textContent = "Destination: " + (state.destination || "—");
  if (state.job) {
    el.jobCargo.textContent = `Cargo: ${state.job.cargo} (${state.job.truckType.label})`;
    el.jobDist.textContent = `${Math.max(0, state.job.remainingEstimate).toFixed(0)} mi remaining`;
    el.jobPay.textContent = "Payout: $" + state.job.payout;
  }
  el.speedValue.textContent = Math.round(state.speed);
  const fuelPct = Math.max(0, Math.min(100, (state.fuel / TANK_CAPACITY) * 100));
  el.fuelFill.style.width = fuelPct + "%";
  el.fuelFill.style.background = fuelPct < 20 ? "linear-gradient(90deg,#e5484d,#ff8a8a)" : "linear-gradient(90deg,#35c96b,#8fe3a8)";
  el.cashValue.textContent = "$" + Math.round(state.cash).toLocaleString();
}

// ---------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------
const keys = new Set();
window.addEventListener("keydown", (ev) => {
  keys.add(ev.key.toLowerCase());
  if (state.mode === "decision") {
    const n = parseInt(ev.key, 10);
    if (n >= 1 && n <= state.decisionOptions.length) resolveDecision(state.decisionOptions[n - 1]);
  }
});
window.addEventListener("keyup", (ev) => keys.delete(ev.key.toLowerCase()));

function isTouchDevice() {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}
if (isTouchDevice()) document.body.classList.add("touch");

function bindPedal(elButton, onDown, onUp) {
  const down = (ev) => { ev.preventDefault(); onDown(); };
  const up = (ev) => { ev.preventDefault(); onUp(); };
  elButton.addEventListener("touchstart", down, { passive: false });
  elButton.addEventListener("touchend", up, { passive: false });
  elButton.addEventListener("touchcancel", up, { passive: false });
  elButton.addEventListener("mousedown", down);
  elButton.addEventListener("mouseup", up);
  elButton.addEventListener("mouseleave", up);
}
bindPedal(el.btnGas, () => (state.inputGas = true), () => (state.inputGas = false));
bindPedal(el.btnBrake, () => (state.inputBrake = true), () => (state.inputBrake = false));

let dragStartX = null;
sceneCanvas.addEventListener("touchstart", (ev) => { dragStartX = ev.touches[0].clientX; }, { passive: true });
sceneCanvas.addEventListener("touchmove", (ev) => {
  if (dragStartX === null) return;
  const dx = ev.touches[0].clientX - dragStartX;
  state.laneInput = Math.max(-1, Math.min(1, dx / 60));
}, { passive: true });
sceneCanvas.addEventListener("touchend", () => { dragStartX = null; state.laneInput = 0; });

function readSteerInput() {
  let v = 0;
  if (keys.has("arrowleft") || keys.has("a")) v -= 1;
  if (keys.has("arrowright") || keys.has("d")) v += 1;
  if (v === 0) v = state.laneInput;
  return v;
}
function readGasInput() {
  return keys.has("arrowup") || keys.has("w") || state.inputGas;
}
function readBrakeInput() {
  return keys.has("arrowdown") || keys.has("s") || state.inputBrake;
}

// ---------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------
function speedCap() {
  if (!state.edge) return 70;
  let cap = state.edge.speedLimit + driver.overSpeedAllowance;
  if (state.mode === "decision" && state.ribbon) {
    const remain = Math.max(0, state.ribbon.length - state.s);
    const t = Math.max(0, Math.min(1, remain / STOP_ZONE));
    cap = Math.min(cap, 8 + t * (state.edge.speedLimit - 8));
  }
  return cap;
}

function update(dt) {
  if (state.mode === "intro" || state.mode === "delivered" || state.mode === "gameover") return;

  evaluateAhead();

  const cap = speedCap();
  if (readGasInput()) {
    state.speed = Math.min(cap, state.speed + ACCEL * driver.handling * dt);
  } else if (readBrakeInput()) {
    state.speed = Math.max(0, state.speed - BRAKE * dt);
  } else {
    state.speed = Math.max(0, state.speed - COAST_DRAG * dt);
  }
  state.speed = Math.min(state.speed, cap);

  const steer = readSteerInput();
  state.lane += steer * STEER_SPEED * driver.handling * dt;
  state.lane = Math.max(-LANE_HALF_WIDTH, Math.min(LANE_HALF_WIDTH, state.lane));

  if (state.mode === "decision") {
    state.decisionTimer -= dt;
    const pct = Math.max(0, state.decisionTimer / DECISION_TIMEOUT) * 100;
    el.decisionTimerFill.style.width = pct + "%";
    if (state.decisionTimer <= 0) {
      const straight = state.decisionOptions.find((o) => state.edge && o.route === state.edge.route);
      resolveDecision(straight || state.decisionOptions[0]);
    }
  }

  if (!state.ribbon) return;
  const remaining = Math.max(0, state.ribbon.length - state.s);
  let dsUnits = state.speed * UNITS_PER_MPH * dt;
  const resolved = state.pendingEdge || state.pendingDelivery;
  if (dsUnits >= remaining) {
    dsUnits = remaining;
    if (!resolved) state.speed = 0; // holding at the junction, still waiting on a choice
  }

  if (dsUnits > 0) {
    const realMiles = state.edge.miles * (dsUnits / state.ribbon.length);
    state.job.milesDriven += realMiles;
    state.job.remainingEstimate -= realMiles;
    const truckType = state.job && state.job.truckType ? state.job.truckType : { mpgMult: 1 };
    const effectiveMpg = MPG * truckType.mpgMult / driver.fuelBurnMult;
    const gallonsUsed = realMiles / effectiveMpg;
    state.fuel -= gallonsUsed;
    if (state.fuel <= 0) {
      state.fuel = 0;
      state.speed = Math.max(0, state.speed - BRAKE * 2 * dt);
      showToast("Out of fuel!");
      if (state.speed <= 0.5) { triggerGameOver("You ran dry between cities. Time to call for a tow."); return; }
    }
  }
  state.s += dsUnits;

  if (resolved && state.s >= state.ribbon.length - 0.01) {
    const node = state.edge.to;
    state.currentNode = node;
    if (state.pendingDelivery) {
      completeDelivery();
    } else {
      const next = state.pendingEdge;
      refuelAt(node);
      if (state.mode !== "gameover") enterEdge(next);
    }
    return;
  }

  // smooth camera heading toward the truck's current tangent
  const pose = ribbonPose(state.ribbon, state.s);
  const targetH = { x: pose.headingX, y: pose.headingY };
  const lerp = 1 - Math.pow(0.001, dt);
  state.camHeading.x += (targetH.x - state.camHeading.x) * lerp;
  state.camHeading.y += (targetH.y - state.camHeading.y) * lerp;
  const hl = Math.hypot(state.camHeading.x, state.camHeading.y) || 1;
  state.camHeading.x /= hl; state.camHeading.y /= hl;
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------
let W = 0, H = 0, DPR = 1, mapSize = 132;
function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  sceneCanvas.width = W * DPR; sceneCanvas.height = H * DPR;
  sceneCanvas.style.width = W + "px"; sceneCanvas.style.height = H + "px";
  sceneCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
  mapSize = mapCanvas.clientWidth || 132;
  mapCanvas.width = mapSize * DPR; mapCanvas.height = mapSize * DPR;
  mapCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener("resize", resize);

function projectPoint(localX, localY, anchorX, anchorY, zoom) {
  const hx = state.camHeading.x, hy = state.camHeading.y;
  // rotate (localX,localY) by the inverse of heading so heading maps to (0,-1) (up)
  const rightX = hy, rightY = -hx;
  const u = localX * rightX + localY * rightY;   // lateral (screen x)
  const v = localX * hx + localY * hy;            // forward distance (positive ahead)
  const depth = v;
  const persp = Math.max(0.45, Math.min(1.25, 1 - depth * 0.00016));
  const sx = anchorX + u * zoom * persp;
  const sy = anchorY - v * zoom * persp * 0.72;
  return { x: sx, y: sy, scale: persp, depth };
}

function drawBackground() {
  const grad = sceneCtx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#3a4a3f");
  grad.addColorStop(0.55, "#2c3830");
  grad.addColorStop(1, "#20281f");
  sceneCtx.fillStyle = grad;
  sceneCtx.fillRect(0, 0, W, H);
}

function roadColor(kind) {
  return kind === "interstate" ? "#4b4f57" : "#57524a";
}

function drawRoad(ribbon, anchorX, anchorY, zoom, currentS) {
  const visibleBehind = 900, visibleAhead = 3600;
  const roadWidth = 120;
  sceneCtx.lineJoin = "round";
  sceneCtx.lineCap = "round";

  // sample along cumulative arclength range relative to currentS
  const samples = [];
  const step = 26;
  for (let s = currentS - visibleBehind; s <= currentS + visibleAhead; s += step) {
    if (s < 0 || s > ribbon.length) continue;
    const p = ribbonSample(ribbon, s);
    samples.push(p);
  }
  if (samples.length < 2) return;

  const proj = samples.map((p) => projectPoint(p.x, p.y, anchorX, anchorY, zoom));

  // road bed
  sceneCtx.strokeStyle = roadColor(state.edge.kind);
  for (let i = 1; i < proj.length; i++) {
    sceneCtx.lineWidth = Math.max(4, roadWidth * proj[i].scale);
    sceneCtx.beginPath();
    sceneCtx.moveTo(proj[i - 1].x, proj[i - 1].y);
    sceneCtx.lineTo(proj[i].x, proj[i].y);
    sceneCtx.stroke();
  }
  // shoulders
  sceneCtx.strokeStyle = "rgba(255,255,255,0.35)";
  for (let i = 1; i < proj.length; i++) {
    sceneCtx.lineWidth = Math.max(1, 3 * proj[i].scale);
    sceneCtx.beginPath();
    sceneCtx.moveTo(proj[i - 1].x, proj[i - 1].y);
    sceneCtx.lineTo(proj[i].x, proj[i].y);
    sceneCtx.stroke();
  }
  // dashed centerline
  sceneCtx.setLineDash([14, 16]);
  sceneCtx.strokeStyle = state.edge.kind === "interstate" ? "#ffd35c" : "#e9e5da";
  for (let i = 1; i < proj.length; i++) {
    sceneCtx.lineWidth = Math.max(1, 3 * proj[i].scale);
    sceneCtx.beginPath();
    sceneCtx.moveTo(proj[i - 1].x, proj[i - 1].y);
    sceneCtx.lineTo(proj[i].x, proj[i].y);
    sceneCtx.stroke();
  }
  sceneCtx.setLineDash([]);
}

function drawCityBlock(localX, localY, anchorX, anchorY, zoom, city) {
  const p = projectPoint(localX, localY, anchorX, anchorY, zoom);
  if (p.scale < 0.4) return;
  const rnd = mulberry32(hashStr(city.name));
  const count = Math.max(2, Math.min(9, Math.round(city.w)));
  const spread = 170;
  for (let i = 0; i < count; i++) {
    const ox = (rnd() * 2 - 1) * spread;
    const oy = (rnd() * 2 - 1) * spread * 0.6;
    const bp = projectPoint(localX + ox, localY + oy, anchorX, anchorY, zoom);
    const h = (14 + rnd() * 46) * bp.scale * (city.w / 6 + 0.6);
    const w = (18 + rnd() * 22) * bp.scale;
    sceneCtx.fillStyle = `hsl(${210 + rnd() * 30}, 12%, ${18 + rnd() * 14}%)`;
    sceneCtx.fillRect(bp.x - w / 2, bp.y - h, w, h);
    sceneCtx.fillStyle = "rgba(255, 220, 140, 0.55)";
    sceneCtx.fillRect(bp.x - w / 2, bp.y - h, w, Math.max(2, h * 0.12));
  }
  sceneCtx.fillStyle = "#fff";
  sceneCtx.font = `700 ${Math.max(10, 15 * p.scale)}px sans-serif`;
  sceneCtx.textAlign = "center";
  sceneCtx.shadowColor = "rgba(0,0,0,0.8)";
  sceneCtx.shadowBlur = 4;
  sceneCtx.fillText(city.name, p.x, p.y + 14);
  sceneCtx.shadowBlur = 0;
}

function drawTruck(anchorX, anchorY) {
  sceneCtx.save();
  sceneCtx.translate(anchorX + state.lane * 0.55, anchorY);
  const cabW = 34, cabH = 26, trailerW = 30, trailerH = 58;
  sceneCtx.fillStyle = "#c1272d";
  sceneCtx.fillRect(-trailerW / 2, -8, trailerW, trailerH);
  sceneCtx.fillStyle = "#eef1f5";
  sceneCtx.fillRect(-trailerW / 2 + 3, -4, trailerW - 6, trailerH - 10);
  sceneCtx.fillStyle = "#22252a";
  sceneCtx.fillRect(-cabW / 2, -trailerH * 0.55, cabW, cabH);
  sceneCtx.fillStyle = "#9fd3ff";
  sceneCtx.fillRect(-cabW / 2 + 4, -trailerH * 0.55 + 4, cabW - 8, 8);
  sceneCtx.restore();
}

function nearbyCities(currentS, ribbon, edge) {
  const list = [];
  if (currentS < 1600) list.push({ name: edge.from, localX: 0, localY: 0 });
  if (ribbon.length - currentS < 1600) list.push({ name: edge.to, localX: 0, localY: ribbon.length });
  return list;
}

function renderScene() {
  drawBackground();
  if (!state.edge || !state.ribbon) return;
  const anchorX = W / 2, anchorY = H * 0.68;
  const zoom = Math.max(0.28, Math.min(0.62, 520 / Math.max(300, state.ribbon.length * 0.001 + 400))) * (W / 900);

  drawRoad(state.ribbon, anchorX, anchorY, zoom, state.s);

  for (const c of nearbyCities(state.s, state.ribbon, state.edge)) {
    const city = graph.nodes[c.name];
    if (city) drawCityBlock(c.localX, c.localY, anchorX, anchorY, zoom, city);
  }

  drawTruck(anchorX, anchorY);
}

function renderMinimap() {
  const size = mapSize;
  mapCtx.clearRect(0, 0, size, size);
  if (!state.currentNode) return;
  const center = graph.nodes[state.currentNode];
  const scale = size / 9; // degrees to px window
  mapCtx.save();
  mapCtx.beginPath();
  mapCtx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  mapCtx.clip();
  mapCtx.fillStyle = "rgba(20,26,34,0.9)";
  mapCtx.fillRect(0, 0, size, size);

  function toMap(c) {
    const dx = (c.lon - center.lon) * Math.cos(center.lat * Math.PI / 180);
    const dy = -(c.lat - center.lat);
    return { x: size / 2 + dx * scale, y: size / 2 + dy * scale };
  }

  mapCtx.strokeStyle = "rgba(255,176,32,0.55)";
  mapCtx.lineWidth = 2;
  for (const e of graph.adjacency[state.currentNode] || []) {
    const a = toMap(center), b = toMap(graph.nodes[e.to]);
    mapCtx.beginPath(); mapCtx.moveTo(a.x, a.y); mapCtx.lineTo(b.x, b.y); mapCtx.stroke();
  }

  mapCtx.fillStyle = "#fff";
  const me = toMap(center);
  mapCtx.beginPath(); mapCtx.arc(me.x, me.y, 4, 0, Math.PI * 2); mapCtx.fill();

  if (state.destination && graph.nodes[state.destination]) {
    const d = toMap(graph.nodes[state.destination]);
    const dist = Math.hypot(d.x - size / 2, d.y - size / 2);
    if (dist < size / 2 - 6) {
      mapCtx.fillStyle = "#35c96b";
      mapCtx.beginPath(); mapCtx.arc(d.x, d.y, 5, 0, Math.PI * 2); mapCtx.fill();
    } else {
      const ang = Math.atan2(d.y - size / 2, d.x - size / 2);
      const ex = size / 2 + Math.cos(ang) * (size / 2 - 10);
      const ey = size / 2 + Math.sin(ang) * (size / 2 - 10);
      mapCtx.fillStyle = "#35c96b";
      mapCtx.beginPath(); mapCtx.arc(ex, ey, 5, 0, Math.PI * 2); mapCtx.fill();
    }
  }
  mapCtx.restore();
  mapCtx.strokeStyle = "rgba(255,255,255,0.25)";
  mapCtx.beginPath(); mapCtx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2); mapCtx.stroke();
}

// ---------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------
let lastTime = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  try {
    update(dt);
    renderScene();
    renderMinimap();
    updateHud();
  } catch (err) {
    el.fatal.textContent = "Runtime error: " + (err.stack || err.message);
    el.fatal.classList.remove("hidden");
    return;
  }
  requestAnimationFrame(frame);
}

const archetype = driver.getArchetype();
el.driverLabel.textContent = archetype.label;
el.driverLabel.style.color = archetype.color;
el.driverDesc.textContent = archetype.desc;

resize();
beginDrive();
requestAnimationFrame(frame);

})();
