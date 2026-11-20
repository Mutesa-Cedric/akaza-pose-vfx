import type { PoseEvaluation } from '../cv/akazaPoseClassifier';
import type { PoseEngineInfo } from '../cv/poseLandmarker';

export interface TelemetrySnapshot {
  fps: number;
  inferenceMs: number;
  fxRenderMs: number;
  pose: PoseEvaluation;
  engineInfo: PoseEngineInfo | null;
}

interface TechHudProps {
  telemetry: TelemetrySnapshot;
  oneEuroEnabled: boolean;
  onToggleOneEuro: () => void;
}

const STATE_STYLES: Record<PoseEvaluation['state'], string> = {
  IDLE: 'bg-slate-800/90 text-slate-300 border-slate-600/60',
  CHARGING: 'bg-amber-500/20 text-amber-300 border-amber-400/60',
  ACTIVE: 'bg-cyan-500/25 text-cyan-200 border-cyan-400/80 shadow-[0_0_16px_rgba(56,189,248,0.45)]',
  DISSIPATING: 'bg-indigo-500/20 text-indigo-200 border-indigo-400/60',
};

function MetricBar({
  label,
  value,
  threshold,
  accent = 'bg-cyan-400',
}: {
  label: string;
  value: number;
  threshold?: number;
  accent?: string;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] font-mono">
        <span className="text-slate-300">{label}</span>
        <span className="text-slate-100 tabular-nums">{pct}%</span>
      </div>
      <div className="relative h-1.5 w-full rounded-full bg-slate-800/90 overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] duration-75 ${accent}`}
          style={{ width: `${pct}%` }}
        />
        {threshold !== undefined && (
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-white/80"
            style={{ left: `${threshold * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}

export function TechHud({ telemetry, oneEuroEnabled, onToggleOneEuro }: TechHudProps) {
  const { fps, inferenceMs, fxRenderMs, pose, engineInfo } = telemetry;

  return (
    <aside className="pointer-events-auto w-76 rounded-2xl border border-cyan-500/25 bg-slate-950/80 p-4 backdrop-blur-md shadow-2xl">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800/90 pb-2.5">
        <div>
          <p className="text-[10px] font-mono uppercase tracking-[0.16em] text-cyan-400">
            CV Telemetry HUD
          </p>
          <p className="text-xs text-slate-400">
            {engineInfo ? `${engineInfo.modelName} · ${engineInfo.delegate}` : 'Initializing…'}
          </p>
        </div>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-[10px] font-mono font-semibold tracking-wider ${STATE_STYLES[pose.state]}`}
        >
          {pose.state}
        </span>
      </div>

      {/* Pipeline Performance */}
      <div className="mt-3 grid grid-cols-4 gap-1.5 text-center font-mono">
        <div className="rounded-lg bg-slate-900/90 px-1.5 py-1.5 border border-slate-800">
          <div className="text-[9px] text-slate-400">FPS</div>
          <div className="text-xs font-semibold text-cyan-300 tabular-nums">{fps}</div>
        </div>
        <div className="rounded-lg bg-slate-900/90 px-1.5 py-1.5 border border-slate-800">
          <div className="text-[9px] text-slate-400">INFER</div>
          <div className="text-xs font-semibold text-emerald-300 tabular-nums">
            {inferenceMs.toFixed(1)}ms
          </div>
        </div>
        <div className="rounded-lg bg-slate-900/90 px-1.5 py-1.5 border border-slate-800">
          <div className="text-[9px] text-slate-400">FX</div>
          <div className="text-xs font-semibold text-sky-300 tabular-nums">
            {fxRenderMs.toFixed(1)}ms
          </div>
        </div>
        <div className="rounded-lg bg-slate-900/90 px-1.5 py-1.5 border border-slate-800">
          <div className="text-[9px] text-slate-400">MODE</div>
          <div className="text-[11px] font-semibold text-slate-200 leading-4">
            {pose.resolvedMode === 'full-body' ? 'FULL' : 'DESK'}
          </div>
        </div>
      </div>

      {/* Pose Heuristics Breakdown */}
      <div className="mt-3.5 space-y-2.5">
        <MetricBar
          label="Combined Score (≥62%)"
          value={pose.rawConfidence}
          threshold={0.62}
          accent={pose.rawConfidence >= 0.62 ? 'bg-cyan-300' : 'bg-sky-500'}
        />
        <div className="h-px bg-slate-800/80" />
        <MetricBar
          label={pose.resolvedMode === 'full-body' ? 'Wide Horse Stance' : 'Elbow Spread'}
          value={pose.subScores.stanceWidth}
          accent="bg-sky-400"
        />
        <MetricBar
          label={pose.resolvedMode === 'full-body' ? 'Low Crouch Depth' : 'Stance Asymmetry'}
          value={pose.subScores.squatDepth}
          accent="bg-sky-400"
        />
        <MetricBar
          label="Lead Fist Guard (High)"
          value={pose.subScores.leadArmGuard}
          accent="bg-indigo-400"
        />
        <MetricBar
          label="Rear Fist Chamber (Low)"
          value={pose.subScores.rearArmChamber}
          accent="bg-indigo-400"
        />
        <MetricBar
          label="Soryu Arm Asymmetry"
          value={pose.subScores.armAsymmetry}
          accent="bg-violet-400"
        />
      </div>

      {/* Signal Processing Control */}
      <div className="mt-3.5 flex items-center justify-between border-t border-slate-800/90 pt-3">
        <div>
          <div className="text-[11px] font-mono text-slate-200">One-Euro Filter</div>
          <div className="text-[10px] text-slate-400">Adaptive jitter suppression</div>
        </div>
        <button
          type="button"
          onClick={onToggleOneEuro}
          className={`rounded-full px-2.5 py-1 text-[11px] font-mono font-semibold transition cursor-pointer ${
            oneEuroEnabled
              ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-400/60'
              : 'bg-slate-800 text-slate-400 border border-slate-700'
          }`}
        >
          {oneEuroEnabled ? 'ON' : 'RAW'}
        </button>
      </div>

      <div className="mt-2 flex items-center justify-between text-[10px] font-mono text-slate-400">
        <span>Lead Side: {pose.stanceSide}</span>
        <span>Wrist v: {pose.wristSpeed.toFixed(2)}</span>
      </div>
    </aside>
  );
}
