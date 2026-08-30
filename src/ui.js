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
let drillKey = null; // null = overview + leader cards; a STATS key = drilled into that ranking
let lastTrucks = [];

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
    const back = e.target.closest("[data-back]");
    if (drillCard) { drillKey = drillCard.dataset.drill; renderDispatchTab(lastTrucks); }
    else if (chip) { drillKey = chip.dataset.chip; renderDispatchTab(lastTrucks); }
    else if (back) { drillKey = null; renderDispatchTab(lastTrucks); }
  });

  el.detailsData.addEventListener("click", (e) => {
    if (e.target.closest("[data-control-toggle]")) onToggleControl && onToggleControl();
  });
}

function openTab(name) {
  el.sheet.classList.remove("minimized");
  el.tabs.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".content-panel").forEach((p) => p.classList.remove("active"));
  document.getElementById(`tab-${name}`).classList.add("active");
}

// User explicitly tapped a truck/city: switch to the Details tab and render.
export function openDetailsFor(entity, kind, isControlled) {
  openTab("details");
  if (kind === "truck") renderTruckDetails(entity, isControlled);
  else renderCityDetails(entity);
}

// Per-frame refresh of the followed truck's numbers - does NOT switch
// tabs, so it stays live (speed/miles/ETA ticking) without yanking the
// player back to Details if they've navigated elsewhere.
export function refreshFollowedTruckDetails(truck, isControlled) {
  renderTruckDetails(truck, isControlled);
}

function metricCard(title, value, sub, tone) {
  const div = document.createElement("div");
  div.className = "metric-card" + (tone ? " " + tone : "");
  div.innerHTML = `<div class="metric-title">${title}</div><div class="metric-value">${value}</div><div class="metric-sub">${sub}</div>`;
  return div;
}

// Remaining distance to a truck's contract destination: the tail of its
// current edge plus every edge still queued in remainingPath.
function etaMilesOf(t) {
  return Math.max(0, t.edge ? t.edge.miles - t.s : 0) + t.remainingPath.reduce((s, e) => s + e.miles, 0);
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
const STATS = {
  earnings: { label: "Top Earners", dir: "desc", get: (t) => t.earnings, fmt: (v) => "$" + Math.round(v).toLocaleString(), unit: "" },
  speed: { label: "Fastest", dir: "desc", get: (t) => t.speed, fmt: (v) => Math.round(v), unit: " mph" },
  routeMiles: { label: "Longest Route", dir: "desc", get: (t) => t.contract.optimalMiles, fmt: (v) => Math.round(v).toLocaleString(), unit: " mi" },
  totalMiles: { label: "Most Miles", dir: "desc", get: (t) => t.totalMilesDriven, fmt: (v) => Math.round(v).toLocaleString(), unit: " mi" },
  trips: { label: "Most Trips", dir: "desc", get: (t) => t.contractsCompleted, fmt: (v) => v, unit: "" },
  etaMiles: { label: "Closest to Arrival", dir: "asc", get: (t) => etaMilesOf(t), fmt: (v) => Math.round(v).toLocaleString(), unit: " mi left" },
  payout: { label: "Highest Payout", dir: "desc", get: (t) => t.contract.payout, fmt: (v) => "$" + Math.round(v).toLocaleString(), unit: "" },
};

function sortedBy(trucks, key) {
  const stat = STATS[key];
  return [...trucks].sort((a, b) => stat.dir === "asc" ? stat.get(a) - stat.get(b) : stat.get(b) - stat.get(a));
}

function listRow(rank, mainText, subText, valueText, valueUnit, onClick) {
  const div = document.createElement("div");
  div.className = "list-row";
  div.innerHTML = `<div class="row-rank">${rank}</div>
    <div><div class="row-main">${mainText}</div><div class="row-sub">${subText}</div></div>
    <div class="row-value">${valueText}${valueUnit ? `<span class="row-value-unit">${valueUnit}</span>` : ""}</div>`;
  if (onClick) div.addEventListener("click", onClick);
  return div;
}

export function renderDispatchTab(trucks) {
  lastTrucks = trucks;
  el.overview.innerHTML = "";
  if (!trucks.length) return;

  if (drillKey) { renderDrilldown(trucks, drillKey); return; }

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

  const label = document.createElement("div");
  label.className = "section-label";
  label.textContent = "Leaderboards — tap to see the full ranking";
  el.overview.appendChild(label);

  const leaderGrid = document.createElement("div");
  leaderGrid.className = "metric-grid";
  for (const key in STATS) {
    const stat = STATS[key];
    const leader = sortedBy(trucks, key)[0];
    const card = document.createElement("div");
    card.className = "metric-card good";
    card.dataset.drill = key;
    card.innerHTML = `<div class="metric-title">${stat.label}</div><div class="metric-value">${stat.fmt(stat.get(leader))}${stat.unit}</div><div class="metric-sub">${leader.name}</div>`;
    leaderGrid.appendChild(card);
  }
  el.overview.appendChild(leaderGrid);
}

function renderDrilldown(trucks, key) {
  const stat = STATS[key];

  const header = document.createElement("div");
  header.className = "detail-header";
  header.style.marginTop = "2px";
  header.innerHTML = `<button class="pill-btn" data-back style="background:var(--panel-strong);color:var(--ink)">&larr; Back</button>
    <div class="detail-title" style="font-size:1rem;">${stat.label}</div><span></span>`;
  el.overview.appendChild(header);

  const chipRow = document.createElement("div");
  chipRow.className = "chip-row";
  for (const k in STATS) {
    const chip = document.createElement("button");
    chip.className = "chip" + (k === key ? " active" : "");
    chip.dataset.chip = k;
    chip.textContent = STATS[k].label;
    chipRow.appendChild(chip);
  }
  el.overview.appendChild(chipRow);

  const list = document.createElement("div");
  sortedBy(trucks, key).slice(0, 10).forEach((t, i) => {
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

function renderCityDetails(city) {
  el.detailsEmpty.classList.add("hidden");
  el.detailsData.classList.remove("hidden");
  el.detailsData.innerHTML = `
    <div class="detail-header">
      <div>
        <div class="detail-title">${city.name}</div>
        <div class="detail-sub">Tier ${city.t} • weight ${city.w}</div>
      </div>
    </div>
    <div class="detail-sub">${(city.ind || []).join(", ") || "No industry data"}</div>
  `;
}
