// render.js - static background (roads + city dots, drawn once to an
// offscreen canvas) plus a per-frame dynamic layer (city labels, truck
// dots, selection ring, followed-truck route highlight). Roads/dots never
// move, so re-rendering them every frame would be wasted work at any
// fleet size. Labels DO need to be dynamic: which tiers are visible
// depends on the live camera zoom, so they're drawn fresh each frame
// against camera.baseZoom (the initial fit-to-screen zoom set by main.js).
import { WORLD_WIDTH, WORLD_HEIGHT } from "./geo.js";
import { STATE_BORDER_RINGS } from "./states-data.js";
import { TILT_FACTOR } from "./camera.js";
import { TRUCK_TYPES } from "./economy.js";

const BG_SCALE = 1.5; // supersample the static layer a bit so zooming in isn't too soft
// Interstate blue and US-highway orange - the classic road-sign colors,
// instead of the earlier desaturated grey-blue/tan. Kept distinct from
// both the route-preview amber (rgba(232,163,61,...)) and the Flatbed
// truck-type orange (#d97706) so none of the three read as the same color.
const ROAD_COLOR = { interstate: "rgba(45, 110, 210, 0.75)", highway: "rgba(214, 122, 40, 0.55)" };
const ROAD_WIDTH = { interstate: 3.2, highway: 1.8 };
const STATE_BORDER_COLOR = "rgba(255, 255, 255, 0.85)"; // bright white, high opacity so it reads clearly against the dark basemap
const STATE_BORDER_WIDTH = 1.6; // another step up from last round's 1.2
const CITY_DOT_COLOR = ["#4b5568", "#5b6b84", "#647089", "#6d7a93"]; // by tier 1..4 (dimmer for smaller tiers)
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
const MEDIAN_COLOR = "rgba(235, 225, 200, 0.45)";
const MEDIAN_WIDTH = 0.5;

// Viewport-cull padding for the per-truck draw loop, in world units - only
// covers the dot's own footprint (radius + selection ring + stroke), tied
// to TRUCK_DOT_RADIUS so it can't silently drift out of sync if that ever
// changes. This is a performance guard, not a visibility feature: a truck
// just outside the true visible area still simulates identically, it just
// isn't drawn - false positives (drawing a couple extra off-screen trucks)
// are fine, false negatives (clipping a truck that should be visible) are not.
const CULL_PAD_WORLD_UNITS = TRUCK_DOT_RADIUS + 8;

// One draw bucket per cargo/truck-type color (7 distinct colors today, see
// economy.js's TRUCK_TYPES) - built once at module scope, cleared and
// refilled every frame instead of allocated fresh, so the per-truck draw
// loop can batch every truck of the same color into a single
// beginPath()/fill() pass instead of one pair per truck.
const truckBuckets = new Map(Object.values(TRUCK_TYPES).map((tt) => [tt.id, { color: tt.color, xs: [], ys: [] }]));

// Multiples of camera.baseZoom at which each additional tier of city
// labels comes into view. Tier 1 is visible from the spawn/fit zoom
// onward; each further tier needs progressively more zoom-in, revealed
// cumulatively (zooming to see tier 3 still shows tiers 1-2).
const LABEL_TIER_ZOOM_MULT = { 1: 1.0, 2: 1.7, 3: 3.2, 4: 5.5 };
// tier1 = old 25px shrunk 20%; each tier below is 25% smaller than the
// tier directly above it (20*0.75=15, 15*0.75=11.25->11, 11*0.75=8.25->8) -
// a steeper cascade than the old {25,24,23,22}.
const LABEL_FONT_PX = { 1: 20, 2: 15, 3: 11, 4: 8 };
const LABEL_COLOR = { 1: "#ffffff", 2: "#d8dde4", 3: "#a9b2bf", 4: "#8994a3" }; // tier1 fully white; 2-4 stay the existing off-white-to-grey cascade
const OFF_ROUTE_LABEL_SCALE = 0.7; // additional shrink for labels not on the followed truck's route ahead
const ROUTE_HIGHLIGHT_COLOR = "rgba(232, 163, 61, 0.85)"; // same amber as the dashed route-preview line/waypoint dots

