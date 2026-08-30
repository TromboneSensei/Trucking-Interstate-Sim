// fleet.js - autonomous trucks. Every truck gets a full A* route the
// moment it accepts a contract and just walks it, arrival to arrival,
// forever - no per-frame decisions, nothing to pause, unless it's the
// one truck the player has taken control of AND it reaches a node with
// more than one real route choice. That's the only place this
// simulation ever needs external input.
//
// On interstate edges, trucks also carry lightweight lane/traffic state
// (see the "lane physics" section below): which of the two lanes
// they're in, whether they're mid-pass, and whether they're stopped at
// a city waiting for a gap to pull out into. Highway-kind edges skip
// all of that and behave like before (single file, straight through).
import { pickEdgesFrom, findPath, edgeId } from "./geo.js";
import { generateContract } from "./economy.js";
import { DriverDNA } from "./driver.js";
import { TRUCK_DOT_RADIUS, LEFT_LANE_OFFSET, RIGHT_LANE_OFFSET } from "./render.js";

// Game-seconds of simulated time per real second at 1.0x speed. Tuned so
// a cross-country haul takes on the order of a minute of real time to
// watch play out at 1x, rather than being instant or glacial.
export const BASE_TIME_SCALE = 2400;
const MAX_DECISION_OPTIONS = 4;

// --- lane / traffic tunables (starting guesses, tuned visually) ---
//
// Gap thresholds that exist to prevent two truck dots from visually
// overlapping are computed per-edge from TRUCK_DOT_RADIUS (see
// minSafeMiles below) rather than given as flat mile constants. At this
// map's projection scale - the continental US drawn across a 4000x2400
// world space - a realistic few-car-lengths following distance is a
// tiny fraction of a mile, far smaller than the world-space distance
// needed to keep two 5-unit-radius dots apart. The dots are a
// deliberately exaggerated stand-in for a real truck's size, so the
// anti-overlap math has to be anchored to the render scale, not real
// truck dimensions - which is why these read as large mile values below
// even though on screen they land as a normal-looking gap.
const MIN_DOT_GAP_WORLD_UNITS = 2 * TRUCK_DOT_RADIUS + 4; // a bit more than "just touching" - same-lane trucks always use this, never relaxed
// render.js deliberately sets the two lanes' offsets closer together
// than MIN_DOT_GAP_WORLD_UNITS - a little visual overlap between a
// truck and one directly beside it in the other lane reads as normal
// lane-adjacent traffic, not a bug. This is that same steady-state gap,
// used as the "good enough, no along-edge cushion needed" threshold for
// cross-lane pairs specifically (see clampOverlaps/placeOnEdge) - a
// truck still mid-lane-change (its rendered offset partway between the
// two lanes, not yet at this full separation) still gets some
// along-edge protection via the Pythagorean shortfall below it.
const CROSS_LANE_TARGET_WORLD_UNITS = RIGHT_LANE_OFFSET - LEFT_LANE_OFFSET;
const FOLLOW_TIME_GAP_S = 2.5; // extra following distance on top of the anti-overlap floor, grows with speed
const PASS_CLEAR_AHEAD_MULT = 2; // multiples of minSafeMiles for a comfortable passing gap
const PASS_CLEAR_BEHIND_MULT = 1.5;
const MERGE_BACK_CLEAR_MULT = 1.5;
const PASS_AGGRESSION_THRESHOLD = 0.4; // only drivers at least this aggressive attempt a pass
const FOLLOW_TRIGGER_MULT = 1.4; // start capping speed at this multiple of the anti-overlap floor, before it's actually urgent
const EMERGENCY_BRAKE_MULT = 1.15; // hard speed clamp once the gap shrinks inside this multiple of the floor
const PASS_CONSIDER_MULT = 3; // decide to change lanes this much earlier than the speed cap, so the visual lane-blend has room to complete
const MAX_DEPARTURE_WAIT_REAL_S = 3; // defensive timeout so a truck can never stall forever
const LANE_CHANGE_EASE = 2.0; // dt-multiplier for the visual lane-blend, same shape as speed easing
const ARRIVAL_DECEL_BASE_MI = 0.5; // physically-plausible braking distance, unrelated to dot size
const ARRIVAL_DECEL_PER_MPH = 0.06; // decel zone scales with the edge's speed limit
const ARRIVAL_MIN_MPH = 12;

