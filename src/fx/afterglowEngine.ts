import type { Landmark3D } from '../cv/oneEuroFilter';
import { POSE_CONNECTIONS } from '../cv/poseLandmarker';
import type { PoseEvaluation, PoseState, Vec2 } from '../cv/akazaPoseClassifier';
import { drawSnowflakeCompass } from './compassRenderer';

interface SlashBeam {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  age: number;
  life: number;
  thickness: number;
  hue: 'cyan' | 'silver' | 'cobalt';
}

interface ShockwaveRing {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  age: number;
  life: number;
  lineWidth: number;
  tiltY: number;
}

interface EnergySpark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  age: number;
  life: number;
  twinklePhase: number;
  kind: 'diamond' | 'ember' | 'firework';
  color: string;
}

interface SkeletonAfterimage {
  points: Array<{ x: number; y: number; v: number }>;
  offsetX: number;
  offsetY: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
}

export interface AfterglowFrameHooks {
  onActivate?: () => void;
  onPunchBurst?: () => void;
  onBarrageTick?: () => void;
  onDissipate?: () => void;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** O(1) swap-remove helper to avoid array shifting during particle updates. */
function swapRemove<T>(arr: T[], index: number): void {
  const last = arr.length - 1;
  if (index !== last) arr[index] = arr[last];
  arr.pop();
}

/**
 * 60fps Anime VFX Compositor for:
 *   Akaza's Destructive Death — Final Form: Blue Silver Chaotic Afterglow
 *   (破壊殺・終式 青銀亂殘光)
 *
 * Performance engineering:
 *   - ZERO per-frame `ctx.shadowBlur` calls (which trigger expensive Gaussian blurs per stroke
 *     on Retina displays). Glow bloom is achieved via pre-baked offscreen sprites (Compass &
 *     Calligraphy) + fast multi-pass additive (`lighter`) strokes.
 *   - O(1) swap-remove particle pools with hard upper caps.
 */
export class AfterglowFxEngine {
  private slashes: SlashBeam[] = [];
  private rings: ShockwaveRing[] = [];
  private sparks: EnergySpark[] = [];
  private afterimages: SkeletonAfterimage[] = [];

  private prevState: PoseState = 'IDLE';
  private timeSec = 0;
  private flashAlpha = 0;
  private shakeMagnitude = 0;
  private slashSpawnAcc = 0;
  private fireworkSpawnAcc = 0;
  private afterimageSpawnAcc = 0;
  private punchCooldown = 0;
  private soundTickAcc = 0;

  // Smoothly interpolated floor & body anchors for buttery stability
  private smoothFloor: Vec2 = { x: 0.5, y: 0.85 };
  private smoothCenter: Vec2 = { x: 0.5, y: 0.5 };
  private smoothScale = 0.15;
  private anchorsInitialized = false;

  // Offscreen cached calligraphy sprite (rebuilt only on font load or size bucket change)
  private bannerSprite: HTMLCanvasElement | null = null;
  private bannerMainSize = 0;
  private bannerFontReady = false;

  constructor() {
    if (typeof document !== 'undefined' && document.fonts) {
      void document.fonts.ready.then(() => {
        this.bannerFontReady = true;
        this.bannerSprite = null;
      });
    }
  }

  reset(): void {
    this.slashes.length = 0;
    this.rings.length = 0;
    this.sparks.length = 0;
    this.afterimages.length = 0;
    this.prevState = 'IDLE';
    this.flashAlpha = 0;
    this.shakeMagnitude = 0;
    this.anchorsInitialized = false;
  }

