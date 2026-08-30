/**
 * Third-person robot chase camera — the single camera owner while engaged.
 *
 * Follows a layer-supplied target getter from a `scene.preUpdate` listener
 * (never `preRender`: the camera must be posed before the scene updates), with
 * bounded anchor correction, heading slew, and terrain-safe height. Holds the
 * render governor (`robot-chase`) for exactly the lifetime of the loop and
 * releases it on every exit path.
 *
 * Ownership contract: `ui.js::_releaseFollowCamera()` tears this down through
 * the owning layer's `releaseCameraOwnership()`, alongside the other camera
 * owners. Data layers never move the camera themselves.
 *
 * @module robotChaseCamera
 */

import * as Cesium from 'cesium';
import { holdContinuousRender, releaseContinuousRender } from './renderGovernor.js';
import { slewHeading, cockpitGroundSafeHeight } from './cockpitMath.js';

export const ROBOT_CHASE_DEFAULTS = Object.freeze({
  rangeM: 6,
  minRangeM: 2,
  maxRangeM: 40,
  pitchDeg: -15,
  // Anchor height above the robot's feet. lookAt() centers the anchor on
  // screen, so the robot renders ~this far below center: keep it low enough
  // that the billboard stays clear of the bottom-center dock UI.
  eyeHeightM: 1.0,
  yawSlewDps: 60,
  groundClearanceM: 1.2,
});

/** First-person: the camera rides at the G1's head-camera height. */
export const ROBOT_FIRST_PERSON_DEFAULTS = Object.freeze({
  eyeHeightM: 1.25,
  pitchDeg: -5,
  groundClearanceM: 0.4,
});

/** Clamp a user range request to the chase envelope. */
export function clampChaseRangeM(rangeM, defaults = ROBOT_CHASE_DEFAULTS) {
  if (!Number.isFinite(rangeM)) return defaults.rangeM;
  return Math.min(defaults.maxRangeM, Math.max(defaults.minRangeM, rangeM));
}

/**
 * Create a chase camera bound to one viewer.
 *
 * @param {Cesium.Viewer} viewer
 * @returns {{start: Function, stop: Function, isActive: () => boolean,
 *   setRange: (rangeM: number) => void}}
 */
export function createRobotChaseCamera(viewer) {
  let remover = null;
  let heading = 0;
  let rangeM = ROBOT_CHASE_DEFAULTS.rangeM;
  let savedInputs = true;
  let lastTickMs = 0;
  const scratchCarto = new Cesium.Cartographic();

  /**
   * Engage the chase loop.
   * @param {() => ({position: Cesium.Cartesian3, headingDeg?: number,
   *   groundHeightM?: number|null, liftM?: number,
   *   poseIsCameraHeight?: boolean}|null)} getTargetFn - Layer-owned target
   *   getter; returning null skips the frame (bounded coasting upstream).
   *   `poseIsCameraHeight` marks targets whose position already sits at the
   *   recorded camera height (bar the render lift `liftM`), so first-person
   *   adds no eye height.
   * @param {{rangeM?: number, pitchDeg?: number, firstPerson?: boolean}} [options]
   *   `firstPerson` poses the camera AT the target (head-camera height,
   *   facing the target's heading) instead of behind it.
   */
  function start(getTargetFn, options = {}) {
    stop();
    const firstPerson = options.firstPerson === true;
    rangeM = clampChaseRangeM(options.rangeM);
    const modeDefaults = firstPerson ? ROBOT_FIRST_PERSON_DEFAULTS : ROBOT_CHASE_DEFAULTS;
    const pitchDeg = Number.isFinite(options.pitchDeg)
      ? options.pitchDeg : modeDefaults.pitchDeg;
    savedInputs = viewer.scene.screenSpaceCameraController.enableInputs;
    viewer.scene.screenSpaceCameraController.enableInputs = false;
    lastTickMs = 0;
    holdContinuousRender('robot-chase');
    remover = viewer.scene.preUpdate.addEventListener(() => {
      const target = getTargetFn();
      if (!target || !target.position) return;
      const nowMs = Date.now();
      const dtSec = lastTickMs ? Math.min(0.25, (nowMs - lastTickMs) / 1000) : 0.016;
      lastTickMs = nowMs;

      const desiredHeading = Number.isFinite(target.headingDeg) ? target.headingDeg : heading;
      heading = slewHeading(heading, desiredHeading, ROBOT_CHASE_DEFAULTS.yawSlewDps * dtSec);

      // Anchor slightly above the robot's feet so the frame reads eye-level.
      Cesium.Cartographic.fromCartesian(target.position, Cesium.Ellipsoid.WGS84, scratchCarto);
      const groundH = Number.isFinite(target.groundHeightM) ? target.groundHeightM : null;
      const eyeOffsetM = firstPerson && target.poseIsCameraHeight === true
        ? -(Number.isFinite(target.liftM) ? target.liftM : 0)
        : modeDefaults.eyeHeightM;
      const proposed = scratchCarto.height + eyeOffsetM;
      const safeH = groundH != null
        ? cockpitGroundSafeHeight(proposed, groundH, modeDefaults.groundClearanceM)
        : proposed;
      const anchor = Cesium.Cartesian3.fromRadians(
        scratchCarto.longitude, scratchCarto.latitude, safeH,
      );

      if (firstPerson) {
        viewer.camera.setView({
          destination: anchor,
          orientation: {
            heading: Cesium.Math.toRadians(heading),
            pitch: Cesium.Math.toRadians(pitchDeg),
            roll: 0,
          },
        });
        return;
      }
      viewer.camera.lookAt(
        anchor,
        new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(heading),
          Cesium.Math.toRadians(pitchDeg),
          rangeM,
        ),
      );
    });
  }

  /** Disengage: remove the listener, release the governor, free the camera. */
  function stop() {
    if (!remover) return;
    remover();
    remover = null;
    releaseContinuousRender('robot-chase');
    viewer.scene.screenSpaceCameraController.enableInputs = savedInputs;
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }

  return {
    start,
    stop,
    isActive: () => remover !== null,
    setRange: (value) => { rangeM = clampChaseRangeM(value); },
  };
}
