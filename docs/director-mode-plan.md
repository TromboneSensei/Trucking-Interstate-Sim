# Director Mode + Convoy Tethers: Build Plan

Written for the model implementing this. Read it all once before
touching code. Every step names real functions in this repo. Line
numbers are approximate and drift as you edit, so anchor on the quoted
code, not the number.

---

## 0. Orientation

### What we're building (spectator map mode only, never career)

1. **Convoy tethers.** A thin amber dashed line from each drafting truck to
   the truck it's drafting behind. Dashes flow toward the leader. The line
   fades with zoom: invisible at state and country zoom, visible up close.
2. **Director mode.** After N seconds of no input (default 45), an automated
   camera takes over. It fades the UI out and cuts between interesting shots
   with a caption for each. Cross-country moves fly Google-Earth style: zoom
   out to the whole country, pause for a beat on a destination pin, then
   zoom in.
3. **Long-exposure light trails.** During still, nighttime director shots,
   trucks leave fading streaks of light.

### Decisions already made by the user (do not relitigate)

- Shot mix is Bottleneck 30%, Convoy 25%, Weather 25%, Lone Hauler 20%.
  Weights are renormalized over whichever types have a candidate right now.
  **Interchange** is an always-available static shot at weight 10: it gives
  variety and fills in when nothing else qualifies.
- Framings: **Anticipatory Follow** (truck sits behind screen-center, road
  ahead revealed), **Drone Pull-Back** (tight to wide over ~14 s), and
  **Static Frame** (camera still, traffic streams through).
- Long hops zoom out to the **whole country** first, then back in.
- Waking up **does not yank the camera back**. The UI fades in. If the shot
  was following a truck, normal follow continues on that truck. A
  "↩ Back to your view" chip shows for 6 s and flies back to the
  pre-director view if tapped.
- There's no audio in this game. Skip the "audio muffling" idea entirely.

### Out of scope

Career mode (director never runs while `career.isActive()`), seasonal
skins, traffic cameras, and anything not listed above.

### Build, test, publish

```
node scripts/build.mjs          # -> dist/interstate-fleet.html (fails loudly on bundle hazards)
node scripts/smoke.mjs          # phone viewport; add --desktop for 1280x800
```

- Branch: `claude/highway-truck-game-jyj8pr`. Commit per phase and push with
  `git push -u origin claude/highway-truck-game-jyj8pr`.
- Publish the playable game after each phase that changes something visible
  (Phases 1, 3, 4, 5, 6). Use the Artifact tool with
  `file_path: dist/interstate-fleet.html` and
  `url: https://claude.ai/code/artifact/a1fecad7-78ea-416f-9cf7-421354801195`.
  **Never** publish the repo's old `artifact_publish.html`. It's a stale
  build from months ago.
- Keep every test script in `scripts/` and commit it. The scratchpad does
  not survive container resets. That's how ~15 earlier regression scripts
  were lost.

### Hard rules for this codebase

1. **Flat bundle.** `scripts/build.mjs` concatenates every `src/*.js` into
   ONE classic script. Every top-level `const`/`let`/`class`/`function`
   shares one global scope across all files.
   - Before adding any top-level name, grep it across `src/`. The build
     fails on const/let/class collisions and on new duplicate functions.
   - Prefix new top-level names in new modules: `dir…`/`DIR_…` in
     `director.js`, `flight…`/`FLIGHT_…` in `flight.js`.
   - A new src file must be added to `ORDER` in `scripts/build.mjs`. The
     build fails otherwise.
   - Use named imports (`import { a } from "./x.js"`). Don't add new
     `import * as` aliases.
2. **Don't restructure `fleet.js`'s tick loop.** The comment above
   `applyFollowAndPassing` (≈ fleet.js:901) explains that truck iteration
   order is load-bearing for the simulation. Only add assignments where this
   plan says.
3. **render.js cannot import career.js or main.js** (import cycle).
   Everything render needs arrives through `drawFrame`'s `renderOpts`.
4. **Globals are test hooks.** Playwright's `page.evaluate(() => trucks)`
   reads top-level bindings by name (`trucks`, `graph`, `camera`, `state`,
   `settings`, `career`, `director`). `trucks` and `settings` are
   *reassigned* by `bootSim`, so never cache them. Pass getters
   (`() => trucks`).
5. **Comments:** explain *why* where it's non-obvious (an invariant, a
   workaround, a surprising choice). Don't narrate *what*.
6. **Look at your output.** For every visual step, take a screenshot with
   Playwright and open it with the Read tool before calling the step done.
   Test suites check state, not appearance. Twice in this project a
   "passing" change was visibly broken.

