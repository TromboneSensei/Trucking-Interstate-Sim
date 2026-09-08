// wizard-ui.js - the company creation wizard (Phase 12). One full-screen
// overlay, four steps (Name / Truck / Home Base / Logo), reusing the exact
// shape #truckstop-overlay already established (career-ui.js's own
// convention: one module owns one full-screen panel). This module owns NO
// game state beyond its own in-progress wizard draft - the actual Truck/
// career creation happens in main.js's onComplete handler, mirroring how
// career.js's confirmHire/main.js's handleHireDriver split hiring.
"use strict";

import { masterCities } from "./data.js";
import { traitSummary } from "./driver.js";
import * as career from "./career.js";

const wizEl = {
  overlay: document.getElementById("wizard-overlay"),
  title: document.getElementById("wizard-title"),
  stepSub: document.getElementById("wizard-step-sub"),
  tabs: document.getElementById("wizard-tabs"),
  content: document.getElementById("wizard-content"),
  btnClose: document.getElementById("btn-wizard-close"),
  btnBack: document.getElementById("btn-wizard-back"),
  btnNext: document.getElementById("btn-wizard-next"),
};

const STEPS = ["Name", "Truck", "Home Base", "Logo"];
const TIER_LABELS = { 1: "Major Hub", 2: "Regional", 3: "Secondary", 4: "Local" };

let onComplete = null;
let step = 0;
let wiz = null; // { companyName, candidate: {driver, city}, homeBaseCity, homeBasePicker: {search,tierFilter}, logo: {color,glyph} }

// The Truck step's "Starting City" button and FLEET's own "Change Home
// Base" setting both open the SAME picker UI standalone (no wizard step
// around it) rather than a second implementation - `standaloneMode`
// controls whether Cancel/a pick closes the whole overlay (external entry)
// or just returns to the step underneath it (internal entry from step 1).
let subPicker = null; // { title, currentCity, search, tierFilter, onSelect } | null
let standaloneMode = false;

function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------
// City picker - shared markup builders. Used by the Home Base step
// (embedded directly as that step's content) and by every standalone/
// sub-picker use (the Truck step's "Starting City", FLEET's "Change Home
// Base") via the exact same functions, so there is only one place that
// knows how to render or filter the list.
// ---------------------------------------------------------------------
function tierChipsHTML(tierFilter) {
  return [1, 2, 3, 4].map((t) =>
    `<button class="chip${tierFilter === t ? " active" : ""}" data-picker-tier="${t}">${TIER_LABELS[t]}</button>`
  ).join("");
}

function cityRowsHTML(search, tierFilter, currentCity) {
  const s = (search || "").toLowerCase();
  const list = Object.entries(masterCities)
    .filter(([name, c]) => c.t > 0 && (!tierFilter || c.t === tierFilter) && name.toLowerCase().includes(s))
    .sort((a, b) => b[1].w - a[1].w)
    .slice(0, 60);
  if (!list.length) return `<div class="placeholder-text">No cities match.</div>`;
  return list.map(([name, c]) => `
    <div class="city-row${name === currentCity ? " selected" : ""}" data-city="${name}">
      <span class="city-name">${name}</span>
      <span class="city-tier">${TIER_LABELS[c.t]}${c.ind && c.ind.length ? " &bull; " + c.ind.slice(0, 2).join(", ") : ""}</span>
    </div>`).join("");
}

function cityPickerBodyHTML(search, tierFilter, currentCity) {
  return `
    <div class="city-search-row"><input type="text" id="wizard-city-search" class="wizard-text-input" placeholder="Search cities…" value="${escAttr(search || "")}"></div>
    <div class="chip-row" id="wizard-city-tiers">${tierChipsHTML(tierFilter)}</div>
    <div class="city-list" id="wizard-city-results">${cityRowsHTML(search, tierFilter, currentCity)}</div>
  `;
}

