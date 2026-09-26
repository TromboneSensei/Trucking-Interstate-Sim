// director.js - the idle-cam "director": after enough real time with no
// input, an automated camera takes over, fades the app chrome out, and
// cuts between interesting shots of the live sim with a caption for each.
// A cross-country hop flies out to a whole-country view first (Google-
// Earth-style), holds on a pulsing destination pin, then flies back in.
//
// Phase 3 ships the full state machine (idle detection, camera takeover,
// travel/APEX/wake) wired to exactly one shot type - Interchange, a still
// shot of a busy road junction, chosen because it never needs a candidate
// (every real road network has junctions) and needs no per-frame camera
// motion (a static shot), so the framework can be proven correct before
// Phase 4 adds the four shots that actually need a truck to follow.
"use strict";

// truckPose, travelDirectionLabel, rawDarknessAtX, effectiveDarkness join
// this import list in Phase 4, once a shot type actually needs a truck's
// position/heading or a darkness check (Interchange needs neither - its
// subject is a fixed road junction).
import { WORLD_WIDTH, WORLD_HEIGHT } from "./geo.js";
import { flightPath, flightDurationMs, flightEase } from "./flight.js";

// --- tunables (Appendix C) --------------------------------------------
const DIR_LONG_HOP_WORLD = 900; // world-unit hop distance above which a move routes via the country view
const DIR_APEX_HOLD_MS = 900; // pause at the country view, pin + caption visible
const DIR_LOOKAHEAD_FRAC = 0.2; // unused until Phase 4's anticipatory-follow shots
const DIR_PULLBACK_S = 14; // unused until Phase 4
const DIR_CANDIDATE_COOLDOWN_MS = 10 * 60 * 1000; // don't reuse a truck/segment/node for 10 real minutes
const DIR_CAPTION_IN_DELAY_MS = 800; // after landing on a short hop; long hops show the caption at APEX instead
const DIR_CAPTION_OUT_LEAD_MS = 1200; // caption fades this long before the shot itself ends
const DIR_ENTER_MS = 350; // UI-fade grace period before the first flight begins
const DIR_RETURN_CHIP_MS = 6000;
const DIR_MARKER_PULSE_HZ = 1.1;
const DIR_VEIL_IN_MS = 180;
const DIR_VEIL_OUT_MS = 220;

const DIR_SHOT_WEIGHTS = { interchange: 10 }; // Phase 4 adds bottleneck/convoy/weather/lone here

function dirClamp01(x) { return Math.max(0, Math.min(1, x)); }

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

