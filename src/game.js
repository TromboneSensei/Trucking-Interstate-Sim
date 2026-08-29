// game.js - Interstate Hauler
// A node-to-node interstate trucking game rendered as a rotating 2.5D
// chase-cam map. Relies on globals from data.js and geo.js.
(function () {
"use strict";

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------
// UNITS_PER_MPH and all lane-geometry constants/helpers (LANE_WIDTH,
// LANES_PER_DIR, MEDIAN_WIDTH, laneCount, ownLaneX, roadHalfWidth,
// laneRange) now live in geo.js so the traffic system can share the exact
// same road/physics model without reaching into this module's closure.
const DECISION_TRIGGER = 1300;    // world-units before a node to reveal the choice panel
const STOP_ZONE = 1000;           // world-units over which speed tapers down for a real junction
const DECISION_TIMEOUT = 11;      // seconds before auto-picking a default route
const ACCEL = 20;                 // mph/sec
const BRAKE = 42;                 // mph/sec
const COAST_DRAG = 4.5;           // mph/sec natural deceleration
const STEER_SPEED = 130;          // world-units/sec lateral, at full input
const TANK_CAPACITY = 150;        // gallons
const MPG = 6.4;
const FUEL_PRICE = 3.85;          // $/gallon
const STARTING_CASH = 600;
const START_CITY = "Chicago";
const MAX_BRANCHES = 4;           // cap on ranked junction options, both for the decision panel and the rendered fan-out

// Look-ahead rendering: how far the "visible network" fans out beyond the
// current edge so the road ahead reads continuously through junctions,
// like a real nav map, instead of stopping dead at the edge boundary.
const MAX_TREE_DEPTH = 3;
const MAX_PREVIEW_BUDGET = 6000;  // world units of branch ribbon, shared across the whole tree
const MAX_TREE_NODES = 40;        // defensive hard stop on dense junctions

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

// graph, buildRibbon, ribbonSample, ribbonPose, edgeId all now live in
// geo.js so the traffic system can share them without reaching into this
// module's closure.

// ---------------------------------------------------------------------
// Visible network: a small tree of edges stitched into the CURRENT edge's
// local coordinate frame, so the road renders continuously through
// upcoming junctions instead of stopping dead at the edge boundary. Built
// once per edge-entry (see enterEdge). Every edge's ribbon is generated in
// its own local space with a ~vertical tangent at both ends (by
// construction in buildRibbon), so a node's rotation relative to the root
// is just the delta between its own true compass bearing and the root
// edge's bearing — no hop-by-hop rotation composition needed. Only the
// translation accumulates, edge by edge, out from the root.
// ---------------------------------------------------------------------
function nodeToRoot(node, lx, ly) {
  return {
    x: node.tx + lx * node.cos - ly * node.sin,
    y: node.ty + lx * node.sin + ly * node.cos,
  };
}

function growBranches(node, rootBearing, budgetLeft, nodeCounter) {
  if (node.depth >= MAX_TREE_DEPTH || budgetLeft <= 0 || nodeCounter.n >= MAX_TREE_NODES) return;
  const nextCity = node.edge.to;
  if (nextCity === state.destination) return; // don't fan out past the delivery point
  const options = rankAndCapOptions(pickEdgesFrom(nextCity, node.edge));
  const parentEnd = nodeToRoot(node, 0, node.ribbon.length);
  for (const candidateEdge of options) {
    if (nodeCounter.n >= MAX_TREE_NODES) break;
    const childRibbon = buildRibbon(candidateEdge);
    // Negated: compass bearing increases clockwise on a y-up map, but our
    // local space is (x=driver's-right, y=forward) which is the opposite
    // handedness — verified empirically (a well-west branch was rendering
    // to the right of a more-northward one) before flipping this sign.
    const deltaRad = toRad(rootBearing - candidateEdge.bearing);
    const child = {
      edge: candidateEdge, ribbon: childRibbon, depth: node.depth + 1,
      tx: parentEnd.x, ty: parentEnd.y,
      cos: Math.cos(deltaRad), sin: Math.sin(deltaRad),
      children: [],
    };
    node.children.push(child);
    nodeCounter.n++;
    growBranches(child, rootBearing, budgetLeft - childRibbon.length, nodeCounter);
  }
}

function buildVisibleTree(rootEdge, rootRibbon) {
  const root = { edge: rootEdge, ribbon: rootRibbon, depth: 0, tx: 0, ty: 0, cos: 1, sin: 0, children: [] };
  growBranches(root, rootEdge.bearing, MAX_PREVIEW_BUDGET, { n: 0 });
  return root;
}

function walkTree(node, visit) {
  visit(node);
  for (const child of node.children) walkTree(child, visit);
}

// ---------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------
const state = {
  mode: "intro", // intro | drive | decision | delivered | gameover
  currentNode: START_CITY,
  edge: null,
  ribbon: null,
  visibleTree: null,
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
  simTime: 0,
  trafficMaintainAcc: 0,
};

function canRefuel(city) {
  return !!city && (city.t > 0 || (city.ind && city.ind.includes("Fuel")));
}

// pickEdgesFrom now lives in geo.js so the traffic system can share it.

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
  state.visibleTree = buildVisibleTree(edge, state.ribbon);
  const [laneMin, laneMax] = laneRange(edge.kind);
  state.lane = Math.max(laneMin, Math.min(laneMax, state.lane));
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

// Ranks junction options by how major their control city is and caps the
// list. Shared by the decision panel AND the rendered branch fan-out so
// what you see on screen always matches what you can actually pick.
function rankAndCapOptions(options) {
  const ranked = [...options].sort((a, b) => (graph.nodes[b.control] ? graph.nodes[b.control].w : 0) - (graph.nodes[a.control] ? graph.nodes[a.control].w : 0));
  return ranked.slice(0, MAX_BRANCHES);
}

function presentDecision(options) {
  const shown = rankAndCapOptions(options);
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

const TRAFFIC_MAINTAIN_INTERVAL = 0.4;

function updateTraffic(dt) {
  state.simTime += dt;
  Traffic.update(dt);
  state.trafficMaintainAcc += dt;
  if (state.trafficMaintainAcc >= TRAFFIC_MAINTAIN_INTERVAL && state.visibleTree) {
    state.trafficMaintainAcc = 0;
    const edges = [];
    walkTree(state.visibleTree, (n) => edges.push(n.edge));
    window.__lastTreeChildren = edges.length;
    Traffic.maintain(edges, state.simTime);
  }
}

function update(dt) {
  updateTraffic(dt);
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
  const [laneMin, laneMax] = laneRange(state.edge.kind);
  state.lane = Math.max(laneMin, Math.min(laneMax, state.lane));

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

// projectPoint takes coordinates ALREADY relative to the truck's current
// forward reference point (see projectWorld) so the camera stays centered
// on the truck no matter how far state.s has advanced along the ribbon.
function projectPoint(dx, dy, anchorX, anchorY, zoom) {
  const hx = state.camHeading.x, hy = state.camHeading.y;
  // rotate (dx,dy) by the inverse of heading so heading maps to (0,-1) (up)
  const rightX = hy, rightY = -hx;
  const u = dx * rightX + dy * rightY;   // lateral (screen x)
  const v = dx * hx + dy * hy;           // forward distance (positive ahead)
  const persp = Math.max(0.45, Math.min(1.25, 1 - v * 0.00016));
  const sx = anchorX + u * zoom * persp;
  const sy = anchorY - v * zoom * persp * 0.72;
  return { x: sx, y: sy, scale: persp, depth: v };
}

// Takes a point in some tree node's OWN local ribbon space, stitches it
// into the root (current-edge) frame, then projects it camera-relative.
function projectWorld(node, lx, ly, cam) {
  const root = nodeToRoot(node, lx, ly);
  return projectPoint(root.x - cam.ref.x, root.y - cam.ref.y, cam.anchorX, cam.anchorY, cam.zoom);
}

function drawBackground() {
  sceneCtx.fillStyle = "#33402f";
  sceneCtx.fillRect(0, 0, W, H);
}

function roadFillColor(kind) { return kind === "interstate" ? "#585c64" : "#6b6156"; }
function roadLineColor(kind) { return kind === "interstate" ? "#ffd35c" : "#f2ead8"; }

function strokeLateralLine(node, ribbon, ss, offset, cam, width) {
  sceneCtx.lineWidth = width;
  sceneCtx.beginPath();
  for (let i = 0; i < ss.length; i++) {
    const p = ribbonLateral(ribbon, ss[i], offset);
    const proj = projectWorld(node, p.x, p.y, cam);
    if (i === 0) sceneCtx.moveTo(proj.x, proj.y); else sceneCtx.lineTo(proj.x, proj.y);
  }
  sceneCtx.stroke();
}

// Draws one tree node's road as a filled pavement polygon (offset left/right
// from the centerline by the road's real lane geometry) plus lane markings,
// instead of the old stroked-centerline approximation. `alpha` fades branch
// previews the player hasn't reached yet so the road actually being driven
// always reads as the most prominent thing on screen.
function drawRoadSegment(node, cam, sFrom, sTo) {
  const ribbon = node.ribbon, kind = node.edge.kind;
  const halfW = roadHalfWidth(kind);
  const step = 44;
  const ss = [];
  for (let s = sFrom; s < sTo; s += step) ss.push(s);
  ss.push(sTo);
  if (ss.length < 2) return;

  const leftPts = [], rightPts = [];
  for (const s of ss) {
    const lp = ribbonLateral(ribbon, s, -halfW);
    const rp = ribbonLateral(ribbon, s, halfW);
    leftPts.push(projectWorld(node, lp.x, lp.y, cam));
    rightPts.push(projectWorld(node, rp.x, rp.y, cam));
  }

  sceneCtx.fillStyle = roadFillColor(kind);
  sceneCtx.beginPath();
  sceneCtx.moveTo(leftPts[0].x, leftPts[0].y);
  for (let i = 1; i < leftPts.length; i++) sceneCtx.lineTo(leftPts[i].x, leftPts[i].y);
  for (let i = rightPts.length - 1; i >= 0; i--) sceneCtx.lineTo(rightPts[i].x, rightPts[i].y);
  sceneCtx.closePath();
  sceneCtx.fill();

  const n = laneCount(kind);
  sceneCtx.strokeStyle = "rgba(255,255,255,0.55)";
  sceneCtx.setLineDash([16, 18]);
  for (let i = 1; i < n; i++) {
    const off = MEDIAN_WIDTH[kind] / 2 + LANE_WIDTH * i;
    strokeLateralLine(node, ribbon, ss, off, cam, 2);
    strokeLateralLine(node, ribbon, ss, -off, cam, 2);
  }
  sceneCtx.setLineDash([]);

  sceneCtx.strokeStyle = roadLineColor(kind);
  if (MEDIAN_WIDTH[kind] > 0) {
    strokeLateralLine(node, ribbon, ss, MEDIAN_WIDTH[kind] / 2, cam, 2.5);
    strokeLateralLine(node, ribbon, ss, -MEDIAN_WIDTH[kind] / 2, cam, 2.5);
  } else {
    sceneCtx.setLineDash([20, 16]);
    strokeLateralLine(node, ribbon, ss, 0, cam, 2.5);
    sceneCtx.setLineDash([]);
  }
}

// Building clusters are disabled for now (per product direction, to focus
// on getting the road network + traffic flow right first) — just a node
// marker (sized a bit by the city's weight so major hubs still stand out)
// and its label. Tier-0 "Junction" filler nodes aren't real settlements,
// so they just get a small dot.
function drawCityBlock(node, lx, ly, cam, city) {
  const origin = projectWorld(node, lx, ly, cam);
  if (origin.scale < 0.35) return;

  if (city.t === 0) {
    sceneCtx.fillStyle = "rgba(255,255,255,0.5)";
    sceneCtx.beginPath();
    sceneCtx.arc(origin.x, origin.y, Math.max(1.5, 3 * origin.scale), 0, Math.PI * 2);
    sceneCtx.fill();
    return;
  }

  const radius = Math.max(2, Math.min(11, 3 + city.w * 0.6)) * origin.scale;
  sceneCtx.fillStyle = "#fff";
  sceneCtx.beginPath();
  sceneCtx.arc(origin.x, origin.y, radius, 0, Math.PI * 2);
  sceneCtx.fill();
  sceneCtx.strokeStyle = "rgba(0,0,0,0.4)";
  sceneCtx.lineWidth = 1.5;
  sceneCtx.stroke();

  sceneCtx.fillStyle = "#fff";
  sceneCtx.font = `700 ${Math.max(10, 15 * origin.scale)}px sans-serif`;
  sceneCtx.textAlign = "center";
  sceneCtx.shadowColor = "rgba(0,0,0,0.8)";
  sceneCtx.shadowBlur = 4;
  sceneCtx.fillText(city.name, origin.x, origin.y + radius + 14);
  sceneCtx.shadowBlur = 0;
}

// Every distinct city touched by the visible tree, deduped by name (a
// node's `to` city is usually the next node's `from`, so this only walks
// each junction once) plus the root's own `from` city (still visible
// behind the truck for a while after departing it).
function collectCityMarkers(tree) {
  const seen = new Map();
  seen.set(tree.edge.from, { node: tree, lx: 0, ly: 0, city: graph.nodes[tree.edge.from] });
  walkTree(tree, (node) => {
    if (!seen.has(node.edge.to)) {
      seen.set(node.edge.to, { node, lx: 0, ly: node.ribbon.length, city: graph.nodes[node.edge.to] });
    }
  });
  return [...seen.values()];
}

// Draws either a simple truck (cab + trailer) or a smaller single-body
// car, both flat-shaded, sized by the point's projected perspective scale.
function drawVehicle(screenX, screenY, scale, opts) {
  sceneCtx.save();
  sceneCtx.translate(screenX, screenY);
  if (opts.kind === "car") {
    const w = 20 * scale, h = 34 * scale;
    sceneCtx.fillStyle = opts.cab;
    sceneCtx.fillRect(-w / 2, -h / 2, w, h);
    if (opts.windshield) {
      sceneCtx.fillStyle = opts.windshield;
      sceneCtx.fillRect(-w / 2 + 3 * scale, -h * 0.12, w - 6 * scale, h * 0.32);
    }
  } else {
    const cabW = 30 * scale, cabH = 22 * scale, trailerW = 26 * scale, trailerH = 50 * scale;
    sceneCtx.fillStyle = opts.trailer;
    sceneCtx.fillRect(-trailerW / 2, -8 * scale, trailerW, trailerH);
    if (opts.trailerAccent) {
      sceneCtx.fillStyle = opts.trailerAccent;
      sceneCtx.fillRect(-trailerW / 2 + 3 * scale, -4 * scale, trailerW - 6 * scale, trailerH - 10 * scale);
    }
    sceneCtx.fillStyle = opts.cab;
    sceneCtx.fillRect(-cabW / 2, -trailerH * 0.55, cabW, cabH);
    if (opts.windshield) {
      sceneCtx.fillStyle = opts.windshield;
      sceneCtx.fillRect(-cabW / 2 + 4 * scale, -trailerH * 0.55 + 4 * scale, cabW - 8 * scale, 8 * scale);
    }
  }
  sceneCtx.restore();
}

const PLAYER_COLORS = { kind: "truck", trailer: "#c1272d", trailerAccent: "#eef1f5", cab: "#22252a", windshield: "#9fd3ff" };
const AI_TRUCK_PALETTES = [
  { trailer: "#3a6ea5", trailerAccent: "#dfe8f2", cab: "#22252a", windshield: "#bcd9ff" },
  { trailer: "#8a8f96", trailerAccent: "#eceff1", cab: "#2a2d31", windshield: "#bcd9ff" },
  { trailer: "#4c7a4c", trailerAccent: "#e4efe0", cab: "#22252a", windshield: "#bcd9ff" },
];
const AI_CAR_PALETTES = [
  { cab: "#b0392f", windshield: "#cfd8dc" },
  { cab: "#2f3b52", windshield: "#cfd8dc" },
  { cab: "#c9a227", windshield: "#cfd8dc" },
  { cab: "#5b5f66", windshield: "#cfd8dc" },
];
function aiPalette(v) {
  const list = v.kind === "car" ? AI_CAR_PALETTES : AI_TRUCK_PALETTES;
  return list[Math.floor(v.paletteSeed * list.length) % list.length];
}

// Player + every AI vehicle whose edge is currently part of the visible
// tree (directly, or as the exact reverse edge — oncoming traffic reuses
// the same shared ribbon geometry, mirrored; see the empirically-verified
// note on ribbonLateral/edge-reversal in geo.js). Vehicles on edges that
// have scrolled out of view are simply skipped for this frame.
function collectVehicleDrawables(cam) {
  const edgeNodeMap = new Map();
  walkTree(state.visibleTree, (n) => edgeNodeMap.set(edgeId(n.edge), n));

  const drawables = [];

  const pp = ribbonLateral(state.ribbon, state.s, state.lane);
  const pProj = projectWorld(state.visibleTree, pp.x, pp.y, cam);
  drawables.push({ proj: pProj, opts: PLAYER_COLORS });

  for (const v of Traffic.getVehicles()) {
    let node = edgeNodeMap.get(edgeId(v.edge));
    let mirrored = false;
    if (!node) {
      node = edgeNodeMap.get(v.edge.to + "|" + v.edge.from + "|" + v.edge.route);
      mirrored = true;
    }
    if (!node) continue;
    const p = ribbonLateral(v.ribbon, v.s, ownLaneX(v.edge.kind, v.lane));
    const proj = projectWorld(node, mirrored ? -p.x : p.x, p.y, cam);
    if (proj.scale < 0.25) continue;
    drawables.push({ proj, opts: { kind: v.kind, ...aiPalette(v) } });
  }

  return drawables;
}

function renderScene() {
  drawBackground();
  if (!state.edge || !state.ribbon || !state.visibleTree) return;
  const cam = {
    anchorX: W / 2, anchorY: H * 0.7,
    zoom: 0.46 * (W / 900),
    ref: ribbonSample(state.ribbon, state.s),
  };

  const treeNodes = [];
  walkTree(state.visibleTree, (n) => treeNodes.push(n));
  treeNodes.sort((a, b) => b.depth - a.depth); // deepest/farthest first, root drawn last (on top)

  for (const node of treeNodes) {
    // No per-depth fade: the road network should read as one continuous
    // system through junctions, not a set of disconnected previews.
    const sFrom = node.depth === 0 ? Math.max(0, state.s - 700) : 0;
    drawRoadSegment(node, cam, sFrom, node.ribbon.length);
  }

  for (const marker of collectCityMarkers(state.visibleTree)) {
    drawCityBlock(marker.node, marker.lx, marker.ly, cam, marker.city);
  }

  const vehicles = collectVehicleDrawables(cam);
  vehicles.sort((a, b) => b.proj.depth - a.proj.depth); // far first, near last
  for (const v of vehicles) {
    drawVehicle(v.proj.x, v.proj.y, Math.max(0.35, v.proj.scale), v.opts);
  }
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
