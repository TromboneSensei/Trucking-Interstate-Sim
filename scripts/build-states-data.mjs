// build-states-data.mjs - ONE-OFF preprocessing script, not shipped/run at
// app runtime. Reads the raw US-states GeoJSON plus a trimmed Canadian
// provinces GeoJSON, drops Alaska/Hawaii/Puerto Rico and any Canadian
// province/territory ring lying entirely outside the world box (Nunavut,
// NWT, Yukon, most of Newfoundland - populated southern Canada only),
// projects every point into the same world-space geo.js's
// projectToWorld() uses for city nodes (duplicated here rather than
// exported from geo.js - this script has no reason to add a temporary
// export surface to shipped code, but the two MUST be kept in sync -
// see the comment on WORLD_BOUNDS in geo.js), simplifies each ring with
// Douglas-Peucker to cut point count drastically, and writes
// src/states-data.js: a flat array of pre-projected, pre-simplified
// rings ready to stroke directly, with zero runtime lon/lat or
// simplification work.
//
// Re-run with: node scripts/build-states-data.mjs

import fs from "node:fs";

const US_SOURCE_GEOJSON = "/root/.claude/uploads/0a078f57-3d46-544a-8353-4d6fe87fe6f2/9ecad0df-us_states.json";
const CA_SOURCE_GEOJSON = new URL("./data/canada-provinces.geojson", import.meta.url);
const OUTPUT_MODULE = new URL("../src/states-data.js", import.meta.url);

// Mirrors geo.js's WORLD_BOUNDS/projectToWorld exactly, so state/province
// borders land pixel-perfectly aligned with cities/roads already
// projected there. maxLat/WORLD_HEIGHT were grown together (yScale stays
// EXACTLY 96 units/deg) so every pre-existing US point simply translates
// down by a constant offset - see geo.js for the full rationale.
const WORLD_BOUNDS = { minLat: 24.5, maxLat: 57.0, minLon: -125.0, maxLon: -66.0 };
const WORLD_WIDTH = 4000, WORLD_HEIGHT = 3120; // (57.0 - 24.5) * 96
function projectToWorld(lat, lon) {
  return {
    x: (lon - WORLD_BOUNDS.minLon) * (WORLD_WIDTH / (WORLD_BOUNDS.maxLon - WORLD_BOUNDS.minLon)),
    y: (WORLD_BOUNDS.maxLat - lat) * (WORLD_HEIGHT / (WORLD_BOUNDS.maxLat - WORLD_BOUNDS.minLat)),
  };
}

const EXCLUDE_STATES = new Set(["Alaska", "Hawaii", "Puerto Rico"]);

const DEFAULT_TOLERANCE = 1.35; // world units
const SMALL_RING_BBOX_DIAGONAL = 40; // world units - rings smaller than this get a finer tolerance
const SMALL_RING_TOLERANCE = DEFAULT_TOLERANCE / 4;

// Perpendicular distance from point p to the segment a-b, falling back to
// point-to-point distance when a and b coincide (GeoJSON rings repeat
// their first point as their last, so the top-level DP call on a closed
// ring always starts with a zero-length "segment" between its two
// anchors - a naive line-distance formula divides by zero there).
function pointSegDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx, projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

// Iterative (explicit-stack) Douglas-Peucker - avoids any recursion-depth
// concern on the largest coastline rings, though at this dataset's scale
// (avg ~158 points/ring) plain recursion would have been fine too; the
// stack form is free insurance for a script only run once.
function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [startIdx, endIdx] = stack.pop();
    let maxDist = 0, maxIdx = -1;
    for (let i = startIdx + 1; i < endIdx; i++) {
      const d = pointSegDist(points[i], points[startIdx], points[endIdx]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > tolerance) {
      keep[maxIdx] = 1;
      stack.push([startIdx, maxIdx], [maxIdx, endIdx]);
    }
  }
  const result = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) result.push(points[i]);
  return result;
}

function bbox(points) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

function bboxDiagonal(points) {
  const b = bbox(points);
  return Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
}

