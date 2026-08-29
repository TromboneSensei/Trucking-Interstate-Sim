// ui.js - the bottom-sheet dashboard. Plain functions over the current
// fleet/graph state, not a class with its own persistent copy of
// everything - main.js already owns that state and just calls in here
// to (re)render whenever something changes. Real CSS classes throughout
// (no inline-styled template strings).
"use strict";

const el = {
  sheet: document.getElementById("bottom-sheet"),
  handle: document.getElementById("sheet-handle"),
  tabs: document.querySelectorAll(".tab-btn"),
  overview: document.getElementById("tab-overview"),
  fleet: document.getElementById("tab-fleet"),
  detailsEmpty: document.getElementById("details-empty"),
  detailsData: document.getElementById("details-data"),
};

let onSelectTruck = null;

export function initUI(callbacks) {
  onSelectTruck = callbacks.onSelectTruck;

  el.handle.addEventListener("click", () => el.sheet.classList.toggle("minimized"));
  el.tabs.forEach((btn) => {
    btn.addEventListener("click", () => openTab(btn.dataset.tab));
  });
}

function openTab(name) {
  el.sheet.classList.remove("minimized");
  el.tabs.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".content-panel").forEach((p) => p.classList.remove("active"));
  document.getElementById(`tab-${name}`).classList.add("active");
}

export function openDetailsFor(entity, kind) {
  openTab("details");
  if (kind === "truck") renderTruckDetails(entity);
  else renderCityDetails(entity);
}

function metricCard(title, value, sub) {
  const div = document.createElement("div");
  div.className = "metric-card";
  div.innerHTML = `<div class="metric-title">${title}</div><div class="metric-value">${value}</div><div class="metric-sub">${sub}</div>`;
  return div;
}

export function renderOverview(trucks) {
  el.overview.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "metric-grid";

  const moving = trucks.filter((t) => t.edge);
  const avgSpeed = moving.length ? moving.reduce((s, t) => s + t.speed, 0) / moving.length : 0;
  const totalEarnings = trucks.reduce((s, t) => s + t.earnings, 0);
  const totalMiles = trucks.reduce((s, t) => s + t.totalMilesDriven, 0);

  const cargoCounts = {};
  for (const t of trucks) cargoCounts[t.contract.truckType.label] = (cargoCounts[t.contract.truckType.label] || 0) + 1;
  const topType = Object.entries(cargoCounts).sort((a, b) => b[1] - a[1])[0];

  grid.appendChild(metricCard("Active Fleet", trucks.length, `${moving.length} rolling`));
  grid.appendChild(metricCard("Network Speed", Math.round(avgSpeed) + " mph", "fleet average"));
  grid.appendChild(metricCard("Total Earnings", "$" + Math.round(totalEarnings).toLocaleString(), "all-time"));
  grid.appendChild(metricCard("Miles Logged", Math.round(totalMiles).toLocaleString(), "all-time"));
  grid.appendChild(metricCard("Top Cargo", topType ? topType[0] : "—", topType ? `${topType[1]} trucks` : ""));

  el.overview.appendChild(grid);
}

function listRow(mainText, subText, valueText, onClick) {
  const div = document.createElement("div");
  div.className = "list-row";
  div.innerHTML = `<div><div class="row-main">${mainText}</div><div class="row-sub">${subText}</div></div><div class="row-value">${valueText}</div>`;
  if (onClick) div.addEventListener("click", onClick);
  return div;
}

export function renderFleetTab(trucks) {
  el.fleet.innerHTML = "";
  if (!trucks.length) return;

  const section = (title, sorted, valueFn) => {
    const header = document.createElement("div");
    header.className = "metric-title";
    header.style.margin = "10px 2px 6px";
    header.textContent = title;
    el.fleet.appendChild(header);
    for (const t of sorted.slice(0, 5)) {
      el.fleet.appendChild(listRow(
        t.name,
        `${t.currentNode} → ${t.contract.destination}`,
        valueFn(t),
        () => onSelectTruck && onSelectTruck(t)
      ));
    }
  };

  section("Top Earners", [...trucks].sort((a, b) => b.earnings - a.earnings), (t) => "$" + Math.round(t.earnings).toLocaleString());
  section("Fastest Right Now", [...trucks].sort((a, b) => b.speed - a.speed), (t) => Math.round(t.speed) + " mph");
  section("Longest Haul", [...trucks].sort((a, b) => b.contract.optimalMiles - a.contract.optimalMiles), (t) => Math.round(t.contract.optimalMiles) + " mi");
}

function statBar(label, value01, color) {
  return `<div class="stat-bar-row">
    <div class="stat-bar-label"><span>${label}</span><span>${Math.round(value01 * 100)}%</span></div>
    <div class="stat-bar"><div class="stat-bar-fill" style="width:${value01 * 100}%;background:${color}"></div></div>
  </div>`;
}

function renderTruckDetails(truck) {
  el.detailsEmpty.classList.add("hidden");
  el.detailsData.classList.remove("hidden");
  const archetype = truck.driver.getArchetype();
  const etaMiles = Math.max(0, truck.edge ? truck.edge.miles - truck.s : 0) + truck.remainingPath.reduce((s, e) => s + e.miles, 0);

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
    <div class="metric-grid" style="margin-bottom:12px;">
      <div class="metric-card"><div class="metric-title">Speed</div><div class="metric-value">${Math.round(truck.speed)} mph</div></div>
      <div class="metric-card"><div class="metric-title">Payout</div><div class="metric-value">$${truck.contract.payout.toLocaleString()}</div></div>
      <div class="metric-card"><div class="metric-title">Earnings</div><div class="metric-value">$${Math.round(truck.earnings).toLocaleString()}</div></div>
    </div>
    ${statBar("Aggression", truck.driver.aggression, "var(--bad)")}
    ${statBar("Skill", truck.driver.skill, "var(--blue)")}
    ${statBar("Hustle", truck.driver.hustle, "var(--good)")}
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
