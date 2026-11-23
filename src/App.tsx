import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Camera,
  CameraOff,
  FlipHorizontal2,
  HelpCircle,
  Pause,
  Play,
  SlidersHorizontal,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  AkazaPoseTracker,
  DEFAULT_TRACKER_CONFIG,
  type PoseEvaluation,
  type TriggerMode,
} from './cv/akazaPoseClassifier';
import { PoseLandmarkSmoother, type Landmark3D } from './cv/oneEuroFilter';
import {
  createPoseEngine,
  type PoseEngineInfo,
  type PoseLandmarker,
} from './cv/poseLandmarker';
import { SubjectSelector } from './cv/subjectSelector';
import {
  AfterglowFxEngine,
  DEFAULT_FX_OPTIONS,
  type AfterglowFrameHooks,
  type AfterglowFxOptions,
} from './fx/afterglowEngine';
import { AfterglowCompositor, MAX_COMPOSITE_SIZE } from './fx/afterglowCompositor';
import {
  drawDebugSkeleton,
  type VideoViewportRect,
} from './fx/debugOverlayRenderer';
import { AfterglowSoundEngine } from './fx/soundEngine';
import { PoseGuideCard } from './components/PoseGuideCard';
import { TechHud, type TelemetrySnapshot } from './components/TechHud';
import { ControlsDrawer } from './components/ControlsDrawer';

type MediaSourceKind = 'none' | 'camera' | 'video';

const INITIAL_POSE: PoseEvaluation = {
  hasPerson: false,
  stanceSide: 'left-lead',
  subScores: {
    stanceWidth: 0,
    squatDepth: 0,
    leadArmGuard: 0,
    rearArmChamber: 0,
    armAsymmetry: 0,
  },
  rawConfidence: 0,
  state: 'IDLE',
  chargeProgress: 0,
  effectIntensity: 0,
  activeDurationSec: 0,
  floorAnchor: { x: 0.5, y: 0.85 },
  bodyCenter: { x: 0.5, y: 0.5 },
  bodyScale: 0.14,
  leadWrist: { x: 0.55, y: 0.45 },
  rearWrist: { x: 0.45, y: 0.55 },
  wristSpeed: 0,
};

function computeViewportRect(
  videoW: number,
  videoH: number,
  canvasW: number,
  canvasH: number,
  fit: 'cover' | 'contain',
): VideoViewportRect {
  const videoAspect = videoW / videoH;
  const canvasAspect = canvasW / canvasH;

  let drawWidth = canvasW;
  let drawHeight = canvasH;

  if (fit === 'cover') {
    if (canvasAspect > videoAspect) {
      drawWidth = canvasW;
      drawHeight = canvasW / videoAspect;
    } else {
      drawHeight = canvasH;
      drawWidth = canvasH * videoAspect;
    }
  } else {
    if (canvasAspect > videoAspect) {
      drawHeight = canvasH;
      drawWidth = canvasH * videoAspect;
    } else {
      drawWidth = canvasW;
      drawHeight = canvasW / videoAspect;
    }
  }

  return {
    offsetX: (canvasW - drawWidth) * 0.5,
    offsetY: (canvasH - drawHeight) * 0.5,
    drawWidth,
    drawHeight,
  };
}

