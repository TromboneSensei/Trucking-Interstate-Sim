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

        // isOutlaw: never stops for circadian rest, and the only driver
        // type that ever cheats a shoulder past a dead jam (Shoulder
        // Rider - see fleet.js's applyFollowAndPassing). Every other
        // "outlaw-flavored" trait below keys off this SAME test rather
        // than rolling its own independent chance - one concept of
        // "outlaw" in the sim, so the red badge the UI already shows is
        // what predicts all of this driver's rule-breaking at once, not
        // just the rest-skipping.
        this.isOutlaw = this.aggression > 0.7 && this.compliance < 0.3;

        // isSuperSpeeder: a strict subset of isOutlaw (0.8 > 0.7 can never
        // clear without also clearing isOutlaw's bar) - a Super-Speeder is
        // always an Outlaw, never merely "fast", matching how a driver
        // actually running 100+ MPH would have to behave.
        this.isSuperSpeeder = this.aggression > 0.8 && this.compliance < 0.3;

        // cruiseMult: how far above/below the posted speed limit this
        // driver tends to run. Power-Law Speed Skew: the bulk of the
        // fleet sits in a narrow, mostly-legal band; Super-Speeders
        // replace it entirely with a power-law roll instead -
        // Math.random()**4 spends most of its mass near 0 (a modest hot-
        // runner) but occasionally spikes near 1, producing the rare
        // driver actually attempting 100-115 MPH and weaving through
        // traffic to hold it.
        this.cruiseMult = 0.85 + this.aggression * 0.15 - (this.compliance > 0.8 ? 0.08 : 0);
        if (this.isSuperSpeeder) this.cruiseMult = 1.0 + Math.pow(rnd(), 4) * 0.70;

        // fuelBurnMult: skilled/smooth drivers sip less, aggressive ones
        // burn more. (Convoy Drafter, in fleet.js, further discounts this
        // while a draft is actually engaged.)
        this.fuelBurnMult = 1.18 - this.skill * 0.3 + this.aggression * 0.1;

        // accelRate/decelRate: how fast this driver's speed eases toward
        // a target (replaces a flat easing constant) - higher is
        // snappier. Braking is always faster than accelerating for
        // everyone, but aggressive drivers push both harder.
        this.accelRate = 2.2 + this.aggression * 1.6;
        this.decelRate = 2.8 + this.aggression * 2.4;

        // isNightOwl: prefers to sleep during the day rather than at night.
        this.isNightOwl = rnd() < 0.15;

        // isDrafter: a fuel-conscious, cooperative driver who tucks in
        // tight behind a same-lane leader instead of passing it (see
        // fleet.js's applyFollowAndPassing). Explicitly excludes Outlaws -
        // too impatient to sit behind anyone - and is weighted toward
        // calmer, higher-hustle drivers, since real fuel savings matter
        // more to someone actually chasing rate-per-mile.
        this.isDrafter = !this.isOutlaw && this.aggression < 0.55 && rnd() < (0.15 + this.hustle * 0.25);

        // isLaneCamper: a rule-following but low-skill driver who settles
        // into the passing lane and never checks the mirror. Deliberately
        // NOT keyed off high aggression (that's the Outlaw/Speeder axis
        // already) - this is obliviousness, not attitude, so it's gated
        // on high compliance and low skill instead. That keeps it
        // structurally unable to double up with isOutlaw: their
        // compliance gates sit on opposite sides of the 0.3/0.55 split.
        this.isLaneCamper = this.compliance > 0.55 && this.skill < 0.35 && this.aggression < 0.5;

        // homeAttachment: how strongly this driver's load choice pulls
        // back toward home (see economy.js's chooseOffer - Hometown
        // Backhauler). Compliant, less-aggressive drivers - the
        // WORKHORSE/VETERAN end of the archetype spread - are the ones
        // who actually plan backhauls; Outlaws are drifters by nature and
        // barely register the pull.
        this.homeAttachment = 0.35 + this.compliance * 0.35 + (1 - this.aggression) * 0.3;
    }

    getArchetype() {
        if (this.aggression > 0.7 && this.compliance < 0.3) return { label: "OUTLAW", color: "#e5484d", desc: "Fast and loose." };
        if (this.skill > 0.75 && this.compliance > 0.55 && this.aggression < 0.5) return { label: "VETERAN", color: "#4d9fff", desc: "Smooth and efficient." };
        if (this.hustle > 0.7 && this.aggression < 0.6) return { label: "WORKHORSE", color: "#35c96b", desc: "Always moving." };
        if (this.skill < 0.35) return { label: "ROOKIE", color: "#ffb020", desc: "Still learning the ropes." };
        return { label: "COMPANY DRIVER", color: "#9aa4b2", desc: "Standard operator." };
    }
}
