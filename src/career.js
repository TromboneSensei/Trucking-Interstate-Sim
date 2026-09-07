// career.js - Owner-Operator mode: the player's own truck, a wallet, and
// everything that happens when they take real agency over one rig inside
// the otherwise-autonomous fleet. This module owns NO DOM (see
// career-ui.js for that, mirroring how cb.js owns its own panel) and never
// touches `trucks` beyond the one truck the player controls - it must stay
// safe to import into a headless test with no window/document at all.
"use strict";

import { updateFleet, drainFleetEvents, BASE_TIME_SCALE, resumeFromPlayerStop } from "./fleet.js";
import { updateWeather } from "./weather.js";
import { DriverDNA } from "./driver.js";

// --- fast-forward ------------------------------------------------------
//
// The single most important correctness rule in career mode: TIME ONLY
// MOVES BY SIMULATING. Sleeping 8 hours must actually run ~8 hours of the
// real fleet loop - fuel burns, AI trucks arrive and depart, breakdowns
// roll, weather drifts - not just add 8 hours to a clock while 10,000
// trucks sit frozen. A frozen-clock jump would desync weather timestamps,
// collapse skipped midnights into one empty daily digest, and let every
// buff/mission deadline burn against a period where nothing could have
// happened - and it would make sleep literally free progress (no fuel
// burn, no AI competing for loads while you're out cold).
//
// `fastForwardHours` is a pure function: it takes the graph/trucks/weather
// it's handed, runs `updateFleet` (+ `updateWeather`) in bounded substeps
// exactly as main.js's own frame loop would tick by tick, and returns the
// new `gameSeconds` plus any fleet events that happened along the way. It
// does not read or write any module-level state of its own, so a caller
// (main.js, or a headless test) is free to drive it however it likes -
// including calling `onSubstep` after every tick to run its own per-tick
// work (sampleEconomy/checkDayRollover in the real game; nothing in a
// test). Callers integrating this into the live game must ensure the
// NORMAL per-frame `updateFleet` call is suppressed for the duration (see
// the truck-stop `state.truckStopOpen` flag) - two callers draining
// `drainFleetEvents()` concurrently would race on fleet.js's single
// module-level queue.
const FF_SUBSTEP_HOURS = 0.25; // ~40 ticks for a 10h sleep - cheap even at 10k trucks, fine-grained enough that dt-clamped easing (Math.min(1, dt*rate)) doesn't visibly snap speed/lane blends

// Rescue missions (career-ui.js / a future missions module) are seeded from
// live BREAKDOWN/DRY_TANK fleet events. An event captured early in an
// 8-hour fast-forward is stale by the time the player wakes: the AI truck
// has very likely already been repaired/towed and moved on (repair is
// 3-24h, but dry-tank service is only 1-3h - even the SHORT end of that
// range clears well inside an 8h sleep). Discarding anything older than
// this, measured from the moment fast-forward ends, keeps only events the
// player could plausibly still reach.
export const RESCUE_EVENT_MAX_AGE_HOURS = 4;

/**
 * Runs `hours` of real simulated game-time in bounded substeps.
 *
 * @param {object} graph - from geo.js buildGraph()
 * @param {Truck[]} trucks - the live fleet array (mutated in place, same as updateFleet)
 * @param {object|null} weatherCells - from weather.js createWeather(), or null
 * @param {number} startGameSeconds - the game clock to fast-forward FROM
 * @param {number} hours - how many game-hours to advance
 * @param {object} [opts]
 * @param {boolean} [opts.showWeather=false]
 * @param {boolean} [opts.showRushHour=true]
 * @param {function} [opts.rnd=Math.random]
 * @param {Truck|null} [opts.controlledTruck=null] - forwarded to updateFleet each substep;
 *   almost always null during a fast-forward (the player's own truck is PARKED, and a parked
 *   truck never reaches a junction/contract decision - see fleet.js's Phase 1/2 guards), but
 *   accepted for completeness/testing.
 * @param {number} [opts.substepHours=FF_SUBSTEP_HOURS]
 * @param {function} [opts.onSubstep] - (gameSeconds, substepHours) => void, called after each substep
 * @returns {{ gameSeconds: number, ticks: number, events: Array<{kind,truckId,truckName,gameSeconds}> }}
 */
export function fastForwardHours(graph, trucks, weatherCells, startGameSeconds, hours, opts = {}) {
  const {
    showWeather = false,
    showRushHour = true,
    rnd = Math.random,
    controlledTruck = null,
    substepHours = FF_SUBSTEP_HOURS,
    onSubstep = null,
  } = opts;

  let gameSeconds = startGameSeconds;
  let remaining = hours;
  const events = [];
  let ticks = 0;

  while (remaining > 1e-9) {
    const step = Math.min(substepHours, remaining);
    // Solve for the (dt, timeScale) pair that makes updateFleet's own
    // `gameHours = dt * BASE_TIME_SCALE * timeScale / 3600` equal `step` -
    // timeScale pinned to 1 so this is just dt = step*3600/BASE_TIME_SCALE.
    // Unlike main.js's real-time frame loop, there is no need to clamp dt
    // here (that clamp - main.js's `Math.min(0.05, ...)` - exists purely
    // to keep a real stalled/backgrounded browser tab from taking one
    // giant catch-up step; it has nothing to do with fleet.js itself,
    // which places no upper bound on dt).
    const dt = (step * 3600) / BASE_TIME_SCALE;
    const env = { weather: weatherCells, showWeather, showRushHour, gameSeconds };

    if (showWeather && weatherCells) updateWeather(weatherCells, step, rnd);
    updateFleet(graph, trucks, dt, 1, controlledTruck, env, rnd);

    gameSeconds += step * 3600;
    remaining -= step;
    ticks++;

    for (const evt of drainFleetEvents()) {
      events.push({ kind: evt.kind, truckId: evt.truck.id, truckName: evt.truck.name, gameSeconds });
    }

    if (onSubstep) onSubstep(gameSeconds, step);
  }

  const maxAgeSeconds = RESCUE_EVENT_MAX_AGE_HOURS * 3600;
  const freshEvents = events.filter((e) => gameSeconds - e.gameSeconds <= maxAgeSeconds);

  return { gameSeconds, ticks, events: freshEvents };
}

