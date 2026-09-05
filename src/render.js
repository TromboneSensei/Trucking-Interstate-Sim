// render.js - static background (bg fill + state borders, drawn once to an
// offscreen canvas) plus a per-frame dynamic layer: roads, city dots, a
// day/night terminator + city-light glow, city labels, truck dots,
// selection ring, and the followed-truck route highlight. Roads and city
// dots used to be baked into the static bitmap, but day/night needs to
// recolor them every frame and the old 1.5x-scaled bitmap was already
// visibly soft at FOLLOW_ZOOM - both now render fresh each frame from a
// flat edge list built once at boot. Labels also stay dynamic: which
// tiers are visible depends on the live camera zoom, drawn fresh each
// frame against camera.baseZoom (the initial fit-to-screen zoom set by
// main.js).
import {
  WORLD_WIDTH, WORLD_HEIGHT, hashStr, mulberry32,
  localMinutesAtX, rawDarknessAtX, effectiveDarkness, NIGHT_DARKNESS_MAX,
} from "./geo.js";
import { STATE_BORDER_RINGS } from "./states-data.js";
import { TILT_FACTOR } from "./camera.js";
import { TRUCK_TYPES } from "./economy.js";

const BG_SCALE = 1.5; // supersample the static layer a bit so zooming in isn't too soft
// The basemap is baked at its NOON appearance: land is a legible slate
// blue and the surrounding void is near-black. Everything darker or
// warmer than this is produced by the per-frame sky grade tinting away
// from it (see SKY_KEYFRAMES), which is what gives the day/night cycle
// somewhere to travel - a uniformly near-black map, as this used to be,
// has no dynamic range for "night" to mean anything.
const VOID_COLOR = "#05080f";
const LAND_COLOR = "#2b3648";
const STATE_BORDER_COLOR = "rgba(168, 186, 214, 0.55)"; // a soft edge ON the land, not a bright line on a void
const STATE_BORDER_WIDTH = 1.6;
// City dots, tier 1..4. A single gold ramp that darkens with tier: bright
// golden yellow for the major hubs down to a dark orange-brown for small
// towns, so importance reads from colour as well as size. Deliberately warm
// against the cool blue-grey road/land palette, which is what makes them
// pop out at country zoom where they were previously getting lost.
const CITY_DOT_COLOR = ["#ffd24a", "#e0a52c", "#bd7d1e", "#8f5c18"];
export const TRUCK_DOT_RADIUS = 3.5; // exported: fleet.js's car-following/passing gaps are sized off this

// Two-lanes-per-direction offsets, interstate-only (highways stay
// single-file). World units, in the same camera-scaled space as
// everything else, so they scale naturally with zoom. LEFT is the
// passing lane, close against the median; RIGHT is the default lane.
// Deliberately closer together than "2 * radius" (the two lanes are
// allowed a slight overlap when a truck is directly beside another in
// the next lane over - reads as normal lane-adjacent traffic rather
// than an exaggerated gap) - fleet.js's overlap guard is aware of this
// and only relaxes its own check by the same amount, see
// CROSS_LANE_TARGET_WORLD_UNITS there.
export const LEFT_LANE_OFFSET = TRUCK_DOT_RADIUS + 1; // exported: fleet.js's overlap clamp needs the exact rendered offset
export const RIGHT_LANE_OFFSET = LEFT_LANE_OFFSET + 2 * TRUCK_DOT_RADIUS - 2;

// US highways are single-lane each way, but opposing traffic still needs to
// look like it has its own side of the road rather than sharing one
// centerline. Chosen against the highway's real dimensions rather than by
// eye: the dot is 3.5 across the radius, the fog line sits at 5.0 and the
// asphalt ends at 8.0 (HWY_FOG / HWY_BAND_HALF below), so at 4.5 the two
// directions clear each other by 2.0 units while the outer edge of a dot
// lands exactly on the asphalt edge. That is the most separation available
// without putting trucks off the pavement - it does overlap the shoulder
// strip, which is the better of the two compromises.
const HIGHWAY_LANE_OFFSET = 4.5;

// ---------------------------------------------------------------------
// Road geometry - every offset below is arithmetic on the lane constants
// above, never a bare number, so the drawn pavement can never drift out
// of sync with where trucks actually paint. A truck riding the right
// (default) lane sits at RIGHT_LANE_OFFSET (9.5) with its dot extending
// to RIGHT_LANE_OFFSET + TRUCK_DOT_RADIUS = 13.0 world units from the
// centerline - FOG_OFFSET below is exactly that value, so the truck's
// outer edge is tangent to the fog/edge line by construction.
// ---------------------------------------------------------------------
const MEDIAN_GAP = LEFT_LANE_OFFSET - TRUCK_DOT_RADIUS; // 1.0 - centerline -> inner edge of the passing lane
const FOG_OFFSET = RIGHT_LANE_OFFSET + TRUCK_DOT_RADIUS; // 13.0 - outer edge of the travel lane == white edge line
const SHOULDER_W = 4.0; // paved shoulder beyond the fog line
const BAND_HALF = FOG_OFFSET + SHOULDER_W; // 17.0 - half-width of the full asphalt band
// Highways: truckWorldPos applies no lane offset for kind !== "interstate"
// (single-file, centerline), so their band is derived narrower/simpler.
const HWY_FOG = TRUCK_DOT_RADIUS + 1.5; // 5.0
const HWY_BAND_HALF = HWY_FOG + 3.0; // 8.0

const ROAD_DAY = {
  interstate: { band: "rgba(85, 110, 140, 0.95)", shoulder: "#60a5fa", fog: "#94a3b8", median: "#ffd700" },
  highway: { band: "rgba(120, 95, 70, 0.9)", shoulder: "#fb923c", fog: "#94a3b8" },
};
// At night the roads should read as LIT - the lanes are the one thing
// still bright once the land has gone dark, which is what sells the
// whole cycle. The previous highway night colour was far too timid to
// register against the graded land; this is a proper sodium-lamp amber.
const ROAD_NIGHT = {
  interstate: { band: "rgba(170, 205, 230, 0.92)", shoulder: "#7dd3fc", fog: "#cbd5e1", median: "#ffd700" },
  highway: { band: "rgba(240, 180, 90, 0.92)", shoulder: "#fdba74", fog: "#cbd5e1" },
};
// Simplified (zoomed-out) atlas-style single line per road kind, day/night
// tinted the same as the full band's asphalt color.
const SIMPLE_PX = { interstate: 2.2, highway: 1.4 };

// Zoom thresholds for the road LOD cross-fade, expressed in *screen*
// pixels of full band width (BAND_HALF*2 = 34 world units) so they are
// resolution-independent rather than tied to a specific camera.zoom
// number. Comfortably above every fitZoom() (~0.09-0.20) and below
// FOLLOW_ZOOM (2.4), so whole-country views stay simplified and
// follow/nav views always render full detail.
const DETAIL_MIN_PX = 18; // band width in screen px below which only the simple line renders
const DETAIL_FULL_PX = 34; // band width in screen px above which only full detail renders

const MEDIAN_WIDTH = 0.7;
// Stroke widths of the two thin road detail layers, in world units. Named
// rather than inlined so drawRoads can compare them against the current
// zoom and skip whichever would land under a screen pixel.
const SHOULDER_LINE_WIDTH = 1.8;
const FOG_LINE_WIDTH = 1.0;

// Viewport-cull padding for the per-truck draw loop, in world units - only
// covers the dot's own footprint (radius + selection ring + stroke), tied
// to TRUCK_DOT_RADIUS so it can't silently drift out of sync if that ever
// changes. This is a performance guard, not a visibility feature: a truck
// just outside the true visible area still simulates identically, it just
// isn't drawn - false positives (drawing a couple extra off-screen trucks)
// are fine, false negatives (clipping a truck that should be visible) are not.
const CULL_PAD_WORLD_UNITS = TRUCK_DOT_RADIUS + 8;
// Wider cull pad for roads/city dots - the drawn band extends BAND_HALF
// (17) world units off each edge's centerline, not just a dot's footprint.
const ROAD_CULL_PAD_WORLD_UNITS = BAND_HALF + 8;

// One draw bucket per cargo/truck-type color (7 distinct colors today, see
// economy.js's TRUCK_TYPES) - built once at module scope, cleared and
// refilled every frame instead of allocated fresh, so the per-truck draw
// loop can batch every truck of the same color into a single
// beginPath()/fill() pass instead of one pair per truck.
const truckBuckets = new Map(Object.values(TRUCK_TYPES).map((tt) => [tt.id, { color: tt.color, xs: [], ys: [] }]));

