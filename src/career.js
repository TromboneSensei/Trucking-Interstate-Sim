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
const LONG_HAUL_BOREDOM_MILES = 400; // legs shorter than this don't grind on morale at all
const LONG_HAUL_MORALE_DECAY_PER_HOUR = 0.6; // ~a full night's rest worth of morale over one long haul, halved+ by the Audiobook upgrade

// Reputation (profile.reputation) previously had exactly one reader
// (STORE_ITEMS.TRUCKERS_CHOICE's repMin gate) and zero sources - it could
// never move off 0, which made that gate permanently closed. These are its
// sources: delivering earns it, getting caught (a ticket, a DUI) or
// blowing a Hotshot deadline spends it.
const REP_GAIN_DELIVERY = 1;
const REP_GAIN_HOTSHOT_ON_TIME = 3;
const REP_LOSS_HOTSHOT_MISSED = 3;
const REP_LOSS_TICKET = 2;
const REP_LOSS_DUI = 3;

// Health (profile.health) previously only ever went DOWN (Trucker's
// Choice, Cigarettes) with nothing reading it beyond the RIG vitals
// display. Below this threshold it makes fatigue worse AND puts a real
// ceiling on morale (see recompute()'s fatigueMult and tickNeeds' cap
// below) - so letting it slide has a cost beyond a sad number in a bar.
const LOW_HEALTH_THRESHOLD = 50;
const LOW_HEALTH_FATIGUE_MULT = 1.2;
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
//
// RADAR is a tier 2, not a duplicate of the STORE's own Radar Detector -
// this used to set the exact same profile.upgrades.radar flag as the $180
// store item, so buying the $2,200 mechanic version did nothing the $180
// one hadn't already done. Now it's a separate field gated on the basic
// one already being owned (`requires`), and its own, stronger multipliers
// (RADAR_TIER2_TICKET_MULT/RADAR_TIER2_DUI_MULT below) - a real second
// purchase with a real second effect, not the same flag twice.
export const UPGRADES = {
  ENGINE: { label: "Engine", field: "engine", maxTier: 3, costs: [1500, 3000, 5000], levelReq: [1, 3, 6] },
  // Tires' wear-reduction used to compound against repairCost's own quadratic
  // curve into a much bigger real-dollar benefit than the -45%/$4,700 sticker
  // suggested - cut both the per-tier price break and the per-tier effect.
  TIRES: { label: "Tires", field: "tires", maxTier: 3, costs: [900, 1900, 3200], levelReq: [1, 2, 4] },
  // Sleeper Bunk tier 3 + APU used to stack to a 2.01x restMult for $8,600 -
  // close to halving fatigue management outright for under 5 loads' cash.
  // Slower per-tier costs/effects here; APU's own price+effect below.
  SLEEPER: { label: "Sleeper Bunk", field: "sleeper", maxTier: 3, costs: [1200, 2600, 4200], levelReq: [1, 3, 5] },
  AERO: { label: "Aero Kit", field: "aero", maxTier: 1, costs: [1800], levelReq: [2] },
  TANK: { label: "Big Tank", field: "tank", maxTier: 1, costs: [2000], levelReq: [2] },
  APU: { label: "Auxiliary Power Unit", field: "apu", maxTier: 1, costs: [3200], levelReq: [3] },
  // Scanner Suite's price/effect rebalanced alongside the Store's basic
  // Radar Detector below - see RADAR_TIER2_TICKET_MULT/RADAR_TIER2_DUI_MULT.
  RADAR: { label: "Scanner Suite", field: "radarTier2", maxTier: 1, costs: [3600], levelReq: [3], requires: "radar", requiresLabel: "the Radar Detector (Store)" },
};
export const TANK_UPGRADE_CAPACITY_BONUS = 40; // +40% over the stock 100-unit tank
// Radar Detector (Store, $220 - profile.upgrades.radar) is the basic tier.
// Scanner Suite (Mechanic, $3,600 - profile.upgrades.radarTier2, requires
// the basic one already owned) is strictly better and supersedes it -
// tickNeeds/buyStoreItem below check radarTier2 first, falling back to the
// basic mult only when it isn't owned. The full stack used to cost $2,380
// for a ~75%/70% ticket/DUI cut - close to erasing HAMMER's only real
// deterrent for 1-2 loads' cash. Rebalanced to $3,820 for ~55%, still the
// best deterrent-softener in the game, no longer near-total.
export const RADAR_TICKET_MULT = 0.55;
export const RADAR_DUI_MULT = 0.5;
export const RADAR_TIER2_TICKET_MULT = 0.45;
export const RADAR_TIER2_DUI_MULT = 0.45;

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
  if (def.requires && !profile.upgrades[def.requires]) return { ok: false, reason: `Requires ${def.requiresLabel} first.` };
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
// `cat` groups the store shelf for display (career-ui.js's SUPPLIES vendor):
// CAFFEINE / FOOD / BOOZE / GEAR - a flat 15-item grid otherwise makes the
// player scroll past everything to find one thing.
export const STORE_ITEMS = {
  // Coffee/Bottomless Cup used to share the same fatigue-per-dollar rate, so
  // Cup strictly dominated Coffee for $2 more with zero downside on either -
  // Coffee is now the best $/relief no-frills staple, Cup a real (if small)
  // sustained effect during its buff instead of just "more coffee."
  COFFEE: { label: "Coffee", price: 3, cat: "CAFFEINE", immediate: { fatigue: -20 }, buffHours: 3, effects: {} },
  BOTTOMLESS_CUP: { label: "Bottomless Cup", price: 5, cat: "CAFFEINE", immediate: { fatigue: -28 }, buffHours: 4, effects: { fatigueMult: 0.95 } },
  ENERGY_DRINK: {
    label: "Energy Drink", price: 6, cat: "CAFFEINE", immediate: { fatigue: -35 }, buffHours: 4,
    effects: { speedMult: 1.06 }, crash: { fatigue: 20 },
  },
  // Was priced UNDER Motel ($60, full fatigue clear + morale/hunger) despite
  // being spammable with no cooldown - now correctly the pricier "emergency,
  // no stop needed" option rather than a strictly-better default.
  TRUCKERS_CHOICE: {
    label: "Trucker's Choice", price: 85, cat: "CAFFEINE", repMin: 10, immediate: { fatigue: -70, health: -4, heat: 8 }, buffHours: 9,
    effects: {}, crash: { fatigue: 45 },
  },
  JERKY: { label: "Beef Jerky", price: 5, cat: "FOOD", immediate: { hunger: 22, morale: 3 } },
  SUNFLOWER_SEEDS: { label: "Sunflower Seeds", price: 3, cat: "FOOD", immediate: { hunger: 8, morale: 6 } },
  CANDY: { label: "Candy Bar", price: 4, cat: "FOOD", immediate: { hunger: 10, morale: 4 } },
  SIX_PACK: {
    label: "Six-Pack", price: 12, cat: "BOOZE", parkedOnly: true, immediate: { morale: 25 }, buffHours: 6,
    effects: { fatigueMult: 0.9 }, dui: 0.35,
  },
  WHISKEY_PINT: {
    label: "Whiskey Pint", price: 22, cat: "BOOZE", parkedOnly: true, immediate: { morale: 40 }, buffHours: 10,
    effects: { fatigueMult: 0.75 }, dui: 0.7,
  },
  CIGARETTES: { label: "Cigarettes", price: 9, cat: "BOOZE", immediate: { morale: 8, health: -2 } },
  RADAR_DETECTOR: { label: "Radar Detector", price: 220, cat: "GEAR", permanent: "radar", immediate: {} },
  ROAD_ATLAS: { label: "Road Atlas", price: 25, cat: "GEAR", permanent: "atlas", immediate: {} },
  AUDIOBOOK: { label: "Audiobook", price: 15, cat: "GEAR", permanent: "audiobook", immediate: { morale: 5 } },
  SLEEP_AID: { label: "Sleep Aid", price: 12, cat: "GEAR", immediate: {}, buffHours: 10, effects: { restMult: 1.3 } },
  CB_ANTENNA: { label: "CB Antenna", price: 90, cat: "GEAR", permanent: "cbAntenna", immediate: {} },
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
// A real bed genuinely beats the bunk - previously the $60 motel just
// called the same advanceTime(8) a free 8h nap would, with nothing to
// show for the money. Now it clears fatigue completely (a nap only ever
// projects down toward 0, never guaranteed to reach it - see career-ui.js's
// REST tab preview) and tops up morale/hunger well past what a nap alone
// touches at all.
const MOTEL_PRICE = 60, MOTEL_HOURS = 8;
const MOTEL_MORALE_BONUS = 30;
const MOTEL_HUNGER_BONUS = 25;

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
      if (up.tires >= 1) wearMult *= 1 - up.tires * 0.10;
      if (up.sleeper >= 1) restMult *= 1 + up.sleeper * 0.15;
      if (up.apu) restMult *= 1.10; // Auxiliary Power Unit - idle-free climate control, better sleep quality
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
      if (profile.health < LOW_HEALTH_THRESHOLD) fatigueMult *= LOW_HEALTH_FATIGUE_MULT;
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

// Pure graph-walking helper for RIG's PULL IN button subtitle - names the
// next REAL town (tier > 0) ahead on the truck's route, mirroring
// stopReasonAt's own "tier-0 is junction filler, never a real stop" gate
// so the button never promises a stop at an unnamed interchange. Walks the
// truck's current edge first, then its queued remainingPath; returns null
// once the route genuinely has no real town left in it.
export function nextPullInStopCity(graph, truck) {
  if (!truck.edge) return null;
  for (const e of [truck.edge, ...truck.remainingPath]) {
    const node = graph.nodes[e.to];
    if (node && node.t > 0) return e.to;
  }
  return null;
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
    upgrades: { engine: 0, aero: false, tires: 0, sleeper: 0, tank: 0, apu: false, radar: false, radarTier2: false, atlas: false, audiobook: false, cbAntenna: false },
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

// Fleet command (Phase 12): free, instant switch between the truck the
// player is currently driving and any other live truck - an already-hired
// driver, or an ordinary AI truck being taken over for the first time.
//
// Demotes `oldTruck` to an ordinary AI-driven hired truck (it keeps
// whatever contract it's mid-haul on and just carries on running it),
// promotes `newTruck` to the player's seat, and - if `newTruck` was already
// a hired driver - settles its unpaid earnings first so nothing accrued
// since its last weekly settlement is silently forfeited the instant it's
// taken over (the same 15% overhead cut checkSettlement's own weekly pass
// takes, applied once here at the moment of the switch instead).
//
// `truck.driver` (DriverDNA) is deliberately NOT reset or swapped on
// either truck - the player inherits `newTruck`'s own specific handling
// (skill/aggression/fuelBurnMult/accel/decel), with profile.upgrades/
// throttle layered on top via agent.recompute() exactly as before. Taking
// over a rookie's truck genuinely handles like a rookie's truck; this is
// the intended two-layer model, not a gap to close.
//
// Known, accepted gap: a demoted truck that was never hired keeps its
// original numeric id, not an "H-" one - it quietly falls outside
// fleet.js's isCompanyTruck string-prefix check (rankings/digest-award
// exclusion only). Not worth a truck-id migration for this; the map beacon
// (once it lands) sidesteps it entirely via Set-membership against
// profile.truckId/hiredTrucks instead of id prefix.
export function switchActiveTruck(oldTruck, newTruck, gameSeconds) {
  if (oldTruck) {
    oldTruck.agent = null;
    profile.hiredTrucks.push({ id: oldTruck.id, hiredAtGameSeconds: gameSeconds, lastSettledEarnings: oldTruck.earnings });
    pushLog(`Handed the wheel of ${oldTruck.name} off to autopilot.`);
  }

  const hiredIdx = profile.hiredTrucks.findIndex((h) => h.id === newTruck.id);
  if (hiredIdx >= 0) {
    const entry = profile.hiredTrucks[hiredIdx];
    const gross = newTruck.earnings - (entry.lastSettledEarnings ?? 0);
    if (gross > 0) profile.cash += gross * (1 - SETTLEMENT_OVERHEAD_PCT);
    profile.hiredTrucks.splice(hiredIdx, 1);
  }

  newTruck.agent = createAgent(newTruck, profile);
  profile.truckId = newTruck.id;
  profile.truckName = newTruck.name;
  lastCreditedContract = null;
  // Verified real risk (fleet.js's BREAKDOWN_PER_MILE), not speculative: a
  // hired truck that's been running a long time without a real stop
  // carries inflated breakdown odds the instant it's taken over - the same
  // reset every other genuine stop already does, just applied here too.
  newTruck.milesSinceStop = 0;
  pushLog(`Took the wheel of ${newTruck.name}.`);
  return { ok: true };
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
  // Long-haul boredom: a leg over LONG_HAUL_BOREDOM_MILES grinds on morale
  // while actually underway (truck.edge - not while parked at a stop on
  // the same contract). Audiobook upgrade (STORE_ITEMS.AUDIOBOOK,
  // profile.upgrades.audiobook) previously set a flag nothing read; it
  // now cuts this decay rather than eliminating it outright ("slows",
  // per the design note on making dead content real).
  if (truck?.edge && truck.contract && truck.contract.optimalMiles > LONG_HAUL_BOREDOM_MILES) {
    const audiobookMult = profile.upgrades.audiobook ? 0.4 : 1;
    profile.morale = clamp01to100(profile.morale - gameHours * LONG_HAUL_MORALE_DECAY_PER_HOUR * audiobookMult);
  }
  // Poor health puts a real ceiling on morale - a purchase can still push
  // morale up (a six-pack, a good meal), but it can't buy past what a
  // battered body allows. Re-applied every tick rather than at the point
  // of each individual gain, so it also catches health dropping BELOW an
  // already-high morale (the ceiling closes in on it, not just holds it back).
  if (profile.health < LOW_HEALTH_THRESHOLD) {
    const moraleCap = 50 + profile.health;
    if (profile.morale > moraleCap) profile.morale = moraleCap;
  }
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
    // Radar detector (Phase 10 upgrade): -45% ticket risk (basic, Store),
    // or -75% with the Scanner Suite (Mechanic, requires the basic one) -
    // applied here rather than as an agent multiplier since it affects a
    // probability roll, not a physical quantity fleet.js reads.
    const radarMult = profile.upgrades.radarTier2 ? RADAR_TIER2_TICKET_MULT : profile.upgrades.radar ? RADAR_TICKET_MULT : 1;
    const chancePerHour = Math.pow(profile.heat / 100, 2) * TICKET_CHANCE_PER_HOUR_AT_MAX_HEAT * radarMult;
    if (rnd() < chancePerHour * gameHours) {
      const fine = TICKET_FINE_BASE + Math.round(profile.heat * 4);
      profile.cash -= fine;
      profile.stats.totalSpent += fine;
      profile.stats.ticketsReceived++;
      profile.heat = clamp01to100(profile.heat - 55);
      profile.reputation = clamp01to100(profile.reputation - REP_LOSS_TICKET);
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
        profile.reputation = clamp01to100(profile.reputation + REP_GAIN_HOTSHOT_ON_TIME);
        pushLog(`HOTSHOT delivered on time — collected $${Math.round(c.payout).toLocaleString()} + $${c.bonusPayout.toLocaleString()} bonus.`);
      } else {
        profile.reputation = clamp01to100(profile.reputation - REP_LOSS_HOTSHOT_MISSED);
        pushLog(`HOTSHOT missed its deadline — still collected the base $${Math.round(c.payout).toLocaleString()}, no bonus.`);
      }
    } else {
      profile.reputation = clamp01to100(profile.reputation + REP_GAIN_DELIVERY);
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

// Weekly wage run, distinct from checkSettlement above: settlement sweeps
// hired trucks' NET earnings into profile.cash (revenue collection, minus
// overhead); this pays OUT of profile.cash to every company truck's
// driver - including the player's own currently-driven rig, which
// settlement never touches at all - as a real expense. Scaled by each
// truck's own delta since its last payroll run: deliveries and miles
// (both already tracked as lifetime counters - contractsCompleted,
// totalMilesDriven, earnings - so no new per-frame bookkeeping is needed),
// each driver's skill (0-1, so skillMult spans 0.7x-1.3x - a veteran
// genuinely out-earns a rookie doing identical work), and a quality bonus
// derived from this period's average payout-per-delivery (a truck that
// spent the week hauling high-tier freight earns more per load than one
// running milk routes, without needing to touch economy.js's payout
// formula itself). profile.payrollBaselines is declared lazily here (not
// in newProfile()) - same established pattern as profile.logo/gpsOwnedByTruckId/
// etc - so an existing save with no baselines yet just starts fresh with
// this week's numbers, no migration needed.
export const PAYROLL_INTERVAL_HOURS = 168; // 1 game week, elapsed GAME time - same convention as SETTLEMENT_INTERVAL_HOURS
const PAYROLL_PER_DELIVERY = 40;
const PAYROLL_PER_MILE = 0.12;

export function checkPayroll(gameSeconds, trucks) {
  if (profile.lastPayrollGameSeconds == null) {
    profile.lastPayrollGameSeconds = gameSeconds; // first check since career start/load - nothing to pay yet, just start the clock
    return null;
  }
  if (gameSeconds - profile.lastPayrollGameSeconds < PAYROLL_INTERVAL_HOURS * 3600) return null;
  profile.lastPayrollGameSeconds = gameSeconds;
  if (!profile.payrollBaselines) profile.payrollBaselines = {};

  const companyIds = new Set([profile.truckId, ...profile.hiredTrucks.map((h) => h.id)]);
  const paid = [];
  let totalPaid = 0;
  for (const t of trucks) {
    if (!companyIds.has(t.id)) continue;
    const base = profile.payrollBaselines[t.id] || {
      contractsCompleted: t.contractsCompleted,
      totalMilesDriven: t.totalMilesDriven,
      earnings: t.earnings,
    };
    const deltaDeliveries = Math.max(0, t.contractsCompleted - base.contractsCompleted);
    const deltaMiles = Math.max(0, t.totalMilesDriven - base.totalMilesDriven);
    const deltaEarnings = Math.max(0, t.earnings - base.earnings);
    profile.payrollBaselines[t.id] = {
      contractsCompleted: t.contractsCompleted,
      totalMilesDriven: t.totalMilesDriven,
      earnings: t.earnings,
    };
    if (deltaDeliveries <= 0 && deltaMiles <= 0) continue; // sat idle/parked all week - nothing earned, nothing owed

    const skillMult = 0.7 + t.driver.skill * 0.6;
    const avgPayoutPerDelivery = deltaDeliveries > 0 ? deltaEarnings / deltaDeliveries : 0;
    // Typical medium haul nets ~$1,650-2,200 (economy.js); anything
    // clearing $1,200/load starts nudging this driver's cut up, capped at
    // a real but not run-away +50%.
    const qualityBonusMult = 1 + Math.min(0.5, Math.max(0, (avgPayoutPerDelivery - 1200) / 4000));
    const pay = Math.round((PAYROLL_PER_DELIVERY * deltaDeliveries + PAYROLL_PER_MILE * deltaMiles) * skillMult * qualityBonusMult);
    if (pay <= 0) continue;
    paid.push({
      id: t.id,
      name: t.name,
      isPlayer: t.id === profile.truckId,
      deliveries: deltaDeliveries,
      miles: Math.round(deltaMiles),
      skill: t.driver.skill,
      pay,
    });
    totalPaid += pay;
  }
  // Drop baselines for ids no longer in the company (defensive - hired
  // trucks are never actually removed from profile.hiredTrucks today).
  // Object.keys always comes back as strings even for a numeric truck.id,
  // so companyIds needs a string-keyed twin here or every entry this very
  // call just wrote gets immediately deleted again (a number id 443 in
  // companyIds never string-equals the "443" key Object.keys hands back).
  const companyIdStrs = new Set([...companyIds].map(String));
  for (const id of Object.keys(profile.payrollBaselines)) {
    if (!companyIdStrs.has(id)) delete profile.payrollBaselines[id];
  }
  if (!paid.length) return null;

  profile.cash -= totalPaid;
  pushLog(`Payroll: paid ${paid.length} driver${paid.length === 1 ? "" : "s"} $${totalPaid.toLocaleString()} total.`);
  return { paid, totalPaid };
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
      checkPayroll(gs, trucks);
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
  const duiMult = profile.upgrades.radarTier2 ? RADAR_TIER2_DUI_MULT : profile.upgrades.radar ? RADAR_DUI_MULT : 1;
  if (item.dui && Math.random() < item.dui * duiMult) {
    profile.stats.duiCount++;
    profile.heat = clamp01to100(profile.heat + 35);
    profile.reputation = clamp01to100(profile.reputation - REP_LOSS_DUI);
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

export function stayAtMotel(truck) {
  if (profile.cash < MOTEL_PRICE) return { ok: false, reason: "Can't afford it." };
  profile.cash -= MOTEL_PRICE;
  profile.stats.totalSpent += MOTEL_PRICE;
  if (truck) truck.fatigue = 0;
  profile.morale = clamp01to100(profile.morale + MOTEL_MORALE_BONUS);
  profile.hunger = clamp01to100(profile.hunger + MOTEL_HUNGER_BONUS);
  pushLog(`Got a real bed at the motel for $${MOTEL_PRICE} - woke up fully rested.`);
  return { ok: true, hours: MOTEL_HOURS };
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

// --- company identity (Phase 12) -----------------------------------------
//
// `profile.logo` is deliberately absent from newProfile() rather than
// defaulted there - a save from before this existed just renders a sensible
// placeholder (see the beacon/FLEET-header consumers, which always compute
// `logo?.color ?? fallback` rather than assuming the field exists), so no
// save-version migration is needed. `profile.companyName` is the same story
// (set by the wizard's setupCompany, not yet built) - deriveMonogram falls
// back to profile.truckName so the badge has something to show either way.
//
// Palette deliberately excludes all four semantic accents (--go/--caution/
// --stop/--info) - a logo badge must never be mistaken for a status color.
export const LOGO_PALETTE = [
  { color: "#8b5cf6", label: "Violet" },
  { color: "#ec4899", label: "Magenta" },
  { color: "#22d3ee", label: "Cyan" },
  { color: "#6366f1", label: "Indigo" },
  { color: "#14b8a6", label: "Teal" },
  { color: "#84cc16", label: "Lime" },
  { color: "#f97316", label: "Orange" },
  { color: "#64748b", label: "Slate" },
];
// Matches the game's existing emoji-glyph convention (#btn-career's own
// truck, heat warnings' siren) rather than introducing a new icon system.
export const LOGO_GLYPHS = ["🚛", "🦅", "⭐", "🔥", "⚡", "🛣️", "🐺", "🏔️"];

// First letters of the first two words, or the first two letters of a
// single word - always available as the fallback the glyph sits in front
// of (a glyph-less badge still needs to read as "your company").
export function deriveMonogram(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return "CO";
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase() || "CO";
}

// Free - confirmed zero gameplay effect (a logo is cosmetic), so unlike
// renameCompany there's no fee to gate this behind.
export function setLogo(color, glyph) {
  profile.logo = { color, glyph: glyph || null, monogram: deriveMonogram(profile.companyName || profile.truckName) };
  pushLog(`Updated the company logo.`);
}

// ~30% of STARTING_CASH - enough to discourage frivolous renames, well
// under one medium load's payout, so it's a real but not punishing cost.
export const RENAME_FEE = 750;

export function renameCompany(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return { ok: false, reason: "Enter a name first." };
  if (profile.cash < RENAME_FEE) return { ok: false, reason: `Can't afford it. ($${RENAME_FEE.toLocaleString()})` };
  profile.cash -= RENAME_FEE;
  profile.stats.totalSpent += RENAME_FEE;
  profile.companyName = trimmed;
  pushLog(`Renamed the company to ${trimmed} for $${RENAME_FEE.toLocaleString()}.`);
  return { ok: true };
}

// Free - profile.homeCity is display-only (RIG's "out of X" header line),
// a wholly different field from truck.homeCity (which Hometown Backhauler
// actually scores load choices against, fixed at each truck's own spawn) -
// changing it has zero gameplay effect, so there's no fee to charge.
export function setHomeBaseCity(city) {
  profile.homeCity = city;
  pushLog(`Moved company headquarters to ${city}.`);
}

// One-time setup at the end of the company creation wizard: sets the three
// identity fields it collects in a single call, all free (see setLogo's
// and setHomeBaseCity's own doc comments on why neither costs anything).
// Deliberately distinct from renameCompany - this is initial setup, not a
// later change, so it never charges RENAME_FEE.
export function setupCompany(companyName, homeBaseCity, logo) {
  const trimmed = (companyName || "").trim();
  if (trimmed) profile.companyName = trimmed;
  profile.homeCity = homeBaseCity;
  if (logo) profile.logo = { color: logo.color, glyph: logo.glyph || null, monogram: logo.monogram || deriveMonogram(profile.companyName || profile.truckName) };
  pushLog(`${profile.companyName || "The company"} is open for business, headquartered in ${homeBaseCity}.`);
}

// --- Fleet-wide shop & autonomy -------------------------------------------
//
// Everything below is deliberately kept off `truck`/`Truck` objects here -
// career.js never imports fleet.js's Truck class or touches the live
// `trucks` array (see the file's own header split with main.js). Purchases
// here only ever write to `profile`; main.js is the one that actually
// stamps the resulting `truck.gps`/`truck.autoDriver`/`truck.fleetWearMult`
// fields onto live Truck instances (at hire/wizard-spawn/switch time, and
// retroactively across the whole company the instant a purchase lands),
// mirroring the exact confirmHire/handleHireDriver split already
// documented above. fleet.js itself never imports career.js either - it
// just reads those plain fields directly off whichever truck it's ticking,
// with no idea "GPS" or "career mode" exist at all.
//
// GPS is deliberately its own concept from `profile.upgrades`/`agent`: an
// agent's multipliers only ever apply to whichever truck currently HOLDS
// it (see the two-layer physics model note up top), so they can't reach a
// hired truck's own AI-driven physics at all. GPS and Fleet Maintenance
// below are the two upgrade concepts that genuinely generalize to a hired
// truck's ordinary, agent-less driving: which junction it picks (GPS) and
// how likely it is to break down (Fleet Maintenance's wear reduction).
// Sleeper/Radar/APU/etc. stay agent-only on purpose - fatigue, heat/
// tickets, and fuel capacity are either meaningless for an AI-driven truck
// (nothing in fleet.js ever tickets or fines one) or, for TANK, already a
// documented one-truck-only physical modification, not a policy.

// Per-truck: profile.gpsOwnedByTruckId[id] = true once bought for that
// specific truck. Fleet-wide: profile.gpsFleetWide = true once bought once
// for the whole company - covers every truck owned NOW and every one
// hired/spawned AFTER, with no separate purchase needed. Neither field is
// declared in newProfile() (same "absent until first written" convention
// as profile.logo) - an old save just reads as "no GPS anywhere yet".
export const GPS_PRICE_PER_TRUCK = 1200;
const GPS_FLEET_BASE = 1000; // scaled by fleet size below - see buyFleetGPS

export function hasGPS(truckId) {
  return !!profile.gpsFleetWide || !!(profile.gpsOwnedByTruckId && profile.gpsOwnedByTruckId[truckId]);
}

export function buyGPS(truckId) {
  if (hasGPS(truckId)) return { ok: false, reason: "This truck already has GPS." };
  if (profile.cash < GPS_PRICE_PER_TRUCK) return { ok: false, reason: `Can't afford it. ($${GPS_PRICE_PER_TRUCK.toLocaleString()})` };
  profile.cash -= GPS_PRICE_PER_TRUCK;
  profile.stats.totalSpent += GPS_PRICE_PER_TRUCK;
  if (!profile.gpsOwnedByTruckId) profile.gpsOwnedByTruckId = {};
  profile.gpsOwnedByTruckId[truckId] = true;
  pushLog(`Installed GPS navigation for $${GPS_PRICE_PER_TRUCK.toLocaleString()} - this rig now handles its own junction calls.`);
  return { ok: true };
}

// Priced as a bulk discount over buying every current truck individually
// (never more than that), but still scales with fleet size since it's
// covering every truck the company will EVER own, not just today's roster.
export function fleetGPSPrice() {
  return Math.round(GPS_FLEET_BASE * (1 + profile.hiredTrucks.length) * 0.7);
}

export function buyFleetGPS() {
  if (profile.gpsFleetWide) return { ok: false, reason: "The whole fleet already has GPS." };
  const cost = fleetGPSPrice();
  if (profile.cash < cost) return { ok: false, reason: `Can't afford it. ($${cost.toLocaleString()})` };
  profile.cash -= cost;
  profile.stats.totalSpent += cost;
  profile.gpsFleetWide = true;
  pushLog(`Rolled out fleet-wide GPS for $${cost.toLocaleString()} - every truck, present and future, navigates itself now.`);
  return { ok: true };
}

// Fleet Maintenance: a company-wide, tiered wear/breakdown-risk reduction -
// the one existing per-driver upgrade (TIRES) that has a real, meaningful
// equivalent for a hired truck's own ordinary physics (fleet.js's
// breakdown-probability formula already reads a generic `truck.
// fleetWearMult` multiplier - see main.js's stamping side for where that
// field actually gets set). Same 3-tier shape and discount logic as GPS.
export const FLEET_MAINT_TIER_COST = [1400, 2800, 4600]; // per-truck-equivalent, before the fleet-size multiplier
export const FLEET_MAINT_WEAR_MULT = [1, 0.85, 0.72, 0.60]; // index 0 = no tier owned yet

export function fleetMaintenanceTier() {
  return profile.fleetMaintenanceTier || 0;
}

export function fleetWearMult() {
  return FLEET_MAINT_WEAR_MULT[fleetMaintenanceTier()];
}

export function fleetMaintenancePrice() {
  const tier = fleetMaintenanceTier();
  if (tier >= FLEET_MAINT_TIER_COST.length) return null; // maxed out
  return Math.round(FLEET_MAINT_TIER_COST[tier] * (1 + profile.hiredTrucks.length) * 0.7);
}

export function buyFleetMaintenance() {
  const cost = fleetMaintenancePrice();
  if (cost == null) return { ok: false, reason: "Fleet Maintenance is already maxed out." };
  if (profile.cash < cost) return { ok: false, reason: `Can't afford it. ($${cost.toLocaleString()})` };
  profile.cash -= cost;
  profile.stats.totalSpent += cost;
  profile.fleetMaintenanceTier = fleetMaintenanceTier() + 1;
  pushLog(`Upgraded Fleet Maintenance to Tier ${profile.fleetMaintenanceTier} for $${cost.toLocaleString()} - every company truck breaks down less.`);
  return { ok: true };
}

// AI Driver: hands the PLAYER's own currently-driven rig over to full
// autopilot - combined with GPS (which this implies regardless of whether
// GPS was bought separately - see main.js's stamping side), the career
// truck now also auto-picks its next load the instant it's free, the same
// chooseOffer() pick an ordinary hired truck's AI already makes, instead of
// opening the load board and waiting on the player. The player keeps full
// manual control of everything else - upgrades, fuel, purchases - this
// only ever touches navigation and load selection. One-time, company-wide
// (there's only ever one "player's own truck" at a time, whichever one
// profile.truckId currently points at - see switchActiveTruck).
export const AI_DRIVER_PRICE = 15000;
export const AI_DRIVER_MIN_LEVEL = 3;

export function hasAIDriver() {
  return !!profile.autoDriver;
}

export function buyAIDriver() {
  if (profile.autoDriver) return { ok: false, reason: "Already fully autonomous." };
  if (profile.level < AI_DRIVER_MIN_LEVEL) return { ok: false, reason: `Requires level ${AI_DRIVER_MIN_LEVEL}.` };
  if (profile.cash < AI_DRIVER_PRICE) return { ok: false, reason: `Can't afford it. ($${AI_DRIVER_PRICE.toLocaleString()})` };
  profile.cash -= AI_DRIVER_PRICE;
  profile.stats.totalSpent += AI_DRIVER_PRICE;
  profile.autoDriver = true;
  pushLog(`Hired an AI Driver for $${AI_DRIVER_PRICE.toLocaleString()} - your rig now runs itself end to end.`);
  return { ok: true };
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