### Per-phase definition of done

1. `node scripts/build.mjs` passes.
2. `node scripts/smoke.mjs` and `node scripts/smoke.mjs --desktop` pass.
3. The phase's own `scripts/verify-*.mjs` passes 3 runs in a row, since
   several behaviors here are probabilistic.
4. Screenshots were taken and actually looked at.
5. Committed and pushed. Published if the phase is visible.
6. A 2–4 sentence note to the user: what's visible now, anything
   surprising.

---

## Phase 0: Baseline (≈5 min)

The build tooling (`scripts/build.mjs`, `scripts/smoke.mjs`, `.gitignore`)
already exists and was green on phone and desktop when this plan was
written. Run both before changing anything. If either fails, stop and tell
the user. Don't build on a red baseline.

---

## Phase 1: Drafting data fix + convoy tethers

### 1a. Fix the stale `isDrafting` flag (fleet.js) — this is a real bug

`truck.isDrafting` is only assigned at ≈ fleet.js:955, *after*
`applyFollowAndPassing`'s early returns:

- the non-interstate return (`if (truck.edge.kind !== "interstate") return Infinity;`)
- the shoulder-rider return
- the `if (!group) return Infinity;` return

So a truck drafting as it leaves an interstate keeps `isDrafting === true`
on highways, and keeps getting the 30% fuel discount at ≈ fleet.js:1216.
It also keeps the flag after parking (≈ fleet.js:631,
`this.parkedAt = this.currentNode;`).

Fix:
- At the **very top** of `applyFollowAndPassing`, before the first
  `return`: `truck.isDrafting = false; truck.draftLeader = null;`
- Right after the existing `truck.isDrafting = !!(…)` assignment:
  `truck.draftLeader = truck.isDrafting ? leader : null;`
- In the `Truck` constructor next to `this.isDrafting = false;` (≈ fleet.js:507):
  add `this.draftLeader = null;`
- At the park site (≈ fleet.js:631), clear both fields.
- ui.js ≈ 910 shows a "● DRAFTING NOW" chip. It needs no change once the
  flag is correct.

This slightly changes the simulation: ex-drafters stop getting a phantom
fuel discount. That's intended. Say so in the commit message.

### 1b. Draw tethers (render.js `drawFrame`)

- Add module-level reusable `const tetherPts = [];` next to
  `headlightPts` (≈ render.js:200). Grep `tetherPts` first.
- In the per-truck loop (after `truckPose(graph, truck, scratchPos)` and
  the visibility test), if all of these hold:
  - `renderOpts.showConvoyTethers !== false`
  - `truck.isDrafting`
  - `truck.draftLeader`
  - `truck.draftLeader.edge === truck.edge`
  - `!truck.draftLeader.parkedAt`
  
  then compute the leader's pose into a second scratch object and push
  `follower.x, follower.y, leader.x, leader.y`. The same-edge check makes
  the renderer robust even if a flag is ever stale again.
- Gate the whole pass on zoom:
  `tetherAlpha = smoothstep(0.9, 1.6, camera.zoom) * 0.55`. Skip if
  `tetherAlpha < 0.01`. Write `smoothstep` as a local inline helper or a
  uniquely named one; grep first.