// Headlight cones, kept deliberately short and narrow so they read as a
// truck's own lights on the pavement rather than searchlights. Flat
// [x, y, bearing, ...] triples in one reused array - same
// no-allocation-per-frame discipline as truckBuckets above.
const HEADLIGHT_LEN = 13;      // world units of throw ahead of the dot
const HEADLIGHT_HALF_W = 2.2;  // half-width at the truck itself
const HEADLIGHT_SPREAD = 4.6;  // half-width at the far end of the beam
const HEADLIGHT_COLOR = "rgba(255, 220, 150, 0.16)";
const headlightPts = [];

// Multiples of camera.baseZoom at which each additional tier of city
// labels comes into view. Tier 1 is visible from the spawn/fit zoom
// onward; each further tier needs progressively more zoom-in, revealed
// cumulatively (zooming to see tier 3 still shows tiers 1-2).
const LABEL_TIER_ZOOM_MULT = { 1: 1.0, 2: 1.7, 3: 3.2, 4: 5.5 };
// tier1 = old 25px shrunk 20%; each tier below is 25% smaller than the
// tier directly above it (20*0.75=15, 15*0.75=11.25->11, 11*0.75=8.25->8) -
// a steeper cascade than the old {25,24,23,22}.
const LABEL_FONT_PX = { 1: 20, 2: 15, 3: 11, 4: 8 };

// Dot size follows the SAME cascade as the label font, so a tier's dot and
// its label shrink together rather than drifting apart if either is
// retuned - derived from LABEL_FONT_PX rather than restated as its own
// table. Tier 1 additionally gets a 25% boost on top so the major hubs
// clearly anchor the map.
const DOT_TIER1_BOOST = 1.25;
const CITY_DOT_SCALE = {};
for (const t of [1, 2, 3, 4]) CITY_DOT_SCALE[t] = DOT_TIER1_BOOST * (LABEL_FONT_PX[t] / LABEL_FONT_PX[1]);

// The one place the dot radius is computed. Three separate call sites used
// to inline this same expression (the dot pass, the label offset, and the
// route highlight ring); the ring in particular has to agree exactly with
// the dot or it stops hugging it.
export function cityDotRadius(node) {
  const base = Math.max(2, Math.min(9, 2 + node.w * 0.7));
  return base * (CITY_DOT_SCALE[node.t] || 1);
}
// Every tier is pure white. The old off-white-to-grey cascade was tuned
// against a near-black basemap; against the filled slate landmass and the
// grey asphalt bands the lower tiers greyed out into the terrain. Tier is
// still legible from the LABEL_FONT_PX size cascade, so brightness doesn't
// need to carry that distinction too.
const LABEL_COLOR = { 1: "#ffffff", 2: "#ffffff", 3: "#ffffff", 4: "#ffffff" };
const OFF_ROUTE_LABEL_SCALE = 0.7; // additional shrink for labels not on the followed truck's route ahead
const ROUTE_HIGHLIGHT_COLOR = "rgba(232, 163, 61, 0.85)"; // same amber as the dashed route-preview line/waypoint dots

// ---------------------------------------------------------------------
// Day/night
// ---------------------------------------------------------------------
// Time-of-day sky grade. The reference sim only hard-swapped between a
// day and a night palette at a darkness threshold; this interpolates a
// full keyframed colour ramp instead, so the map warms through sunrise,
// sits neutral at midday, burns orange at golden hour and cools into deep
// blue overnight. Each keyframe is [minute-of-day, r, g, b, alpha], and
// alpha 0 at midday means the baked basemap shows through completely
// untinted - i.e. the bake IS the noon look and everything else grades
// away from it. Wraps around midnight.
// Deliberately three legible phases rather than a continuous smear:
// a flat untinted DAY, a narrow strongly-warm DUSK/DAWN band that sweeps
// across the country, and a deep near-black NIGHT. Alpha 0 through the
// middle of the day means the baked basemap shows through completely, so
// "day" is unambiguously the bright state; the warm band is short and
// saturated so the sweep is unmistakable as it crosses; night is heavy
// enough to read as genuinely dark. Times are LOCAL minutes, so with the
// NYC anchor in geo.js the 19:00 peak is sunset in New York exactly.
const SKY_KEYFRAMES = [
  [0,     4,   8,  20, 0.80], // 00:00 deep night
  [300,   4,   8,  20, 0.80], // 05:00 still deep night
  [375,  34,  28,  56, 0.64], // 06:15 first violet light
  [420, 198, 108,  46, 0.44], // 07:00 DAWN - peak warm, sweeps west
  [480, 150, 122,  92, 0.15], // 08:00 warm morning fading out
  [540, 255, 255, 255, 0.0],  // 09:00 full day begins
  [1020, 255, 255, 255, 0.0], // 17:00 full day ends
  [1080, 158, 118,  72, 0.16],// 18:00 warm late afternoon
  [1140, 208,  98,  34, 0.46],// 19:00 DUSK - peak warm, sweeps west
  [1200,  86,  44,  62, 0.64],// 20:00 violet twilight
  [1290,   4,   8,  20, 0.80],// 21:30 full night
];

// Interpolated sky tint at a local minute-of-day, as {r,g,b,a}.
function skyTintAtMinute(m) {
  let i = 0;
  while (i < SKY_KEYFRAMES.length - 1 && SKY_KEYFRAMES[i + 1][0] <= m) i++;
  const a = SKY_KEYFRAMES[i];
  const b = SKY_KEYFRAMES[(i + 1) % SKY_KEYFRAMES.length];
  // The final segment wraps past midnight back to the first keyframe.
  const span = (b[0] - a[0] + 1440) % 1440 || 1440;
  const t = Math.max(0, Math.min(1, ((m - a[0] + 1440) % 1440) / span));
  return {
    r: Math.round(a[1] + (b[1] - a[1]) * t),
    g: Math.round(a[2] + (b[2] - a[2]) * t),
    b: Math.round(a[3] + (b[3] - a[3]) * t),
    a: a[4] + (b[4] - a[4]) * t,
  };
}

// The tint at a world X, damped for time-scale the same way darkness is
// (see effectiveDarkness) so cranking the speed slider doesn't strobe the
// whole palette - the alpha is pulled toward its daily mean, which leaves
// a permanent gentle dusk rather than a flicker.
function skyTintAtX(worldX, gameSeconds, timeScale) {
  const tint = skyTintAtMinute(localMinutesAtX(Math.max(0, Math.min(WORLD_WIDTH, worldX)), gameSeconds));
  const blend = 1 / (1 + Math.max(0, timeScale - 1) * 0.6);
  tint.a = tint.a * blend + SKY_AVG_ALPHA * (1 - blend);
  return tint;
}

// Mean alpha across the keyframe ramp, for the time-scale damping above.
const SKY_AVG_ALPHA = (() => {
  let sum = 0;
  for (let m = 0; m < 1440; m += 10) sum += skyTintAtMinute(m).a;
  return sum / 144;
})();

function lerpColor(hexA, hexB, t) {
  const a = parseInt(hexA.slice(1), 16), b = parseInt(hexB.slice(1), 16);
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

// City-glow pre-render: much lower resolution than the road/border bitmap
// (the glow is intrinsically soft, so upscaling it is invisible) to keep
// memory sane - GLOW_SCALE 0.4 -> 1600x960 (~6MB) vs. 86MB for a second
// full-size canvas.
const GLOW_SCALE = 0.4;
// Tier-based glow used to be the reference sim's approach (procedural,
// name-seeded, hardcoded per-tier constants); we have genuine population
// figures for every real city (src/data.js), so intensity/spread are
// derived from actual `node.pop` instead - a five-order-of-magnitude
// range (100 to 8.34M), so linear scaling is unusable; sqrt for radius
// (lit area ~ population) and log10 for intensity/cluster-count (so the
// smallest towns aren't invisible and the biggest metros don't clip).
const GLOW_WARM_COLORS = ["255,210,140", "255,240,215", "200,220,255"];

export function renderCityGlow(graph) {
  const glow = document.createElement("canvas");
  glow.width = WORLD_WIDTH * GLOW_SCALE;
  glow.height = WORLD_HEIGHT * GLOW_SCALE;
  const gctx = glow.getContext("2d");
  gctx.scale(GLOW_SCALE, GLOW_SCALE);
  gctx.globalCompositeOperation = "lighter";

  for (const name in graph.nodes) {
    const node = graph.nodes[name];
    if (node.t === 0 || !node.pop) continue; // junction filler nodes carry no population

    const rnd = mulberry32(hashStr(name)); // stable across reboots, same pattern every time
    const metroR = Math.max(3, Math.min(110, 0.0312 * Math.sqrt(node.pop)));
    const u = Math.max(0, Math.min(1, (Math.log10(node.pop) - 2) / 4.92)); // 100 -> 0, 8.34M -> 1
    const intensity = 0.10 + 0.58 * Math.pow(u, 1.6);
    const clusters = Math.round(2 + u * 10);

    for (let i = 0; i < clusters; i++) {
      const ang = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * metroR;
      const cx = node.x + Math.cos(ang) * r, cy = node.y + Math.sin(ang) * r;
      const cr = metroR * (0.25 + rnd() * 0.35);
      const color = GLOW_WARM_COLORS[i % GLOW_WARM_COLORS.length];
      const grad = gctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
      grad.addColorStop(0, `rgba(${color}, ${intensity})`);
      grad.addColorStop(1, `rgba(${color}, 0)`);
      gctx.fillStyle = grad;
      gctx.beginPath();
      gctx.arc(cx, cy, cr, 0, Math.PI * 2);
      gctx.fill();
    }

    // Bright core dot at the city itself, so even a small town reads as a
    // distinct pinprick rather than only a diffuse haze.
    const coreGrad = gctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, metroR * 0.18 + 1.5);
    coreGrad.addColorStop(0, `rgba(255, 245, 220, ${Math.min(1, intensity + 0.25)})`);
    coreGrad.addColorStop(1, "rgba(255, 245, 220, 0)");
    gctx.fillStyle = coreGrad;
    gctx.beginPath();
    gctx.arc(node.x, node.y, metroR * 0.18 + 1.5, 0, Math.PI * 2);
    gctx.fill();
  }

  return glow;
}

