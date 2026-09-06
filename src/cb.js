// cb.js - the CB radio: a live chatter feed, rendered as a scrollback log
// in its own tab of the bottom sheet. Two things feed it, and keeping them
// separate is the whole design:
//
//   1. REAL EVENTS pushed out of the simulation (fleet.js's event queue) -
//      breakdowns and dry tanks - plus two conditions this module measures
//      itself: a truck genuinely crawling below its own free-flow speed,
//      and a truck with a genuinely disabled rig on the road ahead of it.
//      These are the signal.
//   2. AMBIENT FLAVOR generated here on a timer - weather, scenery, truck
//      stops, road banter. This is the noise, and it exists purely to make
//      a screenful of moving dots feel inhabited.
//
// Two rules govern all of it:
//
//   EVERY SPEAKER IS ON SCREEN. The pool is exactly the trucks inside the
//   frame the renderer just culled to - no exceptions, not even for a
//   breakdown. Reading about Seattle while looking at St. Louis is noise
//   wearing the costume of information.
//
//   EVERY CLAIM IS TRUE. A truck that names a city has just driven through
//   it (see `passed` in cbPlaceContext); a truck that says it's stacked up
//   is measurably below its own free-flow speed; a truck that warns of a
//   breakdown ahead has one on its own edge within a few miles. Lines that
//   can't be backed by simulation state were rewritten until they only
//   claim things about the speaker's own cab.
//
// Everything is throttled against the camera. Zoomed into one corridor the
// feed tightens up and leans ambient, because it's reporting on trucks you
// can actually see. Zoomed out to the whole country every truck qualifies
// and the alerts would drown everything else, so the high-priority lines
// get a much longer floor and a streak limiter (see cbEmitStep) that
// forces banter back in between them.
//
// The DOM is the render target rather than the canvas: this is text that
// needs to wrap, scroll and be tapped, all of which the browser already
// does, and it costs nothing per frame when nothing is being said.
import { truckWorldPos } from "./render.js";
import { travelDirectionLabel, localMinutesAtX } from "./geo.js";
import { weatherSpeedMultAt } from "./weather.js";
import { disabledPositionsOnEdge } from "./fleet.js";

// Higher wins. CRITICAL and ALERT jump the queue; FLAVOR is the filler
// that gets dropped first whenever the queue is over budget.
export const CB_PRIORITY = { FLAVOR: 0, ROUTINE: 1, ALERT: 2, CRITICAL: 3 };

