import * as Cesium from 'cesium';
import { deriveWeatherEffectProfile, weatherAltitudeFactors } from './weatherEffectsMath.js';
import {
  cockpitAerialPerspective,
  cockpitSunDirection,
  cockpitSunIrradiance,
  solarPositionDeg,
} from './cockpitAtmosphere.js';

const WEATHER_REFRESH_MS = 5 * 60_000;
const CLOUD_FRAME_MS = 1000 / 12;
const MAX_RENDER_WIDTH = 520;
const MAX_RENDER_HEIGHT = 320;
const WEATHER_MOVE_REFRESH_M = 25_000;
const WEATHER_ENABLED_STORAGE_KEY = 'godsEyeView.cockpitWeatherEffects.enabled';

const VERTEX_SHADER = `
  attribute vec2 position;

  void main() {
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

// Adapted from the supplied R&D cloudscape, with scattering terms ported from
// three-geospatial's `@takram/three-clouds` and `@takram/three-atmosphere`:
// a dual-lobe Henyey-Greenstein phase function, Kulla/Wrenninge multiple-
// scattering octaves, a powder term, and distance-based aerial perspective.
// This pass outputs transparent clouds only so Cesium remains the sky/terrain
// renderer. Four FBM octaves, 24 primary steps, and a 3-tap light march keep
// the presentation bounded on integrated GPUs.
const FRAGMENT_SHADER = `
  precision highp float;

  #define RECIPROCAL_PI4 0.07957747154594767
  #define MULTI_SCATTERING_OCTAVES 3

  uniform vec2 uResolution;
  uniform vec2 uWind;
  uniform vec2 uAerial;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform float uTime;
  uniform float uStrength;

  float hash(vec3 p) {
    p = fract(p * vec3(443.8975, 397.2973, 491.1871));
    p += dot(p, p.yxz + 19.19);
    return fract((p.x + p.y) * p.z);
  }

  float noise(vec3 x) {
    vec3 p = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(
        mix(hash(p), hash(p + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash(p + vec3(0.0, 1.0, 0.0)), hash(p + vec3(1.0, 1.0, 0.0)), f.x),
        f.y
      ),
      mix(
        mix(hash(p + vec3(0.0, 0.0, 1.0)), hash(p + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash(p + vec3(0.0, 1.0, 1.0)), hash(p + vec3(1.0, 1.0, 1.0)), f.x),
        f.y
      ),
      f.z
    );
  }

  // Four octaves with a per-octave offset so lattice features do not stack.
  // The sum is renormalized to the three-octave weight total the density
  // thresholds were tuned against, so the extra detail costs no coverage.
  float fbm(vec3 p) {
    float value = 0.0;
    float weight = 0.54;
    float total = 0.0;
    for (int octave = 0; octave < 4; octave++) {
      value += weight * noise(p);
      total += weight;
      p = p * 2.03 + vec3(11.7, 3.1, 7.3);
      weight *= 0.48;
    }
    return value * (0.9227 / total);
  }

  // Dual-lobe Henyey-Greenstein: a forward lobe for the silver lining plus a
  // wide back lobe for ambient bulk. The attenuation argument flattens the
  // lobes for the higher multiple-scattering octaves.
  vec2 henyeyGreenstein(vec2 g, float cosTheta) {
    vec2 g2 = g * g;
    return RECIPROCAL_PI4
      * ((1.0 - g2) / max(vec2(1e-7), pow(1.0 + g2 - 2.0 * g * cosTheta, vec2(1.5))));
  }

  float phaseFunction(float cosTheta, float attenuation) {
    const vec2 g = vec2(0.78, -0.28);
    const vec2 lobeWeights = vec2(0.7, 0.3);
    return dot(henyeyGreenstein(g * attenuation, cosTheta), lobeWeights);
  }

  float cloudDensity(vec3 p) {
    vec3 drift = vec3(uWind.x, 0.0, uWind.y) * uTime;
    float warp = fbm((p + drift * 0.42) * 0.42);
    vec3 warped = p + drift + vec3(warp * 1.25, 0.0, warp * 0.82);
    float field = fbm(warped * 0.5);
    float lower = smoothstep(0.45, 1.25, p.y);
    float upper = 1.0 - smoothstep(3.8, 5.1, p.y);
    float threshold = mix(0.71, 0.52, uStrength);
    return smoothstep(threshold, 0.86, field) * lower * upper;
  }

  // Optical depth toward the sun over three steps of growing length: cheap
  // enough for the overlay, long enough to darken cloud interiors.
  float lightOpticalDepth(vec3 point, vec3 sunDirection, float jitter) {
    float stepSize = 0.16;
    float distanceAlongRay = stepSize * jitter;
    float opticalDepth = 0.0;
    for (int i = 0; i < 3; i++) {
      opticalDepth += cloudDensity(point + sunDirection * distanceAlongRay) * stepSize;
      distanceAlongRay += stepSize;
      stepSize *= 1.8;
    }
    return opticalDepth * 12.0;
  }

  // Kulla's multiple-scattering octaves: each octave halves attenuation,
  // contribution, and phase sharpness, which is what keeps thick clouds from
  // going flat black.
  float multipleScattering(float opticalDepth, float cosTheta) {
    vec3 coeffs = vec3(1.0);
    float scattering = 0.0;
    for (int octave = 0; octave < MULTI_SCATTERING_OCTAVES; octave++) {
      scattering += coeffs.x * exp(-opticalDepth * coeffs.y) * phaseFunction(cosTheta, coeffs.z);
      coeffs *= 0.5;
    }
    return scattering;
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution.xy) / uResolution.y;
    vec3 rayOrigin = vec3(0.0, 0.72, uTime * 0.035);
    vec3 rayDirection = normalize(vec3(uv.x, uv.y * 0.92 + 0.18, 1.28));
    vec3 sunDirection = normalize(uSunDirection);
    float cosTheta = dot(rayDirection, sunDirection);
    float jitter = hash(rayDirection + uTime);
    vec3 color = vec3(0.0);
    float alpha = 0.0;
    float distanceAlongRay = 0.15 + 0.06 * jitter;
    float extinctionScale = uAerial.y;
    float inscatterPerUnit = uAerial.x;

    for (int stepIndex = 0; stepIndex < 24; stepIndex++) {
      vec3 point = rayOrigin + rayDirection * distanceAlongRay;
      float density = cloudDensity(point);
      if (density > 0.012) {
        float opticalDepth = lightOpticalDepth(point, sunDirection, jitter) * extinctionScale;
        // Powder: forward-scattering darkening at illuminated cloud edges.
        float powder = 1.0 - 0.72 * exp(-density * 14.0);
        vec3 radiance = uSunColor * multipleScattering(opticalDepth, cosTheta) * powder
          + uSkyColor * (0.09 + 0.16 * exp(-opticalDepth));
        // Aerial perspective: the air column between camera and sample adds
        // sky inscatter and washes the cloud out with distance.
        float aerial = 1.0 - exp(-distanceAlongRay * inscatterPerUnit);
        radiance = mix(radiance, uSkyColor, aerial);
        float sampleAlpha = (1.0 - alpha) * density * (0.16 + uStrength * 0.13);
        color += radiance * sampleAlpha;
        alpha += sampleAlpha;
      }
      if (alpha > 0.92) break;
      distanceAlongRay += 0.29;
    }

    float visorFade = smoothstep(-0.82, -0.28, uv.y);
    alpha *= visorFade * uStrength * 0.78;
    color = alpha > 0.001 ? color / max(alpha, 0.001) : vec3(0.0);
    // Tonemap the scattered radiance: the phase function is not energy-bounded.
    color = color / (color + 0.72);
    gl_FragColor = vec4(clamp(color, 0.0, 1.0), clamp(alpha, 0.0, 0.82));
  }
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  const error = gl.getShaderInfoLog(shader) || 'Unknown shader compilation error';
  gl.deleteShader(shader);
  throw new Error(error);
}

