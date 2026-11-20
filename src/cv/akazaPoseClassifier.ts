import type { Landmark3D } from './oneEuroFilter';
import { POSE_IDX } from './poseLandmarker';

export type DetectionMode = 'auto' | 'full-body' | 'upper-body';

export type ResolvedMode = 'full-body' | 'upper-body';

export type PoseState = 'IDLE' | 'CHARGING' | 'ACTIVE' | 'DISSIPATING';

export type StanceSide = 'left-lead' | 'right-lead';

export interface Vec2 {
  x: number;
  y: number;
}

export interface PoseSubScores {
  /** Wide martial arts stance (knees & ankles spread relative to body scale). */
  stanceWidth: number;
  /** Low coiled Soryu crouch (hips dropped toward knee level + knee flexion). */
  squatDepth: number;
  /** Front arm raised in chest/shoulder guard position. */
  leadArmGuard: number;
  /** Rear arm chambered low near hip/waist. */
  rearArmChamber: number;
  /** Vertical + structural asymmetry characteristic of Akaza's Soryu stance. */
  armAsymmetry: number;
}

export interface PoseTelemetry {
  hasPerson: boolean;
  resolvedMode: ResolvedMode;
  stanceSide: StanceSide;
  subScores: PoseSubScores;
  /** Raw instantaneous frame confidence in [0, 1]. */
  rawConfidence: number;
  /** State machine phase after debounce & hysteresis. */
  state: PoseState;
  /** Progress in [0, 1] during CHARGING (0..1) or ACTIVE (1) or DISSIPATING (1..0). */
  chargeProgress: number;
  /** Overall smooth effect intensity [0, 1] driven by state machine. */
  effectIntensity: number;
  /** Seconds spent continuously in ACTIVE state. */
  activeDurationSec: number;
  /** Normalized 2D anchor for the 3D floor Snowflake Compass Needle. */
  floorAnchor: Vec2;
  /** Normalized 2D center of the user's torso for shockwaves & aura. */
  bodyCenter: Vec2;
  /** Normalized 2D body scale (width reference for sizing effects). */
  bodyScale: number;
  /** Normalized 2D wrist positions for fist trails & reactive punch bursts. */
  leadWrist: Vec2;
  rearWrist: Vec2;
  /** Peak instantaneous wrist velocity (normalized units/sec) for punch-burst reactivity. */
  wristSpeed: number;
}

export type PoseEvaluation = PoseTelemetry;

const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v));

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

const dist2D = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

const dist3D = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Computes interior angle at joint B in degrees (0..180) using 3D coordinates. */
function angle3D(a: Landmark3D, b: Landmark3D, c: Landmark3D): number {
  const bax = a.x - b.x;
  const bay = a.y - b.y;
  const baz = a.z - b.z;
  const bcx = c.x - b.x;
  const bcy = c.y - b.y;
  const bcz = c.z - b.z;

  const magA = Math.hypot(bax, bay, baz);
  const magC = Math.hypot(bcx, bcy, bcz);
  if (magA < 1e-5 || magC < 1e-5) return 180;

  const cosTheta = Math.max(
    -1,
    Math.min(1, (bax * bcx + bay * bcy + baz * bcz) / (magA * magC)),
  );
  return (Math.acos(cosTheta) * 180) / Math.PI;
}

function isVisible(lm: Landmark3D | undefined, threshold = 0.35): boolean {
  return Boolean(lm && (lm.visibility ?? 1) >= threshold && lm.y >= 0.01 && lm.y <= 0.99);
}

/**
 * Geometry-based, scale-invariant, mirror-invariant classifier for Akaza's
 * Destructive Death — Final Form: Blue Silver Chaotic Afterglow (Soryu martial arts stance)
 * paired with a temporal hysteresis state machine.
 */
export class AkazaPoseTracker {
  private state: PoseState = 'IDLE';
  private chargeElapsedSec = 0;
  private activeElapsedSec = 0;
  private releaseElapsedSec = 0;
  private effectIntensity = 0;
  private lastTimestampMs: number | null = null;
  private prevLeftWrist: Vec2 | null = null;
  private prevRightWrist: Vec2 | null = null;
  private latchedSide: StanceSide = 'left-lead';
  private lastRawConfidence = 0;
  private prevFloorAnchor: Vec2 | null = null;

