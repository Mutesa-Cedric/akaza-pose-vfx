import type { Landmark3D } from './oneEuroFilter';
import { POSE_IDX } from './poseLandmarker';

export type DetectionMode = 'auto' | 'full-body' | 'upper-body';

export type ResolvedMode = 'full-body' | 'upper-body';

export type PoseState = 'IDLE' | 'CHARGING' | 'ACTIVE' | 'DISSIPATING';

export type StanceSide = 'left-lead' | 'right-lead';

export type TriggerMode = 'hold' | 'burst';

export type StrictnessPreset = 'relaxed' | 'balanced' | 'strict';

export const STRICTNESS_THRESHOLDS: Record<StrictnessPreset, number> = {
  relaxed: 0.58,
  balanced: 0.68,
  strict: 0.78,
};

export interface PoseTrackerConfig {
  /** Minimum confidence in [0.55, 0.88] required to begin charging. Default 0.74 (Balanced). */
  entryThreshold: number;
  /** 'hold' releases when the stance breaks; 'burst' holds ACTIVE for burstDurationSec once locked. */
  triggerMode: TriggerMode;
  /** Minimum active burst duration in seconds when triggerMode === 'burst'. Default 4.8s. */
  burstDurationSec: number;
}

export const DEFAULT_TRACKER_CONFIG: PoseTrackerConfig = {
  entryThreshold: STRICTNESS_THRESHOLDS.balanced,
  triggerMode: 'hold',
  burstDurationSec: 4.8,
};

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