  /**
   * Returns current micro camera-shake pixel offset so the video canvas shakes
   * in sync with the VFX overlay on activation impact.
   */
  getShakeOffset(): { x: number; y: number } {
    if (this.shakeMagnitude <= 0.25) return { x: 0, y: 0 };
    return {
      x: (Math.random() - 0.5) * 2 * this.shakeMagnitude,
      y: (Math.random() - 0.5) * 2 * this.shakeMagnitude,
    };
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
  ): void {
    const dt = Math.min(0.05, Math.max(0.001, dtSec));
    this.timeSec += dt;
    this.punchCooldown = Math.max(0, this.punchCooldown - dt);

    const mapX = (nx: number) => (mirrored ? 1 - nx : nx) * width;
    const mapY = (ny: number) => ny * height;

    // Smooth anchor interpolation
    if (!this.anchorsInitialized && pose.hasPerson) {
      this.smoothFloor.x = pose.floorAnchor.x;
      this.smoothFloor.y = pose.floorAnchor.y;
      this.smoothCenter.x = pose.bodyCenter.x;
      this.smoothCenter.y = pose.bodyCenter.y;
      this.smoothScale = pose.bodyScale;
      this.anchorsInitialized = true;
    } else if (pose.hasPerson) {
      const k = 1 - Math.exp(-dt * 12);
      this.smoothFloor.x = lerp(this.smoothFloor.x, pose.floorAnchor.x, k);
      this.smoothFloor.y = lerp(this.smoothFloor.y, pose.floorAnchor.y, k);
      this.smoothCenter.x = lerp(this.smoothCenter.x, pose.bodyCenter.x, k);
      this.smoothCenter.y = lerp(this.smoothCenter.y, pose.bodyCenter.y, k);
      this.smoothScale = lerp(this.smoothScale, pose.bodyScale, k);
    }

    const floorPx = { x: mapX(this.smoothFloor.x), y: mapY(this.smoothFloor.y) };
    const centerPx = { x: mapX(this.smoothCenter.x), y: mapY(this.smoothCenter.y) };
    const leadWristPx = { x: mapX(pose.leadWrist.x), y: mapY(pose.leadWrist.y) };
    const rearWristPx = { x: mapX(pose.rearWrist.x), y: mapY(pose.rearWrist.y) };
    const minDim = Math.min(width, height);

    // -----------------------------------------------------------------------
    // State transitions & burst triggers
    // -----------------------------------------------------------------------
    if (this.prevState !== 'ACTIVE' && pose.state === 'ACTIVE') {
      this.flashAlpha = 0.72;
      this.shakeMagnitude = 11;
      this.spawnActivationExplosion(centerPx, floorPx, width, height);
      hooks?.onActivate?.();
    } else if (this.prevState === 'ACTIVE' && pose.state === 'DISSIPATING') {
      hooks?.onDissipate?.();
    }
    this.prevState = pose.state;

    // Reactive punch shockwave bursts when moving fists sharply during ACTIVE
    if (pose.state === 'ACTIVE' && pose.wristSpeed > 1.35 && this.punchCooldown <= 0) {
      this.punchCooldown = 0.24;
      this.shakeMagnitude = Math.max(this.shakeMagnitude, 5.5);
      this.spawnFireworkBurst(leadWristPx.x, leadWristPx.y, minDim * 0.22, 16);
      this.rings.push({
        x: leadWristPx.x,
        y: leadWristPx.y,
        radius: 12,
        maxRadius: minDim * 0.34,
        age: 0,
        life: 0.38,
        lineWidth: 4.5,
        tiltY: 1,
      });
      for (let i = 0; i < 6; i++) {
        this.spawnChaoticSlash(width, height, leadWristPx);
      }
      hooks?.onPunchBurst?.();
    }

    // -----------------------------------------------------------------------
    // Continuous particle & slash emission
    // -----------------------------------------------------------------------
    if (pose.state === 'CHARGING') {
      if (Math.random() < 0.75) {
        const a = Math.random() * Math.PI * 2;
        const dist = minDim * (0.25 + Math.random() * 0.25);
        const sx = centerPx.x + Math.cos(a) * dist;
        const sy = centerPx.y + Math.sin(a) * dist;
        const speed = dist * 2.8;
        this.sparks.push({
          x: sx,
          y: sy,
          vx: -Math.cos(a) * speed,
          vy: -Math.sin(a) * speed,
          size: 2.5 + Math.random() * 3,
          age: 0,
          life: 0.28 + Math.random() * 0.16,
          twinklePhase: Math.random() * Math.PI * 2,
          kind: 'diamond',
          color: '#7dd3fc',
        });
      }
    }

    if (pose.state === 'ACTIVE') {
      const escalation = Math.min(1, 0.45 + pose.activeDurationSec * 0.42);

      // 100-strike chaotic afterglow slash barrage
      this.slashSpawnAcc += dt * (18 + escalation * 26);
      while (this.slashSpawnAcc >= 1) {
        this.slashSpawnAcc -= 1;
        this.spawnChaoticSlash(width, height, centerPx);
      }

      // Periodic Koyuki-inspired blue-silver firework shockwave bursts
      this.fireworkSpawnAcc += dt * (1.8 + escalation * 2.2);
      if (this.fireworkSpawnAcc >= 1) {
        this.fireworkSpawnAcc -= 1;
        const angle = Math.random() * Math.PI * 2;
        const dist = minDim * (0.24 + Math.random() * 0.28);
        const fx = Math.max(width * 0.08, Math.min(width * 0.92, centerPx.x + Math.cos(angle) * dist * 1.25));
        const fy = Math.max(height * 0.12, Math.min(height * 0.82, centerPx.y + Math.sin(angle) * dist * 0.85));
        this.spawnFireworkBurst(fx, fy, minDim * (0.14 + Math.random() * 0.12), 14);
        this.rings.push({
          x: fx,
          y: fy,
          radius: 6,
          maxRadius: minDim * (0.13 + Math.random() * 0.1),
          age: 0,
          life: 0.42,
          lineWidth: 2.6,
          tiltY: 1,
        });
      }

      // Ghostly cyan-silver afterimage clones of Akaza's live stance
      this.afterimageSpawnAcc += dt * 4.4;
      if (this.afterimageSpawnAcc >= 1 && landmarks && landmarks.length >= 29) {
        this.afterimageSpawnAcc -= 1;
        this.spawnAfterimage(landmarks, width, height, mirrored);
      }

      // Rising spirit embers & diamond glints from floor compass & wrists
      for (let i = 0; i < 3; i++) {
        const fromCompass = i < 2;
        const angle = Math.random() * Math.PI * 2;
        const rSpread = minDim * (0.12 + Math.random() * 0.26);
        const sx = fromCompass
          ? floorPx.x + Math.cos(angle) * rSpread
          : (Math.random() < 0.5 ? leadWristPx.x : rearWristPx.x) + (Math.random() - 0.5) * 32;
        const sy = fromCompass
          ? floorPx.y + Math.sin(angle) * rSpread * 0.28
          : (Math.random() < 0.5 ? leadWristPx.y : rearWristPx.y) + (Math.random() - 0.5) * 32;

        this.sparks.push({
          x: sx,
          y: sy,
          vx: (Math.random() - 0.5) * 45,
          vy: -(65 + Math.random() * 145),
          size: 2 + Math.random() * 4.2,
          age: 0,
          life: 0.7 + Math.random() * 0.75,
          twinklePhase: Math.random() * Math.PI * 2,
          kind: Math.random() < 0.42 ? 'diamond' : 'ember',
          color: Math.random() < 0.45 ? '#f0f9ff' : '#38bdf8',
        });
      }

      this.soundTickAcc += dt;
      if (this.soundTickAcc >= 0.32) {
        this.soundTickAcc = 0;
        hooks?.onBarrageTick?.();
      }
    }

    // Decay flash & shake
    this.flashAlpha = Math.max(0, this.flashAlpha - dt * 2.2);
    this.shakeMagnitude = Math.max(0, this.shakeMagnitude * Math.exp(-dt * 9.5));

    // Advance particles
    this.updateParticles(dt);

    // -----------------------------------------------------------------------
    // RENDER LAYERS (Zero per-frame shadowBlur)
    // -----------------------------------------------------------------------
    ctx.clearRect(0, 0, width, height);
    const intensity = pose.effectIntensity;

    if (
      intensity <= 0.005 &&
      this.slashes.length === 0 &&
      this.rings.length === 0 &&
      this.sparks.length === 0 &&
      this.afterimages.length === 0
    ) {
      return;
    }

    // Layer 1: Midnight-indigo / deep-violet Domain atmosphere grade
    if (intensity > 0.01) {
      this.drawAtmosphereGrade(ctx, width, height, centerPx, intensity);
    }

    // Layer 2: Cached 3D Floor Snowflake Compass Needle (破壊殺・羅針)
    const compassRadius = Math.max(minDim * 0.24, Math.min(width * 0.36, this.smoothScale * width * 1.95));
    const unfold =
      pose.state === 'CHARGING'
        ? pose.chargeProgress * 0.45
        : pose.state === 'ACTIVE'
          ? Math.min(1, 0.35 + pose.activeDurationSec * 2.8)
          : intensity;

    drawSnowflakeCompass({
      ctx,
      cx: floorPx.x,
      cy: floorPx.y,
      radius: compassRadius,
      unfold,
      intensity: Math.max(intensity, pose.state === 'CHARGING' ? pose.chargeProgress * 0.35 : 0),
      timeSec: this.timeSec,
    });

    // Layer 3: Ghostly Blue-Silver Energy Afterimages
    this.drawAfterimages(ctx);

    // Layer 4: Body-anchored aura & blazing fist energy
    if (intensity > 0.05 && pose.hasPerson) {
      this.drawBodyAndFistAura(ctx, centerPx, leadWristPx, rearWristPx, minDim, intensity);
    }

    // Layer 5: Shockwave Rings & 100-Strike Chaotic Slashes (layered additive glow)
    this.drawRings(ctx);
    this.drawSlashes(ctx);

    // Layer 6: Diamond Sparkles, Firework Filaments, & Rising Embers
    this.drawSparks(ctx);

    // Layer 7: Anime Speed Lines around screen periphery during ACTIVE
    if (intensity > 0.25) {
      this.drawSpeedLines(ctx, width, height, centerPx, intensity);
    }

    // Layer 8: Impact Flash
    if (this.flashAlpha > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const flashGrad = ctx.createRadialGradient(
        centerPx.x,
        centerPx.y,
        0,
        centerPx.x,
        centerPx.y,
        Math.max(width, height) * 0.85,
      );
      flashGrad.addColorStop(0, `rgba(240, 249, 255, ${this.flashAlpha * 0.85})`);
      flashGrad.addColorStop(0.4, `rgba(56, 189, 248, ${this.flashAlpha * 0.45})`);
      flashGrad.addColorStop(1, 'rgba(30, 58, 138, 0)');
      ctx.fillStyle = flashGrad;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }

    // Layer 9: Cached Calligraphy Title ("破壊殺・終式 青銀亂殘光") at Top Center
    if (intensity > 0.08 && pose.state !== 'CHARGING') {
      this.drawCalligraphyBanner(ctx, width, height, intensity, pose.activeDurationSec);
    }
  }