/** 12-point vector Snowflake Compass watermark for editorial landing screen */
function SnowflakeCompassWatermark() {
  const KANJI = ['壱', '弐', '参', '肆', '伍', '陸', '漆', '捌', '玖', '拾', '拾壱', '拾弐'];
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
      <svg
        viewBox="-300 -300 600 600"
        className="h-[640px] w-[640px] max-w-[92vw] max-h-[92vw] opacity-[0.045] animate-spin-slow text-[#38bdf8]"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle cx="0" cy="0" r="48" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" />
        <circle cx="0" cy="0" r="110" stroke="currentColor" strokeWidth="1" />
        <circle cx="0" cy="0" r="185" stroke="currentColor" strokeWidth="1" strokeDasharray="6 4" />
        <circle cx="0" cy="0" r="245" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="0" cy="0" r="260" stroke="currentColor" strokeWidth="0.75" />

        <polygon points="0,-110 95.26,55 -95.26,55" stroke="currentColor" strokeWidth="1" />
        <polygon points="0,110 95.26,-55 -95.26,-55" stroke="currentColor" strokeWidth="1" />

        {Array.from({ length: 12 }, (_, i) => {
          const deg = i * 30;
          const rad = (deg * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const isMain = i % 2 === 0;
          const rBlade = isMain ? 245 : 215;

          return (
            <g key={i}>
              <line
                x1={cos * 48}
                y1={sin * 48}
                x2={cos * rBlade}
                y2={sin * rBlade}
                stroke="currentColor"
                strokeWidth={isMain ? 1.5 : 1}
              />
              {isMain && (
                <>
                  <path
                    d={`M ${cos * 160 - sin * 14} ${sin * 160 + cos * 14} L ${cos * 185} ${sin * 185} L ${cos * 160 + sin * 14} ${sin * 160 - cos * 14}`}
                    stroke="currentColor"
                    strokeWidth="1"
                  />
                  <path
                    d={`M ${cos * 215 - sin * 18} ${sin * 215 + cos * 18} L ${cos * 245} ${sin * 245} L ${cos * 215 + sin * 18} ${sin * 215 - cos * 18}`}
                    stroke="currentColor"
                    strokeWidth="1.25"
                  />
                </>
              )}
              <text
                x={cos * 210}
                y={sin * 210 + 4}
                textAnchor="middle"
                fill="currentColor"
                className="font-calligraphy text-[13px] select-none"
              >
                {KANJI[i]}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Right-edge vertical Stance Lock meter — readable from a 2-meter room distance */
function StanceLockMeter({ confidence, threshold = 0.74, charging = false }: { confidence: number; threshold?: number; charging?: boolean }) {
  const isLocked = confidence >= threshold;
  const isHot = isLocked || charging;
  const pct = Math.min(100, Math.max(0, Math.round(confidence * 100)));
  const gatePct = Math.min(100, Math.max(0, Math.round(threshold * 100)));

  return (
    <div className="pointer-events-none fixed right-3 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center">
      <div className="relative h-48 w-1 rounded-full bg-white/10">
        <div
          className={`absolute bottom-0 inset-x-0 rounded-full transition-[height,background-color,box-shadow] duration-100 ${
            isLocked
              ? 'bg-[#38bdf8] shadow-[0_0_12px_#38bdf8]'
              : isHot
                ? 'bg-[#38bdf8]/70 shadow-[0_0_8px_rgba(56,189,248,0.55)]'
                : 'bg-slate-500'
          }`}
          style={{ height: `${pct}%` }}
        />
        <div
          className="absolute -inset-x-1 h-[2px] z-10 bg-white"
          style={{ bottom: `${gatePct}%` }}
        />
      </div>
      <div className="mt-2 -rotate-90 origin-center text-[9px] font-mono tracking-widest text-slate-400 select-none whitespace-nowrap">
        {pct}%
      </div>
    </div>
  );
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fxCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const [smoother] = useState(() => new PoseLandmarkSmoother(33));
  const [tracker] = useState(() => new AkazaPoseTracker());
  const [subjectSelector] = useState(() => new SubjectSelector());
  const [fxEngine] = useState(() => new AfterglowFxEngine());
  const [soundEngine] = useState(() => new AfterglowSoundEngine());

  // Mutable settings read by the render loop.
  const engineInfoRef = useRef<PoseEngineInfo | null>(null);
  const centerZoneOnlyRef = useRef(true);
  const mirroredRef = useRef(true);
  const showHudRef = useRef(false);
  const oneEuroRef = useRef(true);
  const simulateRef = useRef(false);
  const sourceKindRef = useRef<MediaSourceKind>('none');
  const mediaRevisionRef = useRef(0);
  const segmentationEnabledRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const videoUrlRef = useRef<string | null>(null);

  // React UI state
  const [sourceKind, setSourceKind] = useState<MediaSourceKind>('none');
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [videoPaused, setVideoPaused] = useState(false);
  const [modelStatus, setModelStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [engineInfo, setEngineInfo] = useState<PoseEngineInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [centerZoneOnly, setCenterZoneOnly] = useState(true);
  const [mirrored, setMirrored] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.85);
  const [showHud, setShowHud] = useState(false);
  const [showGuide, setShowGuide] = useState(true);
  const [showControls, setShowControls] = useState(false);
  const [entryThreshold, setEntryThreshold] = useState(DEFAULT_TRACKER_CONFIG.entryThreshold);
  const [triggerMode, setTriggerMode] = useState<TriggerMode>(DEFAULT_TRACKER_CONFIG.triggerMode);
  const [fxOptions, setFxOptions] = useState<AfterglowFxOptions>(DEFAULT_FX_OPTIONS);
  const fxOptionsRef = useRef<AfterglowFxOptions>(DEFAULT_FX_OPTIONS);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [oneEuroEnabled, setOneEuroEnabled] = useState(true);
  const [simulateActive, setSimulateActive] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>({
    fps: 0,
    inferenceMs: 0,
    maskMs: 0,
    fxRenderMs: 0,
    pose: INITIAL_POSE,
    subjectCount: 0,
    ignoredCount: 0,
    engineInfo: null,
    renderer: 'Canvas 2D',
  });

  // Keep refs synchronized with UI toggles
  useEffect(() => {
    centerZoneOnlyRef.current = centerZoneOnly;
  }, [centerZoneOnly]);
  useEffect(() => {
    mirroredRef.current = mirrored;
  }, [mirrored]);
  useEffect(() => {
    showHudRef.current = showHud;
  }, [showHud]);
  useEffect(() => {
    oneEuroRef.current = oneEuroEnabled;
  }, [oneEuroEnabled]);
  useEffect(() => {
    simulateRef.current = simulateActive;
  }, [simulateActive]);
  useEffect(() => {
    soundEngine.setMuted(muted);
  }, [muted, soundEngine]);
  useEffect(() => {
    soundEngine.setVolume(volume);
  }, [volume, soundEngine]);
  useEffect(() => {
    fxOptionsRef.current = fxOptions;
  }, [fxOptions]);
  useEffect(() => {
    tracker.setConfig({ entryThreshold, triggerMode });
  }, [entryThreshold, triggerMode, tracker]);

  const refreshVideoDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setVideoDevices(devices.filter((d) => d.kind === 'videoinput'));
    } catch {
      // Enumeration can fail without permissions; keep the last known list.
    }
  }, []);

  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const onDeviceChange = () => void refreshVideoDevices();
    md.addEventListener('devicechange', onDeviceChange);
    return () => md.removeEventListener('devicechange', onDeviceChange);
  }, [refreshVideoDevices]);

  const stopActiveMedia = useCallback(() => {
    mediaRevisionRef.current++;
    soundEngine.stopSession();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
      video.removeAttribute('src');
      video.load();
    }
    sourceKindRef.current = 'none';
    setSourceKind('none');
    setVideoPaused(false);
    setSimulateActive(false);
    simulateRef.current = false;
    smoother.reset();
    tracker.reset();
    subjectSelector.reset();
    fxEngine.reset();
  }, [fxEngine, smoother, soundEngine, subjectSelector, tracker]);

  const startCamera = useCallback(
    async (facing: 'user' | 'environment' = facingMode, deviceId?: string) => {
      setErrorMsg(null);
      stopActiveMedia();
      soundEngine.unlock();
      const revision = mediaRevisionRef.current;
      const video = videoRef.current;
      if (!video) return;

      if (!navigator.mediaDevices?.getUserMedia) {
        setErrorMsg('Camera access requires HTTPS or localhost in a modern browser.');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId
            ? {
                deviceId: { exact: deviceId },
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 60, min: 24 },
              }
            : {
                facingMode: facing,
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 60, min: 24 },
              },
          audio: false,
        });

        if (revision !== mediaRevisionRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        video.srcObject = stream;
        video.loop = false;
        await video.play();
        if (revision !== mediaRevisionRef.current) return;

        const track = stream.getVideoTracks()[0];
        const trackLabel = track?.label ?? '';
        setSelectedDeviceId(track?.getSettings().deviceId ?? deviceId ?? '');
        void refreshVideoDevices();
        const looksRear = /back|rear|environment/i.test(trackLabel);
        mirroredRef.current = deviceId ? !looksRear : facing === 'user';
        setMirrored(mirroredRef.current);
        setVideoPaused(false);
        sourceKindRef.current = 'camera';
        setSourceKind('camera');
      } catch (err) {
        if (revision !== mediaRevisionRef.current) return;
        stopActiveMedia();
        console.error('[Camera] Access denied or unavailable:', err);
        setErrorMsg(
          'Could not open webcam. Please allow camera permissions or use "Load Test Footage" to try a clip.',
        );
      }
    },
    [stopActiveMedia, facingMode, soundEngine, refreshVideoDevices],
  );

  const handleSelectDevice = useCallback(
    (id: string) => {
      setSelectedDeviceId(id);
      void startCamera(facingMode, id);
    },
    [startCamera, facingMode],
  );

  const handleChangeVolume = useCallback((v: number) => {
    setVolume(v);
    setMuted(v <= 0.001);
  }, []);

  const handleResetDefaults = useCallback(() => {
    setEntryThreshold(DEFAULT_TRACKER_CONFIG.entryThreshold);
    setTriggerMode(DEFAULT_TRACKER_CONFIG.triggerMode);
    setCenterZoneOnly(true);
    setFxOptions({ ...DEFAULT_FX_OPTIONS });
    setVolume(0.85);
    setMuted(false);
  }, []);

  const handleVideoFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;

      setErrorMsg(null);
      stopActiveMedia();
      soundEngine.unlock();
      const revision = mediaRevisionRef.current;
      const video = videoRef.current;
      if (!video) return;

      const url = URL.createObjectURL(file);
      videoUrlRef.current = url;
      video.src = url;
      video.loop = true;
      video.muted = true;
      try {
        await video.play();
        if (revision !== mediaRevisionRef.current) return;
        mirroredRef.current = false;
        setMirrored(false);
        setVideoPaused(false);
        sourceKindRef.current = 'video';
        setSourceKind('video');
      } catch (err) {
        if (revision !== mediaRevisionRef.current) return;
        stopActiveMedia();
        console.error('[Video] Playback failed:', err);
        setErrorMsg('Could not play this video file in your browser.');
      }
    },
    [stopActiveMedia, soundEngine],
  );

  const toggleVideoPause = useCallback(() => {
    const video = videoRef.current;
    if (!video || sourceKindRef.current !== 'video') return;
    if (video.paused) {
      const revision = mediaRevisionRef.current;
      void video.play().then(
        () => {
          if (revision === mediaRevisionRef.current) setVideoPaused(false);
        },
        () => {
          if (revision === mediaRevisionRef.current) setVideoPaused(true);
        },
      );
    } else {
      video.pause();
      setVideoPaused(true);
    }
  }, []);

  // Cleanup camera stream and Web AudioContext on unmount
  useEffect(() => {
    return () => {
      stopActiveMedia();
      soundEngine.dispose();
    };
  }, [stopActiveMedia, soundEngine]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const key = e.key.toLowerCase();
      if (key === 'd') setShowHud((v) => !v);
      else if (key === 'c') setShowControls((v) => !v);
      else if (key === 'm') {
        soundEngine.unlock();
        setMuted((wasMuted) => {
          if (wasMuted && volume <= 0.001) setVolume(0.85);
          return !wasMuted;
        });
      } else if (key === 's') {
        soundEngine.unlock();
        setSimulateActive((v) => !v);
      } else if (key === 'g') setShowGuide((v) => !v);
      else if (key === ' ' && sourceKindRef.current === 'video') {
        e.preventDefault();
        toggleVideoPause();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleVideoPause, soundEngine, volume]);

  // Advance the effects on display frames and run inference on fresh media frames.
  useEffect(() => {
    const stageCanvas = stageCanvasRef.current;
    const compositeCanvas = compositeCanvasRef.current;
    const fxCanvas = fxCanvasRef.current;
    const video = videoRef.current;
    if (!stageCanvas || !compositeCanvas || !fxCanvas || !video) return;
    const stageCtx = stageCanvas.getContext('2d');
    const fxCtx = fxCanvas.getContext('2d');
    if (!stageCtx || !fxCtx) return;

    const fxHooks: AfterglowFrameHooks = {
      onCharge: (progress) => soundEngine.updateCharge(progress),
      onChargeEnd: () => soundEngine.endCharge(),
      onActivate: () => soundEngine.playActivation(),
      onEcho: (index, pan) => soundEngine.playEcho(index, pan),
      onStrike: (startPan, endPan) => soundEngine.playBarrageSlice(startPan, endPan),
      onPunchBurst: (pan, strength) => soundEngine.playPunchBurst(pan, strength),
      onDissipate: () => soundEngine.playDissipate(),
    };
    const mappedPose = {
      ...INITIAL_POSE,
      floorAnchor: { ...INITIAL_POSE.floorAnchor },
      bodyCenter: { ...INITIAL_POSE.bodyCenter },
      leadWrist: { ...INITIAL_POSE.leadWrist },
      rearWrist: { ...INITIAL_POSE.rearWrist },
    };

    let compositor: AfterglowCompositor | null = null;
    let videoFramePending = true;
    const useCanvasFallback = (error?: unknown) => {
      if (error) console.warn('[Afterglow] Using Canvas 2D renderer:', error);
      compositeCanvas.hidden = true;
      compositor?.dispose();
      compositor = null;
      segmentationEnabledRef.current = false;
    };
    const initCompositor = () => {
      try {
        compositor = AfterglowCompositor.create(compositeCanvas);
        segmentationEnabledRef.current = Boolean(compositor);
        videoFramePending = true;
      } catch (error) {
        useCanvasFallback(error);
      }
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      useCanvasFallback();
    };
    initCompositor();
    compositeCanvas.addEventListener('webglcontextlost', onContextLost);
    compositeCanvas.addEventListener('webglcontextrestored', initCompositor);

    let rafId = 0;
    let lastFrameMs = performance.now();
    let lastInferTimestampMs = 0;
    let lastVideoFrameTime = -1;
    let mediaRevision = -1;
    let videoCallbackId = 0;
    const usesVideoCallbacks = typeof video.requestVideoFrameCallback === 'function';
    const onVideoFrame = () => {
      videoFramePending = true;
      videoCallbackId = video.requestVideoFrameCallback(onVideoFrame);
    };
    if (usesVideoCallbacks) videoCallbackId = video.requestVideoFrameCallback(onVideoFrame);
    let smoothedLandmarks: Landmark3D[] | null = null;
    let rawLandmarks: Landmark3D[] | null = null;
    let worldLandmarks: Landmark3D[] | null = null;
    let ignoredPoses: Landmark3D[][] = [];
    let detectedSubjectCount = 0;
    let ignoredSubjectCount = 0;
    let lastInferenceMs = 0;
    let lastMaskMs = 0;
    let lastFxRenderMs = 0;

    // Pre-allocated mapped landmarks buffer for zero per-frame GC churn
    const mappedLandmarksBuf: Landmark3D[] = Array.from({ length: 33 }, () => ({
      x: 0,
      y: 0,
      z: 0,
      visibility: 0,
    }));

    // FPS & HUD throttle accumulators
    let fpsFrames = 0;
    let fpsWindowStart = performance.now();
    let currentFps = 0;
    let lastHudEmitMs = 0;

    const resizeCanvases = () => {
      const stage = stageCanvasRef.current;
      const fx = fxCanvasRef.current;
      if (!stage || !fx) return;
      const rawDpr = window.devicePixelRatio || 1;
      const stageDpr = Math.min(rawDpr, 2);
      const fxDpr = Math.min(rawDpr, 1.5);

      const sw = Math.floor(window.innerWidth * stageDpr);
      const sh = Math.floor(window.innerHeight * stageDpr);
      if (stage.width !== sw || stage.height !== sh) {
        stage.width = sw;
        stage.height = sh;
      }
      const compositeScale = Math.min(1, MAX_COMPOSITE_SIZE / Math.max(sw, sh, 1));
      const cw = Math.max(1, Math.round(sw * compositeScale));
      const ch = Math.max(1, Math.round(sh * compositeScale));
      if (compositeCanvas.width !== cw || compositeCanvas.height !== ch) {
        compositeCanvas.width = cw;
        compositeCanvas.height = ch;
      }

      const fw = Math.floor(window.innerWidth * fxDpr);
      const fh = Math.floor(window.innerHeight * fxDpr);
      if (fx.width !== fw || fx.height !== fh) {
        fx.width = fw;
        fx.height = fh;
      }
    };

    resizeCanvases();
    window.addEventListener('resize', resizeCanvases);

    const frame = (nowMs: number) => {
      rafId = requestAnimationFrame(frame);

      const dtSec = Math.min(0.05, Math.max(0.001, (nowMs - lastFrameMs) / 1000));
      lastFrameMs = nowMs;

      fpsFrames += 1;
      if (nowMs - fpsWindowStart >= 500) {
        currentFps = Math.round((fpsFrames * 1000) / (nowMs - fpsWindowStart));
        fpsFrames = 0;
        fpsWindowStart = nowMs;
      }

      const sw = stageCanvas.width;
      const sh = stageCanvas.height;
      const fw = fxCanvas.width;
      const fh = fxCanvas.height;

      const hasVideo =
        sourceKindRef.current !== 'none' &&
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        video.videoHeight > 0;

      const mediaChanged = mediaRevision !== mediaRevisionRef.current;
      if (mediaChanged || video.currentTime + 0.08 < lastVideoFrameTime) {
        mediaRevision = mediaRevisionRef.current;
        compositor?.reset();
        subjectSelector.reset();
        lastVideoFrameTime = -1;
        videoFramePending = true;
        if (!mediaChanged) {
          soundEngine.stopSession();
          smoother.reset();
          tracker.reset();
          fxEngine.reset();
        }
        rawLandmarks = smoothedLandmarks = worldLandmarks = null;
        ignoredPoses = [];
        detectedSubjectCount = 0;
        ignoredSubjectCount = 0;
      }

      if (!hasVideo || sw === 0 || sh === 0 || fw === 0 || fh === 0) {
        compositeCanvas.hidden = true;
        stageCtx.clearRect(0, 0, sw, sh);
        fxCtx.clearRect(0, 0, fw, fh);
        lastVideoFrameTime = -1;
        return;
      }

      // 1. Run MediaPipe PoseLandmarker whenever a fresh video frame arrives
      const landmarker = landmarkerRef.current;
      const freshVideoFrame = usesVideoCallbacks ? videoFramePending : video.currentTime !== lastVideoFrameTime;
      if (landmarker && freshVideoFrame) {
        videoFramePending = false;
        lastVideoFrameTime = video.currentTime;
        const monotonicTs = Math.max(lastInferTimestampMs + 1, Math.round(nowMs));
        lastInferTimestampMs = monotonicTs;

        const t0 = performance.now();
        try {
          landmarker.detectForVideo(video, monotonicTs, (result) => {
            lastInferenceMs = performance.now() - t0;

            // Pick the single active center-stage performer; select() reuses its
            // return object, so snapshot everything needed before the next call.
            const sel = subjectSelector.select(
              result.landmarks,
              result.worldLandmarks,
              monotonicTs,
              centerZoneOnlyRef.current,
            );
            const selectedIndex = sel.selectedIndex;
            const selTorsoX = sel.torsoX;
            const selTorsoY = sel.torsoY;
            detectedSubjectCount = sel.totalDetected;
            ignoredSubjectCount = sel.ignoredIndices.length;
            ignoredPoses.length = 0;
            for (const i of sel.ignoredIndices) {
              const ignored = result.landmarks[i];
              if (ignored) ignoredPoses.push(ignored);
            }

            // Subject switch: person A's smoothed pose, mask, echoes, and charge
            // hum must never bleed onto person B.
            if (sel.switched) {
              smoother.reset();
              tracker.reset();
              fxEngine.reset();
              compositor?.reset();
              soundEngine.endCharge();
            }

            rawLandmarks = selectedIndex >= 0 ? (result.landmarks[selectedIndex] ?? null) : null;
            const rawWorld = selectedIndex >= 0 ? (result.worldLandmarks[selectedIndex] ?? null) : null;
            smoothedLandmarks = rawLandmarks && oneEuroRef.current
              ? smoother.smooth(rawLandmarks, monotonicTs)
              : rawLandmarks;
            worldLandmarks = rawWorld && oneEuroRef.current
              ? smoother.smoothWorld(rawWorld, monotonicTs)
              : rawWorld;
            try {
              const maskStart = performance.now();
              const selectedMask = selectedIndex >= 0
                ? result.segmentationMasks?.[selectedIndex]
                : undefined;
              compositor?.updateMask(selectedMask, selTorsoX, selTorsoY);
              lastMaskMs = compositor?.hasMask ? performance.now() - maskStart : 0;
            } catch (error) {
              useCanvasFallback(error);
            }
          });
        } catch {
          // A seek can temporarily fail inference. Drop stale tracking before the next frame.
          rawLandmarks = smoothedLandmarks = worldLandmarks = null;
          ignoredPoses.length = 0;
          detectedSubjectCount = 0;
          ignoredSubjectCount = 0;
          compositor?.updateMask(undefined);
        }
      }

      // 2. Classify Akaza Soryu Pose & advance hysteresis state machine
      const poseEval = tracker.update(
        smoothedLandmarks,
        worldLandmarks,
        nowMs,
        simulateRef.current,
      );

      // 3. Compute exact video-to-canvas transform
      const fit = sourceKindRef.current === 'camera' ? 'cover' : 'contain';
      const stageRect = computeViewportRect(video.videoWidth, video.videoHeight, sw, sh, fit);
      const fxRect = computeViewportRect(video.videoWidth, video.videoHeight, fw, fh, fit);
      const isMirrored = mirroredRef.current;
      const shake = fxEngine.getShakeOffset();
      const stageShakeX = (shake.x * sw) / fw;
      const stageShakeY = (shake.y * sh) / fh;

      // 4. Remap normalized pose anchors into FX canvas-normalized space (in-place mutation, 0 allocations)
      mappedPose.hasPerson = poseEval.hasPerson;
      mappedPose.stanceSide = poseEval.stanceSide;
      mappedPose.subScores = poseEval.subScores;
      mappedPose.rawConfidence = poseEval.rawConfidence;
      mappedPose.state = poseEval.state;
      mappedPose.chargeProgress = poseEval.chargeProgress;
      mappedPose.effectIntensity = poseEval.effectIntensity;
      mappedPose.activeDurationSec = poseEval.activeDurationSec;
      mappedPose.wristSpeed = poseEval.wristSpeed;
      mappedPose.bodyScale = (poseEval.bodyScale * fxRect.drawWidth) / fw;

      const fxDrawW = fxRect.drawWidth;
      const fxDrawH = fxRect.drawHeight;
      const fxOffX = fxRect.offsetX + shake.x;
      const fxOffY = fxRect.offsetY + shake.y;

      const pFloor = poseEval.floorAnchor;
      mappedPose.floorAnchor.x = (fxOffX + (isMirrored ? 1 - pFloor.x : pFloor.x) * fxDrawW) / fw;
      mappedPose.floorAnchor.y = (fxOffY + pFloor.y * fxDrawH) / fh;

      const pCenter = poseEval.bodyCenter;
      mappedPose.bodyCenter.x = (fxOffX + (isMirrored ? 1 - pCenter.x : pCenter.x) * fxDrawW) / fw;
      mappedPose.bodyCenter.y = (fxOffY + pCenter.y * fxDrawH) / fh;

      const pLead = poseEval.leadWrist;
      mappedPose.leadWrist.x = (fxOffX + (isMirrored ? 1 - pLead.x : pLead.x) * fxDrawW) / fw;
      mappedPose.leadWrist.y = (fxOffY + pLead.y * fxDrawH) / fh;

      const pRear = poseEval.rearWrist;
      mappedPose.rearWrist.x = (fxOffX + (isMirrored ? 1 - pRear.x : pRear.x) * fxDrawW) / fw;
      mappedPose.rearWrist.y = (fxOffY + pRear.y * fxDrawH) / fh;

      let mappedLandmarks: Landmark3D[] | null = null;
      if (smoothedLandmarks) {
        const count = Math.min(smoothedLandmarks.length, mappedLandmarksBuf.length);
        for (let i = 0; i < count; i++) {
          const lm = smoothedLandmarks[i];
          const dst = mappedLandmarksBuf[i];
          dst.x = (fxOffX + (isMirrored ? 1 - lm.x : lm.x) * fxDrawW) / fw;
          dst.y = (fxOffY + lm.y * fxDrawH) / fh;
          dst.z = lm.z;
          dst.visibility = lm.visibility;
        }
        mappedLandmarks = mappedLandmarksBuf;
      }

      // 5. Render layered Anime Blue Silver Chaotic Afterglow VFX
      const fxT0 = performance.now();
      const depthActive = poseEval.state !== 'IDLE';
      let rear: CanvasRenderingContext2D | undefined;
      try {
        if (depthActive) rear = compositor?.getRearContext(fw, fh);
      } catch (error) {
        useCanvasFallback(error);
      }
      fxEngine.render(
        fxCtx,
        fw,
        fh,
        dtSec,
        mappedPose,
        mappedLandmarks,
        false,
        fxHooks,
        rear,
        compositor?.hasMask,
        fxOptionsRef.current,
      );
      let composited = false;
      if (rear && compositor) {
        try {
          const { width, height } = compositeCanvas;
          const rect = computeViewportRect(video.videoWidth, video.videoHeight, width, height, fit);
          composited = compositor.render(
            video, rect, shake.x * width / fw, shake.y * height / fh, isMirrored, fxEngine.scene,
            poseEval.floorAnchor, poseEval.state !== 'DISSIPATING', fxOptionsRef.current.depthMatte,
          );
        } catch (error) {
          useCanvasFallback(error);
        }
      } else if (!depthActive) {
        compositor?.clearEchoHistory();
      }
      compositeCanvas.hidden = !composited;
      if (!composited) {
        stageCtx.save();
        stageCtx.fillStyle = '#030509';
        stageCtx.fillRect(0, 0, sw, sh);
        stageCtx.translate(stageShakeX, stageShakeY);
        if (isMirrored) {
          stageCtx.translate(stageRect.offsetX * 2 + stageRect.drawWidth, 0);
          stageCtx.scale(-1, 1);
        }
        stageCtx.drawImage(video, stageRect.offsetX, stageRect.offsetY, stageRect.drawWidth, stageRect.drawHeight);
        stageCtx.restore();
      }

      // 6. Optional CV Debug Skeleton overlay
      if (showHudRef.current) {
        fxRect.offsetX += shake.x;
        fxRect.offsetY += shake.y;
        drawDebugSkeleton(
          fxCtx,
          smoothedLandmarks,
          rawLandmarks,
          poseEval,
          fxRect,
          isMirrored,
          ignoredPoses,
          centerZoneOnlyRef.current,
        );
      }
      lastFxRenderMs = performance.now() - fxT0;

      // 7. Emit throttled UI telemetry (~15Hz)
      if (nowMs - lastHudEmitMs >= 66) {
        lastHudEmitMs = nowMs;
        setTelemetry({
          fps: currentFps,
          inferenceMs: lastInferenceMs,
          maskMs: lastMaskMs,
          fxRenderMs: lastFxRenderMs,
          pose: poseEval,
          subjectCount: detectedSubjectCount,
          ignoredCount: ignoredSubjectCount,
          engineInfo: engineInfoRef.current,
          renderer: compositor
            ? !fxOptionsRef.current.depthMatte
              ? 'WebGL 2 · Matte bypassed'
              : compositor.hasMask
                ? 'WebGL 2 · Person matte'
                : 'WebGL 2 · Awaiting matte'
            : 'Canvas 2D',
        });
      }
    };

    rafId = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(rafId);
      if (usesVideoCallbacks) video.cancelVideoFrameCallback(videoCallbackId);
      window.removeEventListener('resize', resizeCanvases);
      compositeCanvas.removeEventListener('webglcontextlost', onContextLost);
      compositeCanvas.removeEventListener('webglcontextrestored', initCompositor);
      useCanvasFallback();
    };
  }, [fxEngine, smoother, soundEngine, subjectSelector, tracker]);

  // Initialize MediaPipe PoseLandmarker on mount
  useEffect(() => {
    let cancelled = false;

    const initialize = async () => {
      if (cancelled) return;
      try {
        const { landmarker, info } = await createPoseEngine(segmentationEnabledRef.current);
        if (cancelled) {
          landmarker.close();
          return;
        }
        landmarkerRef.current = landmarker;
        engineInfoRef.current = info;
        setEngineInfo(info);
        setModelStatus('ready');
      } catch (err) {
        if (cancelled) return;
        console.error('[PoseEngine] Failed to load:', err);
        setModelStatus('error');
        setErrorMsg('Failed to load MediaPipe Pose model. Check your internet connection.');
      }
    };
    // Strict Mode can replay mount effects before the first model request starts.
    queueMicrotask(() => void initialize());

    return () => {
      cancelled = true;
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
    };
  }, []);

  const isAttenuated = telemetry.pose.state === 'ACTIVE' || telemetry.pose.state === 'CHARGING';

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#030509] bg-film-grain select-none">
      {/* Hidden source video decoded into the stage canvas */}
      <video ref={videoRef} playsInline muted className="hidden" />
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        onChange={handleVideoFileSelect}
        className="hidden"
      />

      {/* Base camera/video canvas */}
      <canvas ref={stageCanvasRef} className="absolute inset-0 h-full w-full" />
      <canvas ref={compositeCanvasRef} hidden className="pointer-events-none absolute inset-0 h-full w-full" />

      {/* Foreground effects and optional debug skeleton */}
      <canvas ref={fxCanvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

      {/* Unified non-intrusive top broadcast rail */}
      {sourceKind !== 'none' && (
        <header className="pointer-events-none absolute top-4 inset-x-6 z-20 flex items-start justify-between">
          {/* Left column: status pill + Controls Drawer */}
          <div className="flex flex-col items-start gap-3">
            <div className="flex items-center gap-2.5 rounded-full border border-white/10 bg-[#030611]/85 px-3.5 py-1.5 backdrop-blur-md">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  telemetry.pose.state === 'ACTIVE'
                    ? 'bg-[#38bdf8] shadow-[0_0_8px_#38bdf8]'
                    : telemetry.pose.state === 'CHARGING'
                      ? 'bg-slate-300'
                      : 'bg-slate-600'
                }`}
              />
              <span className="font-calligraphy text-sm tracking-wider text-[#f8fafc]">
                破壊殺 · 終式 / 青銀亂殘光
              </span>
              <span className="h-3 w-px bg-white/10" />
              <span className="text-[10px] font-mono tracking-widest text-slate-400">
                {sourceKind === 'camera' ? 'LIVE' : 'CLIP'}
              </span>
              <span className="h-3 w-px bg-white/10" />
              <span
                className={`text-[10px] font-mono tracking-wider ${
                  modelStatus === 'loading'
                    ? 'text-slate-300'
                    : telemetry.pose.state === 'ACTIVE'
                      ? 'text-[#38bdf8] font-medium'
                      : 'text-slate-400'
                }`}
              >
                {modelStatus === 'loading' ? 'LOADING CV…' : telemetry.pose.state}
              </span>
            </div>
            {showControls && (
              <ControlsDrawer
                entryThreshold={entryThreshold}
                onChangeEntryThreshold={setEntryThreshold}
                triggerMode={triggerMode}
                onChangeTriggerMode={setTriggerMode}
                centerZoneOnly={centerZoneOnly}
                onToggleCenterZoneOnly={() => setCenterZoneOnly((v) => !v)}
                fxOptions={fxOptions}
                onChangeFxOptions={setFxOptions}
                volume={volume}
                muted={muted}
                onChangeVolume={handleChangeVolume}
                videoDevices={videoDevices}
                selectedDeviceId={selectedDeviceId}
                onSelectDevice={handleSelectDevice}
                onResetDefaults={handleResetDefaults}
                onClose={() => setShowControls(false)}
              />
            )}
          </div>

          {/* Right Panels: Pose Guide & Telemetry HUD */}
          <div className="flex flex-col items-end gap-3 pointer-events-none">
            {showHud && (
              <TechHud
                telemetry={telemetry}
                entryThreshold={entryThreshold}
                triggerMode={triggerMode}
                oneEuroEnabled={oneEuroEnabled}
                onToggleOneEuro={() => setOneEuroEnabled((v) => !v)}
              />
            )}
            {showGuide && !showHud && (
              <PoseGuideCard
                poseState={telemetry.pose.state}
                chargeProgress={telemetry.pose.chargeProgress}
                onDismiss={() => setShowGuide(false)}
              />
            )}
          </div>
        </header>
      )}

      {/* Right-edge vertical Stance Lock meter */}
      {sourceKind !== 'none' && (
        <StanceLockMeter
          confidence={telemetry.pose.rawConfidence}
          threshold={entryThreshold}
          charging={telemetry.pose.state === 'CHARGING'}
        />
      )}

      {/* Editorial Landing Stage before session starts */}
      {sourceKind === 'none' && (
        <section className="relative z-20 flex h-full w-full flex-col items-center justify-center px-6 text-center">
          <SnowflakeCompassWatermark />

          <div className="relative max-w-xl space-y-6">
            <p className="font-mono text-xs uppercase tracking-[0.35em] text-slate-400">
              DESTRUCTIVE DEATH · FINAL FORM
            </p>

            <div className="space-y-3">
              <h1 className="font-calligraphy text-6xl sm:text-7xl font-normal tracking-[0.25em] text-[#f8fafc] select-none">
                青銀亂殘光
              </h1>
              <p className="font-mono text-xs sm:text-sm tracking-[0.2em] uppercase text-slate-400">
                Blue Silver Chaotic Afterglow · Real-Time Stance Synthesizer
              </p>
            </div>

            <p className="mx-auto max-w-md text-xs sm:text-sm leading-relaxed text-slate-400 font-sans">
              Assume the Soryu stance in front of the lens to materialize the 12-point Snowflake Compass
              and discharge the 100-strike blue-silver afterglow barrage locally in your browser.
            </p>

            {errorMsg && (
              <div className="rounded border border-rose-500/30 bg-rose-950/40 px-4 py-2 font-mono text-xs text-rose-300">
                {errorMsg}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => void startCamera()}
                className="group inline-flex items-center gap-2.5 rounded-full border border-[#38bdf8]/40 bg-[#030611]/90 px-6 py-3 font-mono text-xs tracking-wider text-[#f8fafc] hover:border-[#38bdf8] hover:bg-slate-900/90 transition duration-300 backdrop-blur-md cursor-pointer"
              >
                <Camera className="h-3.5 w-3.5 text-[#38bdf8]" />
                <span>Initialize Camera</span>
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-transparent px-5 py-3 font-mono text-xs tracking-wider text-slate-300 hover:border-white/30 hover:text-white transition duration-300 cursor-pointer"
              >
                <Upload className="h-3.5 w-3.5 text-slate-400" />
                <span>Load Test Footage</span>
              </button>
            </div>

            <div className="pt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[10px] font-mono text-slate-500 border-t border-white/5">
              <span>
                ENGINE:{' '}
                <span className="text-slate-300">
                  {modelStatus === 'ready'
                    ? `${engineInfo?.modelName.toUpperCase()} · ${engineInfo?.delegate.toUpperCase()}`
                    : modelStatus === 'loading'
                      ? 'INITIALIZING WASM/GPU…'
                      : 'UNAVAILABLE'}
                </span>
              </span>
              <span>·</span>
              <span>SHORTCUTS: [D] TELEMETRY · [C] CONTROLS · [S] SIMULATE · [G] GUIDE</span>
            </div>
          </div>
        </section>
      )}

      {/* Ultra-compact, single-row auto-attenuating bottom dock */}
      {sourceKind !== 'none' && (
        <nav
          className={`absolute bottom-4 left-1/2 z-20 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-white/10 bg-[#030611]/90 px-2.5 py-1.5 backdrop-blur-xl shadow-2xl max-w-[95vw] overflow-x-auto transition-opacity duration-500 ease-editorial ${
            isAttenuated ? 'opacity-20 hover:opacity-100' : 'opacity-100'
          }`}
        >
          {/* Preview (S) / Manual Trigger */}
          <button
            type="button"
            onClick={() => {
              soundEngine.unlock();
              setSimulateActive((v) => !v);
            }}
            title="Preview effect manually (S)"
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-mono tracking-wider transition cursor-pointer whitespace-nowrap ${
              simulateActive
                ? 'bg-[#38bdf8]/20 text-[#38bdf8] border border-[#38bdf8]/40'
                : 'text-slate-300 hover:bg-white/5'
            }`}
          >
            <Play className="h-3 w-3" />
            <span>Preview (S)</span>
          </button>

          {/* Load Video */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Load video file"
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-mono tracking-wider text-slate-300 hover:bg-white/5 transition cursor-pointer whitespace-nowrap"
          >
            <Upload className="h-3 w-3 text-slate-400" />
            <span className="hidden sm:inline">Load Video</span>
          </button>

          {/* Play / Pause (Space) when video is playing */}
          {sourceKind === 'video' && (
            <button
              type="button"
              onClick={toggleVideoPause}
              title={videoPaused ? 'Resume video (Space)' : 'Pause video (Space)'}
              className="rounded-full p-1.5 text-slate-300 hover:bg-white/5 transition cursor-pointer"
            >
              {videoPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            </button>
          )}

          {/* Flip Camera */}
          <button
            type="button"
            onClick={() => {
              setSelectedDeviceId('');
              if (sourceKind === 'camera') {
                const nextFacing = facingMode === 'user' ? 'environment' : 'user';
                setFacingMode(nextFacing);
                void startCamera(nextFacing);
              } else {
                void startCamera('user');
              }
            }}
            title="Flip camera"
            className="rounded-full p-1.5 text-slate-300 hover:text-white hover:bg-white/5 transition cursor-pointer"
          >
            <Camera className="h-3.5 w-3.5" />
          </button>

          {/* Mirror Video */}
          <button
            type="button"
            onClick={() => setMirrored((v) => !v)}
            title="Mirror video"
            className={`rounded-full p-1.5 transition cursor-pointer ${
              mirrored ? 'text-[#38bdf8] bg-[#38bdf8]/10' : 'text-slate-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <FlipHorizontal2 className="h-3.5 w-3.5" />
          </button>

          {/* Mute (M) */}
          <button
            type="button"
            onClick={() => {
              soundEngine.unlock();
              setMuted((wasMuted) => {
                if (wasMuted && volume <= 0.001) setVolume(0.85);
                return !wasMuted;
              });
            }}
            title="Mute sound FX (M)"
            className={`rounded-full p-1.5 transition cursor-pointer ${
              !muted ? 'text-[#38bdf8] bg-[#38bdf8]/10' : 'text-slate-400 hover:text-white hover:bg-white/5'
            }`}
          >
            {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </button>

          {/* Guide (G) */}
          <button
            type="button"
            onClick={() => setShowGuide((v) => !v)}
            title="Toggle stance guide (G)"
            className={`rounded-full p-1.5 transition cursor-pointer ${
              showGuide ? 'text-[#38bdf8] bg-[#38bdf8]/10' : 'text-slate-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <HelpCircle className="h-3.5 w-3.5" />
          </button>

          {/* Telemetry (D) */}
          <button
            type="button"
            onClick={() => setShowHud((v) => !v)}
            title="Toggle telemetry HUD (D)"
            className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-mono tracking-wider transition cursor-pointer whitespace-nowrap ${
              showHud
                ? 'border border-[#38bdf8]/40 bg-[#38bdf8]/15 text-[#38bdf8]'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
          >
            <Activity className="h-3 w-3" />
            <span>D</span>
          </button>

          {/* Controls (C) */}
          <button
            type="button"
            onClick={() => setShowControls((v) => !v)}
            title="Toggle controls drawer (C)"
            className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-mono tracking-wider transition cursor-pointer whitespace-nowrap ${
              showControls
                ? 'border border-[#38bdf8]/40 bg-[#38bdf8]/15 text-[#38bdf8]'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
          >
            <SlidersHorizontal className="h-3 w-3" />
            <span>C</span>
          </button>

          {/* Exit */}
          <button
            type="button"
            onClick={stopActiveMedia}
            title="Exit session"
            className="rounded-full p-1.5 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer"
          >
            <CameraOff className="h-3.5 w-3.5" />
          </button>
        </nav>
      )}
    </main>
  );
}
