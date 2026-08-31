// camera.js - flat top-down pan/zoom camera with a FREE (user-driven) mode,
// a FOLLOW mode that smoothly centers on a target (a truck), and a
// FOLLOW_NAV mode - a tilted, heading-aligned "chase cam" that rotates so
// the followed truck's current direction of travel always points toward
// the top of the screen, turn-by-turn-nav-app style.
"use strict";

const TAP_MOVE_THRESHOLD = 8; // px
const TAP_MAX_DURATION = 300; // ms
const FOLLOW_LERP = 0.08;
const FOLLOW_ZOOM = 2.4;
const HEADING_LERP = 0.08; // matches FOLLOW_LERP - no reason to diverge initially
export const TILT_FACTOR = 0.62; // Y-axis compression in FOLLOW_NAV, faking a tilted viewing angle - exported: render.js's drawFrame needs the exact value

// Plain linear easing breaks at the 0/2*PI wrap (e.g. easing from 350deg
// to 10deg must go forward through 360deg, not backward through 180deg) -
// this always returns the shorter signed delta regardless of how far
// `from` has drifted outside [0, 2*PI) (it never needs renormalizing;
// sin/cos are happy with an unbounded angle and this is recomputed fresh
// every tick anyway).
function shortestAngleDelta(from, to) {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export class Camera {
  constructor(canvas, { x = 0, y = 0, zoom = 0.3, minZoom = 0.05, maxZoom = 6, onTap = null } = {}) {
    this.canvas = canvas;
    this.x = x;
    this.y = y;
    this.zoom = zoom;
    this.baseZoom = zoom; // the initial fit-to-screen zoom; render.js keys city-label tiers off this
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
    this.mode = "FREE"; // "FREE" | "FOLLOW" | "FOLLOW_NAV"
    this.followTarget = null;
    this.onTap = onTap;
    this.visualCenterYRatio = 0.42; // bias the focal point up so the bottom sheet doesn't cover it
    // FOLLOW_NAV pushes the pivot further down than flat FOLLOW's 0.42 -
    // the truck sits lower on screen, leaving more room above it for the
    // road ahead (which always renders toward the top once rotated).
    // Capped well under ~0.55: the bottom sheet covers roughly the
    // bottom 45% of the viewport (see main.js's fitZoom, which reserves
    // the same 55% for the map), so a ratio much past that hides the
    // truck's own dot underneath the sheet - confirmed by an actual
    // rendered screenshot during implementation, not just arithmetic.
    this.visualCenterYRatioNav = 0.48;

    // FOLLOW_NAV-only state: `heading` is the currently-rendered camera
    // rotation (radians, same compass convention as edge.bearing - 0deg
    // north, clockwise), eased each update() toward `targetHeading` (set
    // by main.js from the followed truck's current edge bearing).
    // Meaningless/unused outside FOLLOW_NAV.
    this.heading = 0;
    this.targetHeading = 0;

    this._bindInput();
  }

  visualCenter() {
    const ratio = this.mode === "FOLLOW_NAV" ? this.visualCenterYRatioNav : this.visualCenterYRatio;
    return { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight * ratio };
  }

  screenToWorld(sx, sy) {
    const c = this.visualCenter();
    return { x: (sx - c.x) / this.zoom + this.x, y: (sy - c.y) / this.zoom + this.y };
  }

  worldToScreen(wx, wy) {
    const c = this.visualCenter();
    return { x: c.x + (wx - this.x) * this.zoom, y: c.y + (wy - this.y) * this.zoom };
  }

  follow(target) {
    this.mode = "FOLLOW";
    this.followTarget = target;
  }

  unfollow() {
    this.mode = "FREE";
    this.followTarget = null;
  }

  clampZoom(z) {
    return Math.max(this.minZoom, Math.min(this.maxZoom, z));
  }

  update() {
    if ((this.mode === "FOLLOW" || this.mode === "FOLLOW_NAV") && this.followTarget) {
      this.x += (this.followTarget.x - this.x) * FOLLOW_LERP;
      this.y += (this.followTarget.y - this.y) * FOLLOW_LERP;
      this.zoom += (FOLLOW_ZOOM - this.zoom) * FOLLOW_LERP;
    }
    if (this.mode === "FOLLOW_NAV") {
      this.heading += shortestAngleDelta(this.heading, this.targetHeading) * HEADING_LERP;
    }
  }

  _bindInput() {
    const canvas = this.canvas;
    let dragging = false, moved = false, tapStart = 0;
    let lastX = 0, lastY = 0;
    let pinchDist = 0;

    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const center = (touches) => {
      let x = 0, y = 0;
      for (const t of touches) { x += t.clientX; y += t.clientY; }
      return { x: x / touches.length, y: y / touches.length };
    };

    const startDrag = (sx, sy) => {
      dragging = true; moved = false; tapStart = Date.now();
      lastX = sx; lastY = sy;
      if (this.mode === "FOLLOW" || this.mode === "FOLLOW_NAV") this.unfollow();
    };
    const doDrag = (sx, sy) => {
      const dx = sx - lastX, dy = sy - lastY;
      if (Math.abs(dx) > TAP_MOVE_THRESHOLD || Math.abs(dy) > TAP_MOVE_THRESHOLD) moved = true;
      this.x -= dx / this.zoom;
      this.y -= dy / this.zoom;
      lastX = sx; lastY = sy;
    };
    const endDrag = (sx, sy) => {
      dragging = false;
      if (!moved && !gestureMultiTouch && Date.now() - tapStart < TAP_MAX_DURATION && this.onTap) {
        const w = this.screenToWorld(sx, sy);
        this.onTap(w.x, w.y);
      }
    };
    const zoomAt = (sx, sy, factor) => {
      const before = this.screenToWorld(sx, sy);
      this.zoom = this.clampZoom(this.zoom * factor);
      const after = this.screenToWorld(sx, sy);
      this.x += before.x - after.x;
      this.y += before.y - after.y;
    };

    canvas.addEventListener("mousedown", (e) => startDrag(e.clientX, e.clientY));
    canvas.addEventListener("mousemove", (e) => { if (dragging) doDrag(e.clientX, e.clientY); });
    window.addEventListener("mouseup", (e) => { if (dragging) endDrag(e.clientX, e.clientY); });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.pow(1.0015, -e.deltaY));
    }, { passive: false });

    // Any change in the number of fingers down re-bases whichever
    // gesture reference is now active (drag origin or pinch distance)
    // from the CURRENT touch positions, instead of carrying over a
    // stale value from the previous finger count. Without this, letting
    // go of a pinch (2 fingers -> 1 before the final lift) reused the
    // single-finger drag origin from before the pinch even started,
    // producing a sudden camera jump right as the gesture released.
    //
    // gestureMultiTouch tracks whether *this entire gesture* ever saw a
    // second finger, from first touch down to all fingers lifted. A
    // pinch that drops to one finger still counts: rebase()'s 1-finger
    // branch calls startDrag(), which resets `moved` to false, so
    // without re-asserting it here a quick final release would read as
    // a plain tap and select whatever was under that last finger, even
    // though the whole gesture was a pinch-zoom, not a tap.
    let touchCount = 0;
    let gestureMultiTouch = false;
    const rebase = (touches) => {
      if (touches.length >= 2) {
        dragging = false;
        gestureMultiTouch = true;
        pinchDist = dist(touches[0], touches[1]);
        moved = true;
      } else if (touches.length === 1) {
        pinchDist = 0;
        const c = center(touches);
        if (!dragging || touchCount >= 2) {
          startDrag(c.x, c.y);
          if (gestureMultiTouch) moved = true;
        } else {
          lastX = c.x; lastY = c.y;
        }
      } else {
        pinchDist = 0;
      }
      touchCount = touches.length;
    };

    canvas.addEventListener("touchstart", (e) => rebase(e.touches), { passive: true });
    canvas.addEventListener("touchmove", (e) => {
      e.preventDefault();
      if (e.touches.length >= 2) {
        const d = dist(e.touches[0], e.touches[1]);
        const c = center(e.touches);
        if (pinchDist > 0) zoomAt(c.x, c.y, d / pinchDist);
        pinchDist = d;
      } else if (e.touches.length === 1 && dragging) {
        const c = center(e.touches);
        doDrag(c.x, c.y);
      }
    }, { passive: false });
    canvas.addEventListener("touchend", (e) => {
      if (e.touches.length === 0) {
        pinchDist = 0;
        touchCount = 0;
        const t = e.changedTouches[0];
        if (t) endDrag(t.clientX, t.clientY);
        else dragging = false;
        gestureMultiTouch = false; // gesture fully over; next touch starts fresh
      } else {
        rebase(e.touches);
      }
    });
  }
}