// A ring is kept only if its bbox overlaps the world box at all - this is
// what discards Nunavut/NWT/Yukon/most-of-Newfoundland (their projected
// coordinates land entirely above y=0) while keeping every ring that at
// least partially falls on-canvas (a ring that crosses the y=0 cutoff is
// kept and simply runs off the top edge when rendered - see render.js,
// which clips it for free).
//
// The NORTH cutoff (y<0) is safe to leave un-clipped: those rings simply
// run off the top edge and stay off (Alberta/Saskatchewan/BC's real
// northern borders sit at 60N, far off-canvas, and never re-enter).
// EAST/WEST is NOT safe the same way: Quebec's real provincial outline
// runs to its border with Labrador past -57 lon (x~4700, deliberately
// deferred with the rest of the Maritimes - see geo.js), and Yukon/far-
// north BC dips west of minLon (x as low as -953 measured). Those rings
// don't just exit the canvas and stay gone - they loop back into the
// visible viewport at a different Y, which without clipping draws a long
// stray diagonal line across the whole map (a real bug this caught: 5
// rings overflowed east past WORLD_WIDTH, 3 overflowed west past x=0,
// before this clip existed). So X gets an actual geometric clip
// (single-edge Sutherland-Hodgman, composed twice) before the overlap
// check runs, while Y stays overlap-only.
function clipHalfPlane(points, inside) {
  if (!points.length) return points;
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const curr = points[i];
    const prev = points[(i - 1 + points.length) % points.length];
    const currIn = inside(curr), prevIn = inside(prev);
    if (currIn !== prevIn) {
      const t = (0 - prev._d) / (curr._d - prev._d); // _d set by caller below
      out.push({ x: prev.x + t * (curr.x - prev.x), y: prev.y + t * (curr.y - prev.y) });
    }
    if (currIn) out.push(curr);
  }
  return out;
}
// Clips a ring to 0 <= x <= WORLD_WIDTH (composes two half-plane clips).
// `_d` (signed distance to the current clip edge) is stashed on each
// point right before its half's clip runs, since clipHalfPlane's
// intersection math needs it and recomputing per-edge inline is simpler
// than threading a distance function through.
function clipRingToWorldX(points) {
  points.forEach((p) => { p._d = p.x; }); // distance to x=0 (left edge)
  let result = clipHalfPlane(points, (p) => p.x >= 0);
  result.forEach((p) => { p._d = WORLD_WIDTH - p.x; }); // distance to x=WORLD_WIDTH (right edge)
  result = clipHalfPlane(result, (p) => p.x <= WORLD_WIDTH);
  return result;
}

function ringOverlapsWorldBox(points) {
  const b = bbox(points);
  return b.maxX >= 0 && b.minX <= WORLD_WIDTH && b.maxY >= 0 && b.minY <= WORLD_HEIGHT;
}

function processFeatureCollection(raw, { excludeNames = null, label, clipX = false }) {
  let rawRingCount = 0, rawPointCount = 0, keptRingCount = 0, clippedRingCount = 0;
  const rings = [];
  for (const feature of raw.features) {
    const name = feature.properties?.NAME ?? feature.properties?.name;
    if (excludeNames && excludeNames.has(name)) continue;
    const geom = feature.geometry;
    const polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        rawRingCount++;
        rawPointCount += ring.length;
        let projected = ring.map(([lon, lat]) => projectToWorld(lat, lon));
        if (clipX) {
          const b = bbox(projected);
          if (b.minX < 0 || b.maxX > WORLD_WIDTH) {
            projected = clipRingToWorldX(projected);
            clippedRingCount++;
          }
        }
        if (projected.length < 3 || !ringOverlapsWorldBox(projected)) continue;
        keptRingCount++;
        const diag = bboxDiagonal(projected);
        const tolerance = diag < SMALL_RING_BBOX_DIAGONAL ? SMALL_RING_TOLERANCE : DEFAULT_TOLERANCE;
        rings.push(simplify(projected, tolerance));
      }
    }
  }
  console.log(`${label}: ${rawRingCount} rings/${rawPointCount} points source -> ${keptRingCount} rings kept (world-box overlap)${clipX ? `, ${clippedRingCount} clipped to world X-bounds` : ""}`);
  return rings;
}

const usRaw = JSON.parse(fs.readFileSync(US_SOURCE_GEOJSON, "utf8"));
const usRings = processFeatureCollection(usRaw, { excludeNames: EXCLUDE_STATES, label: "US" });

let caRings = [];
if (fs.existsSync(CA_SOURCE_GEOJSON)) {
  const caRaw = JSON.parse(fs.readFileSync(CA_SOURCE_GEOJSON, "utf8"));
  caRings = processFeatureCollection(caRaw, { label: "Canada", clipX: true });
} else {
  console.log("Canada source not found - skipping (US-only regeneration)");
}

const simplifiedRings = [...usRings, ...caRings];
const simplifiedPointCount = simplifiedRings.reduce((s, r) => s + r.length, 0);

const lines = [];
lines.push("// states-data.js - GENERATED by scripts/build-states-data.mjs. Do not hand-edit.");
lines.push("// Pre-projected (geo.js's WORLD_BOUNDS/projectToWorld formula), pre-simplified");
lines.push("// (Douglas-Peucker) state/province border rings: continental US 48 + DC, plus");
lines.push("// southern Canada (rings overlapping the world box - see build script). Each");
lines.push("// ring is a flat [x0,y0,x1,y1,...] array in world-space units, ready to stroke");
lines.push("// directly - no lon/lat or simplification work needed at runtime. Canadian");
lines.push("// rings intentionally run off the top edge (y<0) at the ~54-60N cutoff -");
lines.push("// Canvas2D clips this for free, giving the \"stretches north and is cut off\"");
lines.push("// look with no explicit polygon clipping.");
lines.push(`export const STATE_BORDER_RINGS = [`);
for (const ring of simplifiedRings) {
  const flat = [];
  for (const p of ring) flat.push(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10);
  lines.push(`[${flat.join(",")}],`);
}
lines.push("];");
lines.push("");

fs.writeFileSync(OUTPUT_MODULE, lines.join("\n"));

console.log(`Total output: ${simplifiedRings.length} rings, ${simplifiedPointCount} points (US: ${usRings.length} rings, CA: ${caRings.length} rings)`);
console.log(`Wrote ${OUTPUT_MODULE.pathname}`);
