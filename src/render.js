// render.js - static background (roads + cities, drawn once to an
// offscreen canvas) plus a thin per-frame dynamic layer (truck dots,
// selection ring, followed-truck route highlight). Roads/cities never
// move, so re-rendering them every frame would be wasted work at any
// fleet size; only the moving parts are drawn dynamically.
import { WORLD_WIDTH, WORLD_HEIGHT } from "./geo.js";

const BG_SCALE = 1.5; // supersample the static layer a bit so zooming in isn't too soft
const ROAD_COLOR = { interstate: "rgba(120, 150, 190, 0.55)", highway: "rgba(160, 130, 90, 0.4)" };
const ROAD_WIDTH = { interstate: 3.2, highway: 1.8 };
const CITY_DOT_COLOR = ["#4b5568", "#5b6b84", "#647089", "#6d7a93"]; // by tier 1..4 (dimmer for smaller tiers)
const TRUCK_DOT_RADIUS = 9;

export function renderStaticBackground(graph) {
  const bg = document.createElement("canvas");
  bg.width = WORLD_WIDTH * BG_SCALE;
  bg.height = WORLD_HEIGHT * BG_SCALE;
  const ctx = bg.getContext("2d");
  ctx.scale(BG_SCALE, BG_SCALE);

  ctx.fillStyle = "#141a24";
  ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

  ctx.lineCap = "round";
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

  for (const name in graph.nodes) {
    const node = graph.nodes[name];
    if (node.t === 0) continue; // junction filler nodes aren't real places
    const radius = Math.max(2, Math.min(9, 2 + node.w * 0.7));
    ctx.fillStyle = CITY_DOT_COLOR[Math.min(3, node.t - 1)];
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fill();

    if (node.t <= 2) {
      ctx.fillStyle = "#c7d0dc";
      ctx.font = "700 13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(node.name, node.x, node.y - radius - 5);
    }
  }

  return bg;
}

export function truckWorldPos(graph, truck) {
  const edge = truck.edge;
  const a = graph.nodes[edge.from], b = graph.nodes[edge.to];
  const t = Math.max(0, Math.min(1, truck.s / edge.miles));
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function drawFrame(ctx, canvas, camera, graph, bgCanvas, trucks, selectedTruck) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.fillStyle = "#141a24";
  ctx.fillRect(0, 0, w, h);

  const center = camera.visualCenter();
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);

  ctx.drawImage(bgCanvas, 0, 0, bgCanvas.width, bgCanvas.height, 0, 0, WORLD_WIDTH, WORLD_HEIGHT);

  if (selectedTruck && selectedTruck.remainingPath && selectedTruck.remainingPath.length) {
    ctx.strokeStyle = "rgba(255, 176, 32, 0.7)";
    ctx.lineWidth = 2.5 / camera.zoom;
    ctx.setLineDash([10 / camera.zoom, 8 / camera.zoom]);
    ctx.beginPath();
    const p0 = truckWorldPos(graph, selectedTruck);
    ctx.moveTo(p0.x, p0.y);
    for (const e of selectedTruck.remainingPath) {
      const n = graph.nodes[e.to];
      ctx.lineTo(n.x, n.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
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
