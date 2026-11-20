import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision';

/**
 * One-Euro Filter (Casiez, Roussel, Vogel — CHI 2012)
 *
 * Adaptive low-pass filter widely used in real-time motion tracking and interactive
 * camera games. When a landmark is nearly stationary (holding a pose), the cutoff
 * frequency stays low (minCutoff) to eliminate MediaPipe micro-jitter. When the
 * user snaps rapidly into a stance or throws a punch, the cutoff frequency rises
 * proportionally to speed (beta) to minimize perceptual lag.
 */

export interface OneEuroConfig {
  /** Minimum cutoff frequency in Hz (lower = smoother when still). */
  minCutoff: number;
  /** Speed coefficient (higher = less lag during fast motion). */
  beta: number;
  /** Derivative cutoff frequency in Hz. */
  dCutoff: number;
}

class LowPassFilter {
  private y: number | null = null;
  private s: number | null = null;

  filter(value: number, alpha: number): number {
    if (this.s === null) {
      this.y = value;
      this.s = value;
    } else {
      this.s = alpha * value + (1 - alpha) * this.s;
      this.y = value;
    }
    return this.s;
  }

  lastRaw(): number | null {
    return this.y;
  }

  reset(): void {
    this.y = null;
    this.s = null;
  }
}

export class OneEuroScalarFilter {
  private readonly xFilter = new LowPassFilter();
  private readonly dxFilter = new LowPassFilter();
  private lastTimestampSec: number | null = null;
  private readonly config: OneEuroConfig;

  /** Reset stale state automatically if tracking was absent for > 400ms. */
  private static readonly STALE_GAP_SEC = 0.4;

  constructor(config: OneEuroConfig) {
    this.config = config;
  }

  private static alpha(cutoffHz: number, dtSec: number): number {
    const tau = 1.0 / (2.0 * Math.PI * cutoffHz);
    return 1.0 / (1.0 + tau / Math.max(dtSec, 1e-4));
  }

  filter(value: number, timestampSec: number): number {
    if (
      this.lastTimestampSec === null ||
      timestampSec - this.lastTimestampSec > OneEuroScalarFilter.STALE_GAP_SEC ||
      timestampSec < this.lastTimestampSec
    ) {
      this.reset();
      this.lastTimestampSec = timestampSec;
      this.dxFilter.filter(0, 1);
      return this.xFilter.filter(value, 1);
    }

    const dt = Math.max(timestampSec - this.lastTimestampSec, 1 / 240);
    this.lastTimestampSec = timestampSec;

    const prevRaw = this.xFilter.lastRaw();
    const dValue = prevRaw === null ? 0 : (value - prevRaw) / dt;
    const edValue = this.dxFilter.filter(
      dValue,
      OneEuroScalarFilter.alpha(this.config.dCutoff, dt),
    );

    const cutoff = this.config.minCutoff + this.config.beta * Math.abs(edValue);
    return this.xFilter.filter(value, OneEuroScalarFilter.alpha(cutoff, dt));
  }

  reset(): void {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTimestampSec = null;
  }
}

export interface Landmark3D {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/**
 * Maintains independent One-Euro filters for all 33 MediaPipe Pose landmarks (x, y, z)
 * using pre-allocated output buffers to avoid per-frame GC allocations.
 */
export class PoseLandmarkSmoother {
  private readonly filters: Array<[OneEuroScalarFilter, OneEuroScalarFilter, OneEuroScalarFilter]>;
  private readonly buffer: Landmark3D[];
  private readonly worldFilters: Array<[OneEuroScalarFilter, OneEuroScalarFilter, OneEuroScalarFilter]>;
  private readonly worldBuffer: Landmark[];

  constructor(
    landmarkCount = 33,
    config: OneEuroConfig = { minCutoff: 0.85, beta: 3.2, dCutoff: 1.0 },
    worldConfig: OneEuroConfig = { minCutoff: 1.0, beta: 2.5, dCutoff: 1.0 },
  ) {
    this.filters = Array.from({ length: landmarkCount }, () => [
      new OneEuroScalarFilter(config),
      new OneEuroScalarFilter(config),
      new OneEuroScalarFilter(config),
    ]);
    this.buffer = Array.from({ length: landmarkCount }, () => ({
      x: 0,
      y: 0,
      z: 0,
      visibility: 0,
    }));
    this.worldFilters = Array.from({ length: landmarkCount }, () => [
      new OneEuroScalarFilter(worldConfig),
      new OneEuroScalarFilter(worldConfig),
      new OneEuroScalarFilter(worldConfig),
    ]);
    this.worldBuffer = Array.from({ length: landmarkCount }, () => ({
      x: 0,
      y: 0,
      z: 0,
      visibility: 0,
    }));
  }

  smooth(landmarks: NormalizedLandmark[] | Landmark3D[], timestampMs: number): Landmark3D[] {
    const tSec = timestampMs / 1000;
    const count = Math.min(landmarks.length, this.filters.length);
    for (let i = 0; i < count; i++) {
      const lm = landmarks[i];
      const [fx, fy, fz] = this.filters[i];
      const out = this.buffer[i];
      out.x = fx.filter(lm.x, tSec);
      out.y = fy.filter(lm.y, tSec);
      out.z = fz.filter(lm.z, tSec);
      out.visibility = lm.visibility;
    }
    return this.buffer;
  }

  smoothWorld(worldLandmarks: Landmark[], timestampMs: number): Landmark[] {
    const tSec = timestampMs / 1000;
    const count = Math.min(worldLandmarks.length, this.worldFilters.length);
    for (let i = 0; i < count; i++) {
      const lm = worldLandmarks[i];
      const [fx, fy, fz] = this.worldFilters[i];
      const out = this.worldBuffer[i];
      out.x = fx.filter(lm.x, tSec);
      out.y = fy.filter(lm.y, tSec);
      out.z = fz.filter(lm.z, tSec);
      out.visibility = lm.visibility;
    }
    return this.worldBuffer;
  }

  reset(): void {
    for (const [fx, fy, fz] of this.filters) {
      fx.reset();
      fy.reset();
      fz.reset();
    }
    for (const [fx, fy, fz] of this.worldFilters) {
      fx.reset();
      fy.reset();
      fz.reset();
    }
  }
}
