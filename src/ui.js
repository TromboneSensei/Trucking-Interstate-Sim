// ui.js - the bottom-sheet dispatch terminal. Plain functions over the
// current fleet/graph state, not a class with its own persistent copy of
// everything - main.js already owns that state and just calls in here
// to (re)render whenever something changes. Real CSS classes throughout
// (no inline-styled template strings).
"use strict";

const el = {
  sheet: document.getElementById("bottom-sheet"),
  handle: document.getElementById("sheet-handle"),
  tabs: document.querySelectorAll(".tab-btn"),
  overview: document.getElementById("tab-overview"),
  detailsEmpty: document.getElementById("details-empty"),
  detailsData: document.getElementById("details-data"),
};

let onSelectTruck = null;
let onToggleControl = null;
let drillKey = null; // null = overview + leader cards; a key (possibly "city:"-prefixed) = drilled into that ranking
let selectedCityName = null; // set once a city is picked out of a city ranking - replaces the Dispatch tab with that city's full page
let lastTrucks = [];
let lastGraph = null;

export function initUI(callbacks) {
  onSelectTruck = callbacks.onSelectTruck;
  onToggleControl = callbacks.onToggleControl;

  el.handle.addEventListener("click", () => el.sheet.classList.toggle("minimized"));
  el.tabs.forEach((btn) => {
    btn.addEventListener("click", () => openTab(btn.dataset.tab));
  });

  // Delegated: the overview tab's content is fully rebuilt on every
  // refresh, so its click targets are wired here once against the
  // stable parent rather than re-attached per render.
  el.overview.addEventListener("click", (e) => {
    const drillCard = e.target.closest("[data-drill]");
    const chip = e.target.closest("[data-chip]");
    const cityRow = e.target.closest("[data-city]");
    const back = e.target.closest("[data-back]");
    if (!drillCard && !chip && !cityRow && !back) return;

    if (drillCard) { drillKey = drillCard.dataset.drill; selectedCityName = null; }
    else if (chip) { drillKey = chip.dataset.chip; selectedCityName = null; }
    else if (cityRow) { selectedCityName = cityRow.dataset.city; }
    else if (selectedCityName) { selectedCityName = null; } // back out of a city page to its ranking list
    else { drillKey = null; } // back out of a ranking to the overview

    renderDispatchTab(lastTrucks, lastGraph);
    // Rebuilding the panel's innerHTML doesn't reset its own scroll
    // position, so navigating between overview/ranking/city views from
    // partway down the previous one left the new (shorter) content
    // starting mid-scroll instead of at its own top.
    el.overview.scrollTop = 0;
  });

  el.detailsData.addEventListener("click", (e) => {
    if (e.target.closest("[data-control-toggle]")) onToggleControl && onToggleControl();
  });
}

