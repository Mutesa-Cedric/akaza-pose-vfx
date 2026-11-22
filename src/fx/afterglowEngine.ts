import type { Landmark3D } from '../cv/oneEuroFilter';
import type { PoseEvaluation, PoseState, Vec2 } from '../cv/akazaPoseClassifier';
import { drawSnowflakeCompass } from './compassRenderer';
import type { AfterglowScene } from './afterglowCompositor';

export interface AfterglowFrameHooks {
  onCharge?: (progress: number) => void;
  onChargeEnd?: () => void;
  onActivate?: () => void;
  onEcho?: (index: number, pan: number) => void;
  onPunchBurst?: (pan: number, strength: number) => void;
  onStrike?: (startPan: number, endPan: number) => void;
  onDissipate?: () => void;
}

export interface AfterglowFxOptions {
  depthMatte: boolean;
  echoes: boolean;
  compass: boolean;
  strikes: boolean;
  intensityScale: number;
}

export const DEFAULT_FX_OPTIONS: AfterglowFxOptions = {
  depthMatte: true,
  echoes: true,
  compass: true,
  strikes: true,
  intensityScale: 1,
};

interface ChaoticNeedle {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  len: number;
  angle: number;
  age: number;
  life: number;
  thickness: number;
  palette: 'cyan' | 'silver' | 'violet' | 'crimson';
  isHero: boolean;
  behind: boolean;
}

interface PlasmaRing {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  age: number;
  life: number;
  lineWidth: number;
  tiltY: number;
  color: string;
  angle?: number;
  behind?: boolean;
}

interface KoyukiParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  age: number;
  life: number;
  twinklePhase: number;
  kind: 'firework' | 'ember' | 'glint';
  color: string;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const ECHO_ENTRANCES = [
  { slot: 1, start: 0.07, pan: -0.52 },
  { slot: 2, start: 0.17, pan: 0.52 },
  { slot: 0, start: 0.28, pan: -0.89 },
  { slot: 3, start: 0.39, pan: 0.89 },
];

/** O(1) swap-remove helper to avoid GC array shifting */
function swapRemove<T>(arr: T[], index: number): void {
  const last = arr.length - 1;
  if (index !== last) arr[index] = arr[last];
  arr.pop();
}

// ============================================================================
// PRE-BAKED OFFSCREEN SPRITES (Allocated ONCE, zero per-frame shadowBlur)
// ============================================================================

let needleSprite: HTMLCanvasElement | null = null;
let starGlintSprite: HTMLCanvasElement | null = null;
let WISP_SPRITE: HTMLCanvasElement | null = null;

/**
 * Pre-bakes a razor-sharp double-tapered supersonic blue-silver needle (256×32):
 *  - Pointed supersonic head tip at right
 *  - Narrow angled shoulder
 *  - Razor tail tapering to left
 *  - Pre-baked #00f0ff / #7c3aed outer glow + pure #ffffff core
 */
function getNeedleSprite(): HTMLCanvasElement | null {
  if (needleSprite) return needleSprite;
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const cy = 16;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // Bake outer supersonic glow once
  ctx.shadowColor = '#00f0ff';
  ctx.shadowBlur = 10;

  // Double-tapered diamond-needle hull
  // Tail: (8, cy), Shoulder: (212, cy - 6) & (212, cy + 6), Tip: (250, cy)
  const grad = ctx.createLinearGradient(8, 0, 250, 0);
  grad.addColorStop(0, 'rgba(124, 58, 237, 0)');
  grad.addColorStop(0.25, 'rgba(124, 58, 237, 0.7)');
  grad.addColorStop(0.65, 'rgba(0, 240, 255, 0.95)');
  grad.addColorStop(0.92, '#e0f2fe');
  grad.addColorStop(1, '#ffffff');

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(8, cy);
  ctx.lineTo(212, cy - 6);
  ctx.lineTo(250, cy);
  ctx.lineTo(212, cy + 6);
  ctx.closePath();
  ctx.fill();

  // Razor #ffffff core spine
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(18, cy);
  ctx.lineTo(248, cy);
  ctx.stroke();

  ctx.restore();
  needleSprite = canvas;
  return needleSprite;
}

/**
 * Pre-bakes a crisp faceted 4-point beveled diamond crystal glint (96×96):
 *  - 4 razor diamond points with beveled facets (#38bdf8 / #e0f2fe)
 *  - 45° secondary micro-points
 *  - Pure #ffffff center
 */
function getStarGlintSprite(): HTMLCanvasElement | null {
  if (starGlintSprite) return starGlintSprite;
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const cx = 48;
  const cy = 48;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // Baked outer glow
  ctx.shadowColor = 'rgba(56, 189, 248, 0.95)';
  ctx.shadowBlur = 14;

  // Primary 4 diamond points (R = 42)
  const rMajor = 42;
  const wHalf = 3.6;

  // Left facet (#0ea5e9)
  ctx.fillStyle = '#0ea5e9';
  ctx.beginPath();
  ctx.moveTo(cx, cy - rMajor);
  ctx.lineTo(cx - wHalf, cy);
  ctx.lineTo(cx, cy);
  ctx.moveTo(cx, cy + rMajor);
  ctx.lineTo(cx + wHalf, cy);
  ctx.lineTo(cx, cy);
  ctx.moveTo(cx - rMajor, cy);
  ctx.lineTo(cx, cy + wHalf);
  ctx.lineTo(cx, cy);
  ctx.moveTo(cx + rMajor, cy);
  ctx.lineTo(cx, cy - wHalf);
  ctx.lineTo(cx, cy);
  ctx.fill();

  // Right facet (#e0f2fe)
  ctx.fillStyle = '#e0f2fe';
  ctx.beginPath();
  ctx.moveTo(cx, cy - rMajor);
  ctx.lineTo(cx + wHalf, cy);
  ctx.lineTo(cx, cy);
  ctx.moveTo(cx, cy + rMajor);
  ctx.lineTo(cx - wHalf, cy);
  ctx.lineTo(cx, cy);
  ctx.moveTo(cx - rMajor, cy);
  ctx.lineTo(cx, cy - wHalf);
  ctx.lineTo(cx, cy);
  ctx.moveTo(cx + rMajor, cy);
  ctx.lineTo(cx, cy + wHalf);
  ctx.lineTo(cx, cy);
  ctx.fill();

  // Diagonal micro-points (R = 18)
  const rDiag = 18;
  ctx.fillStyle = 'rgba(224, 242, 254, 0.85)';
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * rDiag, cy + Math.sin(a) * rDiag);
    ctx.lineTo(cx + Math.cos(a + 0.15) * 4, cy + Math.sin(a + 0.15) * 4);
    ctx.fill();
  }

  // Pure white diamond core
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(cx, cy - 6);
  ctx.lineTo(cx + 6, cy);
  ctx.lineTo(cx, cy + 6);
  ctx.lineTo(cx - 6, cy);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
  starGlintSprite = canvas;
  return starGlintSprite;
}

