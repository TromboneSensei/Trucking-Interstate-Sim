// ui.js - the bottom-sheet dispatch terminal. Plain functions over the
// current fleet/graph state, not a class with its own persistent copy of
// everything - main.js already owns that state and just calls in here
// to (re)render whenever something changes. Real CSS classes throughout
// (no inline-styled template strings).
"use strict";
import { travelDirectionLabel } from "./geo.js";

const el = {
  sheet: document.getElementById("bottom-sheet"),
  handle: document.getElementById("sheet-handle"),
  tabs: document.querySelectorAll(".tab-btn"),
  overview: document.getElementById("tab-overview"),
  rankings: document.getElementById("tab-rankings"),
  economy: document.getElementById("tab-economy"),
  detailsEmpty: document.getElementById("details-empty"),
  detailsData: document.getElementById("details-data"),
};

let onSelectTruck = null;
let onSpotlightCargo = null;
let onToggleControl = null;
let dispatchDrill = null; // null = the Dispatch summary cards; "corridors" | "interstates" = drilled into that ranking
let rankingsDrillKey = null; // null = the Rankings leader cards; a key (possibly "city:"-prefixed) = drilled into that ranking
let selectedCityName = null; // set once a city is picked out of a city ranking - replaces the Rankings tab with that city's full page
let lastTrucks = [];
let lastGraph = null;

export function initUI(callbacks) {
  onSelectTruck = callbacks.onSelectTruck;
  onToggleControl = callbacks.onToggleControl;
  onSpotlightCargo = callbacks.onSpotlightCargo;

  // Tapping a cargo row spotlights that cargo type on the map. Delegated
  // like the other panels, since the Economy tab is rebuilt wholesale on
  // every refresh.
  el.economy.addEventListener("click", (e) => {
    const row = e.target.closest("[data-cargo]");
    if (row && onSpotlightCargo) onSpotlightCargo(row.dataset.cargo);
  });

  el.handle.addEventListener("click", () => el.sheet.classList.toggle("minimized"));
  el.tabs.forEach((btn) => {
    btn.addEventListener("click", () => openTab(btn.dataset.tab));
  });

  // Delegated: each tab's content is fully rebuilt on every refresh, so
  // its click targets are wired here once against the stable parent
  // rather than re-attached per render.
  el.overview.addEventListener("click", (e) => {
    const drillCard = e.target.closest("[data-drill]");
    const chip = e.target.closest("[data-chip]");
    const back = e.target.closest("[data-back]");
    if (!drillCard && !chip && !back) return;

    if (drillCard) dispatchDrill = drillCard.dataset.drill;
    else if (chip) dispatchDrill = chip.dataset.chip;
    else dispatchDrill = null; // back out of a ranking to the summary cards

    renderDispatchTab(lastTrucks, lastGraph);
    el.overview.scrollTop = 0;
  });

  el.rankings.addEventListener("click", (e) => {
    const drillCard = e.target.closest("[data-drill]");
    const chip = e.target.closest("[data-chip]");
    const cityRow = e.target.closest("[data-city]");
    const back = e.target.closest("[data-back]");
    if (!drillCard && !chip && !cityRow && !back) return;

    if (drillCard) { rankingsDrillKey = drillCard.dataset.drill; selectedCityName = null; }
    else if (chip) { rankingsDrillKey = chip.dataset.chip; selectedCityName = null; }
    else if (cityRow) { selectedCityName = cityRow.dataset.city; }
    else if (selectedCityName) { selectedCityName = null; } // back out of a city page to its ranking list
    else { rankingsDrillKey = null; } // back out of a ranking to the leader cards

    renderRankingsTab(lastTrucks, lastGraph);
    // Rebuilding the panel's innerHTML doesn't reset its own scroll
    // position, so navigating between leader-cards/ranking/city views
    // from partway down the previous one left the new (shorter) content
    // starting mid-scroll instead of at its own top.
    el.rankings.scrollTop = 0;
  });

  el.detailsData.addEventListener("click", (e) => {
    if (e.target.closest("[data-control-toggle]")) onToggleControl && onToggleControl();
  });
}

// Called when the sim restarts under new settings: the old fleet/graph
// this panel was showing (a drilldown, a selected city page, cached
// trucks/graph references) no longer apply to the fresh run.
export function resetUIState() {
  dispatchDrill = null;
  rankingsDrillKey = null;
  selectedCityName = null;
  lastTrucks = [];
  lastGraph = null;
  el.detailsEmpty.classList.remove("hidden");
  el.detailsData.classList.add("hidden");
  el.detailsData.innerHTML = "";
}

