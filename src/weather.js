// weather.js - drifting regional weather systems. Deliberately a tiny,
// self-contained model: a handful of soft circular cells that move west
// to east (the way real North American systems track) and slow any truck
// caught inside them. It lives in its own module because BOTH the
// simulation (fleet.js reads the speed multiplier) and the renderer
// (render.js draws the cells) need it, and neither should own it.
//
// The whole point is regional variety: a run through a snowstorm across
// the northern plains should visibly take longer than the same run in
// clear weather, and you should be able to SEE why on the map.
"use strict";

import { WORLD_WIDTH, latToWorldY } from "./geo.js";

// Snow above this world Y, rain below it. y = (maxLat - lat) * scale, so
// SMALL y is NORTH. Expressed as a latitude (not a WORLD_HEIGHT fraction)
// so the Canada map-expansion (geo.js) can't silently drag the snow line
// north with it - 39.0N is unchanged from when this was WORLD_HEIGHT*0.42.
const SNOW_LINE_Y = latToWorldY(39.0);

// Speed multipliers at the dead centre of a cell at full intensity;
// scaled down toward 1.0 at the cell's edge, so trucks ease into and out
// of a system rather than hitting a wall.
const RAIN_WORST = 0.86;
const SNOW_WORST = 0.68;

// Systems track eastward. World units per game-hour - tuned so a cell
// crosses the country in roughly two and a half game-days, which is slow
// enough to feel like weather rather than strobing.
const DRIFT_X_PER_HOUR = 26;

export function createWeather(count = 7, rnd = Math.random) {
  const cells = [];
  for (let i = 0; i < count; i++) cells.push(spawnCell(rnd, rnd() * WORLD_WIDTH));
  return cells;
}

// US-only band, 46.5N (upper Great Lakes/New England) down to 27.5N (deep
// south Texas/Florida) - expressed as latitudes for the same reason as
// SNOW_LINE_Y above. Weather does not extend over Canada in this pass.
const SPAWN_LAT_NORTH = 46.5, SPAWN_LAT_SOUTH = 27.5;
const SPAWN_Y_NORTH = latToWorldY(SPAWN_LAT_NORTH), SPAWN_Y_SOUTH = latToWorldY(SPAWN_LAT_SOUTH);
// Vertical wander walls, slightly outside the spawn band (47.5N / 26.5N).
const BOUNCE_Y_NORTH = latToWorldY(47.5), BOUNCE_Y_SOUTH = latToWorldY(26.5);

function spawnCell(rnd, x) {
  const y = SPAWN_Y_NORTH + rnd() * (SPAWN_Y_SOUTH - SPAWN_Y_NORTH);
  return {
    x,
    y,
    r: 190 + rnd() * 340,
    kind: y < SNOW_LINE_Y && rnd() < 0.62 ? "snow" : "rain",
    intensity: 0.45 + rnd() * 0.55,
    // A little vertical wander so systems don't march in a straight line.
    vy: (rnd() - 0.5) * 5,
    seed: rnd() * 1000,
  };
}

// Advances every cell by `gameHours`. Cells that drift off the eastern
// edge respawn on the western side as a fresh system, so the map always
// has weather somewhere without the array ever growing.
export function updateWeather(cells, gameHours, rnd = Math.random) {
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    c.x += DRIFT_X_PER_HOUR * gameHours;
    c.y += c.vy * gameHours;
    if (c.y < BOUNCE_Y_NORTH || c.y > BOUNCE_Y_SOUTH) c.vy = -c.vy;
    if (c.x - c.r > WORLD_WIDTH) cells[i] = spawnCell(rnd, -c.r);
  }
}

// Combined speed multiplier for a point, in [worst, 1]. Overlapping
// systems compound (taking the product), so a truck in the middle of two
// stacked cells really is having a bad day.
export function weatherSpeedMultAt(cells, x, y) {
  let mult = 1;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const dx = x - c.x, dy = y - c.y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= c.r * c.r) continue;
    // Linear falloff from centre to rim.
    const strength = (1 - Math.sqrt(d2) / c.r) * c.intensity;
    const worst = c.kind === "snow" ? SNOW_WORST : RAIN_WORST;
    mult *= 1 - (1 - worst) * strength;
  }
  return mult;
}
