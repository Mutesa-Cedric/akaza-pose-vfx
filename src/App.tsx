import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Camera,
  CameraOff,
  FlipHorizontal2,
  HelpCircle,
  Pause,
  Play,
  Sparkles,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  AkazaPoseTracker,
  type DetectionMode,
  type PoseEvaluation,
  type Vec2,
} from './cv/akazaPoseClassifier';
import { PoseLandmarkSmoother, type Landmark3D } from './cv/oneEuroFilter';
import {
  createPoseEngine,
  type PoseEngineInfo,
  type PoseLandmarker,
} from './cv/poseLandmarker';
import { AfterglowFxEngine } from './fx/afterglowEngine';
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

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fxCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Core CV & FX engine instances (kept in refs to avoid React re-renders inside RAF)
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const smootherRef = useRef(new PoseLandmarkSmoother(33));
  const trackerRef = useRef(new AkazaPoseTracker());
  const fxEngineRef = useRef(new AfterglowFxEngine());
  const soundEngineRef = useRef(new AfterglowSoundEngine());

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

  const startCamera = useCallback(async () => {
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
          facingMode: 'user',
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

      setMirrored(true);
      setVideoPaused(false);
      sourceKindRef.current = 'camera';
      setSourceKind('camera');
    } catch (err) {
      console.error('[Camera] Access denied or unavailable:', err);
      setErrorMsg(
        'Could not open webcam. Please allow camera permissions or use "Test Video" to try a clip.',
      );
    }
  }, [stopActiveMedia]);

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

  // Keyboard shortcuts for smooth live interview demoing
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

  // Main 60fps CV + Anime VFX Render Loop (mounts once; reads mutable refs)
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

    // FPS & HUD throttle accumulators (update React state at ~15Hz, render canvas at 60Hz)
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
      // Cap FX canvas DPR at 1.5 to cut Retina fill-rate by ~44% with crisp additive bloom
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
            worldLandmarks = result.worldLandmarks?.[0] ?? null;
            smoothedLandmarks = oneEuroRef.current
              ? smootherRef.current.smooth(rawLandmarks, monotonicTs)
              : rawLandmarks;
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

      // 3. Compute exact video-to-canvas transform (cover for webcam, contain for test video)
      const fit = sourceKindRef.current === 'camera' ? 'cover' : 'contain';
      const stageRect = computeViewportRect(video.videoWidth, video.videoHeight, sw, sh, fit);
      const fxRect = computeViewportRect(video.videoWidth, video.videoHeight, fw, fh, fit);
      const isMirrored = mirroredRef.current;
      const shake = fxEngineRef.current.getShakeOffset();
      const stageShakeX = (shake.x * sw) / fw;
      const stageShakeY = (shake.y * sh) / fh;

      // Draw live video frame onto stage canvas with synchronized micro-shake
      stageCtx.save();
      stageCtx.fillStyle = '#05070f';
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

      // 4. Remap normalized pose anchors into FX canvas-normalized space for pixel-exact alignment
      const toFxNorm = (p: Vec2): Vec2 => ({
        x: (fxRect.offsetX + (isMirrored ? 1 - p.x : p.x) * fxRect.drawWidth + shake.x) / fw,
        y: (fxRect.offsetY + p.y * fxRect.drawHeight + shake.y) / fh,
      });

      const mappedPose: PoseEvaluation = {
        ...poseEval,
        floorAnchor: toFxNorm(poseEval.floorAnchor),
        bodyCenter: toFxNorm(poseEval.bodyCenter),
        leadWrist: toFxNorm(poseEval.leadWrist),
        rearWrist: toFxNorm(poseEval.rearWrist),
        bodyScale: (poseEval.bodyScale * fxRect.drawWidth) / fw,
      };

      let mappedLandmarks: Landmark3D[] | null = null;
      if (smoothedLandmarks) {
        const count = Math.min(smoothedLandmarks.length, mappedLandmarksBuf.length);
        for (let i = 0; i < count; i++) {
          const lm = smoothedLandmarks[i];
          const dst = mappedLandmarksBuf[i];
          dst.x = (fxRect.offsetX + (isMirrored ? 1 - lm.x : lm.x) * fxRect.drawWidth + shake.x) / fw;
          dst.y = (fxRect.offsetY + lm.y * fxRect.drawHeight + shake.y) / fh;
          dst.z = lm.z;
          dst.visibility = lm.visibility;
        }
        mappedLandmarks = mappedLandmarksBuf;
      }

      // 5. Render layered Anime Blue Silver Chaotic Afterglow VFX & time its frame cost
      const fxT0 = performance.now();
      fxEngineRef.current.render(fxCtx, fw, fh, dtSec, mappedPose, mappedLandmarks, false, {
        onActivate: () => soundEngineRef.current.playActivate(),
        onBarrageTick: () => soundEngineRef.current.playBarrageSlice(),
        onPunchBurst: () => soundEngineRef.current.playPunchBurst(),
        onDissipate: () => soundEngineRef.current.playDissipate(),
      });

      // 6. Optional CV Debug Skeleton overlay (when Tech HUD is visible)
      if (showHudRef.current) {
        drawDebugSkeleton(fxCtx, smoothedLandmarks, rawLandmarks, poseEval, fxRect, isMirrored);
      }
      lastFxRenderMs = performance.now() - fxT0;

      // 7. Emit throttled UI telemetry (~15Hz) so React never bottlenecks 60fps rendering
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

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#05070f] select-none">
      {/* Hidden source <video> decoded into the stage canvas */}
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

      {/* 60fps Anime VFX + optional Debug Skeleton canvas */}
      <canvas ref={fxCanvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

      {/* Top Left Brand Badge (subtle when camera is running) */}
      {sourceKind !== 'none' && (
        <header className="pointer-events-none absolute top-4 left-4 z-20 flex items-center gap-2.5">
          <div className="flex items-center gap-2 rounded-full border border-cyan-400/20 bg-slate-950/65 px-3.5 py-1.5 backdrop-blur-md">
            <span
              className={`h-2 w-2 rounded-full ${
                telemetry.pose.state === 'ACTIVE'
                  ? 'bg-cyan-300 shadow-[0_0_10px_#38bdf8] animate-pulse'
                  : 'bg-emerald-400'
              }`}
            />
            <span className="font-calligraphy text-sm tracking-wider text-cyan-100">
              青銀亂殘光
            </span>
            <span className="text-[11px] font-mono text-slate-400">
              {sourceKind === 'camera' ? 'LIVE' : 'TEST CLIP'}
            </span>
          </div>
        </header>
      )}

      {/* Top Right Panels: Pose Guide & Toggleable CV Telemetry HUD */}
      {sourceKind !== 'none' && (
        <div className="pointer-events-none absolute top-4 right-4 z-20 flex flex-col items-end gap-3">
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
      )}

      {/* Cinematic Landing Overlay before camera starts */}
      {sourceKind === 'none' && (
        <section className="relative z-20 flex h-full w-full flex-col items-center justify-center px-6 text-center">
          {/* Ambient radial glow */}
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(56,189,248,0.16),rgba(15,23,42,0.5)_45%,rgba(5,7,15,0.96)_78%)]" />

          <div className="relative max-w-xl space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-950/40 px-4 py-1.5 text-xs font-mono tracking-wider text-cyan-200 backdrop-blur-md">
              <Sparkles className="h-3.5 w-3.5 text-cyan-300" />
              <span>REAL-TIME IN-BROWSER POSE VFX · MEDIAPIPE + ONE-EURO</span>
            </div>

            <div className="space-y-2">
              <p className="font-calligraphy text-lg tracking-[0.35em] text-sky-300/90">
                破壊殺・終式
              </p>
              <h1 className="font-calligraphy text-5xl sm:text-6xl font-bold tracking-wider bg-gradient-to-b from-white via-sky-100 to-cyan-400 bg-clip-text text-transparent drop-shadow-[0_0_28px_rgba(56,189,248,0.45)]">
                青銀亂殘光
              </h1>
              <p className="text-sm sm:text-base font-medium tracking-[0.2em] uppercase text-slate-300">
                Blue Silver Chaotic Afterglow
              </p>
            </div>

            <p className="mx-auto max-w-md text-sm leading-relaxed text-slate-300">
              Strike Akaza&apos;s <span className="text-cyan-200 font-medium">Soryu martial arts stance</span>{' '}
              in front of your camera to unleash his 12-point Snowflake Compass Needle and a
              100-strike blue-silver afterglow barrage — running 100% locally in your browser.
            </p>

            {errorMsg && (
              <div className="rounded-xl border border-rose-500/40 bg-rose-950/50 px-4 py-2.5 text-xs text-rose-200">
                {errorMsg}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={startCamera}
                disabled={modelStatus === 'loading'}
                className="group inline-flex items-center gap-2.5 rounded-full bg-gradient-to-r from-sky-400 to-cyan-300 px-7 py-3.5 text-sm font-semibold text-slate-950 shadow-[0_0_32px_rgba(56,189,248,0.45)] hover:shadow-[0_0_44px_rgba(56,189,248,0.7)] hover:brightness-105 disabled:opacity-55 transition cursor-pointer"
              >
                <Camera className="h-4 w-4" />
                <span>
                  {modelStatus === 'loading' ? 'Loading Pose Model…' : 'Open Camera & Begin'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={modelStatus === 'loading'}
                className="inline-flex items-center gap-2 rounded-full border border-slate-700/90 bg-slate-900/75 px-5 py-3.5 text-sm font-medium text-slate-200 hover:border-cyan-400/50 hover:text-white disabled:opacity-55 transition backdrop-blur-md cursor-pointer"
              >
                <Upload className="h-4 w-4 text-cyan-300" />
                <span>Test with Video Clip</span>
              </button>
            </div>

            <div className="pt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11px] font-mono text-slate-400">
              <span>
                Engine:{' '}
                <strong className="text-slate-200">
                  {modelStatus === 'ready'
                    ? `${engineInfo?.modelName} (${engineInfo?.delegate})`
                    : modelStatus === 'loading'
                      ? 'Initializing WASM/WebGL…'
                      : 'Unavailable'}
                </strong>
              </span>
              <span>·</span>
              <span>
                Press <kbd className="rounded bg-slate-800 px-1.5 py-0.5 text-cyan-300">D</kbd> for CV Telemetry HUD
              </span>
            </div>
          </div>
        </section>
      )}

      {/* Floating Glass Control Bar when Camera / Video is Active */}
      {sourceKind !== 'none' && (
        <nav className="absolute bottom-5 left-1/2 z-20 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-white/12 bg-slate-950/75 px-2.5 py-2 backdrop-blur-xl shadow-2xl max-w-[95vw] overflow-x-auto">
          {/* Detection Mode Pill */}
          <div className="flex items-center rounded-full bg-slate-900/90 p-0.5 border border-slate-800">
            {(['auto', 'full-body', 'upper-body'] as DetectionMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition cursor-pointer whitespace-nowrap ${
                  mode === m
                    ? 'bg-cyan-400/20 text-cyan-200 shadow-inner'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {m === 'auto' ? 'Auto' : m === 'full-body' ? 'Full Body' : 'Desk'}
              </button>
            ))}
          </div>

          <div className="h-5 w-px bg-slate-800 mx-0.5" />

          {/* Simulate Pose Preview */}
          <button
            type="button"
            onClick={() => {
              soundEngineRef.current.unlock();
              setSimulateActive((v) => !v);
            }}
            title="Preview effect manually (S)"
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition cursor-pointer whitespace-nowrap ${
              simulateActive
                ? 'bg-cyan-400 text-slate-950 shadow-[0_0_18px_rgba(56,189,248,0.65)]'
                : 'text-slate-200 hover:bg-slate-800/90'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>{simulateActive ? 'Simulating' : 'Preview FX'}</span>
          </button>

          {/* Upload Test Video / Switch back to Camera */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Run pose detection on a local video clip"
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800/90 transition cursor-pointer whitespace-nowrap"
          >
            <Upload className="h-3.5 w-3.5 text-cyan-300" />
            <span className="hidden sm:inline">Test Video</span>
          </button>

          {sourceKind === 'video' && (
            <>
              <button
                type="button"
                onClick={toggleVideoPause}
                title={videoPaused ? 'Resume video (Space)' : 'Pause video (Space)'}
                className="rounded-full p-2 text-cyan-200 hover:bg-slate-800/90 transition cursor-pointer"
              >
                {videoPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={startCamera}
                title="Switch back to live webcam"
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-slate-800/90 transition cursor-pointer whitespace-nowrap"
              >
                <Camera className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Webcam</span>
              </button>
            </>
          )}

          {/* Mirror toggle */}
          <button
            type="button"
            onClick={() => setMirrored((v) => !v)}
            title="Mirror video"
            className={`rounded-full p-2 transition cursor-pointer ${
              mirrored ? 'text-cyan-300 bg-cyan-500/15' : 'text-slate-400 hover:bg-slate-800'
            }`}
          >
            <FlipHorizontal2 className="h-4 w-4" />
          </button>

          {/* Audio Mute toggle */}
          <button
            type="button"
            onClick={() => {
              soundEngineRef.current.unlock();
              setMuted((v) => !v);
            }}
            title="Toggle sound FX (M)"
            className={`rounded-full p-2 transition cursor-pointer ${
              !muted ? 'text-cyan-300 bg-cyan-500/15' : 'text-slate-400 hover:bg-slate-800'
            }`}
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>

          {/* Pose Guide toggle */}
          <button
            type="button"
            onClick={() => setShowGuide((v) => !v)}
            title="Toggle pose guide (G)"
            className={`rounded-full p-2 transition cursor-pointer ${
              showGuide ? 'text-cyan-300 bg-cyan-500/15' : 'text-slate-400 hover:bg-slate-800'
            }`}
          >
            <HelpCircle className="h-4 w-4" />
          </button>

          {/* CV Tech HUD toggle */}
          <button
            type="button"
            onClick={() => setShowHud((v) => !v)}
            title="Toggle CV Telemetry HUD & skeleton (D)"
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-mono font-medium transition cursor-pointer whitespace-nowrap ${
              showHud
                ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-400/50'
                : 'text-slate-300 hover:bg-slate-800/90'
            }`}
          >
            <Activity className="h-3.5 w-3.5" />
            <span>HUD</span>
          </button>

          {/* Stop camera */}
          <button
            type="button"
            onClick={stopActiveMedia}
            title="Stop camera"
            className="rounded-full p-2 text-rose-300 hover:bg-rose-500/20 transition cursor-pointer"
          >
            <CameraOff className="h-4 w-4" />
          </button>
        </nav>
      )}
    </main>
  );
}
