// geo.js - graph construction + geography helpers built on top of data.js
// (masterCities, interstateRoutes, highwayRoutes, terrainModifiers are globals from data.js)

const DEFAULT_INTERSTATE_MPH = 70;
const DEFAULT_HIGHWAY_MPH = 55;

function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

function haversineMiles(a, b) {
    const R = 3958.8;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const la1 = toRad(a.lat), la2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial bearing from a to b, in degrees, 0 = north, clockwise.
function bearing(a, b) {
    const la1 = toRad(a.lat), la2 = toRad(b.lat);
    const dLon = toRad(b.lon - a.lon);
    const y = Math.sin(dLon) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    let deg = toDeg(Math.atan2(y, x));
    return (deg + 360) % 360;
}

function compassLabel(deg) {
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.round(deg / 45) % 8];
}

// Small deterministic string hash -> 32-bit int, used to seed per-edge PRNGs
// so the same road segment always renders with the same curvature.
function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function mulberry32(seed) {
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

function buildGraph() {
    const nodes = {};
    for (const name in masterCities) {
        nodes[name] = Object.assign({ name }, masterCities[name]);
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
                    seed: hashStr(`${a}|${b}|${routeName}`),
                });
                adjacency[b].push({
                    from: b, to: a, route: routeName, kind, speedLimit: mph, miles,
                    bearing: brgBA, dirLabel: compassLabel(brgBA),
                    control: findControlCity(cities, i + 1, -1),
                    seed: hashStr(`${b}|${a}|${routeName}`),
                });
            }
        }
    }

    ingestRouteTable(interstateRoutes, "interstate", DEFAULT_INTERSTATE_MPH);
    ingestRouteTable(highwayRoutes, "highway", DEFAULT_HIGHWAY_MPH);

    return { nodes, adjacency };
}

// Dijkstra shortest path (by miles) between two cities. Returns array of
// edge objects to traverse, or null if unreachable.
function shortestPath(graph, startName, goalName) {
    const dist = {}, prevEdge = {}, visited = {};
    for (const n in graph.nodes) dist[n] = Infinity;
    dist[startName] = 0;
    const pq = [[0, startName]];
    while (pq.length) {
        pq.sort((a, b) => a[0] - b[0]);
        const [d, u] = pq.shift();
        if (visited[u]) continue;
        visited[u] = true;
        if (u === goalName) break;
        for (const e of graph.adjacency[u]) {
            const nd = d + e.miles;
            if (nd < dist[e.to]) {
                dist[e.to] = nd;
                prevEdge[e.to] = e;
                pq.push([nd, e.to]);
            }
        }
    }
    if (dist[goalName] === Infinity) return null;
    const path = [];
    let cur = goalName;
    while (cur !== startName) {
        const e = prevEdge[cur];
        if (!e) return null;
        path.unshift(e);
        cur = e.from;
    }
    return path;
}

// Stable identity string for a directed edge (from/to/route uniquely
// identify one direction of travel on a route segment). Used by the
// traffic system to track AI vehicles independent of any render frame.
function edgeId(edge) {
    return edge.from + "|" + edge.to + "|" + edge.route;
}

// ---------------------------------------------------------------------
// Road geometry: deterministic per-edge "ribbon" (a gently curving arcade
// road path in its own local 2D space, x=lateral, y=forward). Shared
// globally (not just by game.js) so the traffic system can sample AI
// vehicle positions the same way the player's own position is sampled.
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

// Arcade world-units of road traveled per mph per second — shared so the
// player and AI traffic move at consistent relative speeds.
const UNITS_PER_MPH = 5.2;

// Multi-lane road geometry (world units). Interstates are divided,
// multi-lane; US highways are undivided, one lane each way. Shared by the
// renderer (road polygon + lane markings), the player's steering clamp,
// and the traffic system (lane slots + lane-change-to-pass logic).
const LANE_WIDTH = 34;
const SHOULDER = 20;
const LANES_PER_DIR = { interstate: 2, highway: 1 };
const MEDIAN_WIDTH = { interstate: 26, highway: 0 };

function laneCount(kind) { return LANES_PER_DIR[kind] || 1; }
function ownLaneX(kind, i) { return MEDIAN_WIDTH[kind] / 2 + LANE_WIDTH * i + LANE_WIDTH / 2; }
function roadHalfWidth(kind) { return MEDIAN_WIDTH[kind] / 2 + LANE_WIDTH * laneCount(kind) + SHOULDER; }
function laneRange(kind) {
    const min = MEDIAN_WIDTH[kind] / 2 - 6;
    const max = MEDIAN_WIDTH[kind] / 2 + LANE_WIDTH * laneCount(kind) + SHOULDER * 0.6;
    return [min, max];
}

function ribbonPose(ribbon, s) {
    const eps = 8;
    const p0 = ribbonSample(ribbon, s - eps);
    const p1 = ribbonSample(ribbon, s + eps);
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    const mid = ribbonSample(ribbon, s);
    return { x: mid.x, y: mid.y, headingX: dx / len, headingY: dy / len };
}

// Position at arclength s, offset sideways by `offset` local units
// (positive = the driver's right, i.e. the own-direction side of the
// road in right-hand traffic). Follows curves correctly because the
// offset is applied perpendicular to the ribbon's tangent at s, not as a
// flat world-space nudge. Used for lane centers, lane markings, and both
// the player's and AI vehicles' rendered position.
function ribbonLateral(ribbon, s, offset) {
    const pose = ribbonPose(ribbon, s);
    const px = pose.headingY, py = -pose.headingX;
    return { x: pose.x + px * offset, y: pose.y + py * offset };
}
