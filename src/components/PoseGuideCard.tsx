import { X } from 'lucide-react';
import type { PoseState } from '../cv/akazaPoseClassifier';

interface PoseGuideCardProps {
  poseState: PoseState;
  resolvedMode: 'full-body' | 'upper-body';
  chargeProgress: number;
  onDismiss: () => void;
}

export function PoseGuideCard({
  poseState,
  resolvedMode,
  chargeProgress,
  onDismiss,
}: PoseGuideCardProps) {
  const isHidden = poseState === 'ACTIVE';

  return (
    <div
      className={`pointer-events-auto transition-all duration-500 ${
        isHidden ? 'opacity-0 scale-95 pointer-events-none' : 'opacity-100 scale-100'
      }`}
    >
      <div className="w-64 rounded-2xl border border-cyan-400/20 bg-slate-950/75 p-3.5 backdrop-blur-md shadow-xl">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.16em] text-cyan-300/90">
              Pose Trigger Guide
            </p>
            <h3 className="text-sm font-semibold text-slate-100 mt-0.5">
              Akaza Soryu Stance
            </h3>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Hide pose guide"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Clean SVG Akaza stance silhouette */}
        <div className="my-2.5 flex items-center justify-center rounded-xl bg-slate-900/75 py-2.5 border border-slate-800/80">
          <svg
            viewBox="0 0 180 124"
            className="h-24 w-40"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Floor Compass Hint */}
            <ellipse
              cx="90"
              cy="108"
              rx="62"
              ry="11"
              stroke="rgba(56,189,248,0.45)"
              strokeWidth="1.4"
              strokeDasharray="4 3"
            />
            <ellipse
              cx="90"
              cy="108"
              rx="32"
              ry="5.5"
              stroke="rgba(186,230,253,0.45)"
              strokeWidth="1"
            />
            {/* Head */}
            <circle cx="90" cy="24" r="10" stroke="#e0f2fe" strokeWidth="2.4" fill="rgba(56,189,248,0.12)" />
            {/* Torso */}
            <path d="M90 34 L90 66" stroke="#e0f2fe" strokeWidth="2.8" strokeLinecap="round" />
            {/* Shoulders */}
            <path d="M72 42 L108 42" stroke="#e0f2fe" strokeWidth="2.4" strokeLinecap="round" />
            {/* Lead Arm (Raised High Forward Guard) */}
            <path
              d="M108 42 L126 44 L138 30"
              stroke="#38bdf8"
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="139" cy="29" r="5" fill="#7dd3fc" />
            {/* Rear Arm (Chambered Low at Waist/Hip) */}
            <path
              d="M72 42 L58 58 L66 69"
              stroke="#a78bfa"
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="67" cy="69" r="4.5" fill="#c4b5fd" />
            {/* Wide Crouched Legs */}
            <path
              d="M90 66 L64 81 L54 106"
              stroke="#e0f2fe"
              strokeWidth="2.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M90 66 L116 81 L126 106"
              stroke="#e0f2fe"
              strokeWidth="2.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <ul className="space-y-1 text-[11px] text-slate-300 leading-relaxed">
          {resolvedMode === 'full-body' ? (
            <>
              <li className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shrink-0" />
                <span>Step wide &amp; drop into a low crouch</span>
              </li>
              <li className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-sky-400 shrink-0" />
                <span>Raise one fist forward at chest/shoulder</span>
              </li>
              <li className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-violet-400 shrink-0" />
                <span>Pull opposite fist low by your hip</span>
              </li>
            </>
          ) : (
            <>
              <li className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shrink-0" />
                <span>Desk Mode active (lower body off-camera)</span>
              </li>
              <li className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-sky-400 shrink-0" />
                <span>Raise one fist up in front of shoulder</span>
              </li>
              <li className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-violet-400 shrink-0" />
                <span>Chamber the other fist low by waist</span>
              </li>
            </>
          )}
        </ul>

        {/* Subtle charge indicator bar */}
        <div className="mt-2.5 h-1 w-full rounded-full bg-slate-800 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-sky-400 to-cyan-200 transition-[width] duration-75"
            style={{ width: `${Math.round(chargeProgress * 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}
