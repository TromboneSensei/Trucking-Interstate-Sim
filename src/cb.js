// cb.js - the CB radio: a live chatter feed over the map, in the spirit of
// a Twitch chat scroll. Two things feed it, and keeping them separate is
// the whole design:
//
//   1. REAL EVENTS pushed out of the simulation (fleet.js's event queue) -
//      breakdowns and dry tanks. These are the signal. A breakdown is the
//      one thing in this sim you actually lose money to while not
//      watching, so it outranks everything and is allowed to break the
//      ambient rate limit. (A completed delivery is deliberately NOT one
//      of these - "another one in the book" chatter for every one of
//      hundreds of daily deliveries added nothing and crowded out
//      everything more interesting.)
//   2. AMBIENT FLAVOR generated here on a timer from whichever trucks are
//      currently on screen - weather, scenery, truck stops, road banter.
//      This is the noise, and it exists purely to make a screenful of
//      moving dots feel inhabited.
//
// Everything is throttled against the camera: zoomed out to the whole
// country there are thousands of eligible trucks and a message every
// couple of seconds would be meaningless wallpaper, so the feed slows
// right down and holds only a few lines. Zoomed into one corridor the
// same feed tightens up, because now it's reporting on trucks you can
// actually see.
//
// The DOM is deliberately the render target rather than the canvas: this
// is text that needs to wrap, fade and stack, all of which CSS already
// does, and it costs nothing per frame when nothing is being said.
import { truckWorldPos } from "./render.js";
import { travelDirectionLabel, localMinutesAtX } from "./geo.js";
import { weatherSpeedMultAt } from "./weather.js";

// Higher wins. CRITICAL jumps the queue and bypasses the ambient rate
// limit (subject only to its own much shorter floor); FLAVOR is the
// filler that gets dropped first whenever the queue is over budget.
export const CB_PRIORITY = { FLAVOR: 0, ROUTINE: 1, ALERT: 2, CRITICAL: 3 };

// ---------------------------------------------------------------------
// Every knob worth turning, in one object. The mix of "mechanical
// failures I must not miss" against "trucker banter that makes the map
// feel alive" is set here and nowhere else.
// ---------------------------------------------------------------------
export const CB_TUNING = {
  // --- pacing, interpolated between fully zoomed out (…Out) and zoomed
  // in on a corridor (…In). See cbZoomT: 0 = whole country, 1 = corridor.
  flavorIntervalMsOut: 5000, // one ambient line per this long, zoomed out
  flavorIntervalMsIn: 2500,
  maxVisibleOut: 3, // hard cap on lines on screen at once
  maxVisibleIn: 6,
  lifetimeMsOut: 9000, // how long a line stays before fading
  lifetimeMsIn: 14000,
  // How far in you have to zoom before the "In" ends of those ranges
  // apply, as a multiple of the fit-the-country zoom.
  zoomRatioForFullDetail: 6,

  // --- priority behaviour
  // Minimum gap between any two lines, per priority. CRITICAL's is short
  // on purpose: it's what lets a run of breakdowns come through in a
  // burst instead of trickling out behind ambient chatter.
  minGapMs: { 0: 900, 1: 900, 2: 500, 3: 260 },
  // Pending lines never queue deeper than this; over budget, the
  // lowest-priority oldest entries are dropped rather than delaying
  // anything important behind stale banter.
  queueCap: 12,
  // A queued line older than this is thrown away rather than shown. The
  // feed reports on what is happening NOW; a jam/flavor line that only
  // just reached the front of the queue after sitting eight seconds
  // behind a backlog is stale enough to be misleading. Critical alerts
  // are exempt - a breakdown is still a breakdown whenever you read it.
  staleMs: 3500,
  // A breakdown off the edge of the screen still matters - you can't
  // watch the whole country at once, and missing mechanical failures is
  // the exact thing this feed exists to prevent. Flip this to true to
  // make critical alerts obey the viewport like everything else.
  criticalRespectsViewport: false,

  // --- content mix
  // Traffic-jam alerts, detected from trucks running far below their own
  // free-flow speed (see cbFindJam) - covers both "everyone's just slow
  // here" and a disabled truck causing a rubberneck backup; the line bank
  // itself speculates about a breakdown/wreck rather than the code ever
  // confirming one, same as real CB chatter. Rate-limited hard - a jam
  // persists for a while and doesn't need re-reporting every few seconds.
  jamMinGapMs: 14000,
  jamSlowdownFraction: 0.45, // below this share of free-flow speed counts as stuck
  // Relative odds of each ambient category. Set any of these to 0 to
  // switch that flavor off entirely; raise `traffic` and drop `nature`
  // for a drier, more operational feed.
  flavorWeights: {
    nature: 3,
    weather: 3, // only eligible when the truck is actually inside a weather cell
    night: 2, // only eligible when it's actually dark where the truck is
    landmark: 3,
    coffee: 2,
    traffic: 2,
    smalltalk: 2,
    cargo: 2,
    police: 2, // ambient "bear" sighting - flavor, not a real enforcement mechanic
    firstVisit: 4, // only eligible the first time THIS truck passes THIS city - see cbVisited
  },
  // How many random trucks to test for on-screen-ness before giving up on
  // finding a speaker this tick. Caps the cost at a fixed few dozen
  // regardless of fleet size - never a scan of all 10000.
  speakerSampleAttempts: 40,
  // How soon to re-try after a sample turns up no on-screen speaker.
  flavorRetryMs: 400,
  // How many cities cbVisited remembers per truck before forgetting its
  // oldest one - a long-lived truck passes through far more control
  // cities over a session than are worth holding onto just to gate one
  // flavor line, so this stays a rolling window rather than full history.
  visitedMemory: 16,
};