// ---------------------------------------------------------------------
// Every knob worth turning, in one object. The mix of "mechanical
// failures I must not miss" against "trucker banter that makes the map
// feel alive" is set here and nowhere else.
// ---------------------------------------------------------------------
export const CB_TUNING = {
  // --- pacing, interpolated between fully zoomed out (…Out) and zoomed
  // in on a corridor (…In). See cbZoomT: 0 = whole country, 1 = corridor.
  // How far in you have to zoom before the "In" ends apply, as a multiple
  // of the fit-the-country zoom.
  zoomRatioForFullDetail: 6,
  // Floor between any two lines, whatever they are. This is the single
  // knob for "the feed is too busy".
  globalGapMsOut: 3600,
  globalGapMsIn: 900,
  // How often to try to generate one ambient line.
  flavorIntervalMsOut: 5200,
  flavorIntervalMsIn: 2300,
  // Extra floors that apply only to the high-priority bands. Zoomed out,
  // ten thousand trucks produce a steady drip of breakdowns; without these
  // the feed would be nothing but red lines.
  alertGapMsOut: 8000,
  alertGapMsIn: 1600,
  criticalGapMsOut: 5200,
  criticalGapMsIn: 700,
  // …and a hard limit on how many high-priority lines may run back to
  // back. Once hit, the next line is forced to come from the ambient band
  // if one is waiting - this is what keeps "important" and "random" mixed
  // together nationwide instead of alternating between floods and silence.
  maxHighStreakOut: 1,
  maxHighStreakIn: 4,

  // --- queue
  queueCap: 12, // pending lines never queue deeper than this
  highQueueCap: 6, // …of which at most this many may be ALERT or above, so banter always has room
  // A queued line older than this is thrown away rather than shown. The
  // feed reports on what is happening NOW; a jam line that only just
  // reached the front after sitting eight seconds behind a backlog is
  // stale enough to be misleading. Critical alerts are exempt - a
  // breakdown is still a breakdown whenever you read it.
  staleMs: 3500,
  logCap: 40, // messages kept in the scrollback before the oldest is dropped

  // --- content mix
  jamMinGapMs: 14000, // a jam persists; it doesn't need re-reporting every few seconds
  jamSlowdownFraction: 0.45, // below this share of free-flow speed counts as stuck
  // How far back from a city a truck may still say it "just came through"
  // there. Capped at half the edge as well, so on a short hop the claim
  // expires before the truck is closer to the next town than the last.
  justPassedMiles: 45,
  // How far ahead a disabled truck has to be for a warning to be worth
  // giving - and, more to the point, close enough that the warning is
  // true of the road the speaker is actually on.
  breakdownAheadMiles: 12,
  // Relative odds of each ambient category. Set any of these to 0 to
  // switch that flavor off entirely; raise `traffic` and drop `nature`
  // for a drier, more operational feed.
  flavorWeights: {
    nature: 3,
    weather: 3, // only eligible when the truck is actually inside a weather cell
    night: 2, // only eligible when it's actually dark where the truck is
    landmark: 3, // only eligible when it has actually just passed a real town
    coffee: 2, // ditto - the truck stop it's talking about is behind it
    traffic: 2,
    smalltalk: 2,
    cargo: 2, // only eligible when it's actually running a contract
    police: 2, // ambient "bear" sighting - flavor, not a real enforcement mechanic
    firstVisit: 4, // only the first time THIS truck passes THIS city - see cbVisited
    breakdownAhead: 8, // only when there is genuinely a disabled rig ahead on this edge
  },
  // How many random trucks to test before giving up on finding a speaker
  // this tick. Caps the cost at a fixed few dozen regardless of fleet
  // size - never a scan of all 10000.
  speakerSampleAttempts: 40,
  // How soon to re-try after a sample turns up no on-screen speaker.
  flavorRetryMs: 400,
  // How many cities cbVisited remembers per truck before forgetting its
  // oldest one - a long-lived truck passes through far more towns over a
  // session than are worth holding onto just to gate one flavor line, so
  // this stays a rolling window rather than full history.
  visitedMemory: 16,
};

