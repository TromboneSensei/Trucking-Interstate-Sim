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