  // Tuned thresholds with hysteresis so the effect locks reliably and never flickers.
  private readonly ENTRY_THRESHOLD = 0.62;
  private readonly SUSTAIN_THRESHOLD = 0.46;
  private readonly CHARGE_DURATION_SEC = 0.22;
  private readonly RELEASE_GRACE_SEC = 0.34;
  private readonly DISSIPATE_RATE = 2.4; // fades out in ~0.42s
  private readonly SWITCH_MARGIN = 0.14;

  reset(): void {
    this.state = 'IDLE';
    this.chargeElapsedSec = 0;
    this.activeElapsedSec = 0;
    this.releaseElapsedSec = 0;
    this.effectIntensity = 0;
    this.lastTimestampMs = null;
    this.prevLeftWrist = null;
    this.prevRightWrist = null;
    this.latchedSide = 'left-lead';
    this.lastRawConfidence = 0;
    this.prevFloorAnchor = null;
  }

  update(
    landmarks2D: Landmark3D[] | null,
    worldLandmarks3D: Landmark3D[] | null,
    mode: DetectionMode,
    timestampMs: number,
    manualOverride = false,
  ): PoseTelemetry {
    const dtSec =
      this.lastTimestampMs === null
        ? 1 / 60
        : Math.min(0.1, Math.max(1 / 240, (timestampMs - this.lastTimestampMs) / 1000));
    this.lastTimestampMs = timestampMs;

    if (manualOverride) {
      this.state = 'ACTIVE';
      this.chargeElapsedSec = this.CHARGE_DURATION_SEC;
      this.activeElapsedSec += dtSec;
      this.effectIntensity = Math.min(1, this.effectIntensity + dtSec * 3.5);
      this.latchedSide = 'left-lead';
      this.lastRawConfidence = 1;
      return {
        hasPerson: Boolean(landmarks2D),
        resolvedMode: mode === 'upper-body' ? 'upper-body' : 'full-body',
        stanceSide: 'left-lead',
        subScores: {
          stanceWidth: 1,
          squatDepth: 1,
          leadArmGuard: 1,
          rearArmChamber: 1,
          armAsymmetry: 1,
        },
        rawConfidence: 1,
        state: 'ACTIVE',
        chargeProgress: 1,
        effectIntensity: this.effectIntensity,
        activeDurationSec: this.activeElapsedSec,
        floorAnchor: landmarks2D ? this.computeFloorAnchor(landmarks2D, 'full-body', 0.25, dtSec) : { x: 0.5, y: 0.84 },
        bodyCenter: landmarks2D ? this.computeBodyCenter(landmarks2D) : { x: 0.5, y: 0.48 },
        bodyScale: landmarks2D ? this.computeBodyScale(landmarks2D) : 0.14,
        leadWrist: landmarks2D?.[POSE_IDX.LEFT_WRIST] ?? { x: 0.62, y: 0.44 },
        rearWrist: landmarks2D?.[POSE_IDX.RIGHT_WRIST] ?? { x: 0.38, y: 0.56 },
        wristSpeed: 0,
      };
    }

    if (!landmarks2D || landmarks2D.length < 29) {
      this.stepStateMachine(0, dtSec);
      this.prevLeftWrist = null;
      this.prevRightWrist = null;
      this.lastRawConfidence = 0;
      this.prevFloorAnchor = null;
      return {
        hasPerson: false,
        resolvedMode: mode === 'upper-body' ? 'upper-body' : 'full-body',
        stanceSide: this.latchedSide,
        subScores: {
          stanceWidth: 0,
          squatDepth: 0,
          leadArmGuard: 0,
          rearArmChamber: 0,
          armAsymmetry: 0,
        },
        rawConfidence: 0,
        state: this.state,
        chargeProgress: this.computeChargeProgress(),
        effectIntensity: this.effectIntensity,
        activeDurationSec: this.activeElapsedSec,
        floorAnchor: { x: 0.5, y: 0.85 },
        bodyCenter: { x: 0.5, y: 0.5 },
        bodyScale: 0.14,
        leadWrist: { x: 0.55, y: 0.45 },
        rearWrist: { x: 0.45, y: 0.55 },
        wristSpeed: 0,
      };
    }

    const lSh = landmarks2D[POSE_IDX.LEFT_SHOULDER];
    const rSh = landmarks2D[POSE_IDX.RIGHT_SHOULDER];
    const lEl = landmarks2D[POSE_IDX.LEFT_ELBOW];
    const rEl = landmarks2D[POSE_IDX.RIGHT_ELBOW];
    const lWr = landmarks2D[POSE_IDX.LEFT_WRIST];
    const rWr = landmarks2D[POSE_IDX.RIGHT_WRIST];
    const lHip = landmarks2D[POSE_IDX.LEFT_HIP];
    const rHip = landmarks2D[POSE_IDX.RIGHT_HIP];
    const lKnee = landmarks2D[POSE_IDX.LEFT_KNEE];
    const rKnee = landmarks2D[POSE_IDX.RIGHT_KNEE];
    const lAnk = landmarks2D[POSE_IDX.LEFT_ANKLE];
    const rAnk = landmarks2D[POSE_IDX.RIGHT_ANKLE];

    const kneesVisible = isVisible(lKnee, 0.45) && isVisible(rKnee, 0.45);
    const anklesVisible = isVisible(lAnk, 0.35) && isVisible(rAnk, 0.35);
    const lowerBodyVisible = kneesVisible && (anklesVisible || (lKnee.y < 0.94 && rKnee.y < 0.94));

    const resolvedMode: ResolvedMode =
      mode === 'auto'
        ? lowerBodyVisible
          ? 'full-body'
          : 'upper-body'
        : mode;

    const shMid: Vec2 = { x: (lSh.x + rSh.x) * 0.5, y: (lSh.y + rSh.y) * 0.5 };
    const hipMid: Vec2 = { x: (lHip.x + rHip.x) * 0.5, y: (lHip.y + rHip.y) * 0.5 };
    const shoulderWidth = Math.max(0.03, Math.abs(lSh.x - rSh.x));
    const torsoHeight = Math.max(0.06, hipMid.y - shMid.y);
    // Robust scale invariant to slight 3/4 torso rotation
    const bodyScale = Math.max(shoulderWidth, torsoHeight * 0.46);

    const nose = landmarks2D[POSE_IDX.NOSE];
    const lEar = landmarks2D[7];
    const rEar = landmarks2D[8];

    const w = worldLandmarks3D && worldLandmarks3D.length >= 29 ? worldLandmarks3D : null;

    let uSpine: { x: number; y: number; z: number } | null = null;
    let torsoLen3D = 0;
    let wShMid = { x: 0, y: 0, z: 0 };
    let wHipMid = { x: 0, y: 0, z: 0 };

    if (w) {
      const wLSh = w[POSE_IDX.LEFT_SHOULDER];
      const wRSh = w[POSE_IDX.RIGHT_SHOULDER];
      const wLHip = w[POSE_IDX.LEFT_HIP];
      const wRHip = w[POSE_IDX.RIGHT_HIP];
      wShMid = {
        x: (wLSh.x + wRSh.x) * 0.5,
        y: (wLSh.y + wRSh.y) * 0.5,
        z: (wLSh.z + wRSh.z) * 0.5,
      };
      wHipMid = {
        x: (wLHip.x + wRHip.x) * 0.5,
        y: (wLHip.y + wRHip.y) * 0.5,
        z: (wLHip.z + wRHip.z) * 0.5,
      };
      const vTorso = {
        x: wShMid.x - wHipMid.x,
        y: wShMid.y - wHipMid.y,
        z: wShMid.z - wHipMid.z,
      };
      torsoLen3D = Math.hypot(vTorso.x, vTorso.y, vTorso.z);
      if (torsoLen3D > 1e-4) {
        uSpine = {
          x: vTorso.x / torsoLen3D,
          y: vTorso.y / torsoLen3D,
          z: vTorso.z / torsoLen3D,
        };
      }
    }

    // -------------------------------------------------------------------------
    // 1. Evaluate ARM STANCE for both mirror directions (left-lead vs right-lead)
    // -------------------------------------------------------------------------
    const evaluateArmSide = (
      leadSh: Landmark3D,
      leadEl: Landmark3D,
      leadWr: Landmark3D,
      rearSh: Landmark3D,
      rearEl: Landmark3D,
      rearWr: Landmark3D,
      wLeadSh?: Landmark3D,
      wLeadEl?: Landmark3D,
      wLeadWr?: Landmark3D,
      wRearSh?: Landmark3D,
      wRearEl?: Landmark3D,
      wRearWr?: Landmark3D,
    ) => {
      // Normalized vertical position of wrists: 0 = hip level, 1 = shoulder level
      let leadHeight = (hipMid.y - leadWr.y) / torsoHeight;
      let rearHeight = (hipMid.y - rearWr.y) / torsoHeight;

      // Forward-pitch invariant wrist height: project wrist heights along unit spine uSpine
      if (uSpine && torsoLen3D > 1e-4) {
        if (wLeadWr) {
          const leadProj =
            (wLeadWr.x - wHipMid.x) * uSpine.x +
            (wLeadWr.y - wHipMid.y) * uSpine.y +
            (wLeadWr.z - wHipMid.z) * uSpine.z;
          const leadHeight3D = leadProj / torsoLen3D;
          // Protect against 2D torso foreshortening when leaning forward in deep crouch
          if (leadHeight > leadHeight3D) {
            leadHeight = Math.min(
              leadHeight,
              Math.max(leadHeight3D, 0.4 * leadHeight + 0.6 * leadHeight3D),
            );
          } else {
            leadHeight = 0.65 * leadHeight + 0.35 * leadHeight3D;
          }
          if (leadHeight > 1.45 && leadHeight3D <= 1.45) {
            leadHeight = leadHeight3D;
          }
        }
        if (wRearWr) {
          const rearProj =
            (wRearWr.x - wHipMid.x) * uSpine.x +
            (wRearWr.y - wHipMid.y) * uSpine.y +
            (wRearWr.z - wHipMid.z) * uSpine.z;
          const rearHeight3D = rearProj / torsoLen3D;
          if (rearHeight > rearHeight3D) {
            rearHeight = Math.min(
              rearHeight,
              Math.max(rearHeight3D, 0.4 * rearHeight + 0.6 * rearHeight3D),
            );
          } else {
            rearHeight = 0.65 * rearHeight + 0.35 * rearHeight3D;
          }
          if (rearHeight > 0.65 && rearHeight3D <= 0.65) {
            rearHeight = rearHeight3D;
          }
        }
      }

      // Face-proximity guard: in both full-body and upper-body modes, if candidate lead wrist is right next
      // to nose or ears (coffee mug, phone, scratching chin), penalize leadArmGuard sharply.
      let minDistFace = dist2D(leadWr, nose);
      if (lEar && (lEar.visibility ?? 1) >= 0.25) {
        minDistFace = Math.min(minDistFace, dist2D(leadWr, lEar));
      }
      if (rEar && (rEar.visibility ?? 1) >= 0.25) {
        minDistFace = Math.min(minDistFace, dist2D(leadWr, rEar));
      }
      const faceRatio = minDistFace / bodyScale;
      const faceGuardPenalty = smoothstep(0.20, 0.36, faceRatio);

      // Akaza's lead fist is held up at chest-to-head level (height ~ 0.65..1.35)
      const leadHeightScore =
        smoothstep(0.45, 0.78, leadHeight) * (1 - smoothstep(1.45, 1.85, leadHeight));

      // Lead arm is either extended forward/outward OR held in a tight guard bend
      const leadReach = dist2D(leadSh, leadWr) / torsoHeight;
      const leadElbowAngle =
        wLeadSh && wLeadEl && wLeadWr
          ? angle3D(wLeadSh, wLeadEl, wLeadWr)
          : angle3D(leadSh, leadEl, leadWr);
      // Elbow shouldn't be awkwardly locked overhead; 45°..165° martial guard or strike
      const leadStructure = Math.max(
        smoothstep(0.28, 0.55, leadReach),
        smoothstep(35, 75, leadElbowAngle) * (1 - smoothstep(168, 179, leadElbowAngle)),
      );
      const leadArmGuard = clamp01(
        (leadHeightScore * 0.72 + leadStructure * 0.28) * faceGuardPenalty,
      );

      // Akaza's rear fist is pulled back / chambered near waist, ribs, or hip (height ~ -0.15..0.62)
      const rearHeightScore =
        smoothstep(-0.3, 0.05, rearHeight) * (1 - smoothstep(0.55, 0.88, rearHeight));

      // Rear elbow is flexed / pulled back (not hanging completely straight limp)
      const rearElbowAngle =
        wRearSh && wRearEl && wRearWr
          ? angle3D(wRearSh, wRearEl, wRearWr)
          : angle3D(rearSh, rearEl, rearWr);
      // In Soryu chambered guard, rear elbow bends (typically 50..155 deg) OR wrist sits back near hip
      const rearChamberBend = 1 - smoothstep(155, 176, rearElbowAngle);
      const rearArmChamber = clamp01(rearHeightScore * 0.65 + rearChamberBend * 0.35);

      // Strong vertical separation between lead fist (high) and rear fist (low)
      // In reference video: (lWr - rWr) / torsoHeight ≈ 0.74
      const verticalDiff = leadHeight - rearHeight;
      const armAsymmetry = smoothstep(0.22, 0.58, verticalDiff);

      const combinedArm =
        leadArmGuard * 0.38 + rearArmChamber * 0.32 + armAsymmetry * 0.30;

      return { leadArmGuard, rearArmChamber, armAsymmetry, combinedArm };
    };

    const leftLeadEval = evaluateArmSide(
      lSh, lEl, lWr, rSh, rEl, rWr,
      w?.[POSE_IDX.LEFT_SHOULDER], w?.[POSE_IDX.LEFT_ELBOW], w?.[POSE_IDX.LEFT_WRIST],
      w?.[POSE_IDX.RIGHT_SHOULDER], w?.[POSE_IDX.RIGHT_ELBOW], w?.[POSE_IDX.RIGHT_WRIST],
    );
    const rightLeadEval = evaluateArmSide(
      rSh, rEl, rWr, lSh, lEl, lWr,
      w?.[POSE_IDX.RIGHT_SHOULDER], w?.[POSE_IDX.RIGHT_ELBOW], w?.[POSE_IDX.RIGHT_WRIST],
      w?.[POSE_IDX.LEFT_SHOULDER], w?.[POSE_IDX.LEFT_ELBOW], w?.[POSE_IDX.LEFT_WRIST],
    );

    // Stance-Side Hysteresis Latch (Schmidt Trigger)
    // Only flip between 'left-lead' and 'right-lead' when opposing side exceeds current by SWITCH_MARGIN (0.14)
    // or when state === 'IDLE' and rawConfidence < 0.35.
    const isCurrentLeft = this.latchedSide === 'left-lead';
    const currentScore = isCurrentLeft ? leftLeadEval.combinedArm : rightLeadEval.combinedArm;
    const opposingScore = isCurrentLeft ? rightLeadEval.combinedArm : leftLeadEval.combinedArm;

    if (opposingScore > currentScore + this.SWITCH_MARGIN) {
      this.latchedSide = isCurrentLeft ? 'right-lead' : 'left-lead';
    } else if (this.state === 'IDLE' && this.lastRawConfidence < 0.35 && opposingScore > currentScore) {
      this.latchedSide = isCurrentLeft ? 'right-lead' : 'left-lead';
    }

    const isLeftLead = this.latchedSide === 'left-lead';
    const armEval = isLeftLead ? leftLeadEval : rightLeadEval;
    const stanceSide: StanceSide = this.latchedSide;
    const leadWrist: Vec2 = isLeftLead ? { x: lWr.x, y: lWr.y } : { x: rWr.x, y: rWr.y };
    const rearWrist: Vec2 = isLeftLead ? { x: rWr.x, y: rWr.y } : { x: lWr.x, y: lWr.y };

    // -------------------------------------------------------------------------
    // 2. Evaluate LOWER-BODY SORYU STANCE (Wide horse stance + crouched knees)
    // -------------------------------------------------------------------------
    let stanceWidth = 0;
    let squatDepth = 0;

    if (lowerBodyVisible) {
      const kneeWidth = Math.abs(lKnee.x - rKnee.x);
      const ankleWidth = anklesVisible ? Math.abs(lAnk.x - rAnk.x) : kneeWidth;
      // Reference video: standing ratio ~1.0, Akaza stance ratio ~1.8..2.1
      const widthRatio2D = Math.max(kneeWidth, ankleWidth) / bodyScale;

      // 3D Rotation-Invariant Stance Width
      let widthRatio = widthRatio2D;
      if (w) {
        const wLKnee = w[POSE_IDX.LEFT_KNEE];
        const wRKnee = w[POSE_IDX.RIGHT_KNEE];
        const wLAnk = w[POSE_IDX.LEFT_ANKLE];
        const wRAnk = w[POSE_IDX.RIGHT_ANKLE];
        const wLSh = w[POSE_IDX.LEFT_SHOULDER];
        const wRSh = w[POSE_IDX.RIGHT_SHOULDER];
        const kneeSep3D = dist3D(wLKnee, wRKnee);
        const footSep3D = dist3D(wLAnk, wRAnk);
        const sep3D = anklesVisible ? Math.max(kneeSep3D, footSep3D) : kneeSep3D;
        const shoulderWidth3D = Math.max(
          dist3D(wLSh, wRSh),
          dist3D(wShMid, wHipMid) * 0.55,
        );
        const widthRatio3D = sep3D / Math.max(1e-4, shoulderWidth3D);
        widthRatio = Math.max(widthRatio2D, widthRatio3D);
      }
      stanceWidth = smoothstep(1.12, 1.65, widthRatio);

      // 2D hip-to-knee drop: standing ~0.64, crouched ~0.16..0.42
      const kneeMidY = (lKnee.y + rKnee.y) * 0.5;
      const hipToKneeRatio = (kneeMidY - hipMid.y) / torsoHeight;
      const squat2D = 1 - smoothstep(0.28, 0.62, hipToKneeRatio);

      // 3D knee flexion angle if worldLandmarks available (straight ~170°, crouched ~95..148°)
      let squat3D = squat2D;
      if (w && anklesVisible) {
        const lKneeAngle = angle3D(
          w[POSE_IDX.LEFT_HIP],
          w[POSE_IDX.LEFT_KNEE],
          w[POSE_IDX.LEFT_ANKLE],
        );
        const rKneeAngle = angle3D(
          w[POSE_IDX.RIGHT_HIP],
          w[POSE_IDX.RIGHT_KNEE],
          w[POSE_IDX.RIGHT_ANKLE],
        );
        const minKneeAngle = Math.min(lKneeAngle, rKneeAngle);
        const avgKneeAngle = (lKneeAngle + rKneeAngle) * 0.5;
        squat3D = Math.max(
          1 - smoothstep(115, 158, avgKneeAngle),
          1 - smoothstep(105, 152, minKneeAngle),
        );
      }

      squatDepth = clamp01(Math.max(squat2D, squat3D * 0.92));

      // Seated chair guard: In full-body mode, do NOT penalize genuine deep Akaza horse crouch
      // (where knees & ankles are wide apart, e.g. max(kneeWidth, ankleWidth)/bodyScale >= 1.45
      // and hipToKneeRatio can be as low as 0.14!).
      // ONLY apply chair penalty when ankleWidth / bodyScale < 1.10 AND hipToKneeRatio < 0.30
      // (narrow tucked ankles under a chair with horizontal thighs).
      if (
        resolvedMode === 'full-body' &&
        ankleWidth / bodyScale < 1.10 &&
        hipToKneeRatio < 0.30
      ) {
        const chairPenalty =
          smoothstep(0.75, 1.10, ankleWidth / bodyScale) *
          smoothstep(0.12, 0.30, hipToKneeRatio);
        squatDepth *= chairPenalty * 0.2;
        stanceWidth *= chairPenalty * 0.2;
      }
    }

    // -------------------------------------------------------------------------
    // 3. Combine scores based on Full-Body vs Upper-Body mode
    // -------------------------------------------------------------------------
    let rawConfidence = 0;
    if (resolvedMode === 'full-body') {
      const lowerScore = stanceWidth * 0.45 + squatDepth * 0.55;
      const upperScore = armEval.combinedArm;
      // Weighted geometric-blended score: requires BOTH stance AND martial arms
      // so casually waving while standing straight will NOT false-trigger.
      const weighted = lowerScore * 0.46 + upperScore * 0.54;
      const gate = Math.sqrt(clamp01(lowerScore + 0.08) * clamp01(upperScore + 0.08));
      rawConfidence = clamp01(weighted * 0.65 + gate * 0.35);
    } else {
      // Desk / Upper-Body mode: require both wrists visible so hidden hands below desk don't false-trigger
      const wristsVisible = isVisible(lWr, 0.35) && isVisible(rWr, 0.35);
      const elbowsSpread = Math.abs(lEl.x - rEl.x) / bodyScale;
      const readinessBonus = smoothstep(1.05, 1.55, elbowsSpread);
      rawConfidence = wristsVisible
        ? clamp01(
            armEval.leadArmGuard * 0.34 +
              armEval.rearArmChamber * 0.30 +
              armEval.armAsymmetry * 0.26 +
              readinessBonus * 0.10,
          )
        : 0;
      stanceWidth = readinessBonus;
      squatDepth = armEval.armAsymmetry;
    }

    // Compute velocity per anatomical wrist (immune to left-lead <-> right-lead stance flips)
    let wristSpeed = 0;
    const currLeft: Vec2 = { x: lWr.x, y: lWr.y };
    const currRight: Vec2 = { x: rWr.x, y: rWr.y };
    if (this.prevLeftWrist && this.prevRightWrist) {
      const vLeft = dist2D(currLeft, this.prevLeftWrist) / dtSec;
      const vRight = dist2D(currRight, this.prevRightWrist) / dtSec;
      wristSpeed = Math.max(vLeft, vRight);
    }
    this.prevLeftWrist = currLeft;
    this.prevRightWrist = currRight;

    // Advance hysteresis state machine
    this.stepStateMachine(rawConfidence, dtSec);
    this.lastRawConfidence = rawConfidence;

    return {
      hasPerson: true,
      resolvedMode,
      stanceSide,
      subScores: {
        stanceWidth,
        squatDepth,
        leadArmGuard: armEval.leadArmGuard,
        rearArmChamber: armEval.rearArmChamber,
        armAsymmetry: armEval.armAsymmetry,
      },
      rawConfidence,
      state: this.state,
      chargeProgress: this.computeChargeProgress(),
      effectIntensity: this.effectIntensity,
      activeDurationSec: this.activeElapsedSec,
      floorAnchor: this.computeFloorAnchor(landmarks2D, resolvedMode, torsoHeight, dtSec),
      bodyCenter: this.computeBodyCenter(landmarks2D),
      bodyScale,
      leadWrist,
      rearWrist,
      wristSpeed,
    };
  }