// World-space length of an edge divided by its real mileage - varies
// slightly edge to edge (geographic projection), so gap thresholds
// derived from it are computed per-edge rather than with one global
// ratio.
function worldUnitsPerMile(graph, edge) {
  const a = graph.nodes[edge.from], b = graph.nodes[edge.to];
  return Math.hypot(b.x - a.x, b.y - a.y) / edge.miles;
}

// The `s` (mile) gap on this specific edge equivalent to
// MIN_DOT_GAP_WORLD_UNITS of on-screen separation - the floor every
// following/passing/departure gap check builds on.
function minSafeMiles(graph, edge) {
  return MIN_DOT_GAP_WORLD_UNITS / worldUnitsPerMile(graph, edge);
}

const NICKNAMES = [
  "Rubber Ducky", "Iron Duck", "Mad Max", "Big Rig", "Rolling Thunder", "Night Owl",
  "Highway Star", "Lone Wolf", "White Line", "Overdrive", "Blacktop Runner", "Steel Horse",
  "Convoy King", "Hammer Down", "Ten-Four", "Double Nickel", "Rusty Bucket", "Silver Bullet",
  "Red Rocket", "Ghost Hauler", "Pathfinder", "Trailblazer", "Nomad", "Drifter",
  "Texas Tornado", "Yankee Clipper", "Desert Rat", "Cornhusker", "Bayou Beast", "Windy City",
  "Old Betsy", "Thunder Road", "Midnight Rider", "Grave Digger", "Asphalt Cowboy", "Gear Jammer",
];

let nextId = 1;
function randomName(rnd) {
  const base = NICKNAMES[Math.floor(rnd() * NICKNAMES.length)];
  const n = nextId;
  return n > NICKNAMES.length ? `${base} ${Math.ceil(n / NICKNAMES.length)}` : base;
}

export class Truck {
  constructor(graph, spawnCityName, rnd = Math.random) {
    this.id = nextId++;
    this.name = randomName(rnd);
    this.driver = new DriverDNA(rnd);
    this.currentNode = spawnCityName;
    this.edge = null;
    this.s = 0; // miles traveled along the current edge
    this.speed = 0; // current mph, eases toward the edge's limit
    this.totalMilesDriven = 0;
    this.earnings = 0;
    this.contractsCompleted = 0;
    this.awaitingDecision = false;
    this.pendingOptions = null;
    this.contract = null;
    this.remainingPath = [];

    // Lane physics state (interstate edges only; meaningless/unused on
    // highway edges, left at defaults there).
    this.lane = 0; // 0 = right/default lane, 1 = left/passing lane (target)
    this.laneT = 0; // 0..1 eased visual blend toward `lane`, drives the render offset
    this.passingLeaderId = null; // id of the truck currently being overtaken, or null
    this.pendingEdge = null; // set while stopped at a real city waiting for a gap to depart
    this.departureWaitS = 0; // real seconds spent waiting on pendingEdge

    this._assignContract(graph, rnd);
  }

  _assignContract(graph, rnd, laneGroups) {
    // generateContract's destination pick already filters out unreachable
    // nodes, but retry defensively in case a future data/graph edge case
    // still produces one, rather than crash the whole fleet.
    let contract, attempts = 0;
    do {
      contract = generateContract(graph, this.currentNode, rnd);
      attempts++;
    } while (!contract.path && attempts < 8);

    this.contract = contract;
    this.remainingPath = contract.path ? [...contract.path] : [];
    if (this.remainingPath.length) this._advanceToNextEdge(graph, laneGroups, true);
    else { this.edge = null; this.pendingEdge = null; } // truly stranded; will just sit idle rather than crash
  }