export function renderStaticBackground(graph, opts = {}) {
  const showMedians = opts.showMedians !== false; // default on
  const showStateBorders = opts.showStateBorders !== false; // default on
  const bg = document.createElement("canvas");
  bg.width = WORLD_WIDTH * BG_SCALE;
  bg.height = WORLD_HEIGHT * BG_SCALE;
  const ctx = bg.getContext("2d");
  ctx.scale(BG_SCALE, BG_SCALE);

  ctx.fillStyle = "#12161c";
  ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

  ctx.lineCap = "round";

  // State borders first, beneath everything else - a basemap layer, not
  // a road. Pre-projected/pre-simplified at build time (see
  // scripts/build-states-data.mjs), so this is just a stroke pass, same
  // one-time-cost pattern as the road network below: every ring shares
  // one beginPath()/stroke() call. Stroke-only (never filled), so
  // MultiPolygon inner/hole rings need no special handling - every ring
  // draws identically regardless of outer/inner role.
  if (showStateBorders) {
    ctx.strokeStyle = STATE_BORDER_COLOR;
    ctx.lineWidth = STATE_BORDER_WIDTH;
    ctx.beginPath();
    for (const ring of STATE_BORDER_RINGS) {
      ctx.moveTo(ring[0], ring[1]);
      for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i], ring[i + 1]);
      ctx.closePath();
    }
    ctx.stroke();
  }

  // highways first (dimmer, thinner), interstates on top (brighter, thicker)
  for (const kind of ["highway", "interstate"]) {
    ctx.strokeStyle = ROAD_COLOR[kind];
    ctx.lineWidth = ROAD_WIDTH[kind];
    ctx.beginPath();
    for (const name in graph.nodes) {
      const node = graph.nodes[name];
      for (const e of graph.adjacency[name]) {
        if (e.kind !== kind) continue;
        if (name > e.to) continue; // each undirected edge drawn once
        const other = graph.nodes[e.to];
        ctx.moveTo(node.x, node.y);
        ctx.lineTo(other.x, other.y);
      }
    }
    ctx.stroke();
  }

  // Thin median down the centerline of divided highways only
  // (interstates) - the two lanes per direction either side of it are a
  // purely positional truck offset (see truckWorldPos), no drawn lane
  // divider needed between them. Settings-gated purely cosmetically -
  // the lane offsets themselves are unaffected either way.
  if (showMedians) {
    ctx.strokeStyle = MEDIAN_COLOR;
    ctx.lineWidth = MEDIAN_WIDTH;
    ctx.beginPath();
    for (const name in graph.nodes) {
      const node = graph.nodes[name];
      for (const e of graph.adjacency[name]) {
        if (e.kind !== "interstate") continue;
        if (name > e.to) continue;
        const other = graph.nodes[e.to];
        ctx.moveTo(node.x, node.y);
        ctx.lineTo(other.x, other.y);
      }
    }
    ctx.stroke();
  }

  for (const name in graph.nodes) {
    const node = graph.nodes[name];
    if (node.t === 0) continue; // junction filler nodes aren't real places
    const radius = Math.max(2, Math.min(9, 2 + node.w * 0.7));
    ctx.fillStyle = CITY_DOT_COLOR[Math.min(3, node.t - 1)];
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  return bg;
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
function drawCityLabels(ctx, graph, zoom, baseZoom, showAllLabels, counterRotation, onRouteCities) {
  ctx.textAlign = "center";
  for (const name in graph.nodes) {
    const node = graph.nodes[name];
    if (node.t === 0) continue;
    if (!showAllLabels) {
      const mult = LABEL_TIER_ZOOM_MULT[node.t] ?? Infinity;
      if (zoom < baseZoom * mult) continue;
    }
    const radius = Math.max(2, Math.min(9, 2 + node.w * 0.7));
    let fontPx = LABEL_FONT_PX[node.t];
    if (onRouteCities && !onRouteCities.has(name)) fontPx *= OFF_ROUTE_LABEL_SCALE;
    ctx.font = `600 ${fontPx}px "Oswald", sans-serif`;
    ctx.fillStyle = LABEL_COLOR[node.t];
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
      ctx.restore();
    } else {
      ctx.fillText(node.name, node.x, node.y - radius - 5);
    }
  }
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
  if (!truck.edge || truck.edge.kind !== "interstate") return truckCenterlinePos(graph, truck, out);

  const edge = truck.edge;
  truckCenterlinePos(graph, truck, out); // writes the centerline position into `out`

  // Perpendicular offset to the right of travel, derived from the
  // edge's stored compass bearing: rightX=cos(theta), rightY=sin(theta)
  // (theta=0/north -> right=east; theta=90/east -> right=south - matches
  // real-world driving-on-the-right). The reverse-direction edge stores
  // bearing+180, so its right-vector is the negation of this one -
  // opposing traffic lands on the opposite side of the median for free.
  const rad = (edge.bearing * Math.PI) / 180;
  const rightX = Math.cos(rad), rightY = Math.sin(rad);
  const off = RIGHT_LANE_OFFSET + (LEFT_LANE_OFFSET - RIGHT_LANE_OFFSET) * truck.laneT;
  out.x += rightX * off;
  out.y += rightY * off;
  return out;
}