// Called when the sim restarts under new settings: the old fleet/graph
// this panel was showing (a drilldown, a selected city page, cached
// trucks/graph references) no longer apply to the fresh run.
export function resetUIState() {
  drillKey = null;
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

function metricCard(title, value, sub, tone) {
  const div = document.createElement("div");
  div.className = "metric-card" + (tone ? " " + tone : "");
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
// trucks happen to be driving on it.
function busiestCorridor(trucks) {
  const counts = new Map();
  for (const t of trucks) {
    if (!t.edge) continue;
    const key = [t.edge.from, t.edge.to].sort().join("|") + "|" + t.edge.route;
    const rec = counts.get(key) || { count: 0, edge: t.edge };
    rec.count++;
    counts.set(key, rec);
  }
  let best = null;
  for (const rec of counts.values()) if (!best || rec.count > best.count) best = rec;
  return best;
}

function shieldLabel(route) {
  return route.replace("US-", "US ").replace(" (West)", "").replace(" (East)", "");
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
  outbound: { label: "Most Outbound Traffic", dir: "desc", get: (c, trucks) => trucks.filter((t) => t.edge && t.edge.from === c.name).length, fmt: (v) => v, unit: " outbound" },
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
  el.overview.innerHTML = "";
  if (!trucks.length || !graph) return;

  if (selectedCityName) { renderCityPage(graph.nodes[selectedCityName], graph, trucks); return; }
  if (drillKey) { renderDrilldown(trucks, graph, drillKey); return; }

  const moving = trucks.filter((t) => t.edge);
  const avgSpeed = moving.length ? moving.reduce((s, t) => s + t.speed, 0) / moving.length : 0;
  const totalEarnings = trucks.reduce((s, t) => s + t.earnings, 0);
  const totalMiles = trucks.reduce((s, t) => s + t.totalMilesDriven, 0);
  const totalTrips = trucks.reduce((s, t) => s + t.contractsCompleted, 0);
  const cargoCounts = {};
  for (const t of trucks) cargoCounts[t.contract.truckType.label] = (cargoCounts[t.contract.truckType.label] || 0) + 1;
  const topType = Object.entries(cargoCounts).sort((a, b) => b[1] - a[1])[0];
  const corridor = busiestCorridor(trucks);

  const grid = document.createElement("div");
  grid.className = "metric-grid";
  grid.appendChild(metricCard("Active Fleet", trucks.length, `${moving.length} rolling`));
  grid.appendChild(metricCard("Network Speed", Math.round(avgSpeed) + " mph", "fleet average"));
  grid.appendChild(metricCard("Total Earnings", "$" + Math.round(totalEarnings).toLocaleString(), "all-time"));
  grid.appendChild(metricCard("Miles Logged", Math.round(totalMiles).toLocaleString(), "all-time"));
  grid.appendChild(metricCard("Contracts Done", totalTrips.toLocaleString(), "all-time"));
  grid.appendChild(metricCard("Top Cargo", topType ? topType[0] : "—", topType ? `${topType[1]} trucks` : ""));
  grid.appendChild(metricCard("Busiest Corridor", corridor ? shieldLabel(corridor.edge.route) : "—", corridor ? `near ${corridor.edge.control} • ${corridor.count} trucks` : "", "info"));
  el.overview.appendChild(grid);

  const fleetLabel = document.createElement("div");
  fleetLabel.className = "section-label";
  fleetLabel.textContent = "Fleet Leaderboards — tap to see the full ranking";
  el.overview.appendChild(fleetLabel);

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
  el.overview.appendChild(fleetGrid);

  const cityLabel = document.createElement("div");
  cityLabel.className = "section-label";
  cityLabel.textContent = "City Rankings — tap to see the full list";
  el.overview.appendChild(cityLabel);

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
  el.overview.appendChild(cityGrid);
}

function renderDrilldown(trucks, graph, key) {
  if (key.startsWith("city:")) { renderCityDrilldown(trucks, graph, key.slice(5)); return; }

  const stat = TRUCK_STATS[key];
  const header = document.createElement("div");
  header.className = "detail-header";
  header.style.marginTop = "2px";
  header.innerHTML = `<button class="pill-btn" data-back style="background:var(--panel-strong);color:var(--ink)">&larr; Back</button>
    <div class="detail-title" style="font-size:1rem;">${stat.label}</div><span></span>`;
  el.overview.appendChild(header);

  const chipRow = document.createElement("div");
  chipRow.className = "chip-row";
  for (const k in TRUCK_STATS) {
    const chip = document.createElement("button");
    chip.className = "chip" + (k === key ? " active" : "");
    chip.dataset.chip = k;
    chip.textContent = TRUCK_STATS[k].label;
    chipRow.appendChild(chip);
  }
  el.overview.appendChild(chipRow);

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
  el.overview.appendChild(list);
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
  el.overview.appendChild(header);

  const chipRow = document.createElement("div");
  chipRow.className = "chip-row";
  for (const k in CITY_STATS) {
    const chip = document.createElement("button");
    chip.className = "chip" + (k === key ? " active" : "");
    chip.dataset.chip = "city:" + k;
    chip.textContent = CITY_STATS[k].label;
    chipRow.appendChild(chip);
  }
  el.overview.appendChild(chipRow);

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
  el.overview.appendChild(list);
}

// The rich per-city page, embedded directly in the Dispatch tab in place
// of whichever city ranking the player drilled through to get here.
function renderCityPage(city, graph, trucks) {
  const header = document.createElement("div");
  header.className = "detail-header";
  header.style.marginTop = "2px";
  header.innerHTML = `<button class="pill-btn" data-back style="background:var(--panel-strong);color:var(--ink)">&larr; Back</button><span></span>`;
  el.overview.appendChild(header);

  const wrap = document.createElement("div");
  wrap.innerHTML = cityDetailsHTML(city, graph, trucks);
  el.overview.appendChild(wrap);
}

// Shared by the Dispatch-tab city page and the Unit-tab city view (via
// map tap) so both read from one accurate, consistently formatted source.
function cityDetailsHTML(city, graph, trucks) {
  const inbound = trucks.filter((t) => t.contract.destination === city.name);
  const outbound = trucks.filter((t) => t.edge && t.edge.from === city.name);
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

function renderTruckDetails(truck, isControlled) {
  el.detailsEmpty.classList.add("hidden");
  el.detailsData.classList.remove("hidden");
  const archetype = truck.driver.getArchetype();
  const etaMiles = etaMilesOf(truck);

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
    <div class="detail-sub" style="margin-bottom:10px;">${truck.currentNode} → <strong style="color:var(--ink)">${truck.contract.destination}</strong> &bull; ${Math.round(etaMiles)} mi remaining</div>
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
