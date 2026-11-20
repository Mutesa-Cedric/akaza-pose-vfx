import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Camera,
  CameraOff,
  FlipHorizontal2,
  HelpCircle,
  Pause,
  Play,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  AkazaPoseTracker,
  type DetectionMode,
  type PoseEvaluation,
} from './cv/akazaPoseClassifier';
import { PoseLandmarkSmoother, type Landmark3D } from './cv/oneEuroFilter';
import {
  createPoseEngine,
  type PoseEngineInfo,
  type PoseLandmarker,
} from './cv/poseLandmarker';
import { AfterglowFxEngine, type AfterglowFrameHooks } from './fx/afterglowEngine';
import {
  drawDebugSkeleton,
  type VideoViewportRect,
} from './fx/debugOverlayRenderer';
import { AfterglowSoundEngine } from './fx/soundEngine';
import { PoseGuideCard } from './components/PoseGuideCard';
import { TechHud, type TelemetrySnapshot } from './components/TechHud';

type MediaSourceKind = 'none' | 'camera' | 'video';

const INITIAL_POSE: PoseEvaluation = {
  hasPerson: false,
  resolvedMode: 'full-body',
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

/** Razor-thin right-edge vertical Stance Lock hairline meter */
function StanceLockMeter({ confidence }: { confidence: number }) {
  const isLocked = confidence >= 0.62;
  const pct = Math.min(100, Math.max(0, Math.round(confidence * 100)));

  return (
    <div className="pointer-events-none fixed right-3 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center">
      <div className="relative h-44 w-[2px] rounded-full bg-white/10 overflow-hidden">
        <div
          className={`absolute bottom-0 inset-x-0 transition-[height,background-color] duration-100 ${
            isLocked ? 'bg-[#38bdf8] shadow-[0_0_8px_#38bdf8]' : 'bg-slate-500'
          }`}
          style={{ height: `${pct}%` }}
        />
        <div className="absolute bottom-[62%] -inset-x-0.5 h-[1px] bg-white z-10" />
      </div>
      <div className="mt-2 -rotate-90 origin-center text-[8px] font-mono tracking-widest text-slate-400 select-none whitespace-nowrap">
        {pct}%
      </div>
    </div>
  );
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fxCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Core CV & FX engine instances
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const smootherRef = useRef(new PoseLandmarkSmoother(33));
  const trackerRef = useRef(new AkazaPoseTracker());
  const fxEngineRef = useRef(new AfterglowFxEngine());
  const soundEngineRef = useRef(new AfterglowSoundEngine());

  // Pre-allocated reusable pose evaluation and FX hooks for zero per-frame hot-loop allocations
  const mappedPoseRef = useRef<PoseEvaluation>({
    hasPerson: false,
    resolvedMode: 'full-body',
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
  });

  const fxHooksRef = useRef<AfterglowFrameHooks>({
    onActivate: () => soundEngineRef.current.playActivate(),
    onBarrageTick: () => soundEngineRef.current.playBarrageSlice(),
    onPunchBurst: () => soundEngineRef.current.playPunchBurst(),
    onDissipate: () => soundEngineRef.current.playDissipate(),
  });

  // Mutable settings refs read directly by the 60fps render loop
  const engineInfoRef = useRef<PoseEngineInfo | null>(null);
  const modeRef = useRef<DetectionMode>('auto');
  const mirroredRef = useRef(true);
  const showHudRef = useRef(false);
  const oneEuroRef = useRef(true);
  const simulateRef = useRef(false);
  const sourceKindRef = useRef<MediaSourceKind>('none');
  const streamRef = useRef<MediaStream | null>(null);
  const videoUrlRef = useRef<string | null>(null);

  // React UI state
  const [sourceKind, setSourceKind] = useState<MediaSourceKind>('none');
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [videoPaused, setVideoPaused] = useState(false);
  const [modelStatus, setModelStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [engineInfo, setEngineInfo] = useState<PoseEngineInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [mode, setMode] = useState<DetectionMode>('auto');
  const [mirrored, setMirrored] = useState(true);
  const [muted, setMuted] = useState(false);
  const [showHud, setShowHud] = useState(false);
  const [showGuide, setShowGuide] = useState(true);
  const [oneEuroEnabled, setOneEuroEnabled] = useState(true);
  const [simulateActive, setSimulateActive] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>({
    fps: 0,
    inferenceMs: 0,
    fxRenderMs: 0,
    pose: INITIAL_POSE,
    engineInfo: null,
  });

  // Keep refs synchronized with UI toggles
  useEffect(() => {
    engineInfoRef.current = engineInfo;
  }, [engineInfo]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
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
    soundEngineRef.current.setMuted(muted);
  }, [muted]);

  // Initialize MediaPipe PoseLandmarker on mount
  useEffect(() => {
    let cancelled = false;

    createPoseEngine()
      .then(({ landmarker, info }) => {
        if (cancelled) {
          landmarker.close();
          return;
        }
        landmarkerRef.current = landmarker;
        engineInfoRef.current = info;
        setEngineInfo(info);
        setModelStatus('ready');
      })
      .catch((err) => {
        console.error('[PoseEngine] Failed to load:', err);
        if (!cancelled) {
          setModelStatus('error');
          setErrorMsg('Failed to load MediaPipe Pose model. Check your internet connection.');
        }
      });

    return () => {
      cancelled = true;
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
    };
  }, []);

  const stopActiveMedia = useCallback(() => {
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
    smootherRef.current.reset();
    trackerRef.current.reset();
    fxEngineRef.current.reset();
  }, []);

  const startCamera = useCallback(
    async (facing: 'user' | 'environment' = facingMode) => {
      setErrorMsg(null);
      soundEngineRef.current.unlock();
      stopActiveMedia();

      if (!navigator.mediaDevices?.getUserMedia) {
        setErrorMsg('Camera access requires HTTPS or localhost in a modern browser.');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: facing,
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 60, min: 24 },
          },
          audio: false,
        });

        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.loop = false;
          await video.play();
        }

        setMirrored(facing === 'user');
        setVideoPaused(false);
        sourceKindRef.current = 'camera';
        setSourceKind('camera');
      } catch (err) {
        console.error('[Camera] Access denied or unavailable:', err);
        setErrorMsg(
          'Could not open webcam. Please allow camera permissions or use "Load Test Footage" to try a clip.',
        );
      }
    },
    [stopActiveMedia, facingMode],
  );

  const handleVideoFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;

      setErrorMsg(null);
      soundEngineRef.current.unlock();
      stopActiveMedia();

      const url = URL.createObjectURL(file);
      videoUrlRef.current = url;
      const video = videoRef.current;
      if (video) {
        video.srcObject = null;
        video.src = url;
        video.loop = true;
        video.muted = true;
        try {
          await video.play();
          setMirrored(false);
          setVideoPaused(false);
          sourceKindRef.current = 'video';
          setSourceKind('video');
        } catch (err) {
          console.error('[Video] Playback failed:', err);
          setErrorMsg('Could not play this video file in your browser.');
        }
      }
    },
    [stopActiveMedia],
  );

  const toggleVideoPause = useCallback(() => {
    const video = videoRef.current;
    if (!video || sourceKindRef.current !== 'video') return;
    if (video.paused) {
      void video.play();
      setVideoPaused(false);
    } else {
      video.pause();
      setVideoPaused(true);
    }
  }, []);

  // Cleanup camera stream and Web AudioContext on unmount
  useEffect(() => {
    const sound = soundEngineRef.current;
    return () => {
      stopActiveMedia();
      sound.dispose();
    };
  }, [stopActiveMedia]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key.toLowerCase();
      if (key === 'd') setShowHud((v) => !v);
      else if (key === 'm') setMuted((v) => !v);
      else if (key === 's') {
        soundEngineRef.current.unlock();
        setSimulateActive((v) => !v);
      } else if (key === 'g') setShowGuide((v) => !v);
      else if (key === ' ' && sourceKindRef.current === 'video') {
        e.preventDefault();
        toggleVideoPause();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleVideoPause]);

  // Main 60fps CV + Anime VFX Render Loop
  useEffect(() => {
    let rafId = 0;
    let lastFrameMs = performance.now();
    let lastInferTimestampMs = 0;
    let lastVideoFrameTime = -1;
    let smoothedLandmarks: Landmark3D[] | null = null;
    let rawLandmarks: Landmark3D[] | null = null;
    let worldLandmarks: Landmark3D[] | null = null;
    let lastInferenceMs = 0;
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

      const stageCanvas = stageCanvasRef.current;
      const fxCanvas = fxCanvasRef.current;
      const video = videoRef.current;
      if (!stageCanvas || !fxCanvas) return;

      const stageCtx = stageCanvas.getContext('2d');
      const fxCtx = fxCanvas.getContext('2d');
      if (!stageCtx || !fxCtx) return;

      const sw = stageCanvas.width;
      const sh = stageCanvas.height;
      const fw = fxCanvas.width;
      const fh = fxCanvas.height;

      const hasVideo =
        sourceKindRef.current !== 'none' &&
        video &&
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        video.videoHeight > 0;

      if (!hasVideo) {
        stageCtx.clearRect(0, 0, sw, sh);
        fxCtx.clearRect(0, 0, fw, fh);
        lastVideoFrameTime = -1;
        return;
      }

      // 1. Run MediaPipe PoseLandmarker whenever a fresh video frame arrives
      const landmarker = landmarkerRef.current;
      if (landmarker && video.currentTime !== lastVideoFrameTime) {
        lastVideoFrameTime = video.currentTime;
        const monotonicTs = Math.max(lastInferTimestampMs + 1, Math.round(nowMs));
        lastInferTimestampMs = monotonicTs;

        const t0 = performance.now();
        try {
          const result = landmarker.detectForVideo(video, monotonicTs);
          lastInferenceMs = performance.now() - t0;

          if (result.landmarks && result.landmarks.length > 0) {
            rawLandmarks = result.landmarks[0];
            const rawWorld = result.worldLandmarks?.[0] ?? null;

            smoothedLandmarks = oneEuroRef.current
              ? smootherRef.current.smooth(rawLandmarks, monotonicTs)
              : rawLandmarks;

            // Also smooth worldLandmarks using PoseLandmarkSmoother.smoothWorld if present
            worldLandmarks =
              oneEuroRef.current && rawWorld && typeof smootherRef.current.smoothWorld === 'function'
                ? smootherRef.current.smoothWorld(rawWorld, monotonicTs)
                : rawWorld;
          } else {
            rawLandmarks = null;
            smoothedLandmarks = null;
            worldLandmarks = null;
          }
        } catch {
          // Ignore transient frame decode errors on video seek/loop
        }
      }

      // 2. Classify Akaza Soryu Pose & advance hysteresis state machine
      const poseEval = trackerRef.current.update(
        smoothedLandmarks,
        worldLandmarks,
        modeRef.current,
        nowMs,
        simulateRef.current,
      );

      // 3. Compute exact video-to-canvas transform
      const fit = sourceKindRef.current === 'camera' ? 'cover' : 'contain';
      const stageRect = computeViewportRect(video.videoWidth, video.videoHeight, sw, sh, fit);
      const fxRect = computeViewportRect(video.videoWidth, video.videoHeight, fw, fh, fit);
      const isMirrored = mirroredRef.current;
      const shake = fxEngineRef.current.getShakeOffset();
      const stageShakeX = (shake.x * sw) / fw;
      const stageShakeY = (shake.y * sh) / fh;

      stageCtx.save();
      stageCtx.fillStyle = '#030509';
      stageCtx.fillRect(0, 0, sw, sh);
      stageCtx.translate(stageShakeX, stageShakeY);
      if (isMirrored) {
        stageCtx.translate(stageRect.offsetX * 2 + stageRect.drawWidth, 0);
        stageCtx.scale(-1, 1);
      }
      stageCtx.drawImage(
        video,
        stageRect.offsetX,
        stageRect.offsetY,
        stageRect.drawWidth,
        stageRect.drawHeight,
      );
      stageCtx.restore();

      // 4. Remap normalized pose anchors into FX canvas-normalized space (in-place mutation, 0 allocations)
      const mappedPose = mappedPoseRef.current;
      mappedPose.hasPerson = poseEval.hasPerson;
      mappedPose.resolvedMode = poseEval.resolvedMode;
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
      fxEngineRef.current.render(
        fxCtx,
        fw,
        fh,
        dtSec,
        mappedPose,
        mappedLandmarks,
        false,
        fxHooksRef.current,
      );

      // 6. Optional CV Debug Skeleton overlay
      if (showHudRef.current) {
        drawDebugSkeleton(fxCtx, smoothedLandmarks, rawLandmarks, poseEval, fxRect, isMirrored);
      }
      lastFxRenderMs = performance.now() - fxT0;

      // 7. Emit throttled UI telemetry (~15Hz)
      if (nowMs - lastHudEmitMs >= 66) {
        lastHudEmitMs = nowMs;
        setTelemetry({
          fps: currentFps,
          inferenceMs: lastInferenceMs,
          fxRenderMs: lastFxRenderMs,
          pose: poseEval,
          engineInfo: engineInfoRef.current,
        });
      }
    };

    rafId = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resizeCanvases);
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

      {/* 60fps Anime VFX + Debug Skeleton canvas */}
      <canvas ref={fxCanvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

      {/* Unified non-intrusive top broadcast rail */}
      {sourceKind !== 'none' && (
        <header className="pointer-events-none absolute top-4 inset-x-6 z-20 flex items-center justify-between">
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
                telemetry.pose.state === 'ACTIVE'
                  ? 'text-[#38bdf8] font-medium'
                  : 'text-slate-400'
              }`}
            >
              {telemetry.pose.state}
            </span>
          </div>

          {/* Right Panels: Pose Guide & Telemetry HUD */}
          <div className="flex flex-col items-end gap-3 pointer-events-none">
            {showHud && (
              <TechHud
                telemetry={telemetry}
                oneEuroEnabled={oneEuroEnabled}
                onToggleOneEuro={() => setOneEuroEnabled((v) => !v)}
              />
            )}
            {showGuide && !showHud && (
              <PoseGuideCard
                poseState={telemetry.pose.state}
                resolvedMode={telemetry.pose.resolvedMode}
                chargeProgress={telemetry.pose.chargeProgress}
                onDismiss={() => setShowGuide(false)}
              />
            )}
          </div>
        </header>
      )}

      {/* Razor-thin right-edge vertical Stance Lock hairline meter */}
      {sourceKind !== 'none' && <StanceLockMeter confidence={telemetry.pose.rawConfidence} />}

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
                disabled={modelStatus === 'loading'}
                className="group inline-flex items-center gap-2.5 rounded-full border border-[#38bdf8]/40 bg-[#030611]/90 px-6 py-3 font-mono text-xs tracking-wider text-[#f8fafc] hover:border-[#38bdf8] hover:bg-slate-900/90 disabled:opacity-40 transition duration-300 backdrop-blur-md cursor-pointer"
              >
                <Camera className="h-3.5 w-3.5 text-[#38bdf8]" />
                <span>
                  {modelStatus === 'loading' ? 'Initializing Vision Engine…' : 'Initialize Camera'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={modelStatus === 'loading'}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-transparent px-5 py-3 font-mono text-xs tracking-wider text-slate-300 hover:border-white/30 hover:text-white disabled:opacity-40 transition duration-300 cursor-pointer"
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
              <span>SHORTCUTS: [D] TELEMETRY · [S] SIMULATE · [G] GUIDE</span>
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
          {/* AUTO | FULL | DESK Segmented Mode Toggle */}
          <div className="flex items-center rounded-full bg-white/5 p-0.5 border border-white/5">
            {(['auto', 'full-body', 'upper-body'] as DetectionMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-full px-2 py-0.5 text-[10px] font-mono tracking-wider transition cursor-pointer whitespace-nowrap ${
                  mode === m
                    ? 'bg-white/15 text-[#f8fafc] font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {m === 'auto' ? 'AUTO' : m === 'full-body' ? 'FULL' : 'DESK'}
              </button>
            ))}
          </div>

          <div className="h-4 w-px bg-white/10 mx-0.5" />

          {/* Preview (S) / Manual Trigger */}
          <button
            type="button"
            onClick={() => {
              soundEngineRef.current.unlock();
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
              soundEngineRef.current.unlock();
              setMuted((v) => !v);
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