// ---------------------------------------------------------------------
// Phrase banks. Placeholders are filled from the speaking truck's real
// position:
//   {route}  its highway            {dir}    its heading
//   {ahead}  the control city it is signed toward (always true: it's on
//            the sign in front of the driver)
//   {passed} a real town it has just driven through - ONLY available to
//            categories gated on it, never a guess
//   {cargo}  what's in the trailer  {type}   the trailer kind
//   {dest}   where the load is going
// Nothing in here asserts a road condition the sim hasn't measured; the
// conditions that ARE measured live in CB_EVENT_LINES below.
// ---------------------------------------------------------------------
const CB_LINES = {
  nature: [
    "Sun's coming up out ahead of me on {route}. Prettiest office in the world.",
    "Whole valley's gone gold out here on {route}. Wish you could see it.",
    "Deer standing right on the shoulder up here on {route}. Easy on the hammer, boys.",
    "Sky's doing something ridiculous out my windshield on {route}.",
    "Hawk's been riding my mirror the last ten miles on {route}.",
    "Ain't a cloud between me and {ahead}. Good day to be rolling.",
    "Leaves turning all the way down {route}. Beats a windshield full of city.",
  ],
  weather: [
    "Rain's coming down sideways on {route}, easy does it {dir}bound.",
    "Visibility's about a truck length out here on {route}. Slow it down.",
    "Wind's pushing me around on {route}. Watch it if you're running empty.",
    "It's slick as glass on {route} headed for {ahead}.",
    "Wipers have been on high for an hour now and losing that fight.",
    "Whatever this mess is, it's sitting right on top of {route}.",
  ],
  night: [
    "Nothing out here but me and the mile markers on {route}.",
    "Quiet as a church on {route} this time of night.",
    "Just me, {cargo}, and the white line toward {ahead}.",
    "Moon's lighting up the whole road ahead of me on {route}.",
    "Third cup since dark and {ahead} still ain't any closer.",
  ],
  landmark: [
    "Just rolled through {passed}. Same water tower, same rust.",
    "{passed} is looking about how you'd expect.",
    "Passed that big sign outside {passed} again. Somebody repaint it already.",
    "Scales were open back through {passed}, just so you know.",
    "Made {passed} sooner than the book said. Take that, dispatch.",
    "Bridge work's still up on {route} back by {passed}.",
  ],
  coffee: [
    "Truck stop back in {passed} has the only decent coffee on {route}.",
    "Pie's still good at that place off {route} in {passed}. Trust me.",
    "Showers were clean at the stop in {passed}. Miracle.",
    "Two dollars for a refill back in {passed}. Highway robbery, appropriately.",
    "Grabbed a cup in {passed}. Wallet's lighter, I'm awake.",
  ],
  traffic: [
    "Four-wheelers everywhere on {route} {dir}. Keep your following distance.",
    "Somebody in a hurry just cut me clean off. Ten-four on that.",
    "Left lane's been coned off for six miles on {route}. Cute.",
    "Rolling roadblock up here on {route}, two abreast doing the limit.",
    "Whole convoy of us running {route} {dir} right now. Looks good in the mirror.",
  ],
  smalltalk: [
    "Breaker one-nine, anybody got their ears on out here on {route}?",
    "Radio check on {route}. Anybody copy?",
    "How's the road looking between here and {ahead}?",
    "Ten-four, catch you on the flip side.",
    "Dispatch is quiet today. Suspicious.",
    "That's a big ten-four from {route} {dir}.",
  ],
  cargo: [
    "Hauling {cargo} up {route}. Pays the same as the boring stuff.",
    "Got {cargo} on the {type} and a long way to {dest} yet.",
    "Whoever loaded this {cargo} owes me an alignment.",
    "{cargo} bound for {dest}. Nice and easy does it.",
    "Riding heavy with {cargo} on {route}. She's pulling fine.",
  ],
  police: [
    "Bear in the air over {route}. Watch your speed.",
    "Smokey's got somebody pulled over up ahead on {route}.",
    "County mountie sitting in the median before {ahead}. Ten-four on that.",
    "Bear's running radar on {route} {dir}. Ease off.",
    "Full grown bear parked at the {ahead} exit. Y'all be careful.",
  ],
  // Generic - fires the first time THIS truck passes THIS town, no
  // specific claim about what's there (see CB_CITY_FLAVOR for the handful
  // of cities that get a real one instead).
  firstVisitGeneric: [
    "First time rolling through {passed}. Not bad at all.",
    "Never been to {passed} before. Bigger than I figured.",
    "First trip out this way. {passed}'s alright.",
    "Ain't never hauled through {passed} till today.",
    "Dispatch finally sent me somewhere new - {passed}, if you're wondering.",
  ],
};

// A handful of well-known cities get a real, specific line instead of the
// generic first-visit filler above - the rest of the ~750-city graph falls
// back to firstVisitGeneric rather than inventing a landmark for somewhere
// that may not have one worth naming. Keyed on {passed}, so the truck has
// genuinely just been through the place it's describing.
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

