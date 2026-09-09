// fleet.js - autonomous trucks. Every truck gets a full A* route the
// moment it accepts a contract and just walks it, arrival to arrival,
// forever - no per-frame decisions, nothing to pause, unless it's the
// one truck the player has taken control of AND it reaches a node with
// more than one real route choice. That's the only place this
// simulation ever needs external input.
//
// On interstate edges, trucks also carry lightweight lane/traffic state
// (see the "lane physics" section below): which of the two lanes
// they're in, whether they're mid-pass, and whether they're stopped at
// a city waiting for a gap to pull out into. Highway-kind edges skip
// all of that and behave like before (single file, straight through).
import { pickEdgesFrom, findPath, edgeId, localMinutesAtX } from "./geo.js";
import { generateContract, generateContractOffers, generateDeadheadContract, chooseOffer } from "./economy.js";
import { DriverDNA } from "./driver.js";
import { TRUCK_DOT_RADIUS, LEFT_LANE_OFFSET, RIGHT_LANE_OFFSET } from "./render.js";
import { weatherSpeedMultAt } from "./weather.js";

// Game-seconds of simulated time per real second at 1.0x speed. Tuned so
// a cross-country haul takes on the order of a minute of real time to
// watch play out at 1x, rather than being instant or glacial.
export const BASE_TIME_SCALE = 2400;
const MAX_DECISION_OPTIONS = 4;

// --- lane / traffic tunables (starting guesses, tuned visually) ---
//
// Gap thresholds that exist to prevent two truck dots from visually
// overlapping are computed per-edge from TRUCK_DOT_RADIUS (see
// minSafeMiles below) rather than given as flat mile constants. At this
// map's projection scale - the continental US drawn across a 4000x2400
// world space - a realistic few-car-lengths following distance is a
// tiny fraction of a mile, far smaller than the world-space distance
// needed to keep two 5-unit-radius dots apart. The dots are a
// deliberately exaggerated stand-in for a real truck's size, so the
// anti-overlap math has to be anchored to the render scale, not real
// truck dimensions - which is why these read as large mile values below
// even though on screen they land as a normal-looking gap.
const MIN_DOT_GAP_WORLD_UNITS = 2 * TRUCK_DOT_RADIUS + 1; // just a hair more than touching - required gap when two trucks are in the same visual lane, tight enough that a jam still reads as "bunched up" rather than a generous gap
// render.js deliberately sets the two lanes' offsets closer together
// than MIN_DOT_GAP_WORLD_UNITS - a little visual overlap between a
// truck and one directly beside it in the other lane reads as normal
// lane-adjacent traffic, not a bug. This is that same steady-state gap,
// the required along-edge cushion once two trucks are fully settled in
// different lanes. crossLaneTarget() below interpolates between this and
// MIN_DOT_GAP_WORLD_UNITS continuously as laneT changes, so a truck mid-
// lane-change never gets more clearance credit than its actual lateral
// separation has earned yet (see clampOverlaps/placeOnEdge).
const CROSS_LANE_TARGET_WORLD_UNITS = RIGHT_LANE_OFFSET - LEFT_LANE_OFFSET;
const FOLLOW_TIME_GAP_S = 1.1; // extra following distance on top of the anti-overlap floor, grows with speed - tight but not bumper-to-bumper
const PASS_CLEAR_AHEAD_MULT = 2; // multiples of minSafeMiles for a comfortable passing gap
const PASS_CLEAR_BEHIND_MULT = 1.5;
const MERGE_BACK_CLEAR_MULT = 1.5;
const PASS_AGGRESSION_THRESHOLD = 0.4; // only drivers at least this aggressive attempt a pass
const FOLLOW_TRIGGER_MULT = 1.15; // start capping speed at this multiple of the anti-overlap floor, before it's actually urgent
const EMERGENCY_BRAKE_MULT = 1.05; // hard speed clamp once the gap shrinks inside this multiple of the floor
const PASS_CONSIDER_MULT = 3; // decide to change lanes this much earlier than the speed cap, so the visual lane-blend has room to complete
const MAX_DEPARTURE_WAIT_REAL_S = 3; // defensive timeout so a truck can never stall forever

// HAMMER intimidation aura (career mode): a career truck running HAMMER
// closing on an ordinary AI truck holding the passing lane reads as
// tailgating a semi at 18% over cruise - a real driver in that spot
// backs off. Only low-aggression AI yields; an Outlaw/Super-Speeder is
// exactly the driver who wouldn't.
const INTIMIDATION_AGGRESSION_THRESHOLD = 0.8;
const INTIMIDATION_TRIGGER_MULT = 2.5; // multiples of minSafeMiles - starts yielding before it'd actually be tailgating

// --- Convoy Drafter -----------------------------------------------------
const DRAFT_MIN_LEADER_MPH = 55; // only worth tucking in at real highway speed
const DRAFT_ENGAGE_SAFE_MULT = 5; // engage within this multiple of the anti-overlap floor

// --- Shoulder Rider -------------------------------------------------------
const SHOULDER_JAM_MPH = 25; // leader speed below this counts as "severely congested"
const SHOULDER_TRIGGER_CHANCE = 0.004; // per-tick chance an eligible Outlaw actually takes the shoulder
const SHOULDER_MIN_MILES = 0.4;
const SHOULDER_MAX_MILES = 1.4;
const SHOULDER_RIDE_MPH = 48; // flying-past-the-jam pace - well under a real open-road cruise speed
const LANE_CHANGE_EASE = 2.0; // dt-multiplier for the visual lane-blend, same shape as speed easing
const ARRIVAL_DECEL_BASE_MI = 0.5; // physically-plausible braking distance, unrelated to dot size
const ARRIVAL_DECEL_PER_MPH = 0.06; // decel zone scales with the edge's speed limit
const ARRIVAL_MIN_MPH = 12;

// --- post-delivery layover ---------------------------------------------
// A truck that has just delivered sits at the city before taking its next
// load: unloading, paperwork, the driver's rest break. Expressed in GAME
// hours, so it scales with the time slider like everything else.
//
// Which end of the range a driver lands on is their hustle: a high-hustle
// driver turns around in about DWELL_MIN_HOURS, a low-hustle one takes
// most of DWELL_MAX_HOURS. The jitter keeps two equally-hustling drivers
// from moving in lockstep.
const DWELL_MIN_HOURS = 2;
const DWELL_MAX_HOURS = 12;
const DWELL_JITTER_HOURS = 1.5;
// Lot Loiterer: a low-hustle driver (and, per driver.js's isOutlaw/hustle
// split, never an Outlaw - an Outlaw's whole point is not sitting still)
// stretches the layover ceiling from a normal 12h out to a real 24-36h
// truck-stop hang, keeping the map's parked-badge tally visibly busy at
// major stops without needing more trucks.
const DWELL_LOITERER_MAX_HOURS = 36;
const LOITERER_HUSTLE_THRESHOLD = 0.2;

export function rollDwellHours(driver, rnd = Math.random) {
  const isLoiterer = driver.hustle < LOITERER_HUSTLE_THRESHOLD && !driver.isOutlaw;
  const maxHours = isLoiterer ? DWELL_LOITERER_MAX_HOURS : DWELL_MAX_HOURS;
  const span = maxHours - DWELL_MIN_HOURS;
  const base = maxHours - span * driver.hustle;
  const jitter = (rnd() - 0.5) * 2 * DWELL_JITTER_HOURS;
  return Math.max(DWELL_MIN_HOURS, Math.min(maxHours, base + jitter));
}

// --- fuel -----------------------------------------------------------------
const FUEL_BURN_PER_MILE = 0.066; // base burn (0-100 fuel scale) per mile at fuelBurnMult=1, no drag
const FUEL_DRAG_SPEED_MPH = 65; // above this cruise speed, aerodynamic drag starts costing extra fuel
const FUEL_LOW_THRESHOLD = 15; // stop and refuel at or below this
const FUEL_PRICE_PER_UNIT = 3.5; // $ per fuel unit refilled
const FUEL_STOP_HOURS = 1.0; // game hours spent refueling at a node
const FUEL_TOW_COST = 750; // $ penalty for running dry mid-edge
const FUEL_DISABLED_SERVICE_MIN_HOURS = 1;
const FUEL_DISABLED_SERVICE_MAX_HOURS = 3;
const FUEL_REFILL_MARGIN = 1.15; // refuel to cover the next leg with this much headroom, not just to a flat 100

// --- fatigue / circadian rest ----------------------------------------------
const FATIGUE_PER_HOUR = 6.0;
const FATIGUE_MAX = 100; // hard ceiling, so a driver who skipped rest can't read past a full gauge
// Recovery is deliberately much faster than accrual: sleep restores far
// more per hour than driving costs, which is what makes a single 4-hour
// break in the rest window actually recharge a driver (4h x 25 = a full
// 100-point gauge) instead of clawing back a quarter of it. At the old
// symmetric 6/hour a truck could never sleep its way out of fatigue
// inside one night's window.
export const FATIGUE_RECOVERY_PER_HOUR = 25.0;
const FATIGUE_REST_THRESHOLD = 50;
const REST_MIN_HOURS = 4.0;
const REST_MAX_HOURS = 6.0;
const STANDARD_SLEEP_START_MIN = 21 * 60; // 21:00 local
const STANDARD_SLEEP_END_MIN = 3 * 60;    // 03:00 local (wraps midnight)
const NIGHT_OWL_SLEEP_START_MIN = 9 * 60;  // 09:00 local
const NIGHT_OWL_SLEEP_END_MIN = 15 * 60;   // 15:00 local

// --- breakdowns -------------------------------------------------------------
// Calibrated (see routing_ab-style soak test) to hold roughly one
// concurrently-disabled truck per 1000 in the fleet, given a ~13.5-hour
// mean repair and drivers no longer spending 100% of their time driving
// (they now also layover, rest, and refuel).
const BREAKDOWN_PER_MILE = 1.0e-6;
const BREAKDOWN_REPAIR_MIN_HOURS = 3;
const BREAKDOWN_REPAIR_MAX_HOURS = 24;
const BREAKDOWN_MILES_SINCE_STOP_SCALE = 1500;

// --- rubbernecking -----------------------------------------------------------
const RUBBERNECK_RANGE_SAFE_MULT = 4; // approach zone, in multiples of minSafeMiles (anchors the zone to the render scale, not an absolute mile count - see minSafeMiles)
const RUBBERNECK_WORST_MULT = 0.45; // cruise-speed multiplier right alongside a disabled truck

// How many loads a parked truck gets to choose between.
const OFFER_COUNT = 3;

// --- forced deadhead home ---------------------------------------------
// Hometown Backhauler (economy.js's chooseOffer) only ever nudges an AI
// driver toward a load that happens to be headed home - it never refuses
// a paying job. Past a much harder line than that ordinary nudge, a
// sufficiently home-attached driver can refuse the load board outright and
// drive straight back empty instead. Gated on driver.homeAttachment (see
// driver.js) rather than any single trait flag, so it falls out of the
// same personality spread Hometown Backhauler already uses - an Outlaw's
// low attachment (aggression>0.7, compliance<0.3 pulls it toward ~0.5,
// just under the threshold below) naturally never does this, no isOutlaw
// check needed.
const DEADHEAD_HOME_MILES_THRESHOLD = 9000; // 1.5x economy.js's HOMESICK_FULL_MILES - the ordinary nudge maxing out isn't enough on its own to trigger this
const DEADHEAD_HOME_ATTACHMENT_MIN = 0.55; // homeAttachment ranges ~0.35-1.0; only the more attached half of drivers ever force a trip home
const DEADHEAD_HOME_BASE_CHANCE = 0.35; // rolled once per layover once eligible, not per hour - see the call site

// Pure - true if this truck should refuse the load board this stop and
// deadhead straight home instead. Chance climbs the further past
// DEADHEAD_HOME_MILES_THRESHOLD the truck has been driving, scaled by the
// driver's own homeAttachment, capped well short of certainty so even a
// very homesick driver doesn't reliably strand every load board.
function shouldDeadheadHome(truck, rnd) {
    if (!truck.homeCity || truck.parkedAt === truck.homeCity) return false;
    const attachment = truck.driver.homeAttachment;
    if (attachment < DEADHEAD_HOME_ATTACHMENT_MIN) return false;
    if (truck.milesSinceHome < DEADHEAD_HOME_MILES_THRESHOLD) return false;
    const over = (truck.milesSinceHome - DEADHEAD_HOME_MILES_THRESHOLD) / DEADHEAD_HOME_MILES_THRESHOLD;
    const chance = Math.min(0.9, DEADHEAD_HOME_BASE_CHANCE * attachment * (1 + over));
    return rnd() < chance;
}

// --- simulation event feed -------------------------------------------
// Notable things that happened this tick, for anything outside the sim
// that wants to react to them (currently the CB radio). Deliberately a
// drained queue rather than a callback: fleet.js stays a pure function of
// its inputs with no reference to the UI, and the headless harnesses -
// which never drain this - are unaffected beyond the bounded array below.
const FLEET_EVENT_CAP = 64; // hard cap so an undrained queue can't grow without bound
const fleetEvents = [];
const NO_EVENTS = [];

function emitFleetEvent(kind, truck) {
  if (fleetEvents.length >= FLEET_EVENT_CAP) fleetEvents.shift();
  fleetEvents.push({ kind, truck });
}

// The most recent tick's edgeId -> sorted array of disabled trucks' `.s`
// positions, kept so callers outside the sim (cb.js, asking whether a
// truck is actually creeping past a breakdown before it says so on the
// radio) can answer that in a map lookup instead of scanning the fleet.
// Same object the tick used, not a copy - read-only by convention.
let lastDisabledByEdge = new Map();