  // Moves to the next queued edge. The full stop-and-wait-for-a-gap
  // treatment (see tryDepartTruck in updateFleet) only applies when this
  // is the start of a brand-new contract's route AND the node being LEFT
  // is a real city (not a tier-0 highway-interchange filler node) -
  // i.e. an actual delivery pickup, not just a waypoint the route happens
  // to route through. A truck passing through a real city mid-route
  // (this edge is just the next leg of an already-underway haul) carries
  // straight through at full speed and in whatever lane it was already
  // in instead - same as a tier-0 junction always has (see
  // arrivalSpeedCap, which only decelerates a truck's actual final leg,
  // and placeOnEdge, which no longer resets lane/laneT itself) - real
  // continuity through the node, not just "no hard stop". It still needs
  // `placeOnEdge`'s conflict nudge either way (`laneGroups` may be
  // undefined only when spawning a fresh truck, which always starts at a
  // real city and never reaches this branch).
  _advanceToNextEdge(graph, laneGroups, isNewContractStart = false) {
    const next = this.remainingPath.shift();
    if (isNewContractStart && graph.nodes[next.from].t > 0) {
      this.edge = null;
      this.pendingEdge = next;
      this.speed = 0;
      this.lane = 0;
      this.laneT = 0;
      this.passingLeaderId = null;
      this.departureWaitS = 0;
    } else {
      placeOnEdge(graph, this, next, laneGroups);
    }
  }

  _arriveAtDestination(graph, laneGroups) {
    this.earnings += this.contract.payout;
    this.contractsCompleted++;
    this.currentNode = this.contract.destination;
    this.edge = null;
    this._assignContract(graph, Math.random, laneGroups);
  }

  // Player picked `chosenEdge` at a paused junction; commit to it and
  // re-route the rest of the trip from there so the job still finishes.
  // This is a deliberate, already-paused human choice, not a routine
  // automated transition, so unlike _advanceToNextEdge it places the
  // truck instantly with no departure-gap check.
  resolveDecision(graph, chosenEdge) {
    this.edge = chosenEdge;
    this.s = 0;
    this.lane = 0;
    this.laneT = 0;
    this.passingLeaderId = null;
    this.awaitingDecision = false;
    this.pendingOptions = null;
    this.remainingPath = chosenEdge.to === this.contract.destination
      ? []
      : (findPath(graph, chosenEdge.to, this.contract.destination) || []);
  }
}

function rankAndCapOptions(graph, options) {
  const ranked = [...options].sort((a, b) => (graph.nodes[b.control]?.w || 0) - (graph.nodes[a.control]?.w || 0));
  return ranked.slice(0, MAX_DECISION_OPTIONS);
}

export function spawnFleet(graph, count, rnd = Math.random) {
  const cities = Object.values(graph.nodes).filter((n) => n.t > 0 && n.t <= 3);
  const trucks = [];
  for (let i = 0; i < count; i++) {
    const city = cities[Math.floor(rnd() * cities.length)];
    trucks.push(new Truck(graph, city.name, rnd));
  }
  return trucks;
}

// --- lane physics helpers -------------------------------------------

// Groups currently-driving trucks (pendingEdge/stranded trucks have no
// `edge` and are excluded) by directed edge and lane, sorted ascending
// by progress along the edge. Rebuilt fresh every updateFleet tick from
// that tick's pre-move snapshot, so decisions are deterministic and
// never see another truck's already-updated-this-tick position. Cheap
// at this fleet size (~150 trucks over hundreds of directed edges, most
// groups holding 0-2 trucks) - the seam to revisit if the fleet ever
// scales into the thousands is here: swap this per-tick rebuild for a
// persistent per-edge/lane structure incrementally updated as trucks
// cross thresholds, rather than reworking anything above it.
function buildLaneGroups(trucks) {
  const groups = new Map();
  for (const truck of trucks) {
    if (!truck.edge) continue;
    const key = edgeId(truck.edge);
    let g = groups.get(key);
    if (!g) { g = { lane0: [], lane1: [] }; groups.set(key, g); }
    (truck.lane === 1 ? g.lane1 : g.lane0).push(truck);
  }
  for (const g of groups.values()) {
    g.lane0.sort((a, b) => a.s - b.s);
    g.lane1.sort((a, b) => a.s - b.s);
  }
  return groups;
}

