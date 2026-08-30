import * as Cesium from 'cesium';

/**
 * Camera presets for notable locations.
 */
export const CAMERA_PRESETS = {
  rasuwagadhi: {
    destination: Cesium.Cartesian3.fromDegrees(85.3780, 28.2790, 6500),
    orientation: {
      heading: Cesium.Math.toRadians(195),
      pitch: Cesium.Math.toRadians(-32),
      roll: 0.0,
    },
  },
  austin: {
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 800),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0.0,
    },
  },
  sf: {
    destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 1000),
    orientation: {
      heading: Cesium.Math.toRadians(30),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
  nyc: {
    destination: Cesium.Cartesian3.fromDegrees(-73.9857, 40.7484, 1200),
    orientation: {
      heading: Cesium.Math.toRadians(-20),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
};

/**
 * Fly the camera to a preset location with a smooth animation.
 */
export function flyToPreset(viewer, presetName, duration = 3.0) {
  const preset = CAMERA_PRESETS[presetName];
  if (!preset) return;

  viewer.camera.flyTo({
    destination: preset.destination,
    orientation: preset.orientation,
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
}

/**
 * Where the app opens when no share link supplies a camera state.
 *
 * Heights are absolute (WGS84 ellipsoid), not above ground, so a Himalayan
 * valley floor at ~1,800 m has to be carried in the numbers: the arrival
 * height sits ~4.7 km over Rasuwagadhi, high enough to hold the Bhote
 * Koshi/Trishuli flood corridor in frame. The heading looks south, downstream
 * toward Timure and Syabrubesi.
 */
export const STARTUP_VIEW = Object.freeze({
  label: 'Rasuwagadhi, Nepal',
  lon: 85.3780,
  lat: 28.2790,
  approachHeightM: 45000,
  arrivalHeightM: 6500,
  headingDeg: 195,
  pitchDeg: -32,
  durationS: 4.0,
});

/**
 * Set the camera to the startup location on load with a cinematic fly-in.
 */
export function flyToStartupView(viewer) {
  // Start from a high altitude, then fly down
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(STARTUP_VIEW.lon, STARTUP_VIEW.lat, STARTUP_VIEW.approachHeightM),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });

  // Cinematic fly-in after a brief pause
  setTimeout(() => {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(STARTUP_VIEW.lon, STARTUP_VIEW.lat, STARTUP_VIEW.arrivalHeightM),
      orientation: {
        heading: Cesium.Math.toRadians(STARTUP_VIEW.headingDeg),
        pitch: Cesium.Math.toRadians(STARTUP_VIEW.pitchDeg),
        roll: 0.0,
      },
      duration: STARTUP_VIEW.durationS,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
}