export function disabledPositionsOnEdge(edge) {
  return edge ? lastDisabledByEdge.get(edgeId(edge)) : undefined;
}

// Returns everything queued since the last call and empties the queue.
export function drainFleetEvents() {
  if (!fleetEvents.length) return NO_EVENTS;
  const out = fleetEvents.slice();
  fleetEvents.length = 0;
  return out;
}

// World-space length of an edge divided by its real mileage - varies
// slightly edge to edge (geographic projection), so gap thresholds
// derived from it are computed per-edge rather than with one global
// ratio.
function worldUnitsPerMile(graph, edge) {
  const a = graph.nodes[edge.from], b = graph.nodes[edge.to];
  return Math.hypot(b.x - a.x, b.y - a.y) / edge.miles;
}

// The `s` (mile) gap on this specific edge equivalent to
// MIN_DOT_GAP_WORLD_UNITS of on-screen separation - the floor every
// following/passing/departure gap check builds on.
function minSafeMiles(graph, edge) {
  return MIN_DOT_GAP_WORLD_UNITS / worldUnitsPerMile(graph, edge);
}

// 1000 hand-picked CB-handle-style names (user-supplied list), so a fleet
// of any realistic size mostly gets one truck per name before any name
// repeats at all - unlike the old scheme, which drew from a 36-name pool
// and appended a suffix computed from the GLOBAL truck-id counter (e.g.
// truck #1000 got " 28" regardless of which random name it happened to
// draw, since 1000/36≈28 - a number with no relation to how many times
// that specific name had actually been used).
const TRUCK_NAMES = [
  "Rubber Ducky", "Big Mack", "Snowman", "Pig Pen", "Bear Bait", "White Line Fever", "Asphalt Cowboy", "Gearjammer",
  "Mile Marker Mike", "Road Runner", "Midnight Special", "Diesel Dan", "Highballer", "Kingpin", "Flatbed Fred", "Long Haul Paul",
  "Highway Star", "Rolling Thunder", "Iron Mule", "Leadfoot Larry", "Smokey Chaser", "Silver Bullet", "Turbo Tommy", "Interstate Ike",
  "Golden Eagle", "Blue Mule", "Chrome Horn", "Prairie Dog", "Bull Hauler", "Ten-Four", "Convoy Captain", "Shift Kicker",
  "Super Slab", "Brake Check", "Screamin' Demon", "Rooster Tail", "Road Dog", "Night Owl", "Double Clutch", "Tailgater",
  "Cross-Country Cody", "Blacktop Bandit", "Overdrive Ollie", "Sleeper Cab Sal", "Rig Rider", "Jake Brake Jake", "Highway Ghost", "Big Rig Barney",
  "Freight Train Frankie", "Redline Ray", "Wayfarer", "Interstate Ranger", "Piston Pete", "Diesel Drifter", "White Line Willie", "Roadmaster",
  "Mile Muncher", "Gear Grinder", "Highway Hypnotist", "Big Steer", "Turnpike Ted", "Tar Heel Express", "Blue Highway", "Lone Wolf",
  "Six-Wheeler", "Freightliner Phil", "Kenworth Kenny", "Peterbilt Pete", "Western Star Steve", "Road Rebel", "Longbed Larry", "Coast-to-Coast",
  "Diesel Jockey", "High-Gear Hank", "Flathead Frank", "Truckin' Travis", "Pavement Pounder", "Interstate Jim", "Rig Roamer", "Mile Marker",
  "Asphalt Ace", "Highway Hawk", "Long Haul Harry", "Clutch Master", "Freight Train", "Big Iron", "Overdrive", "Supercharged Sam",
  "Blacktop Bruce", "Diesel Duke", "Axle Grease", "Heavy Hauler", "Highway Hopper", "Pavement Pusher", "Interstate Artie", "Highway Hound",
  "Big Cam Bob", "Road Warden", "Diesel Deacon", "Turnpike Terry", "Bubba Ray", "Billy Bob", "Cletus Wayne", "Earl Junior",
  "Jethro Tull", "Booger Red", "Cooter Brown", "Dwayne Higgins", "Waylon Boyd", "Buckshot", "Skeeter Davis", "Clem Kadiddle",
  "Roscoe P. Coltrane", "Buford T.", "Jebediah", "Bocephus", "Rufus Lee", "Hurlan Peep", "Otis Skaggs", "Junior Samples",
  "Hooter", "Leroy Jenkins", "Virgil Puckett", "Dale Junior Junior", "Merle Haggard Fan #1", "Cletus the Slack-Jawed", "T-Bone Taylor", "Burl Ives",
  "Elrod McPhee", "Clovis Green", "Booger Jim", "Gator Bait", "Swamp Donkey", "Catfish Hunter", "Possum Trot", "Mudflap Miller",
  "Moonshine Mike", "Copperhead", "Bucktooth Bobby", "Earl \"Lugnut\" Snodgrass", "Skeeter McNut", "Billy Ray Cyrus Fan Club", "Hound Dog Hank", "Cooter Davenport",
  "Deke Slayton", "Jim Bob Cooter", "Cleatus Judd", "Billy Joe Bob", "Hank Jr. Jr.", "Red Dirt Roy", "Bubba Gump", "Skeeter Skaggs",
  "Banjo Bob", "Coonhound", "Rustbucket Ray", "Crawdad", "Dixie Dan", "Kudzu Karl", "Grits 'N Gravy", "Porkchop Pete",
  "Cornbread", "Turnip Green", "Skillet", "Moonpie", "Biscuit", "Gumbo Gary", "Hog Wild", "Razorback",
  "Possum Belly", "Sweet Tea Sam", "Moonshine Mullins", "Copperhead Carl", "Redneck Rick", "Trailer Hitch Tim", "John Deere Dan", "Dixie Chick Magnet",
  "Mudbogger", "Duck Blind Dan", "Bass Pro Barry", "Rebel Yell", "Swamp Fox", "Cottonmouth", "Banjo Boy", "Sweet Potato",
  "Hog Waller", "Gator Gizzard", "Chitlins Charlie", "Cornstalk", "Hayseed", "Moonshine Mule", "Country Fried Carl", "Dip Can Dave",
  "Camo Chris", "Yella Dog", "Big Country", "Backwoods Benny", "Boondock Bob", "Mudflap Mack", "Hillbilly Hank", "Red Dirt Dan",
  "Buc-ee's Fanatic", "Beaver Nugget", "Roller Grill Rick", "Flying J Phil", "Love's Lothario", "TA Tony", "Pilot Pete", "Tornado Roller Ron",
  "Gas Station Sushi", "Roller Dog Dan", "Glurp Guzzler", "Five-Hour Energy", "Monster Energy Mike", "Red Bull Ralph", "Pepperoni Stick Pete", "Coffee Pot Slim",
  "3 A.M. Pancake", "Waffle House Brawler", "Cracker Barrel Crafter", "Truckstop Omelet", "Slim Jim Jim", "Big Gulp Greg", "Funnel Cake Frankie", "Corn Dog Carl",
  "Pork Rind Randy", "Glazed Donut Dave", "Powdered Donut Phil", "French Fry Fred", "Honey Bun Hank", "Jerky Jerry", "Cheese Curd Chuck", "Funyun Frank",
  "Jalapeno Popper", "Chili Cheese Mac", "Big Gulp Gary", "Truckstop Casanova", "Deep Fried Dan", "Hot Dog Harry", "Tornado Roll Terry", "Coffee Stain Steve",
  "Styrofoam Cup", "Thermos Tom", "64-Ounce Sipper", "Meat Stick Mike", "Sour Gummy Guy", "Funky Frito", "Funnel Cake Fred", "Roadside Pretzel",
  "Honey Bun Bob", "Glazed & Confused", "Bacon Grease", "Gravy Boat", "Biscuit & Gravy", "Truckstop Buffet", "Iron Skillet Sam", "Waffle House Wendy",
  "Diner Counter Dan", "Pie Slice Pete", "Coffee Refill Ray", "Bottomless Cup", "French Toast Frankie", "Hashbrowns Scattered", "Smothered & Covered", "Chicken Fried Chuck",
  "Truckstop T-Bone", "Meatloaf Mike", "Meatball Sub Sal", "Double Cheeseburger Dan", "Mega Melter", "Jalapeno Jack", "Nacho Cheese Nick", "Cheeto Dust Chad",
  "Pork Rind Paul", "Slim Jim Jimmy", "Jerky Jack", "Gummy Worm Wayne", "Sour Patch Pete", "Jawbreaker Joe", "Sugar High Sam", "Caffeine Crash",
  "Monster Can Mike", "Rockstar Ronnie", "5-Hour Hunter", "Redline Ralph", "Energy Shot Eddie", "2-for-1 Taquito", "Roller Grill Royalty", "Gas Station Gourmet",
  "Corn Dog King", "Funnel Cake Phil", "Maple Bacon Bob", "Diner Booth Dave", "Pancake Stack Pat", "Syrup Chugger", "Sugar Packet Sal", "Pie A La Mode",
  "Road Diner Don", "Cinnamon Roll Ron", "Gravy Train", "Sweet Roll Roy", "Caterpillar Carl", "Detroit Diesel", "Cummins Casey", "Torque Wrench",
  "Camshaft Chuck", "Turbo Tim", "Blowout Bob", "Crankshaft", "Dipstick Dan", "Piston Ring Pete", "Overhaul Ollie", "Blown Gasket",
  "Radiator Ralph", "Alternator Artie", "Fan Belt Frank", "Differential Dave", "Axle Snap", "Air Brake Andy", "Fifth Wheel Phil", "Kingpin Kenny",
  "Leaf Spring Larry", "U-Joint Jack", "Fuel Pump Frank", "Turbocharger", "Manifold Mike", "Exhaust Pipe Pete", "Header Hank", "Supercharger Sam",
  "Nitrous Nick", "Dyno Dan", "Grease Gun Greg", "Ball Joint Bob", "Brake Drum Dan", "Camshaft Cody", "Cylinder Six", "Cylinder Eight",
  "V12 Vince", "Dual Exhaust", "Chrome Stacks", "Straight Pipes", "Jake Brake Johnny", "Transmission Tom", "Low Gear Leo", "High RPM",
  "Clutch Burner", "Oil Pressure Pete", "Temp Gauge Ted", "Flywheel Fred", "Valve Cover Vince", "Spark Plug Spud", "Glow Plug Gary", "Turbo Whistle",
  "Diesel Soot", "Black Smoke Bob", "Ash Can", "Muffler Mike", "Header Hater", "Rust Bucket", "Bondo Bill", "WD-40 Wayne",
  "Duct Tape Dan", "Zip Tie Zach", "Ratchet Ralph", "Socket Wrench", "Torque Converter", "Sway Bar Sam", "Tie Rod Tim", "Control Arm Carl",
  "Bushing Bob", "Piston Slap", "Blown Turbo", "Bad Alternator", "Squeaky Belt", "Dead Battery Dave", "Jumper Cables", "Fuel Injector",
  "Glow Plug Gus", "Air Tank Tom", "Brake Shoe Bob", "Slack Adjuster", "Cam Follower", "Rocker Arm", "Crankcase Carl", "Oil Pan Pete",
  "Dipstick Danny", "Grease Pit Phil", "Lube Job", "Pit Stop Paul", "Impact Wrench", "Floor Jack Fred", "Heavy Duty Hank", "Mega Torque",
  "High Compression", "Chrome Bumper", "Mudflap Mike", "Bug Guard Bob", "Visor Vince", "Cabover Calvin", "Splitter Switch", "Dual Tandem",
  "Speed Trap Sammy", "Radar Dodger", "Weigh Station Bandit", "Scale Dodger", "Bypass Bill", "Ghost Rider", "Night Hawk", "Phantom Freight",
  "Midnight Marauder", "Bootlegger Bob", "Bandit", "The Duke of Hazard", "Smokey's Nightmare", "Fuzz Buster", "Copper Catcher", "Blue Light Special",
  "DOT Evader", "Logbook Forger", "Fake Manifest", "Overweight Otis", "Runaway Ramp", "Red Light Randy", "Midnight Express", "Blackout Bob",
  "Highway Houdini", "Midnight Shift", "Blind Spot", "Ghost Hauler", "Shadow Runner", "Stealth Semi", "Radar Runner", "Kojak Dodger",
  "Bear Hunter", "Trooper Troll", "State Line Leap", "Turnpike Phantom", "Black Hat", "Lawless Larry", "Rebel Road", "Renegade Ron",
  "Wild Card", "Rogue Rig", "Desert Drifter", "Midnight Maverick", "Fast Eddy", "Hammer Lane Harlan", "Speeding Ticket", "Points on License",
  "Outlaw Wayne", "The Midnight Ram", "Hell on Wheels", "Asphalt Assassin", "Highway Hijacker", "Diesel Desperado", "The Smuggler", "High Plains Drifter",
  "Sidewinder", "Road Pirate", "Blacktop Buccaneer", "Lawman's Bane", "Patrol Dodger", "The Shadow", "Night Creeper", "Backroad Bandit",
  "Midnight Cowboy", "County Line Crusher", "Highway Outlaw", "Iron Outlaw", "Rebel Without a Rig", "The Fugitive", "Runaway Truck", "Wild Horse Wayne",
  "Speed Trap Troy", "Blind Faith", "No Brakes Ned", "Danger Zone", "Flat Out Frankie", "Full Throttle Phil", "Zero Tolerance", "Bad Influence",
  "The Instigator", "Trouble Maker", "Road Menace", "Hazard Sign", "Caution Cone", "Speed Demon", "Fast Lane Fred", "Hammer Drop",
  "Floorboard Frank", "Pedal to Metal", "Full Tilt", "High Velocity", "Over-the-Limit", "Leadfoot Louie", "High Tail", "Smoke Screen",
  "The Marauder", "Desert Mirage", "Highway Mirage", "The Phantom", "Captain Underpants", "Disco Dan", "Neon Flamingo", "Cosmic Cowboy",
  "Space Cadet", "Dumpster Fire", "Lawn Mower Larry", "Bermuda Triangle", "Mothman", "Bigfoot Bob", "Area 51 Al", "Alien Abductee",
  "Quantum Leap", "Captain Chaos", "Lord of the Rigs", "Sir Hauls-A-Lot", "Freight Daddy", "Big Daddy Diesel", "Cuddle Bug", "Fuzzy Dice",
  "Hula Girl", "Dashboard Jesus", "Lava Lamp Larry", "Disco Rig", "Funkytown Fred", "Polyester Pete", "Rhinestone Randy", "Cowboy Hat Al",
  "Roller Skate Roy", "Bowling Ball Bob", "Pocket Lint", "Half-Baked", "Rusty Zipper", "Mystery Meat", "Soup Can Sam", "Rubber Chicken",
  "Banana Peel", "Flying Squirrel", "Wobbly Knee", "Two-Toed Tommy", "Left Turn Clyde", "Wrong Way Wendy", "Lost Again Larry", "U-Turn Tony",
  "GPS Hater", "Atlas User", "Paper Map Paul", "Compass Carl", "Dead End Dan", "Detour Dave", "Wrong Exit Rick", "Pothole Pete",
  "Speed Bump Bob", "Orange Barrel", "Roadkill Randy", "Armadillo Artie", "Raccoon Rob", "Possum Pete", "Skid Mark", "Fender Bender",
  "Blind Spot Bob", "Wide Turn Wayne", "Tailpipe Terry", "Muddy Waters", "Squeegee Sam", "Windex Wayne", "Air Freshener Al", "Pine Tree Pete",
  "Little Tree Larry", "Fuzzy Slippers", "Trucker Hat Chad", "Overalls Ollie", "Sleeveless Steve", "Tan Line Terry", "Trucker Arm", "Flip Flop Frank",
  "Sweatpants Sammy", "Bathrobe Bob", "Morning Breath", "Bedhead Ben", "Sleepy Joe", "Wide Awake Wayne", "Caffeinated Carl", "Sugar Rush",
  "Daydream Believer", "Night Crawler", "Worm Farmer", "Frog Leg Frank", "Swamp Monster", "Sasquatch Sam", "Yeti Pete", "Abominable Snowman",
  "Chupacabra Charlie", "Alien Freight", "UFO Dave", "Crop Circle Carl", "Flying Saucer", "Roswell Ray", "Tin Foil Tim", "Conspiracy Cody",
  "Grizzly Adams", "Black Bear", "Honey Badger", "Wolverine Wayne", "Mad Dog", "Bullfrog", "Timber Wolf", "Road Rat",
  "Swamp Possum", "Desert Tortoise", "Blue Heeler", "Coonhound Cody", "Snapping Turtle", "Bald Eagle", "Prairie Hawk", "Cuckoo Bird",
  "Iron Horse", "Stallion Steve", "Wild Mustang", "Billy Goat", "Mountain Lion", "Bobcat Bob", "Raccoon Ray", "Porcupine Pete",
  "Armadillo Andy", "Skunk Averse", "Coyote Chris", "Jackrabbit", "Mule Skinner", "Moccasin Mike", "Cottonmouth Cody", "Diamondback Dan",
  "Rattlesnake Rick", "Python Pete", "Gator Gus", "Bullshark", "Gray Wolf", "Silver Fox", "Red Fox", "Coyote Ugly",
  "Bull Moose", "Elk Horn", "White Tail", "Buck Hunter", "Antler Andy", "Wild Boar", "Razorback Ray", "Badger Bob",
  "Ferret Fred", "Otter Pop", "Beaver Tail", "Mud Turtle", "Pelican Pete", "Sea Gull Sam", "Hawk Eye", "Osprey Ollie",
  "Falcon Frank", "Vulture Vince", "Crow Bar", "Raven Ray", "Black Bird", "Woodpecker Woody", "Roadrunner Ronnie", "Blue Jay",
  "Cardinal Carl", "Robin Red", "Mockingbird", "Screech Owl", "Barn Owl", "Hoot Owl", "Bat Out of Hell", "Pack Mule",
  "Donkey Kong", "Gray Mare", "Black Stallion", "Pinto Pete", "Bronco Buster", "Wild Bronco", "Steer Horn", "Longhorn Larry",
  "Angus Andy", "Hereford Hank", "Dairy Dan", "Bullseye Bob", "Red Bull Roy", "Buffalo Bill", "Bison Bob", "Moose Jaw Mike",
  "Grizzly Gus", "Kodiak Ken", "Polar Bear Paul", "Walrus Wally", "Wolverine Walt", "Timber Rattler", "Diamondback Dave", "Whitetail Woody",
  "Blacktail Ben", "Longhorn Lou", "Bighorn Bill", "Mountain Ram", "Black Ice Bob", "Blizzard Bill", "Thunderhead", "Tornado Tom",
  "Foggy Bottom", "Sunstroke Sam", "Heatwave Hank", "Rocky Mountain High", "Prairie Fire", "Whiteout Wayne", "Flash Flood", "Mudslide Mike",
  "Dust Storm Dan", "Sandstorm Sam", "Glacier Gary", "Avalanche Al", "Hailstorm Harry", "Sleet King", "Frostbite Frank", "Polar Express",
  "Monsoon Mike", "Hurricane Hank", "Typhoon Tim", "Gale Force", "Chinook Charlie", "Santa Ana Sam", "Sirocco Steve", "Dust Devil",
  "Whirlwind Wayne", "Tornado Alley", "Twister Tom", "Lightning Larry", "Thunder Roll", "Storm Chaser", "Cloudburst", "Drizzle Dan",
  "Puddle Jumper", "Hydroplane Hank", "Washout Wayne", "Canyon Carver", "Mountain Climber", "Switchback Steve", "Donner Pass Dan", "Eisenhower Ike",
  "Cabbage Hill Carl", "Grapevine Greg", "Lookout Mountain", "Continental Divide", "High Pass Hank", "Desert Sun", "Salt Flat Sam", "Death Valley Dave",
  "Mojave Mike", "Badlands Bob", "Tundra Tom", "Everglades Ed", "Bayous Bob", "Swamp Dog", "Piney Woods", "Redwood Rick",
  "Timber Trail", "Gravel Grinder", "Dirt Road Dan", "Backroad Bob", "Rocky Road", "Pothole Phil", "Chug Hole Chuck", "Rumble Strip",
  "Guardrail Gary", "Bridge Freeze", "Culvert Carl", "Underpass Pete", "Low Clearance", "Overpass Ollie", "Clearance 13-6", "Steep Grade",
  "Runaway Ramp Ray", "6 Percent Grade", "Switchback Sal", "Hairpin Hank", "Blind Curve", "Fog Horn", "Headlight Beam", "High Beam Harry",
  "Tail Light Tim", "Amber Light", "Flash Hazard", "Blown Tire", "Shredded Tread", "Alligator Alley", "Road Gator", "Retread Ralph",
  "Rubber Chunk", "Debris Dave", "Cone Zone", "Work Zone Wayne", "Detour Dan", "Pavement Groove", "Grooved Road", "Fresh Tar",
  "Billy Ray", "Bobby Joe", "Jimmy Dean", "Tommy Lee", "Johnny Cash", "Ricky Bobby", "Donnie Ray", "Bobby Lee",
  "Danny Joe", "Kenny Wayne", "Stevie Ray", "Randy Travis", "Ronnie Gene", "Jerry Lee", "Terry Ray", "Gary Wayne",
  "Larry Dale", "Terry Dale", "Ricky Dale", "Billy Wayne", "Johnny Ray", "Sammy Lee", "Jesse Lee", "Cody Ray",
  "Tyler Joe", "Hunter Ray", "Chase Lee", "Mason Wayne", "Wyatt Lee", "Colten Ray", "Travis Wayne", "Tanner Lee",
  "Dakota Ray", "Dalton Wayne", "Austin Lee", "Dallas Wayne", "Houston Ray", "Savannah Sam", "Memphis Slim", "Nashville Nick",
  "Jackson Hole", "Montgomery Mike", "Tallahassee Tom", "Raleigh Ray", "Charlotte Charlie", "Augusta Artie", "Macon Mike", "Columbus Chris",
  "Dayton Dan", "Toledo Tom", "Akron Al", "Cleveland Cliff", "Gary Indiana", "Peoria Pete", "Rockford Ray", "Duluth Dan",
  "Fargo Fred", "Bismarck Bob", "Billings Bob", "Casper Chris", "Cheyenne Chad", "Laramie Lee", "Reno Ray", "Vegas Vance",
  "Phoenix Phil", "Tucson Tom", "Flagstaff Frank", "Yuma Ray", "Barstow Bob", "Fresno Fred", "Bakersfield Bob", "Modesto Mike",
  "Stockton Steve", "Redding Ray", "Eugene Earl", "Salem Sam", "Tacoma Tom", "Spokane Steve", "Boise Bob", "Pocatello Pete",
  "Ogden Ollie", "Provo Pete", "Pueblo Phil", "Sterling Steve", "Colby Chris", "Salina Sam", "Topeka Tom", "Wichita Wayne",
  "Tulsa Tom", "Enid Earl", "Norman Nick", "Lawton Larry", "Amarillo Artie", "Lubbock Lee", "Abilene Al", "Midland Mike",
  "Odessa Ollie", "Waco Wayne", "Temple Tom", "Killeen Kenny", "John Wayne", "Clint Eastwood", "The Sundance Kid", "Butch Cassidy",
  "Stampede Steve", "Wild Bill Hickok", "Wyatt Earp", "Doc Holliday", "Jesse James", "Billy the Kid", "Calamity Jane", "Annie Oakley",
  "Davey Crockett", "Daniel Boone", "Paul Bunyan", "Babe the Blue Ox", "Pecos Bill", "Casey Jones", "John Henry", "Big Joe & Phantom 309",
  "Rubber Duck", "Spider Mike", "The Bandit", "Cletus Snow", "Buford T. Justice", "Sheriff Lobo", "B.J. McKay", "Bear the Chimp",
  "Maximum Overdrive", "Duel Peterbilt", "Convoy Leader", "White Line Warrior", "Road Warrior", "Mad Max", "Long Haul Legend", "King of the Road",
  "Highwayman", "Willie Nelson's Co-Pilot", "Waylon's Guitar", "Cash's Cadillac", "Merle's Train", "Waylon Jennings Jr.", "Hank Williams Sr. Ghost", "Smokey Bear",
  "Smokey's Worst Nightmare", "Uncle Sam's Hauler", "Captain America Rig", "Evel Knievel", "Daredevil Dan", "Flying Dutchman", "Ghost of Route 66", "Lincoln Highway Lou",
  "Dixie Flyer", "Broadway Bob", "Sunset Strip Sam", "Pacific Coast Phil", "Great Lakes Gary", "Big Sky Bob", "Lone Star Larry", "Golden Gate Greg",
  "Alamo Al", "Blue Ridge Bob", "Appalachian Artie", "Ozark Ollie", "Sierra Steve", "Cascade Charlie", "Great Plains Gary", "Heartland Hank",
  "Rust Belt Rusty", "Corn Belt Carl", "Sun Belt Sal", "Bible Belt Billy", "Magnolia Mike", "Palmetto Pete", "Bluegrass Bob", "Yosemite Sam",
  "Buckeye Bob", "Hoosier Hank", "Hawkeye Harry", "Gopher Gary", "Old Yeller", "Jayhawk Joe", "Sooner Sam", "Cowboy Bob",
  "Outlaw Josey", "The Man with No Name", "Pale Rider", "Unforgiven Al", "Tombstone Tom", "High Noon Hank", "Stagecoach Steve", "Wells Fargo Wayne",
  "Pony Express Pete", "Deadwood Dick", "Silver Dollar Sam", "Rawhide Ray", "Wagon Train Wayne", "Lonesome Dove", "Gus McCrae", "Woodrow Call",
];

