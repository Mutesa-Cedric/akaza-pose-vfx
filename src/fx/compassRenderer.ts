/**
 * High-performance procedural renderer for Akaza's 12-point Snowflake Compass Needle
 * (破壊殺・羅針), projected onto the ground plane in 3D perspective beneath the user's feet.
 *
 * Performance architecture:
 *  - The intricate static compass geometry (12 barbed snowflake blades, concentric rings,
 *    glowing halo, and 12 traditional kanji numerals) is pre-baked ONCE into an offscreen
 *    640×640 sprite canvas with bloom baked in.
 *  - At 60fps, rendering costs only a single GPU-accelerated `drawImage()` call plus a
 *    lightweight counter-rotating inner hexagram — eliminating all per-frame `shadowBlur`.
 */

const KANJI_NUMERALS = [
  '壱',
  '弐',
  '参',
  '肆',
  '伍',
  '陸',
  '漆',
  '捌',
  '玖',
  '拾',
  '拾壱',
  '拾弐',
] as const;

const SPRITE_SIZE = 640;
const SPRITE_HALF = SPRITE_SIZE / 2;
const SPRITE_BASE_RADIUS = 235;

let cachedCompassSprite: HTMLCanvasElement | null = null;
let fontListenerAttached = false;

function buildCompassSprite(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_SIZE;
  canvas.height = SPRITE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const r = SPRITE_BASE_RADIUS;
  ctx.save();
  ctx.translate(SPRITE_HALF, SPRITE_HALF);
  ctx.globalCompositeOperation = 'lighter';

  // 1. Soft radial floor glow
  const floorGlow = ctx.createRadialGradient(0, 0, r * 0.05, 0, 0, r * 1.26);
  floorGlow.addColorStop(0, 'rgba(215, 248, 255, 0.44)');
  floorGlow.addColorStop(0.32, 'rgba(56, 189, 248, 0.34)');
  floorGlow.addColorStop(0.7, 'rgba(37, 99, 235, 0.16)');
  floorGlow.addColorStop(1, 'rgba(15, 23, 42, 0)');
  ctx.fillStyle = floorGlow;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.26, 0, Math.PI * 2);
  ctx.fill();

  // Bake crisp cyan bloom into the offscreen sprite once (never paid per-frame!)
  ctx.shadowColor = 'rgba(56, 189, 248, 0.95)';
  ctx.shadowBlur = 18;

  // 2. Concentric geometric rings
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.9)';
  ctx.lineWidth = 4.2;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.96, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(224, 242, 254, 0.78)';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.84, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(186, 230, 253, 0.9)';
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.30, 0, Math.PI * 2);
  ctx.stroke();

  // 3. 12-point Snowflake Needle Spokes (6 primary + 6 interleaved frost blades)
  for (let i = 0; i < 12; i++) {
    const angle = (i * Math.PI) / 6;
    const isMajor = i % 2 === 0;
    const spokeLen = isMajor ? r * 1.12 : r * 0.88;
    const halfWidth = isMajor ? r * 0.048 : r * 0.03;

    ctx.save();
    ctx.rotate(angle);

    const grad = ctx.createLinearGradient(0, 0, spokeLen, 0);
    grad.addColorStop(0, 'rgba(240, 249, 255, 0.96)');
    grad.addColorStop(0.55, 'rgba(56, 189, 248, 0.9)');
    grad.addColorStop(1, 'rgba(186, 230, 253, 0.94)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(r * 0.14, 0);
    ctx.lineTo(spokeLen * 0.42, -halfWidth);
    ctx.lineTo(spokeLen, 0);
    ctx.lineTo(spokeLen * 0.42, halfWidth);
    ctx.closePath();
    ctx.fill();

    // Bright silver central spine
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.94)';
    ctx.lineWidth = isMajor ? 2.6 : 1.6;
    ctx.beginPath();
    ctx.moveTo(r * 0.12, 0);
    ctx.lineTo(spokeLen * 1.02, 0);
    ctx.stroke();

    // Crystalline snowflake V-barbs
    const barbPositions = isMajor ? [0.46, 0.68, 0.84] : [0.56, 0.74];
    ctx.strokeStyle = 'rgba(186, 230, 253, 0.92)';
    ctx.lineWidth = isMajor ? 2.4 : 1.5;
    for (let b = 0; b < barbPositions.length; b++) {
      const bp = barbPositions[b] * spokeLen;
      const barbLen = (isMajor ? r * 0.16 : r * 0.10) * (1 - b * 0.22);
      ctx.beginPath();
      ctx.moveTo(bp, 0);
      ctx.lineTo(bp + barbLen * 0.62, -barbLen * 0.78);
      ctx.moveTo(bp, 0);
      ctx.lineTo(bp + barbLen * 0.62, barbLen * 0.78);
      ctx.stroke();
    }

    if (isMajor) {
      ctx.fillStyle = 'rgba(240, 249, 255, 0.96)';
      ctx.beginPath();
      ctx.moveTo(spokeLen + r * 0.08, 0);
      ctx.lineTo(spokeLen, -r * 0.032);
      ctx.lineTo(spokeLen - r * 0.05, 0);
      ctx.lineTo(spokeLen, r * 0.032);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  // 4. Kanji numerals around outer ring
  ctx.font = '700 22px "Noto Serif TC", "Yuji Syuku", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(224, 242, 254, 0.92)';
  for (let i = 0; i < 12; i++) {
    const angle = (i * Math.PI) / 6 + Math.PI / 12;
    const nr = r * 0.90;
    ctx.save();
    ctx.rotate(angle);
    ctx.translate(nr, 0);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(KANJI_NUMERALS[i], 0, 0);
    ctx.restore();
  }

  ctx.restore();
  return canvas;
}

function getCompassSprite(): HTMLCanvasElement | null {
  if (!fontListenerAttached && typeof document !== 'undefined' && document.fonts) {
    fontListenerAttached = true;
    void document.fonts.ready.then(() => {
      // Rebuild sprite once brush/serif web fonts finish loading
      cachedCompassSprite = buildCompassSprite();
    });
  }
  if (!cachedCompassSprite) {
    cachedCompassSprite = buildCompassSprite();
  }
  return cachedCompassSprite;
}

export interface CompassDrawOptions {
  ctx: CanvasRenderingContext2D;
  /** Screen-space X center (pixels). */
  cx: number;
  /** Screen-space Y floor anchor (pixels). */
  cy: number;
  /** Base horizontal radius (pixels) before unfold scaling. */
  radius: number;
  /** Unfold progress [0, 1] (drives crisp radial expansion). */
  unfold: number;
  /** Opacity / intensity [0, 1]. */
  intensity: number;
  /** Continuous elapsed time in seconds. */
  timeSec: number;
}

export function drawSnowflakeCompass({
  ctx,
  cx,
  cy,
  radius,
  unfold,
  intensity,
  timeSec,
}: CompassDrawOptions): void {
  if (intensity <= 0.01 || unfold <= 0.01) return;

  const sprite = getCompassSprite();
  if (!sprite) return;

  // Ease-out cubic unfold
  const eased = 1 - Math.pow(1 - Math.min(1, unfold), 3);
  const r = radius * (0.2 + 0.8 * eased);
  const scale = r / SPRITE_BASE_RADIUS;
  const perspectiveY = 0.30;
  const slowSpin = timeSec * 0.28;
  const counterSpin = -timeSec * 0.42;
  const pulse = 0.88 + 0.12 * Math.sin(timeSec * 5.2);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, perspectiveY);
  ctx.globalCompositeOperation = 'lighter';

  // 1. Single drawImage for the entire 12-point Snowflake Compass Needle
  ctx.save();
  ctx.rotate(slowSpin);
  ctx.globalAlpha = Math.min(1, intensity * pulse);
  const drawSize = SPRITE_SIZE * scale;
  ctx.drawImage(sprite, -drawSize * 0.5, -drawSize * 0.5, drawSize, drawSize);
  ctx.restore();

  // 2. Counter-rotating inner crystalline hexagram lattice (zero shadowBlur)
  ctx.save();
  ctx.rotate(counterSpin);
  ctx.strokeStyle = `rgba(147, 197, 253, ${0.72 * intensity})`;
  ctx.lineWidth = Math.max(1.3, r * 0.014);
  for (let offset = 0; offset < 2; offset++) {
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) {
      const a = (i * Math.PI) / 3 + (offset * Math.PI) / 6;
      const px = Math.cos(a) * r * 0.56;
      const py = Math.sin(a) * r * 0.56;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();

  ctx.restore();

  // 3. Soft vertical spirit sheen rising off the compass perimeter
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const pillarGrad = ctx.createLinearGradient(cx, cy, cx, cy - r * 0.85);
  pillarGrad.addColorStop(0, `rgba(56, 189, 248, ${0.18 * intensity * pulse})`);
  pillarGrad.addColorStop(0.5, `rgba(147, 197, 253, ${0.08 * intensity})`);
  pillarGrad.addColorStop(1, 'rgba(56, 189, 248, 0)');
  ctx.fillStyle = pillarGrad;
  ctx.beginPath();
  ctx.ellipse(cx, cy - r * 0.25, r * 0.72, r * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