/**
 * Pre-bakes a single vertical volumetric aura wisp sprite (48×256):
 *  - Deep indigo base #1d4ed8 at bottom
 *  - Ice cyan #38bdf8 in lower-mid
 *  - Pale silver #e0f2fe in upper-mid
 *  - 0% alpha feather at top & outer edges
 * Pre-baked once at module init to eliminate 14×/frame createLinearGradient.
 */
function getWispSprite(): HTMLCanvasElement | null {
  if (WISP_SPRITE) return WISP_SPRITE;
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = 48;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const h = 256;
  const cx = 24;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // Vertical volumetric wisp gradient:
  // Deep indigo base #1d4ed8 -> ice cyan #38bdf8 -> pale silver #e0f2fe -> 0% alpha feather at top & edges
  const vertGrad = ctx.createLinearGradient(0, h, 0, 0);
  vertGrad.addColorStop(0, 'rgba(29, 78, 216, 0)');
  vertGrad.addColorStop(0.12, 'rgba(29, 78, 216, 0.75)');
  vertGrad.addColorStop(0.48, 'rgba(56, 189, 248, 0.85)');
  vertGrad.addColorStop(0.82, 'rgba(224, 242, 254, 0.95)');
  vertGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

  // Volumetric wisp hull with horizontal feathering
  ctx.fillStyle = vertGrad;
  ctx.beginPath();
  ctx.moveTo(cx - 16, h);
  ctx.bezierCurveTo(cx - 20, h * 0.65, cx - 10, h * 0.25, cx, 0);
  ctx.bezierCurveTo(cx + 10, h * 0.25, cx + 20, h * 0.65, cx + 16, h);
  ctx.closePath();
  ctx.fill();

  // Core bright filament
  const coreGrad = ctx.createLinearGradient(0, h, 0, 0);
  coreGrad.addColorStop(0, 'rgba(56, 189, 248, 0)');
  coreGrad.addColorStop(0.3, 'rgba(56, 189, 248, 0.7)');
  coreGrad.addColorStop(0.75, 'rgba(224, 242, 254, 0.95)');
  coreGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

  ctx.strokeStyle = coreGrad;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(cx, h);
  ctx.bezierCurveTo(cx - 2, h * 0.6, cx + 2, h * 0.3, cx, 2);
  ctx.stroke();

  ctx.restore();
  WISP_SPRITE = canvas;
  return WISP_SPRITE;
}

// Module init pre-bake
if (typeof document !== 'undefined') {
  getNeedleSprite();
  getStarGlintSprite();
  getWispSprite();
}

/**
 * ufotable-inspired Anime VFX Compositor:
 * Akaza's Destructive Death – Final Form: Blue Silver Chaotic Afterglow
 * (破壊殺・終式 青銀乱残光)
 *
 * Back-to-front compositing order:
 *  1. 2-Frame Anime Impact Beat (cyan/crimson lateral rim split + micro camera shake)
 *  2. Midnight Indigo Domain Grade & Vignette
 *  3. 3D Floor Snowflake Compass (via drawSnowflakeCompass)
 *  4. Face-Safe Volumetric Aura Wisps (strictly clamped below collarbone)
 *  5. Fist Plasma Vortices (compact counter-rotating rings + micro-sparks + punch shockwaves)
 *  6. 100-Strike Razor-Needle Chaotic Barrage (pre-baked supersonic needles + 4-vertex hero paths)
 *  7. Koyuki Firework Starbursts (exponential drag deceleration + diamond glints)
 *  8. Peripheral Kinetic Speed Lines & Calligraphy Banner
 */
export class AfterglowFxEngine {
  private needles: ChaoticNeedle[] = [];
  private rings: PlasmaRing[] = [];
  private particles: KoyukiParticle[] = [];

  private prevState: PoseState = 'IDLE';
  private timeSec = 0;
  private shakeMagnitude = 0;
  private needleSpawnAcc = 0;
  private fireworkSpawnAcc = 0;
  private punchCooldown = 0;
  private strikeCooldown = 0;
  private echoTime = 0;
  private nextEchoCue = 0;

  // 2-Frame Anime Impact Beat state
  private impactBeatFrames = 0;
  private impactFlashAlpha = 0;
  readonly scene: AfterglowScene = {
    time: 0,
    intensity: 0,
    floor: { x: 0.5, y: 0.85 },
    center: { x: 0.5, y: 0.5 },
    compassRadius: 0,
    compassOpacity: 0,
    echoReveals: new Float32Array(ECHO_ENTRANCES.length),
    shockOrigin: { x: 0.5, y: 0.5 },
    shockAge: 1,
    shockStrength: 0,
  };

  // Smoothly interpolated anchors
  private smoothFloor: Vec2 = { x: 0.5, y: 0.85 };
  private smoothCenter: Vec2 = { x: 0.5, y: 0.5 };
  private smoothScale = 0.15;
  private anchorsInitialized = false;

  // Offscreen Calligraphy Sprite
  private bannerSprite: HTMLCanvasElement | null = null;
  private bannerBucket = 0;

  // Pre-allocated reusable vectors for zero per-frame hot-loop GC churn
  private shakeOffset: Vec2 = { x: 0, y: 0 };
  private floorPx: Vec2 = { x: 0, y: 0 };
  private centerPx: Vec2 = { x: 0, y: 0 };
  private leadWristPx: Vec2 = { x: 0, y: 0 };
  private rearWristPx: Vec2 = { x: 0, y: 0 };

  constructor() {
    if (typeof document !== 'undefined') {
      getNeedleSprite();
      getStarGlintSprite();
      getWispSprite();
      if (document.fonts) {
        void document.fonts.ready.then(() => {
          this.bannerSprite = null;
        });
      }
    }
  }

  reset(): void {
    this.needles.length = 0;
    this.rings.length = 0;
    this.particles.length = 0;
    this.prevState = 'IDLE';
    this.impactBeatFrames = 0;
    this.impactFlashAlpha = 0;
    this.shakeMagnitude = 0;
    this.anchorsInitialized = false;
    this.needleSpawnAcc = 0;
    this.fireworkSpawnAcc = 0;
    this.strikeCooldown = 0;
    this.punchCooldown = 0;
    this.resetEchoes();
    this.scene.shockAge = 1;
  }