// Speed cap for a truck approaching a real city (tier > 0) at the end of
// its current edge - Infinity (no cap) for a tier-0 junction pass-through,
// a mid-route real-city waypoint the route just happens to run through
// (remainingPath still has hops left after this edge - i.e. this edge's
// `to` isn't actually truck.contract.destination), or while still
// outside the decel zone. Only the truck's genuine final leg slows down;
// everything else carries straight through at cruise speed.
function arrivalSpeedCap(graph, truck, cruiseTargetSpeed) {
  if (truck.remainingPath.length > 0) return Infinity;
  const toNode = graph.nodes[truck.edge.to];
  if (toNode.t === 0) return Infinity;
  const zone = ARRIVAL_DECEL_BASE_MI + truck.edge.speedLimit * ARRIVAL_DECEL_PER_MPH;
  const remaining = truck.edge.miles - truck.s;
  if (remaining >= zone) return Infinity;
  const frac = Math.max(0, remaining / zone);
  return ARRIVAL_MIN_MPH + (cruiseTargetSpeed - ARRIVAL_MIN_MPH) * frac;
}

// Car-following + passing, interstate edges only. Reads/mutates the
// truck's lane state and returns an additional speed cap (Infinity if
// nothing ahead is a factor).
function applyFollowAndPassing(graph, truck, laneGroups, cruiseTargetSpeed) {
  if (truck.edge.kind !== "interstate") return Infinity;
  const group = laneGroups.get(edgeId(truck.edge));
  if (!group) return Infinity;

  const ownArr = truck.lane === 1 ? group.lane1 : group.lane0;
  const idx = ownArr.indexOf(truck);
  const leader = idx >= 0 && idx + 1 < ownArr.length ? ownArr[idx + 1] : null;

  const safeMi = minSafeMiles(graph, truck.edge);
  const gapToLeader = leader ? leader.s - truck.s : Infinity;
  const timeGap = (truck.speed * FOLLOW_TIME_GAP_S) / 3600;
  const blocked = gapToLeader < safeMi * FOLLOW_TRIGGER_MULT + timeGap;
  const followCap = blocked ? Math.min(cruiseTargetSpeed, leader.speed) : Infinity;

  // Emergency hard clamp: the trigger margin above is meant to start
  // slowing a truck well before this, but speed only EASES toward a
  // capped target rather than snapping to it, so a truck closing fast
  // can still dip toward the true anti-overlap floor for a tick or two
  // before easing catches up. If the gap has already shrunk into that
  // zone, cut speed immediately instead of waiting on the normal ease.
  if (leader && gapToLeader <= safeMi * EMERGENCY_BRAKE_MULT) {
    truck.speed = Math.min(truck.speed, leader.speed * 0.85);
  }

  // Passing is considered on a much earlier, looser trigger than the
  // speed cap above - not "blocked", which by definition means the gap
  // is already tight. Deciding to change lanes only once already
  // tailgating left no room for the visual lane-blend (laneT easing
  // from 0 toward 1) to widen the truck's lateral offset before the
  // along-edge gap could close further, so a pass could begin from a
  // dot-diameter's width away with almost no lateral separation yet -
  // exactly the moment separation is smallest. Starting the maneuver
  // while there's still real room (a real driver decides to pass well
  // before tailgating) keeps that transition comfortably clear.
  const wantsToPass = !!leader && gapToLeader < safeMi * PASS_CONSIDER_MULT + timeGap;
  const inArrivalZone = arrivalSpeedCap(graph, truck, cruiseTargetSpeed) < cruiseTargetSpeed;
  if (truck.lane === 0 && wantsToPass && !inArrivalZone && truck.driver.aggression > PASS_AGGRESSION_THRESHOLD) {
    const leftArr = group.lane1;
    const clear = !leftArr.some((t) => t.s > truck.s - safeMi * PASS_CLEAR_BEHIND_MULT && t.s < leader.s + safeMi * PASS_CLEAR_AHEAD_MULT);
    if (clear) {
      truck.lane = 1;
      truck.passingLeaderId = leader.id;
    }
  } else if (truck.lane === 1 && truck.passingLeaderId != null) {
    // Merge back once clear of the truck being passed (or it's gone -
    // arrived, took a different edge, whatever) and lane 0 is clear alongside.
    const passed = group.lane0.find((t) => t.id === truck.passingLeaderId);
    const clearOfPassed = !passed || (truck.s - passed.s) > safeMi * MERGE_BACK_CLEAR_MULT;
    if (clearOfPassed) {
      const lane0Clear = !group.lane0.some((t) => t.s > truck.s - safeMi * PASS_CLEAR_BEHIND_MULT && t.s < truck.s + safeMi * PASS_CLEAR_AHEAD_MULT);
      if (lane0Clear) { truck.lane = 0; truck.passingLeaderId = null; }
    }
  }

  return followCap;
}

