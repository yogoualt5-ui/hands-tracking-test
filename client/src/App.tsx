/**
 * App.tsx — Root orchestrator for the Hand Tracking Shader App
 *
 * Design Philosophy: Invisible UI — the app is purely visual when active.
 * Loading/error states use a minimal dark overlay. All high-frequency data
 * lives in refs to prevent React re-render loops.
 *
 * Architecture:
 *  - Camera init → MediaPipe init → RAF loop
 *  - videoReady + modelReady gates activation
 *  - boxRef: normalized [cx, cy, w, h] for shader
 *  - smoothedBoxRef: lerp-smoothed version of boxRef
 *  - gestureState: state machine for peace/fist gestures
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import EffectsCanvas from "./components/EffectsCanvas";
import GestureDropdown from "./components/GestureDropdown";

// ─── Types ────────────────────────────────────────────────────────────────────

type AppStatus = "loading-camera" | "loading-model" | "active" | "error";

interface BoxData {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LERP_FACTOR = 0.2;
const DETECTION_INTERVAL_MS = 1000 / 30; // ~30 FPS cap
const CLAP_THRESHOLD = 0.1;
const CLAP_COOLDOWN_MS = 1000;
const GESTURE_CONFIRM_MS = 500;
const GESTURE_COOLDOWN_MS = 500;

const MEDIAPIPE_WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpBox(prev: BoxData, next: BoxData, t: number): BoxData {
  return {
    cx: lerp(prev.cx, next.cx, t),
    cy: lerp(prev.cy, next.cy, t),
    w: lerp(prev.w, next.w, t),
    h: lerp(prev.h, next.h, t),
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function App() {
  // ── Refs ──────────────────────────────────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const rafRef = useRef<number>(0);
  const lastDetectTimeRef = useRef<number>(0);
  const lastClapTimeRef = useRef<number>(0);
  const boxRef = useRef<BoxData>({ cx: 0.5, cy: 0.5, w: 0, h: 0 });
  const smoothedBoxRef = useRef<BoxData>({ cx: 0.5, cy: 0.5, w: 0, h: 0 });
  const videoReadyRef = useRef(false);
  const modelReadyRef = useRef(false);

  // Gesture state machine refs
  const currentGestureRef = useRef<string | null>(null);
  const gestureStartTimeRef = useRef<number>(0);
  const confirmedGestureRef = useRef<string | null>(null);
  const lastGestureActionTimeRef = useRef<number>(0);

  // ── State (minimal — only for UI layer) ───────────────────────────────────
  const [status, setStatus] = useState<AppStatus>("loading-camera");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [effectIndex, setEffectIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpenRef = useRef(false);

  // Keep menuOpenRef in sync with menuOpen state
  useEffect(() => {
    menuOpenRef.current = menuOpen;
  }, [menuOpen]);

  // ── Camera init ───────────────────────────────────────────────────────────
  const initCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: "user" },
      });

      const video = videoRef.current;
      if (!video) return;

      video.srcObject = stream;

      await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => resolve();
      });

      await video.play();

      // Poll until readyState === 4 (HAVE_ENOUGH_DATA)
      await new Promise<void>((resolve) => {
        const check = () => {
          if (video.readyState === 4) {
            resolve();
          } else {
            requestAnimationFrame(check);
          }
        };
        check();
      });

      videoReadyRef.current = true;
      setStatus("loading-model");
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Camera access denied or unavailable.";
      setErrorMsg(msg);
      setStatus("error");
    }
  }, []);

  // ── MediaPipe init ────────────────────────────────────────────────────────
  const initMediaPipe = useCallback(async () => {
    try {
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);

      let landmarker: HandLandmarker;

      // Try GPU delegate first, fall back to CPU
      try {
        landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numHands: 2,
        });
      } catch {
        console.warn("GPU delegate failed, falling back to CPU");
        landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
            delegate: "CPU",
          },
          runningMode: "VIDEO",
          numHands: 2,
        });
      }

      landmarkerRef.current = landmarker;
      modelReadyRef.current = true;
      setStatus("active");
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to load AI model.";
      setErrorMsg(msg);
      setStatus("error");
    }
  }, []);

  // ── Finger up detection ───────────────────────────────────────────────────
  const isFingerUp = useCallback(
    (
      landmarks: Array<{ x: number; y: number; z: number }>,
      tipIdx: number,
      pipIdx: number
    ): boolean => {
      return landmarks[tipIdx].y < landmarks[pipIdx].y;
    },
    []
  );

  // ── Gesture detection ─────────────────────────────────────────────────────
  const detectGesture = useCallback(
    (
      landmarks: Array<{ x: number; y: number; z: number }>
    ): string | null => {
      const indexUp = isFingerUp(landmarks, 8, 6);
      const middleUp = isFingerUp(landmarks, 12, 10);
      const ringUp = isFingerUp(landmarks, 16, 14);
      const pinkyUp = isFingerUp(landmarks, 20, 18);

      // Peace sign: index + middle up, ring + pinky down
      if (indexUp && middleUp && !ringUp && !pinkyUp) return "peace";

      // Fist: all fingers down
      if (!indexUp && !middleUp && !ringUp && !pinkyUp) return "fist";

      return null;
    },
    [isFingerUp]
  );

  // ── Draw 2D overlay ───────────────────────────────────────────────────────
  const drawOverlay = useCallback(
    (
      landmarks: Array<Array<{ x: number; y: number; z: number }>>,
      width: number,
      height: number
    ) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      canvas.width = width;
      canvas.height = height;
      ctx.clearRect(0, 0, width, height);

      // Finger connection pairs
      const connections = [
        [0, 1], [1, 2], [2, 3], [3, 4],
        [0, 5], [5, 6], [6, 7], [7, 8],
        [5, 9], [9, 10], [10, 11], [11, 12],
        [9, 13], [13, 14], [14, 15], [15, 16],
        [13, 17], [17, 18], [18, 19], [19, 20],
        [0, 17],
      ];

      for (const hand of landmarks) {
        // Draw connections
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 1.5;
        for (const [a, b] of connections) {
          const ax = (1 - hand[a].x) * width;
          const ay = hand[a].y * height;
          const bx = (1 - hand[b].x) * width;
          const by = hand[b].y * height;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        }

        // Draw nodes
        for (const lm of hand) {
          const x = (1 - lm.x) * width;
          const y = lm.y * height;
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fillStyle = "white";
          ctx.fill();
        }
      }
    },
    []
  );

  // ── Main RAF loop ─────────────────────────────────────────────────────────
  const loop = useCallback(() => {
    rafRef.current = requestAnimationFrame(loop);

    const video = videoRef.current;
    const landmarker = landmarkerRef.current;

    if (!videoReadyRef.current || !modelReadyRef.current) return;
    if (!video || !landmarker) return;
    if (video.readyState !== 4) return;

    const now = performance.now();

    // Throttle detection to ~30 FPS
    if (now - lastDetectTimeRef.current < DETECTION_INTERVAL_MS) return;
    lastDetectTimeRef.current = now;

    // Run detection safely
    let results;
    try {
      results = landmarker.detectForVideo(video, now);
    } catch {
      return; // Skip frame on detection error
    }

    const landmarks = results.landmarks ?? [];
    const width = video.videoWidth;
    const height = video.videoHeight;

    // Draw 2D overlay
    drawOverlay(landmarks, width, height);

    // ── Gesture state machine (runs on first hand if available) ─────────────
    const firstHand = landmarks[0] ?? null;

    if (!firstHand) {
      // No hands → reset gesture tracking
      currentGestureRef.current = null;
      gestureStartTimeRef.current = 0;
    } else {
      const detected = detectGesture(firstHand);

      if (detected !== currentGestureRef.current) {
        currentGestureRef.current = detected;
        gestureStartTimeRef.current = now;
      } else if (
        detected !== null &&
        now - gestureStartTimeRef.current >= GESTURE_CONFIRM_MS &&
        now - lastGestureActionTimeRef.current >= GESTURE_COOLDOWN_MS
      ) {
        // Gesture confirmed — trigger action ONCE
        if (detected !== confirmedGestureRef.current) {
          confirmedGestureRef.current = detected;
          lastGestureActionTimeRef.current = now;

          if (detected === "peace" && !menuOpenRef.current) {
            setMenuOpen(true);
          } else if (detected === "fist" && menuOpenRef.current) {
            setMenuOpen(false);
          }
        }
      } else if (detected === null) {
        confirmedGestureRef.current = null;
      }
    }

    // ── Box + clap logic (only when menu is closed) ──────────────────────────
    if (menuOpenRef.current) return;

    if (landmarks.length !== 2) {
      // Hide box when not exactly 2 hands
      boxRef.current = { cx: 0.5, cy: 0.5, w: 0, h: 0 };
      smoothedBoxRef.current = lerpBox(
        smoothedBoxRef.current,
        boxRef.current,
        LERP_FACTOR
      );
      return;
    }

    const [hand1, hand2] = landmarks;
    const lm1 = hand1[9];
    const lm2 = hand2[9];

    if (!lm1 || !lm2) return;

    const dx = lm2.x - lm1.x;
    const dy = lm2.y - lm1.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Clap detection
    if (
      distance < CLAP_THRESHOLD &&
      now - lastClapTimeRef.current > CLAP_COOLDOWN_MS
    ) {
      lastClapTimeRef.current = now;
      boxRef.current = { cx: 0, cy: 0, w: 0, h: 0 };
      smoothedBoxRef.current = { cx: 0, cy: 0, w: 0, h: 0 };
      return;
    }

    // Compute box
    const cx = (lm1.x + lm2.x) / 2;
    const cy = (lm1.y + lm2.y) / 2;
    const w = Math.min(1, distance * 1.2);
    const h = w * 0.8;

    // Validate (no NaN, no too-small values)
    if (isNaN(cx) || isNaN(cy) || isNaN(w) || isNaN(h) || w < 0.01) return;

    const newBox: BoxData = {
      cx: Math.max(0, Math.min(1, cx)),
      cy: Math.max(0, Math.min(1, cy)),
      w: Math.max(0, Math.min(1, w)),
      h: Math.max(0, Math.min(1, h)),
    };

    boxRef.current = newBox;
    smoothedBoxRef.current = lerpBox(smoothedBoxRef.current, newBox, LERP_FACTOR);
  }, [drawOverlay, detectGesture]);

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  useEffect(() => {
    initCamera();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      const video = videoRef.current;
      if (video?.srcObject) {
        (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      }
    };
  }, [initCamera]);

  useEffect(() => {
    if (status === "loading-model") {
      initMediaPipe();
    }
  }, [status, initMediaPipe]);

  useEffect(() => {
    if (status === "active") {
      rafRef.current = requestAnimationFrame(loop);
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
      };
    }
  }, [status, loop]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-black">
      {/* Hidden video element */}
      <video
        ref={videoRef}
        className="absolute opacity-0 pointer-events-none"
        playsInline
        muted
      />

      {/* WebGL shader canvas (fullscreen) */}
      {status === "active" && (
        <EffectsCanvas
          videoRef={videoRef}
          smoothedBoxRef={smoothedBoxRef}
          effectIndex={effectIndex}
        />
      )}

      {/* 2D landmark overlay */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ zIndex: 10 }}
      />

      {/* Loading state */}
      {(status === "loading-camera" || status === "loading-model") && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black z-50">
          <div className="flex flex-col items-center gap-6">
            {/* Animated ring */}
            <div className="relative w-20 h-20">
              <div className="absolute inset-0 rounded-full border-2 border-white/10" />
              <div
                className="absolute inset-0 rounded-full border-2 border-t-white border-r-transparent border-b-transparent border-l-transparent animate-spin"
                style={{ animationDuration: "1s" }}
              />
            </div>
            <div className="text-center">
              <p className="text-white/90 text-sm font-mono tracking-widest uppercase">
                {status === "loading-camera"
                  ? "Waiting for camera..."
                  : "Loading AI model..."}
              </p>
              <p className="text-white/30 text-xs mt-2 font-mono">
                {status === "loading-camera"
                  ? "Please allow camera access"
                  : "Initializing MediaPipe hand tracking"}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Error state */}
      {status === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black z-50">
          <div className="flex flex-col items-center gap-6 max-w-sm text-center px-6">
            <div className="w-16 h-16 rounded-full border border-red-500/50 flex items-center justify-center">
              <span className="text-red-400 text-2xl">!</span>
            </div>
            <div>
              <p className="text-white text-base font-mono mb-2">
                Initialization Failed
              </p>
              <p className="text-white/50 text-sm font-mono">{errorMsg}</p>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-2 border border-white/20 text-white/80 text-sm font-mono tracking-widest uppercase hover:bg-white/10 transition-colors"
            >
              Reload
            </button>
          </div>
        </div>
      )}

      {/* Gesture-controlled dropdown */}
      {status === "active" && (
        <GestureDropdown
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          effectIndex={effectIndex}
          onEffectChange={(idx) => {
            setEffectIndex(idx);
            setMenuOpen(false);
          }}
        />
      )}

      {/* Hint overlay (shown when active) */}
      {status === "active" && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
          <p className="text-white/20 text-xs font-mono tracking-widest uppercase text-center">
            ✌️ Peace sign to open menu &nbsp;·&nbsp; 👊 Fist to close
          </p>
        </div>
      )}
    </div>
  );
}
