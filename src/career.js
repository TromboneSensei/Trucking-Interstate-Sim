// career.js - Owner-Operator mode: the player's own truck, a wallet, and
// everything that happens when they take real agency over one rig inside
// the otherwise-autonomous fleet. This module owns NO DOM (see
// career-ui.js for that, mirroring how cb.js owns its own panel) and never
// touches `trucks` beyond the one truck the player controls - it must stay
// safe to import into a headless test with no window/document at all.
"use strict";

import { updateFleet, drainFleetEvents, BASE_TIME_SCALE } from "./fleet.js";
import { updateWeather } from "./weather.js";

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