// A fresh shuffle of TRUCK_NAMES, walked round-robin as trucks spawn:
// index 0..999 hands out every name once (no suffix), 1000..1999 hands
// them out a second time (suffix " 2"), and so on - so for any fleet
// size, a name's Nth use is always labeled "Name N", never a number
// disconnected from how many trucks actually share that name. Reset at
// the top of every spawnFleet() call so a fresh 5000-truck fleet uses
// each of the 1000 names exactly 5 times, starting clean rather than
// continuing wherever the previous fleet's cursor left off.
let namePool = TRUCK_NAMES;
let nameCursor = 0;

function resetNamePool(rnd) {
  namePool = TRUCK_NAMES.slice();
  for (let i = namePool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [namePool[i], namePool[j]] = [namePool[j], namePool[i]];
  }
  nameCursor = 0;
}

function nextTruckName() {
  const idx = nameCursor % TRUCK_NAMES.length;
  const round = Math.floor(nameCursor / TRUCK_NAMES.length) + 1;
  nameCursor++;
  const base = namePool[idx];
  return round > 1 ? `${base} ${round}` : base;
}

let nextId = 1;

// A hired company truck (Phase 11) gets a string id from career.js's own
// "H-1", "H-2", ... counter instead of one of these - a separate
// namespace, never bumping `nextId`, so collision with an ambient AI
// truck's id is structurally impossible rather than merely avoided by
// arithmetic (see career.js's nextHiredId doc comment for the full
// rationale). Exported so both ui.js's rankings and main.js's daily
// digest can exclude company trucks from fleet-wide awards without either
// one needing to know the "H-" convention itself.
export function isCompanyTruck(truck) {
  return typeof truck.id === "string" && truck.id.startsWith("H-");
}