// A truck stopped at a real city, waiting for room to pull into the
// destination edge's right lane. Departs once clear, or once the
// defensive timeout elapses - either way it enters at s=0/speed=0, so
// the normal accel easing on the next tick is what gives it the
// "accelerate away from the city" look, with no extra mechanism needed.
//
// A waiting truck has no `edge` yet, so buildLaneGroups' pre-tick
// snapshot never included it - meaning two trucks queued to depart onto
// the SAME edge from the same city wouldn't see each other and could
// both land at s=0 in the same tick. `placeOnEdge` registering a truck
// into the lane group the instant it enters (not just at the top of the
// next tick) closes that: any other truck processed later this same
// tick sees it and correctly waits/nudges instead.
function tryDepartTruck(graph, truck, laneGroups, dt) {
  const key = edgeId(truck.pendingEdge);
  const lane0 = laneGroups.get(key)?.lane0 || [];
  const safeMi = minSafeMiles(graph, truck.pendingEdge);
  const blocked = truck.pendingEdge.kind === "interstate" && lane0.some((t) => t.s < safeMi);

  truck.departureWaitS += dt;
  if (!blocked || truck.departureWaitS > MAX_DEPARTURE_WAIT_REAL_S) {
    placeOnEdge(graph, truck, truck.pendingEdge, laneGroups);
  }
}