// =========================================================================
// Owner-Operator profile + economy
// =========================================================================
//
// Everything below this line is the actual "game" on top of fastForward:
// one persistent player profile (cash, condition, upgrades, buffs, stats),
// the `agent` object that plugs it into fleet.js's seam, and the actions
// (buy fuel, eat, sleep, repair, take a load) a truck-stop UI drives.
//
// Money model: `profile.cash` is a SEPARATE ledger from `truck.earnings`.
// `earnings` keeps meaning "gross revenue" so fleet-wide rankings/digest/
// economy-tab stay correct for the other 9999 autopilot trucks; `cash` is
// the player's actual bank balance after fuel, food, repairs and fines.
// pumpFuel() already routes an agent truck's fuel bill to `cash` instead
// of `earnings` (see fleet.js) - every other expense here does the same.

const CAREER_SAVE_VERSION = 1;
const STARTING_CASH = 2500;
const CRITICAL_FUEL_PCT = 8; // hard safety floor - the player truck can never actually run dry by accident
const HUNGER_DECAY_PER_HOUR = 1.6; // ~2.6 days between meals before it bites
const LOW_HUNGER_THRESHOLD = 20;
const HEAT_COOLDOWN_PER_HOUR = 0.8; // law attention fades on its own, slowly, if you keep clean for a while
const HEAT_BUILD_PER_HOUR_HAMMER = 12; // ~8h of sustained HAMMER saturates heat at 100
const TICKET_FINE_BASE = 180; // + up to ~400 more scaled by how hot you were when caught
const TICKET_CHANCE_PER_HOUR_AT_MAX_HEAT = 0.15; // scales down with (heat/100)^2, so it's negligible below ~40 heat
export const SETTLEMENT_INTERVAL_HOURS = 168; // 1 game-week, elapsed GAME time - same convention as every other career.js timer, not real/wall-clock time
const SETTLEMENT_OVERHEAD_PCT = 0.15; // insurance/permits/truck payment - the ongoing cost of OWNING a rig you don't personally drive, taken off the top before it reaches profile.cash

// --- Hotshot missions ------------------------------------------------------
//
// The simplest mission type in the plan's table: any load, a hard deadline,
// 1.8x pay. Deliberately does NOT inflate `contract.payout` itself - that
// field is also what fleet.js adds to truck.earnings (gross revenue, feeds
// fleet-wide rankings/the digest for the other 9999 autopilot trucks), so
// baking the bonus into it would leak career-only pay into numbers that are
// supposed to mean the same thing for every truck. The bonus lives
// separately (`bonusPayout`) and is only ever added to `profile.cash`, on
// time, by the delivery-credit block in tickNeeds below.
const HOTSHOT_CHANCE = 0.35; // roughly 1 in 3 load-board refreshes offers one
const HOTSHOT_PAYOUT_MULT = 1.8;
const HOTSHOT_DEADLINE_SLACK_MULT = 1.35; // multiple of the route's own optimalHours - tight, but doable without reckless driving

// Marks at most one of a freshly generated set of load offers as a Hotshot
// - called by career-ui.js right after fetching offers from
// generateContractOffers, before rendering the board. Mutates in place
// (the offers are freshly generated objects nothing else references yet).
export function decorateHotshot(offers, rnd = Math.random) {
  if (!offers.length || rnd() > HOTSHOT_CHANCE) return;
  const o = offers[Math.floor(rnd() * offers.length)];
  o.hotshot = true;
  o.bonusPayout = Math.round(o.payout * (HOTSHOT_PAYOUT_MULT - 1));
  o.deadlineHours = Math.max(1, o.optimalHours * HOTSHOT_DEADLINE_SLACK_MULT);
}

function clamp01to100(v) { return Math.max(0, Math.min(100, v)); }

// --- progression: XP/levels, upgrades --------------------------------------
//
// XP is earned only from delivered payouts (base + any Hotshot bonus - see
// the delivery-credit block in tickNeeds), never from spending or buffs, so
// it can't be farmed by anything but actually hauling freight. Levels gate
// the pricier upgrade tiers below rather than doing anything themselves -
// there's no separate "unlock" system to duplicate.
const XP_PER_DOLLAR_EARNED = 0.025;
export const LEVEL_XP_THRESHOLDS = [0, 150, 400, 800, 1400, 2200, 3200, 4500, 6000, 8000, 10500];

function levelForXp(xp) {
  let level = 1;
  for (let i = 1; i < LEVEL_XP_THRESHOLDS.length; i++) {
    if (xp >= LEVEL_XP_THRESHOLDS[i]) level = i + 1;
  }
  return level;
}

// Upgrades store (MECHANIC vendor) - each is a multiplier createAgent's
// recompute() already reads from profile.upgrades (engine/aero/tires/
// sleeper), except TANK, which is a one-time direct bump to the truck's
// own fuelCapacity (not a multiplier - see fleet.js's Truck ctor comment on
// why a bigger tank must never be modeled by editing refuelAmountNeeded's
// floor), and RADAR, which career.js's own ticket-risk roll in tickNeeds
// reads directly. `costs`/`levelReq` are indexed by CURRENT tier (0-based),
// i.e. costs[0] is the price to go from tier 0 to tier 1.
export const UPGRADES = {
  ENGINE: { label: "Engine", field: "engine", maxTier: 3, costs: [1500, 3000, 5000], levelReq: [1, 3, 6] },
  TIRES: { label: "Tires", field: "tires", maxTier: 3, costs: [700, 1500, 2500], levelReq: [1, 2, 4] },
  SLEEPER: { label: "Sleeper Bunk", field: "sleeper", maxTier: 3, costs: [1000, 2000, 3200], levelReq: [1, 3, 5] },
  AERO: { label: "Aero Kit", field: "aero", maxTier: 1, costs: [1800], levelReq: [2] },
  TANK: { label: "Big Tank", field: "tank", maxTier: 1, costs: [2000], levelReq: [2] },
  RADAR: { label: "Radar Detector", field: "radar", maxTier: 1, costs: [2200], levelReq: [3] },
};
const TANK_UPGRADE_CAPACITY_BONUS = 40; // +40% over the stock 100-unit tank