// ---------------------------------------------------------------------
// Phrase banks. Placeholders are filled from the speaking truck's real
// position: {route} its highway, {dir} its heading, {near} the control
// city it's running toward, {cargo} what's in the trailer, {type} the
// trailer kind. Lines that name a place read as local because they ARE
// local - the sim already knows all of this per truck.
// ---------------------------------------------------------------------
const CB_LINES = {
  nature: [
    "Sun's coming up over {near}, prettiest office in the world.",
    "Whole valley's gone gold out here on {route}. Wish you could see it.",
    "Deer standing right on the shoulder near {near}. Easy on the hammer, boys.",
    "Sky's doing something ridiculous west of {near} right now.",
    "Hawk's been riding my mirror the last ten miles on {route}.",
    "Ain't a cloud between me and {near}. Good day to be rolling.",
    "Leaves turning all the way down {route}. Beats a windshield full of city.",
  ],
  weather: [
    "Rain's coming down sideways on {route}, easy does it {dir}bound.",
    "Visibility's about a truck length out here near {near}. Slow it down.",
    "Wind's pushing me around on {route}. Watch it if you're running empty.",
    "It's slick as glass on {route} coming into {near}.",
    "Wipers on high since {near} and losing that fight.",
    "Whatever this mess is, it's sitting right over {near}.",
  ],
  night: [
    "Nothing out here but me and the mile markers on {route}.",
    "Quiet as a church on {route} this time of night.",
    "Just me, {cargo}, and the white line into {near}.",
    "Moon's lighting up the whole road ahead of {near}.",
    "Third cup since dark and {near} still ain't any closer.",
  ],
  landmark: [
    "Rolling past {near}. Same water tower, same rust.",
    "{near} is looking about how you'd expect.",
    "Passing that big sign outside {near} again. Somebody repaint it already.",
    "Scales looked open coming into {near}, just so you know.",
    "Bridge work's still up on {route} near {near}.",
    "Made {near} sooner than the book said. Take that, dispatch.",
  ],
  coffee: [
    "Truck stop outside {near} has the only decent coffee on {route}.",
    "Pie's still good at that place off {route} near {near}. Trust me.",
    "Anybody got a lot with open parking near {near}? Getting tight.",
    "Showers were clean at the stop before {near}. Miracle.",
    "Two dollars for a refill outside {near}. Highway robbery, appropriately.",
    "Fueled up near {near}. Wallet's lighter, tank ain't.",
  ],
  traffic: [
    "Four-wheelers everywhere on {route} {dir}. Keep your following distance.",
    "Somebody in a hurry just cut me clean off near {near}.",
    "Left lane's been blocked for six miles on {route}. Cute.",
    "Rolling roadblock up ahead on {route}, two abreast doing the limit.",
    "Traffic's stacking up coming into {near}. Might want to plan around it.",
    "Whole convoy of us running {route} {dir} right now. Looks good in the mirror.",
  ],
  smalltalk: [
    "Breaker one-nine, anybody got their ears on around {near}?",
    "Radio check on {route}. Anybody copy?",
    "How's the road looking ahead of {near}?",
    "Ten-four, catch you on the flip side.",
    "Dispatch is quiet today. Suspicious.",
    "That's a big ten-four from {route}.",
  ],
  cargo: [
    "Hauling {cargo} up {route}. Pays the same as the boring stuff.",
    "Got {cargo} on the {type} and a long way to {near} yet.",
    "Whoever loaded this {cargo} owes me an alignment.",
    "{cargo} bound for {near}. Nice and easy does it.",
    "Riding heavy with {cargo} on {route}. She's pulling fine.",
  ],
  police: [
    "Bear in the air near {near}, watch your speed on {route}.",
    "Smokey's got somebody pulled over outside {near}.",
    "County mountie sitting in the median before {near}. Ten-four on that.",
    "Bear's running radar on {route} {dir}. Ease off.",
    "Full grown bear parked past the {near} exit. Y'all be careful.",
  ],
  // Generic - fires the first time THIS truck passes THIS city, no
  // specific claim about what's there (see cbCityFlavor for the handful
  // of cities that get a real one instead).
  firstVisitGeneric: [
    "First time rolling through {near}. Not bad at all.",
    "Never been to {near} before. Bigger than I figured.",
    "New to me, this stretch by {near}. Kinda like it.",
    "First trip out this way. {near}'s alright.",
    "Ain't never hauled through {near} till today.",
    "Dispatch finally sent me somewhere new - {near}, if you're wondering.",
  ],
};

