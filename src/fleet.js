// fleet.js - autonomous trucks. Every truck gets a full A* route the
// moment it accepts a contract and just walks it, arrival to arrival,
// forever - no per-frame decisions, no lane physics, nothing to pause,
// unless it's the one truck the player is currently following AND it
// reaches a node with more than one real route choice. That's the only
// place this simulation ever needs external input.
import { pickEdgesFrom, findPath } from "./geo.js";
import { generateContract } from "./economy.js";
import { DriverDNA } from "./driver.js";

// Game-seconds of simulated time per real second at 1.0x speed. Tuned so
// a cross-country haul takes on the order of a minute of real time to
// watch play out at 1x, rather than being instant or glacial.
export const BASE_TIME_SCALE = 2400;
const MAX_DECISION_OPTIONS = 4;

const NICKNAMES = [
  "Rubber Ducky", "Iron Duck", "Mad Max", "Big Rig", "Rolling Thunder", "Night Owl",
  "Highway Star", "Lone Wolf", "White Line", "Overdrive", "Blacktop Runner", "Steel Horse",
  "Convoy King", "Hammer Down", "Ten-Four", "Double Nickel", "Rusty Bucket", "Silver Bullet",
  "Red Rocket", "Ghost Hauler", "Pathfinder", "Trailblazer", "Nomad", "Drifter",
  "Texas Tornado", "Yankee Clipper", "Desert Rat", "Cornhusker", "Bayou Beast", "Windy City",
  "Old Betsy", "Thunder Road", "Midnight Rider", "Grave Digger", "Asphalt Cowboy", "Gear Jammer",
];

let nextId = 1;
function randomName(rnd) {
  const base = NICKNAMES[Math.floor(rnd() * NICKNAMES.length)];
  const n = nextId;
  return n > NICKNAMES.length ? `${base} ${Math.ceil(n / NICKNAMES.length)}` : base;
}

export class Truck {
  constructor(graph, spawnCityName, rnd = Math.random) {
    this.id = nextId++;
    this.name = randomName(rnd);
    this.driver = new DriverDNA(rnd);
    this.currentNode = spawnCityName;
    this.edge = null;
    this.s = 0; // miles traveled along the current edge
    this.speed = 0; // current mph, eases toward the edge's limit
    this.totalMilesDriven = 0;
    this.earnings = 0;
    this.contractsCompleted = 0;
    this.awaitingDecision = false;
    this.pendingOptions = null;
    this.contract = null;
    this.remainingPath = [];
    this._assignContract(graph, rnd);
  }

  _assignContract(graph, rnd) {
    // generateContract's destination pick already filters out unreachable
    // nodes, but retry defensively in case a future data/graph edge case
    // still produces one, rather than crash the whole fleet.
    let contract, attempts = 0;
    do {
      contract = generateContract(graph, this.currentNode, rnd);
      attempts++;
    } while (!contract.path && attempts < 8);

    this.contract = contract;
    this.remainingPath = contract.path ? [...contract.path] : [];
    if (this.remainingPath.length) this._advanceToNextEdge();
    else this.edge = null; // truly stranded; will just sit idle rather than crash
  }

  _advanceToNextEdge() {
    this.edge = this.remainingPath.shift();
    this.s = 0;
  }

  _arriveAtDestination(graph) {
    this.earnings += this.contract.payout;
    this.contractsCompleted++;
    this.currentNode = this.contract.destination;
    this.edge = null;
    this._assignContract(graph, Math.random);
  }

  // Player picked `chosenEdge` at a paused junction; commit to it and
  // re-route the rest of the trip from there so the job still finishes.
  resolveDecision(graph, chosenEdge) {
    this.edge = chosenEdge;
    this.s = 0;
    this.awaitingDecision = false;
    this.pendingOptions = null;
    this.remainingPath = chosenEdge.to === this.contract.destination
      ? []
      : (findPath(graph, chosenEdge.to, this.contract.destination) || []);
  }
}

function rankAndCapOptions(graph, options) {
  const ranked = [...options].sort((a, b) => (graph.nodes[b.control]?.w || 0) - (graph.nodes[a.control]?.w || 0));
  return ranked.slice(0, MAX_DECISION_OPTIONS);
}

export function spawnFleet(graph, count, rnd = Math.random) {
  const cities = Object.values(graph.nodes).filter((n) => n.t > 0 && n.t <= 3);
  const trucks = [];
  for (let i = 0; i < count; i++) {
    const city = cities[Math.floor(rnd() * cities.length)];
    trucks.push(new Truck(graph, city.name, rnd));
  }
  return trucks;
}

// Advances every truck by `dt` real seconds at the given time-scale
// multiplier. Returns the truck awaiting a junction decision, if any
// (only possible for `followedTruck`), so the caller can pause the whole
// sim and show the decision panel.
export function updateFleet(graph, trucks, dt, timeScale, followedTruck) {
  const gameHours = (dt * BASE_TIME_SCALE * timeScale) / 3600;

  for (const truck of trucks) {
    if (truck.awaitingDecision || !truck.edge) continue;

    const targetSpeed = truck.edge.speedLimit * truck.driver.cruiseMult;
    truck.speed += (targetSpeed - truck.speed) * Math.min(1, dt * 3);
    const miles = truck.speed * gameHours;
    truck.s += miles;
    truck.totalMilesDriven += miles;

    if (truck.s < truck.edge.miles) continue;

    const node = truck.edge.to;
    truck.currentNode = node;
    if (node === truck.contract.destination) {
      truck._arriveAtDestination(graph);
      continue;
    }

    if (truck === followedTruck) {
      const options = pickEdgesFrom(graph, node, truck.edge);
      if (options.length > 1) {
        truck.pendingOptions = rankAndCapOptions(graph, options);
        truck.awaitingDecision = true;
        return truck;
      }
    }
    truck._advanceToNextEdge();
  }
  return null;
}