// ---------------------------------------------------------------------

export function renderStaticBackground(graph, opts = {}) {
  const showStateBorders = opts.showStateBorders !== false; // default on
  const bg = document.createElement("canvas");
  bg.width = WORLD_WIDTH * BG_SCALE;
  bg.height = WORLD_HEIGHT * BG_SCALE;
  const ctx = bg.getContext("2d");
  ctx.scale(BG_SCALE, BG_SCALE);

  ctx.fillStyle = VOID_COLOR;
  ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

  ctx.lineCap = "round";

  // The state rings are closed polygons, so filling them (rather than only
  // stroking, as this used to) yields the whole continental landmass in one
  // path - and because coastlines, the Great Lakes, Chesapeake Bay and
  // Puget Sound are all already separate rings in the data, they fall out
  // as correctly-unfilled water for free. This single fill is what turns
  // the map from "lines floating in a void" into an actual map, and gives
  // the day/night grade a surface to act on.
  ctx.beginPath();
  for (const ring of STATE_BORDER_RINGS) {
    ctx.moveTo(ring[0], ring[1]);
    for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i], ring[i + 1]);
    ctx.closePath();
  }
  ctx.fillStyle = LAND_COLOR;
  ctx.fill();
  // Reuse the exact same path for the border strokes - no need to rebuild it.
  if (showStateBorders) {
    ctx.strokeStyle = STATE_BORDER_COLOR;
    ctx.lineWidth = STATE_BORDER_WIDTH;
    ctx.stroke();
  }

  return bg;
}

// Flat, precomputed edge list for the per-frame road pass - built once
// (memoized per graph object; `graph` itself never changes after boot) so
// drawRoads never re-walks graph.adjacency. Each entry carries a cached
// unit perpendicular (px, py) and a bounding box for cheap per-edge
// culling, in addition to the raw endpoints.
const edgeListCache = new WeakMap();
export function buildEdgeList(graph) {
  let cached = edgeListCache.get(graph);
  if (cached) return cached;

  const edges = [];
  // Maps BOTH directed edge objects of a segment to that segment's index
  // in `edges`. Keyed by object identity, so the per-frame congestion
  // tally can find a truck's segment with a plain Map lookup instead of
  // rebuilding an "a|b|route" string for every truck every frame - at
  // 5000 trucks that string churn would dwarf the drawing itself.
  const indexByEdge = new Map();
  for (const name in graph.nodes) {
    const node = graph.nodes[name];
    for (const e of graph.adjacency[name]) {
      if (name > e.to) continue; // each undirected edge stored once
      const other = graph.nodes[e.to];
      const dx = other.x - node.x, dy = other.y - node.y;
      const len = Math.hypot(dx, dy) || 1;
      const idx = edges.length;
      edges.push({
        ax: node.x, ay: node.y, bx: other.x, by: other.y,
        kind: e.kind,
        px: -dy / len, py: dx / len,
        len, // world-space length, so congestion can be a DENSITY not a raw count
        minX: Math.min(node.x, other.x), maxX: Math.max(node.x, other.x),
        minY: Math.min(node.y, other.y), maxY: Math.max(node.y, other.y),
      });
      indexByEdge.set(e, idx);
      // The reverse direction is a different object on the other node's
      // adjacency list; find it so both directions of travel count toward
      // the same physical segment's congestion.
      const back = graph.adjacency[e.to].find((r) => r.to === name && r.route === e.route);
      if (back) indexByEdge.set(back, idx);
    }
  }
  let totalLen = 0;
  for (const e of edges) totalLen += e.len;
  cached = { edges, indexByEdge, totalLen, counts: new Int32Array(edges.length) };
  edgeListCache.set(graph, cached);
  return cached;
}

// Live truck count per physical road segment, reusing one Int32Array
// rather than allocating per frame. Also returns the network-wide mean
// density, which the heat bands are expressed as multiples of: what
// counts as "congested" has to be relative to how many trucks are out
// there at all, or a 500-truck fleet would never light up anything and a
// 5000-truck fleet would light up everything.
function tallyCongestion(edgeList, trucks) {
  const counts = edgeList.counts;
  counts.fill(0);
  let onRoad = 0;
  for (const truck of trucks) {
    if (!truck.edge) continue;
    const idx = edgeList.indexByEdge.get(truck.edge);
    if (idx !== undefined) { counts[idx]++; onRoad++; }
  }
  const meanDensity = (onRoad / edgeList.totalLen) * 100;
  return { counts, meanDensity };
}

function edgeVisible(e, cull) {
  if (cull.nav) {
    // Cheap conservative circle-vs-bbox test: nearest point on the bbox to
    // the cull circle's center, compared against the (already padded)
    // radius. False positives (drawing a few extra off-screen edges) are
    // fine; this never produces a false negative.
    const nx = Math.max(e.minX, Math.min(cull.cx, e.maxX));
    const ny = Math.max(e.minY, Math.min(cull.cy, e.maxY));
    return (nx - cull.cx) ** 2 + (ny - cull.cy) ** 2 <= cull.radiusSq;
  }
  return e.maxX >= cull.minX && e.minX <= cull.maxX && e.maxY >= cull.minY && e.minY <= cull.maxY;
}

// How far into "full road detail" the current zoom is, 0..1. Shared so
// the headlight pass can gate on exactly the same threshold the road
// detail does, instead of duplicating the formula and letting the two
// silently drift apart.
export function roadDetailFactor(camera) {
  const bandPx = BAND_HALF * 2 * camera.zoom;
  return Math.max(0, Math.min(1, (bandPx - DETAIL_MIN_PX) / (DETAIL_FULL_PX - DETAIL_MIN_PX)));
}

// Congestion is drawn as a few discrete heat bands rather than a
// per-edge colour, specifically so the batching survives: a continuous
// gradient would force one stroke() per segment, whereas bucketing keeps
// the whole overlay to one stroke per band.
//
// Density is trucks per 100 world units of road, NOT a raw count -
// counting per edge would call a handful of trucks spread over a 400-mile
// desert run "as congested as" the same handful nose-to-tail through
// Chicago, which is exactly backwards. `mult` is then a multiple of the
// network-wide mean density, so the scale self-calibrates to fleet size.
// Measured distribution (see the density calibration run): the mean sits
// near the 60th percentile, so 1.7x/3x/5x lands roughly on the busiest
// 20% / 8% / 2% of segments at any fleet size.
// Thresholds as multiples of the network's own mean truck density, so they
// self-calibrate to fleet size instead of needing a retune every time the
// truck count changes.
//
// Calibrated against a warmed-up sim rather than by eye. The original
// 1.7/3.0/5.0 lit up ~25% of all 543 segments at every fleet size, which
// made congestion the map's default state rather than a signal. At
// 4.0/7.0/11.0 a 500-truck fleet shows roughly 32 amber / 7 orange / 1 red
// - a handful of genuinely busy corridors and a rare real jam, which is
// what the colour is meant to mean.
const CONGESTION_BANDS = [
  { mult: 4.0, color: "rgba(245, 182, 52, 0.75)" },
  { mult: 7.0, color: "rgba(240, 112, 34, 0.86)" },
  { mult: 11.0, color: "rgba(228, 46, 40, 0.94)" },
];

