# 破壊殺・終式 青銀亂殘光 — Akaza Pose VFX

**Live Demo:** [https://akaza.mcedric.dev](https://akaza.mcedric.dev)

A real-time, 100% in-browser camera VFX web app inspired by Akaza's **Destructive Death — Final Form: Blue Silver Chaotic Afterglow** (*Hakai-satsu, Shūshiki: Aogin Ranzankō*) from *Demon Slayer: Kimetsu no Yaiba*.

Strike Akaza's **Soryu martial arts stance** in front of your webcam. The 12-point **Snowflake Compass Needle** (*破壊殺・羅針*) opens under your feet, a shockwave bends the room, and four blue-silver silhouettes fan out around you. Each silhouette replays a different moment of your movement.

---

## Features

- **100% Client-Side Real-Time CV**: Runs MediaPipe Tasks Vision (`PoseLandmarker` BlazePose Lite FP16) locally in the browser using WebGL/GPU acceleration with automatic CPU/WASM fallback.
- **One-Euro Adaptive Landmark Smoothing**: Implements the [One-Euro Filter](https://gery.casiez.net/1euro/) (`minCutoff: 1.8Hz`, `beta: 0.04`) per landmark axis with automatic stale-gap reset and reusable landmark buffers.
- **Scale-, Angle-, and Mirror-Invariant Pose Classifier**: Combines 3D `worldLandmarks` joint flexion angles with 2D normalized proportions to detect Akaza's stance regardless of distance from the camera, left/right lead side, or slight 3/4 body rotation:
  - Wide horse stance + low knee crouch
  - Asymmetric Soryu guard (lead fist raised at chest/shoulder height, rear fist chambered low near hip/waist)
  - Automatic **Full-Body ↔ Desk Mode** adaptation if lower-body landmarks are out of frame
- **Hysteresis Temporal State Machine**: `IDLE → CHARGING → ACTIVE → DISSIPATING` with entry debounce (`220ms`) and exit hysteresis (`340ms`) to prevent false triggers and flicker.
- **WebGL 2 camera compositing** uses the pose model's confidence mask to keep the performer in front of the projected compass, rear strikes, and aura. A Sobel filter adds edge lighting, and two low-resolution blur passes add bloom. The shockwave refracts the background camera image.
- **Delayed silhouettes** come from an eight-frame texture array of masked camera snapshots. Four samples replay the performer at delays of roughly 140–470 ms, with positions anchored to the tracked stance.
- **Foreground effects** include blue-silver strikes, firework bursts, wrist-tracked vortices, and a timed calligraphy reveal. The front layer softens over the detected face. The Canvas 2D scene remains available when the WebGL renderer is unavailable.
- **Procedural stereo sound** follows the pose lock, compass impact, and each silhouette's entrance. Foreground strikes sweep across the stereo field, punch accents follow the wrist, and filtered reflections give the crystal sounds a short room tail. Audio is generated in the browser.
- **Engineer CV Telemetry HUD (`D` key)**: Live FPS, inference and matte processing latency, FX submission time, active renderer, One-Euro filter toggle, skeleton overlay, and pose confidence bars.
- **Video Clip Test Mode**: Load a local `.mov` or `.mp4` file supported by your browser to run the camera pipeline on repeatable footage. Press `Space` to pause or resume it.

---

## Architecture

```
Webcam / Test Video
  │
  ▼
MediaPipe PoseLandmarker (GPU → CPU fallback)
  ├─ 2D + 3D landmarks → One-Euro filter → Pose classifier + state machine
  │                                         ├─ Pose anchors + effect timing ──┐
  │                                         └─ Particles, audio, HUD         │
  └─ Person mask → Confidence cleanup + temporal smoothing ─────────────────┤
                                                                              ▼
   WebGL 2 compositor (projected compass, occlusion, echoes, refraction, bloom)
     + Canvas 2D foreground (wrist effects, strikes, calligraphy)
```

This is a camera-relative 2.5D effect. The app projects the compass relative to the tracked feet and uses a soft person mask for foreground and background depth. MediaPipe and the compositor own separate WebGL contexts. For a GPU mask, the app downsamples it into an 8-bit target in the MediaPipe context, reads the confidence bytes inside the inference callback, and uploads them for temporal stabilization. The echo textures hold recent masked frames in browser memory.

---

## Running Locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173` and click **Initialize Camera**. Step back until both feet fit in frame, take a wide stance, bend your knees, and raise one hand while keeping the other near your hip.

### Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `D` | Toggle CV Telemetry HUD & skeleton overlay |
| `S` | Toggle manual FX preview simulation |
| `M` | Mute / unmute procedural sound FX |
| `G` | Show / hide pose stance guide |

---

## Tech Stack

- **React 19 + TypeScript + Vite 6 + Tailwind CSS v4**
- **MediaPipe Tasks Vision** (`@mediapipe/tasks-vision`)
- **WebGL 2 / GLSL**, **Canvas 2D**, and **Web Audio API**
