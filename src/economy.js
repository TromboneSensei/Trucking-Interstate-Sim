// economy.js - contract generation: what a truck hauls, to where, and for
// how much. No persistent per-city market and no inventory: a contract is
// generated on demand when a truck is free, driven, paid out, done. The
// "supply chain" is deliberately two links long - a city produces, a city
// receives - which is all the simulation needs to feel alive.
//
// WHAT a city ships comes from products.js (85 named products, 252 city
// export profiles), not from the industry tags directly. The tags in
// data.js seeded that file but are no longer consulted at runtime for
// cargo, because only 10 of ~180 distinct tags were ever wired up, which
// left 60% of cities generating nothing but generic dry freight.
//
// The one exception where tags ARE still read is MILITARY_CITIES below,
// which powers the destination bias for military loads.
import { masterCities } from "./data.js";
import { haversineMiles, findPath, routeClassOf } from "./geo.js";
import { PRODUCTS, CITY_EXPORTS } from "./products.js";

export const TRUCK_TYPES = {
    DRYVAN: { id: "DRYVAN", label: "Dry Van", color: "#e8ecef", multiplier: 1.0 },
    REEFER: { id: "REEFER", label: "Reefer", color: "#35c96b", multiplier: 1.18 },
    TANKER: { id: "TANKER", label: "Tanker", color: "#e0473c", multiplier: 1.3 },
    FLATBED: { id: "FLATBED", label: "Flatbed", color: "#d97706", multiplier: 1.22 },
    AUTO: { id: "AUTO", label: "Auto Hauler", color: "#3b82f6", multiplier: 1.2 },
    TECH: { id: "TECH", label: "High-Value Van", color: "#d946ef", multiplier: 1.3 },
    MILITARY: { id: "MILITARY", label: "Military", color: "#9ca3af", multiplier: 1.6 },
};

const GENERAL_CARGO_POOL = [
    "General Freight", "Retail Goods", "Amazon Parcels", "Warehouse Pallets",
    "Packaged Consumer Goods", "Furniture", "Building Supplies", "Paper Products",
    "Household Appliances", "Office Supplies", "Clothing & Textiles", "Hardware",
];

function weightedPick(list, weightFn, rnd) {
    const total = list.reduce((s, x) => s + weightFn(x), 0);
    let r = rnd() * total;
    for (const item of list) {
        r -= weightFn(item);
        if (r <= 0) return item;
    }
    return list[list.length - 1];
}

// Cities that plausibly send/receive military freight, derived once from
// the industry tags in data.js rather than hand-listed, so it can't drift
// out of sync with the city data. Used for the destination bias below -
// military cargo is the one category that should NOT just go anywhere.
const MILITARY_TAGS = ["Military", "Defense", "AFB", "Naval", "Navy", "Arsenal", "Armor", "Missiles"];
const MILITARY_CITIES = new Set();
for (const name in masterCities) {
    const tags = masterCities[name].ind || [];
    if (tags.some((t) => MILITARY_TAGS.includes(t))) MILITARY_CITIES.add(name);
}

function generalCargo(rnd) {
    return {
        cargo: GENERAL_CARGO_POOL[Math.floor(rnd() * GENERAL_CARGO_POOL.length)],
        truckType: TRUCK_TYPES.DRYVAN,
        category: "General Freight",
    };
}

// What this city ships. Driven entirely by products.js; a city with no
// export profile (small towns with no distinctive industry) falls back to
// ordinary dry freight, same as before.
function pickCargo(cityName, rnd) {
    const profile = CITY_EXPORTS[cityName];
    if (!profile || !profile.length) return generalCargo(rnd);
    const pick = weightedPick(profile, (e) => e[1], rnd);
    if (!pick || pick[0] === "GENERAL") return generalCargo(rnd);
    const def = PRODUCTS[pick[0]];
    if (!def) return generalCargo(rnd); // defensive: products.js is validated at build time
    return { cargo: pick[0], truckType: TRUCK_TYPES[def.truck], category: def.category };
}

// Gravity-weighted destination pick: bigger/closer cities are more likely,
// with a trip-length dice roll (short/medium/long) so the fleet doesn't
// only ever run short hops or only ever run cross-country ones.
//
// `preferSet` (optional): a Set of city names whose score is multiplied by
// PREFER_MULT. Used only for military freight, which should move between
// installations rather than to whichever metro happens to be biggest.
// Deliberately a weighting rather than a hard filter - a hard filter would
// make every military load run the same handful of city pairs.
const PREFER_MULT = 14;

