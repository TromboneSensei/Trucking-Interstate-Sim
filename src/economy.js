// economy.js - trimmed-down adaptation of the tycoon economy engine for a
// single-truck game: picks a cargo + truck type from the origin city's own
// `ind` industry tags (masterCities), rather than a separate profile table.
"use strict";

const TRUCK_TYPES = {
  DRYVAN: { id: "DRYVAN", label: "Dry Van", mult: 1.0, mpgMult: 1.0, cargo: ["General Freight", "Retail Goods", "Amazon Parcels", "Warehouse Pallets", "Mixed Consumer Goods"] },
  REEFER: { id: "REEFER", label: "Reefer", mult: 1.18, mpgMult: 0.88, cargo: ["Refrigerated Produce", "Frozen Foods", "Dairy", "Seafood", "Meat & Poultry"] },
  TANKER: { id: "TANKER", label: "Tanker", mult: 1.3, mpgMult: 0.9, cargo: ["Crude Oil", "Refined Fuel", "Bulk Chemicals", "Petroleum Products"] },
  FLATBED: { id: "FLATBED", label: "Flatbed", mult: 1.22, mpgMult: 0.93, cargo: ["Structural Steel", "Lumber", "Heavy Machinery", "Precast Concrete", "Pipe & Rebar"] },
  AUTO: { id: "AUTO", label: "Auto Hauler", mult: 1.2, mpgMult: 0.95, cargo: ["New Vehicles", "Auto Parts"] },
  TECH: { id: "TECH", label: "High-Value Van", mult: 1.3, mpgMult: 1.0, cargo: ["Servers & Electronics", "Medical Supplies", "Aerospace Components"] },
  LIVESTOCK: { id: "LIVESTOCK", label: "Livestock", mult: 1.15, mpgMult: 0.9, cargo: ["Cattle", "Livestock"] },
};

// industry tag (from masterCities[].ind) -> truck type key
const INDUSTRY_MAP = {
  Port: "DRYVAN", Container: "DRYVAN", Logistics: "DRYVAN", Distribution: "DRYVAN", "Air Cargo": "DRYVAN", Retail: "DRYVAN", "Retail HQ": "DRYVAN", "Grocer HQ": "DRYVAN",
  Ag: "REEFER", Produce: "REEFER", Citrus: "REEFER", Dairy: "REEFER", Seafood: "REEFER", Poultry: "REEFER", Wine: "REEFER", Fruit: "REEFER", Cotton: "REEFER", Corn: "REEFER", "Food Proc": "REEFER", Food: "REEFER",
  Oil: "TANKER", Energy: "TANKER", Refinery: "TANKER", Petrochem: "TANKER", Fuel: "TANKER", Chemicals: "TANKER", Refining: "TANKER", "Oil Shale": "TANKER",
  Steel: "FLATBED", Timber: "FLATBED", Mining: "FLATBED", "Heavy Machinery": "FLATBED", Coal: "FLATBED", Lumber: "FLATBED", Construction: "FLATBED", "Gold Mining": "FLATBED",
  Auto: "AUTO", Automotive: "AUTO", Jeep: "AUTO", "Auto Imports": "AUTO", "Auto Parts": "AUTO",
  Tech: "TECH", Chips: "TECH", Aero: "TECH", Aerospace: "TECH", Medical: "TECH", Pharma: "TECH", Defense: "TECH", Biotech: "TECH", Space: "TECH", Research: "TECH",
  Livestock: "LIVESTOCK", Cattle: "LIVESTOCK", Ranching: "LIVESTOCK",
};

function pickTruckTypeForCity(city) {
  const tags = (city && city.ind) || [];
  for (const tag of tags) {
    if (INDUSTRY_MAP[tag]) return TRUCK_TYPES[INDUSTRY_MAP[tag]];
  }
  return TRUCK_TYPES.DRYVAN;
}

function pickCargo(truckType, rnd) {
  const pool = truckType.cargo;
  return pool[Math.floor((rnd ? rnd() : Math.random()) * pool.length)];
}

// Builds a contract for the leg from `originName` to `destName`.
// optimalMiles: shortest-path distance used so payout is fixed at pickup,
// independent of however the player actually drives it.
function buildContract(originName, destName, optimalMiles, destTier) {
  const originCity = masterCities[originName];
  const truckType = pickTruckTypeForCity(originCity);
  const cargo = pickCargo(truckType);
  const tierMult = { 1: 1.35, 2: 1.15, 3: 1.0, 4: 0.85 }[destTier] || 1.0;
  const PAY_RATE_PER_MILE = 2.35;
  const payout = Math.round(optimalMiles * PAY_RATE_PER_MILE * truckType.mult * tierMult);
  return { cargo, truckType, payout, optimalMiles };
}