// Lines backed by measured simulation state. BREAKDOWN and DRY_TANK come
// straight off fleet.js's event queue; JAM fires only for a truck actually
// running below CB_TUNING.jamSlowdownFraction of its own free-flow speed;
// JAM_BREAKDOWN and BREAKDOWN_AHEAD fire only when there is a genuinely
// disabled rig on the speaker's own edge, ahead of it, within
// CB_TUNING.breakdownAheadMiles.
const CB_EVENT_LINES = {
  BREAKDOWN: [
    "Mayday, I'm dead in the water on {route} {dir} short of {ahead}. Something let go.",
    "Well, that's the end of that. Broke down on {route} {dir}.",
    "Got smoke and no power on {route}. Sitting on the shoulder.",
    "She quit on me on {route} coming into {ahead}. Rolling nowhere.",
  ],
  DRY_TANK: [
    "Ran her dry on {route} short of {ahead}. Don't laugh, just send fuel.",
    "Out of go-juice on {route} {dir}. Rookie mistake.",
    "Sitting on empty on {route}. This one's on me.",
    "Tank's dry on {route} {dir} before {ahead}. Waiting on the fuel truck.",
  ],
  JAM: [
    "We're stacked up solid on {route} {dir} toward {ahead}. Find another way.",
    "Parking lot on {route} {dir}. Been in third gear for a while now.",
    "Heavy traffic on {route} {dir} out here, barely rolling.",
    "Whatever's ahead of us on {route}, it ain't moving.",
    "Crawling on {route} {dir}. Add an hour to whatever your book says.",
  ],
  JAM_BREAKDOWN: [
    "Backed up on {route} {dir} - there's a rig broke down up ahead. That'll do it.",
    "Dead stop on {route}. Somebody's sitting disabled a couple miles up.",
    "We're crawling on {route} {dir} past a broke-down truck. Move over if you can.",
  ],
  BREAKDOWN_AHEAD: [
    "Heads up {dir}bound on {route} - disabled rig on the right, hazards going.",
    "Somebody's broke down on the shoulder just up ahead on {route}. Give him room.",
    "Got a truck sitting dead a couple miles up on {route}. Move over if you've got the lane.",
    "Four-wheelers are all braking for a broke-down rig ahead on {route}. Easy does it.",
    "Breakdown ahead on {route} before {ahead}. Watch your speed coming up on it.",
  ],
};

// ---------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------
let cbFeedEl = null; // the #tab-cb panel - the scrollback lives here
let cbBadgeEl = null; // unread-alert count on the tab button
let cbOnSelectTruck = null; // tapping a line hands the truck back to main.js
let cbIsFeedVisible = null; // () => is the CB tab the one on screen?
let cbQueue = []; // pending lines, highest priority first (see cbEnqueue)
let cbLastEmitMs = 0;
let cbLastHighMs = 0; // last ALERT-or-above line
let cbHighStreak = 0; // consecutive ALERT-or-above lines
let cbLastFlavorMs = 0;
let cbLastJamMs = 0;
let cbUnread = 0;
let cbDisabledNotice = false; // is the panel currently showing the "switched off" placeholder?
const cbScratchPos = { x: 0, y: 0 };

// node -> truck, so a tapped line can hand back the rig that said it
// without keeping ids alive across a fleet rebuild. Entries die with the
// node, which resetCB removes wholesale.
const cbNodeTruck = new WeakMap();

// truck -> its most recent line, for the truck detail panel. Keyed on the
// truck object so a torn-down fleet's entries are simply unreachable
// garbage rather than something resetCB has to walk and clear.
const cbLastMessage = new WeakMap();

// Per-truck rolling memory of which towns it's already been through.
// Capped per truck (CB_TUNING.visitedMemory) - a "first time here" line
// only needs to know whether THIS truck has been through THIS town
// recently, not hold its entire lifetime route.
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

// The truck detail panel asks for this every frame it's open; returns
// null for a rig that hasn't keyed the mic yet, which is the signal to
// leave the block out entirely rather than show an empty quote.
export function cbLastMessageFor(truck) {
  return truck ? cbLastMessage.get(truck) || null : null;
}

// opts: { feedEl, badgeEl, onSelectTruck, isFeedVisible }
export function initCB(opts) {
  cbFeedEl = opts.feedEl || null;
  cbBadgeEl = opts.badgeEl || null;
  cbOnSelectTruck = opts.onSelectTruck || null;
  cbIsFeedVisible = opts.isFeedVisible || null;
  if (cbFeedEl) {
    // Delegated, so forty rows cost one listener and a row can be dropped
    // off the tail without any teardown.
    cbFeedEl.addEventListener("click", (ev) => {
      const row = ev.target.closest ? ev.target.closest(".cb-msg") : null;
      if (!row) return;
      const truck = cbNodeTruck.get(row);
      if (truck && cbOnSelectTruck) cbOnSelectTruck(truck);
    });
    cbShowPlaceholder("Quiet on the channel.");
  }
}

// Wipes the feed - queue, DOM and timers. Called whenever the sim is torn
// down and rebuilt, since every queued line holds a reference to a truck
// from the fleet that just stopped existing.
export function resetCB() {
  cbQueue.length = 0;
  cbLastEmitMs = 0;
  cbLastHighMs = 0;
  cbHighStreak = 0;
  cbLastFlavorMs = 0;
  cbLastJamMs = 0;
  cbUnread = 0;
  cbSyncBadge();
  if (cbFeedEl) cbShowPlaceholder("Quiet on the channel.");
}