// Cross-border freight is real but a minority: most Canadian freight
// should stay domestic, and most US freight should stay in the US. This
// multiplies the score of any candidate whose country differs from the
// origin's - calibrated (see scratchpad/canada/cross_border_calib.mjs)
// against a ~30% cross-border share target for cities within reach of a
// border crossing, not a literal 30% of ALL contracts (most cities, on
// both sides, are nowhere near the border and would essentially never
// cross regardless of this constant).
// Calibrated (scratchpad/canada/calib_sweep.mjs, 8000-contract sweep) so
// contracts originating in Canada cross the border ~29% of the time -
// this needed a much stronger penalty than the naive "roughly 1/4" guess:
// Canada has only 42 cities vs 376 in the US, so even a 4x handicap on
// cross-border score left US destinations dominating the weighted pool.
const CROSS_BORDER_MULT = 0.06;

function pickDestination(graph, originName, rnd, preferSet = null) {
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
        if (node.w < 4) gravity *= 1.15; // give small towns a fighting chance, without letting them regularly out-score a hub
        const distanceFriction = 1 / Math.sqrt(1 + miles / 800);
        let score = gravity * distanceFriction * (0.85 + rnd() * 0.3);
        if (preferSet && preferSet.has(name)) score *= PREFER_MULT;
        if ((origin.country || "US") !== (node.country || "US")) score *= CROSS_BORDER_MULT;
        if (score > 0.0001) {
            candidates.push({ name, score });
            totalWeight += score;
        }
    }

    if (!candidates.length) {
        const names = Object.keys(graph.nodes).filter((n) => n !== originName && graph.nodes[n].t > 0);
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

// Generates one full contract for a truck sitting at `originName`: cargo
// first (it's a property of where the truck IS, not where it's going),
// then a destination, its A* route, and a payout fixed now (based on
// optimal distance) so a detour later costs the driver real fuel/time
// without changing what the job pays.
export function generateContract(graph, originName, rnd = Math.random, driver = null) {
    const { cargo, truckType, category } = pickCargo(originName, rnd);
    // Military loads route between installations; everything else uses the
    // plain gravity/distance picker.
    const prefer = truckType.id === "MILITARY" ? MILITARY_CITIES : null;
    const destination = pickDestination(graph, originName, rnd, prefer);
    // Threading the driver's route class through here (rather than always
    // using the plain-miles default) is what makes a driver's own traits
    // finally show up in navigation - see routeClassOf/edgeCost in geo.js.
    const path = findPath(graph, originName, destination, routeClassOf(driver));
    const optimalMiles = path ? path.reduce((s, e) => s + e.miles, 0) : haversineMiles(graph.nodes[originName], graph.nodes[destination]);
    const tierMult = TIER_PAY_MULT[graph.nodes[destination].t] ?? 1;
    const payout = Math.round(optimalMiles * PAY_RATE_PER_MILE * truckType.multiplier * tierMult);
    return { origin: originName, destination, cargo, category, truckType, optimalMiles, payout, path };
}

// A small board of distinct offers for a truck sitting at `originName`.
// Deliberately generated fresh per stop rather than kept as a persistent
// per-city market: contracts are cheap to make, and a standing board would
// need invalidation logic for something no one can observe.
//
// Offers are de-duplicated by destination so the player is never asked to
// choose between three loads to the same city, and any contract whose A*
// route came back empty is discarded rather than offered.
export function generateContractOffers(graph, originName, count = 3, rnd = Math.random, driver = null) {
    const offers = [];
    const seenDest = new Set();
    for (let attempt = 0; attempt < count * 6 && offers.length < count; attempt++) {
        const c = generateContract(graph, originName, rnd, driver);
        if (!c.path || !c.path.length) continue;
        if (seenDest.has(c.destination)) continue;
        seenDest.add(c.destination);
        offers.push(c);
    }
    return offers;
}

// Which offer an AI driver takes. This is where driver personality finally
// reaches a decision that matters: a hustler chases rate-per-mile, an
// aggressive driver reaches for the long haul, a cautious one takes the
// short local run. The random term keeps two identical drivers at the same
// city from always making identical choices.
export function chooseOffer(offers, driver, rnd = Math.random) {
    if (!offers.length) return null;
    let best = offers[0], bestScore = -Infinity;
    for (const o of offers) {
        const ratePerMile = o.payout / Math.max(1, o.optimalMiles);
        const lengthPref = (o.optimalMiles / 1500) * (driver.aggression - 0.45);
        const score = ratePerMile * (0.55 + driver.hustle * 0.9)
            + lengthPref * 1.1
            + rnd() * 0.18;
        if (score > bestScore) { bestScore = score; best = o; }
    }
    return best;
}