function openTab(name) {
  el.sheet.classList.remove("minimized");
  el.tabs.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".content-panel").forEach((p) => p.classList.remove("active"));
  document.getElementById(`tab-${name}`).classList.add("active");
}

// User explicitly tapped a truck/city: switch to the Details tab and render.
export function openDetailsFor(entity, kind, isControlled, trucks, graph) {
  openTab("details");
  if (kind === "truck") renderTruckDetails(entity, isControlled);
  else renderCityDetails(entity, graph, trucks);
}

// Per-frame refresh of the followed truck's numbers - does NOT switch
// tabs, so it stays live (speed/miles/ETA ticking) without yanking the
// player back to Details if they've navigated elsewhere.
export function refreshFollowedTruckDetails(truck, isControlled) {
  renderTruckDetails(truck, isControlled);
}

// Periodic refresh of a viewed city's live stats (inbound/outbound
// traffic changes as the fleet moves) - same idea, no tab switch.
export function refreshViewedCityDetails(city, graph, trucks) {
  if (city) renderCityDetails(city, graph, trucks);
}

function metricCard(title, value, sub, tone, drillKey) {
  const div = document.createElement("div");
  div.className = "metric-card" + (tone ? " " + tone : "");
  if (drillKey) div.dataset.drill = drillKey;
  div.innerHTML = `<div class="metric-title">${title}</div><div class="metric-value">${value}</div><div class="metric-sub">${sub}</div>`;
  return div;
}

// Remaining distance to a truck's contract destination: the tail of its
// current edge (or the full length of pendingEdge, while briefly stopped
// waiting for a gap to depart a city) plus every edge still queued in
// remainingPath.
function etaMilesOf(t) {
  const currentLeg = t.edge ? t.edge.miles - t.s : (t.pendingEdge ? t.pendingEdge.miles : 0);
  return Math.max(0, currentLeg) + t.remainingPath.reduce((s, e) => s + e.miles, 0);
}