// Places a truck onto `edge` at s=0 and registers it into this tick's
// lane groups so any other truck placed onto the same edge later in the
// same tick sees it. `truck.lane`/`laneT` are left exactly as the caller
// set them: a fresh departure from a full stop already has them reset to
// 0 by the time this runs (see tryDepartTruck), while a truck merely
// continuing through a junction or a mid-route city keeps whatever lane
// it was already in - it stays in the passing lane straight through the
// node rather than snapping back to the right lane, matching a truck
// it's mid-pass on doing the same. If something's already sitting nearby
// (two or more trucks converging through the same junction onto the same
// next edge in the same tick, the one unprotected case a stop-and-wait
// deliberately doesn't cover - junctions aren't real stops), nudge in
// just behind it instead of landing exactly on top of it - checking BOTH
// lanes (a truck can enter right next to a lane-1 occupant that's still
// mid-lane-change, not yet far enough over to be laterally clear on its
// own) and chaining past a whole run of them: checking only the single
// nearest occupant isn't enough once a third truck can arrive the same
// tick and need to clear the truck the *second* one was just nudged
// behind, not the original.
function placeOnEdge(graph, truck, edge, laneGroups) {
  truck.edge = edge;
  truck.pendingEdge = null;
  const key = edgeId(edge);
  let group = laneGroups ? laneGroups.get(key) : null;
  const unitsPerMile = worldUnitsPerMile(graph, edge);
  const myOffset = laneOffset(truck);
  let s = 0;
  if (group) {
    const occupants = [...group.lane0, ...group.lane1].sort((a, b) => a.s - b.s);
    for (const t of occupants) {
      const target = t.lane === truck.lane ? MIN_DOT_GAP_WORLD_UNITS : CROSS_LANE_TARGET_WORLD_UNITS;
      const perpGap = Math.abs(laneOffset(t) - myOffset);
      if (perpGap >= target) continue; // laterally clear regardless of s
      const neededWorldGap = Math.sqrt(target ** 2 - perpGap ** 2);
      const neededMiles = Math.min(neededWorldGap / unitsPerMile, edge.miles);
      if (Math.abs(t.s - s) < neededMiles) s = t.s + neededMiles;
    }
    if (s > edge.miles && group) {
      // Chaining forward past a long run of occupants ran out of edge
      // before it ran out of trucks to clear. Simply clamping every such
      // truck to the same edge.miles boundary would just recreate an
      // exact tie one step removed (each one's chain sees the previous
      // truck sitting at that same collapsed point and overflows past it
      // again) - pack backward from the end instead, so a crowded edge
      // degrades to "tighter than ideal" rather than "literally on top
      // of each other".
      s = edge.miles;
      const byDistance = [...group.lane0, ...group.lane1].sort((a, b) => b.s - a.s);
      for (const t of byDistance) {
        if (t.s < s) break; // already comfortably behind this candidate slot
        const target = t.lane === truck.lane ? MIN_DOT_GAP_WORLD_UNITS : CROSS_LANE_TARGET_WORLD_UNITS;
        const perpGap = Math.abs(laneOffset(t) - myOffset);
        if (perpGap >= target) continue;
        const neededWorldGap = Math.sqrt(target ** 2 - perpGap ** 2);
        const neededMiles = Math.min(neededWorldGap / unitsPerMile, edge.miles);
        if (t.s - s < neededMiles) s = Math.max(0, t.s - neededMiles);
      }
    }
  }
  // Clamp the final result to this edge's own length no matter which
  // pass produced it, so a truck can never be placed beyond where it's
  // already due to arrive. (If that leaves it packed in tighter than
  // ideal, that's the same "edge too short to fully
  // separate everyone on it" tradeoff documented on minSafeMiles.)
  truck.s = Math.min(s, edge.miles);
  if (laneGroups) {
    if (!group) { group = { lane0: [], lane1: [] }; laneGroups.set(key, group); }
    const arr = truck.lane === 1 ? group.lane1 : group.lane0;
    arr.push(truck);
    arr.sort((a, b) => a.s - b.s); // keep the ascending-by-progress invariant intact for this tick's remaining lookups
  }
}

// Mirrors render.js's truckWorldPos lane-blend exactly: a truck mid-way
// through a lane change (0 < laneT < 1) sits only partway toward the
// passing lane's full separation from lane 0.
function laneOffset(truck) {
  return RIGHT_LANE_OFFSET + (LEFT_LANE_OFFSET - RIGHT_LANE_OFFSET) * truck.laneT;
}

// After every truck has moved this tick, two trucks can still end up too
// close: car-following/passing above only reacts to *last* tick's other
// trucks, so a leader braking hard (its own arrival-decel, using a
// decelRate up to 5.2) can lose speed faster within a single tick than a
// one-tick-lagged follower can track - and a truck early in a lane
// change (laneT still near 0) hasn't yet gained the passing lane's full
// lateral separation, so a fresh departure landing nearby in the other
// lane can still end up closer than it looks from `s` alone. Rather
// than chase either case with ever-tighter speed/timing heuristics,
// this clamps positions directly after integration using each truck's
// TRUE rendered offset (same formula as truckWorldPos) and the real
// Pythagorean distance - front-to-back per edge, each truck capped to
// whatever along-edge gap is still needed once its actual lateral
// separation from the truck ahead is accounted for. This guarantees the
// render-time gap regardless of how the speed/lane decisions played
// out. A truck clamped back below its edge's length simply arrives a
// tick later than it otherwise would (a realistic "stuck behind stopped
// traffic" outcome).
function clampOverlaps(graph, trucks) {
  const groups = new Map();
  for (const truck of trucks) {
    if (!truck.edge || truck.edge.kind !== "interstate") continue;
    const key = edgeId(truck.edge);
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(truck);
  }
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => b.s - a.s); // front of the line first
    const unitsPerMile = worldUnitsPerMile(graph, arr[0].edge);
    for (let i = 1; i < arr.length; i++) {
      const ahead = arr[i - 1], behind = arr[i];
      const target = ahead.lane === behind.lane ? MIN_DOT_GAP_WORLD_UNITS : CROSS_LANE_TARGET_WORLD_UNITS;
      const perpGap = Math.abs(laneOffset(ahead) - laneOffset(behind));
      if (perpGap >= target) continue; // laterally clear regardless of along-edge gap
      const neededWorldGap = Math.sqrt(target ** 2 - perpGap ** 2);
      const neededMiles = Math.min(neededWorldGap / unitsPerMile, ahead.edge.miles);
      const maxAllowed = ahead.s - neededMiles;
      // Each pairwise push is capped to the edge's own length, but (as in
      // placeOnEdge) that only bounds one step, not a chain of several -
      // clamp the final result too so a reduction can never itself leave
      // a truck's s negative-then-wrapped or otherwise inconsistent.
      if (behind.s > maxAllowed) behind.s = Math.max(0, Math.min(maxAllowed, ahead.edge.miles));
    }
  }
}

