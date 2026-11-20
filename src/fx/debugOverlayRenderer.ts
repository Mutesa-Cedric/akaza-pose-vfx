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
 * Renders an engineer-facing CV telemetry overlay directly onto the stage canvas:
 *  - Raw MediaPipe landmarks (subtle magenta dots) vs. One-Euro smoothed skeleton (cyan)
 *  - Lead & rear fist tracking highlights
 *  - Floor Compass anchor reticle
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

  // 1. Raw landmarks (faint rose dots to visually contrast against One-Euro smoothed joints)
  if (raw && raw.length >= 29) {
    ctx.fillStyle = 'rgba(244, 114, 182, 0.55)';
    for (let i = 11; i < 29; i++) {
      const lm = raw[i];
      if (!lm || (lm.visibility ?? 1) < 0.25) continue;
      const p = toScreen(lm.x, lm.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 2. One-Euro smoothed skeleton
  if (smoothed && smoothed.length >= 29) {
    const activeColor =
      pose.state === 'ACTIVE'
        ? '#38bdf8'
        : pose.state === 'CHARGING'
          ? '#facc15'
          : '#22d3ee';

    ctx.strokeStyle = activeColor;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
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

    // Joint nodes
    for (let i = 11; i < 33; i++) {
      const lm = smoothed[i];
      if (!lm || (lm.visibility ?? 1) < 0.25) continue;
      const p = toScreen(lm.x, lm.y);
      ctx.fillStyle = '#0f172a';
      ctx.strokeStyle = activeColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Highlight lead & rear fists
    const drawMarker = (nx: number, ny: number, label: string, color: string) => {
      const p = toScreen(nx, ny);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
      ctx.stroke();

      ctx.font = '600 10px "JetBrains Mono", monospace';
      ctx.fillStyle = color;
      ctx.fillText(label, p.x + 14, p.y + 3);
    };

    drawMarker(pose.leadWrist.x, pose.leadWrist.y, 'LEAD', '#38bdf8');
    drawMarker(pose.rearWrist.x, pose.rearWrist.y, 'REAR', '#a78bfa');

    // Stance width vector between ankles
    const lAnk = smoothed[POSE_IDX.LEFT_ANKLE];
    const rAnk = smoothed[POSE_IDX.RIGHT_ANKLE];
    if (lAnk && rAnk && (lAnk.visibility ?? 1) > 0.3 && (rAnk.visibility ?? 1) > 0.3) {
      const pa = toScreen(lAnk.x, lAnk.y);
      const pb = toScreen(rAnk.x, rAnk.y);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.8)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 3. Floor compass anchor reticle
  if (pose.hasPerson) {
    const fp = toScreen(pose.floorAnchor.x, pose.floorAnchor.y);
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(fp.x - 10, fp.y);
    ctx.lineTo(fp.x + 10, fp.y);
    ctx.moveTo(fp.x, fp.y - 10);
    ctx.lineTo(fp.x, fp.y + 10);
    ctx.stroke();
    ctx.font = '600 10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText('COMPASS ANCHOR', fp.x + 12, fp.y + 4);
  }

  ctx.restore();
}
