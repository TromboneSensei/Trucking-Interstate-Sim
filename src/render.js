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

const BG_SCALE = 1.5; // supersample the static layer a bit so zooming in isn't too soft
const ROAD_COLOR = { interstate: "rgba(120, 150, 190, 0.55)", highway: "rgba(160, 130, 90, 0.4)" };
const ROAD_WIDTH = { interstate: 3.2, highway: 1.8 };
const STATE_BORDER_COLOR = "rgba(110, 125, 145, 0.35)"; // subtle cool gray, thinner/dimmer than roads - reads as a basemap layer, not competing with them
const STATE_BORDER_WIDTH = 1.0;
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

// Multiples of camera.baseZoom at which each additional tier of city
// labels comes into view. Tier 1 is visible from the spawn/fit zoom
// onward; each further tier needs progressively more zoom-in, revealed
// cumulatively (zooming to see tier 3 still shows tiers 1-2).
const LABEL_TIER_ZOOM_MULT = { 1: 1.0, 2: 1.7, 3: 3.2, 4: 5.5 };
const LABEL_FONT_PX = { 1: 25, 2: 24, 3: 23, 4: 22 }; // tier1 = old 15px * 1.69, tiers 2-4 step down just barely (was a steeper {15,13,11.5,10.5} cascade)
const LABEL_COLOR = { 1: "#ffffff", 2: "#d8dde4", 3: "#a9b2bf", 4: "#8994a3" }; // tier1 fully white; 2-4 stay the existing off-white-to-grey cascade

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
function drawCityLabels(ctx, graph, zoom, baseZoom, showAllLabels, counterRotation) {
  ctx.textAlign = "center";
  for (const name in graph.nodes) {
    const node = graph.nodes[name];
    if (node.t === 0) continue;
    if (!showAllLabels) {
      const mult = LABEL_TIER_ZOOM_MULT[node.t] ?? Infinity;
      if (zoom < baseZoom * mult) continue;
    }
    const radius = Math.max(2, Math.min(9, 2 + node.w * 0.7));
    ctx.font = `600 ${LABEL_FONT_PX[node.t]}px "Oswald", sans-serif`;
    ctx.fillStyle = LABEL_COLOR[node.t];
    if (counterRotation) {
      ctx.save();
      ctx.translate(node.x, node.y - radius - 5);
      ctx.rotate(counterRotation);
      ctx.fillText(node.name, 0, 0);
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
export function truckCenterlinePos(graph, truck) {
  if (!truck.edge) {
    const n = graph.nodes[truck.currentNode];
    return { x: n.x, y: n.y };
  }
  const edge = truck.edge;
  const a = graph.nodes[edge.from], b = graph.nodes[edge.to];
  const t = Math.max(0, Math.min(1, truck.s / edge.miles));
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function truckWorldPos(graph, truck) {
  if (!truck.edge || truck.edge.kind !== "interstate") return truckCenterlinePos(graph, truck);

  const edge = truck.edge;
  const { x: baseX, y: baseY } = truckCenterlinePos(graph, truck);

  // Perpendicular offset to the right of travel, derived from the
  // edge's stored compass bearing: rightX=cos(theta), rightY=sin(theta)
  // (theta=0/north -> right=east; theta=90/east -> right=south - matches
  // real-world driving-on-the-right). The reverse-direction edge stores
  // bearing+180, so its right-vector is the negation of this one -
  // opposing traffic lands on the opposite side of the median for free.
  const rad = (edge.bearing * Math.PI) / 180;
  const rightX = Math.cos(rad), rightY = Math.sin(rad);
  const off = RIGHT_LANE_OFFSET + (LEFT_LANE_OFFSET - RIGHT_LANE_OFFSET) * truck.laneT;
  return { x: baseX + rightX * off, y: baseY + rightY * off };
}

export function drawFrame(ctx, canvas, camera, graph, bgCanvas, trucks, selectedTruck, renderOpts = {}) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.fillStyle = "#12161c";
  ctx.fillRect(0, 0, w, h);

  const center = camera.visualCenter();
  const nav = camera.mode === "FOLLOW_NAV";
  ctx.save();
  ctx.translate(center.x, center.y);
  if (nav) ctx.rotate(-camera.heading);
  ctx.scale(camera.zoom, nav ? camera.zoom * TILT_FACTOR : camera.zoom);
  ctx.translate(-camera.x, -camera.y);

  ctx.drawImage(bgCanvas, 0, 0, bgCanvas.width, bgCanvas.height, 0, 0, WORLD_WIDTH, WORLD_HEIGHT);
  drawCityLabels(ctx, graph, camera.zoom, camera.baseZoom || camera.zoom, !!renderOpts.showAllLabels, nav ? camera.heading : 0);

  // The dashed remaining-route line walks the real A* edge list - but
  // `remainingPath` only holds the hops AFTER the truck's current edge
  // (the current edge's own endpoint already got shifted out of it into
  // truck.edge by _advanceToNextEdge). Forgetting to include that
  // endpoint here made the first drawn segment jump straight from the
  // truck's position to the node two hops ahead, skipping the immediate
  // next node and reading as a straight shot across land. nodeSeq below
  // is the full remaining stop sequence, current edge included.
  if (selectedTruck && selectedTruck.edge) {
    const nodeSeq = [selectedTruck.edge.to, ...selectedTruck.remainingPath.map((e) => e.to)];
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
  }

  for (const truck of trucks) {
    const p = truckWorldPos(graph, truck);
    ctx.fillStyle = truck.contract.truckType.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, TRUCK_DOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    if (truck === selectedTruck) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.5 / camera.zoom;
      ctx.beginPath();
      ctx.arc(p.x, p.y, TRUCK_DOT_RADIUS + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.restore();
}
