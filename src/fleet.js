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
import { pickEdgesFrom, findPath, edgeId, localMinutesAtX } from "./geo.js";
import { generateContract, generateContractOffers, chooseOffer } from "./economy.js";
import { DriverDNA } from "./driver.js";
import { TRUCK_DOT_RADIUS, LEFT_LANE_OFFSET, RIGHT_LANE_OFFSET } from "./render.js";
import { weatherSpeedMultAt } from "./weather.js";

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
const MIN_DOT_GAP_WORLD_UNITS = 2 * TRUCK_DOT_RADIUS + 1; // just a hair more than touching - required gap when two trucks are in the same visual lane, tight enough that a jam still reads as "bunched up" rather than a generous gap
// render.js deliberately sets the two lanes' offsets closer together
// than MIN_DOT_GAP_WORLD_UNITS - a little visual overlap between a
// truck and one directly beside it in the other lane reads as normal
// lane-adjacent traffic, not a bug. This is that same steady-state gap,
// the required along-edge cushion once two trucks are fully settled in
// different lanes. crossLaneTarget() below interpolates between this and
// MIN_DOT_GAP_WORLD_UNITS continuously as laneT changes, so a truck mid-
// lane-change never gets more clearance credit than its actual lateral
// separation has earned yet (see clampOverlaps/placeOnEdge).
const CROSS_LANE_TARGET_WORLD_UNITS = RIGHT_LANE_OFFSET - LEFT_LANE_OFFSET;
const FOLLOW_TIME_GAP_S = 1.1; // extra following distance on top of the anti-overlap floor, grows with speed - tight but not bumper-to-bumper
const PASS_CLEAR_AHEAD_MULT = 2; // multiples of minSafeMiles for a comfortable passing gap
const PASS_CLEAR_BEHIND_MULT = 1.5;
const MERGE_BACK_CLEAR_MULT = 1.5;
const PASS_AGGRESSION_THRESHOLD = 0.4; // only drivers at least this aggressive attempt a pass
const FOLLOW_TRIGGER_MULT = 1.15; // start capping speed at this multiple of the anti-overlap floor, before it's actually urgent
const EMERGENCY_BRAKE_MULT = 1.05; // hard speed clamp once the gap shrinks inside this multiple of the floor
const PASS_CONSIDER_MULT = 3; // decide to change lanes this much earlier than the speed cap, so the visual lane-blend has room to complete
const MAX_DEPARTURE_WAIT_REAL_S = 3; // defensive timeout so a truck can never stall forever
const LANE_CHANGE_EASE = 2.0; // dt-multiplier for the visual lane-blend, same shape as speed easing
const ARRIVAL_DECEL_BASE_MI = 0.5; // physically-plausible braking distance, unrelated to dot size
const ARRIVAL_DECEL_PER_MPH = 0.06; // decel zone scales with the edge's speed limit
const ARRIVAL_MIN_MPH = 12;

// --- post-delivery layover ---------------------------------------------
// A truck that has just delivered sits at the city before taking its next
// load: unloading, paperwork, the driver's rest break. Expressed in GAME
// hours, so it scales with the time slider like everything else.
//
// Which end of the range a driver lands on is their hustle: a high-hustle
// driver turns around in about DWELL_MIN_HOURS, a low-hustle one takes
// most of DWELL_MAX_HOURS. The jitter keeps two equally-hustling drivers
// from moving in lockstep.
const DWELL_MIN_HOURS = 2;
const DWELL_MAX_HOURS = 12;
const DWELL_JITTER_HOURS = 1.5;

export function rollDwellHours(driver, rnd = Math.random) {
  const span = DWELL_MAX_HOURS - DWELL_MIN_HOURS;
  const base = DWELL_MAX_HOURS - span * driver.hustle;
  const jitter = (rnd() - 0.5) * 2 * DWELL_JITTER_HOURS;
  return Math.max(DWELL_MIN_HOURS, Math.min(DWELL_MAX_HOURS, base + jitter));
}

// --- fuel -----------------------------------------------------------------
const FUEL_BURN_PER_MILE = 0.066; // base burn (0-100 fuel scale) per mile at fuelBurnMult=1, no drag
const FUEL_DRAG_SPEED_MPH = 65; // above this cruise speed, aerodynamic drag starts costing extra fuel
const FUEL_LOW_THRESHOLD = 15; // stop and refuel at or below this
const FUEL_PRICE_PER_UNIT = 3.5; // $ per fuel unit refilled
const FUEL_STOP_HOURS = 1.0; // game hours spent refueling at a node
const FUEL_TOW_COST = 750; // $ penalty for running dry mid-edge
const FUEL_DISABLED_SERVICE_MIN_HOURS = 1;
const FUEL_DISABLED_SERVICE_MAX_HOURS = 3;
const FUEL_REFILL_MARGIN = 1.15; // refuel to cover the next leg with this much headroom, not just to a flat 100