function upgradeTier(def) {
  const v = profile.upgrades[def.field];
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

// Buys the NEXT tier of one upgrade for the given truck (needed only for
// TANK, which bumps the truck's real fuelCapacity rather than a profile
// multiplier). Returns {ok:false, reason} same shape as the other vendor
// actions, or {ok:true, cost}.
export function buyUpgrade(truck, key) {
  const def = UPGRADES[key];
  if (!def) return { ok: false, reason: "Unknown upgrade." };
  const tier = upgradeTier(def);
  if (tier >= def.maxTier) return { ok: false, reason: "Already maxed out." };
  if (profile.level < def.levelReq[tier]) return { ok: false, reason: `Requires level ${def.levelReq[tier]}.` };
  const cost = def.costs[tier];
  if (profile.cash < cost) return { ok: false, reason: "Can't afford it." };
  profile.cash -= cost;
  profile.stats.totalSpent += cost;
  if (def.maxTier === 1) profile.upgrades[def.field] = true;
  else profile.upgrades[def.field] = tier + 1;
  if (key === "TANK" && truck) truck.fuelCapacity += TANK_UPGRADE_CAPACITY_BONUS;
  if (truck?.agent) truck.agent.recompute();
  pushLog(`Installed ${def.label}${def.maxTier > 1 ? " Tier " + (tier + 1) : ""} for $${cost.toLocaleString()}.`);
  return { ok: true, cost };
}

// --- store / diner content ----------------------------------------------
//
// Every consumable has an immediate effect (applied once, at purchase) and
// an OPTIONAL timed buff (effects multiply into the agent's multipliers
// for its duration, then - if `crash` is set - a second immediate effect
// fires once on expiry). Buffs are looked up by `kind` at tick time rather
// than carrying closures, so a buff is plain, save-able data.
export const STORE_ITEMS = {
  COFFEE: { label: "Coffee", price: 3, immediate: { fatigue: -18 }, buffHours: 3, effects: {} },
  BOTTOMLESS_CUP: { label: "Bottomless Cup", price: 5, immediate: { fatigue: -30 }, buffHours: 4, effects: {} },
  ENERGY_DRINK: {
    label: "Energy Drink", price: 6, immediate: { fatigue: -35 }, buffHours: 4,
    effects: { speedMult: 1.06 }, crash: { fatigue: 20 },
  },
  TRUCKERS_CHOICE: {
    label: "Trucker's Choice", price: 40, repMin: 10, immediate: { fatigue: -70, health: -4, heat: 8 }, buffHours: 9,
    effects: {}, crash: { fatigue: 45 },
  },
  JERKY: { label: "Beef Jerky", price: 5, immediate: { hunger: 22, morale: 3 } },
  SUNFLOWER_SEEDS: { label: "Sunflower Seeds", price: 3, immediate: { hunger: 8, morale: 6 } },
  CANDY: { label: "Candy Bar", price: 4, immediate: { hunger: 10, morale: 4 } },
  SIX_PACK: {
    label: "Six-Pack", price: 12, parkedOnly: true, immediate: { morale: 25 }, buffHours: 6,
    effects: { fatigueMult: 0.9 }, dui: 0.35,
  },
  WHISKEY_PINT: {
    label: "Whiskey Pint", price: 22, parkedOnly: true, immediate: { morale: 40 }, buffHours: 10,
    effects: { fatigueMult: 0.75 }, dui: 0.7,
  },
  CIGARETTES: { label: "Cigarettes", price: 9, immediate: { morale: 8, health: -2 } },
  RADAR_DETECTOR: { label: "Radar Detector", price: 180, permanent: "radar", immediate: {} },
  ROAD_ATLAS: { label: "Road Atlas", price: 25, permanent: "atlas", immediate: {} },
  AUDIOBOOK: { label: "Audiobook", price: 15, permanent: "audiobook", immediate: { morale: 5 } },
  SLEEP_AID: { label: "Sleep Aid", price: 12, immediate: {}, buffHours: 10, effects: { restMult: 1.3 } },
  CB_ANTENNA: { label: "CB Antenna", price: 90, permanent: "cbAntenna", immediate: {} },
};

// DINER: three tiers, plus a regional headline pulled from whatever the
// city's own `ind` tags (data.js) suggest - reuses existing city data
// rather than inventing a parallel flavor table.
export const DINER_MENU = {
  FAST: { label: "Fast Bite", price: 8, hours: 0.25, immediate: { hunger: 30, morale: 2 } },
  SITDOWN: { label: "Sit-Down Plate", price: 18, hours: 1, immediate: { hunger: 55, morale: 12 } },
  BUFFET: { label: "All-You-Can-Eat", price: 14, hours: 1.25, immediate: { hunger: 80, morale: 8 } },
};

const REGIONAL_SPECIALS = [
  { tags: ["Port", "Seafood"], name: "the catch of the day" },
  { tags: ["Cattle", "Livestock", "Ranching"], name: "chicken-fried steak" },
  { tags: ["Ag", "Dairy", "Produce"], name: "biscuits and gravy" },
  { tags: ["Tourism", "Culture"], name: "the tourist-trap special" },
  { tags: ["Energy", "Oil", "Refinery"], name: "a roughneck breakfast" },
];
export function regionalSpecialFor(cityNode) {
  const tags = (cityNode && cityNode.ind) || [];
  for (const r of REGIONAL_SPECIALS) if (r.tags.some((t) => tags.includes(t))) return r.name;
  return "the daily special";
}

const SHOWER_PRICE = 14, SHOWER_HOURS = 0.5;
const SHOWER_FREE_FUEL_UNITS = 40; // fill this much or more at the same stop and the shower's free, same as a real truck stop loyalty perk

// Repair: cheap to keep clean, punishing to neglect - mirrors the real
// tradeoff (preventive maintenance vs. gambling on a roadside breakdown).
// No repair-cost precedent existed anywhere in the codebase before this;
// the curve below is this feature's own invention, tuned to feel fair
// against STARTING_CASH and typical per-load payouts (a few hundred to a
// couple thousand dollars).
export function repairCost(wear) { return Math.round(8 * wear + 0.6 * wear * wear); }

// --- the agent -----------------------------------------------------------
//
// One created per career truck (see startCareer). Everything fleet.js
// reads through the seam (speedMult/wearMult/burnMult/fatigueMult/
// restMult, stopReasonAt) lives here; everything career-ui.js reads for
// display lives on `profile` instead. `recompute()` folds throttle +
// upgrades + active buffs into the multipliers ONCE per change rather
// than recomputing them from scratch on every fleet.js call (cheap either
// way at one truck, but there's no reason not to cache).
export const THROTTLE_MULT = { CONSERVE: 0.88, LEGAL: 1.0, HAMMER: 1.18 };

export function createAgent(truck, profile) {
  const agent = {
    speedMult: 1, wearMult: 1, burnMult: 1, fatigueMult: 1, restMult: 1,
    pullInRequested: false,
    hammering: false, // read by fleet.js's HAMMER intimidation aura (applyFollowAndPassing) - kept as a plain flag rather than exposing profile.throttle itself, so fleet.js never has to know career's throttle naming

    recompute() {
      let speedMult = THROTTLE_MULT[profile.throttle] ?? 1;
      // HAMMER's extra speed doesn't come free: burns hotter and wears the
      // rig faster (on top of the ticket-heat risk tickNeeds rolls
      // separately). CONSERVE is the mirror image - a genuine fuel/wear
      // saving for the patience.
      let wearMult = profile.throttle === "HAMMER" ? 1.25 : profile.throttle === "CONSERVE" ? 0.9 : 1;
      let burnMult = profile.throttle === "HAMMER" ? 1.15 : profile.throttle === "CONSERVE" ? 0.9 : 1;
      let fatigueMult = 1, restMult = 1;
      // Upgrades (Phase 10 content - table is empty/no-op until upgrades exist)
      const up = profile.upgrades;
      if (up.engine >= 1) speedMult *= 1 + up.engine * 0.02;
      if (up.aero) burnMult *= 0.9;
      if (up.tires >= 1) wearMult *= 1 - up.tires * 0.15;
      if (up.sleeper >= 1) restMult *= 1 + up.sleeper * 0.25;
      // Active buffs
      for (const b of profile.buffs) {
        const e = b.effects || {};
        if (e.speedMult) speedMult *= e.speedMult;
        if (e.fatigueMult) fatigueMult *= e.fatigueMult;
        if (e.restMult) restMult *= e.restMult;
      }
      // Low morale makes for a tired, sloppy driver.
      if (profile.morale < 30) fatigueMult *= 1.15;
      if (profile.hunger < LOW_HUNGER_THRESHOLD) fatigueMult *= 1.1;
      this.speedMult = speedMult;
      this.wearMult = Math.max(0.1, wearMult);
      this.burnMult = burnMult;
      this.fatigueMult = fatigueMult;
      this.restMult = restMult;
      this.hammering = profile.throttle === "HAMMER";
    },

    // Pure (no mutation) - see fleet.js's nodeStopReason/arrivalSpeedCap,
    // both of which rely on that (arrivalSpeedCap calls this
    // SPECULATIVELY, every tick a career truck approaches ANY real city,
    // well before it actually arrives). Takes the actual node OBJECT
    // (both call sites resolve it before calling in) rather than just its
    // name, specifically so this can gate on tier: a tier-0 junction
    // filler node (the vast majority of nodes on any route) is never a
    // real town, so it can never be a "PLAYER" stop - without this, PULL
    // IN (and a critical-fuel stop) would park at the next node of ANY
    // kind, usually some unnamed junction, and arrivalSpeedCap's own
    // tier-0 bailout (this file's caller) means there's no deceleration
    // ramp for it either: the truck blows through at cruise and snaps to
    // 0 the instant it "arrives". Gating both branches on tier means a
    // truck critically low on fuel with no real town in reach can run
    // dry mid-edge - that already has a defined, billed outcome
    // (onDryTank's roadside tow) and is the honest one, not a bug to
    // route around here.
    stopReasonAt(node) {
      if (!node || node.t === 0) return null;
      if (truck.fuel <= CRITICAL_FUEL_PCT) return "PLAYER";
      if (this.pullInRequested) return "PLAYER";
      return null;
    },

    onFuelPurchased(cost, units) {
      profile.cash -= cost;
      profile.stats.totalSpent += cost;
      profile.stats.fuelUnitsBought += units;
    },

    // Ran fully dry mid-edge (CRITICAL_FUEL_PCT's advance warning was
    // missed or ignored) - fleet.js's roadside-tow path bills this to
    // whichever wallet the truck actually has, same split as
    // onFuelPurchased: the career ledger for an agent truck, not the
    // gross-revenue truck.earnings an ordinary AI truck pays it from.
    onDryTank(cost) {
      profile.cash -= cost;
      profile.stats.totalSpent += cost;
      pushLog(`Ran dry and got towed in - $${cost.toLocaleString()} roadside bill.`);
    },
  };
  agent.recompute();
  return agent;
}

function newProfile() {
  return {
    version: CAREER_SAVE_VERSION,
    active: false,
    truckId: null,
    homeCity: null,
    truckName: "Rig",
    cash: STARTING_CASH,
    xp: 0,
    level: 1,
    reputation: 0,
    hunger: 80,
    morale: 70,
    heat: 0,
    health: 100,
    wear: 0,
    throttle: "LEGAL",
    upgrades: { engine: 0, aero: false, tires: 0, sleeper: 0, tank: 0, apu: false, radar: false, atlas: false, audiobook: false, cbAntenna: false },
    buffs: [], // [{ id, kind, label, expiresAtGameSeconds, effects }]
    endorsements: { hazmat: false, oversize: false, tanker: false, doubles: false },
    // Deliveries/earnings/miles for the truck CURRENTLY being driven live
    // on that Truck object itself (contractsCompleted/earnings/
    // totalMilesDriven - fleet.js) and are read directly from there (see
    // career-ui.js's renderCareerTab) rather than duplicated here, which
    // would just be a second number that can drift out of sync. This
    // stats block holds only what genuinely has nowhere else to live:
    // rescues and DUI/ticket counts persist across a truck's whole
    // career (a fresh truck after a breakdown/upgrade doesn't reset
    // them), and onTimeDeliveries/fuelUnitsBought exist for Phase 9/10
    // missions and progression, which don't exist yet.
    stats: { onTimeDeliveries: 0, rescues: 0, ticketsReceived: 0, duiCount: 0, totalSpent: 0, fuelUnitsBought: 0, hotshotBonusEarned: 0 },
    missions: [],
    completedMissionIds: [],
    nextHiredId: 1, // Phase 11: hired trucks get string ids "H-1", "H-2", ... from THIS counter, never fleet.js's own numeric nextId - see the plan's "Hired Fleet ID Namespace" note
    hiredTrucks: [],
    lastSettlementGameSeconds: null, // lazily set to the first gameSeconds checkSettlement() ever sees (career start OR a just-loaded save) - see checkSettlement's own doc comment
    log: [], // recent toast-worthy events, capped - see pushLog
  };
}

let profile = newProfile();
let buffIdCounter = 1;
// Tracks the last contract object credited to cash, by reference. A
// delivery leaves `truck.contract` pointing at the just-completed load
// (see fleet.js's _arriveAtDestination comment) until the player accepts
// the next one, so tickNeeds fires many times against the same contract
// while parked at BOARD - comparing by reference makes crediting exactly
// idempotent with no separate "already paid" flag to thread through
// save/load.
let lastCreditedContract = null;

export function getProfile() { return profile; }
export function isActive() { return profile.active; }
export function getCareerTruckId() { return profile.truckId; }

const LOG_CAP = 30;
function pushLog(text) {
  profile.log.unshift({ text, at: Date.now() });
  if (profile.log.length > LOG_CAP) profile.log.length = LOG_CAP;
}
export function drainRecentLog() {
  // career-ui.js's toast layer calls this once per check and only shows
  // entries it hasn't shown yet; log itself is left intact (it's also the
  // Career tab's activity feed) - this just marks a read cursor.
  return profile.log;
}

// --- lifecycle -------------------------------------------------------------

export function startCareer(truck, graph) {
  truck.agent = createAgent(truck, profile);
  profile.active = true;
  profile.truckId = truck.id;
  profile.homeCity = truck.currentNode;
  profile.truckName = truck.name;
  lastCreditedContract = null;
  pushLog(`Signed on as an owner-operator out of ${truck.currentNode}.`);
}

// Re-attaches an already-restored profile (via load()) to a freshly spawned
// truck. Unlike startCareer, this must NOT touch cash/stats/homeCity/
// truckName - those came back from the save and are exactly what makes it
// a continuation rather than a new career. The truck itself never
// survives a reload (see load()'s doc comment), so the caller picks
// whichever fresh Truck instance stands in for "you" this session; its
// own position/contract are unrelated to wherever the save last left off.
export function reattachTruck(truck) {
  truck.agent = createAgent(truck, profile);
  profile.active = true;
  profile.truckId = truck.id;
  lastCreditedContract = null;
  pushLog(`Back behind the wheel out of ${truck.currentNode}.`);
}

// Detaches career control from a truck without discarding the profile
// (cash/upgrades/stats persist - see save()) - used when a save is
// restored onto a fresh fleet and the original truck instance is gone.
export function detachAgent(truck) {
  if (truck) truck.agent = null;
}

// --- per-frame tick (LIVE driving only - fastForwardHours' own substeps
// call this too, via the onSubstep hook passed from sleep()/advance()) ---

function expireBuffs(gameSeconds, truck) {
  const before = profile.buffs.length;
  profile.buffs = profile.buffs.filter((b) => {
    if (b.expiresAtGameSeconds > gameSeconds) return true;
    const item = STORE_ITEMS[b.kind];
    if (item && item.crash) applyImmediate(item.crash, truck);
    pushLog(`The ${b.label.toLowerCase()} wore off.`);
    return false;
  });
  return profile.buffs.length !== before;
}

function applyImmediate(effects, truck) {
  if (!effects) return;
  if (effects.fatigue && truck) truck.fatigue = Math.max(0, Math.min(100, truck.fatigue + effects.fatigue));
  if (effects.hunger != null) profile.hunger = clamp01to100(profile.hunger + effects.hunger);
  if (effects.morale != null) profile.morale = clamp01to100(profile.morale + effects.morale);
  if (effects.health != null) profile.health = clamp01to100(profile.health + effects.health);
  if (effects.heat != null) profile.heat = clamp01to100(profile.heat + effects.heat);
}

// Called once per real (unpaused, non-truck-stop) frame by main.js when
// career mode is active, and once per fastForwardHours substep during a
// truck-stop wait/sleep - the one place profile needs (hunger decay, heat
// cooldown, buff expiry, multiplier recompute) actually advance with the
// clock, regardless of whether time is passing live or fast-forwarded.
export function tickNeeds(truck, gameHours, gameSeconds, rnd = Math.random) {
  profile.hunger = clamp01to100(profile.hunger - gameHours * HUNGER_DECAY_PER_HOUR);
  if (profile.hunger < LOW_HUNGER_THRESHOLD) profile.morale = clamp01to100(profile.morale - gameHours * 2);
  profile.heat = clamp01to100(profile.heat - gameHours * HEAT_COOLDOWN_PER_HOUR);
  // wearMult means "wears faster" everywhere else it's used (fleet.js
  // multiplies it straight into the breakdown-probability roll) - it must
  // be multiplied here too, not divided. HAMMER (wearMult 1.25) should
  // accelerate wear, not slow it down.
  profile.wear = clamp01to100(profile.wear + gameHours * 0.15 * (truck?.agent?.wearMult ?? 1));
  // Ticket heat: HAMMER attracts attention while actually driving (not
  // parked, not idling at a stop - `truck.edge` is only set while
  // underway). It cools on its own the rest of the time via the line
  // above. High sustained heat carries a real, escalating chance per hour
  // of getting pulled over - the fine scales with how hot you were, and
  // getting caught resets most of the heat (you've paid for it).
  if (truck?.agent && truck.edge && profile.throttle === "HAMMER") {
    profile.heat = clamp01to100(profile.heat + gameHours * HEAT_BUILD_PER_HOUR_HAMMER);
  }
  if (truck?.agent && truck.edge && profile.heat > 40) {
    // Radar detector (Phase 10 upgrade): -45% ticket risk, applied here
    // rather than as an agent multiplier since it affects a probability
    // roll, not a physical quantity fleet.js reads.
    const radarMult = profile.upgrades.radar ? 0.55 : 1;
    const chancePerHour = Math.pow(profile.heat / 100, 2) * TICKET_CHANCE_PER_HOUR_AT_MAX_HEAT * radarMult;
    if (rnd() < chancePerHour * gameHours) {
      const fine = TICKET_FINE_BASE + Math.round(profile.heat * 4);
      profile.cash -= fine;
      profile.stats.totalSpent += fine;
      profile.stats.ticketsReceived++;
      profile.heat = clamp01to100(profile.heat - 55);
      pushLog(`Pulled over doing ${Math.round(truck.speed)} mph - $${fine.toLocaleString()} ticket.`);
    }
  }
  expireBuffs(gameSeconds, truck);
  // Delivery payout -> spendable cash. truck.earnings (gross, fleet-wide)
  // is already credited by fleet.js's _arriveAtDestination; this is the
  // separate career ledger (see the Money section of the design doc).
  // stopVendor "BOARD" is specifically what _arriveAtDestination sets on a
  // completed delivery (a fuel/pull-in stop parks with stopReason
  // "PLAYER" too, but stopVendor "PUMPS" - checking stopReason alone would
  // wrongly credit the truck's very first, not-yet-delivered contract the
  // moment it pulls in for fuel). `truck.contract` keeps pointing at the
  // just-completed load until the player accepts the next one (takeOffer
  // clears stopVendor), so the reference comparison against
  // lastCreditedContract is what makes this exactly-once despite tickNeeds
  // firing every frame/substep while parked at that stop.
  if (truck && truck.stopVendor === "BOARD" && truck.contract && truck.contract !== lastCreditedContract) {
    lastCreditedContract = truck.contract;
    const c = truck.contract;
    profile.cash += c.payout;
    if (c.hotshot) {
      const onTime = c.deadlineGameSeconds != null && gameSeconds <= c.deadlineGameSeconds;
      if (onTime) {
        profile.cash += c.bonusPayout;
        profile.stats.onTimeDeliveries++;
        profile.stats.hotshotBonusEarned += c.bonusPayout;
        pushLog(`HOTSHOT delivered on time — collected $${Math.round(c.payout).toLocaleString()} + $${c.bonusPayout.toLocaleString()} bonus.`);
      } else {
        pushLog(`HOTSHOT missed its deadline — still collected the base $${Math.round(c.payout).toLocaleString()}, no bonus.`);
      }
    } else {
      pushLog(`Delivered ${c.cargo} — collected $${Math.round(c.payout).toLocaleString()}.`);
    }
    // XP only from what was actually earned (base + any on-time Hotshot
    // bonus, both already added to cash above) - never from spending, buffs
    // or tickets, so it can't be farmed by anything but hauling freight.
    const earnedThisDelivery = c.payout + (c.hotshot && c.deadlineGameSeconds != null && gameSeconds <= c.deadlineGameSeconds ? c.bonusPayout : 0);
    profile.xp += Math.round(earnedThisDelivery * XP_PER_DOLLAR_EARNED);
    const newLevel = levelForXp(profile.xp);
    if (newLevel > profile.level) {
      profile.level = newLevel;
      pushLog(`Leveled up to ${newLevel} - new upgrade tiers unlocked at the Mechanic.`);
    }
  }
  if (truck?.agent) truck.agent.recompute();
}

// Sweeps each hired truck's net-new earnings (since its own last
// settlement) into profile.cash, minus SETTLEMENT_OVERHEAD_PCT -
// insurance/permits/the truck payment, the ongoing cost of OWNING a rig
// rather than driving one yourself. Runs once per SETTLEMENT_INTERVAL_HOURS
// of elapsed GAME time - checked from both the live per-frame tick (main.js)
// and advanceTime's onSubstep below, so a week that passes entirely inside
// one long sleep still pays out instead of waiting for the player to wake
// up first. `trucks` is only ever used here to look up the handful of ids
// already recorded in profile.hiredTrucks by id - never scanned/iterated
// for its own sake (career.js otherwise stays out of the fleet array
// entirely; see confirmHire's doc comment on that split).
export function checkSettlement(gameSeconds, trucks) {
  if (profile.lastSettlementGameSeconds == null) {
    profile.lastSettlementGameSeconds = gameSeconds; // first check since career start/load - nothing to settle yet, just start the clock
    return;
  }
  if (gameSeconds - profile.lastSettlementGameSeconds < SETTLEMENT_INTERVAL_HOURS * 3600) return;
  profile.lastSettlementGameSeconds = gameSeconds;
  if (!profile.hiredTrucks.length) return;

  let totalTake = 0;
  for (const entry of profile.hiredTrucks) {
    const t = trucks.find((x) => x.id === entry.id);
    if (!t) continue; // hired trucks are never removed from the live fleet, but never let a stale record throw
    const gross = t.earnings - (entry.lastSettledEarnings ?? 0);
    entry.lastSettledEarnings = t.earnings;
    if (gross <= 0) continue; // a rough week (tows/fines already came straight out of t.earnings - see pumpFuel/dry-tank) - nothing to collect, and nothing to claw back either
    totalTake += gross * (1 - SETTLEMENT_OVERHEAD_PCT);
  }
  if (totalTake > 0) {
    profile.cash += totalTake;
    profile.stats.fleetEarningsCollected = (profile.stats.fleetEarningsCollected ?? 0) + totalTake;
    pushLog(`Weekly settlement: collected $${Math.round(totalTake).toLocaleString()} from your company, net of overhead.`);
  }
}

// Wraps fastForwardHours with tickNeeds wired through onSubstep - the
// ONE path DINER/SHOWERS/SLEEPER all use to actually let time (and the
// rest of the fleet) pass while the player eats/showers/sleeps. See the
// module doc comment at the top of this file for why this can never be a
// flat clock add.
export function advanceTime(graph, trucks, weatherCells, truck, gameSeconds, hours, opts = {}) {
  return fastForwardHours(graph, trucks, weatherCells, gameSeconds, hours, {
    ...opts,
    onSubstep: (gs, stepHours) => {
      tickNeeds(truck, stepHours, gs, opts.rnd);
      checkSettlement(gs, trucks);
      if (opts.onSubstep) opts.onSubstep(gs, stepHours);
    },
  });
}

// --- store / diner / shower / mechanic actions ----------------------------

export function maxAffordableFuelUnits(truck, pricePerUnit) {
  const room = truck.fuelCapacity - truck.fuel;
  const affordable = profile.cash / pricePerUnit;
  return Math.max(0, Math.min(room, affordable));
}

export function buyStoreItem(truck, itemKind) {
  const item = STORE_ITEMS[itemKind];
  if (!item) return { ok: false, reason: "No such item." };
  if (item.parkedOnly && truck.edge) return { ok: false, reason: "Parked only." };
  if (item.repMin != null && profile.reputation < item.repMin) return { ok: false, reason: "Reputation too low." };
  if (profile.cash < item.price) return { ok: false, reason: "Can't afford it." };

  profile.cash -= item.price;
  profile.stats.totalSpent += item.price;
  applyImmediate(item.immediate, truck);

  if (item.permanent) {
    profile.upgrades[item.permanent] = true;
  }
  if (item.buffHours) {
    profile.buffs.push({
      id: buffIdCounter++,
      kind: itemKind,
      label: item.label,
      expiresAtGameSeconds: null, // set by the caller (career-ui.js knows current gameSeconds); see setBuffExpiry
      effects: item.effects || {},
    });
  }
  if (item.dui && Math.random() < item.dui * (profile.upgrades.radar ? 0.5 : 1)) {
    profile.stats.duiCount++;
    profile.heat = clamp01to100(profile.heat + 35);
    pushLog(`Cutting it close with the bottle tonight - heat's up.`);
  }
  if (truck.agent) truck.agent.recompute();
  pushLog(`Bought ${item.label} for $${item.price}.`);
  return { ok: true };
}

// buyStoreItem can't know "now" (career.js is deliberately clock-agnostic -
// see the fastForward design note), so the caller stamps the just-added
// buff's expiry immediately after. Small, but keeps career.js from ever
// needing to read state.gameSeconds itself.
export function stampLatestBuffExpiry(gameSeconds, hours) {
  const b = profile.buffs[profile.buffs.length - 1];
  if (b && b.expiresAtGameSeconds == null) b.expiresAtGameSeconds = gameSeconds + hours * 3600;
}

export function eatAtDiner(truck, tier) {
  const item = DINER_MENU[tier];
  if (!item) return { ok: false, reason: "No such meal." };
  if (profile.cash < item.price) return { ok: false, reason: "Can't afford it." };
  profile.cash -= item.price;
  profile.stats.totalSpent += item.price;
  applyImmediate(item.immediate, truck);
  pushLog(`Had ${item.label.toLowerCase()} for $${item.price}.`);
  return { ok: true, hours: item.hours };
}

export function takeShower(fuelUnitsThisStop) {
  const free = fuelUnitsThisStop >= SHOWER_FREE_FUEL_UNITS;
  if (!free) {
    if (profile.cash < SHOWER_PRICE) return { ok: false, reason: "Can't afford it." };
    profile.cash -= SHOWER_PRICE;
    profile.stats.totalSpent += SHOWER_PRICE;
  }
  profile.morale = clamp01to100(profile.morale + 15);
  pushLog(free ? "Free shower - filled up enough for it." : `Showered for $${SHOWER_PRICE}.`);
  return { ok: true, hours: SHOWER_HOURS, free };
}

export function repairAtMechanic(truck) {
  const cost = repairCost(profile.wear);
  if (profile.wear < 1) return { ok: false, reason: "Nothing to fix." };
  if (profile.cash < cost) return { ok: false, reason: "Can't afford it." };
  profile.cash -= cost;
  profile.stats.totalSpent += cost;
  profile.wear = 0;
  pushLog(`Mechanic patched up the rig for $${cost}.`);
  return { ok: true, cost };
}

// --- ending a stop -----------------------------------------------------

// Mid-route "PLAYER" stop (fuel-safety or a voluntary pull-in) → resume
// the existing route. Returns whatever fleet.js's resumeFromPlayerStop
// returns: the truck itself if a junction choice is now pending (the
// caller, main.js, should show the decision panel exactly as it would
// for any other controlled truck), or null if it just departed cleanly.
export function rollOut(graph, truck) {
  if (truck.agent) truck.agent.pullInRequested = false;
  pushLog(`Rolled out of ${truck.currentNode}.`);
  return resumeFromPlayerStop(graph, truck);
}

// Delivery-triggered "PLAYER" stop → the player picked a load on the
// BOARD vendor. Mirrors main.js's existing resolveContract exactly
// (truck._takeContract(graph, offer, null) from a synchronous UI
// handler, laneGroups=null for the same reason documented on
// resumeFromPlayerStop). `gameSeconds` is only used to stamp a Hotshot's
// absolute deadline - an ordinary load doesn't need it and callers that
// omit it just never produce a hotshot deadline (still take the load fine).
export function takeOffer(graph, truck, offer, gameSeconds) {
  truck.stopVendor = null;
  truck._takeContract(graph, offer, null);
  if (offer.hotshot && gameSeconds != null) {
    offer.deadlineGameSeconds = gameSeconds + offer.deadlineHours * 3600;
    pushLog(`Took on HOTSHOT ${offer.cargo} bound for ${offer.destination} - ${offer.deadlineHours.toFixed(1)}h to deliver for the $${offer.bonusPayout.toLocaleString()} bonus.`);
  } else {
    pushLog(`Took on ${offer.cargo} bound for ${offer.destination}.`);
  }
}

// --- fleet ownership (Phase 11) ------------------------------------------
//
// Hiring a driver spawns a real, ordinary AI-piloted Truck into the live
// `trucks` array - but this module never touches that array (see the
// header doc comment: it must stay safe to import with no window/document
// and no fleet reference at all). So the split is: career.js rolls the
// candidate driver, checks eligibility, deducts cash, and allocates the
// "H-N" id (bookkeeping only, no truck object exists yet); main.js is the
// one that actually calls `new Truck(...)`, stamps that id onto it, and
// pushes it into the live array - the same division of labor as
// startCareer/reattachTruck already have with the truck main.js supplies.
export const HIRE_COST = 8000;
export const HIRE_MIN_LEVEL = 5;

export function canHire() {
  return profile.level >= HIRE_MIN_LEVEL && profile.cash >= HIRE_COST;
}

// Pure - rolls a candidate driver to show the player (traits and all)
// BEFORE any commitment. Call again to reroll; nothing is spent or
// recorded until confirmHire() is called with the driver the player
// actually picks.
export function rollHireCandidate(rnd = Math.random) {
  return new DriverDNA(rnd);
}

// Commits to hiring the given (already-rolled) driver: deducts cash,
// allocates the next "H-N" id from profile.nextHiredId (a separate counter
// from fleet.js's own numeric nextId - see the plan's "hired fleet id
// namespace" note reproduced on the profile.nextHiredId field itself),
// and records it in profile.hiredTrucks for the Career tab's "Your
// Company" section. Returns {ok:true, id, driver} for main.js to actually
// spawn, or {ok:false, reason}.
export function confirmHire(driver) {
  if (profile.level < HIRE_MIN_LEVEL) return { ok: false, reason: `Requires level ${HIRE_MIN_LEVEL}.` };
  if (profile.cash < HIRE_COST) return { ok: false, reason: "Can't afford it." };
  profile.cash -= HIRE_COST;
  profile.stats.totalSpent += HIRE_COST;
  const id = `H-${profile.nextHiredId++}`;
  profile.hiredTrucks.push({ id, hiredAtGameSeconds: null, lastSettledEarnings: 0 });
  pushLog(`Hired a new driver for $${HIRE_COST.toLocaleString()} - dispatched as ${id}.`);
  return { ok: true, id, driver };
}

// --- save / load ---------------------------------------------------------

const SAVE_KEY = "interstate-fleet-career-v1";

export function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(profile));
    return true;
  } catch (e) {
    return false; // quota exceeded, private mode, etc. - never throw out of a save attempt
  }
}

