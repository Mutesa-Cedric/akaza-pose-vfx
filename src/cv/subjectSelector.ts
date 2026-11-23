import type { Landmark3D } from './oneEuroFilter';
import { POSE_IDX } from './poseLandmarker';

export interface SubjectCandidateInfo {
  /** Index of this candidate inside the MediaPipe landmarksList array. */
  index: number;
  /** Normalized torso-center x (image space). */
  torsoX: number;
  /** Normalized torso-center y (image space). */
  torsoY: number;
  /** Final selection score (higher = more likely the active performer). */
  score: number;
  /** Why this candidate was disqualified, or null when selectable. */
  rejectedReason: 'edge-zone' | 'incomplete' | null;
}

export interface SubjectSelectionResult {
  /** Index into landmarksList of the active performer; -1 when nobody qualifies. */
  selectedIndex: number;
  /**
   * True when the tracked subject position jumped > 0.22 normalized units —
   * callers should reset the One-Euro smoother + compositor echo history.
   */
  switched: boolean;
  /** Torso center x of the selected performer (last tracked position when none). */
  torsoX: number;
  /** Torso center y of the selected performer (last tracked position when none). */
  torsoY: number;
  /** Number of people MediaPipe reported this frame. */
  totalDetected: number;
  /** Indices of rejected candidates (edge-zone or incomplete detections). */
  ignoredIndices: number[];
  /** Per-candidate diagnostics for every detection (including rejected ones). */
  candidates: SubjectCandidateInfo[];
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

function isUsable(lm: Landmark3D | undefined, threshold = 0.32): boolean {
  return Boolean(lm && (lm.visibility ?? 1) >= threshold && lm.y > -0.25 && lm.y < 1.25);
}

function dist3D(
  a: { x: number; y: number; z: number } | undefined,
  b: { x: number; y: number; z: number } | undefined,
): number {
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Picks the single active center-stage performer out of MediaPipe's multi-person
 * arrays so interview-room bystanders (friends seated in chairs at the left/right
 * edges) can never steal tracking.
 *
 * Selection score per frame:
 *   0.42 * center proximity (Gaussian around x = 0.50)
 * + 0.28 * full-body visibility (knees/ankles in frame)
 * + 0.30 * subject prominence (2D body scale, 3D shoulder sanity check)
 * + up to 0.45 temporal sticky bonus for the candidate closest to the
 *   previously tracked torso position (within 0.20 normalized units).
 *
 * Candidates whose torso center falls outside the [0.18, 0.82] center zone are
 * hard-rejected ('edge-zone') and can never be selected while centerZoneOnly is on.
 *
 * Zero-allocation friendly: select() reuses pooled buffers and returns the same
 * result object every call — consume it immediately, do not retain across frames.
 */
export class SubjectSelector {
  /** Center-stage horizontal bounds — anything outside is a bystander. */
  centerZoneMin = 0.18;
  centerZoneMax = 0.82;
  /** Gauss sigma for the center-proximity preference. */
  centerSigma = 0.21;
  /** Sticky-lock radius around the last tracked torso position. */
  stickyRadius = 0.2;
  /** Position jump that flags `switched` so callers reset smoothing/echo state. */
  switchDistance = 0.22;
  /** Max extra score granted to the sticky candidate. */
  stickyBonus = 0.45;
  /** How long (ms) a lost track stays re-acquirable with sticky priority. */
  stickyMemoryMs = 1500;
  /** Minimum score a non-rejected candidate needs to become the subject. */
  minSelectScore = 0.1;

  private hasTracked = false;
  private trackedX = 0.5;
  private trackedY = 0.5;
  private lastSelectMs = -1e9;

  /** Pooled candidate records — reused every call, no per-frame allocation. */
  private readonly candidatePool: SubjectCandidateInfo[] = [];

  private readonly result: SubjectSelectionResult = {
    selectedIndex: -1,
    switched: false,
    torsoX: 0.5,
    torsoY: 0.5,
    totalDetected: 0,
    ignoredIndices: [],
    candidates: [],
  };

  reset(): void {
    this.hasTracked = false;
    this.trackedX = 0.5;
    this.trackedY = 0.5;
    this.lastSelectMs = -1e9;
    const r = this.result;
    r.selectedIndex = -1;
    r.switched = false;
    r.torsoX = 0.5;
    r.torsoY = 0.5;
    r.totalDetected = 0;
    r.ignoredIndices.length = 0;
    r.candidates.length = 0;
  }

  /**
   * @param landmarksList      MediaPipe result.landmarks (one 33-landmark array per person)
   * @param worldLandmarksList MediaPipe result.worldLandmarks (optional, used for scale sanity)
   * @param timestampMs        monotonic frame timestamp in ms
   * @param centerZoneOnly     when true, candidates outside [0.18, 0.82] are rejected
   */
  select(
    landmarksList: Landmark3D[][] | null | undefined,
    worldLandmarksList?: Landmark3D[][] | null,
    timestampMs = 0,
    centerZoneOnly = true,
  ): SubjectSelectionResult {
    const r = this.result;
    const candidates = this.candidatePool;
    const ignored = r.ignoredIndices;
    ignored.length = 0;

    const count = landmarksList ? landmarksList.length : 0;
    r.totalDetected = count;
    r.selectedIndex = -1;
    r.switched = false;
    r.candidates = candidates;

    if (count === 0) {
      candidates.length = 0;
      r.torsoX = this.hasTracked ? this.trackedX : 0.5;
      r.torsoY = this.hasTracked ? this.trackedY : 0.5;
      return r;
    }

    // Grow/shrink the pooled candidate array to match this frame's detections.
    while (candidates.length < count) {
      candidates.push({ index: 0, torsoX: 0, torsoY: 0, score: 0, rejectedReason: null });
    }
    if (candidates.length > count) candidates.length = count;

    const stickyAlive =
      this.hasTracked && timestampMs - this.lastSelectMs <= this.stickyMemoryMs;

    // ------------------------------------------------------------------
    // 1. Measure every detected person
    // ------------------------------------------------------------------
    for (let i = 0; i < count; i++) {
      const lm = landmarksList?.[i];
      const info = candidates[i];
      info.index = i;
      info.torsoX = 0.5;
      info.torsoY = 0.5;
      info.score = 0;
      info.rejectedReason = null;

      if (!lm || lm.length < 29) {
        info.rejectedReason = 'incomplete';
        ignored.push(i);
        continue;
      }

      const lSh = lm[POSE_IDX.LEFT_SHOULDER];
      const rSh = lm[POSE_IDX.RIGHT_SHOULDER];
      const lHip = lm[POSE_IDX.LEFT_HIP];
      const rHip = lm[POSE_IDX.RIGHT_HIP];

      const shL = isUsable(lSh) ? 1 : 0;
      const shR = isUsable(rSh) ? 1 : 0;
      const hipL = isUsable(lHip) ? 1 : 0;
      const hipR = isUsable(rHip) ? 1 : 0;
      const shoulderCount = shL + shR;
      const hipCount = hipL + hipR;

      // Need at least one shoulder plus one other torso anchor for a stable center.
      if (shoulderCount === 0 || shoulderCount + hipCount < 2) {
        info.rejectedReason = 'incomplete';
        ignored.push(i);
        continue;
      }

      const shX = (shL ? (lSh?.x ?? 0) : 0) + (shR ? (rSh?.x ?? 0) : 0);
      const shY = (shL ? (lSh?.y ?? 0) : 0) + (shR ? (rSh?.y ?? 0) : 0);
      const hipX = (hipL ? (lHip?.x ?? 0) : 0) + (hipR ? (rHip?.x ?? 0) : 0);
      const hipY = (hipL ? (lHip?.y ?? 0) : 0) + (hipR ? (rHip?.y ?? 0) : 0);
      const shMidX = shX / shoulderCount;
      const shMidY = shY / shoulderCount;
      const hipMidX = hipCount > 0 ? hipX / hipCount : shMidX;
      const hipMidY = hipCount > 0 ? hipY / hipCount : shMidY + 0.3;

      // Shoulders carry 62% of the torso center (they are the most stable anchor).
      const torsoX = shMidX * 0.62 + hipMidX * 0.38;
      const torsoY = shMidY * 0.62 + hipMidY * 0.38;
      info.torsoX = torsoX;
      info.torsoY = torsoY;

      // Body scale: shoulder width dominates, torso height is the fallback axis.
      const shoulderWidth =
        shoulderCount === 2
          ? Math.max(0.02, Math.abs((lSh?.x ?? 0) - (rSh?.x ?? 0)))
          : hipCount === 2
            ? Math.max(0.02, Math.abs((lHip?.x ?? 0) - (rHip?.x ?? 0)) * 1.35)
            : 0.05;
      const torsoHeight =
        hipCount > 0
          ? Math.max(0.05, hipMidY - shMidY)
          : shoulderWidth * 1.35;
      const scale = Math.max(shoulderWidth, torsoHeight * 0.46);

      const lKnee = lm[POSE_IDX.LEFT_KNEE];
      const rKnee = lm[POSE_IDX.RIGHT_KNEE];
      const lAnk = lm[POSE_IDX.LEFT_ANKLE];
      const rAnk = lm[POSE_IDX.RIGHT_ANKLE];
      const hasLowerBody = isUsable(lKnee, 0.4) && isUsable(rKnee, 0.4);
      const anklesIn = isUsable(lAnk, 0.3) && isUsable(rAnk, 0.3);

      // ---------------------------------------------------------------
      // Center-zone bystander rejection: interviewers seated at the room
      // edges (cx < 0.18 or > 0.82) can never become the active performer.
      // ---------------------------------------------------------------
      if (centerZoneOnly && (torsoX < this.centerZoneMin || torsoX > this.centerZoneMax)) {
        info.rejectedReason = 'edge-zone';
        ignored.push(i);
        continue;
      }

      // ---------------------------------------------------------------
      // Score: center proximity + full-body framing + subject prominence
      // ---------------------------------------------------------------
      const dx = torsoX - 0.5;
      const centerScore = Math.exp(
        -(dx * dx) / (2 * this.centerSigma * this.centerSigma),
      );
      const bodyScore = hasLowerBody ? (anklesIn ? 1.0 : 0.8) : 0.15;
      let scaleScore = smoothstep(0.04, 0.11, scale);

      // 3D sanity: a real adult shoulder span is ~0.30-0.55 m — shrink scores
      // for degenerate far-away or glitched detections.
      const wl = worldLandmarksList?.[i];
      if (wl && wl.length > POSE_IDX.RIGHT_SHOULDER) {
        const span3D = dist3D(
          wl[POSE_IDX.LEFT_SHOULDER],
          wl[POSE_IDX.RIGHT_SHOULDER],
        );
        if (span3D > 1e-4) {
          scaleScore *= 0.55 + 0.45 * smoothstep(0.16, 0.3, span3D);
        }
      }

      info.score =
        centerScore * 0.42 + bodyScore * 0.28 + scaleScore * 0.30;
    }

    // ------------------------------------------------------------------
    // 2. Temporal sticky lock: only the closest selectable candidate inside
    //    the 0.20 radius gets the continuity bonus — tracking never flickers
    //    back and forth between two people.
    // ------------------------------------------------------------------
    if (stickyAlive) {
      let stickyIdx = -1;
      let stickyDist = this.stickyRadius;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (c.rejectedReason) continue;
        const d = Math.hypot(c.torsoX - this.trackedX, c.torsoY - this.trackedY);
        if (d < stickyDist) {
          stickyDist = d;
          stickyIdx = i;
        }
      }
      if (stickyIdx >= 0) {
        candidates[stickyIdx].score +=
          this.stickyBonus * (1 - stickyDist / this.stickyRadius);
      }
    }

    // ------------------------------------------------------------------
    // 3. Pick the best non-rejected candidate
    // ------------------------------------------------------------------
    let best: SubjectCandidateInfo | null = null;
    for (const c of candidates) {
      if (c.rejectedReason) continue;
      if (!best || c.score > best.score) best = c;
    }

    if (best && best.score >= this.minSelectScore) {
      const jumped =
        this.hasTracked &&
        Math.hypot(best.torsoX - this.trackedX, best.torsoY - this.trackedY) >
          this.switchDistance;

      r.selectedIndex = best.index;
      r.switched = jumped;
      r.torsoX = best.torsoX;
      r.torsoY = best.torsoY;

      this.hasTracked = true;
      this.trackedX = best.torsoX;
      this.trackedY = best.torsoY;
      this.lastSelectMs = timestampMs;
    } else {
      // Nobody qualified — keep the last tracked anchor briefly for re-acquire.
      r.torsoX = this.hasTracked ? this.trackedX : 0.5;
      r.torsoY = this.hasTracked ? this.trackedY : 0.5;
    }

    // Ensure every non-selected detection (whether edge-rejected or outscored) is marked ignored
    // so debug overlays and HUD counts reflect every bystander in the room.
    for (const c of candidates) {
      if (c.index !== r.selectedIndex && !c.rejectedReason) {
        ignored.push(c.index);
      }
    }

    return r;
  }
}