  private spawnActivationExplosion(center: Vec2, floor: Vec2, width: number, height: number): void {
    const minDim = Math.min(width, height);

    this.rings.push({
      x: floor.x,
      y: floor.y,
      radius: 20,
      maxRadius: minDim * 0.65,
      age: 0,
      life: 0.65,
      lineWidth: 6,
      tiltY: 0.30,
    });
    this.rings.push({
      x: center.x,
      y: center.y,
      radius: 16,
      maxRadius: minDim * 0.58,
      age: 0,
      life: 0.48,
      lineWidth: 5,
      tiltY: 1,
    });

    for (let i = 0; i < 18; i++) {
      this.spawnChaoticSlash(width, height, center);
    }
    this.spawnFireworkBurst(center.x, center.y, minDim * 0.38, 36);
  }

  private spawnChaoticSlash(width: number, height: number, center: Vec2): void {
    const minDim = Math.min(width, height);
    const isRadial = Math.random() < 0.55;

    let x0: number, y0: number, x1: number, y1: number;
    if (isRadial) {
      const angle = Math.random() * Math.PI * 2;
      const startDist = minDim * (0.04 + Math.random() * 0.16);
      const len = minDim * (0.28 + Math.random() * 0.52);
      x0 = center.x + Math.cos(angle) * startDist;
      y0 = center.y + Math.sin(angle) * startDist;
      x1 = center.x + Math.cos(angle) * (startDist + len);
      y1 = center.y + Math.sin(angle) * (startDist + len);
    } else {
      const mx = width * (0.08 + Math.random() * 0.84);
      const my = height * (0.10 + Math.random() * 0.78);
      const angle = Math.random() * Math.PI * 2;
      const halfLen = minDim * (0.14 + Math.random() * 0.28);
      x0 = mx - Math.cos(angle) * halfLen;
      y0 = my - Math.sin(angle) * halfLen;
      x1 = mx + Math.cos(angle) * halfLen;
      y1 = my + Math.sin(angle) * halfLen;
    }

    const midX = (x0 + x1) * 0.5;
    const midY = (y0 + y1) * 0.5;
    const perpX = -(y1 - y0);
    const perpY = x1 - x0;
    const curve = (Math.random() - 0.5) * 0.22;

    const r = Math.random();
    const hue: SlashBeam['hue'] = r < 0.45 ? 'cyan' : r < 0.82 ? 'silver' : 'cobalt';

    this.slashes.push({
      x0,
      y0,
      x1,
      y1,
      cx: midX + perpX * curve,
      cy: midY + perpY * curve,
      age: 0,
      life: 0.16 + Math.random() * 0.22,
      thickness: 1.5 + Math.random() * 3.8,
      hue,
    });
  }