// A handful of well-known cities get a real, specific line instead of the
// generic first-visit filler above - the rest of the ~150-city graph
// falls back to firstVisitGeneric rather than inventing a landmark for
// somewhere that may not have one worth naming.
const CB_CITY_FLAVOR = {
  "St. Louis": "First time in St. Louis. That Arch is something else.",
  "Chicago": "First time in Chicago. Skyline hits different in person.",
  "New York": "First time anywhere near New York. Traffic's exactly as advertised.",
  "Las Vegas": "First time through Vegas. Whole city's lit up even in daylight.",
  "Nashville": "First time in Nashville. Somebody's always playing guitar somewhere.",
  "New Orleans": "First time in New Orleans. Air smells different down here.",
  "Miami": "First time in Miami. Never seen so much pink on one building.",
  "Seattle": "First time in Seattle. That needle thing is taller than it looks.",
  "Boston": "First time in Boston. These drivers are something else.",
  "Philadelphia": "First time in Philadelphia. Gonna have to try a cheesesteak.",
  "Detroit": "First time in Detroit. Rougher and prouder than I expected.",
  "San Francisco": "First time in San Francisco. These hills are no joke in a rig.",
  "Los Angeles": "First time in Los Angeles. Traffic never actually stops here, huh.",
  "Denver": "First time in Denver. Mountains just show up out of nowhere.",
  "Washington": "First time in Washington. All the buildings look important.",
  "Salt Lake City": "First time in Salt Lake City. Those mountains don't quit.",
  "Phoenix": "First time in Phoenix. Didn't know heat could look shimmery like that.",
};

