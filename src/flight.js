// flight.js - smooth zoom-pan camera interpolation (van Wijk & Nuij, "Smooth
// and efficient zooming and panning", the same math behind d3's
// interpolateZoom and the Google Maps fly-to). Pure math, no imports, no
// canvas/camera/graph knowledge - deliberately standalone so it's testable
// in plain node (see scripts/test-flight.mjs) and reusable by anything that
// wants a single continuous camera move between two {x, y, w} views.
//
// `w` is always viewport width in WORLD units (canvas.clientWidth /
// camera.zoom), never a screen pixel count and never a zoom level directly -
// callers convert both ways at the boundary (zoom = clientWidth / w).
"use strict";

const FLIGHT_RHO = Math.SQRT2;

// Per-leg flight duration: proportional to how much ground/zoom the path
// actually covers (`S`, flightPath's own arc-length-like measure - can be
// negative for a pure zoom-in, hence the abs), clamped to a sane range so a
// one-block hop isn't instant and a cross-country hop isn't glacial.
export const FLIGHT_MS_PER_S = 800;
export const FLIGHT_MIN_MS = 1100;
export const FLIGHT_MAX_MS = 2600;

export function flightDurationMs(S) {
  return Math.max(FLIGHT_MIN_MS, Math.min(FLIGHT_MAX_MS, Math.abs(S) * FLIGHT_MS_PER_S));
}

// Standard cubic ease - symmetric acceleration/deceleration, matching every
// other hand-rolled easing already in this codebase (render.js's various
// lerps) rather than introducing a different curve shape just for flights.
export function flightEase(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Builds one continuous path between two {x, y, w} views. Returns
// { at(t), S } where at(t) for t in [0,1] gives the intermediate
// {x, y, w}, and S is a signed measure of the path's total "distance"
// (in the same log-zoom-weighted sense the duration mapping above uses) -
// negative when the path is a net zoom-IN with no panning.
export function flightPath(p0, p1) {
  const { x: x0, y: y0, w: w0 } = p0;
  const { x: x1, y: y1, w: w1 } = p1;
  const dx = x1 - x0, dy = y1 - y0, d2 = dx * dx + dy * dy;
  const rho = FLIGHT_RHO, rho2 = rho * rho, rho4 = rho2 * rho2;

  // Same point (or near enough that panning is meaningless): a pure zoom,
  // handled separately since the general formula below divides by the
  // pan distance and blows up as it approaches zero.
  if (d2 < 1e-12) {
    const S = Math.log(w1 / w0) / rho;
    return {
      S,
      at: (t) => ({ x: x0 + t * dx, y: y0 + t * dy, w: w0 * Math.exp(rho * t * S) }),
    };
  }

  const d1 = Math.sqrt(d2);
  const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
  const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
  // -asinh(b) == ln(sqrt(b*b+1) - b), but asinh is numerically stable near
  // b=0 where the direct log form loses precision through cancellation.
  const r0 = -Math.asinh(b0);
  const r1 = -Math.asinh(b1);
  const S = (r1 - r0) / rho;

  return {
    S,
    at: (t) => {
      const s = t * S;
      const coshR0 = Math.cosh(r0);
      const u = (w0 / (rho2 * d1)) * (coshR0 * Math.tanh(rho * s + r0) - Math.sinh(r0));
      return {
        x: x0 + u * dx,
        y: y0 + u * dy,
        w: (w0 * coshR0) / Math.cosh(rho * s + r0),
      };
    },
  };
}
