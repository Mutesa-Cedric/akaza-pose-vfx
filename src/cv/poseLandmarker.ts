import { FilesetResolver, PoseLandmarker, type PoseLandmarkerResult } from '@mediapipe/tasks-vision';

export type InferenceDelegate = 'GPU' | 'CPU';

export interface PoseEngineInfo {
  delegate: InferenceDelegate;
  modelName: string;
}

const WASM_CDN =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';

const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

/**
 * MediaPipe BlazePose 33-landmark indices used by our Akaza pose classifier & FX engine.
 */
export const POSE_IDX = {
  NOSE: 0,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

export const POSE_CONNECTIONS: ReadonlyArray<[number, number]> = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
  [27, 29],
  [29, 31],
  [28, 30],
  [30, 32],
];

let cachedModelBytes: Promise<Uint8Array | null> | null = null;

function prefetchModelBytes(): Promise<Uint8Array | null> {
  if (!cachedModelBytes) {
    cachedModelBytes = fetch(POSE_MODEL_URL, { mode: 'cors', credentials: 'omit' })
      .then((res) => (res.ok ? res.arrayBuffer() : null))
      .then((buf) => (buf ? new Uint8Array(buf) : null))
      .catch(() => null);
  }
  return cachedModelBytes;
}

/**
 * Loads MediaPipe PoseLandmarker in VIDEO mode with GPU delegate first, falling back
 * gracefully to CPU/WASM if WebGL/GPU initialization fails on the user's browser.
 * Downloads the WASM runtime and the 5.7 MB FP16 model in parallel to eliminate the
 * sequential network waterfall on cold loads.
 */
export async function createPoseEngine(outputSegmentationMasks: boolean): Promise<{
  landmarker: PoseLandmarker;
  info: PoseEngineInfo;
}> {
  const [vision, modelBytes] = await Promise.all([
    FilesetResolver.forVisionTasks(WASM_CDN),
    prefetchModelBytes(),
  ]);

  const tryCreate = async (delegate: InferenceDelegate) => {
    const baseOptions = modelBytes
      ? { modelAssetBuffer: modelBytes.slice(), delegate }
      : { modelAssetPath: POSE_MODEL_URL, delegate };

    return PoseLandmarker.createFromOptions(vision, {
      baseOptions,
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.45,
      minPosePresenceConfidence: 0.45,
      minTrackingConfidence: 0.45,
      outputSegmentationMasks,
    });
  };

  try {
    const landmarker = await tryCreate('GPU');
    return {
      landmarker,
      info: { delegate: 'GPU', modelName: 'BlazePose Lite (FP16)' },
    };
  } catch (gpuError) {
    console.warn('[PoseEngine] GPU delegate unavailable, falling back to CPU:', gpuError);
    const landmarker = await tryCreate('CPU');
    return {
      landmarker,
      info: { delegate: 'CPU', modelName: 'BlazePose Lite (FP16)' },
    };
  }
}

export type { PoseLandmarker, PoseLandmarkerResult };
