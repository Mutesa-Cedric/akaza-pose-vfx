/**
 * High-performance procedural renderer for Akaza's 12-point Snowflake Compass Needle
 * (破壊殺・羅針), projected onto the ground plane in 3D perspective beneath the user's feet.
 *
 * Performance architecture:
 *  - Intricate faceted geometry (12 beveled crystal diamond blades, dual-tone facets,
 *    specular spines, archaic kanji numerals) is pre-baked ONCE into an offscreen 800×800
 *    canvas with bloom baked in.
 *  - 3-Phase Deployment Kinematics:
 *      1. Ground impact ring expansion on activation.
 *      2. Elastic radial blade unfurl with crisp subtle overshoot (1 + 0.08 * exp(-8t) * cos(16t)).
 *      3. Clockwise sequential kanji luminescence shimmer + grounded icy floor specular bloom.
 *  - STRICTLY ZERO per-frame `ctx.shadowBlur` calls for locked 60fps (< 0.4ms cost).
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

const SPRITE_SIZE = 800;
const SPRITE_HALF = SPRITE_SIZE / 2;
const SPRITE_BASE_RADIUS = 310;

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

  // 1. Soft radial floor glow baked into offscreen canvas
  const floorGlow = ctx.createRadialGradient(0, 0, r * 0.05, 0, 0, r * 1.25);
  floorGlow.addColorStop(0, 'rgba(224, 242, 254, 0.48)');
  floorGlow.addColorStop(0.28, 'rgba(56, 189, 248, 0.36)');
  floorGlow.addColorStop(0.62, 'rgba(14, 165, 233, 0.18)');
  floorGlow.addColorStop(0.88, 'rgba(30, 58, 138, 0.06)');
  floorGlow.addColorStop(1, 'rgba(6, 8, 24, 0)');
  ctx.fillStyle = floorGlow;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.25, 0, Math.PI * 2);
  ctx.fill();

  // Bake crisp azure-cyan bloom into the offscreen sprite once
  ctx.shadowColor = 'rgba(56, 189, 248, 0.95)';
  ctx.shadowBlur = 22;

  // 2. Concentric geometric crystal rings
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.92)';
  ctx.lineWidth = 4.8;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.97, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(224, 242, 254, 0.85)';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.86, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(56, 189, 248, 0.75)';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.76, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(186, 230, 253, 0.92)';
  ctx.lineWidth = 3.6;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.32, 0, Math.PI * 2);
  ctx.stroke();

  // Fine notched ticks along outer rim
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = 'rgba(224, 242, 254, 0.7)';
  for (let t = 0; t < 72; t++) {
    const a = (t * Math.PI) / 36;
    const isMajorTick = t % 6 === 0;
    const len = isMajorTick ? r * 0.045 : r * 0.022;
    const rOuter = r * 0.97;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * (rOuter - len), Math.sin(a) * (rOuter - len));
    ctx.lineTo(Math.cos(a) * rOuter, Math.sin(a) * rOuter);
    ctx.stroke();
  }

  // 3. 12-point Snowflake Needle Spokes (6 major + 6 interleaved blades)
  // Beveled faceted ice-crystal diamond blades:
  //   - Dual-tone left/right crystal facets (#0ea5e9 / #e0f2fe)
  //   - Razor #ffffff specular ridge
  //   - Diamond-faceted V-barbs
  for (let i = 0; i < 12; i++) {
    const angle = (i * Math.PI) / 6;
    const isMajor = i % 2 === 0;
    const spokeLen = isMajor ? r * 1.15 : r * 0.90;
    const halfWidth = isMajor ? r * 0.052 : r * 0.032;
    const baseR = r * 0.12;
    const midR = spokeLen * 0.44;

    ctx.save();
    ctx.rotate(angle);

    // Left crystal facet (#0ea5e9 shadow / deep tone)
    const leftGrad = ctx.createLinearGradient(baseR, -halfWidth, spokeLen, 0);
    leftGrad.addColorStop(0, '#0284c7');
    leftGrad.addColorStop(0.45, '#0ea5e9');
    leftGrad.addColorStop(1, '#38bdf8');
    ctx.fillStyle = leftGrad;
    ctx.beginPath();
    ctx.moveTo(baseR, 0);
    ctx.lineTo(midR, -halfWidth);
    ctx.lineTo(spokeLen, 0);
    ctx.closePath();
    ctx.fill();

    // Right crystal facet (#e0f2fe highlight / light tone)
    const rightGrad = ctx.createLinearGradient(baseR, 0, spokeLen, halfWidth);
    rightGrad.addColorStop(0, '#bae6fd');
    rightGrad.addColorStop(0.5, '#e0f2fe');
    rightGrad.addColorStop(1, '#ffffff');
    ctx.fillStyle = rightGrad;
    ctx.beginPath();
    ctx.moveTo(baseR, 0);
    ctx.lineTo(midR, halfWidth);
    ctx.lineTo(spokeLen, 0);
    ctx.closePath();
    ctx.fill();

    // Razor #ffffff specular center ridge
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = isMajor ? 2.8 : 1.8;
    ctx.beginPath();
    ctx.moveTo(baseR, 0);
    ctx.lineTo(spokeLen * 1.02, 0);
    ctx.stroke();

    // Diamond-faceted V-barbs
    const barbPositions = isMajor ? [0.42, 0.64, 0.82] : [0.52, 0.72];
    for (let b = 0; b < barbPositions.length; b++) {
      const bp = barbPositions[b] * spokeLen;
      const barbLen = (isMajor ? r * 0.17 : r * 0.11) * (1 - b * 0.2);
      const barbW = barbLen * 0.24;

      // Left barb facet (angled backward chevron)
      ctx.fillStyle = '#0ea5e9';
      ctx.beginPath();
      ctx.moveTo(bp, 0);
      ctx.lineTo(bp + barbLen * 0.58, -barbLen * 0.82);
      ctx.lineTo(bp + barbLen * 0.58 - barbW, -barbLen * 0.82 + barbW * 0.5);
      ctx.lineTo(bp - barbW * 0.6, 0);
      ctx.closePath();
      ctx.fill();

      // Right barb facet
      ctx.fillStyle = '#e0f2fe';
      ctx.beginPath();
      ctx.moveTo(bp, 0);
      ctx.lineTo(bp + barbLen * 0.58, barbLen * 0.82);
      ctx.lineTo(bp + barbLen * 0.58 - barbW, barbLen * 0.82 - barbW * 0.5);
      ctx.lineTo(bp - barbW * 0.6, 0);
      ctx.closePath();
      ctx.fill();

      // Specular ridge down each barb
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.lineWidth = isMajor ? 1.6 : 1.1;
      ctx.beginPath();
      ctx.moveTo(bp, 0);
      ctx.lineTo(bp + barbLen * 0.58, -barbLen * 0.82);
      ctx.moveTo(bp, 0);
      ctx.lineTo(bp + barbLen * 0.58, barbLen * 0.82);
      ctx.stroke();
    }

    // Faceted diamond spear tip for major blades
    if (isMajor) {
      const tipL = spokeLen + r * 0.085;
      const tipW = r * 0.038;
      // Left facet of diamond spearhead
      ctx.fillStyle = '#0ea5e9';
      ctx.beginPath();
      ctx.moveTo(spokeLen - r * 0.04, 0);
      ctx.lineTo(spokeLen, -tipW);
      ctx.lineTo(tipL, 0);
      ctx.closePath();
      ctx.fill();

      // Right facet of diamond spearhead
      ctx.fillStyle = '#e0f2fe';
      ctx.beginPath();
      ctx.moveTo(spokeLen - r * 0.04, 0);
      ctx.lineTo(spokeLen, tipW);
      ctx.lineTo(tipL, 0);
      ctx.closePath();
      ctx.fill();

      // Specular diamond ridge
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(spokeLen - r * 0.04, 0);
      ctx.lineTo(tipL, 0);
      ctx.stroke();
    }

    ctx.restore();
  }

  // 4. Archaic Kanji numerals around outer ring (壱 - 拾弐)
  ctx.font = '700 24px "Noto Serif TC", "Yuji Syuku", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(224, 242, 254, 0.96)';
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

export function getCompassSprite(): HTMLCanvasElement | null {
  if (!fontListenerAttached && typeof document !== 'undefined' && document.fonts) {
    fontListenerAttached = true;
    void document.fonts.ready.then(() => {
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
  /** Optional active duration in seconds for kinematics. */
  activeTime?: number;
}