// Draws every road edge for the current frame: a zoom-driven cross-fade
// between a simplified single line (whole-country/atlas view) and the
// full asphalt-band + fog-lines + shoulder-outline + median treatment
// (follow/nav view), day/night tinted. Batches one beginPath()/stroke()
// per (kind x layer) so the whole road network costs at most ~8 stroke
// calls regardless of fleet size.
export function drawRoads(ctx, edgeList, camera, cull, colorT, showMedians, congestion) {
  const k = roadDetailFactor(camera);
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";

  const visible = { highway: [], interstate: [] };
  const visibleIdx = { highway: [], interstate: [] };
  const edges = edgeList.edges;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!edgeVisible(e, cull)) continue;
    visible[e.kind].push(e);
    visibleIdx[e.kind].push(i);
  }

  if (k < 1) {
    // Simplified atlas-style line, highway first then interstate on top,
    // constant-screen-width regardless of zoom.
    for (const kind of ["highway", "interstate"]) {
      const list = visible[kind];
      if (!list.length) continue;
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = lerpColor(kind === "interstate" ? "#2d6ed2" : "#d67a28", kind === "interstate" ? "#aacdee" : "#e8a877", colorT);
      ctx.lineWidth = SIMPLE_PX[kind] / camera.zoom;
      ctx.beginPath();
      for (const e of list) { ctx.moveTo(e.ax, e.ay); ctx.lineTo(e.bx, e.by); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  if (k > 0) {
    // A stroke thinner than about three quarters of a screen pixel paints
    // a faint smear that is indistinguishable from not drawing it at all -
    // but it still costs a full pass over every visible edge plus the
    // rasterisation of an antialiased hairline the length of the country.
    // The fog lines (1.0 world unit) and the median (0.7) go sub-pixel
    // below zoom ~1, which is exactly the mid-zoom range that profiled as
    // the worst frame time in the app, so skipping them there removes real
    // work and changes nothing you can see. Each layer is gated on its own
    // on-screen width rather than on a single blanket zoom threshold.
    const MIN_VISIBLE_PX = 0.75;
    const onScreen = (worldWidth) => worldWidth * camera.zoom >= MIN_VISIBLE_PX;
    const drawShoulders = onScreen(SHOULDER_LINE_WIDTH);
    const drawFog = onScreen(FOG_LINE_WIDTH);
    const drawMedian = onScreen(MEDIAN_WIDTH);

    ctx.globalAlpha = k;
    for (const kind of ["highway", "interstate"]) {
      const list = visible[kind];
      if (!list.length) continue;
      const half = kind === "interstate" ? BAND_HALF : HWY_BAND_HALF;
      const fog = kind === "interstate" ? FOG_OFFSET : HWY_FOG;
      const dayC = ROAD_DAY[kind], nightC = ROAD_NIGHT[kind];

      // Asphalt band
      ctx.strokeStyle = lerpRgba(dayC.band, nightC.band, colorT);
      ctx.lineWidth = half * 2;
      ctx.beginPath();
      for (const e of list) { ctx.moveTo(e.ax, e.ay); ctx.lineTo(e.bx, e.by); }
      ctx.stroke();

      // Shoulder outlines, both sides
      if (drawShoulders) {
        ctx.strokeStyle = lerpColor(dayC.shoulder, nightC.shoulder, colorT);
        ctx.lineWidth = SHOULDER_LINE_WIDTH;
        ctx.beginPath();
        for (const e of list) {
          ctx.moveTo(e.ax + e.px * half, e.ay + e.py * half);
          ctx.lineTo(e.bx + e.px * half, e.by + e.py * half);
          ctx.moveTo(e.ax - e.px * half, e.ay - e.py * half);
          ctx.lineTo(e.bx - e.px * half, e.by - e.py * half);
        }
        ctx.stroke();
      }

      // Fog lines, both sides
      if (drawFog) {
        ctx.strokeStyle = lerpColor(dayC.fog, nightC.fog, colorT);
        ctx.lineWidth = FOG_LINE_WIDTH;
        ctx.beginPath();
        for (const e of list) {
          ctx.moveTo(e.ax + e.px * fog, e.ay + e.py * fog);
          ctx.lineTo(e.bx + e.px * fog, e.by + e.py * fog);
          ctx.moveTo(e.ax - e.px * fog, e.ay - e.py * fog);
          ctx.lineTo(e.bx - e.px * fog, e.by - e.py * fog);
        }
        ctx.stroke();
      }

      // Median - interstates only, centerline
      if (kind === "interstate" && showMedians && drawMedian) {
        ctx.strokeStyle = dayC.median;
        ctx.lineWidth = MEDIAN_WIDTH;
        ctx.beginPath();
        for (const e of list) { ctx.moveTo(e.ax, e.ay); ctx.lineTo(e.bx, e.by); }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // Congestion heat, laid over the finished road so a jam reads as the
  // pavement itself glowing hot. Widths track the same LOD cross-fade as
  // the roads underneath, so the heat never floats wider than its road.
  if (congestion && congestion.meanDensity > 0) {
    const counts = congestion.counts, mean = congestion.meanDensity;
    ctx.save();
    // Deliberately opaque source-over rather than additive: the road
    // should BECOME amber/red, not glow toward white. Additive blending
    // over a blue interstate pushes hot segments to a pale pink that
    // reads as "highlighted" rather than "jammed" - tried it, and the
    // severity ordering was impossible to see at a glance.
    for (const kind of ["highway", "interstate"]) {
      const list = visible[kind], idxs = visibleIdx[kind];
      if (!list.length) continue;
      // Paint the SHOULDERS, not the full carriageway: two strokes sitting
      // on the paved shoulder either side, leaving the travel lanes (and
      // the trucks in them) clearly visible through the middle. Offsets
      // are the true shoulder centreline in world units so they stay
      // locked to the road geometry at every zoom; the width only gets a
      // screen-space floor so the strokes never vanish sub-pixel when
      // zoomed out to the whole country.
      const fogOff = kind === "interstate" ? FOG_OFFSET : HWY_FOG;
      const bandHalf = kind === "interstate" ? BAND_HALF : HWY_BAND_HALF;
      const shoulderCentre = (fogOff + bandHalf) / 2;
      const shoulderW = Math.max(bandHalf - fogOff, 1.4 / camera.zoom);
      for (let bi = CONGESTION_BANDS.length - 1; bi >= 0; bi--) {
        const band = CONGESTION_BANDS[bi];
        const next = CONGESTION_BANDS[bi + 1];
        const lo = band.mult * mean, hi = next ? next.mult * mean : Infinity;
        let started = false;
        for (let j = 0; j < list.length; j++) {
          const e = list[j];
          const d = (counts[idxs[j]] / e.len) * 100; // trucks per 100 world units
          if (d < lo || d >= hi) continue;
          if (!started) { ctx.beginPath(); started = true; }
          ctx.moveTo(e.ax + e.px * shoulderCentre, e.ay + e.py * shoulderCentre);
          ctx.lineTo(e.bx + e.px * shoulderCentre, e.by + e.py * shoulderCentre);
          ctx.moveTo(e.ax - e.px * shoulderCentre, e.ay - e.py * shoulderCentre);
          ctx.lineTo(e.bx - e.px * shoulderCentre, e.by - e.py * shoulderCentre);
        }
        if (started) {
          ctx.strokeStyle = band.color;
          ctx.lineWidth = shoulderW;
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
}

function lerpRgba(rgbaA, rgbaB, t) {
  const parse = (s) => s.match(/[\d.]+/g).map(Number);
  const a = parse(rgbaA), b = parse(rgbaB);
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  const al = a[3] + ((b[3] ?? 1) - a[3]) * t;
  return `rgba(${r}, ${g}, ${bl}, ${al})`;
}

// Weather systems as soft radial patches. Drawn over the roads but under
// the sky grade, so a storm at night is correctly swallowed by the dark
// rather than glowing through it. Only a handful of cells exist, so this
// is a few gradient fills per frame.
// Weather reads as a FRONT, not as fog. The interior wash stays light on
// purpose - a storm should never take over the map - so legibility comes
// from a defined rim and a name rather than from opacity.
//
// The soft-gradient-only version was hardest to see in exactly the case
// that matters most: zoomed in, the viewport can sit entirely INSIDE one
// cell, so there is no edge anywhere on screen and no unaffected ground to
// compare against. A uniform faint tint with no reference is invisible. A
// rim gives the eye something to lock onto, and the label says what it is
// without covering anything.
//
// Rain also had almost no hue contrast to fight with: its old blue-grey
// sat a few points away from the land and road palette it was painted
// over. These are pushed toward cyan so the same alpha reads as weather
// instead of as a slightly different grey.
const WEATHER_STYLE = {
  rain: { fill: "96, 158, 216", rim: "132, 202, 250", label: "RAIN" },
  snow: { fill: "214, 234, 255", rim: "240, 250, 255", label: "SNOW" },
};
// Below this on-screen radius a cell is too small to label without the
// text becoming map clutter rather than information. Tuned so the larger
// systems are named at country zoom - which is the view where you are
// picking systems out of the whole map and most want to know which is
// which. Zoomed in far enough to be inside a cell the label is off
// screen anyway, and there the tint hue and the front arc carry it.
const WEATHER_LABEL_MIN_PX = 44;

export function drawWeather(ctx, cells, cull, camera) {
  const zoom = camera ? camera.zoom : 1;
  const visible = [];
  for (const c of cells) {
    if (cull.nav) {
      const dx = c.x - cull.cx, dy = c.y - cull.cy;
      const reach = c.r + Math.sqrt(cull.radiusSq);
      if (dx * dx + dy * dy > reach * reach) continue;
    } else if (c.x + c.r < cull.minX || c.x - c.r > cull.maxX ||
               c.y + c.r < cull.minY || c.y - c.r > cull.maxY) {
      continue;
    }
    visible.push(c);
  }
  if (!visible.length) return;

  // Interior wash. Each cell needs its own gradient (they differ in
  // centre, radius and intensity), so this one cannot batch.
  for (const c of visible) {
    const st = WEATHER_STYLE[c.kind] || WEATHER_STYLE.rain;
    const grad = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
    grad.addColorStop(0, `rgba(${st.fill}, ${0.30 * c.intensity})`);
    grad.addColorStop(0.55, `rgba(${st.fill}, ${0.16 * c.intensity})`);
    grad.addColorStop(1, `rgba(${st.fill}, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // The fronts: one dashed path per kind rather than one per cell.
  // setLineDash forces the path to be re-tessellated on stroke, so the
  // number of dashed strokes is what costs, not the number of arcs in
  // them. Rim alpha is fixed per kind for that reason - per-cell
  // intensity would force a separate stroke each and is already carried
  // by the wash underneath.
  ctx.save();
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([11 / zoom, 8 / zoom]);
  for (const kind of ["rain", "snow"]) {
    const list = visible.filter((c) => (c.kind === "snow" ? "snow" : "rain") === kind);
    if (!list.length) continue;
    ctx.strokeStyle = `rgba(${WEATHER_STYLE[kind].rim}, 0.62)`;
    ctx.beginPath();
    for (const c of list) {
      // moveTo before each arc so the ring is its own subpath and no
      // connecting line is drawn between cells.
      ctx.moveTo(c.x + c.r * 0.94, c.y);
      ctx.arc(c.x, c.y, c.r * 0.94, 0, Math.PI * 2);
    }
    ctx.stroke();
  }
  ctx.restore();

  // Named near the top of the cell rather than dead centre, so the label
  // does not sit on whatever city or interchange is under the middle of
  // it. Only the larger systems get named - see WEATHER_LABEL_MIN_PX.
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = `600 ${11 / zoom}px "Oswald", sans-serif`;
  for (const c of visible) {
    if (c.r * zoom <= WEATHER_LABEL_MIN_PX) continue;
    const st = WEATHER_STYLE[c.kind] || WEATHER_STYLE.rain;
    ctx.fillStyle = `rgba(${st.rim}, ${0.45 + 0.4 * c.intensity})`;
    ctx.fillText(st.label, c.x, c.y - c.r * 0.94 + 16 / zoom);
  }
  ctx.restore();
}

// City dots, per-frame (moved out of the static bake alongside roads so a
// wide asphalt band never paints over a big city's dot). Batched by tier
// color: at most 4 beginPath()/fill() calls for the whole map.
export function drawCityDots(ctx, graph, cull) {
  const buckets = [[], [], [], []];
  for (const name in graph.nodes) {
    const node = graph.nodes[name];
    if (node.t === 0) continue;
    if (cull.nav) {
      if ((node.x - cull.cx) ** 2 + (node.y - cull.cy) ** 2 > cull.radiusSq) continue;
    } else if (node.x < cull.minX || node.x > cull.maxX || node.y < cull.minY || node.y > cull.maxY) {
      continue;
    }
    buckets[Math.min(3, node.t - 1)].push(node);
  }
  for (let tier = 0; tier < 4; tier++) {
    const list = buckets[tier];
    if (!list.length) continue;
    ctx.fillStyle = CITY_DOT_COLOR[tier];
    ctx.beginPath();
    for (const node of list) {
      const radius = cityDotRadius(node);
      ctx.moveTo(node.x + radius, node.y);
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}

// Draws every city's label whose tier is currently revealed at `zoom`
// relative to `baseZoom`. Called inside the same camera-transformed
// context as the rest of the dynamic layer, so world-space font sizes
// scale naturally with zoom, same as everything else on the map.
// `showAllLabels` (a settings toggle) bypasses the zoom gating entirely -
// every tier renders regardless of how zoomed out the camera is.
// `counterRotation` (radians, 0 outside FOLLOW_NAV) cancels out the
// camera's own rotation for each label individually so text stays
// upright and readable while the world spins around it underneath.
// `onRouteCities` (a Set<string> of city names, or null when not
// following a truck) shrinks every label NOT in the set an additional
// OFF_ROUTE_LABEL_SCALE, on top of its normal tier size - de-emphasizing
// everything off the followed truck's route ahead.
// Font strings are built once and reused. Assigning ctx.font re-parses a
// CSS font shorthand, which is one of the more expensive things you can do
// per label, so both the concatenation and the assignment are avoided
// whenever the value has not actually changed.
// Parked-truck badge: a small count tucked against the top-right of a
// city's label. Drawn as outlined text rather than a pill so it costs two
// text calls and no extra path work per label - at country zoom with the
// label cascade open there can be a couple hundred of these on screen.
const PARKED_BADGE_COLOR = "#f0b429";
const PARKED_BADGE_OUTLINE = "rgba(6, 10, 18, 0.92)";
const PARKED_BADGE_SCALE = 0.82; // relative to the city label's own font size

const fontStrCache = new Map();
function labelFont(px) {
  let s = fontStrCache.get(px);
  if (s === undefined) {
    s = `600 ${px}px "Oswald", sans-serif`;
    fontStrCache.set(px, s);
  }
  return s;
}

function drawCityLabels(ctx, graph, zoom, baseZoom, showAllLabels, counterRotation, onRouteCities, cull, parkedCounts) {
  ctx.textAlign = "center";
  let lastFont = null;
  for (const name in graph.nodes) {
    const node = graph.nodes[name];
    if (node.t === 0) continue;
    if (!showAllLabels) {
      const mult = LABEL_TIER_ZOOM_MULT[node.t] ?? Infinity;
      if (zoom < baseZoom * mult) continue;
    }
    // Viewport cull. Without this every one of the ~343 real cities was
    // drawn on every frame once zoom passed the tier thresholds - a
    // ctx.font assignment plus a fillText each - no matter how far off
    // screen it was. Measured at max zoom, where a handful of cities are
    // actually visible, this was still issuing 343 fillText calls a frame.
    if (cull) {
      if (cull.nav) {
        if ((node.x - cull.cx) ** 2 + (node.y - cull.cy) ** 2 > cull.radiusSq) continue;
      } else if (node.x < cull.minX || node.x > cull.maxX || node.y < cull.minY || node.y > cull.maxY) {
        continue;
      }
    }
    const radius = cityDotRadius(node);
    let fontPx = LABEL_FONT_PX[node.t];
    if (onRouteCities && !onRouteCities.has(name)) fontPx *= OFF_ROUTE_LABEL_SCALE;
    const font = labelFont(fontPx);
    if (font !== lastFont) { ctx.font = font; lastFont = font; }
    ctx.fillStyle = LABEL_COLOR[node.t];
    const parked = parkedCounts ? parkedCounts.get(name) : 0;
    if (counterRotation) {
      // Nav view: labels should look like they're standing up off the
      // tilted ground rather than lying flat on it - a stem rising from
      // the city dot plus a drop-shadowed label at its top, the standard
      // 3D-map POI treatment. Drawn inside a local frame that cancels
      // BOTH the heading-rotation (counterRotation) and the ambient
      // tilt-squash (1/TILT_FACTOR) so the stem renders as a clean
      // vertical screen-space line and the text stays undistorted,
      // independent of the current heading or tilt steepness.
      ctx.save();
      ctx.translate(node.x, node.y);
      ctx.rotate(counterRotation);
      ctx.scale(1, 1 / TILT_FACTOR);
      const stemH = radius + 14;
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, -radius);
      ctx.lineTo(0, -stemH);
      ctx.stroke();
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillText(node.name, 1.5, -stemH - 3.5);
      ctx.fillStyle = LABEL_COLOR[node.t];
      ctx.fillText(node.name, 0, -stemH - 5);
      // The badge is drawn INSIDE this same counter-rotated, un-squashed
      // frame as the label it belongs to. Drawn outside it (as it first
      // was) it stayed flat on the tilted ground while the label stood up,
      // so in nav view the number visibly detached from its own label.
      if (parked) drawParkedBadge(ctx, parked, ctx.measureText(node.name).width / 2, -stemH - 5, fontPx);
      ctx.restore();
      lastFont = null; // the badge changed ctx.font inside a restored frame
    } else {
      ctx.fillText(node.name, node.x, node.y - radius - 5);
      if (parked) {
        drawParkedBadge(ctx, parked, node.x + ctx.measureText(node.name).width / 2, node.y - radius - 5, fontPx);
        lastFont = null;
      }
    }
  }
}

// Shared by both label orientations. `anchorX` is the right edge of the
// label text and `baseY` its baseline, both in whatever frame the caller
// is currently in - which is what lets the nav-view path draw it inside
// its counter-rotated frame without any special-casing here.
function drawParkedBadge(ctx, count, anchorX, baseY, fontPx) {
  const badgePx = fontPx * PARKED_BADGE_SCALE;
  ctx.font = labelFont(badgePx);
  const bx = anchorX + badgePx * 0.55;
  const by = baseY - fontPx * 0.42;
  ctx.lineWidth = badgePx * 0.42;
  ctx.strokeStyle = PARKED_BADGE_OUTLINE;
  ctx.lineJoin = "round";
  ctx.strokeText(count, bx, by);
  ctx.fillStyle = PARKED_BADGE_COLOR;
  ctx.fillText(count, bx, by);
}

// The point on the road's centerline (median, for a divided interstate)
// at a truck's current progress - i.e. truckWorldPos without the lane
// offset. Exported so the dashed route-preview line can emanate from the
// road itself rather than visibly starting off to one side at the
// truck's actual (lane-offset) dot position.
export function truckCenterlinePos(graph, truck, out = { x: 0, y: 0 }) {
  if (!truck.edge) {
    const n = graph.nodes[truck.currentNode];
    out.x = n.x; out.y = n.y;
    return out;
  }
  const edge = truck.edge;
  const a = graph.nodes[edge.from], b = graph.nodes[edge.to];
  const t = Math.max(0, Math.min(1, truck.s / edge.miles));
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  return out;
}

// `out` (optional): reused output object instead of a fresh allocation -
// the per-frame truck draw loop (drawFrame) passes one shared scratch
// object here for every truck to avoid allocating thousands of short-lived
// {x,y} literals per frame at large fleet sizes. Every other call site
// (main.js, the route-preview line below) omits it and gets today's exact
// fresh-object behavior for free.
export function truckWorldPos(graph, truck, out = { x: 0, y: 0 }) {
  if (!truck.edge) return truckCenterlinePos(graph, truck, out);

  const edge = truck.edge;
  truckCenterlinePos(graph, truck, out); // writes the centerline position into `out`

  // Perpendicular offset to the right of travel, derived from the
  // edge's stored compass bearing: rightX=cos(theta), rightY=sin(theta)
  // (theta=0/north -> right=east; theta=90/east -> right=south - matches
  // real-world driving-on-the-right). The reverse-direction edge stores
  // bearing+180, so its right-vector is the negation of this one -
  // opposing traffic lands on the opposite side of the median for free.
  //
  // An edge's bearing never changes, so the sin/cos pair is computed once
  // and memoised on the edge itself. This runs for every truck on every
  // frame - at 3000 trucks that was 6000 trig calls a frame purely to
  // recompute constants.
  let rightX = edge._rightX;
  if (rightX === undefined) {
    const rad = (edge.bearing * Math.PI) / 180;
    rightX = edge._rightX = Math.cos(rad);
    edge._rightY = Math.sin(rad);
  }
  // Interstates blend between two lanes as trucks pass; highways have a
  // single lane each way, so they take a fixed offset with no laneT term.
  // The reverse-direction edge negates the right-vector for free (see
  // above), which is what puts opposing highway traffic on the far side.
  const off = edge.kind === "interstate"
    ? RIGHT_LANE_OFFSET + (LEFT_LANE_OFFSET - RIGHT_LANE_OFFSET) * truck.laneT
    : HIGHWAY_LANE_OFFSET;
  out.x += rightX * off;
  out.y += edge._rightY * off;
  return out;
}

export function drawFrame(ctx, canvas, camera, graph, bgCanvas, edgeList, glowCanvas, trucks, selectedTruck, renderOpts = {}) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.fillStyle = VOID_COLOR;
  ctx.fillRect(0, 0, w, h);

  const center = camera.visualCenter();
  const nav = camera.mode === "FOLLOW_NAV";

  // Viewport-cull bounds for the per-truck/per-road/per-dot draw loops
  // below - computed once per frame, in world space, from the same camera
  // state the transform block just below derives its own matrix from.
  // Simulation (fleet.js) never sees this: every truck keeps updating
  // regardless, only drawing is skipped for things clearly outside it.
  let cullMinX, cullMaxX, cullMinY, cullMaxY, cullCx, cullCy, cullRadius, cullRadiusSq;
  if (nav) {
    // Rotation makes the true visible region a rotated parallelogram, not
    // an axis-aligned rect - use a padded circle instead of computing that
    // exactly. TILT_FACTOR < 1 means the tilt-compressed axis always has
    // the smaller effective scale regardless of current heading, so
    // dividing by zoom*TILT_FACTOR (rather than plain zoom) is always the
    // conservative choice - it can only make the circle bigger than truly
    // needed, never smaller (never clips something that should be visible).
    const maxCornerDist = Math.max(
      Math.hypot(0 - center.x, 0 - center.y),
      Math.hypot(w - center.x, 0 - center.y),
      Math.hypot(0 - center.x, h - center.y),
      Math.hypot(w - center.x, h - center.y),
    );
    cullCx = camera.x;
    cullCy = camera.y;
    cullRadius = maxCornerDist / (camera.zoom * TILT_FACTOR) + CULL_PAD_WORLD_UNITS;
    cullRadiusSq = cullRadius * cullRadius;
  } else {
    // FREE/FOLLOW: no rotation, so the screen->world map is a plain
    // uniform scale+translate - the exact inverse of the two opposite
    // screen corners gives an exact (not approximate) axis-aligned bound.
    cullMinX = camera.x + (0 - center.x) / camera.zoom - CULL_PAD_WORLD_UNITS;
    cullMaxX = camera.x + (w - center.x) / camera.zoom + CULL_PAD_WORLD_UNITS;
    cullMinY = camera.y + (0 - center.y) / camera.zoom - CULL_PAD_WORLD_UNITS;
    cullMaxY = camera.y + (h - center.y) / camera.zoom + CULL_PAD_WORLD_UNITS;
  }
  // Roads/city dots use the same shape of cull test but with a wider pad
  // (the asphalt band extends much further off-centerline than a dot's
  // footprint) - share the circle center/AABB, override just the pad.
  const roadCull = nav
    ? { nav: true, cx: cullCx, cy: cullCy, radiusSq: (cullRadius - CULL_PAD_WORLD_UNITS + ROAD_CULL_PAD_WORLD_UNITS) ** 2 }
    : {
        nav: false,
        minX: cullMinX - ROAD_CULL_PAD_WORLD_UNITS + CULL_PAD_WORLD_UNITS,
        maxX: cullMaxX + ROAD_CULL_PAD_WORLD_UNITS - CULL_PAD_WORLD_UNITS,
        minY: cullMinY - ROAD_CULL_PAD_WORLD_UNITS + CULL_PAD_WORLD_UNITS,
        maxY: cullMaxY + ROAD_CULL_PAD_WORLD_UNITS - CULL_PAD_WORLD_UNITS,
      };

  // Day/night: derived once per frame from the sim clock (never from
  // real-world time), damped against the time-scale-strobing concern via
  // effectiveDarkness. Also used below for the "skip the overlay/glow
  // entirely at high noon" fast path.
  const dayNightOn = renderOpts.showDayNight !== false;
  const gameSeconds = renderOpts.gameSeconds || 0;
  const timeScale = renderOpts.timeScale ?? 1;
  const visMinX = nav ? cullCx - cullRadius : cullMinX;
  const visMaxX = nav ? cullCx + cullRadius : cullMaxX;
  let darkAtMin = 0, darkAtMid = 0, darkAtMax = 0;
  if (dayNightOn) {
    darkAtMin = effectiveDarkness(rawDarknessAtX(Math.max(0, Math.min(WORLD_WIDTH, visMinX)), gameSeconds), timeScale);
    darkAtMid = effectiveDarkness(rawDarknessAtX(Math.max(0, Math.min(WORLD_WIDTH, (visMinX + visMaxX) / 2)), gameSeconds), timeScale);
    darkAtMax = effectiveDarkness(rawDarknessAtX(Math.max(0, Math.min(WORLD_WIDTH, visMaxX)), gameSeconds), timeScale);
  }
  const anyDarkness = darkAtMin > 0.01 || darkAtMid > 0.01 || darkAtMax > 0.01;
  const colorT = Math.max(darkAtMin, darkAtMid, darkAtMax) / NIGHT_DARKNESS_MAX; // 0..1, for road/label day->night color lerp
  // The sky grade is non-zero for far more of the day than `darkness` is
  // (golden hour is a strong tint at zero darkness), so it needs its own
  // fast-path test rather than reusing anyDarkness - otherwise sunrise and
  // sunset would be skipped entirely.
  const anySky = dayNightOn && (
    skyTintAtX(visMinX, gameSeconds, timeScale).a > 0.004 ||
    skyTintAtX(visMaxX, gameSeconds, timeScale).a > 0.004
  );

  ctx.save();
  ctx.translate(center.x, center.y);
  // Scale before rotate: the anisotropic Y-compression must land along
  // screen-vertical (a fixed "depth" axis, like a real tilted camera)
  // BEFORE the heading-rotation is applied - not along the world's fixed
  // N/S axis, which is what calling rotate() first would do (the squash
  // direction would then visibly rotate together with the truck's
  // heading instead of staying tied to the screen). Verified with a real
  // ctx.getTransform() check during planning: canvas composes transforms
  // so the LAST call here is applied FIRST to a raw point, so this order
  // (scale, then rotate) is what keeps compression screen-fixed.
  ctx.scale(camera.zoom, nav ? camera.zoom * TILT_FACTOR : camera.zoom);
  if (nav) ctx.rotate(-camera.heading);
  ctx.translate(-camera.x, -camera.y);

  ctx.drawImage(bgCanvas, 0, 0, bgCanvas.width, bgCanvas.height, 0, 0, WORLD_WIDTH, WORLD_HEIGHT);

  const congestion = renderOpts.showCongestion ? tallyCongestion(edgeList, trucks) : null;
  drawRoads(ctx, edgeList, camera, roadCull, colorT, renderOpts.showMedians !== false, congestion);
  drawCityDots(ctx, graph, roadCull);
  if (renderOpts.showWeather && renderOpts.weather) drawWeather(ctx, renderOpts.weather, roadCull, camera);

  // Darkness overlay: a world-space horizontal gradient sampled across the
  // visible X-range, drawn INSIDE the camera transform so rotation/tilt
  // handle themselves for free - no rotated-gradient math needed. 5 stops
  // is plenty; the underlying darkness curve is smooth.
  // Sky grade: a horizontal gradient across the visible X range sampled
  // from the keyframed time-of-day ramp, so at any instant you can see
  // sunset actually crossing the country - warm on the eastern side while
  // the west is still bright, deep blue behind it. Drawn INSIDE the world
  // transform, so camera rotation and the nav tilt handle themselves.
  // 7 stops rather than 5: the ramp moves fastest through golden hour and
  // the extra samples keep that transition smooth across a wide viewport.
  if (dayNightOn && anySky) {
    ctx.save();
    const grad = ctx.createLinearGradient(visMinX, 0, visMaxX, 0);
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const tint = skyTintAtX(visMinX + (visMaxX - visMinX) * t, gameSeconds, timeScale);
      grad.addColorStop(t, `rgba(${tint.r}, ${tint.g}, ${tint.b}, ${tint.a})`);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(visMinX, nav ? cullCy - cullRadius : cullMinY, visMaxX - visMinX, nav ? cullRadius * 2 : cullMaxY - cullMinY);
    ctx.restore();
  }

  // City lights - pre-rendered glow canvas, composited in vertical slices
  // so each slice picks up its own local darkness (a real terminator, not
  // one flat alpha) rather than the whole glow fading in/out together.
  if (dayNightOn && anyDarkness && glowCanvas && renderOpts.showCityLights !== false) {
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    const pulse = 0.90 + Math.sin(gameSeconds * 0.02) * 0.08 + Math.cos(gameSeconds * 0.053) * 0.03;
    const SLICE_W = 500; // 8 slices across the full map width - halves the drawImage call count from the initial 250-wide design; still fine terminator granularity (30 min of local time per slice)
    const startSlice = Math.max(0, Math.floor(visMinX / SLICE_W));
    const endSlice = Math.min(Math.ceil(WORLD_WIDTH / SLICE_W) - 1, Math.floor(visMaxX / SLICE_W));
    for (let s = startSlice; s <= endSlice; s++) {
      const sx = s * SLICE_W;
      const sw = Math.min(SLICE_W, WORLD_WIDTH - sx);
      if (sw <= 0) continue;
      const d = effectiveDarkness(rawDarknessAtX(sx + sw / 2, gameSeconds), timeScale);
      const nightStrength = Math.pow(d / NIGHT_DARKNESS_MAX, 2.2);
      if (nightStrength < 0.01) continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, pulse * nightStrength));
      ctx.drawImage(
        glowCanvas,
        sx * GLOW_SCALE, 0, sw * GLOW_SCALE, glowCanvas.height,
        sx, 0, sw, WORLD_HEIGHT,
      );
    }
    ctx.restore();
  }

  // The remaining stop sequence ahead of the followed truck - `selectedTruck`
  // is only ever non-null while actually following a truck (FOLLOW or
  // FOLLOW_NAV; there's no "select without follow" state in this app), so
  // this doubles as "we're in follow mode with a route to show." Computed
  // once, up front, so both the label dimming below and the dashed
  // line/ring highlight further down share the same list. `remainingPath`
  // only holds the hops AFTER the truck's current edge (the current edge's
  // own endpoint already got shifted out of it into truck.edge by
  // _advanceToNextEdge) - forgetting to include that endpoint here made the
  // first drawn segment jump straight from the truck's position to the node
  // two hops ahead, skipping the immediate next node.
  let nodeSeq = null, onRouteCities = null;
  if (selectedTruck && selectedTruck.edge) {
    nodeSeq = [selectedTruck.edge.to, ...selectedTruck.remainingPath.map((e) => e.to)];
    onRouteCities = new Set(nodeSeq);
  }
  drawCityLabels(ctx, graph, camera.zoom, camera.baseZoom || camera.zoom, !!renderOpts.showAllLabels, nav ? camera.heading : 0, onRouteCities, roadCull, renderOpts.parkedCounts);

  if (nodeSeq) {
    // Built once and stroked twice: a dark casing underneath, then the
    // amber dashes on top. The route line has to stay readable crossing
    // both pale interstate bands and dark empty terrain, and a single
    // stroke could not do both.
    const routePath = new Path2D();
    const p0 = truckCenterlinePos(graph, selectedTruck);
    routePath.moveTo(p0.x, p0.y);
    for (const name of nodeSeq) {
      const n = graph.nodes[name];
      routePath.lineTo(n.x, n.y);
    }
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(10, 14, 22, 0.55)";
    ctx.lineWidth = 6.5 / camera.zoom;
    ctx.stroke(routePath);
    ctx.strokeStyle = "#ffc457";
    ctx.lineWidth = 3.6 / camera.zoom;
    ctx.setLineDash([13 / camera.zoom, 7 / camera.zoom]);
    ctx.stroke(routePath);
    ctx.restore();
    ctx.setLineDash([]);

    ctx.fillStyle = "#e8a33d";
    const waypointRadius = 3.5 / camera.zoom;
    for (let i = 0; i < nodeSeq.length - 1; i++) {
      const n = graph.nodes[nodeSeq[i]];
      ctx.beginPath();
      ctx.arc(n.x, n.y, waypointRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Highlight ring around every real city ahead on the route, flush
    // against its existing static dot (same radius formula as
    // drawCityDots, so the ring hugs it rather than using an arbitrary
    // fixed size). Junction filler nodes (t===0) have no dot to ring, so
    // they're skipped.
    ctx.strokeStyle = ROUTE_HIGHLIGHT_COLOR;
    ctx.lineWidth = 2 / camera.zoom;
    for (const name of nodeSeq) {
      const n = graph.nodes[name];
      if (n.t === 0) continue;
      const dotRadius = cityDotRadius(n);
      ctx.beginPath();
      ctx.arc(n.x, n.y, dotRadius + 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Batch every truck's dot by cargo color: at large fleet sizes this
  // collapses thousands of individual beginPath()/fill() calls down to at
  // most one per distinct truck-type color (7 today). Known, accepted
  // cosmetic tradeoff: paint order becomes "all of color A, then color B,
  // ..." instead of today's fleet-array interleave, so which of two
  // overlapping, differently-colored dots ends up on top can occasionally
  // differ from before - imperceptible at a 3.5px dot radius.
  for (const b of truckBuckets.values()) { b.xs.length = 0; b.ys.length = 0; }

  // In FOLLOW_NAV, the followed truck gets a directional arrow instead of
  // a plain dot (drawn separately, below) - so it's pulled out of the
  // batched pass here rather than pushed into its color bucket like
  // everyone else. Every other case (not selected, flat FOLLOW, or
  // momentarily edge-less) keeps the plain dot via the normal batch.
  const drawArrowForSelected = nav && selectedTruck && !!selectedTruck.edge;

  // Headlights are only worth drawing when it's actually dark AND we're
  // zoomed in far enough for the road detail to be showing - at
  // country-wide zoom the cones would be sub-pixel confetti, and that's
  // also exactly the zoom where the most trucks are on screen at once.
  //
  // The gate is FULL road detail (factor 1, zoom > 1.0), not merely "some
  // detail" (factor > 0, zoom > 0.53). The old threshold let cones switch
  // on across a zoom range that still shows nearly half the map - a couple
  // of thousand of them at a 3000 truck fleet - which profiled as the
  // single largest cost at mid zoom. Above zoom 1.0 the viewport covers
  // ~13% of the country, so the cone count stays naturally bounded, and
  // that is also the range where a cone is big enough to actually read as
  // a headlight rather than a speck.
  const headlightsOn = dayNightOn && renderOpts.showHeadlights !== false
    && darkAtMid > 0.22 && roadDetailFactor(camera) >= 1;
  headlightPts.length = 0;

  const scratchPos = { x: 0, y: 0 }; // reused across the whole loop - no per-truck allocation
  for (const truck of trucks) {
    if (drawArrowForSelected && truck === selectedTruck) continue;
    // Parked trucks sit exactly on their city's node (see truckCenterlinePos
    // for an edge-less truck) - drawing a dot there would just paint over
    // the city itself, and with several trucks parked at once, stack a pile
    // of overlapping dots on top of it. The existing amber badge next to
    // the city's label already reports how many are parked; no dot needed.
    if (truck.parkedAt) continue;
    truckWorldPos(graph, truck, scratchPos);
    const p = scratchPos;

    const visible = nav
      ? (p.x - cullCx) ** 2 + (p.y - cullCy) ** 2 <= cullRadiusSq
      : p.x >= cullMinX && p.x <= cullMaxX && p.y >= cullMinY && p.y <= cullMaxY;
    // selectedTruck always draws regardless of the cull test - protects
    // the followed-truck ring (and the nav-mode arrow) from ever
    // vanishing even if it briefly computes as just outside the
    // (already generous) bound.
    if (!visible && truck !== selectedTruck) continue;

    const bucket = truckBuckets.get(truck.contract.truckType.id);
    bucket.xs.push(p.x);
    bucket.ys.push(p.y);
    // Only moving trucks throw light, and only ones actually on an edge
    // have a bearing to throw it along.
    if (headlightsOn && truck.edge && truck.speed > 1) {
      headlightPts.push(p.x, p.y, truck.edge.bearing);
    }
  }

  // One path, one fill, for every headlight on screen - the whole reason
  // this is cheap enough to keep. "lighter" makes overlapping beams pool
  // brighter the way real headlights do on a busy lane.
  if (headlightPts.length) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = HEADLIGHT_COLOR;
    ctx.beginPath();
    for (let i = 0; i < headlightPts.length; i += 3) {
      const x = headlightPts[i], y = headlightPts[i + 1];
      const rad = (headlightPts[i + 2] * Math.PI) / 180;
      const fx = Math.sin(rad), fy = -Math.cos(rad);
      const rx = Math.cos(rad), ry = Math.sin(rad);
      // Deliberately a short, narrow cone - it should read as a truck's
      // own lights on the pavement just ahead of it, not a searchlight.
      ctx.moveTo(x + rx * HEADLIGHT_HALF_W, y + ry * HEADLIGHT_HALF_W);
      ctx.lineTo(x + fx * HEADLIGHT_LEN + rx * HEADLIGHT_SPREAD, y + fy * HEADLIGHT_LEN + ry * HEADLIGHT_SPREAD);
      ctx.lineTo(x + fx * HEADLIGHT_LEN - rx * HEADLIGHT_SPREAD, y + fy * HEADLIGHT_LEN - ry * HEADLIGHT_SPREAD);
      ctx.lineTo(x - rx * HEADLIGHT_HALF_W, y - ry * HEADLIGHT_HALF_W);
      // No closePath: fill() already treats every subpath as closed, so it
      // was a pure no-op visually - but one issued once per truck. It
      // profiled at 17% of all CPU at mid-zoom with a few thousand cones
      // in a single path.
    }
    ctx.fill();
    ctx.restore();
  }

  // Night dimming for the fleet only - labels are drawn after the
  // darkness overlay above so they stay fully readable regardless.
  const fleetAlpha = dayNightOn && darkAtMid > 0.01 ? 1 - darkAtMid * 0.2 : 1;
  // Cargo spotlight: because the fleet is already batched one pass per
  // cargo colour, "show me only the reefers" costs nothing extra - it's
  // just a different alpha per bucket, no filtering or extra passes.
  const spotlight = renderOpts.spotlightCargo || null;
  // Below roughly a pixel and a half across, a circle and a square are the
  // same handful of shaded pixels - but arc() has to flatten a curve into
  // segments where rect() is four points. That difference is irrelevant for
  // one dot and very much not irrelevant for three thousand, which is
  // exactly the situation at country zoom: the dot is 3.5 world units, so
  // under about zoom 0.43 every truck on screen is sub-pixel. Zoomed in,
  // where the dots are big enough for the shape to read, they stay round.
  const dotPx = TRUCK_DOT_RADIUS * camera.zoom;
  const squareDots = dotPx < 1.5;
  const dotSide = TRUCK_DOT_RADIUS * 2;
  for (const [id, b] of truckBuckets) {
    if (b.xs.length === 0) continue;
    ctx.globalAlpha = fleetAlpha * (spotlight && id !== spotlight ? 0.12 : 1);
    ctx.fillStyle = b.color;
    ctx.beginPath();
    if (squareDots) {
      for (let i = 0; i < b.xs.length; i++) {
        ctx.rect(b.xs[i] - TRUCK_DOT_RADIUS, b.ys[i] - TRUCK_DOT_RADIUS, dotSide, dotSide);
      }
    } else {
      for (let i = 0; i < b.xs.length; i++) {
        const x = b.xs[i], y = b.ys[i];
        ctx.moveTo(x + TRUCK_DOT_RADIUS, y); // starts this dot's subpath without a connecting line from the previous one
        ctx.arc(x, y, TRUCK_DOT_RADIUS, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Google-Maps-style directional arrow for the followed truck in nav
  // view, in place of its plain dot. No separate counter-rotation needed:
  // the whole scene (every truck's position included) is already inside
  // the outer scale/rotate(-camera.heading) transform above, so drawing
  // the arrow rotated by the truck's own world-space bearing naturally
  // lands pointing up-screen once camera.heading has eased to match -
  // during a turn, the momentary difference between the truck's
  // instantaneous edge.bearing and the still-easing camera.heading
  // produces a small, natural "banking" look, same as real turn-by-turn
  // nav apps. Reuses the same bearing convention as truckWorldPos's
  // right-vector (rightX=cos(theta), rightY=sin(theta)): forward is the
  // companion vector (sin(theta), -cos(theta)).
  if (drawArrowForSelected) {
    truckWorldPos(graph, selectedTruck, scratchPos);
    const rad = (selectedTruck.edge.bearing * Math.PI) / 180;
    const fx = Math.sin(rad), fy = -Math.cos(rad);
    const rx = Math.cos(rad), ry = Math.sin(rad);
    const tipLen = 9, backLen = 4, halfWidth = 5; // world units, same scale family as TRUCK_DOT_RADIUS (3.5)
    const { x, y } = scratchPos;
    ctx.beginPath();
    ctx.moveTo(x + fx * tipLen, y + fy * tipLen);
    ctx.lineTo(x - fx * backLen + rx * halfWidth, y - fy * backLen + ry * halfWidth);
    ctx.lineTo(x - fx * backLen - rx * halfWidth, y - fy * backLen - ry * halfWidth);
    ctx.closePath();
    ctx.fillStyle = selectedTruck.contract.truckType.color; // exact same field the dot uses - guarantees matching color
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.35)"; // thin dark outline so pale truck colors (e.g. Dry Van's near-white) stay visible
    ctx.lineWidth = 1 / camera.zoom;
    ctx.stroke();
  }

  // Selected-truck ring, drawn once on top of everything else, exactly as before.
  if (selectedTruck) {
    truckWorldPos(graph, selectedTruck, scratchPos);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.5 / camera.zoom;
    ctx.beginPath();
    ctx.arc(scratchPos.x, scratchPos.y, TRUCK_DOT_RADIUS + 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}