function greatCircleM(a, b) {
  if (![a?.latitude, a?.longitude, b?.latitude, b?.longitude].every(Number.isFinite)) return Infinity;
  const latitudeA = Cesium.Math.toRadians(a.latitude);
  const latitudeB = Cesium.Math.toRadians(b.latitude);
  const latitudeDelta = Cesium.Math.toRadians(b.latitude - a.latitude);
  const longitudeDelta = Cesium.Math.toRadians(b.longitude - a.longitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

/** Return whether cockpit weather must refresh for elapsed time or movement. */
export function cockpitWeatherRefreshDue({ nowMs, fetchedAt, anchor, point, hasWeather }) {
  if (!hasWeather) return true;
  if (!Number.isFinite(nowMs) || !Number.isFinite(fetchedAt)) return true;
  return nowMs - fetchedAt >= WEATHER_REFRESH_MS
    || greatCircleM(anchor, point) >= WEATHER_MOVE_REFRESH_M;
}

/** Returns the capped framebuffer size used by the cockpit cloud pass. */
export function cockpitCloudRenderSize(width, height) {
  const viewportWidth = Math.max(1, Number(width) || 1);
  const viewportHeight = Math.max(1, Number(height) || 1);
  const scale = Math.min(
    0.42,
    MAX_RENDER_WIDTH / viewportWidth,
    MAX_RENDER_HEIGHT / viewportHeight,
  );
  return {
    width: Math.max(1, Math.round(viewportWidth * scale)),
    height: Math.max(1, Math.round(viewportHeight * scale)),
  };
}

/** Resolve the persisted cockpit-weather preference; missing values default off. */
export function cockpitWeatherEnabledFromStoredValue(value) {
  return value === '1';
}

/**
 * Weather-backed volumetric cloud pass that exists only while cockpit mode is
 * active. It owns no Cesium fog/post-process stages and cannot affect map mode.
 */
export class CockpitCloudEffectsController {
  constructor(viewer) {
    this.viewer = viewer;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'cockpit-cloud-effects';
    this.canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.canvas);

    this.gl = null;
    this.program = null;
    this.locations = null;
    this.frame = null;
    this.refreshTimer = null;
    this.startupTimer = null;
    this.lastFrameMs = 0;
    this.lastRefreshCheckMs = 0;
    this.fetchedAt = 0;
    this.anchor = null;
    this.weather = null;
    this.strength = 0;
    this.targetStrength = 0;
    this.windDirectionDeg = 0;
    this.windStrength = 0;
    this.pending = null;
    this.abort = null;
    this.destroyed = false;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.enabled = this.readEnabledPreference();

    this.onResize = () => this.resize();
    this.onCockpitMode = (event) => {
      const active = event?.detail?.active ?? document.body.classList.contains('cockpit-mode');
      if (active && this.enabled) this.start();
      else this.stop();
    };
    this.onEnabledChange = (event) => {
      const requested = event?.detail?.enabled;
      this.setEnabled(typeof requested === 'boolean' ? requested : !this.enabled);
    };
    window.addEventListener('resize', this.onResize);
    window.addEventListener('gev:cockpit-mode-changed', this.onCockpitMode);
    window.addEventListener('gev:cockpit-weather-toggle', this.onEnabledChange);
    this.emitEnabledState();
  }

  readEnabledPreference() {
    try {
      return cockpitWeatherEnabledFromStoredValue(
        localStorage.getItem(WEATHER_ENABLED_STORAGE_KEY),
      );
    } catch {
      return false;
    }
  }

  emitEnabledState() {
    window.dispatchEvent(new CustomEvent('gev:cockpit-weather-state', {
      detail: { enabled: this.enabled },
    }));
  }

  setEnabled(enabled) {
    const next = !!enabled;
    this.enabled = next;
    try {
      localStorage.setItem(WEATHER_ENABLED_STORAGE_KEY, next ? '1' : '0');
    } catch { /* best effort */ }
    if (!next) {
      this.stop();
    } else if (document.body.classList.contains('cockpit-mode')) {
      this.start();
    }
    this.emitEnabledState();
  }

  initializeRenderer() {
    try {
      const gl = this.canvas.getContext('webgl', {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'low-power',
      });
      if (!gl) throw new Error('WebGL unavailable');

      const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      const program = gl.createProgram();
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || 'Cloud shader link failed');
      }

      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 1, -1, -1, 1,
        -1, 1, 1, -1, 1, 1,
      ]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'position');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

      this.gl = gl;
      this.program = program;
      this.locations = {
        resolution: gl.getUniformLocation(program, 'uResolution'),
        time: gl.getUniformLocation(program, 'uTime'),
        strength: gl.getUniformLocation(program, 'uStrength'),
        wind: gl.getUniformLocation(program, 'uWind'),
        aerial: gl.getUniformLocation(program, 'uAerial'),
        sunDirection: gl.getUniformLocation(program, 'uSunDirection'),
        sunColor: gl.getUniformLocation(program, 'uSunColor'),
        skyColor: gl.getUniformLocation(program, 'uSkyColor'),
      };
    } catch (error) {
      console.warn('[Cockpit clouds] Renderer unavailable:', error);
      this.canvas.dataset.status = 'unavailable';
    }
  }

  resize() {
    if (!this.gl) return;
    const size = cockpitCloudRenderSize(window.innerWidth, window.innerHeight);
    if (this.canvas.width === size.width && this.canvas.height === size.height) return;
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    this.gl.viewport(0, 0, size.width, size.height);
  }

  cameraPoint() {
    const cartographic = this.viewer?.camera?.positionCartographic;
    if (!cartographic) return null;
    const latitude = Cesium.Math.toDegrees(cartographic.latitude);
    const longitude = Cesium.Math.toDegrees(cartographic.longitude);
    if (![latitude, longitude].every(Number.isFinite)) return null;
    return {
      latitude,
      longitude,
      altitudeM: Math.max(0, Number(cartographic.height) || 0),
    };
  }

  start() {
    if (this.destroyed || !this.enabled || this.frame !== null || this.suspended) return;
    if (!this.gl) {
      this.initializeRenderer();
      this.resize();
    }
    if (!this.gl) return;
    this.canvas.dataset.cockpit = 'true';
    this.lastFrameMs = 0;
    this.frame = requestAnimationFrame((time) => this.tick(time));
    if (this.startupTimer !== null) window.clearTimeout(this.startupTimer);
    this.startupTimer = window.setTimeout(() => {
      this.startupTimer = null;
      if (document.body.classList.contains('cockpit-mode')) void this.refresh();
    }, 450);
  }

  stop() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (this.startupTimer !== null) window.clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.abort?.abort();
    this.abort = null;
    this.pending = null;
    this.strength = 0;
    this.targetStrength = 0;
    this.canvas.classList.remove('active');
    this.canvas.dataset.cockpit = 'false';
    this.clear();
  }

  clear() {
    if (!this.gl) return;
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  async refresh() {
    if (this.destroyed || !this.enabled || this.pending || this.suspended
      || !document.body.classList.contains('cockpit-mode')) {
      return this.pending;
    }
    const point = this.cameraPoint();
    if (!point) return null;
    if (
      this.weather
      && Date.now() - this.fetchedAt < WEATHER_REFRESH_MS
      && greatCircleM(this.anchor, point) < WEATHER_MOVE_REFRESH_M
    ) {
      this.applyWeather(this.weather, point.altitudeM);
      return this.weather;
    }

    this.abort?.abort();
    this.abort = new AbortController();
    const params = new URLSearchParams({
      latitude: point.latitude.toFixed(5),
      longitude: point.longitude.toFixed(5),
    });
    this.pending = fetch(`/api/weather-effects?${params}`, { signal: this.abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Cloud weather unavailable (${response.status})`);
        const payload = await response.json();
        if (!payload?.weather) throw new Error('Cloud weather observation unavailable');
        this.weather = payload.weather;
        this.fetchedAt = Date.now();
        this.anchor = point;
        this.applyWeather(payload.weather, point.altitudeM);
        this.canvas.dataset.sourceStatus = payload.status || 'ready';
        return payload.weather;
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') {
          this.targetStrength = 0;
          this.canvas.dataset.sourceStatus = 'unavailable';
        }
        return null;
      })
      .finally(() => {
        this.pending = null;
        this.abort = null;
      });
    return this.pending;
  }

  applyWeather(weather, altitudeM) {
    const profile = deriveWeatherEffectProfile(weather);
    const altitude = weatherAltitudeFactors(altitudeM);
    this.targetStrength = profile.available ? profile.cloud * altitude.cloud : 0;
    this.windDirectionDeg = profile.windDirectionDeg || 0;
    this.windStrength = profile.wind || 0;
    this.canvas.dataset.cloudStrength = this.targetStrength.toFixed(3);
    this.canvas.dataset.weatherCode = String(weather?.weatherCode ?? 'unknown');
    if (this.reducedMotion && document.body.classList.contains('cockpit-mode')) {
      this.strength = this.targetStrength;
      const visible = this.strength > 0.035;
      this.canvas.classList.toggle('active', visible);
      if (visible) this.render(0);
      else this.clear();
    }
  }

  tick(timeMs) {
    if (this.destroyed || !this.enabled || !document.body.classList.contains('cockpit-mode')) {
      this.stop();
      return;
    }
    // Suspended (document hidden): halt every scheduling chain — rAF AND the
    // reduced-motion timeout chain — without tearing weather state down.
    // setSuspended(false) restarts exactly one chain. (perf wave 2 fix)
    if (this.suspended) {
      this.frame = null;
      if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
      return;
    }

    if (timeMs - this.lastRefreshCheckMs >= 1000) {
      this.lastRefreshCheckMs = timeMs;
      const point = this.cameraPoint();
      if (point && cockpitWeatherRefreshDue({
        nowMs: Date.now(),
        fetchedAt: this.fetchedAt,
        anchor: this.anchor,
        point,
        hasWeather: Boolean(this.weather),
      })) void this.refresh();
    }

    const blend = this.reducedMotion ? 1 : 0.08;
    this.strength += (this.targetStrength - this.strength) * blend;
    const visible = this.strength > 0.035;
    this.canvas.classList.toggle('active', visible);
    if (visible && (this.reducedMotion || timeMs - this.lastFrameMs >= CLOUD_FRAME_MS)) {
      this.lastFrameMs = timeMs;
      this.render(timeMs / 1000);
    } else if (!visible) {
      this.clear();
    }

    if (this.reducedMotion) {
      this.frame = null;
      this.refreshTimer = window.setTimeout(() => {
        this.refreshTimer = null;
        this.tick(performance.now());
      }, 1000);
      return;
    }
    this.frame = requestAnimationFrame((time) => this.tick(time));
  }

  render(timeSec) {
    const gl = this.gl;
    if (!gl || !this.program || !this.locations) return;
    const windRadians = Cesium.Math.toRadians(this.windDirectionDeg);
    const windScale = 0.008 + this.windStrength * 0.022;
    gl.useProgram(this.program);
    gl.uniform2f(this.locations.resolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.locations.time, timeSec);
    gl.uniform1f(this.locations.strength, Math.min(1, Math.max(0, this.strength)));
    gl.uniform2f(
      this.locations.wind,
      Math.sin(windRadians) * windScale,
      -Math.cos(windRadians) * windScale,
    );
    const atmosphere = this.atmosphereUniforms();
    gl.uniform3f(
      this.locations.sunDirection,
      atmosphere.sunDirection.x,
      atmosphere.sunDirection.y,
      atmosphere.sunDirection.z,
    );
    gl.uniform3f(this.locations.sunColor, ...atmosphere.sunColor);
    gl.uniform3f(this.locations.skyColor, ...atmosphere.skyColor);
    gl.uniform2f(
      this.locations.aerial,
      atmosphere.aerial.inscatter,
      atmosphere.aerial.extinctionScale,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * Sun and air-column terms for the cloud pass, from the real solar position
   * at the camera. Falls back to a fixed noon sun when the camera is unknown.
   * @returns {{sunDirection: {x: number, y: number, z: number}, sunColor: number[], skyColor: number[], aerial: {inscatter: number, extinctionScale: number}}}
   */
  atmosphereUniforms() {
    const point = this.cameraPoint();
    const solar = point
      ? solarPositionDeg({
        dateMs: Date.now(),
        latitude: point.latitude,
        longitude: point.longitude,
      })
      : { elevationDeg: 45, azimuthDeg: 0 };
    const headingDeg = Number.isFinite(this.viewer?.camera?.heading)
      ? Cesium.Math.toDegrees(this.viewer.camera.heading)
      : 0;
    const irradiance = cockpitSunIrradiance(solar.elevationDeg);
    return {
      aerial: cockpitAerialPerspective(point?.altitudeM ?? 0),
      skyColor: irradiance.sky,
      sunColor: irradiance.sun,
      sunDirection: cockpitSunDirection(solar.elevationDeg, solar.azimuthDeg - headingDeg),
    };
  }

  getSnapshot() {
    return {
      enabled: this.enabled,
      active: this.canvas.classList.contains('active'),
      strength: this.targetStrength,
      weather: this.weather ? { ...this.weather } : null,
      renderSize: { width: this.canvas.width, height: this.canvas.height },
      sourceStatus: this.canvas.dataset.sourceStatus || 'idle',
    };
  }

  /**
   * Hidden-state gate (perf wave 2): pause the independent cloud rAF while
   * the document is hidden; resume it on return if cockpit mode is still up.
   * @param {boolean} suspended
   * @returns {void}
   */
  setSuspended(suspended) {
    this.suspended = Boolean(suspended);
    if (this.suspended) {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = null;
      // The reduced-motion path schedules via timeout, not rAF — clear it
      // too, plus the startup refresh timer; refresh() is suspend-guarded.
      if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
      if (this.startupTimer !== null) window.clearTimeout(this.startupTimer);
      this.startupTimer = null;
    } else if (document.body.classList.contains('cockpit-mode')) {
      this.start();
    }
  }

  destroy() {
    this.destroyed = true;
    this.stop();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('gev:cockpit-mode-changed', this.onCockpitMode);
    window.removeEventListener('gev:cockpit-weather-toggle', this.onEnabledChange);
    if (this.program && this.gl) this.gl.deleteProgram(this.program);
    this.canvas.remove();
  }
}

export function initCockpitCloudEffects(viewer) {
  return new CockpitCloudEffectsController(viewer);
}
