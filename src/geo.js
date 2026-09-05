// geo.js - graph construction + geography helpers built on top of data.js
import { masterCities, interstateRoutes, highwayRoutes, terrainModifiers } from "./data.js";

const DEFAULT_INTERSTATE_MPH = 70;
// A US-numbered route through towns, signals and no-passing two-lanes
// realistically averages well under its posted limit for a commercial
// truck - 48 (not 55) is what stops A* treating it as interstate-
// equivalent per mile.
const DEFAULT_HIGHWAY_MPH = 48;
// A* below costs edges by travel TIME, not distance, but real carriers
// still prefer limited-access roads at a small time cost (fuel stops,
// weigh stations, no low bridges/weight limits) - this multiplies a
// highway edge's time cost so a merely-slightly-faster highway detour
// doesn't win over a proper interstate route.
export const HIGHWAY_ROUTE_PENALTY = 1.15;

// Fixed lat/lon bounds for the continental US, projected into a static
// "world space" once per node so rendering never has to reproject a
// lat/lon on every frame. World units are arbitrary but consistent; the
// camera (see camera.js) maps this space to screen pixels.
const WORLD_BOUNDS = { minLat: 24.5, maxLat: 49.5, minLon: -125.0, maxLon: -66.0 };
export const WORLD_WIDTH = 4000;
export const WORLD_HEIGHT = 2400;

function projectToWorld(lat, lon) {
    const { minLat, maxLat, minLon, maxLon } = WORLD_BOUNDS;
    return {
        x: (lon - minLon) * (WORLD_WIDTH / (maxLon - minLon)),
        y: (maxLat - lat) * (WORLD_HEIGHT / (maxLat - minLat)),
    };
}

function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

export function haversineMiles(a, b) {
    const R = 3958.8;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const la1 = toRad(a.lat), la2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial bearing from a to b, in degrees, 0 = north, clockwise.
export function bearing(a, b) {
    const la1 = toRad(a.lat), la2 = toRad(b.lat);
    const dLon = toRad(b.lon - a.lon);
    const y = Math.sin(dLon) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    let deg = toDeg(Math.atan2(y, x));
    return (deg + 360) % 360;
}

export function compassLabel(deg) {
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.round(deg / 45) % 8];
}

const COMPASS_WORD = { N: "North", NE: "Northeast", E: "East", SE: "Southeast", S: "South", SW: "Southwest", W: "West", NW: "Northwest" };

// US highway numbering convention (both the Interstate and the older US
// Numbered Highway systems): ODD route numbers run north-south, EVEN
// numbers run east-west - the reliable rule, not "ends in 0/5" (a
// simplification that happens to hold for many of the big coast-to-coast/
// border-to-border routes, e.g. I-10/I-80/I-90 or I-5/I-75/I-95, but
// isn't the actual convention - I-4, I-16, I-66 are all even/east-west
// despite not ending in 0, and I-19/I-99 are odd/north-south despite not
// ending in 5). Only reliable for 1-2 digit route numbers - a 3-digit
// route (a spur or beltway loop off a parent route, e.g. I-380, I-215)
// doesn't dependably inherit its parent's axis (I-380 is even/"should"
// be east-west by the numeric rule but is actually a north-south spur),
// so those fall back to the edge's own measured compass label instead of
// a forced axis.
function routeAxis(route) {
    const m = route.match(/^(?:I|US)-(\d+)/);
    if (!m) return null;
    const num = parseInt(m[1], 10);
    if (num >= 100) return null;
    return num % 2 === 0 ? "EW" : "NS";
}

// The direction word for a truck's current edge, honoring the route's
// fixed axis where one reliably applies (see routeAxis) rather than the
// edge's literal bearing - a north-south interstate reads as "North" or
// "South" the whole way even through a jog that briefly angles east or
// west. Falls back to the edge's own 8-way compass label when no fixed
// axis applies (3-digit routes, or an unrecognized route prefix).
export function travelDirectionLabel(edge) {
    const axis = routeAxis(edge.route);
    const rad = (edge.bearing * Math.PI) / 180;
    if (axis === "NS") return Math.cos(rad) >= 0 ? "North" : "South";
    if (axis === "EW") return Math.sin(rad) >= 0 ? "East" : "West";
    return COMPASS_WORD[edge.dirLabel] || edge.dirLabel;
}