- Draw **after the headlight pass, before the batched truck dots**, so dots
  sit on top:
  - one `beginPath`, all segments, one `stroke()`
  - `strokeStyle: rgba(240,169,60,α)` (this is `--caution` #f0a93c)
  - `lineWidth: 1.6 / camera.zoom`
  - `setLineDash([6 / zoom, 5 / zoom])`
  - `lineDashOffset = -(_renderRealSeconds * 14) / camera.zoom`
  - Reset the dash afterward.
  - Verify visually that dashes travel **from follower toward leader**. If
    they go the other way, flip the sign.
  - Use real seconds, not game seconds, so the flow speed doesn't change
    with the sim-speed slider.
- Add `tethersDrawn: <segment count>` to `drawFrame`'s returned object. Tests
  use it.

### 1c. Setting

Add `showConvoyTethers: true` to `DEFAULT_SETTINGS` (main.js ≈ 33). Add a
"Convoy Tethers" switch row in `index.html`'s settings panel, mirroring the
`setting-headlights` row exactly. Wire it through `el`, `openSettings`
(≈ main.js:824), and the Apply handler (≈ main.js:860). Pass
`showConvoyTethers: settings.showConvoyTethers` in `drawFrame`'s
`renderOpts` (≈ main.js:1252).

### 1d. `scripts/verify-convoy.mjs`

Launch a fresh browser per page load (see Appendix E). Set
`state.timeScale = 4` and run ~40 s real time. Then assert:

- At least one truck has `isDrafting`. With the default 1000 trucks this
  should hold. If it's flaky, apply a 3000-truck fleet through Settings
  first.
- **Invariant, over every truck:** `isDrafting` implies
  `edge && edge.kind === "interstate" && !parkedAt && draftLeader && draftLeader.edge === edge`.
  This is the 1a fix.
- Follow a drafting truck (`followTruck(t)`), set `camera.zoom = 3`, and
  wait 2 frames. `drawFrame` must report `tethersDrawn > 0`. Expose the
  last frame stats as a top-level `lastFrameStats` in main.js if needed.
- `camera.unfollow(); camera.zoom = 0.4` must give `tethersDrawn === 0`.
- Screenshot at zoom 3 on a drafter, phone viewport, and **look at it**.

---

## Phase 2: Flight math (`src/flight.js`, pure, no imports)

A standalone module so the math is unit-testable in plain Node. Add
`"flight.js"` to `ORDER` right after `"geo.js"`.

Exports:
- `flightPath(from, to)`: `from`/`to` are `{x, y, w}`, where `w` is the
  viewport **width in world units** (`canvas.clientWidth / camera.zoom`).
  Returns `{ at(t) -> {x, y, w}, S }` for `t ∈ [0,1]`. The formula is in
  Appendix A.
- `flightDurationMs(S)`: `clamp(|S| * FLIGHT_MS_PER_S, FLIGHT_MIN_MS, FLIGHT_MAX_MS)`.
- `flightEase(t)`: easeInOutCubic.

`scripts/test-flight.mjs`: plain `node`, imports `../src/flight.js`
directly. Assert:
- `at(0)` and `at(1)` equal the endpoints within 1e-6.
- No NaN or Infinity across 200 samples, for:
  - a same-point zoom-in
  - a same-point zoom-out
  - a 3500-unit pan at `w=150` on both ends
  - a pan to a view *wider* than the start
- For the long pan, `w` peaks mid-flight above both endpoints (it zooms
  out).
- For a leg ending at the country view (w=4000), `w` is monotonically
  non-decreasing.

---

## Phase 3: Director framework

Get the whole lifecycle working end to end using **only the Interchange
shot**, which is always available. Add the other shots in Phase 4.

### 3a. `src/director.js`

Add to `ORDER` right before `"main.js"`. It imports:
- `truckPose` from render.js
- `WORLD_WIDTH`, `WORLD_HEIGHT`, `travelDirectionLabel`, `rawDarknessAtX`,
  `effectiveDarkness` from geo.js
- `flightPath`, `flightDurationMs`, `flightEase` from flight.js

Shape:

```js
export function createDirector(deps) -> director
// deps: { camera, canvas, graph, edgeList,
//         getTrucks, getState, getSettings, getWeather,          // getters: bootSim reassigns these
//         isCareerActive, isBlocked,                              // isBlocked: decision/contract/settings/truck-stop/wizard open
//         getFollowSnapshot, followTruckById, unfollow, enterNavView }
director.update(dtReal, nowMs)   // call every frame
director.start(reason)           // "idle" | "manual"
director.stop(reason)            // "wake" | "blocked" | "reset"
director.isActive()
director.returnToSnapshot()
director.renderOpts()            // -> { marker, lightTrails } for drawFrame
director.debug                   // Appendix D
```

Keep all state inside the closure. The only top-level name added is
`createDirector`.

**State machine.** Phases:

```
IDLE → ENTERING → TRAVEL → (APEX) → SHOT → TRAVEL → … ; any → EXITING → IDLE
```

- **IDLE:** add `dtReal` to `idleAccum` each frame. Any input resets it to 0.
  Use accumulated frame time, not wall-clock, so returning from a
  background tab after 10 minutes doesn't instantly trigger. Auto-start
  when all of these hold:
  - `idleAccum ≥ settings.directorIdleSeconds`, which is > 0
  - `!isCareerActive()`
  - `!isBlocked()`
  - `state.timeScale > 0`
  - `state.controlledTruckId == null`
  
  Manual start via the 🎬 button skips the idle and timeScale checks.
- **ENTERING (350 ms):**
  - Snapshot `{x, y, zoom, mode, heading, followedTruckId, visualCenterYRatio}`.
  - Call `deps.unfollow()`. This is required: main.js's per-frame follow
    resync would otherwise call `unfollow()` and drop the camera to FREE
    every frame.
  - Add `body.director`.
  - Set `camera.mode = "DIRECTOR"`.
  - Lerp `camera.visualCenterYRatio` 0.42 → 0.5, since the sheet is faded
    out.
  - Pick the first shot.
  - Entering from `FOLLOW_NAV`: the rotated, tilted view can't interpolate
    to flat, so use a **veil cut** instead of a flight. Fade black in over
    180 ms, snap the camera, fade out over 220 ms.
- **TRAVEL:** the flight to the shot's opening view (Appendix A):
  - A short hop (`dist ≤ DIR_LONG_HOP_WORLD`) is one `flightPath` leg.
  - A long hop is:
    - **leg A** to the country view `{x: WORLD_WIDTH/2, y: WORLD_HEIGHT/2, w: canvas.clientWidth / dirCountryZoom()}`
    - an **APEX** hold of `DIR_APEX_HOLD_MS`: the destination pin pulses
      and the caption fades in
    - **leg B** to the shot view
  - Skip leg A if the current view is already ≥ 90% of country width.
  - `dirCountryZoom() = min(clientWidth / WORLD_WIDTH, clientHeight / WORLD_HEIGHT) * 0.9`.
    Use full height, not main.js's `fitZoom`, which reserves 45% for the
    sheet that's now invisible.
  - **Moving targets:** sample the subject's opening view once at pick
    time. During leg B add `(liveView − sampledView) * flightEase(t)` so
    the flight lands exactly on the truck's live position.
  - Write `camera.x/y/zoom` directly each frame, with
    `zoom = clientWidth / w`, clamped to `camera.minZoom..maxZoom`.
- **SHOT:** run the shot's framing for its duration (Appendix B). Each frame,
  validate the subject: the truck still exists (`getTrucks().includes`) and
  isn't parked or disabled. If it's invalid, end the shot early. Near the
  end, pick the next shot. Never pick the same *type* twice in a row unless
  it's the only one available. Don't reuse the same truck, segment, or node
  within `DIR_CANDIDATE_COOLDOWN_MS`.
- **EXITING (wake):**
  - Remove `body.director`.
  - Restore `visualCenterYRatio`.
  - If the current or next subject is a truck that still exists:
    `followTruckById(id)`. That's normal FOLLOW, and it also opens the detail
    sheet, which is fine. Otherwise `camera.mode = "FREE"` at the current
    x/y/zoom.
  - Show the return chip for 6 s.

**`returnToSnapshot()`:** a single-leg flight back, with duration clamped to
500–900 ms. Then restore:
- if `followedTruckId` still exists: `followTruckById`
- if the snapshot mode was `FOLLOW_NAV`: `enterNavView()`; reuse the NAV
  VIEW button's own handler logic
- otherwise FREE at the snapshot view

Hide the chip.

**Reduced motion.** When
`matchMedia("(prefers-reduced-motion: reduce)").matches`, replace every
flight with a veil cut and skip pin pulsing.

### 3b. Camera (camera.js)

Add `"DIRECTOR"` to the mode comment (≈ camera.js:37). `update()` already
no-ops for an unknown mode; confirm it. Then grep every `camera.mode` reader
in `src/` and confirm DIRECTOR is harmless for each: main.js `isFollowMode`,
render.js `nav`, cb.js, ui.js. The shield blocks all canvas input while
director is active, so camera.js's drag and zoom handlers never see it.

### 3c. main.js wiring

- `const director = createDirector({...})` at top level after `camera` is
  created. `followTruckById(id)` wraps `truckById.get(id)` → `followTruck`.
  `isBlocked` returns `state.settingsOpen || state.decisionTruck || state.contractTruck || isTruckStopOpen()`
  plus the wizard overlay being visible.
- In `frame()`: call `director.update(dt, now)` **immediately after**
  `camera.update()` (≈ main.js:1202), outside the `!state.settingsOpen`
  block.
- Guard the follow-resync `else if (!isFollowMode && state.followedTruckId != null)`
  branch (≈ main.js:1189) with `!director.isActive()`.
- Pass `...director.renderOpts()` into `drawFrame`'s `renderOpts`.
- `bootSim`: call `director.stop("reset")` first.
- Each frame, hide the director button during a career:
  `el.btnDirector.classList.toggle("hidden", career.isActive())`.
- Setting: add `directorIdleSeconds: 45` to `DEFAULT_SETTINGS`. Add a
  "Director Mode" `<select id="setting-director-idle">` with Off=0, After
  30s, After 45s, After 90s, wired like `setting-start-time`.

### 3d. DOM + CSS (index.html, style.css)

Use the existing tokens (`--panel`, `--caution`, `--r-md`, `--e2`,
`--sheen`, `--fs-*`, `--font-display`) and match the style of the existing
components.

- `<button id="btn-director" class="pill-btn">🎬 DIRECTOR</button>` inside
  `#hud-actions`, right after `#btn-career`. Neutral style like
  `#btn-nav-toggle`.
- `#director-shield`: fixed, inset 0, `z-index: 40` (above sheet, overlays,
  and toast; below `#fatal-error`'s 100), transparent, `touch-action: none`,
  `hidden` by default. Handlers:
  - **`pointerdown`:** call `preventDefault()`. This suppresses the
    compatibility mouse events and click underneath, so the waking tap
    doesn't also select a truck or pan the map. Begin exit.
  - Keep the shield up until `pointerup`/`pointercancel`, then hide it on
    the next frame. If you hide it immediately on `pointerdown`, the
    trailing click lands on the canvas.
  - **`wheel`:** exit, with `preventDefault`.
  - **`pointermove`** with `pointerType === "mouse"` and more than 12 px of
    total travel: exit.
  - Window `keydown` in capture phase while active: exit +
    `stopImmediatePropagation()`.
- `#director-veil`: fixed, inset 0, black, `opacity: 0`,
  `pointer-events: none`, `z-index: 35`. The director drives the opacity
  through a class with a transition.
- `#director-caption`: a lower-left lower third.
  - Container: `--panel` at ~0.78 alpha, `backdrop-filter: blur(6px)`,
    radius `--r-md`, padding 10px 14px.
  - `.dc-eyebrow`: Oswald caps, `--fs-tiny`, `--caution`, letter-spacing
    0.1em.
  - `.dc-line`: body `--fs-base`, `--ink`.
  - Position: `left/bottom max(16px, safe-area)`.
  - Fade via an `.show` class. **No accent rail.** The recent UI redesign
    deliberately removed decorative left borders.
- `#director-hint`: a top-left chip, "● DIRECTOR · tap anywhere to take
  over". Shown on entry, fades after 4 s.
- `#director-return`: a pill centered at
  `bottom: calc(var(--sheet-visible-h) + 16px)`, "↩ Back to your view",
  hidden by default.
- **UI fade.** Under `body.director`, set `opacity: 0; pointer-events: none`
  on all of these:

  `#hud, #btn-settings, #time-readout, #speed-popover, #fps-counter, #bottom-sheet, #daily-digest, #payroll-alert, #toast, #decision-overlay, #contract-overlay`

  **Cascade trap:** `#bottom-sheet` already has
  `transition: transform …`. **Append** `opacity var(--dur-3) var(--ease)`
  to that same declaration; don't add a second `transition` that overwrites
  it. Same check for every element above that already has a `transition` or
  `animation`. Put the opacity transition on the *base* rule, not under
  `body.director`, so the fade back **in** animates too.

### 3e. Interchange shot (the only shot in this phase)

See Appendix B. It needs the director's own segment tally (Appendix B,
"Director tally") for scoring.

### 3f. `scripts/verify-director.mjs` (extend in Phases 4 and 5)

Assert:
- `director.start("manual")`, then 500 ms later: `body.director` is set,
  `getComputedStyle(#bottom-sheet).opacity === "0"`,
  `camera.mode === "DIRECTOR"`, and the shield is visible.
- `debug.forceShot("interchange", {longHop: true})`, sampling
  `camera.zoom` every 100 ms through the travel. The minimum zoom is
  ≤ `dirCountryZoom() * 1.15` (it reached the country view), and the final
  zoom is ≈ the shot zoom. The phase passes through `"APEX"`.
- The caption is visible with non-empty eyebrow and line text during SHOT.
- `page.mouse.click` on the shield ends director mode. It must NOT select a
  truck: `state.followedTruckId` is either unchanged or equals the director's
  subject, never a random truck under the cursor. The UI is visible again
  and `#director-return` is visible.
- Clicking `#director-return` returns the camera to within 5% of the
  snapshot x/y/zoom within 1.5 s.
- Auto-start: `debug.setIdleMs(1500)`, wait 2.2 s with no input, and it's
  active. Repeat with `career` active (Quick Start): it must NOT start.
  Repeat with the settings overlay open: it must NOT start.
- Wake by `keydown`: active → inactive, and no decision-panel digit handling
  fires.
- Screenshots: during a shot, at the apex, and right after wake. Take them
  at phone and desktop sizes, and look at all of them.

---

## Phase 4: The shot catalog + captions

Implement Bottleneck, Convoy, Weather, and Lone Hauler per Appendix B. Then
the weighted pick:

- Build `available = types with ≥1 candidate`.
- Weights: `{bottleneck:30, convoy:25, weather:25, lone:20, interchange:10}`,
  over available types only.
- Exclude the previous type unless it's the only one.
- A roll picks the type. Within the type, take the best candidate (convoy,
  bottleneck) or a random one among qualifiers (lone, interchange).

**Captions** are built in director.js:
- Route label: `edge.route` shortened the way cb.js's `cbRouteLabel` does
  it. That function is module-private, so write a uniquely named copy
  (`dirRouteLabel`).
- Direction: `travelDirectionLabel(edge)`.
- "Near X": the nearest `node.t > 0` city to the subject position. That's
  an O(nodes) scan, run once per shot.

**Performance budget.** Candidate scans run once per pick, never per frame.
Measure the pick with `performance.now()` at a 10,000-truck fleet (apply it
via Settings). It must stay under 8 ms. Log it through `debug.lastPickMs`.

**Verify.** Extend `verify-director.mjs`:
- `forceShot(type)` for each type, asserting either that a candidate was
  used (subject set, caption eyebrow matches the type) or a documented
  graceful fallback when there's no candidate:
  - **weather:** returns "unavailable" when `settings.showWeather` is false.
    Test it both ways; turn weather on via Settings Apply.
  - **lone:** only qualifies at night. Set `state.gameSeconds` to ~02:00 at
    boot. Sky darkness depends on world x (time zones), so pick a candidate
    whose x is dark.
- Over 30 forced auto-picks, no type appears twice consecutively (unless
  it's the only one available), and the frequency roughly tracks the
  weights.
- A screenshot of each shot type. Look at every one.

---

## Phase 5: Long-exposure light trails

**Why not the "translucent black fill instead of clearRect" trick:** every
frame repaints the whole background (`ctx.drawImage(bgCanvas, …)` ≈
render.js:1584). A translucent veil would either get painted over or smear
the map itself. The alternative, an accumulation canvas faded with
`destination-out`, leaves permanent ghost pixels, because 8-bit alpha stops
decreasing once a tiny per-frame decrement rounds to zero.

**Instead: ring-buffer polylines in world space.** They're clean, bounded,
and have no residue.

- **When:** `renderOpts.lightTrails === true`, meaning the director is in the
  SHOT phase of a **static** shot (Bottleneck, Interchange) and
  `settings.showLightTrails`, AND drawFrame's own `darkAtMid > 0.22`, the
  same darkness gate as headlights.
- **Storage (render.js module level, uniquely named):** a
  `Map<truck, {buf: Float32Array(DIR_TRAIL_SAMPLES*2), head, count, lastSampleMs}>`.
  - Sample a truck's world position every `TRAIL_SAMPLE_MS = 50` of real
    time: 60 samples is 3 s of trail, independent of frame rate.
  - Only visible, moving trucks; cap at 600 tracked.
  - Clear the whole map the frame `lightTrails` turns false.
  - Evict trucks not seen for 2 s.
- **Draw:** after the headlight pass, before the dots,
  `globalCompositeOperation = "lighter"`.
  - Split each trail into 4 age bands with alphas 0.10 / 0.22 / 0.40 / 0.70
    (oldest → newest). Stroke **one path per band per color**, so 8 strokes
    total regardless of truck count.
  - Line width `2 / camera.zoom`.
  - Color by screen direction to mimic the classic highway photo: trucks
    moving **down-screen** (`forward.y > 0`) get warm white
    `rgba(255,226,180,a)`; **up-screen** trucks get tail red
    `rgba(255,70,55,a)`.
- **Setting:** `showLightTrails: true` plus a "Long-Exposure Light Trails"
  switch, wired like 1c.
- **Verify:** force a night Interchange or Bottleneck shot. After 3 s,
  `drawFrame` reports `trailsTracked > 0`. After the shot ends, it reports
  0. Take a night screenshot mid-shot and **look at it**: continuous
  streaks, no dotted gaps, no ghosting after the shot. Also measure FPS
  with trails on vs off on the same shot (`#fps-counter`, sampled over
  5 s). Report both. It should drop by less than 10%.

---

## Phase 6: Polish, performance, publish

- Tune the Appendix C constants by watching 3–4 minutes of director mode:
  shot lengths, pull-back feel, apex hold, flight speed. Change only the
  constants.
- Perf: at 10,000 trucks, compare FPS with director inactive vs active
  (steady-state shot) over 10 s each. Director overhead should be under
  5%.
- Edge cases to test deliberately:
  - window resize mid-flight (recompute the country zoom)
  - a fleet of 10 trucks (Interchange-only fallback, must not throw)
  - sim speed 8× (shots still readable; subjects may arrive and end shots
    early, which is fine)
  - wake mid-APEX
  - wake mid-veil
  - start from FOLLOW_NAV
- Run the full definition of done. Publish. Write the user a short summary
  covering what to watch for, the three new settings, and anything cut or
  changed.

---

## Appendix A: Flight math (van Wijk & Nuij smooth zoom-pan)

This is the same math as d3's `interpolateZoom` and the Google Maps
fly-to. `w` = viewport width in world units. `ρ = √2`.

```
flightPath(p0 = {x:x0, y:y0, w:w0}, p1 = {x:x1, y:y1, w:w1}):
  dx = x1-x0; dy = y1-y0; d2 = dx*dx + dy*dy
  if d2 < 1e-12:                            // same point: pure zoom
    S = ln(w1/w0) / ρ
    at(t) = { x: x0 + t*dx, y: y0 + t*dy, w: w0 * exp(ρ * t * S) }
  else:
    d1 = sqrt(d2)
    b0 = (w1² - w0² + ρ⁴·d2) / (2·w0·ρ²·d1)
    b1 = (w1² - w0² - ρ⁴·d2) / (2·w1·ρ²·d1)
    r0 = -asinh(b0)          // == ln(sqrt(b0²+1) - b0), but numerically stable
    r1 = -asinh(b1)
    S  = (r1 - r0) / ρ
    at(t):
      s = t * S
      u = (w0 / (ρ²·d1)) * (cosh(r0)·tanh(ρ·s + r0) - sinh(r0))
      return { x: x0 + u*dx, y: y0 + u*dy, w: w0 * cosh(r0) / cosh(ρ·s + r0) }
  return { at, S }
```

- Drive `t` with `flightEase(elapsed / duration)`, where
  `duration = flightDurationMs(S)`. `S` can be negative for a pure zoom-in,
  hence the `|S|`.
- Convert back with `zoom = canvas.clientWidth / w`.
- **Long hop:** leg A goes to the country view, then the APEX hold, then leg
  B. Both legs are separate `flightPath`s.
- **Short hop:** one leg. The formula already pulls out somewhat on its own
  for medium distances.

---

## Appendix B: Shot catalog

**Director tally.** Run once per pick. Typed arrays sized
`edgeList.edges.length`, allocated once inside the closure. For each truck
with `edge && !parkedAt && !(disabledHoursLeft > 0) && !arrivalBraking`:
- `idx = edgeList.indexByEdge.get(truck.edge)`
- `dir = edgeList.directionByEdge.get(truck.edge)`
- per direction: `count++` and `slow += max(0, 1 - speed/freeFlowSpeed)`

These exclusions mirror render.js's `tallyCongestion`. **Don't call
`tallyCongestion` itself.** It advances a real-time smoothing EMA, so extra
calls would distort the heat map, and it only runs when congestion display
is on.

For thresholds, **export** `CONGESTION_BANDS` from render.js and import it.
Don't duplicate the numbers.

| Shot | Candidates | Pick | Framing | Zoom | Length | Caption (eyebrow / line) |
|---|---|---|---|---|---|---|
| **Bottleneck** | Segment directions with `count ≥ CONGESTION_BANDS[1].minTrucks` and `avgSlow ≥ CONGESTION_BANDS[1].slowdown` | Max `count × avgSlow` | **Static.** Center on the centroid of that direction's slow trucks (a second pass over trucks for that idx only). Hold perfectly still. Light trails at night. | Fit the slow trucks' bbox × 1.5, clamp [1.4, 3.0] | 16 s | `GRIDLOCK` / `{n} trucks crawling · I-80 W near Chicago` |
| **Convoy** | Drafting trucks with valid `draftLeader` (same edge). Walk leaders up to a root: ≤12 steps, cycle guard. | Root with the most drafters (≥1) | **Anticipatory follow** of the root. Offset the target *backward* by half the chain extent so the whole line is framed. **Pull-back** over the last 14 s. Tethers fade out automatically as zoom drops. | Fit the chain extent × 1.6, clamp [1.8, 3.4] → pull-back to 0.55 | 20 s | `CONVOY` / `{n}-truck draft line · I-40 E near Amarillo` |
| **Weather** | `settings.showWeather` on. Per cell, count moving trucks within `0.8 r`. | Cell with most trucks (≥3); subject = moving truck in that cell nearest its center, interstate preferred | **Anticipatory follow**, then **pull-back** to reveal the storm system | 1.6 → `clamp(clientWidth / (cell.r*2.4), 0.3, 1.2)` | 20 s | `SNOW` or `RAINSTORM` (cell.kind) / `{truck.name} pushing through · I-90 W near Billings` |
| **Lone Hauler** | Moving truck at speed ≥ 45 mph where: `effectiveDarkness(rawDarknessAtX(x, gameSeconds), timeScale) ≥ 0.3` (above the headlight gate); its segment's total count (both directions) is 1; segment length ≥ 60 world units; nearest `t>0` city ≥ 80 units away | Random among qualifiers | **Anticipatory follow**, no pull-back (zen) | 3.0 | 18 s | `LONE HAULER` / `{truck.name} · {cargo} · I-10 W near Van Horn` |
| **Interchange** | Nodes with `graph.adjacency[name].length ≥ 4`. Score = degree × (1 + sum of counts on touching segments / 10). | Random among the top 10, minus cooldown | **Static** at the node. Light trails at night. | 2.2 | 14 s | `INTERCHANGE` / `{City} · {deg} routes meet`. For an unnamed junction (`t === 0`): `Junction near {nearest city}` |

**Anticipatory follow, per frame:**
- `pose = truckPose(graph, truck, scratch, false)` (no jitter, same as
  main.js's follow camera)
- `fwd = (sin h, −cos h)`, with `h` in radians from `pose.heading` (degrees)
- `lead = DIR_LOOKAHEAD_FRAC * (clientWidth / zoom)`
- Ease a stored offset vector toward `fwd * lead` at 0.03 per frame so
  turns don't whip the camera.
- `camera.x += (pose.x + off.x - camera.x) * 0.08`, and the same for y.

**Pull-back:** `zoom = z0 * (z1/z0) ^ easeInOutSine(u)`, where `u` is
progress through the pull-back window. Interpolating in log space keeps the
zoom *speed* feeling constant.

**Destination pin** (APEX + first 60% of leg B):
`renderOpts.marker = {x, y, pulse}`. drawFrame draws an amber ring of
screen radius `(8 + 6·pulse) px`, i.e. `/ camera.zoom` in world units,
`lineWidth 2/zoom`, after the dots.

---

## Appendix C: Tunables (top of director.js)

| Constant | Start value | Meaning |
|---|---|---|
| `DIR_LONG_HOP_WORLD` | 900 | Hop distance (world units) above which we go via the country view |
| `DIR_APEX_HOLD_MS` | 900 | Pause at country view with pin + caption |
| `FLIGHT_MS_PER_S` / `FLIGHT_MIN_MS` / `FLIGHT_MAX_MS` | 800 / 1100 / 2600 | Per-leg flight duration mapping (in flight.js) |
| `DIR_LOOKAHEAD_FRAC` | 0.2 | Fraction of viewport width the camera leads the truck |
| `DIR_PULLBACK_S` | 14 | Pull-back window at the end of Convoy/Weather shots |
| `DIR_CANDIDATE_COOLDOWN_MS` | 600000 | Don't reuse a truck/segment/node for 10 min |
| `DIR_CAPTION_IN_DELAY_MS` | 800 | After landing (short hops); on long hops the caption shows at APEX |
| `DIR_CAPTION_OUT_LEAD_MS` | 1200 | Caption fades out this long before the shot ends |
| `DIR_TRAIL_SAMPLES` | 60 | Light-trail length at 50 ms sampling (3 s) |

---

## Appendix D: Test hooks (`director.debug`)

- `forceShot(type, {longHop})`: picks that type now. Returns `"ok"` or
  `"unavailable"`. `longHop: true` forces the country-view route.
- `setIdleMs(ms)`: overrides the idle threshold for tests.
- `snapshot()`: returns `{ phase, shotType, subjectId, caption: {eyebrow, line}, lastPickMs }`.
- `countryZoom()`

---

## Appendix E: Environment quirks (read before writing tests)

- **Google Fonts is blocked in the sandbox.** Expect repeated
  `ERR_CONNECTION` console errors and ~10 s slower page loads. Filter them
  out; smoke.mjs already does. They are not bugs.
- **Chromium crashes after ~6 heavy page loads in one browser process.**
  Symptom: `Target page, context or browser has been closed` on the next
  `goto`. Launch a fresh browser per section instead of reusing one.
  Launching is cheap.
- **Clicks at the bottom of a long bottom-sheet tab** can fail
  "outside of viewport" even with `force: true`. For logic assertions, use
  `page.evaluate(() => el.click())`. Screenshot-based checks still use real
  clicks where the point is touch targeting.
- **Probabilistic tests:** anything depending on the random sim (drafters,
  jams, weather) must retry or force conditions, and must pass 3/3 runs.
  An earlier test "passed" for months only because an unrelated log line
  happened to fire in its window. Assert the actual cause, not a side
  effect.
- **The container can reset between sessions.** Only committed files
  survive. Commit test scripts with the phase that adds them.
- **Commit messages:** no model names or IDs. Attribution trailer lines are
  given by the session's system reminder.
