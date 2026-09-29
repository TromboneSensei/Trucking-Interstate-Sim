// director.js - the idle-cam "director": after enough real time with no
// input, an automated camera takes over, fades the app chrome out, and
// cuts between interesting shots of the live sim with a caption for each.
// A cross-country hop flies out to a whole-country view first (Google-
// Earth-style), holds on a pulsing destination pin, then flies back in.
//
// Phase 3 shipped the full state machine (idle detection, camera takeover,
// travel/APEX/wake) wired to exactly one shot type - Interchange. Phase 4
// adds the four shots that actually need a truck to follow: Bottleneck
// (static, centered on a jam), Convoy (anticipatory-follow of a draft
// chain's lead truck, pulling back to reveal the whole line), Weather
// (anticipatory-follow into a storm cell, pulling back to reveal it), and
// Lone Hauler (anticipatory-follow, no pull-back - a night shot of open
// road).
"use strict";

import { WORLD_WIDTH, WORLD_HEIGHT, travelDirectionLabel, rawDarknessAtX, effectiveDarkness } from "./geo.js";
import { flightPath, flightDurationMs, flightEase } from "./flight.js";
import { truckPose, CONGESTION_BANDS } from "./render.js";

// --- tunables (Appendix C) --------------------------------------------
const DIR_LONG_HOP_WORLD = 900; // world-unit hop distance above which a move routes via the country view
const DIR_APEX_HOLD_MS = 900; // pause at the country view, pin + caption visible
const DIR_LOOKAHEAD_FRAC = 0.2; // fraction of viewport width the camera leads a followed truck
const DIR_PULLBACK_S = 14; // pull-back window at the end of Convoy/Weather shots
const DIR_CANDIDATE_COOLDOWN_MS = 10 * 60 * 1000; // don't reuse a truck/segment/node for 10 real minutes
const DIR_CAPTION_IN_DELAY_MS = 800; // after landing on a short hop; long hops show the caption at APEX instead
const DIR_CAPTION_OUT_LEAD_MS = 1200; // caption fades this long before the shot itself ends
const DIR_ENTER_MS = 350; // UI-fade grace period before the first flight begins
const DIR_RETURN_CHIP_MS = 6000;
const DIR_MARKER_PULSE_HZ = 1.1;
const DIR_VEIL_IN_MS = 180;
const DIR_VEIL_OUT_MS = 220;

const DIR_SHOT_WEIGHTS = { bottleneck: 30, convoy: 25, weather: 25, lone: 20, interchange: 10 };

// Bottleneck: fit multiplier + zoom clamp on the slow trucks' bbox.
const DIR_BOTTLENECK_FIT_MULT = 1.5;
const DIR_BOTTLENECK_ZOOM_MIN = 1.4;
const DIR_BOTTLENECK_ZOOM_MAX = 3.0;
// Convoy: fit multiplier + zoom clamp on the draft chain's bbox, and how
// far (as a fraction of the initial zoom) the pull-back eases out to.
const DIR_CONVOY_FIT_MULT = 1.6;
const DIR_CONVOY_ZOOM_MIN = 1.8;
const DIR_CONVOY_ZOOM_MAX = 3.4;
const DIR_CONVOY_PULLBACK_MULT = 0.55;
const DIR_CONVOY_MAX_CHAIN_STEPS = 12;
// Weather: starting zoom, and the cell-fraction/truck-count candidate gate.
const DIR_WEATHER_ZOOM_START = 1.6;
const DIR_WEATHER_CELL_FRAC = 0.8;
const DIR_WEATHER_MIN_TRUCKS = 3;
// Lone Hauler: candidate gates (Appendix B) and its fixed follow zoom.
const DIR_LONE_MIN_SPEED_MPH = 45;
const DIR_LONE_DARKNESS_MIN = 0.3;
const DIR_LONE_MIN_SEG_LEN = 60;
const DIR_LONE_MIN_CITY_DIST = 80;
const DIR_LONE_ZOOM = 3.0;

function dirClamp01(x) { return Math.max(0, Math.min(1, x)); }
function dirClamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function dirEaseInOutSine(u) { return -(Math.cos(Math.PI * dirClamp01(u)) - 1) / 2; }

// The nearest node.t > 0 (real, named) city to a world point - an O(nodes)
// scan, run once per shot pick, never per frame. Used by every shot's
// caption ("near {city}"), not just Interchange's own fallback name.
function dirNearestRealCity(graph, x, y) {
  let best = null, bestD2 = Infinity;
  for (const name in graph.nodes) {
    const n = graph.nodes[name];
    if (n.t === 0) continue;
    const d2 = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = n; }
  }
  return best;
}

// Same shield-ish route-name shortening cb.js's own module-private
// cbRouteLabel applies - that function isn't exported, so this is a
// uniquely-named copy rather than a shared import.
function dirRouteLabel(route) {
  return route ? route.replace("US-", "US ").replace(" (West)", "").replace(" (East)", "") : "the slab";
}

// The "{route} {dir} near {city}" tail shared by Bottleneck/Convoy/
// Weather/Lone Hauler's captions.
function dirRouteNear(graph, edge, x, y) {
  const near = dirNearestRealCity(graph, x, y);
  return `${dirRouteLabel(edge.route)} ${travelDirectionLabel(edge)} near ${near ? near.name : "nowhere in particular"}`;
}