export class Truck {
  constructor(graph, spawnCityName, rnd = Math.random, presetDriver = null) {
    this.id = nextId++;
    this.name = nextTruckName();
    this.driver = presetDriver || new DriverDNA(rnd);
    this.currentNode = spawnCityName;
    this.edge = null;
    this.s = 0; // miles traveled along the current edge
    this.speed = 0; // current mph, eases toward the edge's limit
    this.freeFlowSpeed = 0; // open-road cruise speed snapshot (weather included), read by render.js's congestion tally
    this.arrivalBraking = false; // true while decelerating for ITS OWN upcoming stop (arrivalSpeedCap engaged) - excluded from congestion tallying, since it isn't a traffic effect
    this.totalMilesDriven = 0;
    this.earnings = 0;
    this.contractsCompleted = 0;
    this.awaitingDecision = false;
    this.pendingOptions = null;
    this.contract = null;
    this.remainingPath = [];

    // Lane physics state (interstate edges only; meaningless/unused on
    // highway edges, left at defaults there).
    this.lane = 0; // 0 = right/default lane, 1 = left/passing lane (target)
    this.laneT = 0; // 0..1 eased visual blend toward `lane`, drives the render offset
    this.passingLeaderId = null; // id of the truck currently being overtaken, or null
    this.pendingEdge = null; // set while stopped at a real city waiting for a gap to depart
    this.departureWaitS = 0; // real seconds spent waiting on pendingEdge

    // Layover state. `parkedAt` is the city name while the truck is sitting
    // between contracts (null the entire time it's driving), which is what
    // the map's per-city parked counter and the UI's "PARKED" status both
    // key off. `pendingOffers` is only populated for the player-controlled
    // truck, whose choice of load is made by a human rather than by
    // chooseOffer().
    this.parkedAt = null;
    this.dwellHoursLeft = 0;
    this.pendingOffers = null;
    this.awaitingContract = false;
    // Discriminates why a parked truck is parked: "LAYOVER" (between
    // contracts - takes a new load on wake) vs "REST"/"FUEL" (mid-route -
    // resumes the SAME contract on wake). Reusing parkedAt/dwellHoursLeft
    // for all three keeps the map's parked-badge tally, the "hide the dot"
    // render rule, and the tap-falls-through-to-city behavior working for
    // REST/FUEL with no changes - they all key off parkedAt alone.
    this.stopReason = null;

    // Resources (Phase 3/4): fuel, fatigue, and breakdown condition.
    this.fuel = 100;
    this.fatigue = 0;
    this.milesSinceStop = 0; // wear tracker for the breakdown roll; resets on any real stop
    // > 0 while broken down or dry-tanked ON THE SHOULDER mid-edge - this
    // is deliberately NOT `parkedAt` (the truck never reached a node, so
    // it keeps its edge/.s and must stay fully rendered and rubberneck-
    // visible, unlike a parked truck's hidden dot).
    this.disabledHoursLeft = 0;
    this.disabledReason = null; // "BREAKDOWN" | "FUEL"
    this.fuelSpend = 0;
    this.downtimeHours = 0;
    // A refuel in progress fills the tank GRADUALLY across the stop rather
    // than snapping to full on wake, so the detail panel's fuel gauge
    // visibly climbs while the truck sits at the pump (the panel already
    // re-renders every frame for the viewed truck). null when not fueling.
    this.refuelTarget = null;
    this.refuelPerHour = 0;

    // Per-day accumulators for the midnight digest, zeroed by main.js's
    // captureDayStart() at every rollover. Deliberately separate from the
    // lifetime counters above (earnings/totalMilesDriven/...), which keep
    // accumulating uninterrupted - the digest reports the DAY, the
    // Dispatch tab reports all time.
    this.dayEarnings = 0; // gross contract payouts banked today
    this.dayMiles = 0;
    this.dayDeliveries = 0;
    this.dayBreakdowns = 0; // mechanical failures + dry-tank halts
    this.dayFuelSpend = 0; // diesel bought today, plus roadside assistance fees
    // The edge just completed - used to avoid an immediate U-turn when
    // resuming from a full stop (parkedAt/disabled clears `edge`, so the
    // junction/departure logic needs this to know what NOT to reverse
    // back onto), and later reused for junction corner-blending.
    this.prevEdge = null;

    // Hometown Backhauler: the city this driver considers home - simply
    // wherever they spawned, same as a real owner-operator's domicile.
    // economy.js's chooseOffer reads this (with driver.homeAttachment) to
    // bias load selection back toward it. milesSinceHome feeds the
    // homesickness curve there and only resets when a delivery actually
    // lands the truck back at homeCity (see _arriveAtDestination).
    this.homeCity = spawnCityName;
    this.milesSinceHome = 0;

    // Convoy Drafter: set fresh every tick by applyFollowAndPassing,
    // consumed the same tick by burnPerMile's fuel discount - never
    // sticky state, so a draft's fuel savings only apply while a
    // qualifying leader is actually being tucked in behind.
    this.isDrafting = false;

    // Shoulder Rider: a mid-jam shoulder cheat, Outlaws only (see
    // applyFollowAndPassing). Distinct from `lane`/`laneT` - like a
    // disabled truck, a shoulder-riding truck is excluded from the normal
    // lane-group anti-overlap/follow physics entirely (buildLaneGroups),
    // which is what actually lets it clear the jam instead of inheriting
    // the blocked leader's speed cap.
    this.onShoulder = false;
    this.shoulderMilesLeft = 0;

    // Owner-Operator career mode (career.js). `agent` is null for every
    // ordinary AI truck, forever - it's the ONE seam career mode uses to
    // divert a truck's decisions from autopilot to the player, and every
    // read of it below is a `?? 1`/null-check no-op when it's absent. See
    // career.js's createAgent() for the object shape (speedMult/wearMult/
    // burnMult/fatigueMult/restMult multipliers + stopReasonAt(node)).
    // `fuelCapacity` generalizes the old hardcoded-100 tank size so a
    // career "bigger tank" upgrade has something real to change; every AI
    // truck still just gets the same 100 it always had. `stopVendor` is a
    // pure UI hint (which truck-stop tab to default to) - fleet.js sets it
    // when it parks a career truck for a reason ONLY it knows (a genuine
    // delivery vs. a fuel-safety stop vs. a voluntary pull-in), and never
    // reads it back.
    this.agent = null;
    this.fuelCapacity = 100;
    this.stopVendor = null;

    this._assignContract(graph, rnd);
  }

  _assignContract(graph, rnd, laneGroups) {
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
    if (this.remainingPath.length) this._advanceToNextEdge(graph, laneGroups, true);
    else { this.edge = null; this.pendingEdge = null; } // truly stranded; will just sit idle rather than crash
  }

  // Moves to the next queued edge. The full stop-and-wait-for-a-gap
  // treatment (see tryDepartTruck in updateFleet) only applies when this
  // is a genuine departure FROM A FULL STOP - a brand-new contract's
  // route, or a truck waking from a REST/FUEL stop to resume its existing
  // route - AND the node being LEFT is a real city (not a tier-0 highway-
  // interchange filler node), i.e. an actual stop, not just a waypoint
  // the route happens to route through. A truck passing through a real
  // city mid-route (this edge is just the next leg of an already-
  // underway haul, no stop involved) carries straight through at full
  // speed and in whatever lane it was already in instead - same as a
  // tier-0 junction always has (see arrivalSpeedCap, which only
  // decelerates a truck's actual final leg, and placeOnEdge, which no
  // longer resets lane/laneT itself) - real continuity through the node,
  // not just "no hard stop". It still needs `placeOnEdge`'s conflict
  // nudge either way (`laneGroups` may be undefined only when spawning a
  // fresh truck, which always starts at a real city and never reaches
  // this branch).
  _advanceToNextEdge(graph, laneGroups, fromFullStop = false) {
    const next = this.remainingPath.shift();
    if (!next) {
      // remainingPath ran out before reaching contract.destination - a
      // route/destination mismatch (see resolveDecision's own fix for the
      // one known way this happened) rather than a truck that's actually
      // arrived. Strand gracefully like any other truly-unreachable truck
      // (_assignContract's own fallback) instead of crashing the whole
      // fleet loop on a null edge.
      this.edge = null;
      this.pendingEdge = null;
      this.speed = 0;
      return;
    }
    if (fromFullStop && graph.nodes[next.from].t > 0) {
      this.edge = null;
      this.pendingEdge = next;
      this.speed = 0;
      this.lane = 0;
      this.laneT = 0;
      this.passingLeaderId = null;
      this.departureWaitS = 0;
    } else {
      // Phase 2's speed*gameHours integration for the whole tick isn't
      // clamped to the current edge's remaining length, so at a high sim
      // speed (several game-hours can pass in one real frame) `this.s`
      // may already sit well past `this.edge.miles` by the time this
      // runs. Always restarting the new edge at s=0 (the old behavior)
      // silently discarded that already-earned distance every time a
      // truck crossed a short edge fast enough to overshoot it, which
      // reads as the truck stalling/lagging behind its own displayed
      // speed - most visible right where it matters most, a dense run of
      // short junction-filler edges taken at 8x. Carry the overshoot
      // forward as a head start on the new edge instead; placeOnEdge's
      // own lane-conflict clamp still applies on top exactly as it would
      // for a start of 0.
      const overshoot = this.edge ? Math.max(0, this.s - this.edge.miles) : 0;
      placeOnEdge(graph, this, next, laneGroups, overshoot);
    }
  }

  // Delivery complete: bank the payout and park. The truck deliberately
  // keeps `contract` pointing at the load it just finished rather than
  // nulling it - the details panel, the rankings and the economy tab all
  // read that object every frame, and a parked truck showing its last run
  // is both safe and more informative than a blank. It's replaced wholesale
  // when the next load is accepted.
  _arriveAtDestination(graph, rnd = Math.random) {
    this.earnings += this.contract.payout;
    this.dayEarnings += this.contract.payout;
    this.contractsCompleted++;
    this.dayDeliveries++;
    this.currentNode = this.contract.destination;
    if (this.currentNode === this.homeCity) this.milesSinceHome = 0; // Hometown Backhauler: made it home, homesickness curve resets
    this.edge = null;
    this.pendingEdge = null;
    this.speed = 0;
    this.lane = 0;
    this.laneT = 0;
    this.passingLeaderId = null;
    this.parkedAt = this.currentNode;
    this.milesSinceStop = 0; // a delivery + layover counts as a real stop for breakdown wear
    if (this.agent && !this.autoDriver) {
      // Career mode: a delivery is never auto-resolved. dwellHoursLeft
      // stays at 0 and stopReason "PLAYER" makes Phase 4's parked branch
      // skip the whole auto-dwell/auto-contract pipeline entirely (see
      // updateFleet) - the player ends this stop explicitly through the
      // truck stop's BOARD vendor, same load-board data
      // (generateContractOffers/chooseOffer) just player-driven instead
      // of autopilot. No auto-refuel either - buying fuel is a real,
      // billed player action now (see the PUMPS vendor / pumpFuel).
      this.dwellHoursLeft = 0;
      this.stopReason = "PLAYER";
      this.stopVendor = "BOARD";
    } else {
      // this.autoDriver (career.js's AI Driver upgrade) takes this same
      // branch an ordinary agent-less truck does - dwell, auto-refuel, and
      // (via Phase 4's own LAYOVER handling in updateFleet) an auto-picked
      // contract, with no load-board prompt. A fully autonomous rig is
      // meant to behave exactly like a hired driver's truck here; the only
      // thing distinguishing it is still holding .agent (so upgrades/
      // throttle/heat keep applying to it as normal).
      this.dwellHoursLeft = rollDwellHours(this.driver, rnd);
      this.stopReason = "LAYOVER";
      // Top off while the trailer is being unloaded - a truck rolling out
      // on a fresh contract leaves with a full tank, the same as a real
      // yard turnaround, instead of starting the next haul on whatever
      // was left.
      beginRefuel(this, Math.min(this.dwellHoursLeft, FUEL_STOP_HOURS));
    }
  }

  // Accept a specific contract (chosen by the driver, or by the player for
  // the controlled truck) and roll out. Mirrors _assignContract's tail, but
  // takes the contract as given instead of generating one.
  _takeContract(graph, contract, laneGroups) {
    this.contract = contract;
    this.remainingPath = contract.path ? [...contract.path] : [];
    this.parkedAt = null;
    this.dwellHoursLeft = 0;
    this.stopReason = null;
    this.pendingOffers = null;
    this.awaitingContract = false;
    if (this.remainingPath.length) this._advanceToNextEdge(graph, laneGroups, true);
    else { this.edge = null; this.pendingEdge = null; }
  }