  getShakeOffset(): Vec2 {
    if (this.shakeMagnitude <= 0.2) {
      this.shakeOffset.x = 0;
      this.shakeOffset.y = 0;
      return this.shakeOffset;
    }
    this.shakeOffset.x = (Math.random() - 0.5) * 2 * this.shakeMagnitude;
    this.shakeOffset.y = (Math.random() - 0.5) * 2 * this.shakeMagnitude;
    return this.shakeOffset;
  }

  render(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    dtSec: number,
    pose: PoseEvaluation,
    landmarks: Landmark3D[] | null,
    mirrored: boolean,
    hooks?: AfterglowFrameHooks,
    rear?: CanvasRenderingContext2D,
    hasMatte = false,
    options: AfterglowFxOptions = DEFAULT_FX_OPTIONS,
  ): void {
    const dt = Math.min(0.05, Math.max(0.001, dtSec));
    const intensityScale = Math.max(0.4, Math.min(1.4, options.intensityScale));
    const useEchoes = options.echoes && options.depthMatte && hasMatte;
    this.timeSec += dt;
    this.punchCooldown = Math.max(0, this.punchCooldown - dt);
    this.strikeCooldown = Math.max(0, this.strikeCooldown - dt);
    this.scene.shockAge = Math.min(1, this.scene.shockAge + dt / 0.56);

    const mapX = (nx: number) => (mirrored ? 1 - nx : nx) * width;
    const mapY = (ny: number) => ny * height;

    // Smooth anchor interpolation
    if (!this.anchorsInitialized) {
      this.smoothFloor.x = pose.floorAnchor.x;
      this.smoothFloor.y = pose.floorAnchor.y;
      this.smoothCenter.x = pose.bodyCenter.x;
      this.smoothCenter.y = pose.bodyCenter.y;
      this.smoothScale = pose.bodyScale;
      this.anchorsInitialized = true;
    } else if (pose.hasPerson) {
      const k = 1 - Math.exp(-dt * 14);
      this.smoothFloor.x = lerp(this.smoothFloor.x, pose.floorAnchor.x, k);
      this.smoothFloor.y = lerp(this.smoothFloor.y, pose.floorAnchor.y, k);
      this.smoothCenter.x = lerp(this.smoothCenter.x, pose.bodyCenter.x, k);
      this.smoothCenter.y = lerp(this.smoothCenter.y, pose.bodyCenter.y, k);
      this.smoothScale = lerp(this.smoothScale, pose.bodyScale, k);
    }

    this.floorPx.x = mapX(this.smoothFloor.x);
    this.floorPx.y = mapY(this.smoothFloor.y);
    this.centerPx.x = mapX(this.smoothCenter.x);
    this.centerPx.y = mapY(this.smoothCenter.y);
    this.leadWristPx.x = mapX(pose.leadWrist.x);
    this.leadWristPx.y = mapY(pose.leadWrist.y);
    this.rearWristPx.x = mapX(pose.rearWrist.x);
    this.rearWristPx.y = mapY(pose.rearWrist.y);

    const floorPx = this.floorPx;
    const centerPx = this.centerPx;
    const leadWristPx = this.leadWristPx;
    const rearWristPx = this.rearWristPx;
    const minDim = Math.min(width, height);

    // -------------------------------------------------------------------------
    // State Transitions & Triggers
    // -------------------------------------------------------------------------
    if (pose.state === 'CHARGING') {
      hooks?.onCharge?.(pose.chargeProgress);
    } else if (this.prevState === 'CHARGING') {
      hooks?.onChargeEnd?.();
    }
    if (this.prevState !== 'ACTIVE' && pose.state === 'ACTIVE') {
      this.resetEchoes();
      this.impactBeatFrames = options.strikes ? 2 : 0;
      this.impactFlashAlpha = 0.55 * intensityScale;
      this.shakeMagnitude = 7.5 * intensityScale;
      this.startShock(centerPx, width, height, Math.min(1.2, intensityScale));
      if (options.strikes) {
        this.spawnActivationBlast(centerPx, floorPx, minDim);
      }
      hooks?.onActivate?.();
    } else if (this.prevState === 'ACTIVE' && pose.state === 'DISSIPATING') {
      hooks?.onDissipate?.();
    }
    this.prevState = pose.state;

    // Reactive punch burst
    if (options.strikes && pose.state === 'ACTIVE' && pose.wristSpeed > 1.35 && this.punchCooldown <= 0) {
      this.punchCooldown = 0.24;
      this.impactBeatFrames = 1;
      this.shakeMagnitude = Math.max(this.shakeMagnitude, 4.5 * intensityScale);
      this.startShock(leadWristPx, width, height, 0.58 * intensityScale);
      this.spawnPunchShockwave(leadWristPx, centerPx, minDim);
      hooks?.onPunchBurst?.(2 * leadWristPx.x / width - 1, Math.min(1, pose.wristSpeed / 2.5));
    }

    // -------------------------------------------------------------------------
    // Continuous Spawning
    // -------------------------------------------------------------------------
    if (options.strikes && pose.state === 'CHARGING') {
      if (Math.random() < 0.8 * intensityScale) {
        const a = Math.random() * Math.PI * 2;
        const dist = minDim * (0.2 + Math.random() * 0.25);
        this.particles.push({
          x: centerPx.x + Math.cos(a) * dist,
          y: centerPx.y + Math.sin(a) * dist,
          vx: -Math.cos(a) * dist * 3.2,
          vy: -Math.sin(a) * dist * 3.2,
          size: 2.2 + Math.random() * 2.8,
          age: 0,
          life: 0.28,
          twinklePhase: Math.random() * Math.PI * 2,
          kind: 'glint',
          color: '#38bdf8',
        });
      }
    }

    if (pose.state === 'ACTIVE') {
      const escalation = Math.min(1, 0.45 + pose.activeDurationSec * 0.4);
      if (rear && useEchoes) {
        this.revealEchoes(dt, centerPx.x / width, hooks);
      } else {
        this.scene.echoReveals.fill(0);
      }

      if (options.strikes) {
        // Controlled Blue-Silver needle barrage (keeps compass & 4 silhouettes clearly legible)
        const ramp = rear ? Math.min(1, 0.25 + pose.activeDurationSec * 1.8) : 1;
        this.needleSpawnAcc += dt * (9 + escalation * 13) * ramp * intensityScale;
        while (this.needleSpawnAcc >= 1) {
          this.needleSpawnAcc -= 1;
          const strike = this.spawnChaoticNeedle(width, height, centerPx, minDim);
          if (strike.isHero && !strike.behind && this.strikeCooldown <= 0 && pose.activeDurationSec > 0.54) {
            this.strikeCooldown = 0.26;
            hooks?.onStrike?.(2 * strike.x0 / width - 1, 2 * strike.x1 / width - 1);
          }
        }

        // Restrained Koyuki frost starbursts
        this.fireworkSpawnAcc += dt * (0.55 + escalation * 0.65) * intensityScale;
        if (this.fireworkSpawnAcc >= 1) {
          this.fireworkSpawnAcc -= 1;
          const angle = Math.random() * Math.PI * 2;
          const dist = minDim * (0.28 + Math.random() * 0.24);
          const fx = Math.max(width * 0.08, Math.min(width * 0.92, centerPx.x + Math.cos(angle) * dist * 1.3));
          const fy = Math.max(height * 0.12, Math.min(height * 0.82, centerPx.y + Math.sin(angle) * dist * 0.85));
          this.spawnKoyukiStarburst(fx, fy, minDim * 0.20, Math.max(6, Math.round(11 * intensityScale)));
        }

        // Rising icy floor embers & wrist micro-sparks
        const emberCount = Math.max(1, Math.round(1.5 * intensityScale));
        for (let i = 0; i < emberCount; i++) {
          const fromFloor = i < Math.ceil(emberCount * 0.65);
          const angle = Math.random() * Math.PI * 2;
          const rSpread = minDim * (0.12 + Math.random() * 0.28);
          const sx = fromFloor
            ? floorPx.x + Math.cos(angle) * rSpread
            : (Math.random() < 0.5 ? leadWristPx.x : rearWristPx.x) + (Math.random() - 0.5) * 28;
          const sy = fromFloor
            ? floorPx.y + Math.sin(angle) * rSpread * 0.28
            : (Math.random() < 0.5 ? leadWristPx.y : rearWristPx.y) + (Math.random() - 0.5) * 28;

          this.particles.push({
            x: sx,
            y: sy,
            vx: (Math.random() - 0.5) * 40,
            vy: -(60 + Math.random() * 120),
            size: 2 + Math.random() * 3.5,
            age: 0,
            life: 0.65 + Math.random() * 0.65,
            twinklePhase: Math.random() * Math.PI * 2,
            kind: Math.random() < 0.45 ? 'glint' : 'ember',
            color: Math.random() < 0.5 ? '#f8fafc' : '#38bdf8',
          });
        }
      }
    } else if (!useEchoes) {
      this.scene.echoReveals.fill(0);
    }

    // Decay impact & shake
    this.impactFlashAlpha = Math.max(0, this.impactFlashAlpha - dt * 3.2);
    this.shakeMagnitude = Math.max(0, this.shakeMagnitude * Math.exp(-dt * 9.0));

    // Particle updates
    this.updateParticles(dt);

    // -------------------------------------------------------------------------
    // Back-to-front compositing
    // -------------------------------------------------------------------------
    ctx.clearRect(0, 0, width, height);
    rear?.clearRect(0, 0, width, height);
    const intensity = Math.min(1.25, pose.effectIntensity * intensityScale);
    this.scene.intensity = Math.min(1, intensity);

    if (
      intensity <= 0.005 &&
      this.needles.length === 0 &&
      this.rings.length === 0 &&
      this.particles.length === 0 &&
      this.impactBeatFrames === 0
    ) {
      return;
    }

    // Stack Layer 1: 2-Frame Anime Impact Beat (Rim split)
    if (options.strikes && this.impactBeatFrames > 0) {
      this.drawImpactBeat(ctx, width, height);
      this.impactBeatFrames--;
    }

    // Stack Layer 2: Midnight Indigo Domain Grade & Vignette
    if (!rear && intensity > 0.01) {
      this.drawDomainGrade(ctx, width, height, centerPx, Math.min(1, intensity));
    }

    // Stack Layer 3: 3D Floor Snowflake Compass (破壊殺・羅針)
    const compassRadius = Math.max(minDim * 0.24, Math.min(width * 0.38, this.smoothScale * width * 1.95));
    const unfold =
      pose.state === 'CHARGING'
        ? pose.chargeProgress * 0.45
        : pose.state === 'ACTIVE'
          ? Math.min(1, 0.35 + pose.activeDurationSec * 2.8)
          : pose.effectIntensity;

    const compassOpacity = options.compass
      ? Math.min(1.25, Math.max(intensity, pose.state === 'CHARGING' ? pose.chargeProgress * 0.42 * intensityScale : 0))
      : 0;
    if (rear) {
      const scene = this.scene;
      scene.time = this.timeSec;
      scene.center.x = centerPx.x / width;
      scene.center.y = centerPx.y / height;
      scene.floor.x = floorPx.x / width;
      scene.floor.y = floorPx.y / height;
      const open = pose.state === 'DISSIPATING' ? 1 : unfold;
      scene.compassRadius = compassRadius / minDim * (0.18 + open * 0.82);
      scene.compassOpacity = compassOpacity * (0.90 + 0.10 * Math.sin(this.timeSec * 5.2));
      if (options.strikes) {
        this.drawPlasmaRings(rear, true);
        this.drawChaoticNeedles(rear, true);
      }
    } else if (options.compass) {
      drawSnowflakeCompass({
        ctx,
        cx: floorPx.x,
        cy: floorPx.y,
        radius: compassRadius,
        unfold,
        intensity: Math.min(1, compassOpacity),
        timeSec: this.timeSec,
        activeTime: pose.activeDurationSec,
      });
    }

    // Stack Layer 4: Face-Safe Volumetric Aura Wisps (strictly below collarbone)
    if (!rear && options.strikes && intensity > 0.04 && pose.hasPerson) {
      this.drawFaceSafeAuraWisps(ctx, landmarks, centerPx, minDim, Math.min(1, intensity), mapY, mirrored, width);
    }

    // Stack Layer 5: Fist Plasma Vortices & Directional Shockwaves
    if (options.strikes && intensity > 0.05 && pose.hasPerson) {
      this.drawFistVortices(ctx, leadWristPx, rearWristPx, minDim, Math.min(1, intensity), pose.wristSpeed);
    }

    // Stack Layer 6: Plasma Rings & 100-Strike Razor-Needle Chaotic Barrage
    if (options.strikes) {
      this.drawPlasmaRings(ctx, rear ? false : undefined);
      this.drawChaoticNeedles(ctx, rear ? false : undefined);

      // Stack Layer 7: Koyuki Firework Starbursts & Embers
      this.drawKoyukiParticles(ctx);

      // Stack Layer 8: Peripheral Kinetic Speed Lines
      if (intensity > 0.22) {
        this.drawSpeedLines(ctx, width, height, centerPx, Math.min(1, intensity));
      }
    }

    // Subtle Flash Overlay on Beat
    if (!rear && options.strikes && this.impactFlashAlpha > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(240, 249, 255, ${Math.min(1, this.impactFlashAlpha) * 0.5})`;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }

    if (rear && landmarks) this.protectFace(ctx, width, height, landmarks, mirrored);

    // Calligraphy Banner ("破壊殺・終式 青銀亂殘光")
    const titleFade = rear ? Math.max(0, Math.min(1, (1.95 - pose.activeDurationSec) / 0.62)) : 1;
    if (intensity * titleFade > 0.08 && pose.state !== 'CHARGING') {
      this.drawCalligraphyBanner(ctx, width, height, Math.min(1, intensity) * titleFade, pose.activeDurationSec);
    }
  }

  private resetEchoes(): void {
    this.echoTime = 0;
    this.nextEchoCue = 0;
    this.scene.echoReveals.fill(0);
  }

  private revealEchoes(dt: number, centerX: number, hooks?: AfterglowFrameHooks): void {
    this.echoTime += dt;
    for (let i = 0; i < ECHO_ENTRANCES.length; i++) {
      const { slot, start, pan } = ECHO_ENTRANCES[i];
      const progress = Math.max(0, Math.min(1, (this.echoTime - start) / 0.18));
      const visible = 1 - (1 - progress) ** 3;
      this.scene.echoReveals[slot] = visible;
      if (this.nextEchoCue === i && visible >= 0.26) {
        this.nextEchoCue++;
        hooks?.onEcho?.(i, pan + (centerX - 0.5) * 0.46);
      }
    }
  }

  private startShock(origin: Vec2, width: number, height: number, strength: number): void {
    this.scene.shockOrigin.x = origin.x / width;
    this.scene.shockOrigin.y = origin.y / height;
    this.scene.shockAge = 0;
    this.scene.shockStrength = strength;
  }

  private protectFace(
    ctx: CanvasRenderingContext2D, width: number, height: number, landmarks: Landmark3D[], mirrored: boolean,
  ): void {
    const nose = landmarks[0];
    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];
    if (!nose || (nose.visibility ?? 1) < 0.4 || !leftShoulder || !rightShoulder) return;
    const shoulderWidth = Math.hypot(
      (leftShoulder.x - rightShoulder.x) * width,
      (leftShoulder.y - rightShoulder.y) * height,
    );
    const radius = Math.max(10, shoulderWidth * 0.37);
    ctx.save();
    ctx.translate((mirrored ? 1 - nose.x : nose.x) * width, nose.y * height - radius * 0.12);
    ctx.scale(1, 1.21);
    const fade = ctx.createRadialGradient(0, 0, radius * 0.53, 0, 0, radius);
    fade.addColorStop(0, '#fff');
    fade.addColorStop(1, '#fff0');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = fade;
    ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Layer 1: 2-Frame Anime Impact Beat (Pure Blue-Silver frost frame)
  // ---------------------------------------------------------------------------
  private drawImpactBeat(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const rimW = Math.max(3, Math.round(width * 0.005));
    ctx.fillStyle = 'rgba(56, 189, 248, 0.78)';
    ctx.fillRect(0, 0, rimW, height);
    ctx.fillRect(width - rimW, 0, rimW, height);

    ctx.fillStyle = 'rgba(224, 242, 254, 0.35)';
    ctx.fillRect(0, 0, width, Math.max(2, Math.round(height * 0.003)));
    ctx.fillRect(0, height - Math.max(2, Math.round(height * 0.003)), width, height);

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Layer 2: Midnight Indigo Domain Grade & Vignette
  // ---------------------------------------------------------------------------
  private drawDomainGrade(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    center: Vec2,
    intensity: number,
  ): void {
    ctx.save();
    // Midnight atmospheric base tint
    ctx.fillStyle = `rgba(6, 8, 24, ${0.44 * intensity})`;
    ctx.fillRect(0, 0, width, height);

    // Deep-violet vignette
    const vig = ctx.createRadialGradient(
      center.x,
      center.y,
      Math.min(width, height) * 0.16,
      center.x,
      center.y,
      Math.max(width, height) * 0.78,
    );
    vig.addColorStop(0, `rgba(56, 189, 248, ${0.05 * intensity})`);
    vig.addColorStop(0.5, `rgba(17, 14, 56, ${0.25 * intensity})`);
    vig.addColorStop(1, `rgba(6, 8, 24, ${0.68 * intensity})`);
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Layer 4: Face-Safe Volumetric Aura Wisps (Strictly clamped below collarbone)
  // ---------------------------------------------------------------------------
  private drawFaceSafeAuraWisps(
    ctx: CanvasRenderingContext2D,
    landmarks: Landmark3D[] | null,
    center: Vec2,
    minDim: number,
    intensity: number,
    mapY: (ny: number) => number,
    mirrored: boolean,
    width: number,
  ): void {
    // Strictly determine collarbone level (y >= collarY)
    let collarY = center.y - minDim * 0.14;
    let shoulderLeftX = center.x - minDim * 0.18;
    let shoulderRightX = center.x + minDim * 0.18;

    if (landmarks && landmarks.length >= 25) {
      const ls = landmarks[11]; // Left shoulder
      const rs = landmarks[12]; // Right shoulder
      if (ls && rs && (ls.visibility ?? 1) > 0.3 && (rs.visibility ?? 1) > 0.3) {
        // Safe collar level: 12px BELOW the lower shoulder joint
        collarY = Math.max(mapY(ls.y), mapY(rs.y)) + 12;
        shoulderLeftX = (mirrored ? 1 - ls.x : ls.x) * width;
        shoulderRightX = (mirrored ? 1 - rs.x : rs.x) * width;
      }
    }

    const sprite = getWispSprite();
    if (!sprite) return;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const wispCount = 14;
    const pulse = 0.85 + 0.15 * Math.sin(this.timeSec * 8);

    for (let i = 0; i < wispCount; i++) {
      const frac = i / (wispCount - 1);
      const isLeft = frac < 0.5;
      const tSide = isLeft ? frac * 2 : (frac - 0.5) * 2;
      const rootX = isLeft
        ? lerp(shoulderLeftX - minDim * 0.15, center.x - minDim * 0.05, tSide)
        : lerp(center.x + minDim * 0.05, shoulderRightX + minDim * 0.15, tSide);
      const rootY = center.y + minDim * (0.05 + Math.sin(i * 1.7) * 0.2);

      const wispH = minDim * (0.22 + Math.sin(i * 3.1 + this.timeSec * 6) * 0.08);
      const targetY = rootY - wispH;

      // Strictly clamp and fade wisps as they approach collarbone
      const clampedTargetY = Math.max(collarY + 8, targetY);
      if (rootY <= collarY + 6) continue;

      const actualH = rootY - clampedTargetY;
      if (actualH <= 1) continue;

      const sway = Math.sin(this.timeSec * 6.5 + i * 0.85) * minDim * 0.04;
      const angle = Math.atan2(sway, actualH);
      const wispW = Math.max(12, minDim * 0.045 * (1 - tSide * 0.25));

      ctx.save();
      ctx.translate(rootX, rootY);
      ctx.rotate(angle);
      ctx.globalAlpha = Math.min(1, intensity * pulse * 0.85);
      ctx.drawImage(sprite, -wispW * 0.5, -actualH, wispW, actualH);
      ctx.restore();
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Layer 5: Fist Plasma Vortices & Directional Shockwaves
  // ---------------------------------------------------------------------------
  private drawFistVortices(
    ctx: CanvasRenderingContext2D,
    leadWrist: Vec2,
    rearWrist: Vec2,
    minDim: number,
    intensity: number,
    wristSpeed: number,
  ): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glint = getStarGlintSprite();

    const drawVortex = (pos: Vec2, scale: number, isLead: boolean) => {
      const rInner = minDim * 0.038 * scale;
      const rOuter = minDim * 0.062 * scale;
      const rot1 = this.timeSec * 7.5;
      const rot2 = -this.timeSec * 9.2;

      // Inner counter-rotating plasma ring
      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.rotate(rot1);
      ctx.strokeStyle = `rgba(56, 189, 248, ${0.85 * intensity})`;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.ellipse(0, 0, rInner, rInner * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();

      // Core white ring
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.95 * intensity})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(0, 0, rInner * 0.85, rInner * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Outer plasma ring
      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.rotate(rot2);
      ctx.strokeStyle = `rgba(124, 58, 237, ${0.65 * intensity})`;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.ellipse(0, 0, rOuter, rOuter * 0.45, 0, 0, Math.PI * 2);
      ctx.stroke();

      // Orbiting pinpoint micro-sparks
      const sparkCount = 4;
      for (let s = 0; s < sparkCount; s++) {
        const sa = (s * Math.PI) / 2 + rot2;
        const sx = Math.cos(sa) * rOuter;
        const sy = Math.sin(sa) * rOuter * 0.45;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(sx, sy, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // Compact diamond glint at wrist center
      if (glint) {
        const glintSize = minDim * 0.075 * scale;
        ctx.drawImage(glint, pos.x - glintSize * 0.5, pos.y - glintSize * 0.5, glintSize, glintSize);
      }

      // Conical punch shockwave when moving fast
      if (isLead && wristSpeed > 1.35) {
        ctx.save();
        ctx.translate(pos.x, pos.y);
        const coneGrad = ctx.createRadialGradient(0, 0, 5, 0, 0, minDim * 0.18);
        coneGrad.addColorStop(0, `rgba(255, 255, 255, ${0.85 * intensity})`);
        coneGrad.addColorStop(0.3, `rgba(56, 189, 248, ${0.55 * intensity})`);
        coneGrad.addColorStop(1, 'rgba(56, 189, 248, 0)');
        ctx.fillStyle = coneGrad;
        ctx.beginPath();
        ctx.arc(0, 0, minDim * 0.18, -Math.PI * 0.35, Math.PI * 0.35);
        ctx.lineTo(0, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    };

    drawVortex(leadWrist, 1.15, true);
    drawVortex(rearWrist, 0.9, false);

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Layer 6: Plasma Rings & 100-Strike Razor-Needle Chaotic Barrage
  // ---------------------------------------------------------------------------
  private drawPlasmaRings(ctx: CanvasRenderingContext2D, behind?: boolean): void {
    if (this.rings.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const r of this.rings) {
      if (behind !== undefined && Boolean(r.behind) !== behind) continue;
      const t = r.age / r.life;
      const alpha = (1 - t) * (1 - t);
      const w = Math.max(1, r.lineWidth * (1 - t * 0.65));

      ctx.save();
      ctx.translate(r.x, r.y);
      if (r.angle !== undefined) ctx.rotate(r.angle);
      ctx.scale(1, r.tiltY);
      ctx.beginPath();
      ctx.arc(0, 0, r.radius, 0, Math.PI * 2);

      // Outer color stroke
      ctx.strokeStyle = r.color.replace(')', `, ${alpha * 0.85})`).replace('rgb', 'rgba');
      ctx.lineWidth = w * 2.8;
      ctx.stroke();

      // Sharp white inner shock rim
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.95})`;
      ctx.lineWidth = w;
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  private drawChaoticNeedles(ctx: CanvasRenderingContext2D, behind?: boolean): void {
    if (this.needles.length === 0) return;
    const needleSprite = getNeedleSprite();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const n of this.needles) {
      if (behind !== undefined && n.behind !== behind) continue;
      const t = n.age / n.life;
      const alpha = t < 0.16 ? t / 0.16 : Math.pow(1 - (t - 0.16) / 0.84, 1.5);
      if (alpha <= 0.01) continue;

      const midX = (n.x0 + n.x1) * 0.5;
      const midY = (n.y0 + n.y1) * 0.5;

      ctx.save();
      ctx.translate(midX, midY);
      ctx.rotate(n.angle);
      ctx.globalAlpha = alpha;

      if (needleSprite && !n.isHero) {
        // Fast GPU drawImage of pre-baked double-tapered needle sprite
        const drawW = n.len;
        const drawH = Math.max(10, n.thickness * 7.5);
        ctx.drawImage(needleSprite, -drawW * 0.5, -drawH * 0.5, drawW, drawH);
      } else {
        // Hero 4-vertex tapered diamond-needle polygon
        const halfL = n.len * 0.5;
        const shoulderX = halfL * 0.72;
        const shoulderW = n.thickness * 2.4;

        let fillCol = '#00f0ff';
        if (n.palette === 'violet') fillCol = '#7c3aed';
        else if (n.palette === 'silver') fillCol = '#f8fafc';
        else if (n.palette === 'crimson') fillCol = '#ff1e56';

        ctx.fillStyle = fillCol;
        ctx.beginPath();
        ctx.moveTo(-halfL, 0); // Tail
        ctx.lineTo(shoulderX, -shoulderW); // Shoulder top
        ctx.lineTo(halfL, 0); // Supersonic needle tip
        ctx.lineTo(shoulderX, shoulderW); // Shoulder bottom
        ctx.closePath();
        ctx.fill();

        // Razor #ffffff core
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1.2, n.thickness * 0.6);
        ctx.beginPath();
        ctx.moveTo(-halfL * 0.8, 0);
        ctx.lineTo(halfL, 0);
        ctx.stroke();
      }

      ctx.restore();
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Layer 7: Koyuki Firework Starbursts & Embers
  // ---------------------------------------------------------------------------
  private drawKoyukiParticles(ctx: CanvasRenderingContext2D): void {
    if (this.particles.length === 0) return;
    const glint = getStarGlintSprite();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const p of this.particles) {
      const t = p.age / p.life;
      const fade = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88;
      const twinkle = 0.75 + 0.25 * Math.sin(this.timeSec * 16 + p.twinklePhase);
      const alpha = Math.max(0, fade * twinkle);
      if (alpha <= 0.01) continue;

      ctx.globalAlpha = alpha;

      if (p.kind === 'firework') {
        // Chrysanthemum / willow filament trail
        const tailX = p.x - p.vx * 0.038;
        const tailY = p.y - p.vy * 0.038;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1.2, p.size * 0.55);
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();

        // Faceted diamond glint head
        if (glint && p.size > 2.8) {
          const gSize = p.size * 3.8;
          ctx.drawImage(glint, p.x - gSize * 0.5, p.y - gSize * 0.5, gSize, gSize);
        } else {
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * 0.45, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (p.kind === 'glint') {
        if (glint) {
          const gSize = p.size * 4.2;
          ctx.drawImage(glint, p.x - gSize * 0.5, p.y - gSize * 0.5, gSize, gSize);
        } else {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * 0.6, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        // Winter ember
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Layer 8: Peripheral Speed Lines & Calligraphy Banner
  // ---------------------------------------------------------------------------
  private drawSpeedLines(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    center: Vec2,
    intensity: number,
  ): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const maxR = Math.hypot(width, height) * 0.65;
    const count = 22;
    const seed = Math.floor(this.timeSec * 12);

    for (let i = 0; i < count; i++) {
      const h = Math.sin((i + 1) * 127.1 + seed * 311.7) * 43758.5453;
      const frac = h - Math.floor(h);
      const angle = (i / count) * Math.PI * 2 + (frac - 0.5) * 0.12;
      const innerR = maxR * (0.58 + frac * 0.22);
      const outerR = maxR * 1.15;

      const x0 = center.x + Math.cos(angle) * innerR;
      const y0 = center.y + Math.sin(angle) * innerR;
      const x1 = center.x + Math.cos(angle) * outerR;
      const y1 = center.y + Math.sin(angle) * outerR;

      ctx.strokeStyle = `rgba(186, 230, 253, ${0.075 * intensity * (0.4 + frac * 0.6)})`;
      ctx.lineWidth = 0.9 + frac * 1.2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.restore();
  }

  private getCalligraphySprite(mainSize: number): HTMLCanvasElement | null {
    const bucket = Math.round(mainSize / 4) * 4;
    if (this.bannerSprite && this.bannerBucket === bucket) {
      return this.bannerSprite;
    }
    if (typeof document === 'undefined') return null;

    const subSize = Math.max(12, Math.round(bucket * 0.28));
    const padX = Math.round(bucket * 4.6);
    const padY = Math.round(bucket * 1.7);

    const canvas = document.createElement('canvas');
    canvas.width = padX * 2;
    canvas.height = padY * 2;
    const g = canvas.getContext('2d');
    if (!g) return null;

    g.save();
    g.translate(padX, padY);
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    // Subtitle: 破壊殺・終式
    g.font = `700 ${subSize}px "Noto Serif TC", "Yuji Syuku", serif`;
    g.fillStyle = 'rgba(186, 230, 253, 0.95)';
    g.shadowColor = 'rgba(14, 165, 233, 0.95)';
    g.shadowBlur = 14;
    g.fillText('破 壊 殺 ・ 終 式', 0, -bucket * 0.62);

    // Main Title: 青銀亂殘光
    g.font = `900 ${bucket}px "Yuji Syuku", "Noto Serif TC", serif`;
    g.shadowColor = 'rgba(56, 189, 248, 1)';
    g.shadowBlur = 28;
    g.lineWidth = Math.max(3.2, bucket * 0.095);
    g.strokeStyle = 'rgba(6, 8, 28, 0.95)';
    g.strokeText('青銀亂殘光', 0, 0);

    const textGrad = g.createLinearGradient(0, -bucket * 0.5, 0, bucket * 0.5);
    textGrad.addColorStop(0, '#ffffff');
    textGrad.addColorStop(0.48, '#e0f2fe');
    textGrad.addColorStop(1, '#7dd3fc');
    g.fillStyle = textGrad;
    g.fillText('青銀亂殘光', 0, 0);

    // English subtitle
    g.shadowBlur = 8;
    g.font = `600 ${Math.max(10, Math.round(subSize * 0.72))}px "Inter", sans-serif`;
    g.fillStyle = 'rgba(224, 242, 254, 0.82)';
    g.fillText('BLUE SILVER CHAOTIC AFTERGLOW', 0, bucket * 0.88);
    g.restore();

    this.bannerSprite = canvas;
    this.bannerBucket = bucket;
    return canvas;
  }

  private drawCalligraphyBanner(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    intensity: number,
    activeDurationSec: number,
  ): void {
    const enter = Math.min(1, activeDurationSec * 3.8);
    const ease = 1 - Math.pow(1 - enter, 3);
    const alpha = Math.min(1, intensity * 1.15);

    const cx = width * 0.5;
    const topY = Math.max(54, height * 0.105);
    const mainSize = Math.max(30, Math.min(68, Math.round(width * 0.048)));
    const sprite = this.getCalligraphySprite(mainSize);
    if (!sprite) return;

    ctx.save();
    const scale = 1 + (1 - ease) * 0.16;
    ctx.translate(cx, topY);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite, -sprite.width * 0.5, -sprite.height * 0.5);

    // Animated frost-silver ink underline
    ctx.globalCompositeOperation = 'lighter';
    const lineHalfW = mainSize * 3.2 * ease;
    const lineGrad = ctx.createLinearGradient(-lineHalfW, 0, lineHalfW, 0);
    lineGrad.addColorStop(0, 'rgba(56, 189, 248, 0)');
    lineGrad.addColorStop(0.25, 'rgba(56, 189, 248, 0.75)');
    lineGrad.addColorStop(0.5, 'rgba(248, 250, 252, 0.98)');
    lineGrad.addColorStop(0.75, 'rgba(56, 189, 248, 0.75)');
    lineGrad.addColorStop(1, 'rgba(56, 189, 248, 0)');
    ctx.strokeStyle = lineGrad;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(-lineHalfW, mainSize * 0.58);
    ctx.lineTo(lineHalfW, mainSize * 0.58);
    ctx.stroke();

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Spawners & Physics Simulation
  // ---------------------------------------------------------------------------
  private spawnActivationBlast(center: Vec2, floor: Vec2, minDim: number): void {
    this.rings.push({
      x: floor.x,
      y: floor.y,
      radius: 18,
      maxRadius: minDim * 0.68,
      age: 0,
      life: 0.65,
      lineWidth: 5.5,
      tiltY: 0.28,
      color: 'rgb(56, 189, 248)',
      behind: true,
    });
    this.rings.push({
      x: center.x,
      y: center.y,
      radius: 14,
      maxRadius: minDim * 0.58,
      age: 0,
      life: 0.48,
      lineWidth: 4.8,
      tiltY: 1,
      color: 'rgb(124, 58, 237)',
      behind: true,
    });

    for (let i = 0; i < 12; i++) {
      this.spawnChaoticNeedle(minDim * 1.5, minDim * 1.5, center, minDim);
    }
    this.spawnKoyukiStarburst(center.x, center.y, minDim * 0.36, 22);
  }

  private spawnPunchShockwave(leadWrist: Vec2, center: Vec2, minDim: number): void {
    this.rings.push({
      x: leadWrist.x,
      y: leadWrist.y,
      radius: 10,
      maxRadius: minDim * 0.32,
      age: 0,
      life: 0.34,
      lineWidth: 3.6,
      tiltY: 0.54,
      angle: Math.atan2(leadWrist.y - center.y, leadWrist.x - center.x) + Math.PI * 0.5,
      color: 'rgb(56, 189, 248)',
    });
    this.spawnKoyukiStarburst(leadWrist.x, leadWrist.y, minDim * 0.22, 12);
    for (let i = 0; i < 5; i++) {
      this.spawnChaoticNeedle(minDim * 1.5, minDim * 1.5, leadWrist, minDim);
    }
  }

  private spawnChaoticNeedle(width: number, height: number, center: Vec2, minDim: number): ChaoticNeedle {
    const isRadial = Math.random() < 0.62;
    let x0: number, y0: number, x1: number, y1: number;

    if (isRadial) {
      const angle = Math.random() * Math.PI * 2;
      const startDist = minDim * (0.04 + Math.random() * 0.18);
      const len = minDim * (0.32 + Math.random() * 0.55);
      x0 = center.x + Math.cos(angle) * startDist;
      y0 = center.y + Math.sin(angle) * startDist;
      x1 = center.x + Math.cos(angle) * (startDist + len);
      y1 = center.y + Math.sin(angle) * (startDist + len);
    } else {
      const mx = width * (0.08 + Math.random() * 0.84);
      const my = height * (0.10 + Math.random() * 0.78);
      const angle = Math.random() * Math.PI * 2;
      const halfLen = minDim * (0.16 + Math.random() * 0.32);
      x0 = mx - Math.cos(angle) * halfLen;
      y0 = my - Math.sin(angle) * halfLen;
      x1 = mx + Math.cos(angle) * halfLen;
      y1 = my + Math.sin(angle) * halfLen;
    }

    const len = Math.hypot(x1 - x0, y1 - y0);
    const angle = Math.atan2(y1 - y0, x1 - x0);

    const r = Math.random();
    // Cohesive Blue-Silver palette (ice cyan, frost silver, subtle deep blue-violet)
    const palette: ChaoticNeedle['palette'] =
      r < 0.56 ? 'cyan' : r < 0.90 ? 'silver' : 'violet';

    const needle: ChaoticNeedle = {
      x0,
      y0,
      x1,
      y1,
      len,
      angle,
      age: 0,
      life: 0.20 + Math.random() * 0.24,
      thickness: 1.4 + Math.random() * 2.8,
      palette,
      isHero: Math.random() < 0.28,
      behind: Math.random() < 0.76,
    };
    this.needles.push(needle);
    return needle;
  }

  private spawnKoyukiStarburst(x: number, y: number, speedScale: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.22;
      const speed = speedScale * (1.3 + Math.random() * 2.0);
      const col = i % 3 === 0 ? '#f8fafc' : i % 3 === 1 ? '#e9d5ff' : '#38bdf8';
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        size: 2.2 + Math.random() * 3.2,
        age: 0,
        life: 0.42 + Math.random() * 0.38,
        twinklePhase: Math.random() * Math.PI * 2,
        kind: 'firework',
        color: col,
      });
    }
  }

  private updateParticles(dt: number): void {
    // Needles
    for (let i = this.needles.length - 1; i >= 0; i--) {
      this.needles[i].age += dt;
      if (this.needles[i].age >= this.needles[i].life) {
        swapRemove(this.needles, i);
      }
    }

    // Rings
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.age += dt;
      const t = Math.min(1, r.age / r.life);
      r.radius = r.maxRadius * (1 - Math.pow(1 - t, 3));
      if (r.age >= r.life) {
        swapRemove(this.rings, i);
      }
    }

    // Koyuki particles with exponential drag deceleration (v *= exp(-4.8 * dt))
    const drag = Math.exp(-4.8 * dt);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      if (p.kind === 'firework') {
        p.vx *= drag;
        p.vy *= drag;
        p.vy += 35 * dt; // Subtle gravity
      } else if (p.kind === 'ember') {
        p.vy -= 15 * dt; // Buoyancy
      }

      if (p.age >= p.life) {
        swapRemove(this.particles, i);
      }
    }

    // Bound particle counts during sustained activation.
    if (this.needles.length > 50) this.needles.length = 50;
    if (this.particles.length > 140) this.particles.length = 140;
    if (this.rings.length > 14) this.rings.length = 14;
  }
}
