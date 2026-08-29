// economy.js - contract generation: what a truck hauls, to where, and for
// how much. No persistent per-city market (that existed in the reference
// tycoon sim to keep ~10,000 trucks from dogpiling the same mega-hub; at
// the fleet sizes this build targets, generating one contract on demand
// is plenty). Cargo/truck-type flavor is driven by each city's own
// industry tags (masterCities[].ind) plus a small manual override table
// for well-known specialty cities, adapted from an earlier project's
// cargoProfiles.js.
import { masterCities } from "./data.js";
import { haversineMiles, findPath } from "./geo.js";

export const TRUCK_TYPES = {
    DRYVAN: { id: "DRYVAN", label: "Dry Van", color: "#e8ecef", multiplier: 1.0 },
    REEFER: { id: "REEFER", label: "Reefer", color: "#35c96b", multiplier: 1.18 },
    TANKER: { id: "TANKER", label: "Tanker", color: "#e0473c", multiplier: 1.3 },
    FLATBED: { id: "FLATBED", label: "Flatbed", color: "#d97706", multiplier: 1.22 },
    AUTO: { id: "AUTO", label: "Auto Hauler", color: "#3b82f6", multiplier: 1.2 },
    TECH: { id: "TECH", label: "High-Value Van", color: "#d946ef", multiplier: 1.3 },
    MILITARY: { id: "MILITARY", label: "Military", color: "#9ca3af", multiplier: 1.6 },
};

const INDUSTRIES = {
    CRUDE_OIL: { truck: "TANKER", label: "Crude Oil" },
    FUEL: { truck: "TANKER", label: "Refined Fuel" },
    CHEMICALS: { truck: "TANKER", label: "Industrial Chemicals" },
    PRODUCE: { truck: "REEFER", label: "Produce" },
    DAIRY: { truck: "REEFER", label: "Dairy" },
    MEAT: { truck: "REEFER", label: "Meat & Poultry" },
    STEEL: { truck: "FLATBED", label: "Steel" },
    MACHINERY: { truck: "FLATBED", label: "Machinery" },
    TIMBER: { truck: "FLATBED", label: "Lumber" },
    CARS: { truck: "AUTO", label: "New Vehicles" },
    AUTO_PARTS: { truck: "DRYVAN", label: "Auto Parts" },
    ELECTRONICS: { truck: "TECH", label: "Electronics" },
    AEROSPACE: { truck: "TECH", label: "Aerospace Components" },
    MEDICAL: { truck: "TECH", label: "Medical Supplies" },
    IMPORTS: { truck: "DRYVAN", label: "Imported Goods" },
    EXPRESS: { truck: "DRYVAN", label: "Express Freight" },
    MILITARY: { truck: "MILITARY", label: "Military Cargo" },
    GENERAL: { truck: "DRYVAN", label: "General Freight" },
};

const GENERAL_CARGO_POOL = [
    "General Freight", "Retail Goods", "Amazon Parcels", "Warehouse Pallets",
    "Packaged Consumer Goods", "Furniture", "Building Supplies", "Paper Products",
    "Household Appliances", "Office Supplies", "Clothing & Textiles", "Hardware",
];

