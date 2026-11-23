import { X } from 'lucide-react';
import type { PoseState } from '../cv/akazaPoseClassifier';

interface PoseGuideCardProps {
  poseState: PoseState;
  chargeProgress: number;
  onDismiss: () => void;
}

export function PoseGuideCard({
  poseState,
  chargeProgress,
  onDismiss,
}: PoseGuideCardProps) {
  const isHidden = poseState === 'ACTIVE';

  return (
    <div
      className={`pointer-events-auto transition-all duration-500 ease-editorial ${
        isHidden ? 'opacity-0 translate-y-1 pointer-events-none' : 'opacity-100 translate-y-0'
      }`}
    >
      <div className="w-64 rounded-xl border border-white/10 bg-[#030611]/90 p-3.5 backdrop-blur-md shadow-2xl">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-400">
              STANCE SCHEMATIC
            </p>
            <h3 className="text-xs font-semibold text-[#f8fafc] mt-0.5">
              Soryu Destructive Form
            </h3>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss stance guide"
            className="rounded p-1 text-slate-400 hover:text-[#f8fafc] hover:bg-white/5 transition cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Single-weight monochrome #94a3b8 hairline SVG Soryu stance schematic */}
        <div className="my-2.5 flex items-center justify-center rounded-lg bg-[#070b14]/80 py-2 border border-white/5">
          <svg
            viewBox="0 0 180 120"
            className="h-24 w-36"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Subtle dashed floor line */}
            <line
              x1="24"
              y1="102"
              x2="156"
              y2="102"
              stroke="#94a3b8"
              strokeOpacity="0.22"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            {/* Floor compass hint */}
            <ellipse
              cx="90"
              cy="102"
              rx="46"
              ry="6"
              stroke="#94a3b8"
              strokeOpacity="0.15"
              strokeWidth="1"
              strokeDasharray="4 3"
            />

            {/* Head */}
            <circle cx="90" cy="22" r="7.5" stroke="#94a3b8" strokeWidth="1.25" />

            {/* Spine */}
            <line x1="90" y1="29.5" x2="90" y2="60" stroke="#94a3b8" strokeWidth="1.25" strokeLinecap="round" />

            {/* Shoulder line */}
            <line x1="73" y1="37" x2="107" y2="37" stroke="#94a3b8" strokeWidth="1.25" strokeLinecap="round" />

            {/* Lead arm (forward high guard) */}
            <path
              d="M107 37 L124 39 L136 26"
              stroke="#94a3b8"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {/* Accent dot ONLY on lead wrist */}
            <circle cx="136" cy="26" r="2.75" fill="#38bdf8" />

            {/* Rear arm (chambered low by waist) */}
            <path
              d="M73 37 L61 51 L67 63"
              stroke="#94a3b8"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {/* Accent dot ONLY on rear wrist */}
            <circle cx="67" cy="63" r="2.75" fill="#38bdf8" />

            {/* Crouched wide legs */}
            <path
              d="M90 60 L66 74 L54 102"
              stroke="#94a3b8"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M90 60 L114 74 L126 102"
              stroke="#94a3b8"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        {/* Clean 01 / 02 / 03 numbered monospace instructions */}
        <ol className="space-y-1.5 font-mono text-[10px] text-slate-300 leading-normal">
          <li className="flex items-start gap-2">
            <span className="text-slate-500 shrink-0 select-none">01</span>
            <span>Drop into low, wide horse stance</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-slate-500 shrink-0 select-none">02</span>
            <span>Lead fist raised at forward guard</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-slate-500 shrink-0 select-none">03</span>
            <span>Rear fist chambered low by waist</span>
          </li>
        </ol>

        {/* Subtle charge indicator bar */}
        <div className="mt-2.5 pt-2 border-t border-white/5">
          <div className="flex items-center justify-between text-[9px] font-mono text-slate-500 mb-1">
            <span>CHARGE LOCK</span>
            <span className="tabular-nums text-slate-300">{Math.round(chargeProgress * 100)}%</span>
          </div>
          <div className="h-[2px] w-full rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full bg-[#38bdf8] transition-[width] duration-75"
              style={{ width: `${Math.round(chargeProgress * 100)}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