// Advances every truck by `dt` real seconds at the given time-scale
// multiplier. Returns the truck awaiting a junction decision, if any
// (only possible for `controlledTruck` - the one truck the player has
// explicitly taken control of via the details panel, a separate,
// narrower thing than merely being followed by the camera), so the
// caller can pause the whole sim and show the decision panel.
export function updateFleet(graph, trucks, dt, timeScale, controlledTruck) {
  const gameHours = (dt * BASE_TIME_SCALE * timeScale) / 3600;
  const laneGroups = buildLaneGroups(trucks);

  // Phase 1: decide each truck's target speed/lane and ease toward it -
  // reads other trucks' pre-move positions (laneGroups), same as before.
  for (const truck of trucks) {
    if (truck.awaitingDecision || truck.pendingEdge || !truck.edge) continue;

    let targetSpeed = truck.edge.speedLimit * truck.driver.cruiseMult;
    targetSpeed = Math.min(targetSpeed, arrivalSpeedCap(graph, truck, targetSpeed));
    targetSpeed = Math.min(targetSpeed, applyFollowAndPassing(graph, truck, laneGroups, targetSpeed));

    const rate = targetSpeed >= truck.speed ? truck.driver.accelRate : truck.driver.decelRate;
    truck.speed += (targetSpeed - truck.speed) * Math.min(1, dt * rate);
    truck.laneT += (truck.lane - truck.laneT) * Math.min(1, dt * LANE_CHANGE_EASE);
  }

  // Phase 2: integrate position from the speed each truck just settled on.
  for (const truck of trucks) {
    if (truck.awaitingDecision || truck.pendingEdge || !truck.edge) continue;
    const miles = truck.speed * gameHours;
    truck.s += miles;
    truck.totalMilesDriven += miles;
  }

  // Phase 3: hard anti-overlap clamp on the post-move positions (see
  // clampOverlaps above for why this can't just be folded into phase 1).
  clampOverlaps(graph, trucks);

  // Phase 4: arrivals, junction decisions, and departures, using the
  // final (clamped) positions - unchanged from before this restructuring.
  for (const truck of trucks) {
    if (truck.awaitingDecision) continue;

    if (truck.pendingEdge) {
      tryDepartTruck(graph, truck, laneGroups, dt);
      continue;
    }
    if (!truck.edge) continue; // truly stranded
    if (truck.s < truck.edge.miles) continue;

    const node = truck.edge.to;
    truck.currentNode = node;
    if (node === truck.contract.destination) {
      truck._arriveAtDestination(graph, laneGroups);
      continue;
    }

    if (truck === controlledTruck) {
      const options = pickEdgesFrom(graph, node, truck.edge);
      if (options.length > 1) {
        truck.pendingOptions = rankAndCapOptions(graph, options);
        truck.awaitingDecision = true;
        return truck;
      }
    }
    truck._advanceToNextEdge(graph, laneGroups);
  }
  return null;
}