// Small deterministic string hash -> 32-bit int, used to seed per-entity
// PRNGs (driver personality, contract rolls) so the same seed always
// reproduces the same result.
export function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function terrainSpeed(cityA, cityB, fallback) {
    const k1 = `${cityA}-${cityB}`;
    const k2 = `${cityB}-${cityA}`;
    if (terrainModifiers.hasOwnProperty(k1)) return terrainModifiers[k1];
    if (terrainModifiers.hasOwnProperty(k2)) return terrainModifiers[k2];
    return fallback;
}

// Walk forward along a route's city list from `index` in `dir` (+1/-1)
// looking for the nearest "major" city (tier <= 2) to use as a highway
// sign control city. Falls back to the terminus of the route.
function findControlCity(cityList, index, dir) {
    let i = index + dir;
    let last = null;
    while (i >= 0 && i < cityList.length) {
        const name = cityList[i];
        const c = masterCities[name];
        if (c && c.t <= 2) return name;
        last = name;
        i += dir;
    }
    return last;
}

// Stable identity string for a directed edge (from/to/route uniquely
// identify one direction of travel on a route segment).
export function edgeId(edge) {
    return edge.from + "|" + edge.to + "|" + edge.route;
}

export function buildGraph() {
    const nodes = {};
    for (const name in masterCities) {
        const data = masterCities[name];
        const { x, y } = projectToWorld(data.lat, data.lon);
        nodes[name] = Object.assign({ name, x, y }, data);
    }

    // adjacency[city] = array of edge objects
    const adjacency = {};
    for (const name in nodes) adjacency[name] = [];

    function ingestRouteTable(table, kind, defaultMph) {
        for (const routeName in table) {
            const cities = table[routeName];
            for (let i = 0; i < cities.length - 1; i++) {
                const a = cities[i], b = cities[i + 1];
                if (!nodes[a] || !nodes[b]) continue; // guard against typos in source data
                const mph = terrainSpeed(a, b, defaultMph);
                const miles = haversineMiles(nodes[a], nodes[b]);
                const brgAB = bearing(nodes[a], nodes[b]);
                const brgBA = (brgAB + 180) % 360;

                adjacency[a].push({
                    from: a, to: b, route: routeName, kind, speedLimit: mph, miles,
                    bearing: brgAB, dirLabel: compassLabel(brgAB),
                    control: findControlCity(cities, i, +1),
                });
                adjacency[b].push({
                    from: b, to: a, route: routeName, kind, speedLimit: mph, miles,
                    bearing: brgBA, dirLabel: compassLabel(brgBA),
                    control: findControlCity(cities, i + 1, -1),
                });
            }
        }
    }

    ingestRouteTable(interstateRoutes, "interstate", DEFAULT_INTERSTATE_MPH);
    ingestRouteTable(highwayRoutes, "highway", DEFAULT_HIGHWAY_MPH);

    // The true fastest speedLimit anywhere on the graph - findPath's time
    // heuristic divides straight-line miles by this, which is what keeps
    // it admissible (no real route can beat great-circle distance at
    // less than this many hours per mile). Computed from the actual
    // edges rather than hardcoded, so a future terrainModifiers entry
    // above today's max can never silently break admissibility.
    let maxMph = DEFAULT_INTERSTATE_MPH;
    for (const name in adjacency) {
        for (const e of adjacency[name]) {
            if (e.speedLimit > maxMph) maxMph = e.speedLimit;
        }
    }

    return { nodes, adjacency, maxMph };
}

// All legal next edges from `node`, excluding a straight U-turn back the
// way `excludeReverseOf` came from (unless that's the only option, e.g. a
// dead end).
export function pickEdgesFrom(graph, node, excludeReverseOf) {
    const all = graph.adjacency[node] || [];
    const filtered = all.filter((e) => !(excludeReverseOf && e.to === excludeReverseOf.from && e.route === excludeReverseOf.route));
    return filtered.length ? filtered : all;
}