function refreshCityResults(search, tierFilter, currentCity) {
  const tiersEl = document.getElementById("wizard-city-tiers");
  const resultsEl = document.getElementById("wizard-city-results");
  if (tiersEl) tiersEl.innerHTML = tierChipsHTML(tierFilter);
  if (resultsEl) resultsEl.innerHTML = cityRowsHTML(search, tierFilter, currentCity);
}

function refreshHomeBaseResults() {
  refreshCityResults(wiz.homeBasePicker.search, wiz.homeBasePicker.tierFilter, wiz.homeBaseCity);
}
function refreshSubPickerResults() {
  refreshCityResults(subPicker.search, subPicker.tierFilter, subPicker.currentCity);
}

// Opens the picker without any wizard step around it - Cancel or a pick
// closes the whole overlay rather than returning to a step. This is the
// entry point FLEET's "Change Home Base" setting uses directly.
export function openStandaloneCityPicker({ title, currentCity, onSelect }) {
  standaloneMode = true;
  subPicker = { title, currentCity, search: "", tierFilter: null, onSelect };
  wizEl.overlay.classList.remove("hidden");
  render();
}

// Opens the same picker AS a sub-step of the wizard (the Truck step's
// "Starting City" button) - Cancel returns to that step instead of
// closing the overlay.
function openSubPicker({ title, currentCity, onSelect }) {
  subPicker = { title, currentCity, search: "", tierFilter: null, onSelect };
  render();
}

// ---------------------------------------------------------------------
// Step content
// ---------------------------------------------------------------------
function renderNameStep() {
  wizEl.content.innerHTML = `
    <div class="section-label">Company Name</div>
    <input type="text" id="wizard-name-input" class="wizard-text-input" placeholder="e.g. Blue Ridge Freight" value="${escAttr(wiz.companyName)}" maxlength="40">
    <div class="row-sub" style="margin-top:8px;">Shown on your FLEET header, the map beacon, and your logo's default monogram.</div>
  `;
  document.getElementById("wizard-name-input").addEventListener("input", (e) => {
    wiz.companyName = e.target.value;
    wizEl.btnNext.disabled = !stepValid(step);
  });
}

function renderTruckStep() {
  const traits = traitSummary(wiz.candidate.driver).map((t) =>
    `<span class="chip active" style="cursor:default;background:${t.color};border-color:${t.color};">${t.label}</span>`
  ).join("") || `<span class="row-sub">No standout traits - a steady, ordinary driver.</span>`;
  const d = wiz.candidate.driver;
  const cityLabel = wiz.candidate.city || "Not set - defaults to your Home Base";
  wizEl.content.innerHTML = `
    <div class="section-label">Starting Driver</div>
    <div class="vendor-item" style="cursor:default;">
      <span class="v-name">Candidate</span>
      <div class="chip-row" style="margin:4px 0;">${traits}</div>
      <span class="v-desc">Skill ${Math.round(d.skill * 100)}% &bull; Aggression ${Math.round(d.aggression * 100)}% &bull; Hustle ${Math.round(d.hustle * 100)}%</span>
    </div>
    <div class="vendor-grid" style="margin-top:10px;">
      <button class="vendor-item" data-action="reroll-candidate">
        <span class="v-name">Different Candidate</span>
        <span class="v-desc">Free - roll a new driver</span>
      </button>
      <button class="vendor-item" data-action="choose-truck-city">
        <span class="v-name">Starting City</span>
        <span class="v-desc">${cityLabel}</span>
      </button>
    </div>
  `;
}

function renderHomeBaseStep() {
  wizEl.content.innerHTML = `
    <div class="section-label">Home Base</div>
    <div class="row-sub" style="margin-bottom:8px;">Shown on your FLEET header and RIG tab - purely cosmetic, free to change later in FLEET settings.</div>
    ${cityPickerBodyHTML(wiz.homeBasePicker.search, wiz.homeBasePicker.tierFilter, wiz.homeBaseCity)}
  `;
}