// Real-event lines. Same placeholder rules; {handle} is the truck name.
const CB_EVENT_LINES = {
  BREAKDOWN: [
    "Mayday, I'm dead in the water on {route} {dir} near {near}. Something let go.",
    "Well, that's the end of that. Broke down on {route} outside {near}.",
    "Got smoke and no power on {route} near {near}. Sitting on the shoulder.",
    "She quit on me on {route} coming into {near}. Rolling nowhere.",
  ],
  DRY_TANK: [
    "Ran her dry on {route} near {near}. Don't laugh, just send fuel.",
    "Out of go-juice on {route} outside {near}. Rookie mistake.",
    "Sitting on empty on {route} near {near}. This one's on me.",
    "Tank's dry on {route} {dir} near {near}. Waiting on the fuel truck.",
  ],
  JAM: [
    "We're stacked up solid on {route} {dir} coming into {near}. Find another way.",
    "Parking lot on {route} near {near}. Been in third gear for a while now.",
    "Heavy traffic on {route} {dir} outside {near}, barely rolling.",
    "Whatever's ahead of us on {route} near {near}, it ain't moving.",
    "Something's got us backed up on {route} near {near} - looks like somebody's broke down up there.",
    "Dead stop on {route} {dir} near {near}. Smells like a breakdown or a wreck, one of the two.",
    "Word back here is there's a truck sitting sideways somewhere ahead on {route}. That'll do it.",
  ],
};

// ---------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------
let cbContainer = null;
let cbQueue = []; // pending lines, highest priority first (see cbEnqueue)
let cbLive = []; // { node, expiresAt, removeAt } for what's on screen
let cbLastEmitMs = 0;
let cbLastFlavorMs = 0;
let cbLastJamMs = 0;
const cbScratchPos = { x: 0, y: 0 };

// Per-truck rolling memory of which control cities it's already passed,
// keyed by the truck object itself so a torn-down fleet's entries are
// simply unreachable garbage rather than something resetCB has to walk
// and clear. Capped per truck (see CB_TUNING.visitedMemory) - a "first
// time here" line only needs to know whether THIS truck has been through
// THIS city recently, not hold its entire lifetime route.
const cbVisited = new WeakMap();

function cbMarkVisited(truck, city) {
  let set = cbVisited.get(truck);
  if (!set) { set = new Set(); cbVisited.set(truck, set); }
  if (set.has(city)) return;
  set.add(city);
  if (set.size > CB_TUNING.visitedMemory) set.delete(set.values().next().value);
}

function cbHasVisited(truck, city) {
  const set = cbVisited.get(truck);
  return !!set && set.has(city);
}

export function initCB(containerEl) {
  cbContainer = containerEl;
}

// Wipes the feed - queue, DOM and timers. Called whenever the sim is torn
// down and rebuilt, since every queued line holds a reference to a truck
// from the fleet that just stopped existing.
export function resetCB() {
  cbQueue.length = 0;
  for (const m of cbLive) m.node.remove();
  cbLive.length = 0;
  cbLastEmitMs = 0;
  cbLastFlavorMs = 0;
  cbLastJamMs = 0;
  if (cbContainer) cbContainer.innerHTML = "";
}

// 0 when the whole country is in frame, 1 once zoomed into a corridor.
// Everything rate-related is a lerp along this.
function cbZoomT(camera) {
  const base = camera.baseZoom || camera.zoom || 1;
  const ratio = camera.zoom / base;
  const span = Math.max(1e-6, CB_TUNING.zoomRatioForFullDetail - 1);
  return Math.max(0, Math.min(1, (ratio - 1) / span));
}

function cbLerp(a, b, t) {
  return a + (b - a) * t;
}

function cbPick(arr, rnd = Math.random) {
  return arr[Math.floor(rnd() * arr.length)];
}

// "I-75" / "US 287" - the same shield-ish shortening the dispatch panels
// use, kept local so this module doesn't reach into the UI layer.
function cbRouteLabel(route) {
  return route ? route.replace("US-", "US ").replace(" (West)", "").replace(" (East)", "") : "the slab";
}

// Everything a line might want to name about where this truck is right
// now. Returns null for a truck with no meaningful position (mid-
// transition between edges), which simply doesn't get to speak this tick.
function cbPlaceContext(graph, truck) {
  const type = truck.contract ? truck.contract.truckType : null;
  const base = {
    handle: truck.name,
    cargo: truck.contract ? truck.contract.cargo : "freight",
    type: type ? type.label.toLowerCase() : "trailer",
    color: type ? type.color : "#e8ecef",
  };
  if (truck.edge) {
    base.route = cbRouteLabel(truck.edge.route);
    base.dir = travelDirectionLabel(truck.edge);
    base.near = truck.edge.control || truck.edge.to;
    return base;
  }
  if (truck.parkedAt) {
    base.route = "the yard";
    base.dir = "";
    base.near = truck.parkedAt;
    return base;
  }
  return null;
}

