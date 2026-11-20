import type { Landmark3D } from '../cv/oneEuroFilter';
import { POSE_CONNECTIONS, POSE_IDX } from '../cv/poseLandmarker';
import type { PoseEvaluation } from '../cv/akazaPoseClassifier';

export interface VideoViewportRect {
  offsetX: number;
  offsetY: number;
  drawWidth: number;
  drawHeight: number;
}

/**
 * Sony CineAlta monochrome + pure ice-cyan CV telemetry skeleton overlay:
 *  - Thin 1.5px #94a3b8 slate bones
 *  - Crisp #38bdf8 active joints
 *  - Minimalist #38bdf8 / #a78bfa lead & rear fist reticles
 *  - Razor floor anchor reticle
 *  - Zero visual clutter
 */
export function drawDebugSkeleton(
  ctx: CanvasRenderingContext2D,
  smoothed: Landmark3D[] | null,
  raw: Landmark3D[] | null,
  pose: PoseEvaluation,
  rect: VideoViewportRect,
  mirrored: boolean,
): void {
  const toScreen = (nx: number, ny: number) => ({
    x: rect.offsetX + (mirrored ? 1 - nx : nx) * rect.drawWidth,
    y: rect.offsetY + ny * rect.drawHeight,
  });

  ctx.save();

  // 1. Raw landmarks (ultra-faint hairline dots for CV jitter reference)
  if (raw && raw.length >= 29) {
    ctx.fillStyle = 'rgba(244, 114, 182, 0.28)';
    for (let i = 11; i < 29; i++) {
      const lm = raw[i];
      if (!lm || (lm.visibility ?? 1) < 0.25) continue;
      const p = toScreen(lm.x, lm.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 2. Sony CineAlta monochrome bone skeleton with ice-cyan active joints
  if (smoothed && smoothed.length >= 29) {
    // Thin 1.5px #94a3b8 bones
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const [a, b] of POSE_CONNECTIONS) {
      const la = smoothed[a];
      const lb = smoothed[b];
      if (!la || !lb || (la.visibility ?? 1) < 0.25 || (lb.visibility ?? 1) < 0.25) continue;
      const pa = toScreen(la.x, la.y);
      const pb = toScreen(lb.x, lb.y);
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();

    // Crisp #38bdf8 active joints
    for (let i = 11; i < 33; i++) {
      const lm = smoothed[i];
      if (!lm || (lm.visibility ?? 1) < 0.25) continue;
      const p = toScreen(lm.x, lm.y);
      ctx.fillStyle = '#0f172a';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Lead & Rear fist reticles
    const drawFistMarker = (nx: number, ny: number, label: string, color: string) => {
      const p = toScreen(nx, ny);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = '600 9px "JetBrains Mono", monospace';
      ctx.fillStyle = color;
      ctx.fillText(label, p.x + 12, p.y + 3);
    };

    drawFistMarker(pose.leadWrist.x, pose.leadWrist.y, 'LEAD', '#38bdf8');
    drawFistMarker(pose.rearWrist.x, pose.rearWrist.y, 'REAR', '#a78bfa');

    // Stance base vector between ankles
    const lAnk = smoothed[POSE_IDX.LEFT_ANKLE];
    const rAnk = smoothed[POSE_IDX.RIGHT_ANKLE];
    if (lAnk && rAnk && (lAnk.visibility ?? 1) > 0.3 && (rAnk.visibility ?? 1) > 0.3) {
      const pa = toScreen(lAnk.x, lAnk.y);
      const pb = toScreen(rAnk.x, rAnk.y);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 3. Crisp Floor Compass anchor reticle
  if (pose.hasPerson) {
    const fp = toScreen(pose.floorAnchor.x, pose.floorAnchor.y);

    // Crosshairs
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(fp.x - 8, fp.y);
    ctx.lineTo(fp.x + 8, fp.y);
    ctx.moveTo(fp.x, fp.y - 8);
    ctx.lineTo(fp.x, fp.y + 8);
    ctx.stroke();

    // Floor targeting tick ring
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.ellipse(fp.x, fp.y, 14, 5, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '600 9px "JetBrains Mono", monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('ANCHOR', fp.x + 12, fp.y + 3);
  }

  ctx.restore();
}