// Manual overrides for cities whose real-world specialty is worth calling
// out by name rather than leaving to tag-based auto-generation.
const SPECIALIZED = {
    "San Jose": [["ELECTRONICS", 90], ["GENERAL", 10]],
    "Austin": [["ELECTRONICS", 60], ["AUTO_PARTS", 15], ["GENERAL", 25]],
    "Phoenix": [["ELECTRONICS", 55], ["GENERAL", 45]],
    "Midland": [["CRUDE_OIL", 90], ["GENERAL", 10]],
    "Odessa": [["CRUDE_OIL", 90], ["GENERAL", 10]],
    "Williston": [["CRUDE_OIL", 85], ["GENERAL", 15]],
    "Bakersfield": [["CRUDE_OIL", 45], ["PRODUCE", 30], ["GENERAL", 25]],
    "Casper": [["CRUDE_OIL", 60], ["GENERAL", 40]],
    "Billings": [["CRUDE_OIL", 45], ["GENERAL", 55]],
    "Houston": [["FUEL", 55], ["IMPORTS", 20], ["CHEMICALS", 15], ["GENERAL", 10]],
    "Baton Rouge": [["FUEL", 55], ["CHEMICALS", 15], ["GENERAL", 30]],
    "Lake Charles": [["FUEL", 60], ["CHEMICALS", 15], ["GENERAL", 25]],
    "Fresno": [["PRODUCE", 70], ["DAIRY", 10], ["GENERAL", 20]],
    "Boise": [["PRODUCE", 60], ["GENERAL", 40]],
    "Yakima": [["PRODUCE", 75], ["GENERAL", 25]],
    "Twin Falls": [["DAIRY", 65], ["GENERAL", 35]],
    "Orlando": [["PRODUCE", 55], ["GENERAL", 45]],
    "Tampa": [["PRODUCE", 45], ["IMPORTS", 15], ["GENERAL", 40]],
    "Amarillo": [["MEAT", 60], ["GENERAL", 40]],
    "Sioux Falls": [["MEAT", 60], ["GENERAL", 40]],
    "Omaha": [["MEAT", 55], ["GENERAL", 45]],
    "Detroit": [["CARS", 50], ["AUTO_PARTS", 25], ["STEEL", 10], ["GENERAL", 15]],
    "Pittsburgh": [["STEEL", 60], ["GENERAL", 40]],
    "Gary": [["STEEL", 65], ["GENERAL", 35]],
    "Wichita": [["AEROSPACE", 55], ["MACHINERY", 25], ["GENERAL", 20]],
    "Seattle": [["AEROSPACE", 45], ["ELECTRONICS", 25], ["IMPORTS", 15], ["GENERAL", 15]],
    "San Diego": [["MILITARY", 45], ["IMPORTS", 20], ["GENERAL", 35]],
    "Norfolk": [["MILITARY", 55], ["IMPORTS", 20], ["GENERAL", 25]],
    "Fayetteville": [["MILITARY", 55], ["GENERAL", 45]],
    "Killeen": [["MILITARY", 55], ["GENERAL", 45]],
    "Colorado Springs": [["MILITARY", 45], ["AEROSPACE", 20], ["GENERAL", 35]],
    "Huntsville": [["AEROSPACE", 40], ["MILITARY", 35], ["GENERAL", 25]],
    "Los Angeles": [["IMPORTS", 55], ["ELECTRONICS", 20], ["GENERAL", 25]],
    "Long Beach": [["IMPORTS", 65], ["FUEL", 10], ["GENERAL", 25]],
    "Newark": [["IMPORTS", 55], ["EXPRESS", 15], ["GENERAL", 30]],
    "Miami": [["IMPORTS", 45], ["PRODUCE", 20], ["GENERAL", 35]],
    "Savannah": [["IMPORTS", 55], ["GENERAL", 45]],
    "Louisville": [["EXPRESS", 50], ["CARS", 15], ["GENERAL", 35]],
    "Memphis": [["EXPRESS", 55], ["MEDICAL", 10], ["GENERAL", 35]],
};

const TAG_RULES = [
    ["Oil", "CRUDE_OIL", 75],
    ["Refinery", "FUEL", 30],
    ["Ag", "PRODUCE", 55],
    ["Dairy", "DAIRY", 60],
    ["Tech", "ELECTRONICS", 45],
    ["Port", "IMPORTS", 55],
    ["Steel", "STEEL", 45],
    ["Aerospace", "AEROSPACE", 45],
    ["Logistics", "EXPRESS", 35],
    ["Medical", "MEDICAL", 35],
];
const TAG_MILITARY = ["Military", "Defense", "AFB"];
const TIER_FALLBACK_WEIGHT = { 0: 1, 1: 80, 2: 50, 3: 25, 4: 5 };

function normalize(list) {
    const total = list.reduce((s, e) => s + e[1], 0) || 1;
    return list.map(([t, w]) => ({ t, w: w / total }));
}