function cbFormat(template, place) {
  return template.replace(/\{(\w+)\}/g, (_, key) => (place[key] != null ? place[key] : ""));
}

// ---------------------------------------------------------------------
// Viewport gating
// ---------------------------------------------------------------------
// `viewport` is the world-space box drawFrame already computed for its own
// culling this frame, handed straight back to us - so "on screen" here
// means exactly what it means to the renderer, with no second, subtly
// different copy of the camera math to drift out of sync.
function cbIsVisible(graph, truck, viewport) {
  if (!viewport) return true;
  truckWorldPos(graph, truck, cbScratchPos);
  return (
    cbScratchPos.x >= viewport.minX && cbScratchPos.x <= viewport.maxX &&
    cbScratchPos.y >= viewport.minY && cbScratchPos.y <= viewport.maxY
  );
}

// Finds a truck that's both on screen and in a state worth talking from,
// by random sampling rather than scanning - at 10000 trucks a full filter
// pass every few seconds would cost more than everything else this module
// does put together.
function cbFindSpeaker(graph, trucks, viewport) {
  if (!trucks.length) return null;
  for (let i = 0; i < CB_TUNING.speakerSampleAttempts; i++) {
    const truck = trucks[Math.floor(Math.random() * trucks.length)];
    // A truck sitting broken down has its own (critical) line already;
    // don't let it also chat about the scenery. Parked trucks are skipped
    // too: every ambient line names the road it's rolling on, and a truck
    // at a dock has no route or heading to put in one.
    if (truck.disabledHoursLeft > 0) continue;
    if (!truck.edge) continue;
    if (!cbIsVisible(graph, truck, viewport)) continue;
    return truck;
  }
  return null;
}

// A visible truck that's genuinely stuck - well under the speed it would
// be doing on an open road, and not merely braking for its own exit.
// `freeFlowSpeed` is captured by fleet.js before rush hour, rubbernecking
// and car-following are applied, so this is the same "is it congestion?"
// question the map's heat overlay asks, just per truck.
function cbFindJam(graph, trucks, viewport) {
  if (!trucks.length) return null;
  for (let i = 0; i < CB_TUNING.speakerSampleAttempts; i++) {
    const truck = trucks[Math.floor(Math.random() * trucks.length)];
    if (!truck.edge || truck.disabledHoursLeft > 0 || truck.arrivalBraking) continue;
    if (!(truck.freeFlowSpeed > 0)) continue;
    if (truck.speed / truck.freeFlowSpeed > CB_TUNING.jamSlowdownFraction) continue;
    if (!cbIsVisible(graph, truck, viewport)) continue;
    return truck;
  }
  return null;
}

// ---------------------------------------------------------------------
// Ambient flavor
// ---------------------------------------------------------------------
// Which categories this particular truck, here, right now, could
// plausibly say something from. Weather lines need actual weather; night
// lines need actual night. Gating them on the real simulation state is
// what keeps the banter feeling local rather than random.
function cbEligibleCategories(graph, truck, cbCtx, place) {
  const weights = CB_TUNING.flavorWeights;
  const out = [];
  let total = 0;
  const add = (name) => {
    const w = weights[name] || 0;
    if (w > 0) { out.push({ name, w }); total += w; }
  };

  add("nature");
  add("landmark");
  add("coffee");
  add("traffic");
  add("smalltalk");
  add("cargo");
  add("police");

  if (cbCtx.showWeather && cbCtx.weather && truck.edge) {
    truckWorldPos(graph, truck, cbScratchPos);
    // < 1 means this truck is inside a cell and being slowed by it.
    if (weatherSpeedMultAt(cbCtx.weather, cbScratchPos.x, cbScratchPos.y) < 0.999) add("weather");
  }
  if (truck.edge) {
    truckWorldPos(graph, truck, cbScratchPos);
    const mins = localMinutesAtX(cbScratchPos.x, cbCtx.gameSeconds);
    if (mins >= 21 * 60 || mins < 5 * 60) add("night");
  }
  // Only a candidate the first time THIS truck has been seen near THIS
  // control city - see cbVisited. `near` is a real city name whenever
  // truck.edge is set (cbPlaceContext), which cbMakeFlavor has already
  // confirmed before calling here.
  if (!cbHasVisited(truck, place.near)) add("firstVisit");

  return { out, total };
}