  private spawnFireworkBurst(x: number, y: number, speedScale: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
      const speed = speedScale * (1.2 + Math.random() * 1.9);
      this.sparks.push({
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        size: 2.2 + Math.random() * 3.4,
        age: 0,
        life: 0.38 + Math.random() * 0.36,
        twinklePhase: Math.random() * Math.PI * 2,
        kind: 'firework',
        color: i % 3 === 0 ? '#f8fafc' : i % 3 === 1 ? '#7dd3fc' : '#38bdf8',
      });
    }
  }

  private spawnAfterimage(
    landmarks: Landmark3D[],
    width: number,
    height: number,
    mirrored: boolean,
  ): void {
    const pts = landmarks.map((lm) => ({
      x: (mirrored ? 1 - lm.x : lm.x) * width,
      y: lm.y * height,
      v: lm.visibility ?? 1,
    }));
    const angle = Math.random() < 0.5 ? (Math.random() - 0.5) * 0.6 : Math.PI + (Math.random() - 0.5) * 0.6;
    const speed = 130 + Math.random() * 160;
    this.afterimages.push({
      points: pts,
      offsetX: 0,
      offsetY: 0,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed * 0.35 - 18,
      age: 0,
      life: 0.42,
    });
  }

  private updateParticles(dt: number): void {
    for (let i = this.slashes.length - 1; i >= 0; i--) {
      this.slashes[i].age += dt;
      if (this.slashes[i].age >= this.slashes[i].life) {
        swapRemove(this.slashes, i);
      }
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.age += dt;
      const t = Math.min(1, r.age / r.life);
      r.radius = r.maxRadius * (1 - Math.pow(1 - t, 3));
      if (r.age >= r.life) {
        swapRemove(this.rings, i);
      }
    }

    const drag = Math.exp(-dt * 4.5);
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.age += dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (s.kind === 'firework') {
        s.vx *= drag;
        s.vy *= drag;
        s.vy += 40 * dt;
      }
      if (s.age >= s.life) {
        swapRemove(this.sparks, i);
      }
    }