  // Player picked `chosenEdge` at a paused junction; commit to it and
  // re-route the rest of the trip from there so the job still finishes.
  // This is a deliberate, already-paused human choice, not a routine
  // automated transition, so unlike _advanceToNextEdge it places the
  // truck instantly with no departure-gap check.
  resolveDecision(graph, chosenEdge, rnd = Math.random) {
    this.edge = chosenEdge;
    this.s = 0;
    this.lane = 0;
    this.laneT = 0;
    this.passingLeaderId = null;
    this.awaitingDecision = false;
    this.pendingOptions = null;
    if (chosenEdge.to === this.contract.destination) {
      this.remainingPath = [];
      return;
    }
    const path = findPath(graph, chosenEdge.to, this.contract.destination);
    if (path) {
      this.remainingPath = path;
      return;
    }
    // The player's pick left no way back to the original destination (a
    // one-way/customs edge, usually) - leaving remainingPath empty here
    // used to run the truck dry mid-drive with no destination reached,
    // crashing the whole fleet the next time it hit a node with only one
    // way out (_advanceToNextEdge trying to place a null "next edge").
    // Redirect onto a fresh contract from the new position instead, same
    // as any other truck that's arrived somewhere and needs a new load.
    let contract, attempts = 0;
    do {
      contract = generateContract(graph, chosenEdge.to, rnd);
      attempts++;
    } while (!contract.path && attempts < 8);
    this.contract = contract;
    this.remainingPath = contract.path ? [...contract.path] : [];
  }
}

// Options for a junction the player has to call. The truck's own planned
// next edge is always first and always present, even if its control city
// would have ranked it off the end of the list - it's the route the driver
// is already committed to, so it has to be the obvious default rather than
// something the player has to hunt for. The rest follow by control-city
// importance.
function rankAndCapOptions(graph, options, plannedEdge) {
  const isPlanned = (e) => plannedEdge && e.to === plannedEdge.to && e.route === plannedEdge.route;
  const planned = options.find(isPlanned) || null;
  const rest = options
    .filter((e) => e !== planned)
    .sort((a, b) => (graph.nodes[b.control]?.w || 0) - (graph.nodes[a.control]?.w || 0));
  const capped = rest.slice(0, MAX_DECISION_OPTIONS - (planned ? 1 : 0));
  return planned ? [planned, ...capped] : capped;
}

// Weighted by city `w` (roulette-wheel, same shape as economy.js's
// pickDestination) rather than a flat uniform pick over the eligible
// pool - tier-3 cities alone outnumber tier-1 hubs roughly 4 to 1, so a
// flat pick handed small cities disproportionately more starting trucks
// purely from pool arithmetic, independent of how "important" they are.
export function spawnFleet(graph, count, rnd = Math.random) {
  resetNamePool(rnd);
  const cities = Object.values(graph.nodes).filter((n) => n.t > 0 && n.t <= 3);
  let totalWeight = 0;
  for (const c of cities) totalWeight += c.w;
  const trucks = [];
  for (let i = 0; i < count; i++) {
    let roll = rnd() * totalWeight;
    let city = cities[cities.length - 1];
    for (const c of cities) {
      roll -= c.w;
      if (roll <= 0) { city = c; break; }
    }
    trucks.push(new Truck(graph, city.name, rnd));
  }
  return trucks;
}

// --- lane physics helpers -------------------------------------------

// Groups currently-driving trucks (pendingEdge/stranded trucks have no
// `edge` and are excluded) by directed edge and lane, sorted ascending
// by progress along the edge. Rebuilt fresh every updateFleet tick from
// that tick's pre-move snapshot, so decisions are deterministic and
// never see another truck's already-updated-this-tick position. Each
// group also carries the shared `edge` object itself (every truck sharing
// an edgeId is on the same physical road segment, so `.kind`/`.miles`/etc
// are identical across the group) - downstream per-tick passes
// (clampOverlaps, updateFleet's Phase 1) reuse this same Map instead of
// re-deriving their own grouping, which is the thing that used to make
// this "the seam to revisit if the fleet ever scales into the
// thousands" - it since has, so that redundant rebuild is gone now.
// IMPORTANT: the ascending sort is only valid at THIS moment (before any
// truck moves this tick) - different trucks integrate different distances
// in Phase 2, which can and does reorder their relative `.s` within a
// lane by the time later phases run (confirmed empirically during
// verification). Phase 1 runs immediately after this and never mutates
// `.s`, so it's safe to trust this order - anything reading `lane0`/
// `lane1` AFTER Phase 2 has run (clampOverlaps) must re-sort by current
// `.s` rather than trusting this snapshot's order.
// `disabledByEdge` collects the `.s` of every broken-down/dry-tanked
// truck, keyed by edgeId, so the rest of the tick can find them without a
// second pass over `trucks`. A disabled truck is deliberately excluded
// from `groups` (and therefore from every lane-physics consumer below -
// leaderMap, applyFollowAndPassing, clampOverlaps, tryDepartTruck,
// placeOnEdge's occupant scan all read `groups`, never `trucks`) since it
// sits on the shoulder, not in the travel lane: a 0-speed "leader" would
// otherwise propagate a permanent full-stop backward through every
// follower, and clampOverlaps would pin them at its position forever -
// a corridor-wide deadlock immune to any speed logic. Other trucks
// driving straight through its position is the correct, intended result.
function buildLaneGroups(trucks, disabledByEdge) {
  const groups = new Map();
  for (const truck of trucks) {
    if (!truck.edge) continue;
    if (truck.onShoulder) continue; // Shoulder Rider: excluded from normal lane physics for the same reason a disabled truck is (see applyFollowAndPassing) - other trucks drive straight through its shoulder position
    const key = edgeId(truck.edge);
    if (truck.disabledHoursLeft > 0) {
      let arr = disabledByEdge.get(key);
      if (!arr) { arr = []; disabledByEdge.set(key, arr); }
      arr.push(truck.s);
      continue;
    }
    let g = groups.get(key);
    if (!g) { g = { lane0: [], lane1: [], edge: truck.edge }; groups.set(key, g); }
    (truck.lane === 1 ? g.lane1 : g.lane0).push(truck);
  }
  for (const g of groups.values()) {
    g.lane0.sort((a, b) => a.s - b.s);
    g.lane1.sort((a, b) => a.s - b.s);
  }
  for (const arr of disabledByEdge.values()) arr.sort((a, b) => a - b);
  return groups;
}

// --- environment: rush hour + weather ---------------------------------
//
// Both slow a truck's cruise target rather than capping it, so they layer
// with car-following instead of fighting it. `env` is
// { weather, showWeather, showRushHour, gameSeconds } supplied by main.js;
// when it's null (as in the pure-simulation regression harnesses) nothing
// here runs and the sim behaves exactly as it did before these existed.

// Peak commuter windows, in LOCAL minutes at the truck's own longitude -
// morning and evening rush genuinely happen at 8am/5pm local across the
// country, not simultaneously everywhere, and the terminator math needed
// to know that already exists in geo.js.
const RUSH_WINDOWS = [[420, 555], [960, 1110]]; // 07:00-09:15, 16:00-18:30
const RUSH_WORST = 0.62; // speed multiplier at peak, right at a major metro

// How "metro" an edge is, 0..1, from the heavier of its two endpoints.
// Cached on the edge object the first time it's asked for: edges are
// created once in buildGraph and never mutated, and this is a pure
// function of the graph, so recomputing it per truck per tick would be
// pure waste.
function edgeMetroFactor(graph, edge) {
  if (edge._metro === undefined) {
    const a = graph.nodes[edge.from], b = graph.nodes[edge.to];
    const w = Math.max(a.w || 0, b.w || 0);
    edge._metro = Math.max(0, Math.min(1, (w - 4.5) / 5.5)); // w<=4.5 rural -> 0, w>=10 megacity -> 1
  }
  return edge._metro;
}

function rushHourMult(graph, truck, gameSeconds) {
  const metro = edgeMetroFactor(graph, truck.edge);
  if (metro <= 0) return 1;
  const node = graph.nodes[truck.edge.from];
  const m = localMinutesAtX(node.x, gameSeconds);
  for (const [start, end] of RUSH_WINDOWS) {
    if (m < start || m > end) continue;
    // Ramp in and out across the window instead of a step change, so the
    // fleet visibly congeals and then loosens again.
    const t = (m - start) / (end - start);
    const peak = Math.sin(t * Math.PI);
    return 1 - (1 - RUSH_WORST) * peak * metro;
  }
  return 1;
}

// Weather alone (no rush hour) - kept separate from rush hour so Phase 1
// can snapshot `truck.freeFlowSpeed` (what this truck would be doing on
// an open road right now, weather included) BEFORE rush hour, rubberneck,
// follow, and arrival caps apply. The congestion detector (render.js's
// tallyCongestion) compares live speed against this snapshot to measure
// actual slowdown - weather counts as "the road is just slow today", not
// congestion, but rush hour and a real jam both should read as congested,
// so they're excluded from the baseline instead.
function weatherOnlyMult(graph, truck, env) {
  if (!(env.showWeather && env.weather)) return 1;
  // Edge midpoint is plenty for weather sampling - cells are hundreds of
  // world units across, far larger than any single edge.
  const a = graph.nodes[truck.edge.from], b = graph.nodes[truck.edge.to];
  return weatherSpeedMultAt(env.weather, (a.x + b.x) / 2, (a.y + b.y) / 2);
}

// Speed cap for a truck approaching a real city (tier > 0) at the end of
// its current edge - Infinity (no cap) for a tier-0 junction pass-through,
// a mid-route real-city waypoint the route just happens to run through
// (remainingPath still has hops left after this edge - i.e. this edge's
// `to` isn't actually truck.contract.destination), or while still
// outside the decel zone. Only the truck's genuine final leg slows down;
// everything else carries straight through at cruise speed.
function arrivalSpeedCap(graph, truck, cruiseTargetSpeed) {
  const toNode = graph.nodes[truck.edge.to];
  if (toNode.t === 0) return Infinity; // tier-0 junction filler is never a real stop, agent or not
  // A career truck decelerates for ANY node it's actually going to stop
  // at, not just its final contract destination - otherwise a mid-route
  // fuel/pull-in stop blows through at full cruise and snaps straight to
  // 0 inside parkForStop the instant it arrives. `stopReasonAt` is pure
  // (no mutation), so calling it here speculatively - before the stop
  // has "really" happened - is safe; nodeStopReason (Phase 4) makes the
  // same call for real once the truck actually reaches the node.
  if (truck.remainingPath.length > 0) {
    if (!truck.agent || !truck.agent.stopReasonAt(toNode)) return Infinity;
  }
  const zone = ARRIVAL_DECEL_BASE_MI + truck.edge.speedLimit * ARRIVAL_DECEL_PER_MPH;
  const remaining = truck.edge.miles - truck.s;
  if (remaining >= zone) return Infinity;
  const frac = Math.max(0, remaining / zone);
  return ARRIVAL_MIN_MPH + (cruiseTargetSpeed - ARRIVAL_MIN_MPH) * frac;
}