// --- fatigue / circadian rest ----------------------------------------------
const FATIGUE_PER_HOUR = 6.0;
const FATIGUE_REST_THRESHOLD = 50;
const REST_MIN_HOURS = 4.0;
const REST_MAX_HOURS = 6.0;
const STANDARD_SLEEP_START_MIN = 21 * 60; // 21:00 local
const STANDARD_SLEEP_END_MIN = 3 * 60;    // 03:00 local (wraps midnight)
const NIGHT_OWL_SLEEP_START_MIN = 9 * 60;  // 09:00 local
const NIGHT_OWL_SLEEP_END_MIN = 15 * 60;   // 15:00 local

// --- breakdowns -------------------------------------------------------------
// Calibrated (see routing_ab-style soak test) to hold roughly one
// concurrently-disabled truck per 1000 in the fleet, given a ~13.5-hour
// mean repair and drivers no longer spending 100% of their time driving
// (they now also layover, rest, and refuel).
const BREAKDOWN_PER_MILE = 1.0e-6;
const BREAKDOWN_REPAIR_MIN_HOURS = 3;
const BREAKDOWN_REPAIR_MAX_HOURS = 24;
const BREAKDOWN_MILES_SINCE_STOP_SCALE = 1500;

// --- rubbernecking -----------------------------------------------------------
const RUBBERNECK_RANGE_SAFE_MULT = 4; // approach zone, in multiples of minSafeMiles (anchors the zone to the render scale, not an absolute mile count - see minSafeMiles)
const RUBBERNECK_WORST_MULT = 0.45; // cruise-speed multiplier right alongside a disabled truck