export function drawFrame(ctx, canvas, camera, graph, bgCanvas, trucks, selectedTruck, renderOpts = {}) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.fillStyle = "#12161c";
  ctx.fillRect(0, 0, w, h);

  const center = camera.visualCenter();
  const nav = camera.mode === "FOLLOW_NAV";

  // Viewport-cull bounds for the per-truck draw loop below - computed once
  // per frame, in world space, from the same camera state the transform
  // block just below derives its own matrix from. Simulation (fleet.js)
  // never sees this: every truck keeps updating regardless, only drawing
  // is skipped for ones clearly outside it.
  let cullMinX, cullMaxX, cullMinY, cullMaxY, cullCx, cullCy, cullRadiusSq;
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
    const cullRadius = maxCornerDist / (camera.zoom * TILT_FACTOR) + CULL_PAD_WORLD_UNITS;
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
  drawCityLabels(ctx, graph, camera.zoom, camera.baseZoom || camera.zoom, !!renderOpts.showAllLabels, nav ? camera.heading : 0, onRouteCities);

  if (nodeSeq) {
    ctx.strokeStyle = "rgba(232, 163, 61, 0.85)";
    ctx.lineWidth = 2.5 / camera.zoom;
    ctx.setLineDash([10 / camera.zoom, 8 / camera.zoom]);
    ctx.beginPath();
    const p0 = truckCenterlinePos(graph, selectedTruck);
    ctx.moveTo(p0.x, p0.y);
    for (const name of nodeSeq) {
      const n = graph.nodes[name];
      ctx.lineTo(n.x, n.y);
    }
    ctx.stroke();
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
    // renderStaticBackground's city dots, so the ring hugs it rather than
    // using an arbitrary fixed size). Junction filler nodes (t===0) have
    // no dot in the static background to ring, so they're skipped.
    ctx.strokeStyle = ROUTE_HIGHLIGHT_COLOR;
    ctx.lineWidth = 2 / camera.zoom;
    for (const name of nodeSeq) {
      const n = graph.nodes[name];
      if (n.t === 0) continue;
      const dotRadius = Math.max(2, Math.min(9, 2 + n.w * 0.7));
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

  const scratchPos = { x: 0, y: 0 }; // reused across the whole loop - no per-truck allocation
  for (const truck of trucks) {
    if (drawArrowForSelected && truck === selectedTruck) continue;
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
  }

  for (const b of truckBuckets.values()) {
    if (b.xs.length === 0) continue;
    ctx.fillStyle = b.color;
    ctx.beginPath();
    for (let i = 0; i < b.xs.length; i++) {
      const x = b.xs[i], y = b.ys[i];
      ctx.moveTo(x + TRUCK_DOT_RADIUS, y); // starts this dot's subpath without a connecting line from the previous one
      ctx.arc(x, y, TRUCK_DOT_RADIUS, 0, Math.PI * 2);
    }
    ctx.fill();
  }

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