// Car-following + passing, interstate edges only. Reads/mutates the
// truck's lane state and returns an additional speed cap (Infinity if
// nothing ahead is a factor). `leaderMap` (built once per tick by
// updateFleet's Phase 1, before any truck's state changes) gives O(1)
// leader lookup instead of the `ownArr.indexOf(truck)` rescan this used to
// do - deliberately NOT restructured to iterate lane arrays directly
// instead of `trucks`: Phase 1 mutates each truck's own `.speed` in
// place as it goes, and a follower's cap here reads its leader's
// `.speed` LIVE - so which trucks have or haven't been processed yet
// this same tick (i.e. `trucks`-array iteration order specifically)
// silently affects the result. Confirmed by exact-match testing against
// the pre-refactor baseline: an earlier version of this change iterated
// lane arrays instead (back-to-front by position) and produced a
// systematically different simulation, not just an occasional tie.
// Preserving the exact original iteration order was necessary for a
// true behavior-preserving optimization here.
function applyFollowAndPassing(graph, truck, laneGroups, leaderMap, followerMap, cruiseTargetSpeed, rnd) {
  if (truck.edge.kind !== "interstate") return Infinity;

  // Shoulder Rider, already engaged: buildLaneGroups excluded this truck
  // from `laneGroups` for the whole tick (see its comment), so there's no
  // leader/group to read here at all - just hold the flat "flying past
  // the jam" pace until Phase 2's mileage countdown ends the ride.
  if (truck.onShoulder) return SHOULDER_RIDE_MPH;

  const group = laneGroups.get(edgeId(truck.edge));
  if (!group) return Infinity;
  const leader = leaderMap.get(truck) || null;

  const safeMi = minSafeMiles(graph, truck.edge);
  const gapToLeader = leader ? leader.s - truck.s : Infinity;
  const timeGap = (truck.speed * FOLLOW_TIME_GAP_S) / 3600;

  // Shoulder Rider ENGAGE check - this is the one tick that still sees a
  // real leader (before exclusion kicks in next tick). Outlaws only, and
  // only in a genuinely dead jam - a small per-tick chance rather than an
  // instant reaction, so it reads as a driver deciding to risk it rather
  // than a deterministic rule.
  if (truck.driver.isOutlaw && truck.lane === 0 && leader && leader.speed < SHOULDER_JAM_MPH && rnd() < SHOULDER_TRIGGER_CHANCE) {
    truck.onShoulder = true;
    truck.shoulderMilesLeft = SHOULDER_MIN_MILES + rnd() * (SHOULDER_MAX_MILES - SHOULDER_MIN_MILES);
    return SHOULDER_RIDE_MPH;
  }

  // Convoy Drafter: a same-lane leader running at real highway speed and
  // close enough to tuck in behind. Locks the follow speed to exactly
  // the leader's (not merely capped by it) so the pair actually travels
  // together instead of the follower drifting back to its own cruise
  // target the moment the gap opens a little - that persistence is what
  // turns a chance encounter into a visible multi-truck convoy. Purely
  // reactive (recomputed fresh every tick, never sticky): a driver only
  // opts in while an actual qualifying leader is right there, and drops
  // out the instant that stops being true - never considers a pass while
  // drafting (see the `isDrafting` guard below skipping that block).
  truck.isDrafting = !!(truck.driver.isDrafter && truck.lane === 0 && leader
    && leader.speed >= DRAFT_MIN_LEADER_MPH
    && gapToLeader < safeMi * DRAFT_ENGAGE_SAFE_MULT);
  if (truck.isDrafting) return leader.speed;

  const blocked = gapToLeader < safeMi * FOLLOW_TRIGGER_MULT + timeGap;
  const followCap = blocked ? Math.min(cruiseTargetSpeed, leader.speed) : Infinity;

  // Emergency hard clamp: the trigger margin above is meant to start
  // slowing a truck well before this, but speed only EASES toward a
  // capped target rather than snapping to it, so a truck closing fast
  // can still dip toward the true anti-overlap floor for a tick or two
  // before easing catches up. If the gap has already shrunk into that
  // zone, cut speed immediately instead of waiting on the normal ease.
  if (leader && gapToLeader <= safeMi * EMERGENCY_BRAKE_MULT) {
    truck.speed = Math.min(truck.speed, leader.speed * 0.85);
  }

  // Passing is considered on a much earlier, looser trigger than the
  // speed cap above - not "blocked", which by definition means the gap
  // is already tight. Deciding to change lanes only once already
  // tailgating left no room for the visual lane-blend (laneT easing
  // from 0 toward 1) to widen the truck's lateral offset before the
  // along-edge gap could close further, so a pass could begin from a
  // dot-diameter's width away with almost no lateral separation yet -
  // exactly the moment separation is smallest. Starting the maneuver
  // while there's still real room (a real driver decides to pass well
  // before tailgating) keeps that transition comfortably clear.
  const wantsToPass = !!leader && gapToLeader < safeMi * PASS_CONSIDER_MULT + timeGap;
  const inArrivalZone = arrivalSpeedCap(graph, truck, cruiseTargetSpeed) < cruiseTargetSpeed;
  // HAMMER throttle (career mode) always clears the aggression gate below,
  // regardless of this specific rig's own fixed driver.aggression roll -
  // "floor it and get around slower traffic" is the whole point of
  // choosing HAMMER, so a low-aggression driver's truck shouldn't sit
  // stuck behind a leader just because its baseline DNA rolled passive.
  const willingToPass = truck.driver.aggression > PASS_AGGRESSION_THRESHOLD || truck.agent?.hammering;
  if (truck.lane === 0 && wantsToPass && !inArrivalZone && willingToPass) {
    const leftArr = group.lane1;
    const clear = !leftArr.some((t) => t.s > truck.s - safeMi * PASS_CLEAR_BEHIND_MULT && t.s < leader.s + safeMi * PASS_CLEAR_AHEAD_MULT);
    if (clear) {
      truck.lane = 1;
      truck.passingLeaderId = leader.id;
    }
  } else if (truck.lane === 1 && truck.passingLeaderId != null && !truck.driver.isLaneCamper) {
    // Merge back once clear of the truck being passed (or it's gone -
    // arrived, took a different edge, whatever) and lane 0 is clear alongside.
    const passed = group.lane0.find((t) => t.id === truck.passingLeaderId);
    const clearOfPassed = !passed || (truck.s - passed.s) > safeMi * MERGE_BACK_CLEAR_MULT;
    if (clearOfPassed) {
      const lane0Clear = !group.lane0.some((t) => t.s > truck.s - safeMi * PASS_CLEAR_BEHIND_MULT && t.s < truck.s + safeMi * PASS_CLEAR_AHEAD_MULT);
      if (lane0Clear) { truck.lane = 0; truck.passingLeaderId = null; }
    }
  }
  // Left-Lane Camper: isLaneCamper drivers hit the guard above and simply
  // never merge back - a rolling roadblock in the passing lane until
  // something else resets `lane` (arrival, a fresh contract leg, etc.).

  // HAMMER intimidation aura (career mode): checked independently of the
  // pass/merge-back branch above, and independent of isLaneCamper - a
  // closing player at 18% over cruise is a different force than that
  // driver's own choice not to merge back, so it overrides the camper's
  // stickiness too. High-aggression AI (Outlaws, Super-Speeders) hold
  // their ground; intimidating them would be backwards.
  if (truck.lane === 1 && truck.driver.aggression < INTIMIDATION_AGGRESSION_THRESHOLD) {
    const follower = followerMap.get(truck);
    if (follower?.agent?.hammering && truck.s - follower.s < safeMi * INTIMIDATION_TRIGGER_MULT) {
      truck.lane = 0;
      truck.passingLeaderId = null;
    }
  }

  return followCap;
}

// A truck stopped at a real city, waiting for room to pull into the
// destination edge's right lane. Departs once clear, or once the
// defensive timeout elapses - either way it enters at s=0/speed=0, so
// the normal accel easing on the next tick is what gives it the
// "accelerate away from the city" look, with no extra mechanism needed.
//
// A waiting truck has no `edge` yet, so buildLaneGroups' pre-tick
// snapshot never included it - meaning two trucks queued to depart onto
// the SAME edge from the same city wouldn't see each other and could
// both land at s=0 in the same tick. `placeOnEdge` registering a truck
// into the lane group the instant it enters (not just at the top of the
// next tick) closes that: any other truck processed later this same
// tick sees it and correctly waits/nudges instead.
function tryDepartTruck(graph, truck, laneGroups, dt) {
  const key = edgeId(truck.pendingEdge);
  const lane0 = laneGroups.get(key)?.lane0 || [];
  const safeMi = minSafeMiles(graph, truck.pendingEdge);
  const blocked = truck.pendingEdge.kind === "interstate" && lane0.some((t) => t.s < safeMi);

  truck.departureWaitS += dt;
  if (!blocked || truck.departureWaitS > MAX_DEPARTURE_WAIT_REAL_S) {
    placeOnEdge(graph, truck, truck.pendingEdge, laneGroups);
  }
}

// Places a truck onto `edge` at s=0 and registers it into this tick's
// lane groups so any other truck placed onto the same edge later in the
// same tick sees it. `truck.lane`/`laneT` are left exactly as the caller
// set them: a fresh departure from a full stop already has them reset to
// 0 by the time this runs (see tryDepartTruck), while a truck merely
// continuing through a junction or a mid-route city keeps whatever lane
// it was already in - it stays in the passing lane straight through the
// node rather than snapping back to the right lane, matching a truck
// it's mid-pass on doing the same. If something's already sitting nearby
// (two or more trucks converging through the same junction onto the same
// next edge in the same tick, the one unprotected case a stop-and-wait
// deliberately doesn't cover - junctions aren't real stops), nudge in
// just behind it instead of landing exactly on top of it - checking BOTH
// lanes (a truck can enter right next to a lane-1 occupant that's still
// mid-lane-change, not yet far enough over to be laterally clear on its
// own) and chaining past a whole run of them: checking only the single
// nearest occupant isn't enough once a third truck can arrive the same
// tick and need to clear the truck the *second* one was just nudged
// behind, not the original.
function placeOnEdge(graph, truck, edge, laneGroups, headStart = 0) {
  truck.edge = edge;
  truck.pendingEdge = null;
  const key = edgeId(edge);
  let group = laneGroups ? laneGroups.get(key) : null;
  const unitsPerMile = worldUnitsPerMile(graph, edge);
  const myOffset = laneOffset(truck);
  let s = Math.min(headStart, edge.miles);
  if (group) {
    const occupants = [...group.lane0, ...group.lane1].sort((a, b) => a.s - b.s);
    for (const t of occupants) {
      const target = crossLaneTarget(t.laneT, truck.laneT);
      const perpGap = Math.abs(laneOffset(t) - myOffset);
      if (perpGap >= target) continue; // laterally clear regardless of s
      const neededWorldGap = Math.sqrt(target ** 2 - perpGap ** 2);
      const neededMiles = Math.min(neededWorldGap / unitsPerMile, edge.miles);
      if (Math.abs(t.s - s) < neededMiles) s = t.s + neededMiles;
    }
    if (s > edge.miles && group) {
      // Chaining forward past a long run of occupants ran out of edge
      // before it ran out of trucks to clear. Simply clamping every such
      // truck to the same edge.miles boundary would just recreate an
      // exact tie one step removed (each one's chain sees the previous
      // truck sitting at that same collapsed point and overflows past it
      // again) - pack backward from the end instead, so a crowded edge
      // degrades to "tighter than ideal" rather than "literally on top
      // of each other".
      s = edge.miles;
      const byDistance = [...group.lane0, ...group.lane1].sort((a, b) => b.s - a.s);
      for (const t of byDistance) {
        if (t.s < s) break; // already comfortably behind this candidate slot
        const target = crossLaneTarget(t.laneT, truck.laneT);
        const perpGap = Math.abs(laneOffset(t) - myOffset);
        if (perpGap >= target) continue;
        const neededWorldGap = Math.sqrt(target ** 2 - perpGap ** 2);
        const neededMiles = Math.min(neededWorldGap / unitsPerMile, edge.miles);
        if (t.s - s < neededMiles) s = Math.max(0, t.s - neededMiles);
      }
    }
  }
  // Clamp the final result to this edge's own length no matter which
  // pass produced it, so a truck can never be placed beyond where it's
  // already due to arrive. (If that leaves it packed in tighter than
  // ideal, that's the same "edge too short to fully
  // separate everyone on it" tradeoff documented on minSafeMiles.)
  truck.s = Math.min(s, edge.miles);
  if (laneGroups) {
    if (!group) { group = { lane0: [], lane1: [] }; laneGroups.set(key, group); }
    const arr = truck.lane === 1 ? group.lane1 : group.lane0;
    arr.push(truck);
    arr.sort((a, b) => a.s - b.s); // keep the ascending-by-progress invariant intact for this tick's remaining lookups
  }
}

// Mirrors render.js's truckWorldPos lane-blend exactly: a truck mid-way
// through a lane change (0 < laneT < 1) sits only partway toward the
// passing lane's full separation from lane 0.
function laneOffset(truck) {
  return RIGHT_LANE_OFFSET + (LEFT_LANE_OFFSET - RIGHT_LANE_OFFSET) * truck.laneT;
}

// The along-edge gap threshold two trucks need, continuously interpolated
// on how far apart their laneT actually is - NOT on the discrete `.lane`
// target flag. RIGHT_LANE_OFFSET - LEFT_LANE_OFFSET === CROSS_LANE_TARGET_
// WORLD_UNITS by construction, so perpGap between any two trucks is always
// exactly CROSS_LANE_TARGET_WORLD_UNITS * |Δlanet|, bounded in [0,
// CROSS_LANE_TARGET_WORLD_UNITS] - meaning a plain linear ramp from
// MIN_DOT_GAP_WORLD_UNITS (same visual lane) down to CROSS_LANE_TARGET_
// WORLD_UNITS (fully opposite lanes) lands exactly on both today's steady-
// state endpoints with a smooth, monotonic gradient between them. Using
// the discrete flag instead (as this used to) relaxes the threshold the
// instant a pass/merge DECISION is made, before the truck has actually
// moved sideways - reading as a same-tick longitudinal snap rather than a
// diagonal glide. This formula makes that discontinuity structurally
// impossible rather than just less likely.
function crossLaneTarget(laneTA, laneTB) {
  const diff = Math.abs(laneTA - laneTB);
  return MIN_DOT_GAP_WORLD_UNITS - (MIN_DOT_GAP_WORLD_UNITS - CROSS_LANE_TARGET_WORLD_UNITS) * diff;
}

// After every truck has moved this tick, two trucks can still end up too
// close: car-following/passing above only reacts to *last* tick's other
// trucks, so a leader braking hard (its own arrival-decel, using a
// decelRate up to 5.2) can lose speed faster within a single tick than a
// one-tick-lagged follower can track - and a truck early in a lane
// change (laneT still near 0) hasn't yet gained the passing lane's full
// lateral separation, so a fresh departure landing nearby in the other
// lane can still end up closer than it looks from `s` alone. Rather
// than chase either case with ever-tighter speed/timing heuristics,
// this clamps positions directly after integration using each truck's
// TRUE rendered offset (same formula as truckWorldPos) and the real
// Pythagorean distance - front-to-back per edge, each truck capped to
// whatever along-edge gap is still needed once its actual lateral
// separation from the truck ahead is accounted for. This guarantees the
// render-time gap regardless of how the speed/lane decisions played
// out. A truck clamped back below its edge's length simply arrives a
// tick later than it otherwise would (a realistic "stuck behind stopped
// traffic" outcome).
// Takes the tick's already-built `laneGroups` (same Map updateFleet's
// Phase 1 uses) instead of re-deriving its own grouping from `trucks` -
// still avoids the full O(n) Map-rebuild-from-`trucks` every tick (group
// MEMBERSHIP by edge doesn't change mid-tick), but each group's `lane0`/
// `lane1` were only sorted once, at the top of updateFleet, BEFORE Phase 1
// (speed decisions) and Phase 2 (position integration) ran - different
// trucks move different distances this same tick, which can and does
// reorder their relative `.s` within a lane before clampOverlaps runs
// (confirmed empirically: two same-lane trucks swapped relative order
// within a single tick during verification). So this still needs a fresh
// sort by CURRENT `.s`, not a merge that trusts the stale buildLaneGroups
// order - a merge would silently process pairs in the wrong order.
function clampOverlaps(graph, laneGroups) {
  for (const group of laneGroups.values()) {
    if (group.edge.kind !== "interstate") continue;
    if (group.lane0.length + group.lane1.length < 2) continue;
    const ascending = [...group.lane0, ...group.lane1].sort((a, b) => a.s - b.s);
    const unitsPerMile = worldUnitsPerMile(graph, group.edge);
    // Walk front-to-back (highest `.s` first) by iterating the ascending
    // merge in reverse - equivalent to the original's fresh descending
    // sort, without building a second array.
    for (let i = ascending.length - 1; i > 0; i--) {
      const ahead = ascending[i], behind = ascending[i - 1];
      const target = crossLaneTarget(ahead.laneT, behind.laneT);
      const perpGap = Math.abs(laneOffset(ahead) - laneOffset(behind));
      if (perpGap >= target) continue; // laterally clear regardless of along-edge gap
      const neededWorldGap = Math.sqrt(target ** 2 - perpGap ** 2);
      const neededMiles = Math.min(neededWorldGap / unitsPerMile, ahead.edge.miles);
      const maxAllowed = ahead.s - neededMiles;
      // Each pairwise push is capped to the edge's own length, but (as in
      // placeOnEdge) that only bounds one step, not a chain of several -
      // clamp the final result too so a reduction can never itself leave
      // a truck's s negative-then-wrapped or otherwise inconsistent.
      if (behind.s > maxAllowed) behind.s = Math.max(0, Math.min(maxAllowed, ahead.edge.miles));
    }
  }
}