function cbMakeFlavor(graph, truck, cbCtx) {
  const place = cbPlaceContext(graph, truck);
  if (!place) return null;
  const { out, total } = cbEligibleCategories(graph, truck, cbCtx, place);
  if (!total) return null;

  let roll = Math.random() * total;
  let category = out[out.length - 1].name;
  for (const entry of out) {
    roll -= entry.w;
    if (roll <= 0) { category = entry.name; break; }
  }

  if (category === "firstVisit") {
    // Only actually marked visited once the line is spoken - a truck
    // that was eligible but landed on a different category this tick
    // stays eligible to say it next time instead of silently losing the
    // moment.
    cbMarkVisited(truck, place.near);
    const specific = CB_CITY_FLAVOR[place.near];
    return { priority: CB_PRIORITY.FLAVOR, handle: place.handle, color: place.color, text: specific || cbFormat(cbPick(CB_LINES.firstVisitGeneric), place) };
  }
  return {
    priority: CB_PRIORITY.FLAVOR,
    handle: place.handle,
    color: place.color,
    text: cbFormat(cbPick(CB_LINES[category]), place),
  };
}

// ---------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------
// Sorted insert, highest priority first, FIFO within a priority. Over
// budget, the tail (oldest of the lowest priority present) is what goes -
// so a flood of breakdowns pushes banter out rather than the reverse.
function cbEnqueue(msg, nowMs) {
  msg.queuedAt = nowMs;
  let i = cbQueue.length;
  while (i > 0 && cbQueue[i - 1].priority < msg.priority) i--;
  cbQueue.splice(i, 0, msg);
  if (cbQueue.length > CB_TUNING.queueCap) cbQueue.length = CB_TUNING.queueCap;
}

