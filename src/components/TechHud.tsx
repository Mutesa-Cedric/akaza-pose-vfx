import type { PoseEvaluation, TriggerMode } from '../cv/akazaPoseClassifier';
import type { PoseEngineInfo } from '../cv/poseLandmarker';

export interface TelemetrySnapshot {
  fps: number;
  inferenceMs: number;
  maskMs: number;
  fxRenderMs: number;
  pose: PoseEvaluation;
  /** Number of people MediaPipe detected this frame (0..numPoses). */
  subjectCount: number;
  /** Candidates rejected by the center-zone / completeness gate. */
  ignoredCount: number;
  engineInfo: PoseEngineInfo | null;
  renderer: string;
}

interface TechHudProps {
  telemetry: TelemetrySnapshot;
  entryThreshold: number;
  triggerMode: TriggerMode;
  oneEuroEnabled: boolean;
  onToggleOneEuro: () => void;
}

const STATE_BADGE: Record<PoseEvaluation['state'], string> = {
  IDLE: 'border-white/10 text-slate-400 bg-white/5',
  CHARGING: 'border-[#38bdf8]/50 text-slate-200 bg-[#38bdf8]/10',
  ACTIVE: 'border-[#38bdf8] text-[#38bdf8] bg-[#38bdf8]/15',
  DISSIPATING: 'border-white/15 text-slate-300 bg-white/5',
};

function HairlineMetric({
  label,
  value,
  threshold,
}: {
  label: string;
  value: number;
  threshold?: number;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const isActive = threshold !== undefined ? value >= threshold : value >= 0.5;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] font-mono">
        <span className="text-slate-400 tracking-wider">{label}</span>
        <span className="tabular-nums text-slate-200">{pct}%</span>
      </div>
      <div className="relative h-1 w-full rounded-none bg-white/5 overflow-hidden">
        <div
          className={`h-full transition-[width] duration-75 ${
            isActive ? 'bg-[#38bdf8]' : 'bg-slate-500'
          }`}
          style={{ width: `${pct}%` }}
        />
        {threshold !== undefined && (
          <div
            className="absolute top-0 bottom-0 w-[1px] bg-white z-10"
            style={{ left: `${threshold * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}

export function TechHud({ telemetry, entryThreshold, triggerMode, oneEuroEnabled, onToggleOneEuro }: TechHudProps) {
  const { fps, inferenceMs, maskMs, fxRenderMs, pose, subjectCount, ignoredCount, engineInfo, renderer } = telemetry;

  return (
    <aside className="pointer-events-auto w-72 rounded-xl border border-white/10 bg-[#030611]/90 p-3.5 backdrop-blur-md shadow-2xl select-none">
      {/* Header telemetry band */}
      <div className="flex items-center justify-between gap-2 border-b border-white/5 pb-2.5">
        <div>
          <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-400">
            CINEALTA TELEMETRY
          </p>
          <p className="text-[11px] font-mono text-slate-300 truncate max-w-[170px]">
            {engineInfo ? `${engineInfo.modelName} · ${engineInfo.delegate.toUpperCase()}` : 'INITIALIZING…'}
          </p>
          <p className="text-[10px] font-mono text-slate-400">{renderer}</p>
        </div>
        <span
          className={`rounded border px-2 py-0.5 text-[9px] font-mono font-medium tracking-widest ${STATE_BADGE[pose.state]}`}
        >
          {pose.state}
        </span>
      </div>

      <div className="mt-2.5 grid grid-cols-4 gap-1.5 font-mono text-center">
        <div className="rounded border border-white/5 bg-[#070b14]/80 py-1.5 px-1">
          <div className="text-[8px] text-slate-500 tracking-widest uppercase">FPS</div>
          <div className="text-xs font-medium text-slate-100 tabular-nums">{fps}</div>
        </div>
        <div className="rounded border border-white/5 bg-[#070b14]/80 py-1.5 px-1">
          <div className="text-[8px] text-slate-500 tracking-widest uppercase">INFER</div>
          <div className="text-xs font-medium text-slate-100 tabular-nums">
            {inferenceMs.toFixed(1)}ms
          </div>
        </div>
        <div className="rounded border border-white/5 bg-[#070b14]/80 py-1.5 px-1">
          <div className="text-[8px] text-slate-500 tracking-widest uppercase">MATTE</div>
          <div className="text-xs font-medium text-slate-100 tabular-nums">
            {maskMs.toFixed(1)}ms
          </div>
        </div>
        <div className="rounded border border-white/5 bg-[#070b14]/80 py-1.5 px-1">
          <div className="text-[8px] text-slate-500 tracking-widest uppercase">FX SUBMIT</div>
          <div className="text-xs font-medium text-slate-100 tabular-nums">
            {fxRenderMs.toFixed(1)}ms
          </div>
        </div>
      </div>

      {/* Combined stance score hairline bar with sharp dynamic threshold tick */}
      <div className="mt-3 pt-2 border-t border-white/5">
        <HairlineMetric
          label={`STANCE LOCK GATE (${Math.round(entryThreshold * 100)}%)`}
          value={pose.rawConfidence}
          threshold={entryThreshold}
        />
      </div>

      {/* 4 monochrome/cyan sub-score hairlines */}
      <div className="mt-2.5 space-y-2 border-t border-white/5 pt-2.5">
        <HairlineMetric
          label="HORSE STANCE"
          value={pose.subScores.stanceWidth}
        />
        <HairlineMetric
          label="CROUCH DEPTH"
          value={pose.subScores.squatDepth}
        />
        <HairlineMetric
          label="LEAD GUARD"
          value={pose.subScores.leadArmGuard}
        />
        <HairlineMetric
          label="REAR CHAMBER"
          value={pose.subScores.rearArmChamber}
        />
      </div>

      {/* 1€ Filter toggle control */}
      <div className="mt-3 flex items-center justify-between border-t border-white/5 pt-2.5">
        <button
          type="button"
          onClick={onToggleOneEuro}
          className={`w-full rounded border py-1.5 text-[10px] font-mono tracking-wider transition cursor-pointer ${
            oneEuroEnabled
              ? 'border-[#38bdf8]/40 bg-[#38bdf8]/10 text-[#38bdf8] hover:bg-[#38bdf8]/20'
              : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'
          }`}
        >
          {oneEuroEnabled ? '1€ FILTER: ACTIVE' : '1€ FILTER: BYPASS'}
        </button>
      </div>

      {/* Subject tracking status, stance orientation & wrist speed */}
      <div className="mt-2 flex items-center justify-between text-[9px] font-mono text-slate-500 pt-1">
        <span>
          {!pose.hasPerson
            ? 'NO SUBJECT'
            : subjectCount <= 1
              ? 'CENTER LOCK'
              : `TRACKED 1/${subjectCount}`}
        </span>
        {ignoredCount > 0 && (
          <span className="text-slate-600">IGNORED: {ignoredCount}</span>
        )}
        <span>LEAD: {pose.stanceSide.toUpperCase()}</span>
        {triggerMode === 'burst' && (
          <span className="rounded border border-[#38bdf8]/40 bg-[#38bdf8]/10 px-1 text-[#38bdf8]">
            BURST
          </span>
        )}
        <span className="tabular-nums">WRIST V: {pose.wristSpeed.toFixed(2)}</span>
      </div>
    </aside>
  );
}