// --- fuel / fatigue / breakdown helpers -------------------------------

// Fuel burn for the miles just driven: base rate x this driver's
// fuelBurnMult x an aerodynamic drag penalty that only kicks in above
// FUEL_DRAG_SPEED_MPH (an aggressive driver cruising fast pays for it).
function burnPerMile(truck) {
  const drag = 1.0 + Math.pow(Math.max(0, truck.speed / FUEL_DRAG_SPEED_MPH - 1.0), 2);
  const draftDiscount = truck.isDrafting ? 0.7 : 1.0; // Convoy Drafter: -30% burn while actually tucked in behind a leader
  return FUEL_BURN_PER_MILE * truck.driver.fuelBurnMult * drag * draftDiscount * (truck.agent?.burnMult ?? 1);
}

// Rough remaining range in miles at this truck's current fuel level, for
// the detail panel's gauge - the no-drag rate is a fine estimate for a
// forward-looking display (drag only matters above FUEL_DRAG_SPEED_MPH).
export function estimatedRangeMiles(truck) {
  return truck.fuel / (FUEL_BURN_PER_MILE * truck.driver.fuelBurnMult);
}

// Fuel needed to cover `miles` more of driving, with FUEL_REFILL_MARGIN
// headroom - the no-drag rate is a fine estimate since drag only applies
// to a small speed band.
function fuelNeededFor(truck, miles) {
  return miles * FUEL_BURN_PER_MILE * truck.driver.fuelBurnMult * FUEL_REFILL_MARGIN;
}

// How much fuel a refuel (at a node, or recovering from a dry-tank
// breakdown) should top off to - never a flat 100, which would re-strand
// a truck on an edge longer than a full tank's range. Covers whatever
// distance is actually still ahead: the rest of the CURRENT edge if the
// truck is disabled mid-edge, or the next queued edge if it's parked at
// a node about to depart.
function refuelAmountNeeded(truck) {
  let remainingMiles = 0;
  if (truck.edge) remainingMiles = truck.edge.miles - truck.s;
  else if (truck.remainingPath[0]) remainingMiles = truck.remainingPath[0].miles;
  const minFuel = remainingMiles > 0 ? fuelNeededFor(truck, remainingMiles) : 0;
  return Math.max(truck.fuelCapacity, minFuel);
}

// Pumps `units` of diesel into the tank and bills for it - clamped to
// fuelCapacity, since a career player choosing an arbitrary fill amount
// (unlike the AI's own always-exact `need`) can actually ask for more
// than the tank holds. The single place fuel is ever added, so every
// purchase - gradual AI pump stop, roadside tow-and-fill, a player's
// PUMPS purchase - lands in the same totals. A career truck's bill goes
// to its agent (career.js's own cash ledger - see career.js's "Money"
// design note on why that's deliberately NOT truck.earnings) instead of
// the ordinary earnings/fuelSpend fields, which stay meaningful for
// fleet-wide rankings/digest only when every truck in them is autopilot.
export function pumpFuel(truck, units, pricePerUnit = FUEL_PRICE_PER_UNIT) {
  if (units <= 0) return;
  units = Math.min(units, truck.fuelCapacity - truck.fuel);
  if (units <= 0) return;
  const cost = units * pricePerUnit;
  if (truck.agent) {
    truck.agent.onFuelPurchased(cost, units);
  } else {
    truck.earnings -= cost;
    truck.fuelSpend += cost;
    truck.dayFuelSpend += cost;
  }
  truck.fuel += units;
}

// Fills the tank instantly - the roadside recovery case, where a service
// truck has already spent the whole disabled window getting there.
function applyRefuel(truck) {
  pumpFuel(truck, Math.max(0, refuelAmountNeeded(truck) - truck.fuel));
}

// Starts a GRADUAL fill spread across `hours` of the stop the truck is
// about to sit through, rather than snapping the tank full on wake. The
// gauge in the detail panel re-renders every frame, so ramping the
// underlying value is what makes it visibly climb at the pump - no
// separate animation layer, and the sim stays the single source of truth
// (a truck woken early really is only part-filled, and only billed for
// what went in).
function beginRefuel(truck, hours) {
  const need = Math.max(0, refuelAmountNeeded(truck) - truck.fuel);
  if (need <= 0 || hours <= 0) { truck.refuelTarget = null; return; }
  truck.refuelTarget = truck.fuel + need;
  truck.refuelPerHour = need / hours;
}

// Advances an in-progress fill by one tick's worth of game time.
function tickRefuel(truck, gameHours) {
  if (truck.refuelTarget == null) return;
  const units = Math.min(truck.refuelPerHour * gameHours, truck.refuelTarget - truck.fuel);
  pumpFuel(truck, units);
  if (truck.fuel >= truck.refuelTarget - 1e-6) truck.refuelTarget = null;
}

// Tops off whatever the ramp hasn't delivered yet and ends the fill - the
// stop is over, so the pump either finished or gets to finish now.
function finishRefuel(truck) {
  if (truck.refuelTarget == null) return;
  pumpFuel(truck, Math.max(0, truck.refuelTarget - truck.fuel));
  truck.refuelTarget = null;
}

// True if minute-of-day `m` falls in [start, end), where the window may
// wrap past midnight (start > end, e.g. 21:00-03:00).
function isInWindow(m, start, end) {
  return start <= end ? (m >= start && m < end) : (m >= start || m < end);
}

// Fuel takes priority (a physical necessity); circadian rest only checked
// if fuel is fine. `env` is null in the headless harness path (no game
// clock to read local time from), so rest simply never fires there -
// fuel and breakdowns are both deterministic and still fully exercised.
function nodeStopReason(graph, truck, node, env) {
  // Career mode: the player's own stop logic entirely replaces the AI's
  // (a career player decides when to fuel/rest themselves - see
  // career.js's createAgent). stopReasonAt is pure/side-effect-free, so
  // arrivalSpeedCap below can also call it speculatively to know whether
  // to decelerate for a stop that isn't the truck's contract destination.
  // A non-destination "PLAYER" stop always opens on PUMPS - the truck
  // stop is a full multi-tab takeover (career-ui.js), not a single-
  // purpose panel, so which tab is merely a UX default, not a functional
  // choice (a delivery arrival, handled entirely in _arriveAtDestination
  // rather than here, opens on BOARD instead).
  if (truck.agent) {
    const reason = truck.agent.stopReasonAt(graph.nodes[node]);
    if (reason) truck.stopVendor = "PUMPS";
    return reason;
  }

  const nextEdge = truck.remainingPath[0];
  if (truck.fuel <= FUEL_LOW_THRESHOLD || (nextEdge && truck.fuel < fuelNeededFor(truck, nextEdge.miles))) {
    return "FUEL";
  }
  if (env && !truck.driver.isOutlaw && truck.fatigue > FATIGUE_REST_THRESHOLD) {
    const m = localMinutesAtX(graph.nodes[node].x, env.gameSeconds);
    const inWindow = truck.driver.isNightOwl
      ? isInWindow(m, NIGHT_OWL_SLEEP_START_MIN, NIGHT_OWL_SLEEP_END_MIN)
      : isInWindow(m, STANDARD_SLEEP_START_MIN, STANDARD_SLEEP_END_MIN);
    if (inWindow) return "REST";
  }
  return null;
}

// Parks a truck at a real-city node for a REST or FUEL stop - same
// parkedAt/dwellHoursLeft fields a delivery layover uses (see the
// `stopReason` field comment on Truck), so every parkedAt-keyed system
// (badge tally, hidden dot, tap fall-through) needs no changes to cover
// these two new stop kinds.
function parkForStop(truck, node, reason, rnd) {
  truck.edge = null;
  truck.pendingEdge = null;
  truck.speed = 0;
  truck.lane = 0;
  truck.laneT = 0;
  truck.passingLeaderId = null;
  truck.parkedAt = node;
  truck.stopReason = reason;
  // PLAYER: no dwell to roll (Phase 4's parked branch never counts it
  // down for a "PLAYER" stop anyway - see updateFleet) and no auto-fill
  // (buying fuel is now a real, billed player action - see pumpFuel).
  truck.dwellHoursLeft = reason === "PLAYER" ? 0
    : reason === "FUEL" ? FUEL_STOP_HOURS
    : REST_MIN_HOURS + rnd() * (REST_MAX_HOURS - REST_MIN_HOURS);
  // Fuel goes in over the whole pump stop (see beginRefuel). A REST stop
  // is not at a pump, so it fills nothing.
  if (reason === "FUEL") beginRefuel(truck, truck.dwellHoursLeft);
}

// Disables a truck ON THE SHOULDER, mid-edge - see the `disabledHoursLeft`
// field comment on Truck for why this is distinct from parkedAt.
function disableTruck(truck, reason, hours) {
  truck.speed = 0;
  truck.disabledHoursLeft = hours;
  truck.disabledReason = reason;
  truck.onShoulder = false; // a breakdown/dry-tank mid shoulder-ride ends the ride; it resumes in the normal lane once repaired
  truck.shoulderMilesLeft = 0;
}

// Speed multiplier from "rubbernecking" a disabled truck ahead on the
// same edge: deepens monotonically as a truck closes the gap, and is
// exactly 1 (no effect) the instant its `.s` passes the disabled truck's
// - "out of potential traffic once they pass." `sortedS` is ascending, so
// gap = ds - truck.s increases monotonically as we walk it: once gap
// exceeds `range` every later entry is farther still, so it's safe to
// stop scanning. The zone is sized off minSafeMiles (a multiple of the
// render-scale anti-overlap floor), NOT an absolute mile count - at this
// map's projection a couple of real miles is sub-pixel, and would be
// invisible on screen and too short to ever stack a visible queue.
function rubberneckMult(sortedS, graph, truck) {
  if (!sortedS || !sortedS.length) return 1;
  const range = minSafeMiles(graph, truck.edge) * RUBBERNECK_RANGE_SAFE_MULT;
  let mult = 1;
  for (const ds of sortedS) {
    const gap = ds - truck.s;
    if (gap > range) break;
    if (gap <= 0) continue;
    const closeness = 1 - gap / range;
    const m = 1 - (1 - RUBBERNECK_WORST_MULT) * closeness;
    if (m < mult) mult = m;
  }
  return mult;
}

// Departs a truck from a full stop at a node - either a fresh contract
// leg it was always going to take, or the SAME contract's next leg after
// waking from a REST/FUEL park. `reverseOfEdge` is the edge the truck
// just arrived on (excluded from the controlled-truck's junction options
// so it isn't offered an immediate U-turn); `fromFullStop` is forwarded
// to `_advanceToNextEdge` to decide whether this departure gets the
// stop-and-wait-for-a-gap treatment.
function departFromNode(graph, truck, laneGroups, controlledTruck, reverseOfEdge, fromFullStop) {
  // GPS (or the AI Driver upgrade, which implies it - see main.js's
  // stamping side) skips the junction call entirely: the truck just keeps
  // rolling along its own already-planned remainingPath below, exactly
  // like any ordinary AI truck already does without ever pausing. Plain
  // fields on the truck itself, same as fleetWearMult above - fleet.js has
  // no idea "GPS" or career mode exist, it just reads a flag.
  if (truck === controlledTruck && !truck.gps && !truck.autoDriver) {
    const options = pickEdgesFrom(graph, truck.currentNode, reverseOfEdge);
    if (options.length > 1) {
      truck.pendingOptions = rankAndCapOptions(graph, options, truck.remainingPath[0]);
      truck.awaitingDecision = true;
      return truck;
    }
  }
  truck._advanceToNextEdge(graph, laneGroups, fromFullStop);
  return null;
}

// Ends a career "PLAYER" stop and resumes the truck's existing route -
// the player-driven equivalent of the automatic REST/FUEL wake path
// above, but callable directly from OUTSIDE a tick (career-ui.js's ROLL
// OUT button), the same way main.js's existing resolveContract/
// resolveDecision already call Truck methods directly from a synchronous
// UI handler rather than through updateFleet. `laneGroups=null` is safe
// here for the same reason it's safe there: departFromNode's only use of
// it is `_advanceToNextEdge`'s `placeOnEdge` branch, which never runs for
// a `fromFullStop` departure from a real city (see `_advanceToNextEdge`'s
// own comment) - it always takes the `pendingEdge` branch instead, which
// the next real updateFleet tick picks up with its own freshly-built
// laneGroups. Returns the truck if a junction choice is now pending
// (mirrors updateFleet's own return contract - the caller should show
// the decision panel, exactly as it would for any other controlled
// truck), or null if the truck just departed cleanly.
export function resumeFromPlayerStop(graph, truck) {
  truck.stopReason = null;
  truck.parkedAt = null;
  truck.stopVendor = null;
  truck.milesSinceStop = 0;
  return departFromNode(graph, truck, null, truck, truck.prevEdge, true);
}

