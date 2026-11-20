# 破壊殺・終式 青銀亂殘光 — Akaza Pose VFX

**Live Demo:** [https://akaza.mcedric.dev](https://akaza.mcedric.dev)

A real-time, 100% in-browser camera VFX web app inspired by Akaza's **Destructive Death — Final Form: Blue Silver Chaotic Afterglow** (*Hakai-satsu, Shūshiki: Aogin Ranzankō*) from *Demon Slayer: Kimetsu no Yaiba*.

Strike Akaza's **Soryu martial arts stance** in front of your webcam to project his rotating 12-point **Snowflake Compass Needle** (*破壊殺・羅針*) beneath your feet and unleash an anime-inspired barrage of blue-silver shockwaves, glowing aura wisps, firework bursts, and procedural sound effects.

---

## Features

- **100% Client-Side Real-Time CV**: Runs MediaPipe Tasks Vision (`PoseLandmarker` BlazePose Lite FP16) locally in the browser using WebGL/GPU acceleration with automatic CPU/WASM fallback.
- **One-Euro Adaptive Landmark Smoothing**: Implements the [One-Euro Filter](https://gery.casiez.net/1euro/) (`minCutoff: 1.8Hz`, `beta: 0.04`) per landmark axis with automatic stale-gap reset and pre-allocated zero-GC buffers.
- **Scale-, Angle-, and Mirror-Invariant Pose Classifier**: Combines 3D `worldLandmarks` joint flexion angles with 2D normalized proportions to detect Akaza's stance regardless of distance from the camera, left/right lead side, or slight 3/4 body rotation:
  - Wide horse stance + low knee crouch
  - Asymmetric Soryu guard (lead fist raised at chest/shoulder height, rear fist chambered low near hip/waist)
  - Automatic **Full-Body ↔ Desk Mode** adaptation if lower-body landmarks are out of frame
- **Hysteresis Temporal State Machine**: `IDLE → CHARGING → ACTIVE → DISSIPATING` with entry debounce (`220ms`) and exit hysteresis (`340ms`) to prevent false triggers and flicker.
- **Layered 60fps Anime VFX Engine**:
  - Midnight-indigo domain color grade & radial vignette
  - Pre-baked offscreen sprite **12-point Snowflake Compass Needle** with frost barbs & kanji numerals (`壱`–`拾弐`) projected onto the floor between the user's ankles (zero per-frame `shadowBlur`)
  - Omni-directional **100-strike shockwave slashes**, Koyuki-inspired **blue-silver firework bursts**, rising diamond embers, anime speed lines, and reactive **fist punch bursts**
  - Pre-baked calligraphy title reveal (`破壊殺・終式 青銀亂殘光`) + damped micro camera-shake
- **Procedural Web Audio FX**: Synthesized domain drop sub-bass, crystalline compass chimes, and air-slice whooshes using the Web Audio API (zero external audio assets).
- **Engineer CV Telemetry HUD (`D` key)**: Live FPS, inference latency (ms), FX render cost (ms), One-Euro filter raw-vs-smoothed toggle, live skeleton overlay, and per-heuristic confidence bars.
- **Video Clip Test Mode**: Load any local `.mov` / `.mp4` clip (with `Space` Play/Pause) to run the exact same real-time CV + VFX pipeline offline.

---

## Architecture

```
Webcam / Test Video
        │
        ▼
MediaPipe PoseLandmarker (GPU/WebGL → CPU fallback)
  ├─ 33x 2D normalized landmarks
  └─ 33x 3D metric worldLandmarks
        │
        ▼
One-Euro Adaptive Filter (33 × 3 axes)
        │
        ▼
Akaza Soryu Pose Classifier + Hysteresis State Machine
  ├─ Stance Width & 3D/2D Squat Depth
  ├─ Lead Fist Guard & Rear Fist Chamber (mirror-invariant)
  └─ IDLE ─► CHARGING ─► ACTIVE ─► DISSIPATING
        │
        ├──► 60fps Layered Canvas VFX Engine (Compass + Afterglow + Calligraphy)
        ├──► Procedural Web Audio Synthesizer
        └──► Throttled 15Hz React Telemetry HUD
```

---

## Running Locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in Chrome, Edge, or Safari and click **Open Camera & Begin**.

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
- **HTML5 Canvas 2D** (additive `lighter` compositing) & **Web Audio API**