// ---------------------------------------------------------------------
// A* pathfinding: a binary min-heap open set (O(log n) push/pop instead
// of an O(n) sorted-array insert) plus a small bounded path cache, since
// many trucks will request routes. Cost = travel TIME in hours (real
// miles / speedLimit, with a highway route penalty - see
// HIGHWAY_ROUTE_PENALTY), not raw distance: costing by distance alone
// let a 55mph two-lane beat a 70mph interstate any time it was even
// slightly shorter, which is not how real routing works. Heuristic =
// straight-line miles to the goal divided by graph.maxMph (the fastest
// speedLimit anywhere on the graph), which is always <= the true
// remaining travel time (no road can be faster than the fastest road,
// and great-circle distance <= true road distance), so it's admissible.
// ---------------------------------------------------------------------
class MinHeap {
    constructor(scoreOf) {
        this.scoreOf = scoreOf;
        this.data = [];
    }
    size() { return this.data.length; }
    push(item) {
        this.data.push(item);
        this._bubbleUp(this.data.length - 1);
    }
    pop() {
        const top = this.data[0];
        const last = this.data.pop();
        if (this.data.length > 0) {
            this.data[0] = last;
            this._sinkDown(0);
        }
        return top;
    }
    _bubbleUp(i) {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.scoreOf(this.data[i]) < this.scoreOf(this.data[parent])) {
                [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
                i = parent;
            } else break;
        }
    }
    _sinkDown(i) {
        const n = this.data.length;
        while (true) {
            const l = 2 * i + 1, r = 2 * i + 2;
            let smallest = i;
            if (l < n && this.scoreOf(this.data[l]) < this.scoreOf(this.data[smallest])) smallest = l;
            if (r < n && this.scoreOf(this.data[r]) < this.scoreOf(this.data[smallest])) smallest = r;
            if (smallest === i) break;
            [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
            i = smallest;
        }
    }
}

const PATH_CACHE_MAX = 20000;
const pathCache = new Map();

function cachePath(key, value) {
    if (pathCache.size >= PATH_CACHE_MAX) {
        pathCache.delete(pathCache.keys().next().value); // evict oldest (Map preserves insertion order)
    }
    pathCache.set(key, value);
}

// Returns an array of directed edges from startName to goalName (the
// route to walk edge-by-edge), or null if unreachable.
export function findPath(graph, startName, goalName) {
    if (startName === goalName) return null;
    const cacheKey = `${startName}->${goalName}`;
    if (pathCache.has(cacheKey)) return pathCache.get(cacheKey);

    const goalNode = graph.nodes[goalName];
    if (!graph.nodes[startName] || !goalNode) return null;

    const maxMph = graph.maxMph || DEFAULT_INTERSTATE_MPH;
    const gScore = new Map([[startName, 0]]);
    const fScore = new Map([[startName, haversineMiles(graph.nodes[startName], goalNode) / maxMph]]);
    const cameFromEdge = new Map();
    const closed = new Set();

    const heap = new MinHeap((name) => fScore.get(name) ?? Infinity);
    heap.push(startName);

    while (heap.size() > 0) {
        const current = heap.pop();
        if (closed.has(current)) continue;
        if (current === goalName) {
            const path = [];
            let cur = current;
            while (cameFromEdge.has(cur)) {
                const e = cameFromEdge.get(cur);
                path.unshift(e);
                cur = e.from;
            }
            cachePath(cacheKey, path);
            return path;
        }
        closed.add(current);

        for (const e of graph.adjacency[current] || []) {
            if (closed.has(e.to)) continue;
            const edgeHours = (e.miles / e.speedLimit) * (e.kind === "highway" ? HIGHWAY_ROUTE_PENALTY : 1);
            const tentativeG = (gScore.get(current) ?? Infinity) + edgeHours;
            if (tentativeG < (gScore.get(e.to) ?? Infinity)) {
                cameFromEdge.set(e.to, e);
                gScore.set(e.to, tentativeG);
                fScore.set(e.to, tentativeG + haversineMiles(graph.nodes[e.to], goalNode) / maxMph);
                heap.push(e.to);
            }
        }
    }

    cachePath(cacheKey, null);
    return null;
}