// Combines both directions of the same physical road segment (from/to
// sorted) so a corridor's congestion count doesn't split by which way
// trucks happen to be driving on it. Sorted descending - [0] is the
// single busiest corridor, the full array backs its ranking drilldown.
function corridorCounts(trucks) {
  const counts = new Map();
  for (const t of trucks) {
    if (!t.edge) continue;
    const key = [t.edge.from, t.edge.to].sort().join("|") + "|" + t.edge.route;
    const rec = counts.get(key) || { count: 0, edge: t.edge };
    rec.count++;
    counts.set(key, rec);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

// A physical route like I-76 can be split into two non-contiguous
// segments in the data (route names "I-76 (West)"/"I-76 (East)") - this
// strips that suffix so both halves roll up into one "I-76" total.
function baseRouteName(route) {
  return route.replace(" (West)", "").replace(" (East)", "");
}

// Every truck currently on an interstate, tallied by which interstate
// (both directions, all corridors of that route combined) - "busiest
// interstate overall" rather than "busiest single segment".
function interstateCounts(trucks) {
  const counts = new Map();
  for (const t of trucks) {
    if (!t.edge || t.edge.kind !== "interstate") continue;
    const key = baseRouteName(t.edge.route);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([route, count]) => ({ route, count })).sort((a, b) => b.count - a.count);
}

function shieldLabel(route) {
  return route.replace("US-", "US ").replace(" (West)", "").replace(" (East)", "");
}

// A periodic (every ~400ms) refresh tears down and rebuilds a panel's
// innerHTML wholesale, which by default resets any scroll position -
// most jarringly the chip-row's horizontal scroll snapping back to its
// start mid-swipe. Wrapping a render call in this preserves both the
// panel's own vertical scroll and any chip-row's horizontal scroll
// across that rebuild; explicit navigation (tapping into/out of a
// ranking) still resets scroll afterward via its own click handler,
// which runs after and overrides this.
function preserveScroll(container, renderFn) {
  const scrollTop = container.scrollTop;
  const chipScrollLeft = container.querySelector(".chip-row")?.scrollLeft;
  renderFn();
  container.scrollTop = scrollTop;
  if (chipScrollLeft != null) {
    const chipRow = container.querySelector(".chip-row");
    if (chipRow) chipRow.scrollLeft = chipScrollLeft;
  }
}

// Every stat a truck can be ranked by. Each shows up as one leader card
// on the Dispatch overview (name of the #1 truck + its value); tapping
// that card drills into the full top-10 for that stat.
const TRUCK_STATS = {
  earnings: { label: "Top Earners", dir: "desc", get: (t) => t.earnings, fmt: (v) => "$" + Math.round(v).toLocaleString(), unit: "" },
  speed: { label: "Fastest", dir: "desc", get: (t) => t.speed, fmt: (v) => Math.round(v), unit: " mph" },
  routeMiles: { label: "Longest Route", dir: "desc", get: (t) => t.contract.optimalMiles, fmt: (v) => Math.round(v).toLocaleString(), unit: " mi" },
  totalMiles: { label: "Most Miles", dir: "desc", get: (t) => t.totalMilesDriven, fmt: (v) => Math.round(v).toLocaleString(), unit: " mi" },
  trips: { label: "Most Trips", dir: "desc", get: (t) => t.contractsCompleted, fmt: (v) => v, unit: "" },
  etaMiles: { label: "Closest to Arrival", dir: "asc", get: (t) => etaMilesOf(t), fmt: (v) => Math.round(v).toLocaleString(), unit: " mi left" },
  payout: { label: "Highest Payout", dir: "desc", get: (t) => t.contract.payout, fmt: (v) => "$" + Math.round(v).toLocaleString(), unit: "" },
};

// Same idea, for cities. population is static (from data.js); inbound/
// outbound are live counts over the current fleet, so their `get` also
// takes `trucks`.
const CITY_STATS = {
  population: { label: "Largest Cities", dir: "desc", get: (c) => c.pop || 0, fmt: (v) => v.toLocaleString(), unit: "" },
  inbound: { label: "Most Inbound Traffic", dir: "desc", get: (c, trucks) => trucks.filter((t) => t.contract.destination === c.name).length, fmt: (v) => v, unit: " inbound" },
  outbound: { label: "Most Outbound Traffic", dir: "desc", get: (c, trucks) => trucks.filter((t) => t.contract.origin === c.name).length, fmt: (v) => v, unit: " outbound" },
};

function sortedTrucksBy(trucks, key) {
  const stat = TRUCK_STATS[key];
  return [...trucks].sort((a, b) => stat.dir === "asc" ? stat.get(a) - stat.get(b) : stat.get(b) - stat.get(a));
}

function realCities(graph) {
  return Object.values(graph.nodes).filter((n) => n.t > 0);
}

function sortedCitiesBy(graph, trucks, key) {
  const stat = CITY_STATS[key];
  return realCities(graph).sort((a, b) => stat.dir === "asc" ? stat.get(a, trucks) - stat.get(b, trucks) : stat.get(b, trucks) - stat.get(a, trucks));
}

function listRow(rank, mainText, subText, valueText, valueUnit, onClick, dataAttr) {
  const div = document.createElement("div");
  div.className = "list-row";
  if (dataAttr) div.dataset[dataAttr[0]] = dataAttr[1];
  div.innerHTML = `<div class="row-rank">${rank}</div>
    <div><div class="row-main">${mainText}</div><div class="row-sub">${subText}</div></div>
    <div class="row-value">${valueText}${valueUnit ? `<span class="row-value-unit">${valueUnit}</span>` : ""}</div>`;
  if (onClick) div.addEventListener("click", onClick);
  return div;
}

export function renderDispatchTab(trucks, graph) {
  lastTrucks = trucks;
  lastGraph = graph;
  if (!trucks.length || !graph) { el.overview.innerHTML = ""; return; }

  preserveScroll(el.overview, () => {
    el.overview.innerHTML = "";
    if (dispatchDrill) { renderRoadDrilldown(trucks, dispatchDrill); return; }

    const moving = trucks.filter((t) => t.edge);
    const avgSpeed = moving.length ? moving.reduce((s, t) => s + t.speed, 0) / moving.length : 0;
    const totalEarnings = trucks.reduce((s, t) => s + t.earnings, 0);
    const totalMiles = trucks.reduce((s, t) => s + t.totalMilesDriven, 0);
    const totalTrips = trucks.reduce((s, t) => s + t.contractsCompleted, 0);
    const cargoCounts = {};
    for (const t of trucks) cargoCounts[t.contract.truckType.label] = (cargoCounts[t.contract.truckType.label] || 0) + 1;
    const topType = Object.entries(cargoCounts).sort((a, b) => b[1] - a[1])[0];
    const corridors = corridorCounts(trucks);
    const corridor = corridors[0];
    const interstates = interstateCounts(trucks);
    const topInterstate = interstates[0];

    const grid = document.createElement("div");
    grid.className = "metric-grid";
    grid.appendChild(metricCard("Active Fleet", trucks.length, `${moving.length} rolling`));
    grid.appendChild(metricCard("Network Speed", Math.round(avgSpeed) + " mph", "fleet average"));
    grid.appendChild(metricCard("Total Earnings", "$" + Math.round(totalEarnings).toLocaleString(), "all-time"));
    grid.appendChild(metricCard("Miles Logged", Math.round(totalMiles).toLocaleString(), "all-time"));
    grid.appendChild(metricCard("Contracts Done", totalTrips.toLocaleString(), "all-time"));
    grid.appendChild(metricCard("Top Cargo", topType ? topType[0] : "—", topType ? `${topType[1]} trucks` : ""));
    grid.appendChild(metricCard("Busiest Corridor", corridor ? shieldLabel(corridor.edge.route) : "—", corridor ? `near ${corridor.edge.control} • ${corridor.count} trucks` : "", "info", "corridors"));
    grid.appendChild(metricCard("Busiest Interstate", topInterstate ? shieldLabel(topInterstate.route) : "—", topInterstate ? `${topInterstate.count} trucks total` : "", "info", "interstates"));
    el.overview.appendChild(grid);
  });
}

const ROAD_DRILL_LABEL = { corridors: "Busiest Corridors", interstates: "Busiest Interstates" };

// Dispatch's own (much smaller) drilldown - just the two road-traffic
// rankings, so it gets a simple 2-way chip toggle rather than pulling in
// the full Rankings-tab machinery for two categories.
function renderRoadDrilldown(trucks, key) {
  const header = document.createElement("div");
  header.className = "detail-header";
  header.style.marginTop = "2px";
  header.innerHTML = `<button class="pill-btn" data-back style="background:var(--panel-strong);color:var(--ink)">&larr; Back</button>
    <div class="detail-title" style="font-size:1rem;">${ROAD_DRILL_LABEL[key]}</div><span></span>`;
  el.overview.appendChild(header);

  const chipRow = document.createElement("div");
  chipRow.className = "chip-row";
  for (const k in ROAD_DRILL_LABEL) {
    const chip = document.createElement("button");
    chip.className = "chip" + (k === key ? " active" : "");
    chip.dataset.chip = k;
    chip.textContent = ROAD_DRILL_LABEL[k];
    chipRow.appendChild(chip);
  }
  el.overview.appendChild(chipRow);

  const list = document.createElement("div");
  if (key === "corridors") {
    corridorCounts(trucks).slice(0, 10).forEach((rec, i) => {
      list.appendChild(listRow(i + 1, shieldLabel(rec.edge.route), `near ${rec.edge.control}`, rec.count, " trucks"));
    });
  } else {
    interstateCounts(trucks).slice(0, 10).forEach((rec, i) => {
      list.appendChild(listRow(i + 1, shieldLabel(rec.route), "all corridors", rec.count, " trucks"));
    });
  }
  el.overview.appendChild(list);
}

export function renderRankingsTab(trucks, graph) {
  if (!trucks.length || !graph) { el.rankings.innerHTML = ""; return; }

  preserveScroll(el.rankings, () => {
    el.rankings.innerHTML = "";
    if (selectedCityName) { renderCityPage(graph.nodes[selectedCityName], graph, trucks); return; }
    if (rankingsDrillKey) { renderDrilldown(trucks, graph, rankingsDrillKey); return; }

    const fleetLabel = document.createElement("div");
    fleetLabel.className = "section-label";
    fleetLabel.textContent = "Fleet Leaderboards — tap to see the full ranking";
    el.rankings.appendChild(fleetLabel);

    const fleetGrid = document.createElement("div");
    fleetGrid.className = "metric-grid";
    for (const key in TRUCK_STATS) {
      const stat = TRUCK_STATS[key];
      const leader = sortedTrucksBy(trucks, key)[0];
      const card = document.createElement("div");
      card.className = "metric-card good";
      card.dataset.drill = key;
      card.innerHTML = `<div class="metric-title">${stat.label}</div><div class="metric-value">${stat.fmt(stat.get(leader))}${stat.unit}</div><div class="metric-sub">${leader.name}</div>`;
      fleetGrid.appendChild(card);
    }
    el.rankings.appendChild(fleetGrid);

    const cityLabel = document.createElement("div");
    cityLabel.className = "section-label";
    cityLabel.textContent = "City Rankings — tap to see the full list";
    el.rankings.appendChild(cityLabel);

    const cityGrid = document.createElement("div");
    cityGrid.className = "metric-grid";
    for (const key in CITY_STATS) {
      const stat = CITY_STATS[key];
      const leader = sortedCitiesBy(graph, trucks, key)[0];
      const card = document.createElement("div");
      card.className = "metric-card info";
      card.dataset.drill = "city:" + key;
      card.innerHTML = `<div class="metric-title">${stat.label}</div><div class="metric-value">${stat.fmt(stat.get(leader, trucks))}${stat.unit}</div><div class="metric-sub">${leader.name}</div>`;
      cityGrid.appendChild(card);
    }
    el.rankings.appendChild(cityGrid);
  });
}

function renderDrilldown(trucks, graph, key) {
  if (key.startsWith("city:")) { renderCityDrilldown(trucks, graph, key.slice(5)); return; }

  const stat = TRUCK_STATS[key];
  const header = document.createElement("div");
  header.className = "detail-header";
  header.style.marginTop = "2px";
  header.innerHTML = `<button class="pill-btn" data-back style="background:var(--panel-strong);color:var(--ink)">&larr; Back</button>
    <div class="detail-title" style="font-size:1rem;">${stat.label}</div><span></span>`;
  el.rankings.appendChild(header);

  const chipRow = document.createElement("div");
  chipRow.className = "chip-row";
  for (const k in TRUCK_STATS) {
    const chip = document.createElement("button");
    chip.className = "chip" + (k === key ? " active" : "");
    chip.dataset.chip = k;
    chip.textContent = TRUCK_STATS[k].label;
    chipRow.appendChild(chip);
  }
  el.rankings.appendChild(chipRow);

  const list = document.createElement("div");
  sortedTrucksBy(trucks, key).slice(0, 10).forEach((t, i) => {
    list.appendChild(listRow(
      i + 1,
      t.name,
      `${t.currentNode} → ${t.contract.destination}`,
      stat.fmt(stat.get(t)),
      stat.unit,
      () => onSelectTruck && onSelectTruck(t)
    ));
  });
  el.rankings.appendChild(list);
}

function cityTierLabel(t) {
  return { 1: "Major Hub", 2: "Regional Center", 3: "Secondary Market", 4: "Local Market" }[t] || "Waypoint";
}

function renderCityDrilldown(trucks, graph, key) {
  const stat = CITY_STATS[key];
  const header = document.createElement("div");
  header.className = "detail-header";
  header.style.marginTop = "2px";
  header.innerHTML = `<button class="pill-btn" data-back style="background:var(--panel-strong);color:var(--ink)">&larr; Back</button>
    <div class="detail-title" style="font-size:1rem;">${stat.label}</div><span></span>`;
  el.rankings.appendChild(header);

  const chipRow = document.createElement("div");
  chipRow.className = "chip-row";
  for (const k in CITY_STATS) {
    const chip = document.createElement("button");
    chip.className = "chip" + (k === key ? " active" : "");
    chip.dataset.chip = "city:" + k;
    chip.textContent = CITY_STATS[k].label;
    chipRow.appendChild(chip);
  }
  el.rankings.appendChild(chipRow);

  const list = document.createElement("div");
  sortedCitiesBy(graph, trucks, key).slice(0, 10).forEach((c, i) => {
    list.appendChild(listRow(
      i + 1,
      c.name,
      cityTierLabel(c.t),
      stat.fmt(stat.get(c, trucks)),
      stat.unit,
      null,
      ["city", c.name]
    ));
  });
  el.rankings.appendChild(list);
}

// The rich per-city page, embedded directly in the Rankings tab in place
// of whichever city ranking the player drilled through to get here.
function renderCityPage(city, graph, trucks) {
  const header = document.createElement("div");
  header.className = "detail-header";
  header.style.marginTop = "2px";
  header.innerHTML = `<button class="pill-btn" data-back style="background:var(--panel-strong);color:var(--ink)">&larr; Back</button><span></span>`;
  el.rankings.appendChild(header);

  const wrap = document.createElement("div");
  wrap.innerHTML = cityDetailsHTML(city, graph, trucks);
  el.rankings.appendChild(wrap);
}

// Shared by the Dispatch-tab city page and the Unit-tab city view (via
// map tap) so both read from one accurate, consistently formatted source.
function cityDetailsHTML(city, graph, trucks) {
  const inbound = trucks.filter((t) => t.contract.destination === city.name);
  const outbound = trucks.filter((t) => t.contract.origin === city.name);
  const allReal = realCities(graph);
  const popRank = city.pop ? allReal.filter((c) => (c.pop || 0) > city.pop).length + 1 : null;

  const cargoCounts = {};
  for (const t of inbound) cargoCounts[t.contract.truckType.label] = (cargoCounts[t.contract.truckType.label] || 0) + 1;
  const topInbound = Object.entries(cargoCounts).sort((a, b) => b[1] - a[1])[0];

  return `
    <div class="detail-header">
      <div>
        <div class="detail-title">${city.name}</div>
        <div class="detail-sub">${cityTierLabel(city.t)} • Tier ${city.t}${popRank ? ` • #${popRank} by population` : ""}</div>
      </div>
    </div>
    <div class="metric-grid" style="margin-bottom:12px;">
      <div class="metric-card"><div class="metric-title">Population</div><div class="metric-value">${city.pop ? city.pop.toLocaleString() : "—"}</div></div>
      <div class="metric-card"><div class="metric-title">Freight Weight</div><div class="metric-value">${city.w}</div></div>
      <div class="metric-card good"><div class="metric-title">Inbound Now</div><div class="metric-value">${inbound.length}</div><div class="metric-sub">trucks headed here</div></div>
      <div class="metric-card info"><div class="metric-title">Outbound Now</div><div class="metric-value">${outbound.length}</div><div class="metric-sub">trucks just departed</div></div>
    </div>
    ${topInbound ? `<div class="detail-sub" style="margin-bottom:10px;">Top inbound cargo: <strong style="color:var(--ink)">${topInbound[0]}</strong> (${topInbound[1]} truck${topInbound[1] === 1 ? "" : "s"})</div>` : ""}
    <div class="detail-sub">${(city.ind || []).join(", ") || "No industry data"}</div>
  `;
}

function statBar(label, value01, color) {
  return `<div class="stat-bar-row">
    <div class="stat-bar-label"><span>${label}</span><span>${Math.round(value01 * 100)}%</span></div>
    <div class="stat-bar"><div class="stat-bar-fill" style="width:${value01 * 100}%;background:${color}"></div></div>
  </div>`;
}

// The full planned route (contract.path never shrinks as the truck
// drives, unlike remainingPath) as its ordered real-city stops - origin,
// every tier>0 waypoint the route happens to pass through, destination.
// Static for the life of the contract, unlike showing currentNode (which
// would silently swap the "from" city out for whatever town the truck
// most recently passed).
// Just origin and destination (no intermediate waypoints) - final
// destination bolded, mirrors the emphasis the old currentNode-→-destination
// line had.
function fullRouteHTML(truck) {
  return `${truck.contract.origin} → <strong style="color:var(--ink)">${truck.contract.destination}</strong>`;
}

// "On I-75 North" / "Stopped in Macon" - live, changes edge to edge
// (or when stopped waiting to depart), unlike the static route above.
function currentRoadDetail(truck) {
  if (truck.edge) return `On ${shieldLabel(truck.edge.route)} ${travelDirectionLabel(truck.edge)}`;
  if (truck.pendingEdge) return `Stopped in ${truck.currentNode}`;
  return null;
}

function renderTruckDetails(truck, isControlled) {
  el.detailsEmpty.classList.add("hidden");
  el.detailsData.classList.remove("hidden");
  const archetype = truck.driver.getArchetype();
  const etaMiles = etaMilesOf(truck);
  const roadDetail = currentRoadDetail(truck);

  const controlBlock = isControlled
    ? `<button class="pill-btn" data-control-toggle style="background:var(--go);width:100%;margin-bottom:12px;">&#9881; Controlling — Release Control</button>`
    : `<button class="pill-btn" data-control-toggle style="background:var(--caution);color:var(--caution-ink);width:100%;margin-bottom:12px;">Take Control</button>`;

  el.detailsData.innerHTML = `
    <div class="detail-header">
      <div>
        <div class="detail-title">${truck.name}</div>
        <div class="detail-sub">${truck.contract.truckType.label} • ${truck.contract.cargo}</div>
      </div>
      <div style="text-align:right">
        <div class="archetype-badge" style="color:${archetype.color}">${archetype.label}</div>
        <div class="archetype-desc">${archetype.desc}</div>
      </div>
    </div>
    <div class="detail-sub" style="margin-bottom:2px;">${fullRouteHTML(truck)} &bull; ${Math.round(etaMiles)} mi remaining</div>
    ${roadDetail ? `<div class="detail-sub" style="margin-bottom:10px;color:var(--caution);font-size:1.6rem;font-weight:700;">${roadDetail}</div>` : `<div style="margin-bottom:10px;"></div>`}
    ${controlBlock}
    ${isControlled ? `<div class="detail-sub" style="margin-bottom:10px;">Junction calls are yours - the sim will pause and wait for you at the next fork.</div>` : ""}
    <div class="metric-grid" style="margin-bottom:12px;">
      <div class="metric-card"><div class="metric-title">Speed</div><div class="metric-value">${Math.round(truck.speed)} mph</div></div>
      <div class="metric-card"><div class="metric-title">Odometer</div><div class="metric-value">${Math.round(truck.totalMilesDriven).toLocaleString()}</div></div>
      <div class="metric-card"><div class="metric-title">Payout</div><div class="metric-value">$${truck.contract.payout.toLocaleString()}</div></div>
      <div class="metric-card"><div class="metric-title">Earnings</div><div class="metric-value">$${Math.round(truck.earnings).toLocaleString()}</div></div>
      <div class="metric-card"><div class="metric-title">Trips</div><div class="metric-value">${truck.contractsCompleted}</div></div>
      <div class="metric-card"><div class="metric-title">Cruise Mult.</div><div class="metric-value">${truck.driver.cruiseMult.toFixed(2)}&times;</div></div>
    </div>
    ${statBar("Aggression", truck.driver.aggression, "var(--stop)")}
    ${statBar("Skill", truck.driver.skill, "var(--info)")}
    ${statBar("Hustle", truck.driver.hustle, "var(--go)")}
  `;
}

function renderCityDetails(city, graph, trucks) {
  el.detailsEmpty.classList.add("hidden");
  el.detailsData.classList.remove("hidden");
  el.detailsData.innerHTML = cityDetailsHTML(city, graph, trucks);
}

// ---------------------------------------------------------------------
// Economy tab
//
// Chart design notes, since these decisions are load-bearing rather than
// cosmetic:
//  * Every trend here is a SINGLE series, so each gets one hue and no
//    legend - the title names it. The two hues (#b8802a money, #4780cc
//    operations) were picked by running them through a palette validator
//    against this panel's own surface (#1b212a): both sit inside the dark
//    lightness band, clear the chroma floor, hold ~24 dE separation under
//    protanopia/tritanopia, and pass 3:1 contrast.
//  * The cargo bars are ONE colour, not seven. A bar chart of "revenue by
//    cargo type" is a single measure, and giving each bar its own hue
//    would burn the colour channel re-encoding what bar length already
//    says. The cargo's own map colour appears as a small chip beside the
//    label instead, so identity still ties back to the map without the
//    quantitative encoding depending on it - which matters because the
//    cargo palette itself fails CVD separation (Flatbed vs Tanker are
//    only dE 11 apart even in normal vision).
//  * No hover tooltips: this panel is rebuilt every ~400ms while the sim
//    runs, so hover state cannot survive a refresh. Direct labels on the
//    endpoint and on every bar carry the same information statically.
// ---------------------------------------------------------------------
const CHART_MONEY = "#b8802a";
const CHART_OPS = "#4780cc";

// Ring-buffer samples arrive oldest-first as
// { min, earnings, contracts, avgSpeed, rolling }.
function seriesFrom(history, pick) {
  const out = [];
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1], b = history[i];
    const hours = (b.min - a.min) / 60;
    if (hours <= 0) continue;
    out.push(pick(a, b, hours));
  }
  return out;
}