// How many loads a parked truck gets to choose between.
const OFFER_COUNT = 3;

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

    // Layover state. `parkedAt` is the city name while the truck is sitting
    // between contracts (null the entire time it's driving), which is what
    // the map's per-city parked counter and the UI's "PARKED" status both
    // key off. `pendingOffers` is only populated for the player-controlled
    // truck, whose choice of load is made by a human rather than by
    // chooseOffer().
    this.parkedAt = null;
    this.dwellHoursLeft = 0;
    this.pendingOffers = null;
    this.awaitingContract = false;
    // Discriminates why a parked truck is parked: "LAYOVER" (between
    // contracts - takes a new load on wake) vs "REST"/"FUEL" (mid-route -
    // resumes the SAME contract on wake). Reusing parkedAt/dwellHoursLeft
    // for all three keeps the map's parked-badge tally, the "hide the dot"
    // render rule, and the tap-falls-through-to-city behavior working for
    // REST/FUEL with no changes - they all key off parkedAt alone.
    this.stopReason = null;

    // Resources (Phase 3/4): fuel, fatigue, and breakdown condition.
    this.fuel = 100;
    this.fatigue = 0;
    this.milesSinceStop = 0; // wear tracker for the breakdown roll; resets on any real stop
    // > 0 while broken down or dry-tanked ON THE SHOULDER mid-edge - this
    // is deliberately NOT `parkedAt` (the truck never reached a node, so
    // it keeps its edge/.s and must stay fully rendered and rubberneck-
    // visible, unlike a parked truck's hidden dot).
    this.disabledHoursLeft = 0;
    this.disabledReason = null; // "BREAKDOWN" | "FUEL"
    this.fuelSpend = 0;
    this.downtimeHours = 0;
    // The edge just completed - used to avoid an immediate U-turn when
    // resuming from a full stop (parkedAt/disabled clears `edge`, so the
    // junction/departure logic needs this to know what NOT to reverse
    // back onto), and later reused for junction corner-blending.
    this.prevEdge = null;

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
  // is a genuine departure FROM A FULL STOP - a brand-new contract's
  // route, or a truck waking from a REST/FUEL stop to resume its existing
  // route - AND the node being LEFT is a real city (not a tier-0 highway-
  // interchange filler node), i.e. an actual stop, not just a waypoint
  // the route happens to route through. A truck passing through a real
  // city mid-route (this edge is just the next leg of an already-
  // underway haul, no stop involved) carries straight through at full
  // speed and in whatever lane it was already in instead - same as a
  // tier-0 junction always has (see arrivalSpeedCap, which only
  // decelerates a truck's actual final leg, and placeOnEdge, which no
  // longer resets lane/laneT itself) - real continuity through the node,
  // not just "no hard stop". It still needs `placeOnEdge`'s conflict
  // nudge either way (`laneGroups` may be undefined only when spawning a
  // fresh truck, which always starts at a real city and never reaches
  // this branch).
  _advanceToNextEdge(graph, laneGroups, fromFullStop = false) {
    const next = this.remainingPath.shift();
    if (fromFullStop && graph.nodes[next.from].t > 0) {
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

  // Delivery complete: bank the payout and park. The truck deliberately
  // keeps `contract` pointing at the load it just finished rather than
  // nulling it - the details panel, the rankings and the economy tab all
  // read that object every frame, and a parked truck showing its last run
  // is both safe and more informative than a blank. It's replaced wholesale
  // when the next load is accepted.
  _arriveAtDestination(graph, rnd = Math.random) {
    this.earnings += this.contract.payout;
    this.contractsCompleted++;
    this.currentNode = this.contract.destination;
    this.edge = null;
    this.pendingEdge = null;
    this.speed = 0;
    this.lane = 0;
    this.laneT = 0;
    this.passingLeaderId = null;
    this.parkedAt = this.currentNode;
    this.dwellHoursLeft = rollDwellHours(this.driver, rnd);
    this.stopReason = "LAYOVER";
    this.milesSinceStop = 0; // a delivery + layover counts as a real stop for breakdown wear
  }

  // Accept a specific contract (chosen by the driver, or by the player for
  // the controlled truck) and roll out. Mirrors _assignContract's tail, but
  // takes the contract as given instead of generating one.
  _takeContract(graph, contract, laneGroups) {
    this.contract = contract;
    this.remainingPath = contract.path ? [...contract.path] : [];
    this.parkedAt = null;
    this.dwellHoursLeft = 0;
    this.stopReason = null;
    this.pendingOffers = null;
    this.awaitingContract = false;
    if (this.remainingPath.length) this._advanceToNextEdge(graph, laneGroups, true);
    else { this.edge = null; this.pendingEdge = null; }
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

// Options for a junction the player has to call. The truck's own planned
// next edge is always first and always present, even if its control city
// would have ranked it off the end of the list - it's the route the driver
// is already committed to, so it has to be the obvious default rather than
// something the player has to hunt for. The rest follow by control-city
// importance.
function rankAndCapOptions(graph, options, plannedEdge) {
  const isPlanned = (e) => plannedEdge && e.to === plannedEdge.to && e.route === plannedEdge.route;
  const planned = options.find(isPlanned) || null;
  const rest = options
    .filter((e) => e !== planned)
    .sort((a, b) => (graph.nodes[b.control]?.w || 0) - (graph.nodes[a.control]?.w || 0));
  const capped = rest.slice(0, MAX_DECISION_OPTIONS - (planned ? 1 : 0));
  return planned ? [planned, ...capped] : capped;
}

// Weighted by city `w` (roulette-wheel, same shape as economy.js's
// pickDestination) rather than a flat uniform pick over the eligible
// pool - tier-3 cities alone outnumber tier-1 hubs roughly 4 to 1, so a
// flat pick handed small cities disproportionately more starting trucks
// purely from pool arithmetic, independent of how "important" they are.
export function spawnFleet(graph, count, rnd = Math.random) {
  const cities = Object.values(graph.nodes).filter((n) => n.t > 0 && n.t <= 3);
  let totalWeight = 0;
  for (const c of cities) totalWeight += c.w;
  const trucks = [];
  for (let i = 0; i < count; i++) {
    let roll = rnd() * totalWeight;
    let city = cities[cities.length - 1];
    for (const c of cities) {
      roll -= c.w;
      if (roll <= 0) { city = c; break; }
    }
    trucks.push(new Truck(graph, city.name, rnd));
  }
  return trucks;
}

// --- lane physics helpers -------------------------------------------

// Groups currently-driving trucks (pendingEdge/stranded trucks have no
// `edge` and are excluded) by directed edge and lane, sorted ascending
// by progress along the edge. Rebuilt fresh every updateFleet tick from
// that tick's pre-move snapshot, so decisions are deterministic and
// never see another truck's already-updated-this-tick position. Each
// group also carries the shared `edge` object itself (every truck sharing
// an edgeId is on the same physical road segment, so `.kind`/`.miles`/etc
// are identical across the group) - downstream per-tick passes
// (clampOverlaps, updateFleet's Phase 1) reuse this same Map instead of
// re-deriving their own grouping, which is the thing that used to make
// this "the seam to revisit if the fleet ever scales into the
// thousands" - it since has, so that redundant rebuild is gone now.
// IMPORTANT: the ascending sort is only valid at THIS moment (before any
// truck moves this tick) - different trucks integrate different distances
// in Phase 2, which can and does reorder their relative `.s` within a
// lane by the time later phases run (confirmed empirically during
// verification). Phase 1 runs immediately after this and never mutates
// `.s`, so it's safe to trust this order - anything reading `lane0`/
// `lane1` AFTER Phase 2 has run (clampOverlaps) must re-sort by current
// `.s` rather than trusting this snapshot's order.
// `disabledByEdge` collects the `.s` of every broken-down/dry-tanked
// truck, keyed by edgeId, so the rest of the tick can find them without a
// second pass over `trucks`. A disabled truck is deliberately excluded
// from `groups` (and therefore from every lane-physics consumer below -
// leaderMap, applyFollowAndPassing, clampOverlaps, tryDepartTruck,
// placeOnEdge's occupant scan all read `groups`, never `trucks`) since it
// sits on the shoulder, not in the travel lane: a 0-speed "leader" would
// otherwise propagate a permanent full-stop backward through every
// follower, and clampOverlaps would pin them at its position forever -
// a corridor-wide deadlock immune to any speed logic. Other trucks
// driving straight through its position is the correct, intended result.
function buildLaneGroups(trucks, disabledByEdge) {
  const groups = new Map();
  for (const truck of trucks) {
    if (!truck.edge) continue;
    const key = edgeId(truck.edge);
    if (truck.disabledHoursLeft > 0) {
      let arr = disabledByEdge.get(key);
      if (!arr) { arr = []; disabledByEdge.set(key, arr); }
      arr.push(truck.s);
      continue;
    }
    let g = groups.get(key);
    if (!g) { g = { lane0: [], lane1: [], edge: truck.edge }; groups.set(key, g); }
    (truck.lane === 1 ? g.lane1 : g.lane0).push(truck);
  }
  for (const g of groups.values()) {
    g.lane0.sort((a, b) => a.s - b.s);
    g.lane1.sort((a, b) => a.s - b.s);
  }
  for (const arr of disabledByEdge.values()) arr.sort((a, b) => a - b);
  return groups;
}

// --- environment: rush hour + weather ---------------------------------
//
// Both slow a truck's cruise target rather than capping it, so they layer
// with car-following instead of fighting it. `env` is
// { weather, showWeather, showRushHour, gameSeconds } supplied by main.js;
// when it's null (as in the pure-simulation regression harnesses) nothing
// here runs and the sim behaves exactly as it did before these existed.

// Peak commuter windows, in LOCAL minutes at the truck's own longitude -
// morning and evening rush genuinely happen at 8am/5pm local across the
// country, not simultaneously everywhere, and the terminator math needed
// to know that already exists in geo.js.
const RUSH_WINDOWS = [[420, 555], [960, 1110]]; // 07:00-09:15, 16:00-18:30
const RUSH_WORST = 0.62; // speed multiplier at peak, right at a major metro

// How "metro" an edge is, 0..1, from the heavier of its two endpoints.
// Cached on the edge object the first time it's asked for: edges are
// created once in buildGraph and never mutated, and this is a pure
// function of the graph, so recomputing it per truck per tick would be
// pure waste.
function edgeMetroFactor(graph, edge) {
  if (edge._metro === undefined) {
    const a = graph.nodes[edge.from], b = graph.nodes[edge.to];
    const w = Math.max(a.w || 0, b.w || 0);
    edge._metro = Math.max(0, Math.min(1, (w - 4.5) / 5.5)); // w<=4.5 rural -> 0, w>=10 megacity -> 1
  }
  return edge._metro;
}

function rushHourMult(graph, truck, gameSeconds) {
  const metro = edgeMetroFactor(graph, truck.edge);
  if (metro <= 0) return 1;
  const node = graph.nodes[truck.edge.from];
  const m = localMinutesAtX(node.x, gameSeconds);
  for (const [start, end] of RUSH_WINDOWS) {
    if (m < start || m > end) continue;
    // Ramp in and out across the window instead of a step change, so the
    // fleet visibly congeals and then loosens again.
    const t = (m - start) / (end - start);
    const peak = Math.sin(t * Math.PI);
    return 1 - (1 - RUSH_WORST) * peak * metro;
  }
  return 1;
}

// Weather alone (no rush hour) - kept separate from rush hour so Phase 1
// can snapshot `truck.freeFlowSpeed` (what this truck would be doing on
// an open road right now, weather included) BEFORE rush hour, rubberneck,
// follow, and arrival caps apply. The congestion detector (render.js's
// tallyCongestion) compares live speed against this snapshot to measure
// actual slowdown - weather counts as "the road is just slow today", not
// congestion, but rush hour and a real jam both should read as congested,
// so they're excluded from the baseline instead.
function weatherOnlyMult(graph, truck, env) {
  if (!(env.showWeather && env.weather)) return 1;
  // Edge midpoint is plenty for weather sampling - cells are hundreds of
  // world units across, far larger than any single edge.
  const a = graph.nodes[truck.edge.from], b = graph.nodes[truck.edge.to];
  return weatherSpeedMultAt(env.weather, (a.x + b.x) / 2, (a.y + b.y) / 2);
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
// nothing ahead is a factor). `leaderMap` (built once per tick by
// updateFleet's Phase 1, before any truck's state changes) gives O(1)
// leader lookup instead of the `ownArr.indexOf(truck)` rescan this used to
// do - deliberately NOT restructured to iterate lane arrays directly
// instead of `trucks`: Phase 1 mutates each truck's own `.speed` in
// place as it goes, and a follower's cap here reads its leader's
// `.speed` LIVE - so which trucks have or haven't been processed yet
// this same tick (i.e. `trucks`-array iteration order specifically)
// silently affects the result. Confirmed by exact-match testing against
// the pre-refactor baseline: an earlier version of this change iterated
// lane arrays instead (back-to-front by position) and produced a
// systematically different simulation, not just an occasional tie.
// Preserving the exact original iteration order was necessary for a
// true behavior-preserving optimization here.
function applyFollowAndPassing(graph, truck, laneGroups, leaderMap, cruiseTargetSpeed) {
  if (truck.edge.kind !== "interstate") return Infinity;
  const group = laneGroups.get(edgeId(truck.edge));
  if (!group) return Infinity;
  const leader = leaderMap.get(truck) || null;

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
      const target = crossLaneTarget(t.laneT, truck.laneT);
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
        const target = crossLaneTarget(t.laneT, truck.laneT);
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

// The along-edge gap threshold two trucks need, continuously interpolated
// on how far apart their laneT actually is - NOT on the discrete `.lane`
// target flag. RIGHT_LANE_OFFSET - LEFT_LANE_OFFSET === CROSS_LANE_TARGET_
// WORLD_UNITS by construction, so perpGap between any two trucks is always
// exactly CROSS_LANE_TARGET_WORLD_UNITS * |Δlanet|, bounded in [0,
// CROSS_LANE_TARGET_WORLD_UNITS] - meaning a plain linear ramp from
// MIN_DOT_GAP_WORLD_UNITS (same visual lane) down to CROSS_LANE_TARGET_
// WORLD_UNITS (fully opposite lanes) lands exactly on both today's steady-
// state endpoints with a smooth, monotonic gradient between them. Using
// the discrete flag instead (as this used to) relaxes the threshold the
// instant a pass/merge DECISION is made, before the truck has actually
// moved sideways - reading as a same-tick longitudinal snap rather than a
// diagonal glide. This formula makes that discontinuity structurally
// impossible rather than just less likely.
function crossLaneTarget(laneTA, laneTB) {
  const diff = Math.abs(laneTA - laneTB);
  return MIN_DOT_GAP_WORLD_UNITS - (MIN_DOT_GAP_WORLD_UNITS - CROSS_LANE_TARGET_WORLD_UNITS) * diff;
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
// Takes the tick's already-built `laneGroups` (same Map updateFleet's
// Phase 1 uses) instead of re-deriving its own grouping from `trucks` -
// still avoids the full O(n) Map-rebuild-from-`trucks` every tick (group
// MEMBERSHIP by edge doesn't change mid-tick), but each group's `lane0`/
// `lane1` were only sorted once, at the top of updateFleet, BEFORE Phase 1
// (speed decisions) and Phase 2 (position integration) ran - different
// trucks move different distances this same tick, which can and does
// reorder their relative `.s` within a lane before clampOverlaps runs
// (confirmed empirically: two same-lane trucks swapped relative order
// within a single tick during verification). So this still needs a fresh
// sort by CURRENT `.s`, not a merge that trusts the stale buildLaneGroups
// order - a merge would silently process pairs in the wrong order.
function clampOverlaps(graph, laneGroups) {
  for (const group of laneGroups.values()) {
    if (group.edge.kind !== "interstate") continue;
    if (group.lane0.length + group.lane1.length < 2) continue;
    const ascending = [...group.lane0, ...group.lane1].sort((a, b) => a.s - b.s);
    const unitsPerMile = worldUnitsPerMile(graph, group.edge);
    // Walk front-to-back (highest `.s` first) by iterating the ascending
    // merge in reverse - equivalent to the original's fresh descending
    // sort, without building a second array.
    for (let i = ascending.length - 1; i > 0; i--) {
      const ahead = ascending[i], behind = ascending[i - 1];
      const target = crossLaneTarget(ahead.laneT, behind.laneT);
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

// --- fuel / fatigue / breakdown helpers -------------------------------

// Fuel burn for the miles just driven: base rate x this driver's
// fuelBurnMult x an aerodynamic drag penalty that only kicks in above
// FUEL_DRAG_SPEED_MPH (an aggressive driver cruising fast pays for it).
function burnPerMile(truck) {
  const drag = 1.0 + Math.pow(Math.max(0, truck.speed / FUEL_DRAG_SPEED_MPH - 1.0), 2);
  return FUEL_BURN_PER_MILE * truck.driver.fuelBurnMult * drag;
}

// Rough remaining range in miles at this truck's current fuel level, for
// the detail panel's gauge - the no-drag rate is a fine estimate for a
// forward-looking display (drag only matters above FUEL_DRAG_SPEED_MPH).
export function estimatedRangeMiles(truck) {
  return truck.fuel / (FUEL_BURN_PER_MILE * truck.driver.fuelBurnMult);
}

// Fuel needed to cover `miles` more of driving, with FUEL_REFILL_MARGIN
// headroom - the no-drag rate is a fine estimate since drag only applies
// to a small speed band.
function fuelNeededFor(truck, miles) {
  return miles * FUEL_BURN_PER_MILE * truck.driver.fuelBurnMult * FUEL_REFILL_MARGIN;
}

// How much fuel a refuel (at a node, or recovering from a dry-tank
// breakdown) should top off to - never a flat 100, which would re-strand
// a truck on an edge longer than a full tank's range. Covers whatever
// distance is actually still ahead: the rest of the CURRENT edge if the
// truck is disabled mid-edge, or the next queued edge if it's parked at
// a node about to depart.
function refuelAmountNeeded(truck) {
  let remainingMiles = 0;
  if (truck.edge) remainingMiles = truck.edge.miles - truck.s;
  else if (truck.remainingPath[0]) remainingMiles = truck.remainingPath[0].miles;
  const minFuel = remainingMiles > 0 ? fuelNeededFor(truck, remainingMiles) : 0;
  return Math.max(100, minFuel);
}

function applyRefuel(truck) {
  const before = truck.fuel;
  const after = refuelAmountNeeded(truck);
  const cost = Math.max(0, after - before) * FUEL_PRICE_PER_UNIT;
  truck.earnings -= cost;
  truck.fuelSpend += cost;
  truck.fuel = after;
}

// True if minute-of-day `m` falls in [start, end), where the window may
// wrap past midnight (start > end, e.g. 21:00-03:00).
function isInWindow(m, start, end) {
  return start <= end ? (m >= start && m < end) : (m >= start || m < end);
}

// Fuel takes priority (a physical necessity); circadian rest only checked
// if fuel is fine. `env` is null in the headless harness path (no game
// clock to read local time from), so rest simply never fires there -
// fuel and breakdowns are both deterministic and still fully exercised.
function nodeStopReason(graph, truck, node, env) {
  const nextEdge = truck.remainingPath[0];
  if (truck.fuel <= FUEL_LOW_THRESHOLD || (nextEdge && truck.fuel < fuelNeededFor(truck, nextEdge.miles))) {
    return "FUEL";
  }
  if (env && !truck.driver.isOutlaw && truck.fatigue > FATIGUE_REST_THRESHOLD) {
    const m = localMinutesAtX(graph.nodes[node].x, env.gameSeconds);
    const inWindow = truck.driver.isNightOwl
      ? isInWindow(m, NIGHT_OWL_SLEEP_START_MIN, NIGHT_OWL_SLEEP_END_MIN)
      : isInWindow(m, STANDARD_SLEEP_START_MIN, STANDARD_SLEEP_END_MIN);
    if (inWindow) return "REST";
  }
  return null;
}

// Parks a truck at a real-city node for a REST or FUEL stop - same
// parkedAt/dwellHoursLeft fields a delivery layover uses (see the
// `stopReason` field comment on Truck), so every parkedAt-keyed system
// (badge tally, hidden dot, tap fall-through) needs no changes to cover
// these two new stop kinds.
function parkForStop(truck, node, reason, rnd) {
  truck.edge = null;
  truck.pendingEdge = null;
  truck.speed = 0;
  truck.lane = 0;
  truck.laneT = 0;
  truck.passingLeaderId = null;
  truck.parkedAt = node;
  truck.stopReason = reason;
  truck.dwellHoursLeft = reason === "FUEL"
    ? FUEL_STOP_HOURS
    : REST_MIN_HOURS + rnd() * (REST_MAX_HOURS - REST_MIN_HOURS);
}

// Disables a truck ON THE SHOULDER, mid-edge - see the `disabledHoursLeft`
// field comment on Truck for why this is distinct from parkedAt.
function disableTruck(truck, reason, hours) {
  truck.speed = 0;
  truck.disabledHoursLeft = hours;
  truck.disabledReason = reason;
}

// Speed multiplier from "rubbernecking" a disabled truck ahead on the
// same edge: deepens monotonically as a truck closes the gap, and is
// exactly 1 (no effect) the instant its `.s` passes the disabled truck's
// - "out of potential traffic once they pass." `sortedS` is ascending, so
// gap = ds - truck.s increases monotonically as we walk it: once gap
// exceeds `range` every later entry is farther still, so it's safe to
// stop scanning. The zone is sized off minSafeMiles (a multiple of the
// render-scale anti-overlap floor), NOT an absolute mile count - at this
// map's projection a couple of real miles is sub-pixel, and would be
// invisible on screen and too short to ever stack a visible queue.
function rubberneckMult(sortedS, graph, truck) {
  if (!sortedS || !sortedS.length) return 1;
  const range = minSafeMiles(graph, truck.edge) * RUBBERNECK_RANGE_SAFE_MULT;
  let mult = 1;
  for (const ds of sortedS) {
    const gap = ds - truck.s;
    if (gap > range) break;
    if (gap <= 0) continue;
    const closeness = 1 - gap / range;
    const m = 1 - (1 - RUBBERNECK_WORST_MULT) * closeness;
    if (m < mult) mult = m;
  }
  return mult;
}

// Departs a truck from a full stop at a node - either a fresh contract
// leg it was always going to take, or the SAME contract's next leg after
// waking from a REST/FUEL park. `reverseOfEdge` is the edge the truck
// just arrived on (excluded from the controlled-truck's junction options
// so it isn't offered an immediate U-turn); `fromFullStop` is forwarded
// to `_advanceToNextEdge` to decide whether this departure gets the
// stop-and-wait-for-a-gap treatment.
function departFromNode(graph, truck, laneGroups, controlledTruck, reverseOfEdge, fromFullStop) {
  if (truck === controlledTruck) {
    const options = pickEdgesFrom(graph, truck.currentNode, reverseOfEdge);
    if (options.length > 1) {
      truck.pendingOptions = rankAndCapOptions(graph, options, truck.remainingPath[0]);
      truck.awaitingDecision = true;
      return truck;
    }
  }
  truck._advanceToNextEdge(graph, laneGroups, fromFullStop);
  return null;
}

// Advances every truck by `dt` real seconds at the given time-scale
// multiplier. Returns the truck awaiting a junction decision, if any
// (only possible for `controlledTruck` - the one truck the player has
// explicitly taken control of via the details panel, a separate,
// narrower thing than merely being followed by the camera), so the
// caller can pause the whole sim and show the decision panel. `rnd`
// defaults to Math.random but accepts a seeded generator for the
// headless soak-test harness.
export function updateFleet(graph, trucks, dt, timeScale, controlledTruck, env = null, rnd = Math.random) {
  const gameHours = (dt * BASE_TIME_SCALE * timeScale) / 3600;
  const disabledByEdge = new Map();
  const laneGroups = buildLaneGroups(trucks, disabledByEdge);

  // Precomputed once per tick, before Phase 1 mutates anything: each
  // truck's leader (the next entry in its lane array, or null), from the
  // same fresh laneGroups snapshot Phase 1 already relies on. O(1) lookup
  // per truck in Phase 1 below instead of the old `ownArr.indexOf(truck)`
  // rescan - built here (rather than inline per-truck) specifically so
  // Phase 1's own iteration order over `trucks` doesn't change (see the
  // long comment on applyFollowAndPassing for why that order matters).
  const leaderMap = new Map();
  for (const group of laneGroups.values()) {
    for (const lane of [group.lane0, group.lane1]) {
      for (let i = 0; i < lane.length - 1; i++) leaderMap.set(lane[i], lane[i + 1]);
    }
  }

  // Phase 1: decide each truck's target speed/lane and ease toward it -
  // reads other trucks' pre-move positions (laneGroups/leaderMap), same
  // as before.
  for (const truck of trucks) {
    if (truck.awaitingDecision || truck.awaitingContract || truck.pendingEdge || !truck.edge || truck.disabledHoursLeft > 0) continue;

    let targetSpeed = truck.edge.speedLimit * truck.driver.cruiseMult;
    // Environmental slowdowns are applied to the CRUISE target rather than
    // as a hard cap, so car-following and the arrival decel below still
    // compose on top normally - a truck crawling through a blizzard still
    // brakes for the truck in front of it.
    if (env) {
      targetSpeed *= weatherOnlyMult(graph, truck, env);
      // Snapshot BEFORE rush hour/rubberneck/follow/arrival - this is what
      // the truck would be doing on an open road right now (weather
      // included; weather is "the road is slow today", not congestion).
      // render.js's tallyCongestion compares live speed against this to
      // detect a genuine slowdown, independent of fleet size.
      truck.freeFlowSpeed = targetSpeed;
      if (env.showRushHour) targetSpeed *= rushHourMult(graph, truck, env.gameSeconds);
    } else {
      truck.freeFlowSpeed = targetSpeed;
    }
    // Rubbernecking a disabled truck ahead - also a target-level
    // multiplier (not a hard cap) for the same reason, and composes with
    // the follow cap below since it's applied before that Math.min.
    targetSpeed *= rubberneckMult(disabledByEdge.get(edgeId(truck.edge)), graph, truck);
    targetSpeed = Math.min(targetSpeed, arrivalSpeedCap(graph, truck, targetSpeed));
    targetSpeed = Math.min(targetSpeed, applyFollowAndPassing(graph, truck, laneGroups, leaderMap, targetSpeed));

    const rate = targetSpeed >= truck.speed ? truck.driver.accelRate : truck.driver.decelRate;
    truck.speed += (targetSpeed - truck.speed) * Math.min(1, dt * rate);
    truck.laneT += (truck.lane - truck.laneT) * Math.min(1, dt * LANE_CHANGE_EASE);
  }

  // Phase 2: integrate position from the speed each truck just settled on,
  // then burn fuel and roll for a breakdown.
  for (const truck of trucks) {
    if (truck.awaitingDecision || truck.awaitingContract || truck.pendingEdge || !truck.edge || truck.disabledHoursLeft > 0) continue;
    const miles = truck.speed * gameHours;
    truck.s += miles;
    truck.totalMilesDriven += miles;
    truck.milesSinceStop += miles;
    truck.fatigue += gameHours * FATIGUE_PER_HOUR;
    truck.fuel = Math.max(0, truck.fuel - miles * burnPerMile(truck));

    // An arrival this tick is handled entirely by Phase 4 (refuel/rest at
    // the node, or a fresh breakdown-immunity there) - never disable a
    // truck exactly at or past its edge's end, which would create a slow
    // zone right at the node that nothing could ever clear.
    if (truck.s >= truck.edge.miles) continue;

    if (truck.fuel <= 0) {
      truck.earnings -= FUEL_TOW_COST;
      disableTruck(truck, "FUEL", FUEL_DISABLED_SERVICE_MIN_HOURS + rnd() * (FUEL_DISABLED_SERVICE_MAX_HOURS - FUEL_DISABLED_SERVICE_MIN_HOURS));
      continue;
    }

    const p = BREAKDOWN_PER_MILE * (1.6 - truck.driver.skill) * (1 + truck.milesSinceStop / BREAKDOWN_MILES_SINCE_STOP_SCALE) * miles;
    if (rnd() < p) {
      disableTruck(truck, "BREAKDOWN", BREAKDOWN_REPAIR_MIN_HOURS + rnd() * (BREAKDOWN_REPAIR_MAX_HOURS - BREAKDOWN_REPAIR_MIN_HOURS));
    }
  }

  // Phase 3: hard anti-overlap clamp on the post-move positions (see
  // clampOverlaps above for why this can't just be folded into phase 1).
  clampOverlaps(graph, laneGroups);

  // Phase 4: disabled trucks, layovers, rest/fuel stops, arrivals,
  // junction decisions, and departures, using the final (clamped)
  // positions.
  for (const truck of trucks) {
    if (truck.awaitingDecision || truck.awaitingContract) continue;

    // Disabled on the shoulder (breakdown or ran dry mid-edge) - not
    // `parkedAt` (see the field comment on Truck), so it keeps its edge/.s
    // the whole time and resumes from exactly where it stopped.
    if (truck.disabledHoursLeft > 0) {
      truck.disabledHoursLeft -= gameHours;
      truck.downtimeHours += gameHours;
      if (truck.disabledHoursLeft > 0) continue;
      truck.disabledHoursLeft = 0;
      if (truck.disabledReason === "FUEL") applyRefuel(truck);
      truck.disabledReason = null;
      truck.milesSinceStop = 0;
      continue;
    }

    // Parked - between loads (LAYOVER), or mid-route sleeping/refueling
    // (REST/FUEL). Burn down the dwell timer; layovers/rests also recover
    // fatigue while parked, not just on wake, so a truck woken early by a
    // future feature wouldn't read a stale high number.
    if (truck.parkedAt) {
      truck.dwellHoursLeft -= gameHours;
      truck.fatigue = Math.max(0, truck.fatigue - gameHours * FATIGUE_PER_HOUR);
      if (truck.dwellHoursLeft > 0) continue;
      truck.dwellHoursLeft = 0;

      if (truck.stopReason !== "LAYOVER") {
        // REST or FUEL: resume the SAME contract's route rather than
        // taking a new load.
        if (truck.stopReason === "FUEL") applyRefuel(truck);
        else truck.fatigue = 0; // exact reset - don't rely on the sleep window alone (see nodeStopReason), or a truck waking still inside its window re-sleeps immediately
        truck.stopReason = null;
        truck.parkedAt = null;
        truck.milesSinceStop = 0;
        const waiting = departFromNode(graph, truck, laneGroups, controlledTruck, truck.prevEdge, true);
        if (waiting) return waiting;
        continue;
      }

      const offers = generateContractOffers(graph, truck.parkedAt, OFFER_COUNT, rnd);
      if (!offers.length) {
        // Nothing routable from here (shouldn't happen on this graph, but
        // don't wedge the truck forever if it ever does) - wait and retry.
        truck.dwellHoursLeft = 1;
        continue;
      }
      if (truck === controlledTruck) {
        truck.pendingOffers = offers;
        truck.awaitingContract = true;
        return truck;
      }
      truck._takeContract(graph, chooseOffer(offers, truck.driver, rnd), laneGroups);
      continue;
    }

    if (truck.pendingEdge) {
      tryDepartTruck(graph, truck, laneGroups, dt);
      continue;
    }
    if (!truck.edge) continue; // truly stranded
    if (truck.s < truck.edge.miles) continue;

    const node = truck.edge.to;
    truck.currentNode = node;
    if (node === truck.contract.destination) {
      truck._arriveAtDestination(graph, rnd);
      continue;
    }

    truck.prevEdge = truck.edge;
    const stop = nodeStopReason(graph, truck, node, env);
    if (stop) {
      parkForStop(truck, node, stop, rnd);
      continue;
    }

    const waiting = departFromNode(graph, truck, laneGroups, controlledTruck, truck.prevEdge, false);
    if (waiting) return waiting;
  }
  return null;
}