function effectiveWizLogo() {
  return {
    color: wiz.logo.color,
    glyph: wiz.logo.glyph,
    monogram: career.deriveMonogram(wiz.companyName) || "CO",
  };
}

function renderLogoStep() {
  const logo = effectiveWizLogo();
  const swatches = career.LOGO_PALETTE.map((p) =>
    `<button class="logo-swatch${wiz.logo.color === p.color ? " active" : ""}" data-action="wiz-logo-color" data-arg="${p.color}" title="${p.label}" style="background:${p.color};"></button>`
  ).join("");
  const glyphButtons = career.LOGO_GLYPHS.map((g) =>
    `<button class="logo-glyph-btn${wiz.logo.glyph === g ? " active" : ""}" data-action="wiz-logo-glyph" data-arg="${g}">${g}</button>`
  ).join("");
  const monogramButton = `<button class="logo-glyph-btn${!wiz.logo.glyph ? " active" : ""}" data-action="wiz-logo-glyph" data-arg="" title="Use your monogram instead">${logo.monogram}</button>`;
  wizEl.content.innerHTML = `
    <div class="section-label">Company Logo</div>
    <div class="logo-picker-row">
      <div class="company-badge" style="width:48px;height:48px;font-size:24px;background:${logo.color};">${logo.glyph || logo.monogram}</div>
      <div class="logo-picker-groups">
        <div class="logo-swatch-row">${swatches}</div>
        <div class="logo-glyph-row">${glyphButtons}${monogramButton}</div>
      </div>
    </div>
    <div class="row-sub" style="margin-top:10px;">This same badge appears on your FLEET header and as the map beacon over every company truck.</div>
  `;
}

function renderSubPickerContent() {
  wizEl.content.innerHTML = cityPickerBodyHTML(subPicker.search, subPicker.tierFilter, subPicker.currentCity);
}

function handleContentAction(action, arg) {
  if (action === "reroll-candidate") {
    wiz.candidate.driver = career.rollHireCandidate();
    render();
  } else if (action === "choose-truck-city") {
    openSubPicker({
      title: "Starting City",
      currentCity: wiz.candidate.city,
      onSelect: (city) => { wiz.candidate.city = city; render(); },
    });
  } else if (action === "wiz-logo-color") {
    wiz.logo.color = arg;
    render();
  } else if (action === "wiz-logo-glyph") {
    wiz.logo.glyph = arg || null;
    render();
  }
}

// ---------------------------------------------------------------------
// Step validity, navigation, top-level render
// ---------------------------------------------------------------------
function stepValid(s) {
  if (s === 0) return (wiz.companyName || "").trim().length > 0;
  if (s === 2) return !!wiz.homeBaseCity;
  return true; // Truck (a candidate always exists once the wizard is open) and Logo (defaults are always valid) never block Next
}

function renderTabs() {
  if (standaloneMode) { wizEl.tabs.innerHTML = ""; return; }
  wizEl.tabs.innerHTML = STEPS.map((label, i) =>
    `<button class="vendor-tab-btn${i === step ? " active" : ""}" data-step="${i}">${label}</button>`
  ).join("");
}

function renderFooter() {
  if (subPicker) {
    wizEl.btnBack.textContent = "← Cancel";
    wizEl.btnBack.classList.remove("hidden");
    wizEl.btnBack.disabled = false;
    wizEl.btnNext.classList.add("hidden");
    return;
  }
  wizEl.btnBack.textContent = "← Back";
  wizEl.btnBack.classList.toggle("hidden", step === 0);
  wizEl.btnNext.classList.remove("hidden");
  wizEl.btnNext.textContent = step === STEPS.length - 1 ? "Finish" : "Next →";
  wizEl.btnNext.disabled = !stepValid(step);
}