export function createDirector(deps) {
  const { camera, canvas, graph } = deps;

  // --- state -------------------------------------------------------------
  let phase = "IDLE"; // IDLE | ENTERING | TRAVEL | SHOT | EXITING
  let idleAccumMs = 0;
  let idleMsOverride = null; // debug.setIdleMs

  let snapshot = null; // camera/follow state to restore on wake - set at ENTERING, read at EXITING/returnToSnapshot
  let enterStartMs = 0;
  // FOLLOW_NAV's rotated, tilted view can't be interpolated toward a flat
  // DIRECTOR view by flightPath (that math assumes both ends are the same
  // flat top-down projection) - entering from it cuts through black instead
  // of flying, per ENTERING's own spec. veilCutSnapDone marks the instant
  // between the fade-in finishing and the fade-out starting, when the
  // camera actually jumps.
  let veilCutActive = false;
  let veilCutSnapDone = false;

  // Travel: a queue of segments walked in order. A short hop is one
  // {kind:"flight"} segment; a long hop is
  // [{flight: cur->country}, {apex}, {flight: country->shot}].
  let travelQueue = [];
  let travelIndex = 0;
  let travelSegStartMs = 0;

  let shot = null; // { type, subject, startMs, durationMs, caption:{eyebrow,line}, view:{x,y,w} }
  let lastShotType = null;
  // Recently-used candidates, so the same junction doesn't repeat for a
  // while - keyed by a caller-chosen string ("node:Springfield", later
  // "truck:1234"), value the ms timestamp it was last picked.
  const recentlyUsed = new Map();

  let returnChipTimer = null;
  let lastPickMs = 0;
  // The Camera instance is shared with the rest of the app (camera.js,
  // render.js, main.js all read/write it) - stashing director-only state on
  // it as a foreign property would be a small ongoing liability for anyone
  // reading that file later. Kept here instead, alongside everything else
  // director.js owns.
  let savedVisualCenterYRatio = null;

  // Reused scratch buffer for the many synchronous truckPose() calls a
  // candidate scan makes - read immediately after each call, before the
  // next overwrites it, so one shared object is safe (see the plan's own
  // "keep all state inside the closure" rule - this never crosses a frame
  // boundary, so it isn't a hazard the way a per-truck cache would be).
  const scratchPose = { x: 0, y: 0, heading: 0 };

  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // --- idle-detection input listeners ------------------------------------
  // Attached once, always live (not just while active): the IDLE phase's
  // "any input resets it to 0" needs to hear input long before the shield
  // (which only exists while director already owns the screen) is even in
  // play. Harmless to also fire while director IS active - idleAccumMs is
  // meaningless outside the IDLE phase, and the shield's own handlers are
  // what actually calls stop() for a wake; this only ever resets a counter.
  function noteInput() { idleAccumMs = 0; }
  window.addEventListener("pointerdown", noteInput, { capture: true, passive: true });
  window.addEventListener("wheel", noteInput, { capture: true, passive: true });
  window.addEventListener("touchstart", noteInput, { capture: true, passive: true });
  window.addEventListener("keydown", noteInput, { capture: true });

  function isCandidateCooling(key, nowMs) {
    const at = recentlyUsed.get(key);
    return at != null && nowMs - at < DIR_CANDIDATE_COOLDOWN_MS;
  }
  function markCandidateUsed(key, nowMs) { recentlyUsed.set(key, nowMs); }

  // --- director tally --------------------------------------------------
  // Live truck count + average slowdown per physical road segment, PER
  // DIRECTION - Appendix B's "Director tally". Run once per pick (never
  // per frame), shared by Bottleneck (which segments are jammed) and Lone
  // Hauler (a segment carrying exactly one truck, in either direction).
  // Deliberately NOT render.js's tallyCongestion: that one advances a
  // real-time smoothing EMA meant for the congestion overlay, and only
  // runs when that overlay is on - calling it here would both distort the
  // heat map with extra calls and leave this tally silently stale whenever
  // congestion display is off. Same exclusions as tallyCongestion, plus
  // parkedAt (Appendix B lists it explicitly for this tally).
  let dirCountsFwd = null, dirCountsBack = null, dirSumFwd = null, dirSumBack = null;
  function runDirectorTally(trucks) {
    const n = deps.edgeList.edges.length;
    if (!dirCountsFwd || dirCountsFwd.length !== n) {
      dirCountsFwd = new Int32Array(n); dirCountsBack = new Int32Array(n);
      dirSumFwd = new Float32Array(n); dirSumBack = new Float32Array(n);
    } else {
      dirCountsFwd.fill(0); dirCountsBack.fill(0); dirSumFwd.fill(0); dirSumBack.fill(0);
    }
    const { indexByEdge, directionByEdge } = deps.edgeList;
    for (const truck of trucks) {
      if (!truck.edge || truck.parkedAt || truck.disabledHoursLeft > 0 || truck.arrivalBraking) continue;
      const idx = indexByEdge.get(truck.edge);
      if (idx === undefined) continue;
      const slowdown = truck.freeFlowSpeed > 0 ? Math.max(0, 1 - truck.speed / truck.freeFlowSpeed) : 0;
      if (directionByEdge.get(truck.edge) === 0) { dirCountsFwd[idx]++; dirSumFwd[idx] += slowdown; }
      else { dirCountsBack[idx]++; dirSumBack[idx] += slowdown; }
    }
  }

  function findTruckById(id) {
    const trucks = deps.getTrucks();
    for (let i = 0; i < trucks.length; i++) if (trucks[i].id === id) return trucks[i];
    return null;
  }

  // A cheap linear (no corner-blend, no jitter) truck position, for
  // candidate SCANS that touch every truck in the fleet (Weather's storm-
  // cell membership check) - truckPose's junction-blending/shoulder
  // handling is real render-quality work that a "which storm cell is this
  // truck roughly in" check at a 190-530 world-unit cell radius doesn't
  // need, and calling the full pose 10,000 times every pick was a real
  // chunk of the perf budget (Appendix B, Phase 4: <8ms at 10k trucks).
  // The chosen subject still gets a real truckPose in view()/caption()/
  // apply(), which run once per shot rather than once per truck per pick.
  function cheapTruckXY(truck, out) {
    const edge = truck.edge;
    const a = graph.nodes[edge.from], b = graph.nodes[edge.to];
    const t = edge.miles > 0 ? Math.max(0, Math.min(1, truck.s / edge.miles)) : 0;
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    return out;
  }

  // World position of a truck-subject shot's truck right now, or null if
  // the truck is gone / not on an edge. Trucks move tens of miles per real
  // second at 1x, so anything sampled at pick time is stale by the time the
  // 1-3s TRAVEL flight lands - see updateTravel/beginShotPhase.
  function liveSubjectPos(subject) {
    if (!subject || subject.kind !== "truck") return null;
    const t = findTruckById(subject.id);
    if (!t || !t.edge) return null;
    truckPose(graph, t, scratchPose, false);
    return { x: scratchPose.x, y: scratchPose.y };
  }

  // Shared per-frame camera motion for every "anticipatory follow" shot
  // (Convoy/Weather/Lone Hauler) - Appendix B's own formula. `leadWorld` is
  // signed: positive leads AHEAD of the truck's heading (Weather/Lone),
  // negative trails BEHIND it (Convoy, so the whole draft line stays framed).
  function stepAnticipatoryFollow(pose, followState, leadWorld) {
    const h = (pose.heading * Math.PI) / 180;
    const fwdX = Math.sin(h), fwdY = -Math.cos(h);
    const targetX = fwdX * leadWorld, targetY = fwdY * leadWorld;
    followState.offX += (targetX - followState.offX) * 0.03;
    followState.offY += (targetY - followState.offY) * 0.03;
    camera.x += (pose.x + followState.offX - camera.x) * 0.08;
    camera.y += (pose.y + followState.offY - camera.y) * 0.08;
  }

  // Log-space pull-back shared by Convoy/Weather: holds at z0 until the
  // last DIR_PULLBACK_S of the shot, then eases to z1 - interpolating the
  // zoom in log space (rather than linearly) is what keeps the zoom SPEED
  // feeling constant regardless of how far apart z0/z1 are.
  function pullbackZoomAt(nowMs, z0, z1) {
    const windowMs = DIR_PULLBACK_S * 1000;
    const winStart = shot.endMs - windowMs;
    if (nowMs <= winStart) return z0;
    const u = dirEaseInOutSine((nowMs - winStart) / windowMs);
    return z0 * Math.pow(z1 / z0, u);
  }

  // Fits a world-space bbox on screen: centered on the bbox, padded by
  // `padMult`, matched to the canvas aspect so neither dimension clips,
  // then clamped to a zoom range so a single truck (Bottleneck's slow-
  // truck bbox can degenerate to a point) never zooms in absurdly far.
  function fitBBoxView(minX, maxX, minY, maxY, padMult, zMin, zMax) {
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const aspect = canvas.clientWidth / canvas.clientHeight;
    const w0 = Math.max(maxX - minX, 1) * padMult;
    const h0 = Math.max(maxY - minY, 1) * padMult;
    let w = Math.max(w0, h0 * aspect);
    w = dirClamp(w, canvas.clientWidth / zMax, canvas.clientWidth / zMin);
    return { x: cx, y: cy, w };
  }

  // --- shot candidates -----------------------------------------------------

  // Nodes with 4+ connecting roads, scored by degree x (1 + touching
  // traffic/10) - a lightweight per-candidate scan (not the director
  // tally above, which Bottleneck/Lone Hauler need but this doesn't).
  // One pass over the whole fleet, tallying each truck against BOTH nodes
  // its current edge touches - the same total scoreInterchange's old
  // per-node "does this truck touch THIS node" scan produced, but computed
  // once for every node at once instead of once PER node: at a 400-node
  // graph and a 10,000-truck fleet, the old approach was 4 million+
  // comparisons every single pick, the dominant cost of the whole director
  // tick and well over the <8ms budget (Appendix B, Phase 4) on its own.
  // A plain object, not a Map: this runs once per pick over the whole
  // fleet (up to 20,000 increments at a 10,000-truck fleet), and a bare
  // string-keyed object measured faster here than a Map for that many
  // small integer increments.
  function buildNodeTrafficCounts(trucks) {
    const counts = Object.create(null);
    for (const truck of trucks) {
      if (!truck.edge || truck.parkedAt || truck.disabledHoursLeft > 0 || truck.arrivalBraking) continue;
      const f = truck.edge.from, t = truck.edge.to;
      counts[f] = (counts[f] || 0) + 1;
      counts[t] = (counts[t] || 0) + 1;
    }
    return counts;
  }

  function scoreInterchange(name, trafficCounts) {
    const adj = graph.adjacency[name] || [];
    if (adj.length < 4) return null;
    return adj.length * (1 + (trafficCounts[name] || 0) / 10);
  }

  // Interchange never marks its own cooldown here - see the uniform rule
  // below computeCandidates: only the type actually CHOSEN this cycle gets
  // its cooldownKey marked, in beginShotWith/snapToShotInstantly. Marking
  // it during the candidate SCAN (which runs for every type, every pick,
  // whether or not it wins the weighted roll) would cool down a node the
  // viewer never actually saw.
  function pickInterchangeCandidate(trucks, nowMs) {
    const trafficCounts = buildNodeTrafficCounts(trucks);
    const scored = [];
    for (const name in graph.nodes) {
      const score = scoreInterchange(name, trafficCounts);
      if (score != null) scored.push({ name, score });
    }
    if (!scored.length) return null; // only possible on a graph with no real junctions at all
    scored.sort((a, b) => b.score - a.score);
    const top10 = scored.slice(0, 10);
    let pool = top10.filter((c) => !isCandidateCooling("node:" + c.name, nowMs));
    // Interchange is documented as ALWAYS available (it's the fallback
    // every other shot type falls back to) - so cooldown is a soft
    // preference, never a hard reason to come up empty. If every one of
    // the top 10 is cooling, forget cooldown rather than fail the pick.
    if (!pool.length) pool = top10;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function interchangeCaption(node) {
    const deg = (graph.adjacency[node.name] || []).length;
    if (node.t > 0) return { eyebrow: "INTERCHANGE", line: `${node.name} · ${deg} routes meet` };
    const near = dirNearestRealCity(graph, node.x, node.y);
    return { eyebrow: "INTERCHANGE", line: `Junction near ${near ? near.name : "nowhere in particular"}` };
  }

  // Walks every currently-drafting truck's leader chain up to its root
  // (the lead truck, which may not itself be drafting), grouping drafters
  // by root. `driftLeader`/`isDrafting` are per-tick, fleet.js-owned state
  // (Phase 1) - this only ever reads them, never mutates.
  function findConvoyRoots(trucks) {
    const roots = new Map(); // root truck id -> { root, members: [drafter,...] }
    for (const t of trucks) {
      if (!t.isDrafting || !t.draftLeader || t.draftLeader.edge !== t.edge) continue;
      let cur = t;
      const seen = new Set([cur.id]);
      let steps = 0;
      while (steps < DIR_CONVOY_MAX_CHAIN_STEPS && cur.isDrafting && cur.draftLeader && cur.draftLeader.edge === cur.edge) {
        const next = cur.draftLeader;
        if (seen.has(next.id)) break; // cycle guard - shouldn't happen, but never loop forever on bad data
        seen.add(next.id);
        cur = next;
        steps++;
      }
      let entry = roots.get(cur.id);
      if (!entry) { entry = { root: cur, members: [] }; roots.set(cur.id, entry); }
      entry.members.push(t);
    }
    return roots;
  }

  // Registry of shot types this build knows how to pick + frame. `pick`
  // returns a subject or null (a null return means "no candidate this
  // cycle", not "this type doesn't exist" - see computeCandidates), `view`
  // gives TRAVEL its destination {x,y,w}, `caption` builds the two-line
  // text, `isValid` re-checks the subject is still real each SHOT frame,
  // and `apply` does per-frame framing work during SHOT (a no-op for a
  // static shot - the camera just sits).
  const SHOT_TYPES = {
    interchange: {
      weight: DIR_SHOT_WEIGHTS.interchange,
      durationMs: 14000,
      pick(trucksNow, nowMs) {
        const c = pickInterchangeCandidate(trucksNow, nowMs);
        if (!c) return null;
        return { kind: "node", name: c.name, cooldownKey: "node:" + c.name };
      },
      isValid() { return true; }, // a road junction never disappears
      view(subject) {
        const node = graph.nodes[subject.name];
        return { x: node.x, y: node.y, w: canvas.clientWidth / 2.2 };
      },
      caption(subject) { return interchangeCaption(graph.nodes[subject.name]); },
      apply() {}, // static framing - nothing to do per frame during SHOT
    },

    bottleneck: {
      weight: DIR_SHOT_WEIGHTS.bottleneck,
      durationMs: 16000,
      pick(trucksNow, nowMs) {
        const band = CONGESTION_BANDS[1];
        const { edges } = deps.edgeList;
        let bestIdx = -1, bestDir = 0, bestScore = -1;
        for (let idx = 0; idx < edges.length; idx++) {
          const cf = dirCountsFwd[idx];
          if (cf >= band.minTrucks) {
            const avg = dirSumFwd[idx] / cf;
            if (avg >= band.slowdown) { const score = cf * avg; if (score > bestScore) { bestScore = score; bestIdx = idx; bestDir = 0; } }
          }
          const cb = dirCountsBack[idx];
          if (cb >= band.minTrucks) {
            const avg = dirSumBack[idx] / cb;
            if (avg >= band.slowdown) { const score = cb * avg; if (score > bestScore) { bestScore = score; bestIdx = idx; bestDir = 1; } }
          }
        }
        if (bestIdx < 0) return null;
        const key = "segment:" + bestIdx + ":" + bestDir;
        if (isCandidateCooling(key, nowMs)) return null;
        // Second pass: the actual slow trucks on this (idx, dir), for the
        // centroid/bbox this shot centers on - the tally above only has
        // aggregate counts, not which trucks or where.
        const { indexByEdge, directionByEdge } = deps.edgeList;
        let sampleEdge = null, n = 0;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const truck of trucksNow) {
          if (!truck.edge || truck.parkedAt || truck.disabledHoursLeft > 0 || truck.arrivalBraking) continue;
          if (indexByEdge.get(truck.edge) !== bestIdx || directionByEdge.get(truck.edge) !== bestDir) continue;
          if (!sampleEdge) sampleEdge = truck.edge;
          truckPose(graph, truck, scratchPose, false);
          if (scratchPose.x < minX) minX = scratchPose.x; if (scratchPose.x > maxX) maxX = scratchPose.x;
          if (scratchPose.y < minY) minY = scratchPose.y; if (scratchPose.y > maxY) maxY = scratchPose.y;
          n++;
        }
        if (!sampleEdge) return null; // tally said trucks were there a moment ago; the live pass found none - shouldn't happen, but never hand a geometry-less subject onward
        return { kind: "segment", edge: sampleEdge, count: n, minX, maxX, minY, maxY, cooldownKey: key };
      },
      isValid() { return true; }, // static framing, same as Interchange
      view(subject) {
        return fitBBoxView(subject.minX, subject.maxX, subject.minY, subject.maxY, DIR_BOTTLENECK_FIT_MULT, DIR_BOTTLENECK_ZOOM_MIN, DIR_BOTTLENECK_ZOOM_MAX);
      },
      caption(subject) {
        const cx = (subject.minX + subject.maxX) / 2, cy = (subject.minY + subject.maxY) / 2;
        return { eyebrow: "GRIDLOCK", line: `${subject.count} trucks crawling · ${dirRouteNear(graph, subject.edge, cx, cy)}` };
      },
      apply() {}, // static - hold perfectly still
    },

    convoy: {
      weight: DIR_SHOT_WEIGHTS.convoy,
      durationMs: 20000,
      pick(trucksNow, nowMs) {
        const roots = findConvoyRoots(trucksNow);
        let best = null;
        for (const entry of roots.values()) if (!best || entry.members.length > best.members.length) best = entry;
        if (!best) return null;
        const key = "truck:" + best.root.id;
        if (isCandidateCooling(key, nowMs)) return null;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const t of [best.root, ...best.members]) {
          truckPose(graph, t, scratchPose, false);
          if (scratchPose.x < minX) minX = scratchPose.x; if (scratchPose.x > maxX) maxX = scratchPose.x;
          if (scratchPose.y < minY) minY = scratchPose.y; if (scratchPose.y > maxY) maxY = scratchPose.y;
        }
        const extent = Math.hypot(maxX - minX, maxY - minY);
        return { kind: "truck", id: best.root.id, edge: best.root.edge, count: best.members.length, minX, maxX, minY, maxY, extent, cooldownKey: key };
      },
      isValid(subject, trucksNow) {
        const t = trucksNow.find((tr) => tr.id === subject.id);
        return !!t && !t.parkedAt && !(t.disabledHoursLeft > 0);
      },
      view(subject) {
        return fitBBoxView(subject.minX, subject.maxX, subject.minY, subject.maxY, DIR_CONVOY_FIT_MULT, DIR_CONVOY_ZOOM_MIN, DIR_CONVOY_ZOOM_MAX);
      },
      caption(subject) {
        const live = liveSubjectPos(subject); // the lead truck's position now, not the pick-time bbox center
        const cx = live ? live.x : (subject.minX + subject.maxX) / 2, cy = live ? live.y : (subject.minY + subject.maxY) / 2;
        return { eyebrow: "CONVOY", line: `${subject.count}-truck draft line · ${dirRouteNear(graph, subject.edge, cx, cy)}` };
      },
      apply(subject, nowMs) {
        const t = findTruckById(subject.id);
        if (!t || !t.edge) return;
        truckPose(graph, t, scratchPose, false);
        if (!shot.followState) shot.followState = { offX: 0, offY: 0 };
        // Backward (negative) lead by half the chain's extent, so the
        // whole line stays in frame as the root truck pulls it forward.
        stepAnticipatoryFollow(scratchPose, shot.followState, -(subject.extent / 2));
        camera.zoom = pullbackZoomAt(nowMs, shot.z0, shot.z0 * DIR_CONVOY_PULLBACK_MULT);
      },
    },

    weather: {
      weight: DIR_SHOT_WEIGHTS.weather,
      durationMs: 20000,
      pick(trucksNow, nowMs) {
        if (!deps.getSettings().showWeather) return null;
        const cells = deps.getWeather();
        if (!cells || !cells.length) return null;
        const perCell = cells.map(() => []);
        for (const t of trucksNow) {
          if (!t.edge || t.parkedAt || t.disabledHoursLeft > 0 || t.speed <= 0) continue;
          cheapTruckXY(t, scratchPose);
          for (let ci = 0; ci < cells.length; ci++) {
            const cell = cells[ci];
            const r = cell.r * DIR_WEATHER_CELL_FRAC;
            const dx = scratchPose.x - cell.x, dy = scratchPose.y - cell.y;
            if (dx * dx + dy * dy <= r * r) perCell[ci].push({ t, x: scratchPose.x, y: scratchPose.y });
          }
        }
        let bestCi = -1, bestCount = -1;
        for (let ci = 0; ci < cells.length; ci++) if (perCell[ci].length > bestCount) { bestCount = perCell[ci].length; bestCi = ci; }
        if (bestCi < 0 || bestCount < DIR_WEATHER_MIN_TRUCKS) return null;
        const cell = cells[bestCi], list = perCell[bestCi];
        const interstateOnly = list.filter((e) => e.t.edge.kind === "interstate");
        const pool = interstateOnly.length ? interstateOnly : list;
        let best = null, bestD2 = Infinity;
        for (const e of pool) {
          const dx = e.x - cell.x, dy = e.y - cell.y, d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; best = e; }
        }
        const key = "truck:" + best.t.id;
        if (isCandidateCooling(key, nowMs)) return null;
        return { kind: "truck", id: best.t.id, edge: best.t.edge, cellKind: cell.kind, cellR: cell.r, count: bestCount, cooldownKey: key };
      },
      isValid(subject, trucksNow) {
        const t = trucksNow.find((tr) => tr.id === subject.id);
        return !!t && !t.parkedAt && !(t.disabledHoursLeft > 0);
      },
      view(subject) {
        const t = findTruckById(subject.id);
        truckPose(graph, t, scratchPose, false);
        return { x: scratchPose.x, y: scratchPose.y, w: canvas.clientWidth / DIR_WEATHER_ZOOM_START };
      },
      caption(subject) {
        const t = findTruckById(subject.id);
        truckPose(graph, t, scratchPose, false);
        const eyebrow = subject.cellKind === "snow" ? "SNOW" : "RAINSTORM";
        return { eyebrow, line: `${t.name} pushing through · ${dirRouteNear(graph, subject.edge, scratchPose.x, scratchPose.y)}` };
      },
      apply(subject, nowMs) {
        const t = findTruckById(subject.id);
        if (!t || !t.edge) return;
        truckPose(graph, t, scratchPose, false);
        if (!shot.followState) shot.followState = { offX: 0, offY: 0 };
        const lead = DIR_LOOKAHEAD_FRAC * (canvas.clientWidth / camera.zoom);
        stepAnticipatoryFollow(scratchPose, shot.followState, lead);
        const z1 = dirClamp(canvas.clientWidth / (subject.cellR * 2.4), 0.3, 1.2);
        camera.zoom = pullbackZoomAt(nowMs, shot.z0, z1);
      },
    },

    lone: {
      weight: DIR_SHOT_WEIGHTS.lone,
      durationMs: 18000,
      pick(trucksNow, nowMs) {
        const gameState = deps.getState();
        const { indexByEdge, edges } = deps.edgeList;
        const qualifiers = [];
        // Ordered cheapest-first: the segment-occupancy check (a Map
        // lookup + a typed-array read) rejects the overwhelming majority
        // of trucks - most interstate segments carry far more than one
        // truck - so it runs before the position/darkness/nearest-city
        // work below ever touches the trucks it would have rejected
        // anyway. dirNearestRealCity is an O(nodes) scan, so it's last,
        // reached only by the rare survivor of every cheaper filter.
        for (const t of trucksNow) {
          if (!t.edge || t.parkedAt || t.disabledHoursLeft > 0 || t.arrivalBraking) continue;
          if (t.speed < DIR_LONE_MIN_SPEED_MPH) continue;
          const idx = indexByEdge.get(t.edge);
          if (idx === undefined) continue;
          if (dirCountsFwd[idx] + dirCountsBack[idx] !== 1) continue;
          if (edges[idx].len < DIR_LONE_MIN_SEG_LEN) continue;
          cheapTruckXY(t, scratchPose);
          const raw = rawDarknessAtX(scratchPose.x, gameState.gameSeconds);
          if (effectiveDarkness(raw, gameState.timeScale) < DIR_LONE_DARKNESS_MIN) continue;
          const near = dirNearestRealCity(graph, scratchPose.x, scratchPose.y);
          const cityDist = near ? Math.hypot(near.x - scratchPose.x, near.y - scratchPose.y) : Infinity;
          if (cityDist < DIR_LONE_MIN_CITY_DIST) continue;
          const key = "truck:" + t.id;
          if (isCandidateCooling(key, nowMs)) continue;
          qualifiers.push(t);
        }
        if (!qualifiers.length) return null;
        const t = qualifiers[Math.floor(Math.random() * qualifiers.length)];
        return { kind: "truck", id: t.id, edge: t.edge, name: t.name, cargo: (t.contract && t.contract.cargo) || "freight", cooldownKey: "truck:" + t.id };
      },
      isValid(subject, trucksNow) {
        const t = trucksNow.find((tr) => tr.id === subject.id);
        return !!t && !t.parkedAt && !(t.disabledHoursLeft > 0);
      },
      view(subject) {
        const t = findTruckById(subject.id);
        truckPose(graph, t, scratchPose, false);
        return { x: scratchPose.x, y: scratchPose.y, w: canvas.clientWidth / DIR_LONE_ZOOM };
      },
      caption(subject) {
        const t = findTruckById(subject.id);
        truckPose(graph, t, scratchPose, false);
        return { eyebrow: "LONE HAULER", line: `${subject.name} · ${subject.cargo} · ${dirRouteNear(graph, subject.edge, scratchPose.x, scratchPose.y)}` };
      },
      apply(subject) {
        const t = findTruckById(subject.id);
        if (!t || !t.edge) return;
        truckPose(graph, t, scratchPose, false);
        if (!shot.followState) shot.followState = { offX: 0, offY: 0 };
        const lead = DIR_LOOKAHEAD_FRAC * (canvas.clientWidth / camera.zoom);
        stepAnticipatoryFollow(scratchPose, shot.followState, lead);
      }, // no pull-back (zen)
    },
  };

  // Runs the director tally once, then every registered type's own `pick`
  // exactly once - so a type with expensive candidate logic (Bottleneck,
  // Weather) is never scanned twice for one shot change, and so a
  // candidate a type finds is the SAME one used if that type wins the
  // weighted roll below (no second, possibly-different call to pick()).
  function computeCandidates(trucksNow, nowMs) {
    runDirectorTally(trucksNow);
    const out = [];
    for (const type in SHOT_TYPES) {
      const subject = SHOT_TYPES[type].pick(trucksNow, nowMs);
      if (subject) out.push({ type, subject });
    }
    return out;
  }

  // Weighted-random pick among already-computed candidates, excluding
  // `excludeType` (the just-shown type) unless it's the only one available.
  function pickTypeFromCandidates(candidates, excludeType) {
    const filtered = candidates.length > 1 ? candidates.filter((c) => c.type !== excludeType) : candidates;
    const pool = filtered.length ? filtered : candidates;
    let total = 0;
    for (const c of pool) total += SHOT_TYPES[c.type].weight;
    let r = Math.random() * total;
    for (const c of pool) {
      r -= SHOT_TYPES[c.type].weight;
      if (r <= 0) return c;
    }
    return pool[pool.length - 1];
  }

  // --- travel construction -------------------------------------------------

  function currentView() {
    return { x: camera.x, y: camera.y, w: canvas.clientWidth / camera.zoom };
  }

  function countryZoom() {
    return Math.min(canvas.clientWidth / WORLD_WIDTH, canvas.clientHeight / WORLD_HEIGHT) * 0.9;
  }

  // Builds the queue of TRAVEL segments from the current view to `dest`
  // ({x,y,w}). `forceLongHop` (debug.forceShot's own option) routes via the
  // country view regardless of actual distance, so a test can exercise the
  // APEX path on demand rather than needing a genuinely distant target.
  function buildTravelQueue(dest, forceLongHop, nowMs) {
    const cur = currentView();
    const dist = Math.hypot(dest.x - cur.x, dest.y - cur.y);
    const countryW = canvas.clientWidth / countryZoom();
    const alreadyCountryish = cur.w >= 0.9 * countryW;
    const isLong = forceLongHop || (dist > DIR_LONG_HOP_WORLD && !alreadyCountryish);

    if (!isLong) {
      const path = flightPath(cur, dest);
      return [{ kind: "flight", path, durationMs: reducedMotion ? 1 : flightDurationMs(path.S) }];
    }
    const countryView = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2, w: countryW };
    const legA = flightPath(cur, countryView);
    const legB = flightPath(countryView, dest);
    return [
      { kind: "flight", path: legA, durationMs: reducedMotion ? 1 : flightDurationMs(legA.S) },
      { kind: "apex", durationMs: reducedMotion ? 1 : DIR_APEX_HOLD_MS, pin: dest },
      { kind: "flight", path: legB, durationMs: reducedMotion ? 1 : flightDurationMs(legB.S), pin: dest, isLegB: true },
    ];
  }

  // --- caption / marker DOM (director.js owns its own small UI directly -
  // main.js just creates the element references it hands in via deps, same
  // spirit as career-ui.js owning its own DOM rather than main.js poking it) ---

  // All three (caption, hint, return chip) are meant to FADE, never cut -
  // toggling the app's global `.hidden` (display:none !important, used
  // everywhere else in this codebase) would make that impossible no matter
  // what opacity/transition CSS a more specific selector declared, since
  // !important always wins. These elements instead rest at opacity 0 by
  // default (no `.hidden` in their markup) and this `.show` class is the
  // only thing that ever touches their visibility.
  function setElVisible(el, visible) { if (el) el.classList.toggle("show", visible); }
  function setCaptionVisible(visible) { setElVisible(deps.captionEl, visible); }
  function setCaptionText(eyebrow, line) {
    if (deps.captionEyebrowEl) deps.captionEyebrowEl.textContent = eyebrow;
    if (deps.captionLineEl) deps.captionLineEl.textContent = line;
  }

  let captionShowAtMs = Infinity;
  let captionHideAtMs = Infinity;

  // --- lifecycle -----------------------------------------------------------

  // Starts TRAVEL toward an ALREADY-PICKED (type, subject) pair - never
  // calls a type's own pick() again, so the subject shown is exactly the
  // one computeCandidates found (a second pick() call could legitimately
  // return something different for a random-among-qualifiers type like
  // Lone Hauler, or a live-tally type whose inputs shifted a frame later).
  function beginShotWith(type, subject, nowMs) {
    const def = SHOT_TYPES[type];
    lastShotType = type;
    if (subject.cooldownKey) markCandidateUsed(subject.cooldownKey, nowMs);
    const view = def.view(subject);
    const caption = def.caption(subject);
    const durationMs = def.durationMs;
    const forceLong = deps.__debugForceLongHop || false;
    deps.__debugForceLongHop = false;
    const queue = buildTravelQueue(view, forceLong, nowMs);
    shot = { type, subject, def, startMs: nowMs, durationMs, caption, view, samplePos: liveSubjectPos(subject) };
    travelQueue = queue;
    travelIndex = 0;
    travelSegStartMs = nowMs;
    phase = "TRAVEL";
    setCaptionVisible(false);
    // Left as Infinity/Infinity regardless of hop length - finalized later,
    // either by updateTravel the instant an APEX segment actually begins
    // (long hop - the caption shows at APEX, not immediately at liftoff),
    // or by beginShotPhase once TRAVEL completes (short hop, or the
    // no-APEX tail of a long one, which beginShotPhase's own
    // `if (captionShowAtMs === Infinity)` guard correctly leaves untouched).
    captionShowAtMs = Infinity;
    captionHideAtMs = Infinity;
    return true;
  }

  function pickAndBeginShot(nowMs) {
    const t0 = performance.now();
    const candidates = computeCandidates(deps.getTrucks(), nowMs);
    if (!candidates.length) { lastPickMs = performance.now() - t0; return false; } // unreachable in practice - Interchange always yields a candidate
    const chosen = pickTypeFromCandidates(candidates, lastShotType);
    const ok = beginShotWith(chosen.type, chosen.subject, nowMs);
    lastPickMs = performance.now() - t0;
    return ok;
  }

  function setVeilOpacity(x) {
    // Driven directly, not via a CSS transition: the plan's 180ms-in/
    // 220ms-out timing is asymmetric and needs the camera snap to land
    // exactly at the seam between them, which is much simpler to get right
    // stepping a raw value once per frame than fighting a CSS transition's
    // own timing from JS.
    if (deps.veilEl) deps.veilEl.style.opacity = String(x);
  }

  function enter(reason, nowMs) {
    snapshot = deps.getFollowSnapshot();
    veilCutActive = snapshot.cameraMode === "FOLLOW_NAV";
    veilCutSnapDone = false;
    deps.unfollow(); // also nulls camera.followTarget and sets camera.mode = "FREE" (camera.js's own unfollow()) - both immediately overwritten below, but this is what makes state.followedTruckId/controlledTruckId consistent with the DIRECTOR mode being entered
    document.body.classList.add("director");
    camera.mode = "DIRECTOR";
    savedVisualCenterYRatio = camera.visualCenterYRatio;
    camera.visualCenterYRatio = 0.5; // the sheet is faded out, so the old "leave room for it" bias no longer applies
    enterStartMs = nowMs;
    phase = "ENTERING";
    setElVisible(deps.hintEl, true);
    setTimeout(() => setElVisible(deps.hintEl, false), 4000);
    setElVisible(deps.returnChipEl, false);
    if (returnChipTimer) { clearTimeout(returnChipTimer); returnChipTimer = null; }
    setVeilOpacity(0); // defensive - should already be 0 from the last cut's own fade-out, but never start a fresh entry mid-veil
  }

  function exit(reason, nowMs) {
    document.body.classList.remove("director");
    setCaptionVisible(false);
    setElVisible(deps.hintEl, false);

    if (reason === "reset") {
      // The whole fleet/graph is being torn down and rebuilt - nothing
      // here (a followed truck id, a saved camera view) will still be
      // meaningful the instant bootSim finishes, so this is a hard reset,
      // not the normal wake dance. bootSim sets its own camera.x/y/zoom
      // afterward, but never touches visualCenterYRatio, so that still
      // needs restoring here or a reset that happened to land mid-director
      // would leave every future frame biased toward the fade-out framing.
      phase = "IDLE";
      idleAccumMs = 0;
      shot = null;
      travelQueue = [];
      snapshot = null;
      camera.mode = "FREE";
      if (savedVisualCenterYRatio != null) camera.visualCenterYRatio = savedVisualCenterYRatio;
      return;
    }

    // Only the just-ended SHOT's own subject is considered here, per spec -
    // not a fallback to whatever the pre-director snapshot was following.
    // That restoration is the *chip's* job (returnToSnapshot, below): a
    // plain wake (tap/key/scroll) leaves the camera exactly where the
    // director left it, camera.mode FREE unless the shot handed off a live
    // truck, so "wake" and "fly back to my exact previous view" stay two
    // distinct, deliberately different actions rather than the first
    // silently doing part of the second's job.
    const subjectTruckId = shot && shot.subject && shot.subject.kind === "truck" ? shot.subject.id : null;
    const stillExists = subjectTruckId != null && deps.getTrucks().some((t) => t.id === subjectTruckId);
    if (stillExists) deps.followTruckById(subjectTruckId);
    else camera.mode = "FREE";
    if (savedVisualCenterYRatio != null) camera.visualCenterYRatio = savedVisualCenterYRatio;

    if (snapshot) {
      setElVisible(deps.returnChipEl, true);
      if (returnChipTimer) clearTimeout(returnChipTimer);
      returnChipTimer = setTimeout(() => {
        setElVisible(deps.returnChipEl, false);
        returnChipTimer = null;
      }, DIR_RETURN_CHIP_MS);
    }

    phase = "IDLE";
    idleAccumMs = 0;
    shot = null;
    travelQueue = [];
  }

  function start(reason) {
    if (phase !== "IDLE") return false;
    if (deps.isCareerActive() || deps.isBlocked()) return false;
    if (deps.getState().controlledTruckId != null) return false;
    if (reason !== "manual") {
      if (deps.getState().timeScale <= 0) return false;
    }
    enter(reason, performance.now());
    return true;
  }

  function stop(reason) {
    if (phase === "IDLE") return;
    exit(reason, performance.now());
  }

  function returnToSnapshot() {
    if (!snapshot) return;
    if (returnChipTimer) { clearTimeout(returnChipTimer); returnChipTimer = null; }
    setElVisible(deps.returnChipEl, false);
    // Fully exit the director state machine BEFORE starting this function's
    // own flight - main.js calls director.update() unconditionally every
    // frame while isActive() is true, and left running it would keep
    // dispatching to updateTravel/updateShot in parallel with the step()
    // loop below, both writing camera.x/y/zoom the same frame. Mirrors
    // exit()'s UI teardown, minus the parts that don't apply here (exit()
    // re-follows the just-ended shot's own subject and re-shows the return
    // chip - this path restores the pre-director view instead and has
    // already hidden the chip above).
    document.body.classList.remove("director");
    setCaptionVisible(false);
    setElVisible(deps.hintEl, false);
    if (savedVisualCenterYRatio != null) camera.visualCenterYRatio = savedVisualCenterYRatio;
    phase = "IDLE";
    idleAccumMs = 0;
    shot = null;
    travelQueue = [];

    const target = { x: snapshot.x, y: snapshot.y, w: canvas.clientWidth / snapshot.zoom };
    const path = flightPath(currentView(), target);
    const durationMs = Math.max(500, Math.min(900, flightDurationMs(path.S)));
    const startMs = performance.now();
    camera.mode = "FREE";
    const s = snapshot;
    snapshot = null;
    function step() {
      const now = performance.now();
      const t = flightEase(dirClamp01((now - startMs) / durationMs));
      const v = path.at(t);
      camera.x = v.x; camera.y = v.y;
      camera.zoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, canvas.clientWidth / v.w));
      if (t < 1) { requestAnimationFrame(step); return; }
      if (s.followedTruckId != null && deps.getTrucks().some((tr) => tr.id === s.followedTruckId)) {
        deps.followTruckById(s.followedTruckId);
        if (s.cameraMode === "FOLLOW_NAV") deps.enterNavView();
      }
    }
    requestAnimationFrame(step);
  }

  // --- per-frame update ------------------------------------------------------

  // Picks a shot and puts the camera EXACTLY on its view with no
  // interpolation - the second half of the FOLLOW_NAV veil-cut (the
  // "snap" between fading to black and fading back in). Shares
  // beginShotPhase with the normal flight path for everything after the
  // camera is in position (caption timing, shot.endMs, etc.) rather than
  // duplicating that bookkeeping here too.
  function snapToShotInstantly(nowMs) {
    const t0 = performance.now();
    const candidates = computeCandidates(deps.getTrucks(), nowMs);
    lastPickMs = performance.now() - t0;
    if (!candidates.length) return false; // unreachable in practice - Interchange always yields a candidate
    const { type, subject } = pickTypeFromCandidates(candidates, lastShotType);
    const def = SHOT_TYPES[type];
    lastShotType = type;
    if (subject.cooldownKey) markCandidateUsed(subject.cooldownKey, nowMs);
    const view = def.view(subject);
    shot = { type, subject, def, startMs: nowMs, durationMs: def.durationMs, caption: def.caption(subject), view, samplePos: liveSubjectPos(subject) };
    travelQueue = [];
    travelIndex = 0;
    // Move the camera NOW, while the veil is still fully opaque (opacity 1
    // - the caller only reaches here once that fade-in has finished) - the
    // entire reason for cutting through black is to hide this jump, so it
    // cannot wait for beginShotPhase's own (redundant, for the normal
    // flight path) re-snap, which only runs once the fade-OUT completes.
    camera.x = view.x; camera.y = view.y;
    camera.zoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, canvas.clientWidth / view.w));
    return true;
  }

  function updateEntering(nowMs) {
    if (veilCutActive) {
      const elapsed = nowMs - enterStartMs;
      if (!veilCutSnapDone) {
        if (elapsed < DIR_VEIL_IN_MS) { setVeilOpacity(elapsed / DIR_VEIL_IN_MS); return; }
        setVeilOpacity(1);
        veilCutSnapDone = true;
        if (!snapToShotInstantly(nowMs)) { exit("blocked", nowMs); return; }
        return; // hold one full frame at opacity 1 before starting the fade-out clock, so the cut always reads as a genuine held black frame, not a single-frame flicker
      }
      const outElapsed = elapsed - DIR_VEIL_IN_MS;
      const t = dirClamp01(outElapsed / DIR_VEIL_OUT_MS);
      setVeilOpacity(1 - t);
      if (t >= 1) { veilCutActive = false; beginShotPhase(nowMs); }
      return;
    }
    if (nowMs - enterStartMs >= DIR_ENTER_MS) {
      if (!pickAndBeginShot(nowMs)) {
        // Should be unreachable - Interchange always has a candidate on any
        // graph with a real junction - but never leave the camera stuck in
        // a half-entered state if it somehow happens.
        exit("blocked", nowMs);
      }
    }
  }

  function updateTravel(nowMs) {
    const seg = travelQueue[travelIndex];
    if (!seg) { beginShotPhase(nowMs); return; }
    const t = dirClamp01((nowMs - travelSegStartMs) / Math.max(1, seg.durationMs));

    if (seg.kind === "apex") {
      // Hold still at the country view reached by leg A - camera doesn't
      // move during this segment, only the pin/caption state does. Only
      // set once (guard against Infinity): this runs every frame apex is
      // active, and travelSegStartMs itself doesn't change during that
      // whole hold, so re-assigning would be harmless anyway, but the
      // guard documents that this is a one-time "the hold just began" event.
      if (captionShowAtMs === Infinity) captionShowAtMs = travelSegStartMs;
    } else {
      const eased = flightEase(t);
      const v = seg.path.at(eased);
      camera.x = v.x; camera.y = v.y;
      // Moving target: on the final leg, blend in how far the subject has
      // travelled since pick time, so the flight lands ON the truck.
      if (travelIndex === travelQueue.length - 1 && shot.samplePos) {
        const live = liveSubjectPos(shot.subject);
        if (live) { camera.x += (live.x - shot.samplePos.x) * eased; camera.y += (live.y - shot.samplePos.y) * eased; }
      }
      camera.zoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, canvas.clientWidth / v.w));
    }

    if (nowMs >= captionShowAtMs) setCaptionVisible(true);

    if (t >= 1) {
      travelIndex++;
      travelSegStartMs = nowMs;
      if (travelIndex >= travelQueue.length) beginShotPhase(nowMs);
    }
  }

  function beginShotPhase(nowMs) {
    phase = "SHOT";
    const shotStartMs = nowMs;
    shot.shotStartMs = shotStartMs;
    shot.endMs = shotStartMs + shot.durationMs;
    // Truck-subject shots: re-anchor the landing view and the caption's
    // "near {city}" to where the truck is NOW, not where it was at pick.
    const livePos = liveSubjectPos(shot.subject);
    if (livePos && shot.samplePos) {
      shot.view = { x: shot.view.x + (livePos.x - shot.samplePos.x), y: shot.view.y + (livePos.y - shot.samplePos.y), w: shot.view.w };
      shot.samplePos = livePos;
      shot.caption = shot.def.caption(shot.subject);
    }
    setCaptionText(shot.caption.eyebrow, shot.caption.line);
    if (captionShowAtMs === Infinity) captionShowAtMs = shotStartMs + DIR_CAPTION_IN_DELAY_MS;
    captionHideAtMs = shot.endMs - DIR_CAPTION_OUT_LEAD_MS;
    // Land exactly on the shot's own view - the flight's easing can leave a
    // sub-pixel residual at t=1 depending on how S was computed; snapping
    // here guarantees the static frame is pixel-exact, not just "close".
    camera.x = shot.view.x; camera.y = shot.view.y;
    camera.zoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, canvas.clientWidth / shot.view.w));
    shot.z0 = camera.zoom; // Convoy/Weather's own apply() pulls back from this exact starting zoom
  }

  function updateShot(nowMs) {
    if (!shot.def.isValid(shot.subject, deps.getTrucks())) { pickAndBeginShot(nowMs); return; }
    shot.def.apply(shot.subject, nowMs, camera, deps);
    if (nowMs >= captionShowAtMs) setCaptionVisible(true);
    if (nowMs >= captionHideAtMs) setCaptionVisible(false);
    if (nowMs >= shot.endMs) {
      if (!pickAndBeginShot(nowMs)) exit("blocked", nowMs);
    }
  }

  function update(dtReal, nowMs) {
    if (phase === "IDLE") {
      idleAccumMs += dtReal * 1000;
      const idleMs = idleMsOverride ?? (deps.getSettings().directorIdleSeconds || 0) * 1000;
      if (idleMs > 0 && idleAccumMs >= idleMs) start("idle");
      return;
    }
    // Defensive: something outside the shield's own control (a Routine, a
    // programmatic career start) made the world newly unsafe to keep
    // driving the camera in - never leave it stranded mid-flight.
    if (deps.isCareerActive() || deps.isBlocked()) { exit("blocked", nowMs); return; }
    if (phase === "ENTERING") updateEntering(nowMs);
    else if (phase === "TRAVEL") updateTravel(nowMs);
    else if (phase === "SHOT") updateShot(nowMs);
  }

  // --- render-facing output --------------------------------------------------

  function renderOpts() {
    if (phase === "IDLE" || phase === "ENTERING") return { marker: null, lightTrails: false };
    const nowMs = performance.now();
    let marker = null;
    if (phase === "TRAVEL") {
      const seg = travelQueue[travelIndex];
      if (seg && seg.kind === "apex") marker = seg.pin;
      else if (seg && seg.isLegB) {
        const t = dirClamp01((nowMs - travelSegStartMs) / Math.max(1, seg.durationMs));
        if (t <= 0.6) marker = seg.pin;
      }
    }
    if (marker) {
      const pulse = 0.5 + 0.5 * Math.sin((nowMs / 1000) * DIR_MARKER_PULSE_HZ * Math.PI * 2);
      marker = { x: marker.x, y: marker.y, pulse };
    }
    return { marker, lightTrails: false }; // lightTrails: Phase 5
  }

  return {
    update,
    start,
    stop,
    isActive: () => phase !== "IDLE",
    returnToSnapshot,
    renderOpts,
    debug: {
      forceShot(type, opts = {}) {
        const nowMs = performance.now();
        if (!SHOT_TYPES[type]) return "unavailable";
        const trucksNow = deps.getTrucks();
        runDirectorTally(trucksNow); // Bottleneck/Lone Hauler's own pick() reads this directly, same as a normal computeCandidates() cycle would have already done
        const subject = SHOT_TYPES[type].pick(trucksNow, nowMs);
        if (!subject) return "unavailable";
        deps.__debugForceLongHop = !!opts.longHop;
        if (phase === "IDLE") enter("manual", nowMs);
        const ok = beginShotWith(type, subject, nowMs);
        if (!ok) return "unavailable";
        return "ok";
      },
      // Dry-runs the weighted auto-pick `n` times back to back with no side
      // effects (no camera movement, no cooldown marking) - lets a test
      // sample the type distribution over many picks without waiting out
      // each shot's real 14-20s duration. Type-level exclusion (never the
      // same type twice running) is still honored via a local "last type"
      // that only this call's own loop advances.
      samplePickTypes(n) {
        const trucksNow = deps.getTrucks();
        const nowMs = performance.now();
        const out = [];
        let excludeType = lastShotType;
        for (let i = 0; i < n; i++) {
          const candidates = computeCandidates(trucksNow, nowMs);
          if (!candidates.length) break;
          const chosen = pickTypeFromCandidates(candidates, excludeType);
          out.push(chosen.type);
          excludeType = chosen.type;
        }
        return out;
      },
      setIdleMs(ms) { idleMsOverride = ms; },
      snapshot() {
        return {
          phase,
          shotType: shot ? shot.type : null,
          subjectId: shot && shot.subject ? (shot.subject.id ?? shot.subject.name ?? null) : null,
          caption: shot ? shot.caption : null,
          lastPickMs,
          // Which TRAVEL segment is currently playing ("flight"/"apex"), or
          // null outside TRAVEL - lets a test wait for the actual APEX hold
          // rather than inferring it from camera.zoom (unreliable whenever
          // the current view already happens to be near the country view,
          // since a forced long hop's own legA is then a near-zero-distance
          // flight that never visibly leaves that zoom level).
          travelSegKind: phase === "TRAVEL" ? (travelQueue[travelIndex]?.kind ?? null) : null,
        };
      },
      countryZoom,
    },
  };
}