  private stepStateMachine(confidence: number, dtSec: number): void {
    switch (this.state) {
      case 'IDLE': {
        this.activeElapsedSec = 0;
        this.effectIntensity = Math.max(0, this.effectIntensity - dtSec * this.DISSIPATE_RATE);
        if (confidence >= this.ENTRY_THRESHOLD) {
          this.state = 'CHARGING';
          this.chargeElapsedSec = dtSec;
        }
        break;
      }
      case 'CHARGING': {
        if (confidence >= this.ENTRY_THRESHOLD * 0.9) {
          this.chargeElapsedSec += dtSec;
          this.effectIntensity = Math.max(
            this.effectIntensity,
            0.22 * (this.chargeElapsedSec / this.CHARGE_DURATION_SEC),
          );
          if (this.chargeElapsedSec >= this.CHARGE_DURATION_SEC) {
            this.state = 'ACTIVE';
            this.activeElapsedSec = 0;
            this.releaseElapsedSec = 0;
          }
        } else {
          this.chargeElapsedSec = Math.max(0, this.chargeElapsedSec - dtSec * 2.5);
          this.effectIntensity = Math.max(0, this.effectIntensity - dtSec * 2.0);
          if (this.chargeElapsedSec <= 0) {
            this.state = 'IDLE';
          }
        }
        break;
      }
      case 'ACTIVE': {
        this.activeElapsedSec += dtSec;
        this.effectIntensity = Math.min(1, this.effectIntensity + dtSec * 4.2);
        if (confidence >= this.SUSTAIN_THRESHOLD) {
          this.releaseElapsedSec = 0;
        } else {
          this.releaseElapsedSec += dtSec;
          if (this.releaseElapsedSec >= this.RELEASE_GRACE_SEC) {
            this.state = 'DISSIPATING';
          }
        }
        break;
      }
      case 'DISSIPATING': {
        if (confidence >= this.ENTRY_THRESHOLD) {
          this.state = 'ACTIVE';
          this.releaseElapsedSec = 0;
          break;
        }
        this.effectIntensity = Math.max(0, this.effectIntensity - dtSec * this.DISSIPATE_RATE);
        if (this.effectIntensity <= 0.005) {
          this.effectIntensity = 0;
          this.activeElapsedSec = 0;
          this.chargeElapsedSec = 0;
          this.state = 'IDLE';
        }
        break;
      }
    }
  }