function isInFrame(lm: Landmark3D | undefined, threshold = 0.42): boolean {
  return Boolean(
    lm &&
      (lm.visibility ?? 1) >= threshold &&
      lm.x >= 0.01 &&
      lm.x <= 0.99 &&
      lm.y >= 0.02 &&
      lm.y <= 0.97,
  );
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
  private burstRemainingSec = 0;

  // Tuned temporal & hysteresis defaults; entryThreshold & triggerMode are live-configurable.
  private entryThreshold = DEFAULT_TRACKER_CONFIG.entryThreshold;
  private triggerMode: TriggerMode = DEFAULT_TRACKER_CONFIG.triggerMode;
  private burstDurationSec = DEFAULT_TRACKER_CONFIG.burstDurationSec;
  private readonly CHARGE_DURATION_SEC = 0.24;
  private readonly MIN_ACTIVE_HOLD_SEC = 1.25;
  private readonly RELEASE_GRACE_SEC = 0.55;
  private readonly DISSIPATE_RATE = 2.2; // fades out smoothly in ~0.45s
  private readonly SWITCH_MARGIN = 0.14;

  setConfig(config: Partial<PoseTrackerConfig>): void {
    if (config.entryThreshold !== undefined) {
      this.entryThreshold = clamp(config.entryThreshold, 0.50, 0.86);
    }
    if (config.triggerMode !== undefined) {
      this.triggerMode = config.triggerMode;
      if (this.triggerMode === 'hold') {
        this.burstRemainingSec = 0;
      }
    }
    if (config.burstDurationSec !== undefined) {
      this.burstDurationSec = clamp(config.burstDurationSec, 2.0, 10.0);
    }
  }

  getEntryThreshold(): number {
    return this.entryThreshold;
  }

  reset(): void {
    this.state = 'IDLE';
    this.chargeElapsedSec = 0;
    this.activeElapsedSec = 0;
    this.releaseElapsedSec = 0;
    this.burstRemainingSec = 0;
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
    const lMouth = landmarks2D[POSE_IDX.MOUTH_LEFT];
    const rMouth = landmarks2D[POSE_IDX.MOUTH_RIGHT];

    const w = worldLandmarks3D && worldLandmarks3D.length >= 29 ? worldLandmarks3D : null;

    let uSpine: { x: number; y: number; z: number } | null = null;
    let uLat: { x: number; y: number; z: number } | null = null;
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
      const vLat = {
        x: wRSh.x - wLSh.x,
        y: wRSh.y - wLSh.y,
        z: wRSh.z - wLSh.z,
      };
      const latLen = Math.hypot(vLat.x, vLat.y, vLat.z);
      if (latLen > 1e-4) {
        uLat = {
          x: vLat.x / latLen,
          y: vLat.y / latLen,
          z: vLat.z / latLen,
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

      // Face-proximity guard: reject mugs, phones, glasses, chin/neck touching
      let minDistFace = dist2D(leadWr, nose);
      if (lEar && (lEar.visibility ?? 1) >= 0.25) {
        minDistFace = Math.min(minDistFace, dist2D(leadWr, lEar));
      }
      if (rEar && (rEar.visibility ?? 1) >= 0.25) {
        minDistFace = Math.min(minDistFace, dist2D(leadWr, rEar));
      }
      if (lMouth && (lMouth.visibility ?? 1) >= 0.25) {
        minDistFace = Math.min(minDistFace, dist2D(leadWr, lMouth));
      }
      if (rMouth && (rMouth.visibility ?? 1) >= 0.25) {
        minDistFace = Math.min(minDistFace, dist2D(leadWr, rMouth));
      }
      const faceRatio = minDistFace / bodyScale;
      const faceGuardPenalty = smoothstep(0.24, 0.42, faceRatio);

      // Lead fist raised clearly at upper-chest / shoulder / cheek guard height (0.62..1.42)
      const leadHeightScore =
        smoothstep(0.54, 0.82, leadHeight) * (1 - smoothstep(1.42, 1.80, leadHeight));

      // Lead arm MUST extend outward (2D reach) OR forward toward camera (3D z reach)
      // AND keep a martial elbow angle (multiplicative — prevents tucked-arm false positives).
      const leadReach2D = dist2D(leadSh, leadWr) / torsoHeight;
      const leadForward3D =
        wLeadSh && wLeadWr && torsoLen3D > 1e-4
          ? Math.max(0, (wLeadSh.z - wLeadWr.z) / torsoLen3D)
          : 0;
      const leadReachScore = Math.max(
        smoothstep(0.32, 0.60, leadReach2D),
        smoothstep(0.24, 0.50, leadForward3D),
      );
      const leadElbowAngle =
        wLeadSh && wLeadEl && wLeadWr
          ? angle3D(wLeadSh, wLeadEl, wLeadWr)
          : angle3D(leadSh, leadEl, leadWr);
      const leadElbowScore =
        smoothstep(38, 72, leadElbowAngle) * (1 - smoothstep(168, 179, leadElbowAngle));
      const leadStructure = leadReachScore * leadElbowScore;

      // Reject lead wrist crossed deeply across the opposite side of the chest (arms crossed)
      const leadSideSign = Math.sign(leadSh.x - shMid.x) || 1;
      const leadSideOffset = ((leadWr.x - shMid.x) * leadSideSign) / shoulderWidth;
      const leadMidlineGuard = smoothstep(-0.36, -0.04, leadSideOffset);

      const leadArmGuard = clamp01(
        leadHeightScore * (0.35 + 0.65 * leadStructure) * leadMidlineGuard * faceGuardPenalty,
      );

      // Rear fist chambered low near hip/waist/lower ribs (-0.15..0.52)
      const rearHeightScore =
        smoothstep(-0.22, 0.08, rearHeight) * (1 - smoothstep(0.46, 0.72, rearHeight));

      // Rear elbow MUST be actively flexed (rejects hanging limp arms >= 165 deg while tolerating
      // real BlazePose 140..150 deg readings during natural Soryu chambering).
      const rearElbowAngle =
        wRearSh && wRearEl && wRearWr
          ? angle3D(wRearSh, wRearEl, wRearWr)
          : angle3D(rearSh, rearEl, rearWr);
      const rearChamberBend =
        smoothstep(30, 58, rearElbowAngle) * (1 - smoothstep(146, 168, rearElbowAngle));

      // Gentle elbow retraction check (BlazePose monocular z is noisy on wrists/elbows, so avoid
      // hard z cutoffs that false-reject genuine real-webcam stances).
      let rearRetractGuard = 1;
      if (wRearWr && wRearEl && torsoLen3D > 1e-4) {
        const elbowBack3D = (wRearEl.z - wRearWr.z) / torsoLen3D;
        rearRetractGuard = smoothstep(-0.36, -0.02, elbowBack3D);
      }

      // Reject rear hand crossed over onto the opposite side of the torso
      const rearSideSign = Math.sign(rearSh.x - shMid.x) || -1;
      const rearSideOffset = ((rearWr.x - shMid.x) * rearSideSign) / shoulderWidth;
      const rearMidlineGuard = smoothstep(-0.18, 0.12, rearSideOffset);

      const rearArmChamber = clamp01(
        rearHeightScore *
          (0.30 + 0.70 * rearChamberBend) *
          rearRetractGuard *
          rearMidlineGuard,
      );

      // Strong vertical separation between high lead guard and low rear chamber
      const verticalDiff = leadHeight - rearHeight;
      const armAsymmetry = smoothstep(0.36, 0.68, verticalDiff);

      // Geometric-heavy arm fusion: missing any of the 3 pillars sharply drops combinedArm
      const armLinear = leadArmGuard * 0.38 + rearArmChamber * 0.32 + armAsymmetry * 0.30;
      const armGeo = Math.cbrt(leadArmGuard * rearArmChamber * armAsymmetry);
      const combinedArm = clamp01(armLinear * 0.38 + armGeo * 0.62);

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
    // 2. Evaluate LOWER-BODY SORYU STANCE (Wide horse stance + both-knee crouch)
    // -------------------------------------------------------------------------
    let stanceWidth = 0;
    let squatDepth = 0;

    if (lowerBodyVisible) {
      const kneeWidth = Math.abs(lKnee.x - rKnee.x);
      const ankleWidth = anklesVisible ? Math.abs(lAnk.x - rAnk.x) : kneeWidth;
      // Standing ratio ~1.0, Akaza wide horse stance ~1.7..2.2
      const widthRatio2D = Math.max(kneeWidth, ankleWidth) / bodyScale;

      // 3D Yaw-Invariant LATERAL Stance Width:
      // Project knee/ankle separation onto the body's lateral shoulder axis uLat so
      // 30-45 deg yaw horse stances stay wide while front-to-back walking strides stay narrow.
      let widthRatio = widthRatio2D;
      if (w && uLat) {
        const wLKnee = w[POSE_IDX.LEFT_KNEE];
        const wRKnee = w[POSE_IDX.RIGHT_KNEE];
        const wLAnk = w[POSE_IDX.LEFT_ANKLE];
        const wRAnk = w[POSE_IDX.RIGHT_ANKLE];
        const wLSh = w[POSE_IDX.LEFT_SHOULDER];
        const wRSh = w[POSE_IDX.RIGHT_SHOULDER];
        const kneeLat3D = Math.abs(
          (wRKnee.x - wLKnee.x) * uLat.x +
            (wRKnee.y - wLKnee.y) * uLat.y +
            (wRKnee.z - wLKnee.z) * uLat.z,
        );
        const footLat3D = Math.abs(
          (wRAnk.x - wLAnk.x) * uLat.x +
            (wRAnk.y - wLAnk.y) * uLat.y +
            (wRAnk.z - wLAnk.z) * uLat.z,
        );
        const sep3D = anklesVisible ? Math.max(kneeLat3D, footLat3D) : kneeLat3D;
        const shoulderWidth3D = Math.max(
          dist3D(wLSh, wRSh),
          dist3D(wShMid, wHipMid) * 0.55,
        );
        const widthRatio3D = sep3D / Math.max(1e-4, shoulderWidth3D);
        widthRatio = Math.max(widthRatio2D, widthRatio3D);
      }
      stanceWidth = smoothstep(1.18, 1.68, widthRatio);

      // 2D hip-to-knee drop: standing ~0.64, crouched ~0.12..0.42
      const kneeMidY = (lKnee.y + rKnee.y) * 0.5;
      const hipToKneeRatio = (kneeMidY - hipMid.y) / torsoHeight;
      const squat2D = 1 - smoothstep(0.24, 0.56, hipToKneeRatio);

      // 3D BOTH-knees flexion angle: require both legs bent (prevents single-knee weight shift cheat)
      let squat3D = squat2D;
      let bothBentGate = 1;
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
        const maxKneeAngle = Math.max(lKneeAngle, rKneeAngle);
        const avgKneeAngle = (lKneeAngle + rKneeAngle) * 0.5;
        bothBentGate = 1 - smoothstep(158, 174, maxKneeAngle);
        squat3D =
          (1 - smoothstep(118, 156, avgKneeAngle)) *
          (1 - smoothstep(144, 170, maxKneeAngle));
      }

      squatDepth = clamp01(Math.max(squat2D * bothBentGate, squat3D * 0.96));

      // Seated chair guard: penalize narrow tucked ankles under a chair with horizontal thighs
      if (
        resolvedMode === 'full-body' &&
        ankleWidth / bodyScale < 1.15 &&
        hipToKneeRatio < 0.34
      ) {
        const chairPenalty =
          smoothstep(0.80, 1.15, ankleWidth / bodyScale) *
          smoothstep(0.14, 0.34, hipToKneeRatio);
        squatDepth *= chairPenalty * 0.15;
        stanceWidth *= chairPenalty * 0.15;
      }
    }

    // -------------------------------------------------------------------------
    // 3. Combine scores with strict multiplicative gating
    // -------------------------------------------------------------------------
    let rawConfidence = 0;
    if (resolvedMode === 'full-body') {
      const lowerLinear = stanceWidth * 0.45 + squatDepth * 0.55;
      const lowerGeo = Math.sqrt(stanceWidth * squatDepth);
      const lowerScore = clamp01(lowerLinear * 0.42 + lowerGeo * 0.58);
      const upperScore = armEval.combinedArm;

      // Strict geometric-weighted fusion: standing straight OR relaxed arms CANNOT trigger
      const weighted = lowerScore * 0.50 + upperScore * 0.50;
      const gate = Math.sqrt(lowerScore * upperScore);
      rawConfidence = clamp01(weighted * 0.30 + gate * 0.70);
    } else {
      // Desk / Upper-Body mode: require both wrists & elbows in frame, without forcing hips inside
      // laptop webcam bounds (hips naturally sit below the bottom edge when seated at a desk).
      const upperClean =
        isInFrame(lWr, 0.42) &&
        isInFrame(rWr, 0.42) &&
        isInFrame(lEl, 0.42) &&
        isInFrame(rEl, 0.42);
      const elbowsSpread = Math.abs(lEl.x - rEl.x) / bodyScale;
      const readinessBonus = smoothstep(1.12, 1.56, elbowsSpread);
      rawConfidence = upperClean
        ? clamp01(armEval.combinedArm * (0.80 + 0.20 * readinessBonus) * 0.94)
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
    const entry = this.entryThreshold;
    // Forgiving charge & sustain floors prevent mid-hook aborts from brief MediaPipe jitter.
    const chargeHold = entry * 0.78;
    const sustain = clamp(entry - 0.24, 0.36, 0.65);

    switch (this.state) {
      case 'IDLE': {
        this.activeElapsedSec = 0;
        this.burstRemainingSec = 0;
        this.effectIntensity = Math.max(0, this.effectIntensity - dtSec * this.DISSIPATE_RATE);
        if (confidence >= entry) {
          this.state = 'CHARGING';
          this.chargeElapsedSec = dtSec;
        }
        break;
      }
      case 'CHARGING': {
        if (confidence >= chargeHold) {
          this.chargeElapsedSec += dtSec;
          this.effectIntensity = Math.max(
            this.effectIntensity,
            0.22 * (this.chargeElapsedSec / this.CHARGE_DURATION_SEC),
          );
          if (this.chargeElapsedSec >= this.CHARGE_DURATION_SEC) {
            this.state = 'ACTIVE';
            this.activeElapsedSec = 0;
            this.releaseElapsedSec = 0;
            this.burstRemainingSec =
              this.triggerMode === 'burst' ? this.burstDurationSec : this.MIN_ACTIVE_HOLD_SEC;
          }
        } else {
          this.chargeElapsedSec = Math.max(0, this.chargeElapsedSec - dtSec * 0.85);
          this.effectIntensity = Math.max(0, this.effectIntensity - dtSec * 1.4);
          if (this.chargeElapsedSec <= 0) {
            this.state = 'IDLE';
          }
        }
        break;
      }
      case 'ACTIVE': {
        this.activeElapsedSec += dtSec;
        this.effectIntensity = Math.min(1, this.effectIntensity + dtSec * 4.2);
        if (this.burstRemainingSec > 0) {
          this.burstRemainingSec = Math.max(0, this.burstRemainingSec - dtSec);
        }
        if (confidence >= sustain || this.burstRemainingSec > 0) {
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
        if (confidence >= entry * 0.92) {
          this.state = 'ACTIVE';
          this.releaseElapsedSec = 0;
          this.burstRemainingSec =
            this.triggerMode === 'burst' ? this.burstDurationSec : this.MIN_ACTIVE_HOLD_SEC;
          break;
        }
        this.effectIntensity = Math.max(0, this.effectIntensity - dtSec * this.DISSIPATE_RATE);
        if (this.effectIntensity <= 0.005) {
          this.effectIntensity = 0;
          this.activeElapsedSec = 0;
          this.chargeElapsedSec = 0;
          this.burstRemainingSec = 0;
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
