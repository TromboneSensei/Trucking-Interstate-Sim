// traffic.js - decorative AI vehicle traffic. Purely visual: no collision
// with the player (by design), just ambient trucks/cars that travel their
// own edge, follow each other, and pass on multi-lane interstates.
// Relies on globals from geo.js (graph, buildRibbon, ribbonSample,
// ribbonPose, ribbonLateral, edgeId, laneCount, UNITS_PER_MPH, mulberry32,
// hashStr) so it can share the exact same road/physics model the player
// uses without depending on game.js's internals.
"use strict";

const Traffic = (function () {
  const MAX_VEHICLES = 24;
  const SPACING = 950;          // world units per vehicle per lane, target density
  const FOLLOW_WINDOW = 220;    // look-ahead distance for car-following
  const FOLLOW_GAP = 90;        // desired following gap
  const PASS_GAP = 150;         // minimum clear gap to change lanes
  const DESPAWN_GRACE = 2.5;    // seconds an edge can be out of view before its vehicles are dropped
  const CATCHUP_RATE = 1.6;     // how fast speed eases toward target/blocked speed

  let vehicles = [];
  let nextId = 1;
  const lastSeenEdge = new Map(); // edgeId(edge) -> last timestamp seen in-view

  function randomSpeed(edge, rnd) {
    return edge.speedLimit * (0.78 + rnd() * 0.24);
  }

  function edgeVehicleCount(id) {
    let c = 0;
    for (const v of vehicles) if (v.edgeKey === id) c++;
    return c;
  }

  function spawnOn(edge, id, rnd) {
    const ribbon = buildRibbon(edge);
    const n = laneCount(edge.kind);
    const speed = randomSpeed(edge, rnd);
    vehicles.push({
      id: nextId++,
      edgeKey: id,
      edge, ribbon, s: rnd() * ribbon.length, lane: Math.floor(rnd() * n),
      speed, targetSpeed: speed,
      kind: rnd() < 0.7 ? "truck" : "car",
      paletteSeed: rnd(),
      changeCooldown: rnd() * 3,
    });
  }

  // visibleEdges: graph edge objects currently in the render tree. Spawns
  // both those edges AND their reverse direction (so oncoming traffic
  // appears on divided/undivided roads alike, reusing the same shared
  // ribbon geometry the player's own edges already use), and despawns
  // vehicles whose edge has been out of view for the grace period.
  function maintain(visibleEdges, now) {
    const wanted = new Map();
    for (const e of visibleEdges) {
      const id = edgeId(e);
      wanted.set(id, e);
      lastSeenEdge.set(id, now);
      const rev = (graph.adjacency[e.to] || []).find((r) => r.to === e.from && r.route === e.route);
      if (rev) {
        const revId = edgeId(rev);
        wanted.set(revId, rev);
        lastSeenEdge.set(revId, now);
      }
    }

    for (const [id, edge] of wanted) {
      if (vehicles.length >= MAX_VEHICLES) break;
      const ribbon = buildRibbon(edge);
      const n = laneCount(edge.kind);
      const targetCount = Math.min(4, Math.max(1, Math.round((ribbon.length / SPACING) * n)));
      const rnd = mulberry32(hashStr(id + "|" + Math.floor(now / 4)));
      let have = edgeVehicleCount(id);
      let guard = 0;
      while (have < targetCount && vehicles.length < MAX_VEHICLES && guard++ < 6) {
        spawnOn(edge, id, rnd);
        have++;
      }
    }

    vehicles = vehicles.filter((v) => {
      const seen = lastSeenEdge.get(v.edgeKey);
      return seen !== undefined && now - seen < DESPAWN_GRACE;
    });
  }

  function laneClear(v, lane) {
    for (const o of vehicles) {
      if (o === v || o.edgeKey !== v.edgeKey || o.lane !== lane) continue;
      if (Math.abs(o.s - v.s) < PASS_GAP) return false;
    }
    return true;
  }

  // Reaching the end of an edge merges onto a connecting highway instead
  // of despawning, so traffic flows continuously through junctions (the
  // same graph pickEdgesFrom the player's own routing uses, so AI only
  // ever continues onto a real connecting road).
  function continueVehicle(v) {
    const overflow = v.s - v.ribbon.length;
    const options = pickEdgesFrom(v.edge.to, v.edge);
    const next = options[Math.floor(Math.random() * options.length)];
    v.edge = next;
    v.edgeKey = edgeId(next);
    v.ribbon = buildRibbon(next);
    v.s = Math.min(Math.max(0, overflow), v.ribbon.length);
    v.lane = Math.min(v.lane, laneCount(next.kind) - 1);
    v.targetSpeed = randomSpeed(next, Math.random);
    v.changeCooldown = 1 + Math.random() * 2;
  }

  function update(dt) {
    for (const v of vehicles) {
      v.changeCooldown = Math.max(0, v.changeCooldown - dt);

      let aheadGap = Infinity, aheadSpeed = v.targetSpeed;
      for (const o of vehicles) {
        if (o === v || o.edgeKey !== v.edgeKey || o.lane !== v.lane) continue;
        const gap = o.s - v.s;
        if (gap > 0 && gap < aheadGap) { aheadGap = gap; aheadSpeed = o.speed; }
      }
      const blocked = aheadGap < FOLLOW_WINDOW && (aheadGap < FOLLOW_GAP || aheadSpeed < v.speed - 2);
      const desired = blocked ? Math.min(aheadSpeed, v.speed) : v.targetSpeed;
      v.speed = Math.max(0, v.speed + (desired - v.speed) * Math.min(1, dt * CATCHUP_RATE));

      const lanes = laneCount(v.edge.kind);
      if (lanes > 1 && v.changeCooldown <= 0) {
        if (blocked && v.lane > 0 && laneClear(v, v.lane - 1)) {
          v.lane -= 1;
          v.changeCooldown = 3 + Math.random() * 3;
        } else if (!blocked && v.lane < lanes - 1 && Math.random() < 0.15 * dt && laneClear(v, v.lane + 1)) {
          v.lane += 1;
          v.changeCooldown = 3 + Math.random() * 3;
        }
      }

      v.s += v.speed * UNITS_PER_MPH * dt;
      if (v.s >= v.ribbon.length) continueVehicle(v);
    }
  }

  function getVehicles() { return vehicles; }

  return { maintain, update, getVehicles };
})();