export function drawSnowflakeCompass({
  ctx,
  cx,
  cy,
  radius,
  unfold,
  intensity,
  timeSec,
  activeTime,
}: CompassDrawOptions): void {
  if (intensity <= 0.01 || unfold <= 0.01) return;

  const sprite = getCompassSprite();
  if (!sprite) return;

  const tUnfold = Math.min(1, Math.max(0, unfold));
  // 3-Phase Kinematics Phase 2: Elastic radial blade unfurl with crisp subtle overshoot
  // Formula: 1 + 0.08 * exp(-8t) * cos(16t)
  const overshoot = 1 + 0.08 * Math.exp(-8 * tUnfold) * Math.cos(16 * tUnfold);
  const deploymentScale = tUnfold >= 0.999 ? 1.0 : tUnfold * overshoot;
  const r = radius * (0.16 + 0.84 * deploymentScale);
  const scale = r / SPRITE_BASE_RADIUS;
  const perspectiveY = 0.28;
  const slowSpin = timeSec * 0.24;
  const counterSpin = -timeSec * 0.38;
  const pulse = 0.88 + 0.12 * Math.sin(timeSec * 5.2);

  const actTime = activeTime ?? (tUnfold < 1 ? tUnfold * 0.5 : timeSec);

  // -------------------------------------------------------------------------
  // Phase 1: Ground impact ring expansion on activation
  // -------------------------------------------------------------------------
  if (actTime < 0.65) {
    const impactProgress = actTime / 0.65;
    const impactR = radius * (0.2 + 1.25 * (1 - Math.exp(-impactProgress * 5.5)));
    const impactAlpha = Math.max(0, (1 - impactProgress) * (1 - impactProgress) * intensity * 0.85);
    if (impactAlpha > 0.01) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, perspectiveY);
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(186, 230, 253, ${impactAlpha})`;
      ctx.lineWidth = Math.max(1.8, radius * 0.02 * (1 - impactProgress * 0.7));
      ctx.beginPath();
      ctx.arc(0, 0, impactR, 0, Math.PI * 2);
      ctx.stroke();

      // Outer faint shock ring
      ctx.strokeStyle = `rgba(56, 189, 248, ${impactAlpha * 0.5})`;
      ctx.lineWidth = Math.max(1, radius * 0.04 * (1 - impactProgress));
      ctx.beginPath();
      ctx.arc(0, 0, impactR * 1.08, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // -------------------------------------------------------------------------
  // Phase 3a: Grounded icy floor specular bloom underneath (anchored in 3D)
  // -------------------------------------------------------------------------
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, perspectiveY);
  ctx.globalCompositeOperation = 'lighter';

  const floorBloom = ctx.createRadialGradient(0, 0, r * 0.08, 0, 0, r * 1.15);
  floorBloom.addColorStop(0, `rgba(224, 242, 254, ${0.32 * intensity * pulse})`);
  floorBloom.addColorStop(0.35, `rgba(56, 189, 248, ${0.22 * intensity})`);
  floorBloom.addColorStop(0.72, `rgba(14, 165, 233, ${0.08 * intensity})`);
  floorBloom.addColorStop(1, 'rgba(6, 8, 24, 0)');
  ctx.fillStyle = floorBloom;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.15, 0, Math.PI * 2);
  ctx.fill();

  // Subtle grounded crystal lattice facets on the floor
  ctx.strokeStyle = `rgba(186, 230, 253, ${0.28 * intensity})`;
  ctx.lineWidth = 1.2;
  for (let s = 0; s < 6; s++) {
    const a = (s * Math.PI) / 3 + slowSpin;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95);
    ctx.stroke();
  }
  ctx.restore();

  // -------------------------------------------------------------------------
  // Main Pre-Baked 800×800 Crystalline Snowflake Compass Sprite
  // -------------------------------------------------------------------------
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, perspectiveY);
  ctx.globalCompositeOperation = 'lighter';

  ctx.save();
  ctx.rotate(slowSpin);
  ctx.globalAlpha = Math.min(1, intensity * pulse);
  const drawSize = SPRITE_SIZE * scale;
  ctx.drawImage(sprite, -drawSize * 0.5, -drawSize * 0.5, drawSize, drawSize);
  ctx.restore();

  // Counter-rotating inner crystalline hexagram lattice (zero shadowBlur)
  ctx.save();
  ctx.rotate(counterSpin);
  ctx.strokeStyle = `rgba(147, 197, 253, ${0.78 * intensity})`;
  ctx.lineWidth = Math.max(1.4, r * 0.015);
  for (let offset = 0; offset < 2; offset++) {
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) {
      const a = (i * Math.PI) / 3 + (offset * Math.PI) / 6;
      const px = Math.cos(a) * r * 0.58;
      const py = Math.sin(a) * r * 0.58;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();

  // -------------------------------------------------------------------------
  // Phase 3b: Clockwise sequential kanji luminescence shimmer
  // -------------------------------------------------------------------------
  const kanjiIndex = ((Math.floor(timeSec * 3.8) % 12) + 12) % 12;
  const kanjiAngle = slowSpin + (kanjiIndex * Math.PI) / 6 + Math.PI / 12;
  const kx = Math.cos(kanjiAngle) * r * 0.90;
  const ky = Math.sin(kanjiAngle) * r * 0.90;

  // Luminous diamond crystal glint at the active sequential kanji
  const glintR = Math.max(3.5, r * 0.04);
  ctx.fillStyle = `rgba(255, 255, 255, ${0.95 * intensity})`;
  ctx.beginPath();
  ctx.moveTo(kx, ky - glintR * 1.6);
  ctx.lineTo(kx + glintR * 0.35, ky - glintR * 0.35);
  ctx.lineTo(kx + glintR * 1.6, ky);
  ctx.lineTo(kx + glintR * 0.35, ky + glintR * 0.35);
  ctx.lineTo(kx, ky + glintR * 1.6);
  ctx.lineTo(kx - glintR * 0.35, ky + glintR * 0.35);
  ctx.lineTo(kx - glintR * 1.6, ky);
  ctx.lineTo(kx - glintR * 0.35, ky - glintR * 0.35);
  ctx.closePath();
  ctx.fill();

  ctx.restore();

  // -------------------------------------------------------------------------
  // Grounded vertical spirit pillar sheen rising off perimeter
  // -------------------------------------------------------------------------
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const pillarGrad = ctx.createLinearGradient(cx, cy, cx, cy - r * 0.9);
  pillarGrad.addColorStop(0, `rgba(56, 189, 248, ${0.20 * intensity * pulse})`);
  pillarGrad.addColorStop(0.45, `rgba(147, 197, 253, ${0.09 * intensity})`);
  pillarGrad.addColorStop(1, 'rgba(56, 189, 248, 0)');
  ctx.fillStyle = pillarGrad;
  ctx.beginPath();
  ctx.ellipse(cx, cy - r * 0.22, r * 0.75, r * 0.36, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