  private computeChargeProgress(): number {
    if (this.state === 'ACTIVE') return 1;
    if (this.state === 'CHARGING') return clamp01(this.chargeElapsedSec / this.CHARGE_DURATION_SEC);
    if (this.state === 'DISSIPATING') return this.effectIntensity;
    return 0;
  }

  private computeFloorAnchor(
    lm: Landmark3D[],
    resolvedMode: ResolvedMode,
    torsoHeight: number,
    dtSec: number,
  ): Vec2 {
    const lAnk = lm[POSE_IDX.LEFT_ANKLE];
    const rAnk = lm[POSE_IDX.RIGHT_ANKLE];
    const lHeel = lm[POSE_IDX.LEFT_HEEL];
    const rHeel = lm[POSE_IDX.RIGHT_HEEL];
    const lKnee = lm[POSE_IDX.LEFT_KNEE];
    const rKnee = lm[POSE_IDX.RIGHT_KNEE];
    const lHip = lm[POSE_IDX.LEFT_HIP];
    const rHip = lm[POSE_IDX.RIGHT_HIP];

    const anklesVisible = isVisible(lAnk, 0.30) && isVisible(rAnk, 0.30);
    const kneesVisible = isVisible(lKnee, 0.35) && isVisible(rKnee, 0.35);

    let targetX = (lHip.x + rHip.x) * 0.5;
    let targetY = 0.88;

    if (resolvedMode === 'full-body') {
      if (anklesVisible) {
        const footY =
          isVisible(lHeel, 0.25) && isVisible(rHeel, 0.25)
            ? Math.max((lAnk.y + rAnk.y) * 0.5, (lHeel.y + rHeel.y) * 0.5)
            : (lAnk.y + rAnk.y) * 0.5;
        targetX = (lAnk.x + rAnk.x) * 0.5;
        targetY = Math.min(0.97, footY + 0.015);
      } else if (kneesVisible) {
        const kneeMidY = (lKnee.y + rKnee.y) * 0.5;
        targetX = (lKnee.x + rKnee.x) * 0.5;
        targetY = clamp(kneeMidY + clamp(torsoHeight * 0.72, 0.10, 0.24), 0.58, 0.97);
      }
    }

    // Smoothly damp floorAnchor internally so it never jumps on single-frame ankle visibility drops
    if (!this.prevFloorAnchor) {
      this.prevFloorAnchor = { x: targetX, y: targetY };
    } else {
      const blend = 1 - Math.exp(-dtSec * 14);
      this.prevFloorAnchor.x += (targetX - this.prevFloorAnchor.x) * blend;
      this.prevFloorAnchor.y += (targetY - this.prevFloorAnchor.y) * blend;
    }

    return { x: this.prevFloorAnchor.x, y: this.prevFloorAnchor.y };
  }

  private computeBodyCenter(lm: Landmark3D[]): Vec2 {
    const lSh = lm[POSE_IDX.LEFT_SHOULDER];
    const rSh = lm[POSE_IDX.RIGHT_SHOULDER];
    const lHip = lm[POSE_IDX.LEFT_HIP];
    const rHip = lm[POSE_IDX.RIGHT_HIP];
    return {
      x: (lSh.x + rSh.x + lHip.x + rHip.x) * 0.25,
      y: (lSh.y + rSh.y + lHip.y + rHip.y) * 0.25,
    };
  }

  private computeBodyScale(lm: Landmark3D[]): number {
    const lSh = lm[POSE_IDX.LEFT_SHOULDER];
    const rSh = lm[POSE_IDX.RIGHT_SHOULDER];
    const lHip = lm[POSE_IDX.LEFT_HIP];
    const rHip = lm[POSE_IDX.RIGHT_HIP];
    const shW = Math.abs(lSh.x - rSh.x);
    const torsoH = Math.abs((lHip.y + rHip.y) * 0.5 - (lSh.y + rSh.y) * 0.5);
    return Math.max(0.06, Math.max(shW, torsoH * 0.46));
  }
}