// dirRouteLabel (the same shield-ish route-name shortening cb.js's own
// module-private cbRouteLabel applies) joins Phase 4, once a caption
// actually names a route - Interchange's caption never does.

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

  // --- shot candidates -----------------------------------------------------

  // Nodes with 4+ connecting roads, scored by degree x (1 + touching
  // traffic/10). "Touching traffic" needs a live truck tally, but this is
  // the ONLY shot type Phase 3 ships, so a full director-wide tally
  // (Appendix B's "Director tally", shared by Bottleneck in Phase 4) would
  // be pure dead weight right now - this counts moving, non-disabled,
  // non-arrival-braking trucks on each candidate's own incident edges
  // directly instead, which is exactly as correct for a handful of
  // candidates and doesn't require carrying typed arrays sized to the
  // whole edge list until Phase 4 actually needs them for Bottleneck too.
  function scoreInterchange(name, trucks) {
    const adj = graph.adjacency[name] || [];
    if (adj.length < 4) return null;
    let traffic = 0;
    for (const truck of trucks) {
      if (!truck.edge || truck.parkedAt || truck.disabledHoursLeft > 0 || truck.arrivalBraking) continue;
      if (truck.edge.from === name || truck.edge.to === name) traffic++;
    }
    return adj.length * (1 + traffic / 10);
  }

  function pickInterchangeCandidate(trucks, nowMs) {
    const scored = [];
    for (const name in graph.nodes) {
      const score = scoreInterchange(name, trucks);
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

  // Registry of shot types this build actually knows how to pick + frame.
  // Phase 4 adds bottleneck/convoy/weather/lone entries here, in the same
  // shape - `pick` returns a subject or null, `caption` builds the two-line
  // text, `view` gives TRAVEL its destination {x,y,w}, `duration` is ms,
  // `isValid` re-checks the subject is still real each SHOT frame (a static
  // node is trivially always valid), and `apply` does per-frame framing
  // work during SHOT (a no-op for a static shot - the camera just sits).
  const SHOT_TYPES = {
    interchange: {
      weight: DIR_SHOT_WEIGHTS.interchange,
      durationMs: 14000,
      pick(trucksNow, nowMs) {
        const c = pickInterchangeCandidate(trucksNow, nowMs);
        if (!c) return null;
        markCandidateUsed("node:" + c.name, nowMs);
        return { kind: "node", name: c.name };
      },
      isValid() { return true; }, // a road junction never disappears
      view(subject) {
        const node = graph.nodes[subject.name];
        return { x: node.x, y: node.y, w: canvas.clientWidth / 2.2 };
      },
      caption(subject) { return interchangeCaption(graph.nodes[subject.name]); },
      apply() {}, // static framing - nothing to do per frame during SHOT
    },
  };

  function availableShotTypes(trucksNow) {
    // Phase 3 has exactly one type, so this is trivially always
    // ["interchange"] - written as a real filter (not hardcoded) so
    // Phase 4 dropping in more entries needs no change here.
    return Object.keys(SHOT_TYPES);
  }

  function weightedPickType(trucksNow) {
    const avail = availableShotTypes(trucksNow);
    // Exclude the just-used type UNLESS it's the only one currently
    // available (true for the whole of Phase 3 - Interchange is the only
    // registered type - and can still happen in Phase 4 whenever every
    // other type's candidate search comes up empty).
    const filtered = avail.length > 1 ? avail.filter((t) => t !== lastShotType) : avail;
    const pool = filtered.length ? filtered : avail;
    let total = 0;
    for (const t of pool) total += SHOT_TYPES[t].weight;
    let r = Math.random() * total;
    for (const t of pool) {
      r -= SHOT_TYPES[t].weight;
      if (r <= 0) return t;
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

  function beginShot(type, nowMs) {
    const def = SHOT_TYPES[type];
    const subject = def.pick(deps.getTrucks(), nowMs);
    if (!subject) return false;
    lastShotType = type;
    const view = def.view(subject);
    const caption = def.caption(subject);
    const durationMs = def.durationMs;
    const forceLong = deps.__debugForceLongHop || false;
    deps.__debugForceLongHop = false;
    const queue = buildTravelQueue(view, forceLong, nowMs);
    shot = { type, subject, def, startMs: nowMs, durationMs, caption, view };
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
    const type = weightedPickType(deps.getTrucks());
    const t0 = performance.now();
    const ok = beginShot(type, nowMs);
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
    const type = weightedPickType(deps.getTrucks());
    const t0 = performance.now();
    const def = SHOT_TYPES[type];
    const subject = def.pick(deps.getTrucks(), nowMs);
    lastPickMs = performance.now() - t0;
    if (!subject) return false;
    lastShotType = type;
    const view = def.view(subject);
    shot = { type, subject, def, startMs: nowMs, durationMs: def.durationMs, caption: def.caption(subject), view };
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
    setCaptionText(shot.caption.eyebrow, shot.caption.line);
    if (captionShowAtMs === Infinity) captionShowAtMs = shotStartMs + DIR_CAPTION_IN_DELAY_MS;
    captionHideAtMs = shot.endMs - DIR_CAPTION_OUT_LEAD_MS;
    // Land exactly on the shot's own view - the flight's easing can leave a
    // sub-pixel residual at t=1 depending on how S was computed; snapping
    // here guarantees the static frame is pixel-exact, not just "close".
    camera.x = shot.view.x; camera.y = shot.view.y;
    camera.zoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, canvas.clientWidth / shot.view.w));
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
        deps.__debugForceLongHop = !!opts.longHop;
        if (phase === "IDLE") enter("manual", nowMs);
        const ok = beginShot(type, nowMs);
        if (!ok) return "unavailable";
        return "ok";
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
