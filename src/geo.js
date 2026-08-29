// geo.js - graph construction + geography helpers built on top of data.js
import { masterCities, interstateRoutes, highwayRoutes, terrainModifiers } from "./data.js";

const DEFAULT_INTERSTATE_MPH = 70;
const DEFAULT_HIGHWAY_MPH = 55;

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

    return { nodes, adjacency };
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
// many trucks will request routes. Cost = real miles; heuristic =
// straight-line miles to the goal, which is always <= the true remaining
// road distance, so it's admissible.
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

const PATH_CACHE_MAX = 5000;
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

    const gScore = new Map([[startName, 0]]);
    const fScore = new Map([[startName, haversineMiles(graph.nodes[startName], goalNode)]]);
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
            const tentativeG = (gScore.get(current) ?? Infinity) + e.miles;
            if (tentativeG < (gScore.get(e.to) ?? Infinity)) {
                cameFromEdge.set(e.to, e);
                gScore.set(e.to, tentativeG);
                fScore.set(e.to, tentativeG + haversineMiles(graph.nodes[e.to], goalNode));
                heap.push(e.to);
            }
        }
    }

    cachePath(cacheKey, null);
    return null;
}