function render() {
  renderTabs();
  if (subPicker) {
    wizEl.title.textContent = subPicker.title;
    wizEl.stepSub.textContent = "";
    renderSubPickerContent();
    renderFooter();
    return;
  }
  wizEl.title.textContent = (wiz?.companyName || "").trim() || "Start Your Company";
  wizEl.stepSub.textContent = `Step ${step + 1} of ${STEPS.length} — ${STEPS[step]}`;
  if (step === 0) renderNameStep();
  else if (step === 1) renderTruckStep();
  else if (step === 2) renderHomeBaseStep();
  else renderLogoStep();
  renderFooter();
}

function finish() {
  const result = {
    companyName: wiz.companyName.trim(),
    driver: wiz.candidate.driver,
    truckHomeCity: wiz.candidate.city || wiz.homeBaseCity,
    homeBaseCity: wiz.homeBaseCity,
    logo: { ...wiz.logo, monogram: career.deriveMonogram(wiz.companyName.trim()) },
  };
  closeWizard();
  if (onComplete) onComplete(result);
}

export function openWizard() {
  wiz = {
    companyName: "",
    candidate: { driver: career.rollHireCandidate(), city: null },
    homeBaseCity: null,
    homeBasePicker: { search: "", tierFilter: null },
    logo: { color: career.LOGO_PALETTE[0].color, glyph: null },
  };
  step = 0;
  subPicker = null;
  standaloneMode = false;
  wizEl.overlay.classList.remove("hidden");
  render();
}

export function closeWizard() {
  wizEl.overlay.classList.add("hidden");
  subPicker = null;
  standaloneMode = false;
}

export function initWizardUI(callbacks) {
  onComplete = callbacks.onComplete;

  wizEl.btnClose.addEventListener("click", closeWizard);

  wizEl.tabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-step]");
    if (!btn) return;
    subPicker = null;
    step = parseInt(btn.dataset.step, 10);
    render();
  });

  wizEl.btnBack.addEventListener("click", () => {
    if (subPicker) {
      subPicker = null;
      if (standaloneMode) { standaloneMode = false; closeWizard(); return; }
      render();
      return;
    }
    if (step > 0) { step--; render(); }
  });

  wizEl.btnNext.addEventListener("click", () => {
    if (step === STEPS.length - 1) { finish(); return; }
    step++;
    render();
  });

  wizEl.content.addEventListener("input", (e) => {
    if (e.target.id !== "wizard-city-search") return;
    if (subPicker) { subPicker.search = e.target.value; refreshSubPickerResults(); }
    else if (step === 2) { wiz.homeBasePicker.search = e.target.value; refreshHomeBaseResults(); }
  });

  wizEl.content.addEventListener("click", (e) => {
    const tierBtn = e.target.closest("[data-picker-tier]");
    if (tierBtn) {
      const t = parseInt(tierBtn.dataset.pickerTier, 10);
      if (subPicker) { subPicker.tierFilter = subPicker.tierFilter === t ? null : t; refreshSubPickerResults(); }
      else if (step === 2) { wiz.homeBasePicker.tierFilter = wiz.homeBasePicker.tierFilter === t ? null : t; refreshHomeBaseResults(); }
      return;
    }
    const cityRow = e.target.closest("[data-city]");
    if (cityRow) {
      const city = cityRow.dataset.city;
      if (subPicker) {
        const cb = subPicker.onSelect;
        const wasStandalone = standaloneMode;
        subPicker = null;
        if (wasStandalone) { standaloneMode = false; closeWizard(); }
        cb(city);
        return;
      }
      if (step === 2) {
        wiz.homeBaseCity = city;
        refreshHomeBaseResults();
        wizEl.btnNext.disabled = !stepValid(step);
        return;
      }
      return;
    }
    const btn = e.target.closest("[data-action]");
    if (btn) handleContentAction(btn.dataset.action, btn.dataset.arg);
  });
}