function buildCityProfiles() {
    const profiles = {};
    for (const city in masterCities) {
        if (SPECIALIZED[city]) {
            profiles[city] = normalize(SPECIALIZED[city]);
            continue;
        }
        const tags = masterCities[city].ind || [];
        const tier = masterCities[city].t;
        const exports = [];
        for (const [tag, industry, weight] of TAG_RULES) {
            if (tags.includes(tag)) exports.push([industry, weight]);
        }
        if (TAG_MILITARY.some((t) => tags.includes(t))) exports.push(["MILITARY", 55]);
        exports.push(["GENERAL", TIER_FALLBACK_WEIGHT[tier] ?? 5]);
        profiles[city] = normalize(exports);
    }
    return profiles;
}

const CITY_PROFILES = buildCityProfiles();

function weightedPick(list, weightFn, rnd) {
    const total = list.reduce((s, x) => s + weightFn(x), 0);
    let r = rnd() * total;
    for (const item of list) {
        r -= weightFn(item);
        if (r <= 0) return item;
    }
    return list[list.length - 1];
}

function pickCargo(cityName, rnd) {
    const profile = CITY_PROFILES[cityName] || CITY_PROFILES.GENERAL;
    const pick = weightedPick(profile, (e) => e.w, rnd);
    const industry = INDUSTRIES[pick.t];
    const cargo = pick.t === "GENERAL"
        ? GENERAL_CARGO_POOL[Math.floor(rnd() * GENERAL_CARGO_POOL.length)]
        : industry.label;
    return { cargo, truckType: TRUCK_TYPES[industry.truck] };
}

// Gravity-weighted destination pick: bigger/closer cities are more likely,
// with a trip-length dice roll (short/medium/long) so the fleet doesn't
// only ever run short hops or only ever run cross-country ones.
function pickDestination(graph, originName, rnd) {
    const origin = graph.nodes[originName];
    const tripRoll = rnd();
    const candidates = [];
    let totalWeight = 0;

    for (const name in graph.nodes) {
        if (name === originName) continue;
        const node = graph.nodes[name];
        if (node.t === 0) continue; // pure junction filler nodes aren't real destinations
        if (!graph.adjacency[name] || !graph.adjacency[name].length) continue; // a handful of data-entry cities never got wired into any route
        const miles = haversineMiles(origin, node);

        if (tripRoll < 0.4 && miles >= 500) continue;
        if (tripRoll >= 0.4 && tripRoll < 0.75 && (miles < 300 || miles > 1400)) continue;
        if (tripRoll >= 0.75 && miles <= 1400) continue;

        let gravity = node.w;
        if (node.w < 4) gravity *= 1.4; // give small towns a fighting chance
        const distanceFriction = 1 / Math.sqrt(1 + miles / 800);
        const score = gravity * distanceFriction * (0.85 + rnd() * 0.3);
        if (score > 0.0001) {
            candidates.push({ name, score });
            totalWeight += score;
        }
    }

    if (!candidates.length) {
        const names = Object.keys(graph.nodes).filter((n) => n !== originName);
        return names[Math.floor(rnd() * names.length)];
    }
    let roll = rnd() * totalWeight;
    for (const c of candidates) {
        roll -= c.score;
        if (roll <= 0) return c.name;
    }
    return candidates[candidates.length - 1].name;
}

const PAY_RATE_PER_MILE = 2.35;
const TIER_PAY_MULT = { 1: 1.35, 2: 1.15, 3: 1.0, 4: 0.85 };

// Generates one full contract for a truck sitting at `originName`: a
// destination, cargo, truck type, its A* route, and a payout fixed now
// (based on optimal distance) so a detour later costs the driver real
// fuel/time without changing what the job pays.
export function generateContract(graph, originName, rnd = Math.random) {
    const destination = pickDestination(graph, originName, rnd);
    const path = findPath(graph, originName, destination);
    const optimalMiles = path ? path.reduce((s, e) => s + e.miles, 0) : haversineMiles(graph.nodes[originName], graph.nodes[destination]);
    const { cargo, truckType } = pickCargo(originName, rnd);
    const tierMult = TIER_PAY_MULT[graph.nodes[destination].t] ?? 1;
    const payout = Math.round(optimalMiles * PAY_RATE_PER_MILE * truckType.multiplier * tierMult);
    return { destination, cargo, truckType, optimalMiles, payout, path };
}
