import { X } from 'lucide-react';
import {
  STRICTNESS_THRESHOLDS,
  type StrictnessPreset,
  type TriggerMode,
} from '../cv/akazaPoseClassifier';
import type { AfterglowFxOptions } from '../fx/afterglowEngine';

interface ControlsDrawerProps {
  entryThreshold: number;
  onChangeEntryThreshold: (value: number) => void;
  triggerMode: TriggerMode;
  onChangeTriggerMode: (mode: TriggerMode) => void;
  fxOptions: AfterglowFxOptions;
  onChangeFxOptions: (options: AfterglowFxOptions) => void;
  volume: number;
  muted: boolean;
  onChangeVolume: (volume: number) => void;
  videoDevices: MediaDeviceInfo[];
  selectedDeviceId: string;
  onSelectDevice: (id: string) => void;
  onResetDefaults: () => void;
  onClose: () => void;
}

const PRESETS: { key: StrictnessPreset; label: string }[] = [
  { key: 'relaxed', label: 'RELAXED' },
  { key: 'balanced', label: 'BALANCED' },
  { key: 'strict', label: 'STRICT' },
];

const LAYERS: {
  key: 'depthMatte' | 'echoes' | 'compass' | 'strikes';
  label: string;
}[] = [
  { key: 'depthMatte', label: 'DEPTH MATTE' },
  { key: 'echoes', label: '4× ECHOES' },
  { key: 'compass', label: 'COMPASS' },
  { key: 'strikes', label: 'STRIKES' },
];

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-500">
      {children}
    </p>
  );
}

function HairlineSlider({
  label,
  display,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  display: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] font-mono">
        <span className="text-slate-400 tracking-wider">{label}</span>
        <span className="tabular-nums text-slate-200">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer accent-[#38bdf8]"
      />
    </div>
  );
}

export function ControlsDrawer({
  entryThreshold,
  onChangeEntryThreshold,
  triggerMode,
  onChangeTriggerMode,
  fxOptions,
  onChangeFxOptions,
  volume,
  muted,
  onChangeVolume,
  videoDevices,
  selectedDeviceId,
  onSelectDevice,
  onResetDefaults,
  onClose,
}: ControlsDrawerProps) {
  const toggleLayer = (key: 'depthMatte' | 'echoes' | 'compass' | 'strikes') =>
    onChangeFxOptions({ ...fxOptions, [key]: !fxOptions[key] });

  return (
    <aside className="pointer-events-auto w-72 rounded-xl border border-white/10 bg-[#030611]/90 p-3.5 backdrop-blur-md shadow-2xl select-none">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-white/5 pb-2.5">
        <div>
          <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-400">
            CONTROL DECK
          </p>
          <p className="text-[10px] font-mono text-slate-500">
            TRIGGER · PIPELINE · OUTPUT
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close controls (C)"
          className="rounded border border-white/10 p-1 text-slate-400 hover:text-slate-200 hover:bg-white/5 transition cursor-pointer"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {/* Section 1 — Pose Trigger */}
      <div className="mt-3 space-y-2">
        <SectionLabel>POSE TRIGGER</SectionLabel>
        <div className="flex rounded border border-white/5 bg-white/5 p-0.5">
          {PRESETS.map(({ key, label }) => {
            const active =
              Math.abs(entryThreshold - STRICTNESS_THRESHOLDS[key]) <= 0.005;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onChangeEntryThreshold(STRICTNESS_THRESHOLDS[key])}
                className={`flex-1 rounded px-1 py-1 text-[9px] font-mono tracking-wider transition cursor-pointer ${
                  active
                    ? 'bg-[#38bdf8]/15 text-[#38bdf8] font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <HairlineSlider
          label="LOCK GATE"
          display={`${Math.round(entryThreshold * 100)}%`}
          min={0.58}
          max={0.86}
          step={0.01}
          value={entryThreshold}
          onChange={onChangeEntryThreshold}
        />
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px] font-mono">
            <span className="text-slate-400 tracking-wider">RELEASE</span>
          </div>
          <div className="flex rounded border border-white/5 bg-white/5 p-0.5">
            {(
              [
                { mode: 'hold' as TriggerMode, label: 'HOLD' },
                { mode: 'burst' as TriggerMode, label: 'BURST 5S' },
              ]
            ).map(({ mode, label }) => (
              <button
                key={mode}
                type="button"
                onClick={() => onChangeTriggerMode(mode)}
                className={`flex-1 rounded px-1 py-1 text-[9px] font-mono tracking-wider transition cursor-pointer ${
                  triggerMode === mode
                    ? 'bg-[#38bdf8]/15 text-[#38bdf8] font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Section 2 — Pipeline Layers */}
      <div className="mt-3 space-y-2 border-t border-white/5 pt-2.5">
        <SectionLabel>PIPELINE LAYERS</SectionLabel>
        <div className="grid grid-cols-2 gap-1.5">
          {LAYERS.map(({ key, label }) => {
            const enabled = fxOptions[key];
            const disabled = key === 'echoes' && !fxOptions.depthMatte;
            return (
              <button
                key={key}
                type="button"
                disabled={disabled}
                onClick={() => toggleLayer(key)}
                className={`rounded border py-1.5 text-[9px] font-mono tracking-wider transition cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed ${
                  enabled && !disabled
                    ? 'border-[#38bdf8]/40 bg-[#38bdf8]/10 text-[#38bdf8]'
                    : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Section 3 — Output */}
      <div className="mt-3 space-y-2 border-t border-white/5 pt-2.5">
        <SectionLabel>OUTPUT</SectionLabel>
        <HairlineSlider
          label="FX INTENSITY"
          display={`${Math.round(fxOptions.intensityScale * 100)}%`}
          min={0.4}
          max={1.4}
          step={0.05}
          value={fxOptions.intensityScale}
          onChange={(intensityScale) =>
            onChangeFxOptions({ ...fxOptions, intensityScale })
          }
        />
        <HairlineSlider
          label="AUDIO LEVEL"
          display={muted ? 'MUTED' : `${Math.round(volume * 100)}%`}
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={onChangeVolume}
        />
      </div>

      {/* Section 4 — Camera Input */}
      {videoDevices.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-white/5 pt-2.5">
          <SectionLabel>CAMERA INPUT</SectionLabel>
          <select
            value={selectedDeviceId}
            onChange={(e) => onSelectDevice(e.target.value)}
            className="w-full rounded border border-white/10 bg-[#070b14] px-2 py-1.5 text-[10px] font-mono text-slate-300 outline-none focus:border-[#38bdf8]/50 cursor-pointer"
          >
            {selectedDeviceId === '' && <option value="">DEFAULT CAMERA</option>}
            {videoDevices.map((device, i) => (
              <option key={device.deviceId || i} value={device.deviceId}>
                {device.label || `Camera ${i + 1}`}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Footer */}
      <div className="mt-3 border-t border-white/5 pt-2.5">
        <button
          type="button"
          onClick={onResetDefaults}
          className="w-full rounded border border-white/10 py-1.5 text-[9px] font-mono tracking-widest text-slate-400 hover:text-slate-200 hover:bg-white/5 transition cursor-pointer"
        >
          RESET DEFAULTS
        </button>
      </div>
    </aside>
  );
}