export function hasSave() {
  try { return localStorage.getItem(SAVE_KEY) != null; } catch (e) { return false; }
}

// Loads the profile only (cash/upgrades/stats/buffs/missions) - does NOT
// resume driving a truck, since the truck instance from a previous
// session no longer exists (bootSim/page reload respawns the whole fleet
// with fresh ids - see the plan's id-collision note). The caller
// (main.js) is responsible for spawning/attaching a fresh Truck and
// calling startCareer-equivalent wiring against the restored profile.
// Precondition: only call this while !isActive() - like deleteSave, this
// reassigns the module-level `profile` binding wholesale, which would
// orphan any truck.agent already closed over the previous object (see
// deleteSave's doc comment for the full failure mode).
export function load() {
  let raw;
  try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
  if (!raw) return false;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return false; }
  if (!parsed || parsed.version !== CAREER_SAVE_VERSION) return false; // reject unknown/future versions cleanly rather than guess at a shape
  profile = parsed;
  profile.active = false; // the truck itself never survives a reload - see this function's own doc comment
  profile.truckId = null;
  return true;
}

// Wipes the persisted snapshot only - it must NOT reassign the live
// `profile` binding while a career is active. createAgent(truck, profile)
// closes over the exact object passed to it, not the module-level `let
// profile` slot, so a truck's agent already in play would otherwise keep
// billing an orphaned object forever while every other career.js function
// (tickNeeds, buyStoreItem, ...) moved on to the new one - purchases would
// silently stop reaching the ledger the Career tab actually displays. If
// no career is currently running, there's nothing live to protect, and
// resetting profile here doubles as "start clean" for the next one.
export function deleteSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  if (!profile.active) profile = newProfile();
}