function cbShowPlaceholder(text) {
  if (!cbFeedEl) return;
  cbFeedEl.innerHTML = "";
  const p = document.createElement("div");
  p.className = "cb-empty";
  p.textContent = text;
  cbFeedEl.appendChild(p);
}

function cbSyncBadge() {
  if (!cbBadgeEl) return;
  if (cbUnread > 0) {
    cbBadgeEl.textContent = cbUnread > 9 ? "9+" : String(cbUnread);
    cbBadgeEl.classList.remove("hidden");
  } else {
    cbBadgeEl.classList.add("hidden");
  }
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

// "2:14p" - short enough to sit in a fixed gutter beside forty rows.
function cbClock(gameSeconds) {
  let m = Math.floor(((gameSeconds || 0) % 86400) / 60);
  let h = Math.floor(m / 60);
  m = m % 60;
  const suffix = h >= 12 ? "p" : "a";
  h = h % 12 || 12;
  return `${h}:${m < 10 ? "0" + m : m}${suffix}`;
}

// ---------------------------------------------------------------------
// Place facts
// ---------------------------------------------------------------------
// Everything a line is allowed to name about where this truck is right
// now, split by how confident the sim actually is:
//
//   ahead   - the control city on the signs in front of the driver. Always
//             safe: it's where this edge is pointed.
//   passed  - a REAL town (tier 0 nodes are unnamed interchange filler)
//             that this truck has driven through within the last
//             justPassedMiles. Null the rest of the time, and the
//             categories that name a town are gated on it, which is what
//             makes "first time in St. Louis" mean the truck is in fact
//             leaving St. Louis.
//
// Returns null for a truck with no meaningful position, which simply
// doesn't get to speak this tick.
function cbPlaceContext(graph, truck) {
  const type = truck.contract ? truck.contract.truckType : null;
  const base = {
    handle: truck.name,
    cargo: truck.contract ? truck.contract.cargo : "freight",
    type: type ? type.label.toLowerCase() : "trailer",
    dest: truck.contract ? truck.contract.destination : null,
    color: type ? type.color : "#e8ecef",
    passed: null,
  };
  if (truck.edge) {
    base.route = cbRouteLabel(truck.edge.route);
    base.dir = travelDirectionLabel(truck.edge);
    base.ahead = truck.edge.control || truck.edge.to;
    const origin = graph.nodes[truck.edge.from];
    // Half the edge as well as an absolute cap: on a 30-mile hop between
    // two towns, "just came through" has to expire before the truck is
    // nearer the next one than the last.
    const window = Math.min(CB_TUNING.justPassedMiles, truck.edge.miles * 0.5);
    if (origin && origin.t > 0 && truck.s <= window) base.passed = truck.edge.from;
    return base;
  }
  if (truck.parkedAt) {
    base.route = "the yard";
    base.dir = "";
    base.ahead = truck.parkedAt;
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
// different copy of the camera math to drift out of sync. Nothing gets to
// speak from off screen, breakdowns included: the feed describes what
// you're looking at.
function cbIsVisible(graph, truck, viewport) {
  if (!viewport) return true;
  truckWorldPos(graph, truck, cbScratchPos);
  return (
    cbScratchPos.x >= viewport.minX && cbScratchPos.x <= viewport.maxX &&
    cbScratchPos.y >= viewport.minY && cbScratchPos.y <= viewport.maxY
  );
}

// Miles to the nearest disabled truck ahead of this one on its own edge,
// or -1 if there isn't one inside the warning range. fleet.js already
// builds the sorted per-edge list every tick for its rubberneck slowdown,
// so this is a lookup plus a short walk, not a scan.
function cbDisabledAhead(truck) {
  if (!truck.edge) return -1;
  const sorted = disabledPositionsOnEdge(truck.edge);
  if (!sorted || !sorted.length) return -1;
  for (let i = 0; i < sorted.length; i++) {
    const gap = sorted[i] - truck.s;
    if (gap <= 0) continue; // already behind us
    return gap <= CB_TUNING.breakdownAheadMiles ? gap : -1;
  }
  return -1;
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
// truthfully say something from. Weather lines need actual weather; night
// lines need actual night; anything that names a town needs the truck to
// have just left one. Gating on real simulation state is the whole reason
// the banter reads as local rather than random.
function cbEligibleCategories(graph, truck, cbCtx, place) {
  const weights = CB_TUNING.flavorWeights;
  const out = [];
  let total = 0;
  const add = (name) => {
    const w = weights[name] || 0;
    if (w > 0) { out.push({ name, w }); total += w; }
  };

  add("nature");
  add("traffic");
  add("smalltalk");
  add("police");
  if (truck.contract) add("cargo");
  if (place.passed) {
    add("landmark");
    add("coffee");
    // …and only the first time THIS truck has been through THIS town.
    if (!cbHasVisited(truck, place.passed)) add("firstVisit");
  }

  if (cbCtx.showWeather && cbCtx.weather) {
    truckWorldPos(graph, truck, cbScratchPos);
    // < 1 means this truck is inside a cell and being slowed by it.
    if (weatherSpeedMultAt(cbCtx.weather, cbScratchPos.x, cbScratchPos.y) < 0.999) add("weather");
  }
  truckWorldPos(graph, truck, cbScratchPos);
  const mins = localMinutesAtX(cbScratchPos.x, cbCtx.gameSeconds);
  if (mins >= 21 * 60 || mins < 5 * 60) add("night");

  // Only when there is genuinely a disabled rig up the road on this very
  // edge - see cbDisabledAhead. This one leaves the ambient band and goes
  // out as an ALERT, because it's a real hazard report.
  if (cbDisabledAhead(truck) > 0) add("breakdownAhead");

  return { out, total };
}

function cbMakeFlavor(graph, truck, cbCtx) {
  const place = cbPlaceContext(graph, truck);
  if (!place || !truck.edge) return null;
  const { out, total } = cbEligibleCategories(graph, truck, cbCtx, place);
  if (!total) return null;

  let roll = Math.random() * total;
  let category = out[out.length - 1].name;
  for (const entry of out) {
    roll -= entry.w;
    if (roll <= 0) { category = entry.name; break; }
  }

  if (category === "breakdownAhead") {
    return cbMessage(CB_PRIORITY.ALERT, truck, place, cbFormat(cbPick(CB_EVENT_LINES.BREAKDOWN_AHEAD), place));
  }
  if (category === "firstVisit") {
    // Only actually marked visited once the line is spoken - a truck that
    // was eligible but landed on a different category this tick stays
    // eligible to say it next time instead of silently losing the moment.
    cbMarkVisited(truck, place.passed);
    const specific = CB_CITY_FLAVOR[place.passed];
    return cbMessage(CB_PRIORITY.FLAVOR, truck, place, specific || cbFormat(cbPick(CB_LINES.firstVisitGeneric), place));
  }
  return cbMessage(CB_PRIORITY.FLAVOR, truck, place, cbFormat(cbPick(CB_LINES[category]), place));
}

function cbMessage(priority, truck, place, text) {
  return { priority, truck, handle: place.handle, color: place.color, text };
}

// ---------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------
// Sorted insert, highest priority first, FIFO within a priority. Two caps
// apply: an overall depth, and a separate one on the ALERT-and-above band
// so a nationwide drip of breakdowns can never squeeze the banter out
// entirely - a feed of nothing but red lines is as unreadable as a feed of
// nothing but weather.
function cbEnqueue(msg, nowMs) {
  msg.queuedAt = nowMs;

  if (msg.priority >= CB_PRIORITY.ALERT) {
    let highs = 0;
    let oldest = -1;
    for (let i = 0; i < cbQueue.length; i++) {
      if (cbQueue[i].priority < CB_PRIORITY.ALERT) continue;
      highs++;
      if (oldest < 0 || cbQueue[i].queuedAt < cbQueue[oldest].queuedAt) oldest = i;
    }
    if (highs >= CB_TUNING.highQueueCap && oldest >= 0) cbQueue.splice(oldest, 1);
  }

  let i = cbQueue.length;
  while (i > 0 && cbQueue[i - 1].priority < msg.priority) i--;
  cbQueue.splice(i, 0, msg);

  // Over budget: drop the OLDEST of the lowest-priority band, not simply
  // the tail. The tail is the newest banter, and throwing that away means
  // the feed shows only lines that have already gone stale.
  if (cbQueue.length > CB_TUNING.queueCap) {
    const lowest = cbQueue[cbQueue.length - 1].priority;
    let j = cbQueue.length - 1;
    while (j > 0 && cbQueue[j - 1].priority === lowest) j--;
    cbQueue.splice(j, 1);
  }
}

// Turns one simulation event (BREAKDOWN or DRY_TANK - the only kinds
// fleet.js emits) into a queued critical line, if the rig is on screen.
function cbIngestEvent(graph, evt, viewport, nowMs) {
  const truck = evt.truck;
  if (!truck) return;
  const bank = CB_EVENT_LINES[evt.kind];
  if (!bank) return;
  if (!cbIsVisible(graph, truck, viewport)) return;

  const place = cbPlaceContext(graph, truck);
  if (!place) return;
  cbEnqueue(cbMessage(CB_PRIORITY.CRITICAL, truck, place, cbFormat(cbPick(bank), place)), nowMs);
}

// ---------------------------------------------------------------------
// Rendering - a scrollback, newest at the top
// ---------------------------------------------------------------------
function cbPublish(msg, gameSeconds) {
  const time = cbClock(gameSeconds);
  if (msg.truck) cbLastMessage.set(msg.truck, { text: msg.text, time, priority: msg.priority });
  if (!cbFeedEl) return;

  const placeholder = cbFeedEl.querySelector(".cb-empty");
  if (placeholder) placeholder.remove();

  const node = document.createElement("div");
  node.className =
    "cb-msg" +
    (msg.priority >= CB_PRIORITY.CRITICAL ? " cb-critical" : msg.priority >= CB_PRIORITY.ALERT ? " cb-alert" : "");

  const stamp = document.createElement("span");
  stamp.className = "cb-time";
  stamp.textContent = time;

  const body = document.createElement("div");
  body.className = "cb-body";
  const handle = document.createElement("span");
  handle.className = "cb-handle";
  handle.style.color = msg.color;
  handle.textContent = msg.handle;
  const text = document.createElement("span");
  text.className = "cb-text";
  text.textContent = msg.text;
  body.appendChild(handle);
  body.appendChild(text);

  node.appendChild(stamp);
  node.appendChild(body);
  if (msg.truck) cbNodeTruck.set(node, msg.truck);

  // Inserting at the top pushes everything down, which would yank the
  // ground out from under someone reading further back. If they've
  // scrolled away from the top, scroll by exactly as much as we just
  // grew so their place doesn't move.
  const wasScrolled = cbFeedEl.scrollTop > 2;
  cbFeedEl.insertBefore(node, cbFeedEl.firstChild);
  if (wasScrolled) cbFeedEl.scrollTop += node.offsetHeight;

  while (cbFeedEl.childElementCount > CB_TUNING.logCap) cbFeedEl.removeChild(cbFeedEl.lastChild);

  // An alert you weren't looking at is exactly what the badge is for.
  if (msg.priority >= CB_PRIORITY.ALERT && !(cbIsFeedVisible && cbIsFeedVisible())) {
    cbUnread++;
    cbSyncBadge();
  }
}

// ---------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------
// One line per frame at most, and never two closer together than the
// zoom-derived global gap. The interesting part is what happens when the
// head of the queue is an alert: nationwide there are always more alerts
// than the feed can carry, so an alert that's too soon after the last one
// - or that would extend a run of them past the streak limit - steps
// aside for whatever banter is waiting instead. That interleaving is the
// difference between a feed that reports the country and one that just
// lists its breakdowns.
function cbEmitStep(nowMs, cbCtx, t) {
  // Two ways a queued line stops being worth showing between being written
  // and reaching the front:
  //   - it sat long enough to no longer be true (criticals are exempt; a
  //     breakdown reads the same whenever you see it), or
  //   - its speaker has driven off the edge of the screen since. Zoomed in
  //     a rig crosses the frame in a couple of seconds, so checking the
  //     viewport only at enqueue time is not the same promise as checking
  //     it here. This is the check that actually guarantees every line in
  //     the feed came from something you can see.
  for (let i = cbQueue.length - 1; i >= 0; i--) {
    const m = cbQueue[i];
    if (m.priority < CB_PRIORITY.CRITICAL && nowMs - m.queuedAt > CB_TUNING.staleMs) { cbQueue.splice(i, 1); continue; }
    if (m.truck && !cbIsVisible(cbCtx.graph, m.truck, cbCtx.viewport)) cbQueue.splice(i, 1);
  }
  if (!cbQueue.length) return;
  if (nowMs - cbLastEmitMs < cbLerp(CB_TUNING.globalGapMsOut, CB_TUNING.globalGapMsIn, t)) return;

  let idx = 0;
  const head = cbQueue[0];
  if (head.priority >= CB_PRIORITY.ALERT) {
    const gap =
      head.priority >= CB_PRIORITY.CRITICAL
        ? cbLerp(CB_TUNING.criticalGapMsOut, CB_TUNING.criticalGapMsIn, t)
        : cbLerp(CB_TUNING.alertGapMsOut, CB_TUNING.alertGapMsIn, t);
    const tooSoon = nowMs - cbLastHighMs < gap;
    const streaked = cbHighStreak >= Math.round(cbLerp(CB_TUNING.maxHighStreakOut, CB_TUNING.maxHighStreakIn, t));
    if (tooSoon || streaked) {
      const alt = cbQueue.findIndex((m) => m.priority < CB_PRIORITY.ALERT);
      if (alt >= 0) idx = alt;
      // Nothing else to say: hold the alert back if it's genuinely too
      // soon, but let a streak through rather than going silent.
      else if (tooSoon) return;
    }
  }

  const msg = cbQueue.splice(idx, 1)[0];
  cbLastEmitMs = nowMs;
  if (msg.priority >= CB_PRIORITY.ALERT) {
    cbLastHighMs = nowMs;
    cbHighStreak++;
  } else {
    cbHighStreak = 0;
  }
  cbPublish(msg, cbCtx.gameSeconds);
}

// ---------------------------------------------------------------------
// Per-frame entry point
// ---------------------------------------------------------------------
// cbCtx: { enabled, graph, trucks, viewport, camera, gameSeconds, weather,
//          showWeather, events }
// `events` is whatever fleet.js emitted this tick (drained by main.js).
export function updateCB(nowMs, cbCtx) {
  if (!cbFeedEl) return;
  if (!cbCtx.enabled) {
    if (!cbDisabledNotice) {
      cbQueue.length = 0;
      cbShowPlaceholder("CB radio is switched off.");
      cbUnread = 0;
      cbSyncBadge();
      cbDisabledNotice = true;
    }
    return;
  }
  if (cbDisabledNotice) {
    cbShowPlaceholder("Quiet on the channel.");
    cbDisabledNotice = false;
  }

  // Looking at the feed clears the badge - that's what "unread" means.
  if (cbUnread && cbIsFeedVisible && cbIsFeedVisible()) {
    cbUnread = 0;
    cbSyncBadge();
  }

  const t = cbZoomT(cbCtx.camera);
  const flavorInterval = cbLerp(CB_TUNING.flavorIntervalMsOut, CB_TUNING.flavorIntervalMsIn, t);

  // 1. Real events first - they're the reason this thing exists.
  if (cbCtx.events) {
    for (const evt of cbCtx.events) cbIngestEvent(cbCtx.graph, evt, cbCtx.viewport, nowMs);
  }

  // 2. Traffic watch: a visible truck crawling well under its own
  // free-flow speed. It only gets to blame a breakdown when there is one
  // on its edge ahead of it; otherwise it just reports being slow.
  if (nowMs - cbLastJamMs >= CB_TUNING.jamMinGapMs) {
    const stuck = cbFindJam(cbCtx.graph, cbCtx.trucks, cbCtx.viewport);
    if (stuck) {
      cbLastJamMs = nowMs;
      const place = cbPlaceContext(cbCtx.graph, stuck);
      if (place) {
        const bank = cbDisabledAhead(stuck) > 0 ? CB_EVENT_LINES.JAM_BREAKDOWN : CB_EVENT_LINES.JAM;
        cbEnqueue(cbMessage(CB_PRIORITY.ALERT, stuck, place, cbFormat(cbPick(bank), place)), nowMs);
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

  cbEmitStep(nowMs, cbCtx, t);
}