// Advances every truck by `dt` real seconds at the given time-scale
// multiplier. Returns the truck awaiting a junction decision, if any
// (only possible for `controlledTruck` - the one truck the player has
// explicitly taken control of via the details panel, a separate,
// narrower thing than merely being followed by the camera), so the
// caller can pause the whole sim and show the decision panel. `rnd`
// defaults to Math.random but accepts a seeded generator for the
// headless soak-test harness.
export function updateFleet(graph, trucks, dt, timeScale, controlledTruck, env = null, rnd = Math.random) {
  const gameHours = (dt * BASE_TIME_SCALE * timeScale) / 3600;
  const disabledByEdge = new Map();
  const laneGroups = buildLaneGroups(trucks, disabledByEdge);
  lastDisabledByEdge = disabledByEdge;

  // Precomputed once per tick, before Phase 1 mutates anything: each
  // truck's leader (the next entry in its lane array, or null), from the
  // same fresh laneGroups snapshot Phase 1 already relies on. O(1) lookup
  // per truck in Phase 1 below instead of the old `ownArr.indexOf(truck)`
  // rescan - built here (rather than inline per-truck) specifically so
  // Phase 1's own iteration order over `trucks` doesn't change (see the
  // long comment on applyFollowAndPassing for why that order matters).
  const leaderMap = new Map();
  // followerMap is the mirror of leaderMap (truck -> the truck directly
  // behind it in the same lane) - built in the same pass since it's the
  // same sorted-by-s arrays, purely so applyFollowAndPassing's HAMMER
  // intimidation check can ask "is a career truck closing on ME from
  // behind" in O(1) instead of rescanning the lane.
  const followerMap = new Map();
  for (const group of laneGroups.values()) {
    for (const lane of [group.lane0, group.lane1]) {
      for (let i = 0; i < lane.length - 1; i++) {
        leaderMap.set(lane[i], lane[i + 1]);
        followerMap.set(lane[i + 1], lane[i]);
      }
    }
  }

  // Phase 1: decide each truck's target speed/lane and ease toward it -
  // reads other trucks' pre-move positions (laneGroups/leaderMap), same
  // as before.
  for (const truck of trucks) {
    if (truck.awaitingDecision || truck.awaitingContract || truck.pendingEdge || !truck.edge || truck.disabledHoursLeft > 0) continue;

    let targetSpeed = truck.edge.speedLimit * truck.driver.cruiseMult * (truck.agent?.speedMult ?? 1);
    // Environmental slowdowns are applied to the CRUISE target rather than
    // as a hard cap, so car-following and the arrival decel below still
    // compose on top normally - a truck crawling through a blizzard still
    // brakes for the truck in front of it.
    if (env) {
      targetSpeed *= weatherOnlyMult(graph, truck, env);
      // Snapshot BEFORE rush hour/rubberneck/follow/arrival - this is what
      // the truck would be doing on an open road right now (weather
      // included; weather is "the road is slow today", not congestion).
      // render.js's tallyCongestion compares live speed against this to
      // detect a genuine slowdown, independent of fleet size.
      truck.freeFlowSpeed = targetSpeed;
      if (env.showRushHour) targetSpeed *= rushHourMult(graph, truck, env.gameSeconds);
    } else {
      truck.freeFlowSpeed = targetSpeed;
    }
    // Rubbernecking a disabled truck ahead - also a target-level
    // multiplier (not a hard cap) for the same reason, and composes with
    // the follow cap below since it's applied before that Math.min.
    targetSpeed *= rubberneckMult(disabledByEdge.get(edgeId(truck.edge)), graph, truck);
    // A truck slowing for ITS OWN upcoming stop is not congestion - flag it
    // here (before the cap is applied) so render.js's tallyCongestion can
    // exclude it, the same way a disabled truck is excluded, rather than
    // letting every busy city's arrival apron read as a traffic jam.
    const preArrivalSpeed = targetSpeed;
    targetSpeed = Math.min(targetSpeed, arrivalSpeedCap(graph, truck, targetSpeed));
    truck.arrivalBraking = targetSpeed < preArrivalSpeed;
    targetSpeed = Math.min(targetSpeed, applyFollowAndPassing(graph, truck, laneGroups, leaderMap, followerMap, targetSpeed, rnd));

    const rate = targetSpeed >= truck.speed ? truck.driver.accelRate : truck.driver.decelRate;
    truck.speed += (targetSpeed - truck.speed) * Math.min(1, dt * rate);
    truck.laneT += (truck.lane - truck.laneT) * Math.min(1, dt * LANE_CHANGE_EASE);
  }

  // Phase 2: integrate position from the speed each truck just settled on,
  // then burn fuel and roll for a breakdown.
  for (const truck of trucks) {
    if (truck.awaitingDecision || truck.awaitingContract || truck.pendingEdge || !truck.edge || truck.disabledHoursLeft > 0) continue;
    const miles = truck.speed * gameHours;
    truck.s += miles;
    truck.totalMilesDriven += miles;
    truck.dayMiles += miles;
    truck.milesSinceStop += miles;
    truck.milesSinceHome += miles; // Hometown Backhauler's homesickness curve (economy.js's chooseOffer)
    if (truck.onShoulder) {
      truck.shoulderMilesLeft -= miles;
      if (truck.shoulderMilesLeft <= 0) truck.onShoulder = false; // cleared the jam (or ran out the ride) - back to the normal travel lane next tick
    }
    truck.fatigue = Math.min(FATIGUE_MAX, truck.fatigue + gameHours * FATIGUE_PER_HOUR * (truck.agent?.fatigueMult ?? 1));
    truck.fuel = Math.max(0, truck.fuel - miles * burnPerMile(truck));

    // An arrival this tick is handled entirely by Phase 4 (refuel/rest at
    // the node, or a fresh breakdown-immunity there) - never disable a
    // truck exactly at or past its edge's end, which would create a slow
    // zone right at the node that nothing could ever clear.
    if (truck.s >= truck.edge.miles) continue;

    if (truck.fuel <= 0) {
      if (truck.agent) truck.agent.onDryTank(FUEL_TOW_COST);
      else {
        truck.earnings -= FUEL_TOW_COST;
        truck.dayFuelSpend += FUEL_TOW_COST; // roadside assistance is part of the day's fuel bill
      }
      truck.dayBreakdowns++;
      emitFleetEvent("DRY_TANK", truck);
      disableTruck(truck, "FUEL", FUEL_DISABLED_SERVICE_MIN_HOURS + rnd() * (FUEL_DISABLED_SERVICE_MAX_HOURS - FUEL_DISABLED_SERVICE_MIN_HOURS));
      continue;
    }

    // truck.fleetWearMult is a plain field career.js/main.js stamp directly
    // onto every company truck (including hired, agent-less ones) when the
    // player buys the Fleet Maintenance upgrade - unlike agent.wearMult,
    // which only ever reaches whichever truck currently holds .agent, this
    // is the one wear-reduction path that actually generalizes to a hired
    // truck's own ordinary AI-driven physics. Composes with agent.wearMult
    // rather than replacing it, so the player's own currently-driven rig
    // still gets both if both apply.
    const p = BREAKDOWN_PER_MILE * (1.6 - truck.driver.skill) * (1 + truck.milesSinceStop / BREAKDOWN_MILES_SINCE_STOP_SCALE) * miles * (truck.agent?.wearMult ?? 1) * (truck.fleetWearMult ?? 1);
    if (rnd() < p) {
      truck.dayBreakdowns++;
      emitFleetEvent("BREAKDOWN", truck);
      disableTruck(truck, "BREAKDOWN", BREAKDOWN_REPAIR_MIN_HOURS + rnd() * (BREAKDOWN_REPAIR_MAX_HOURS - BREAKDOWN_REPAIR_MIN_HOURS));
    }
  }

  // Phase 3: hard anti-overlap clamp on the post-move positions (see
  // clampOverlaps above for why this can't just be folded into phase 1).
  clampOverlaps(graph, laneGroups);

  // Phase 4: disabled trucks, layovers, rest/fuel stops, arrivals,
  // junction decisions, and departures, using the final (clamped)
  // positions.
  //
  // Only `controlledTruck` can ever need player input (awaitingDecision/
  // awaitingContract are set nowhere else), so at most one truck per tick
  // can produce a result here - but it must not `return` the INSTANT that
  // happens. `trucks` is a flat array with no ordering guarantee relative
  // to who's currently controlled, so an early return used to silently
  // skip Phase 4 - arrivals, departures, dwell decrement, everything -
  // for every truck later in the array that same tick, a real (if minor)
  // bias toward trucks earlier in spawn order. Collect the awaiting
  // result instead and let the loop finish so every truck gets its
  // Phase 4 turn every tick regardless of where the controlled truck
  // happens to sit in the array.
  let awaitingResult = null;
  for (const truck of trucks) {
    if (truck.awaitingDecision || truck.awaitingContract) continue;

    // Disabled on the shoulder (breakdown or ran dry mid-edge) - not
    // `parkedAt` (see the field comment on Truck), so it keeps its edge/.s
    // the whole time and resumes from exactly where it stopped.
    if (truck.disabledHoursLeft > 0) {
      truck.disabledHoursLeft -= gameHours;
      truck.downtimeHours += gameHours;
      if (truck.disabledHoursLeft > 0) continue;
      truck.disabledHoursLeft = 0;
      if (truck.disabledReason === "FUEL") applyRefuel(truck);
      truck.disabledReason = null;
      truck.milesSinceStop = 0;
      continue;
    }

    // Parked - between loads (LAYOVER), mid-route sleeping/refueling
    // (REST/FUEL), or a career player's own stop (PLAYER). Burn down the
    // dwell timer; layovers/rests also recover fatigue while parked, not
    // just on wake, so a truck woken early by a future feature wouldn't
    // read a stale high number.
    if (truck.parkedAt) {
      // PLAYER stops never auto-resolve - dwellHoursLeft simply never
      // counts down (there's deliberately no dwell to burn: the player,
      // or career.js's fastForwardHours during a sleep/wait action, ends
      // the stop explicitly). Fatigue still recovers and any in-progress
      // refuel still ticks in every Phase-4 pass either way, exactly like
      // any other parked truck - only the auto-resume/auto-contract tail
      // below is skipped.
      truck.fatigue = Math.max(0, truck.fatigue - gameHours * FATIGUE_RECOVERY_PER_HOUR * (truck.agent?.restMult ?? 1));
      tickRefuel(truck, gameHours);
      if (truck.stopReason === "PLAYER") continue;

      truck.dwellHoursLeft -= gameHours;
      if (truck.dwellHoursLeft > 0) continue;
      truck.dwellHoursLeft = 0;
      finishRefuel(truck);

      if (truck.stopReason !== "LAYOVER") {
        // REST or FUEL: resume the SAME contract's route rather than
        // taking a new load.
        if (truck.stopReason === "REST") truck.fatigue = 0; // exact reset - don't rely on the sleep window alone (see nodeStopReason), or a truck waking still inside its window re-sleeps immediately
        truck.stopReason = null;
        truck.parkedAt = null;
        truck.milesSinceStop = 0;
        const waiting = departFromNode(graph, truck, laneGroups, controlledTruck, truck.prevEdge, true);
        if (waiting) awaitingResult = waiting;
        continue;
      }

      // Only ever considered for an AI-driven pick (this branch is never
      // reached for a live player stop - see the PLAYER continue above),
      // so a company HQ or a fleet driver's own hometown can actually pull
      // a truck home even when a paying load was on offer.
      if (!(truck === controlledTruck && !truck.autoDriver) && shouldDeadheadHome(truck, rnd)) {
        const deadhead = generateDeadheadContract(graph, truck.parkedAt, truck.homeCity);
        if (deadhead) {
          truck._takeContract(graph, deadhead, laneGroups);
          continue;
        }
      }

      const offers = generateContractOffers(graph, truck.parkedAt, OFFER_COUNT, rnd);
      if (!offers.length) {
        // Nothing routable from here (shouldn't happen on this graph, but
        // don't wedge the truck forever if it ever does) - wait and retry.
        truck.dwellHoursLeft = 1;
        continue;
      }
      if (truck === controlledTruck && !truck.autoDriver) {
        truck.pendingOffers = offers;
        truck.awaitingContract = true;
        awaitingResult = truck;
        continue;
      }
      truck._takeContract(graph, chooseOffer(offers, truck, graph, rnd), laneGroups);
      continue;
    }

    if (truck.pendingEdge) {
      tryDepartTruck(graph, truck, laneGroups, dt);
      continue;
    }
    if (!truck.edge) continue; // truly stranded
    if (truck.s < truck.edge.miles) continue;

    const node = truck.edge.to;
    truck.currentNode = node;
    if (node === truck.contract.destination) {
      truck._arriveAtDestination(graph, rnd);
      continue;
    }

    truck.prevEdge = truck.edge;
    const stop = nodeStopReason(graph, truck, node, env);
    if (stop) {
      parkForStop(truck, node, stop, rnd);
      continue;
    }

    const waiting = departFromNode(graph, truck, laneGroups, controlledTruck, truck.prevEdge, false);
    if (waiting) awaitingResult = waiting;
  }
  return awaitingResult;
}