// ---------------------------------------------------------------------
// World time-of-day. Lives here rather than in render.js because it's
// pure geography/time math with no drawing in it, and BOTH the simulation
// (fleet.js's rush-hour slowdown) and the renderer (the day/night colour
// grade, city lights, headlights) need it - the sim importing the
// renderer just to ask what time it is would be backwards.
//
// World x=0 is lon -125 (west), x=WORLD_WIDTH is lon -66 (east): a 59deg
// span, ~3.93 hours of solar time. TERMINATOR_SWEEP_MIN sweeps local time
// across that span (the west is always earlier), so sunset visibly
// crosses the country instead of the whole map flipping at once.
// ---------------------------------------------------------------------
// A full west-to-east sweep of the map takes TERMINATOR_SWEEP_MIN. New
// York and Los Angeles sit 74.98% of the map width apart, so 240 minutes
// end to end puts exactly 180 - three game-hours - between sunset in NYC
// and sunset in LA, which is the intended pacing.
export const TERMINATOR_SWEEP_MIN = 240;

// The sim clock is East Coast time, so the terminator is anchored on NEW
// YORK rather than on the map's eastern edge. That edge is lon -66, out
// past Maine; anchoring there made NYC reach its own local dusk about 33
// minutes after the HUD clock read 7pm. With this offset, local time at
// NYC is exactly the game clock, so dusk lands at 19:00 and dawn at 07:00
// on the nose, and LA follows three hours later.
const ANCHOR_LON = -74.006; // New York City
const ANCHOR_PCT_WEST = 1 - (ANCHOR_LON - WORLD_BOUNDS.minLon) / (WORLD_BOUNDS.maxLon - WORLD_BOUNDS.minLon);

export const DAWN_MIN = 7 * 60;   // 07:00 in NYC - full daylight from here
export const DUSK_MIN = 19 * 60;  // 19:00 in NYC - darkness starts accumulating
const NIGHT_LEN = 1440 - (DUSK_MIN - DAWN_MIN); // 720
export const NIGHT_DARKNESS_MAX = 0.65;

// Mean of rawDarknessAtX over a full 24h cycle: 0 for the 720-minute
// daylight window, and a half-sine (mean 2/PI of its peak) for the
// NIGHT_LEN minutes either side of it.
const AVG_DARKNESS = NIGHT_DARKNESS_MAX * (2 / Math.PI) * (NIGHT_LEN / 1440);

// Minute-of-day [0, 1440) at a given world X - i.e. the LOCAL clock at
// that longitude, which is what "is it rush hour here" and "how dark is
// it here" both actually depend on.
export function localMinutesAtX(worldX, gameSeconds) {
    const pctWest = 1 - worldX / WORLD_WIDTH;
    // Offset relative to the NYC anchor, so local time AT NYC is exactly
    // the game clock and everywhere west of it runs correspondingly behind.
    let m = (gameSeconds / 60 - (pctWest - ANCHOR_PCT_WEST) * TERMINATOR_SWEEP_MIN) % 1440;
    if (m < 0) m += 1440;
    return m;
}

// Local darkness [0, NIGHT_DARKNESS_MAX] straight off the HUD clock,
// before any time-scale damping.
export function rawDarknessAtX(worldX, gameSeconds) {
    const m = localMinutesAtX(worldX, gameSeconds);
    if (m >= DAWN_MIN && m < DUSK_MIN) return 0;
    const p = m >= DUSK_MIN ? m - DUSK_MIN : m + 1440 - DUSK_MIN;
    return Math.sin((p / NIGHT_LEN) * Math.PI) * NIGHT_DARKNESS_MAX;
}

// At 1x a full game day passes in 36 real seconds (BASE_TIME_SCALE=2400
// game-seconds per real second); at the slider's 8x cap, 4.5 seconds -
// undamped, the sky would strobe between noon and midnight several times
// a minute. This blends toward the day's mean as timeScale climbs, so 1x
// still shows a full cycle while high speeds settle into a steady dusk.
// Identity at timeScale <= 1, so the common case is untouched.
export function effectiveDarkness(raw, timeScale) {
    const blend = 1 / (1 + Math.max(0, timeScale - 1) * 0.6);
    return raw * blend + AVG_DARKNESS * (1 - blend);
}
