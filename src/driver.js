// driver.js - lightweight per-truck personality flavor. No reaction-time
// or merge-confidence fields here - just a few stats that read well in
// the fleet dashboard and give trucks some character (a "fastest truck"
// or "top earner" leaderboard is more fun when the leader has a name and
// a vibe), plus the accel/decel rates fleet.js's car-following/passing
// logic uses to make aggressive drivers visibly surge and brake harder.
"use strict";

export class DriverDNA {
    constructor(rnd = Math.random) {
        this.aggression = rnd();
        this.hustle = rnd();
        this.skill = rnd();
        this.compliance = rnd();

        // cruiseMult: how far above/below the posted speed limit this
        // driver tends to run — aggressive+skilled drivers push it,
        // highly compliant drivers sit at or under it.
        this.cruiseMult = 0.92 + this.aggression * 0.28 - (this.compliance > 0.8 ? 0.08 : 0);
        // fuelBurnMult: skilled/smooth drivers sip less, aggressive ones burn more.
        this.fuelBurnMult = 1.18 - this.skill * 0.3 + this.aggression * 0.1;

        // accelRate/decelRate: how fast this driver's speed eases toward
        // a target (replaces a flat easing constant) - higher is
        // snappier. Braking is always faster than accelerating for
        // everyone, but aggressive drivers push both harder.
        this.accelRate = 2.2 + this.aggression * 1.6;
        this.decelRate = 2.8 + this.aggression * 2.4;

        // fastCard: holds a NEXUS/FAST trusted-traveler card, cutting
        // border-crossing customs time (see fleet.js's customs FSM).
        // Skewed toward skilled drivers (frequent, careful cross-border
        // hauls are what earns one), not a flat coin flip.
        this.fastCard = rnd() < 0.15 + this.skill * 0.2;
    }

    getArchetype() {
        if (this.aggression > 0.7 && this.compliance < 0.3) return { label: "OUTLAW", color: "#e5484d", desc: "Fast and loose." };
        if (this.skill > 0.75 && this.compliance > 0.55 && this.aggression < 0.5) return { label: "VETERAN", color: "#4d9fff", desc: "Smooth and efficient." };
        if (this.hustle > 0.7 && this.aggression < 0.6) return { label: "WORKHORSE", color: "#35c96b", desc: "Always moving." };
        if (this.skill < 0.35) return { label: "ROOKIE", color: "#ffb020", desc: "Still learning the ropes." };
        return { label: "COMPANY DRIVER", color: "#9aa4b2", desc: "Standard operator." };
    }
}