    const imgDrag = Math.exp(-dt * 2.5);
    for (let i = this.afterimages.length - 1; i >= 0; i--) {
      const a = this.afterimages[i];
      a.age += dt;
      a.offsetX += a.vx * dt;
      a.offsetY += a.vy * dt;
      a.vx *= imgDrag;
      if (a.age >= a.life) {
        swapRemove(this.afterimages, i);
      }
    }

    // Hard pool caps for guaranteed 60fps
    if (this.slashes.length > 85) this.slashes.length = 85;
    if (this.sparks.length > 240) this.sparks.length = 240;
    if (this.afterimages.length > 8) this.afterimages.length = 8;
  }

  private drawAtmosphereGrade(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    center: Vec2,
    intensity: number,
  ): void {
    ctx.save();
    ctx.fillStyle = `rgba(18, 12, 46, ${0.42 * intensity})`;
    ctx.fillRect(0, 0, width, height);

    const vig = ctx.createRadialGradient(
      center.x,
      center.y,
      Math.min(width, height) * 0.14,
      center.x,
      center.y,
      Math.max(width, height) * 0.78,
    );
    vig.addColorStop(0, `rgba(56, 189, 248, ${0.06 * intensity})`);
    vig.addColorStop(0.55, `rgba(24, 18, 62, ${0.22 * intensity})`);
    vig.addColorStop(1, `rgba(6, 8, 28, ${0.62 * intensity})`);
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  private drawAfterimages(ctx: CanvasRenderingContext2D): void {
    if (this.afterimages.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const img of this.afterimages) {
      const t = img.age / img.life;
      const alpha = (1 - t) * (1 - t) * 0.42;
      if (alpha <= 0.01) continue;

      ctx.beginPath();
      for (const [a, b] of POSE_CONNECTIONS) {
        const pa = img.points[a];
        const pb = img.points[b];
        if (!pa || !pb || pa.v < 0.25 || pb.v < 0.25) continue;
        ctx.moveTo(pa.x + img.offsetX, pa.y + img.offsetY);
        ctx.lineTo(pb.x + img.offsetX, pb.y + img.offsetY);
      }

      // Layered additive glow (no shadowBlur Gaussian overhead)
      ctx.strokeStyle = `rgba(56, 189, 248, ${alpha * 0.42})`;
      ctx.lineWidth = 14 * (1 - t * 0.35);
      ctx.stroke();

      ctx.strokeStyle = `rgba(125, 211, 252, ${alpha * 0.85})`;
      ctx.lineWidth = 5.5 * (1 - t * 0.35);
      ctx.stroke();

      ctx.strokeStyle = `rgba(240, 249, 255, ${alpha * 0.9})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawBodyAndFistAura(
    ctx: CanvasRenderingContext2D,
    center: Vec2,
    leadWrist: Vec2,
    rearWrist: Vec2,
    minDim: number,
    intensity: number,
  ): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const pulse = 0.85 + 0.15 * Math.sin(this.timeSec * 12);

    const bodyGlow = ctx.createRadialGradient(
      center.x,
      center.y,
      minDim * 0.02,
      center.x,
      center.y,
      minDim * 0.26,
    );
    bodyGlow.addColorStop(0, `rgba(186, 230, 253, ${0.14 * intensity * pulse})`);
    bodyGlow.addColorStop(0.5, `rgba(56, 189, 248, ${0.10 * intensity})`);
    bodyGlow.addColorStop(1, 'rgba(37, 99, 235, 0)');
    ctx.fillStyle = bodyGlow;
    ctx.beginPath();
    ctx.arc(center.x, center.y, minDim * 0.26, 0, Math.PI * 2);
    ctx.fill();

    const drawFistFlare = (pos: Vec2, sizeMul: number) => {
      const r = minDim * 0.075 * sizeMul * pulse;
      const g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, r);
      g.addColorStop(0, `rgba(255, 255, 255, ${0.85 * intensity})`);
      g.addColorStop(0.28, `rgba(125, 211, 252, ${0.58 * intensity})`);
      g.addColorStop(0.65, `rgba(14, 165, 233, ${0.22 * intensity})`);
      g.addColorStop(1, 'rgba(14, 165, 233, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fill();

      const starR = r * 0.78;
      ctx.fillStyle = `rgba(240, 249, 255, ${0.85 * intensity})`;
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y - starR);
      ctx.quadraticCurveTo(pos.x, pos.y, pos.x + starR * 0.72, pos.y);
      ctx.quadraticCurveTo(pos.x, pos.y, pos.x, pos.y + starR);
      ctx.quadraticCurveTo(pos.x, pos.y, pos.x - starR * 0.72, pos.y);
      ctx.quadraticCurveTo(pos.x, pos.y, pos.x, pos.y - starR);
      ctx.fill();
    };

    drawFistFlare(leadWrist, 1.15);
    drawFistFlare(rearWrist, 0.9);
    ctx.restore();
  }

  private drawRings(ctx: CanvasRenderingContext2D): void {
    if (this.rings.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const r of this.rings) {
      const t = r.age / r.life;
      const alpha = (1 - t) * (1 - t);
      const baseW = Math.max(1, r.lineWidth * (1 - t * 0.7));

      ctx.save();
      ctx.translate(r.x, r.y);
      ctx.scale(1, r.tiltY);
      ctx.beginPath();
      ctx.arc(0, 0, r.radius, 0, Math.PI * 2);

      // Soft outer halo stroke
      ctx.strokeStyle = `rgba(56, 189, 248, ${alpha * 0.38})`;
      ctx.lineWidth = baseW * 3.4;
      ctx.stroke();

      // Crisp luminous inner shockwave ring
      ctx.strokeStyle = `rgba(224, 242, 254, ${alpha * 0.92})`;
      ctx.lineWidth = baseW;
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  private drawSlashes(ctx: CanvasRenderingContext2D): void {
    if (this.slashes.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    for (const s of this.slashes) {
      const t = s.age / s.life;
      const alpha = t < 0.18 ? t / 0.18 : Math.pow(1 - (t - 0.18) / 0.82, 1.6);
      if (alpha <= 0.01) continue;

      const w = s.thickness * (1.8 - t * 0.7);
      const bloomColor =
        s.hue === 'cyan'
          ? `rgba(56, 189, 248, ${alpha * 0.34})`
          : s.hue === 'silver'
            ? `rgba(203, 213, 225, ${alpha * 0.30})`
            : `rgba(96, 165, 250, ${alpha * 0.32})`;

      const midColor =
        s.hue === 'cyan'
          ? `rgba(125, 211, 252, ${alpha * 0.85})`
          : s.hue === 'silver'
            ? `rgba(226, 232, 240, ${alpha * 0.82})`
            : `rgba(147, 197, 253, ${alpha * 0.85})`;

      ctx.beginPath();
      ctx.moveTo(s.x0, s.y0);
      ctx.quadraticCurveTo(s.cx, s.cy, s.x1, s.y1);

      // Wide additive glow halo (replaces costly shadowBlur!)
      ctx.strokeStyle = bloomColor;
      ctx.lineWidth = w * 3.4;
      ctx.stroke();

      // Vibrant colored blade body
      ctx.strokeStyle = midColor;
      ctx.lineWidth = w;
      ctx.stroke();

      // Razor-sharp white-silver inner core
      ctx.strokeStyle = `rgba(248, 250, 252, ${alpha * 0.96})`;
      ctx.lineWidth = Math.max(0.9, w * 0.38);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawSparks(ctx: CanvasRenderingContext2D): void {
    if (this.sparks.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const s of this.sparks) {
      const t = s.age / s.life;
      const fade = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      const twinkle = 0.72 + 0.28 * Math.sin(this.timeSec * 18 + s.twinklePhase);
      const alpha = Math.max(0, fade * twinkle);
      if (alpha <= 0.01) continue;

      ctx.globalAlpha = alpha;

      if (s.kind === 'firework') {
        const tailX = s.x - s.vx * 0.045;
        const tailY = s.y - s.vy * 0.045;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = Math.max(1.2, s.size * 0.55);
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(s.x, s.y);
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size * 0.45, 0, Math.PI * 2);
        ctx.fill();
      } else if (s.kind === 'diamond') {
        const r = s.size * 1.45;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - r);
        ctx.lineTo(s.x + r * 0.28, s.y - r * 0.28);
        ctx.lineTo(s.x + r, s.y);
        ctx.lineTo(s.x + r * 0.28, s.y + r * 0.28);
        ctx.lineTo(s.x, s.y + r);
        ctx.lineTo(s.x - r * 0.28, s.y + r * 0.28);
        ctx.lineTo(s.x - r, s.y);
        ctx.lineTo(s.x - r * 0.28, s.y - r * 0.28);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

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
    const count = 28;
    const flickerSeed = Math.floor(this.timeSec * 24);

    for (let i = 0; i < count; i++) {
      const h = Math.sin((i + 1) * 127.1 + flickerSeed * 311.7) * 43758.5453;
      const frac = h - Math.floor(h);
      const angle = (i / count) * Math.PI * 2 + (frac - 0.5) * 0.14;
      const innerR = maxR * (0.48 + frac * 0.22);
      const outerR = maxR * 1.15;

      const x0 = center.x + Math.cos(angle) * innerR;
      const y0 = center.y + Math.sin(angle) * innerR;
      const x1 = center.x + Math.cos(angle) * outerR;
      const y1 = center.y + Math.sin(angle) * outerR;

      ctx.strokeStyle = `rgba(186, 230, 253, ${0.14 * intensity * (0.4 + frac * 0.6)})`;
      ctx.lineWidth = 1 + frac * 1.8;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.restore();
  }

  private getCalligraphySprite(mainSize: number): HTMLCanvasElement | null {
    // Quantize to 4px buckets so window resize doesn't constantly rebuild
    const bucket = Math.round(mainSize / 4) * 4;
    if (this.bannerSprite && this.bannerMainSize === bucket) {
      return this.bannerSprite;
    }
    if (typeof document === 'undefined') return null;

    const subSize = Math.max(12, Math.round(bucket * 0.28));
    const padX = Math.round(bucket * 4.4);
    const padY = Math.round(bucket * 1.65);

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
    g.fillStyle = 'rgba(186, 230, 253, 0.92)';
    g.shadowColor = 'rgba(14, 165, 233, 0.95)';
    g.shadowBlur = 12;
    g.fillText('破 壊 殺 ・ 終 式', 0, -bucket * 0.62);

    // Main Title: 青銀亂殘光 (baked with crisp azure bloom once!)
    g.font = `900 ${bucket}px "Yuji Syuku", "Noto Serif TC", serif`;
    g.shadowColor = 'rgba(56, 189, 248, 1)';
    g.shadowBlur = 26;
    g.lineWidth = Math.max(3, bucket * 0.09);
    g.strokeStyle = 'rgba(12, 74, 110, 0.95)';
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
    g.fillStyle = 'rgba(224, 242, 254, 0.78)';
    g.fillText('BLUE SILVER CHAOTIC AFTERGLOW', 0, bucket * 0.86);
    g.restore();

    if (this.bannerFontReady || bucket > 0) {
      this.bannerSprite = canvas;
      this.bannerMainSize = bucket;
    }
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
    const scale = 1 + (1 - ease) * 0.18;
    ctx.translate(cx, topY);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite, -sprite.width * 0.5, -sprite.height * 0.5);

    // Animated horizontal luminous brush slash underline
    ctx.globalCompositeOperation = 'lighter';
    const lineHalfW = mainSize * 3.1 * ease;
    const lineGrad = ctx.createLinearGradient(-lineHalfW, 0, lineHalfW, 0);
    lineGrad.addColorStop(0, 'rgba(56, 189, 248, 0)');
    lineGrad.addColorStop(0.25, 'rgba(56, 189, 248, 0.72)');
    lineGrad.addColorStop(0.5, 'rgba(248, 250, 252, 0.96)');
    lineGrad.addColorStop(0.75, 'rgba(56, 189, 248, 0.72)');
    lineGrad.addColorStop(1, 'rgba(56, 189, 248, 0)');
    ctx.strokeStyle = lineGrad;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(-lineHalfW, mainSize * 0.56);
    ctx.lineTo(lineHalfW, mainSize * 0.56);
    ctx.stroke();

    ctx.restore();
  }
}