// Turns one simulation event (BREAKDOWN or DRY_TANK - the only kinds
// fleet.js emits) into a queued critical line.
function cbIngestEvent(graph, evt, viewport, nowMs) {
  const truck = evt.truck;
  if (!truck) return;
  const bank = CB_EVENT_LINES[evt.kind];
  if (!bank) return;
  if (CB_TUNING.criticalRespectsViewport && !cbIsVisible(graph, truck, viewport)) return;

  const place = cbPlaceContext(graph, truck);
  if (!place) return;
  cbEnqueue({
    priority: CB_PRIORITY.CRITICAL,
    handle: place.handle,
    color: place.color,
    text: cbFormat(cbPick(bank), place),
    critical: true,
  }, nowMs);
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------
function cbRender(msg, nowMs, lifetimeMs) {
  const node = document.createElement("div");
  node.className = msg.critical ? "cb-msg cb-critical" : "cb-msg";

  const handle = document.createElement("span");
  handle.className = "cb-handle";
  handle.style.color = msg.color;
  handle.textContent = msg.handle + ":";

  const text = document.createElement("span");
  text.className = "cb-text";
  text.textContent = " " + msg.text;

  node.appendChild(handle);
  node.appendChild(text);
  cbContainer.appendChild(node);
  // A critical alert holds twice as long - it's the one you might have
  // looked away from.
  const life = msg.critical ? lifetimeMs * 2 : lifetimeMs;
  cbLive.push({ node, expiresAt: nowMs + life, removeAt: 0 });
}

// Fades out anything past its lifetime, drops anything past its fade, and
// trims the oldest lines whenever the zoom-derived cap has tightened.
function cbSweep(nowMs, maxVisible) {
  for (let i = cbLive.length - 1; i >= 0; i--) {
    const m = cbLive[i];
    if (m.removeAt) {
      if (nowMs >= m.removeAt) { m.node.remove(); cbLive.splice(i, 1); }
    } else if (nowMs >= m.expiresAt) {
      m.node.classList.add("cb-leaving");
      m.removeAt = nowMs + 400; // matches the CSS transition
    }
  }
  // Count only lines not already on their way out, so a burst doesn't
  // instantly evict the messages the user is mid-read of.
  let alive = 0;
  for (const m of cbLive) if (!m.removeAt) alive++;
  for (let i = 0; i < cbLive.length && alive > maxVisible; i++) {
    const m = cbLive[i];
    if (m.removeAt) continue;
    m.node.classList.add("cb-leaving");
    m.removeAt = nowMs + 400;
    alive--;
  }
}

// ---------------------------------------------------------------------
// Per-frame entry point
// ---------------------------------------------------------------------
// cbCtx: { enabled, graph, trucks, viewport, camera, gameSeconds, weather,
//          showWeather, events }
// `events` is whatever fleet.js emitted this tick (drained by main.js).
export function updateCB(nowMs, cbCtx) {
  if (!cbContainer) return;
  if (!cbCtx.enabled) {
    if (cbLive.length || cbQueue.length) resetCB();
    return;
  }

  const t = cbZoomT(cbCtx.camera);
  const maxVisible = Math.round(cbLerp(CB_TUNING.maxVisibleOut, CB_TUNING.maxVisibleIn, t));
  const lifetimeMs = cbLerp(CB_TUNING.lifetimeMsOut, CB_TUNING.lifetimeMsIn, t);
  const flavorInterval = cbLerp(CB_TUNING.flavorIntervalMsOut, CB_TUNING.flavorIntervalMsIn, t);

  // 1. Real events first - they're the reason this thing exists.
  if (cbCtx.events) {
    for (const evt of cbCtx.events) cbIngestEvent(cbCtx.graph, evt, cbCtx.viewport, nowMs);
  }

  // 2. Traffic-jam watch: a visible truck crawling well under its own
  // free-flow speed. Outranks banter and deliveries, but not a breakdown.
  if (nowMs - cbLastJamMs >= CB_TUNING.jamMinGapMs) {
    const stuck = cbFindJam(cbCtx.graph, cbCtx.trucks, cbCtx.viewport);
    if (stuck) {
      cbLastJamMs = nowMs;
      const place = cbPlaceContext(cbCtx.graph, stuck);
      if (place) {
        cbEnqueue({
          priority: CB_PRIORITY.ALERT,
          handle: place.handle,
          color: place.color,
          text: cbFormat(cbPick(CB_EVENT_LINES.JAM), place),
        }, nowMs);
      }
    }
  }

  // 3. Ambient filler, only when the timer says so and only from a truck
  // that's actually on screen.
  if (nowMs - cbLastFlavorMs >= flavorInterval) {
    const speaker = cbFindSpeaker(cbCtx.graph, cbCtx.trucks, cbCtx.viewport);
    const msg = speaker ? cbMakeFlavor(cbCtx.graph, speaker, cbCtx) : null;
    if (msg) {
      cbEnqueue(msg, nowMs);
      cbLastFlavorMs = nowMs;
    } else {
      // Zoomed right in there may be only a handful of trucks on screen,
      // so a random sample often finds nobody. Back off briefly and try
      // again rather than losing the whole interval to one miss - which
      // would make the feed go quietest exactly where it should be
      // busiest.
      cbLastFlavorMs = nowMs - flavorInterval + CB_TUNING.flavorRetryMs;
    }
  }

  // 4. Emit at most one line per frame, gated by that priority's own
  // floor. Because the queue is priority-sorted, a critical alert waiting
  // behind banter gets to use CRITICAL's much shorter gap immediately.
  // Anything that sat too long to still be true is dropped rather than
  // shown late (critical alerts excepted - see CB_TUNING.staleMs).
  while (cbQueue.length) {
    const next = cbQueue[0];
    if (!next.critical && nowMs - next.queuedAt > CB_TUNING.staleMs) { cbQueue.shift(); continue; }
    if (nowMs - cbLastEmitMs < CB_TUNING.minGapMs[next.priority]) break;
    cbQueue.shift();
    cbLastEmitMs = nowMs;
    cbRender(next, nowMs, lifetimeMs);
    break; // one line per frame, so a backlog still reads as a conversation
  }

  cbSweep(nowMs, maxVisible);
}
