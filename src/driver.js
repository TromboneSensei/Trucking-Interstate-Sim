// driver.js - lightweight adaptation of the "Driver Dossier" concept for a
// single player-controlled rig: rng'd driver stats that flavor the economy
// (fuel burn, a little top-speed leeway) rather than driving an AI traffic sim.
"use strict";

class DriverDNA {
  constructor() {
    this.aggression = Math.random();
    this.hustle = Math.random();
    this.skill = Math.random();
    this.compliance = Math.random();
    this.isSpeedster = this.compliance < 0.12 && this.aggression > 0.55;

    // fuelBurnMult: 1.0 = MPG rating as printed on the truck; skilled/smooth
    // drivers sip less, aggressive/unskilled drivers burn more.
    this.fuelBurnMult = 1.22 - this.skill * 0.34 + this.aggression * 0.12;
    // small allowed cushion over the posted limit for bold drivers
    this.overSpeedAllowance = this.isSpeedster ? 9 + this.aggression * 6 : (this.compliance > 0.75 ? 0 : 3);
    // shaves a little off accel/brake responsiveness for low-skill drivers
    this.handling = 0.82 + this.skill * 0.28;
  }

  getArchetype() {
    if (this.isSpeedster) return { label: "OUTLAW", color: "#e5484d", desc: "Fast and loose. Burns fuel, beats the clock." };
    if (this.skill > 0.75 && this.compliance > 0.55 && this.aggression < 0.5) return { label: "VETERAN", color: "#4d9fff", desc: "Smooth and efficient. Sips fuel." };
    if (this.hustle > 0.7 && this.aggression < 0.6) return { label: "WORKHORSE", color: "#35c96b", desc: "Always moving, dependable." };
    if (this.skill < 0.35) return { label: "ROOKIE", color: "#ffb020", desc: "Still learning the ropes." };
    return { label: "COMPANY DRIVER", color: "#9aa4b2", desc: "Standard operator." };
  }
}