// Centred moving average. Per-sample rates are genuinely spiky - a
// 15-game-minute window catches whatever handful of contracts happened to
// land in it - and an unsmoothed line renders as a hairball that hides the
// very trend the chart exists to show. The section is labelled "smoothed"
// so this isn't passed off as raw data.
function smooth(values, window = 5) {
  if (values.length < window) return values;
  const half = Math.floor(window / 2);
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) { sum += values[j]; n++; }
    out[i] = sum / n;
  }
  return out;
}

// A single-series sparkline: hairline baseline, soft area fill, 2px line,
// one endpoint marker, and a direct label only at that endpoint.
function sparkline(values, color, w = 240, h = 52) {
  if (values.length < 2) {
    return `<div class="chart-empty">gathering data…</div>`;
  }
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  if (max - min < 1e-9) { max = min + 1; }
  const pad = (max - min) * 0.12;
  min -= pad; max += pad;
  const x = (i) => (i / (values.length - 1)) * (w - 2) + 1;
  const y = (v) => h - 6 - ((v - min) / (max - min)) * (h - 14);
  let d = "", area = `M ${x(0)} ${h - 2}`;
  for (let i = 0; i < values.length; i++) {
    d += `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(values[i]).toFixed(1)} `;
    area += ` L ${x(i).toFixed(1)} ${y(values[i]).toFixed(1)}`;
  }
  area += ` L ${x(values.length - 1)} ${h - 2} Z`;
  const lastX = x(values.length - 1), lastY = y(values[values.length - 1]);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">
    <line x1="0" y1="${h - 2}" x2="${w}" y2="${h - 2}" class="spark-axis"/>
    <path d="${area}" fill="${color}" opacity="0.14"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4" fill="${color}"/>
  </svg>`;
}

function trendCard(title, values, color, currentText) {
  return `<div class="chart-card">
    <div class="chart-head"><span class="chart-title">${title}</span><span class="chart-now">${currentText}</span></div>
    ${sparkline(smooth(values), color)}
  </div>`;
}

// Horizontal bars: one hue, rounded outer end, 2px gaps, direct value on
// each row, and the cargo's map colour as an identity chip.
function barChart(rows, unitFmt, spotlight) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return rows.map((r) => {
    const pct = Math.max(1.5, (r.value / max) * 100);
    const on = spotlight === r.id;
    return `<div class="cargo-row${on ? " spotlit" : ""}" data-cargo="${r.id}" title="Tap to spotlight ${r.label} on the map">
      <span class="cargo-chip" style="background:${r.color}"></span>
      <span class="cargo-name">${r.label}</span>
      <span class="cargo-track"><span class="cargo-bar" style="width:${pct.toFixed(1)}%"></span></span>
      <span class="cargo-val">${unitFmt(r.value)}</span>
    </div>`;
  }).join("");
}

export function renderEconomyTab(trucks, graph, history, spotlight) {
  if (!trucks.length) { el.economy.innerHTML = ""; return; }

  preserveScroll(el.economy, () => {
    const revPerHr = seriesFrom(history, (a, b, h) => (b.earnings - a.earnings) / h);
    const conPerHr = seriesFrom(history, (a, b, h) => (b.contracts - a.contracts) / h);
    const speed = history.slice(1).map((s) => s.avgSpeed);
    const rolling = history.slice(1).map((s) => s.rolling);

    const last = (arr) => (arr.length ? arr[arr.length - 1] : 0);
    const money = (v) => "$" + Math.round(v).toLocaleString();

    // Per-cargo aggregates in one pass over the fleet.
    const agg = new Map();
    for (const t of trucks) {
      const tt = t.contract.truckType;
      let a = agg.get(tt.id);
      if (!a) { a = { id: tt.id, label: tt.label, color: tt.color, count: 0, payout: 0, earned: 0 }; agg.set(tt.id, a); }
      a.count++;
      a.payout += t.contract.payout;
      a.earned += t.earnings;
    }
    const byCount = [...agg.values()].map((a) => ({ ...a, value: a.count })).sort((x, y) => y.value - x.value);
    // Average payout per load, NOT total revenue - total would just
    // restate the fleet mix, whereas this answers "which freight is
    // actually worth hauling" independent of how many you run.
    const byPayout = [...agg.values()].map((a) => ({ ...a, value: a.payout / a.count })).sort((x, y) => y.value - x.value);

    el.economy.innerHTML = `
      <div class="section-label">Trends &mdash; last 48 sim hours, smoothed</div>
      <div class="chart-grid">
        ${trendCard("Revenue / hr", revPerHr, CHART_MONEY, money(last(revPerHr)) + "/hr")}
        ${trendCard("Contracts / hr", conPerHr, CHART_MONEY, last(conPerHr).toFixed(1) + "/hr")}
        ${trendCard("Fleet Avg Speed", speed, CHART_OPS, Math.round(last(speed)) + " mph")}
        ${trendCard("Trucks Rolling", rolling, CHART_OPS, Math.round(last(rolling)).toLocaleString())}
      </div>
      <div class="section-label">Fleet Mix &mdash; tap a cargo to spotlight it on the map</div>
      <div class="cargo-chart">${barChart(byCount, (v) => v.toLocaleString(), spotlight)}</div>
      <div class="section-label">Avg Payout per Load</div>
      <div class="cargo-chart">${barChart(byPayout, money, spotlight)}</div>
      ${spotlight ? `<div class="detail-sub" style="margin-top:10px">Spotlighting <strong style="color:var(--ink)">${agg.get(spotlight)?.label || spotlight}</strong> &mdash; tap it again to clear.</div>` : ""}
    `;
  });
}
