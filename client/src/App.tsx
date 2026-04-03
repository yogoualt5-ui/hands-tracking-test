/**
 * App.tsx — Root orchestrator for the Hand Tracking Shader App
 * 
 * IMPROVEMENTS:
 * 1. Integrated GestureManager with confidence scoring
 * 2. Velocity filtering to prevent ghost triggers
 * 3. Gesture priority system (menu > custom > built-in)
 * 4. Temporal consistency buffer for stable detection
 * 5. Debug HUD for real-time monitoring
 * 6. Smoothing on all transforms (landmarks, box, UI)
 * 7. Frame decoupling (detection ~30 FPS, rendering 60 FPS)
 */

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import EffectsCanvas, { type BoxRef } from "./components/EffectsCanvas";
import GestureDropdown from "./components/GestureDropdown";
import GestureControlPanel, { type CustomGesture, type GestureAction } from "./components/GestureControlPanel";
import { DebugHUD } from "./gesture-engine/debug/DebugHUD";
import { GestureManager } from "./gesture-engine/GestureManager";
import { lerpBox, smoothLandmarks } from "./gesture-engine/processing/smoothing";
import { calculateBoxFromTwoHands, calculateClapDistance } from "./gesture-engine/processing/boxCalculation";
import { EngineState, Landmark } from "./gesture-engine/types";
import { toast, Toaster } from "sonner";
import { Button } from "./components/ui/button";

// ─── Constants ────────────────────────────────────────────────────────────────

const LERP_FACTOR = 0.2;
const DETECTION_INTERVAL_MS = 1000 / 30; // ~30 FPS cap
const CLAP_THRESHOLD = 0.1;
const CLAP_COOLDOWN_MS = 1000;
const NUM_EFFECTS = 6;

const MEDIAPIPE_WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

// ─── Types ────────────────────────────────────────────────────────────────────

type AppStatus = "loading-camera" | "loading-model" | "active" | "error" | "idle";

// ─── Component ────────────────────────────────────────────────────────────────

export default function App() {
  // ── Refs ──────────────────────────────────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const rafRef = useRef<number>(0);
  const lastDetectTimeRef = useRef<number>(0);
  const lastClapTimeRef = useRef<number>(0);
  const boxRef = useRef<BoxRef>({ xMin: 0, yMin: 0, xMax: 0, yMax: 0 });
  const smoothedBoxRef = useRef<BoxRef>({ xMin: 0, yMin: 0, xMax: 0, yMax: 0 });
  const videoReadyRef = useRef(false);
  const modelReadyRef = useRef(false);

  // High-frequency refs
  const effectIndexRef = useRef(0);
  const menuOpenRef = useRef(false);
  const isRecordingRef = useRef(false);
  const recordingFramesRef = useRef<Landmark[][]>([]);
  const recordingStartTimeRef = useRef(0);

  // Debug/Performance
  const fpsRef = useRef(0);
  const frameCountRef = useRef(0);
  const lastFpsTimeRef = useRef(performance.now());
  const smoothedLandmarksRef = useRef<Landmark[][]>([]);

  // ── State (minimal — only for UI layer) ───────────────────────────────────
  const [status, setStatus] = useState<AppStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [effectIndex, setEffectIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<"UI" | "Gesture">("UI");
  const [gestures, setGestures] = useState<CustomGesture[]>(() => {
    const saved = localStorage.getItem("customGestures");
    return saved ? JSON.parse(saved) : [];
  });
  const [isRecording, setIsRecording] = useState(false);
  const [recordingProgress, setRecordingProgress] = useState(0);
  const [debugState, setDebugState] = useState<EngineState>({
    landmarks: [],
    velocity: 0,
    currentGesture: null,
    confidence: 0,
    isMenuOpen: false,
    effectIndex: 0,
    fps: 0,
  });
  const [showDebug, setShowDebug] = useState(false);

  // Sync state to refs
  useEffect(() => {
    menuOpenRef.current = menuOpen;
  }, [menuOpen]);

  useEffect(() => {
    effectIndexRef.current = effectIndex;
  }, [effectIndex]);

  useEffect(() => {
    localStorage.setItem("customGestures", JSON.stringify(gestures));
  }, [gestures]);

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
      const msg = err instanceof Error ? err.message : "Camera access denied or unavailable.";
      setErrorMsg(msg);
      setStatus("error");
    }
  }, []);

  // ── MediaPipe init ────────────────────────────────────────────────────────
  const initMediaPipe = useCallback(async () => {
    try {
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);

      let landmarker: HandLandmarker;

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
      const msg = err instanceof Error ? err.message : "Failed to load AI model.";
      setErrorMsg(msg);
      setStatus("error");
    }
  }, []);

  // ── Action Execution ──────────────────────────────────────────────────────
  const executeAction = useCallback((action: GestureAction) => {
    switch (action) {
      case "toggleMenu":
        setMenuOpen((prev) => !prev);
        break;
      case "nextEffect":
        setEffectIndex((prev) => (prev + 1) % NUM_EFFECTS);
        break;
      case "previousEffect":
        setEffectIndex((prev) => (prev - 1 + NUM_EFFECTS) % NUM_EFFECTS);
        break;
      case "toggleTracking":
        setMode((prev) => (prev === "UI" ? "Gesture" : "UI"));
        break;
      case "resetEffects":
        setEffectIndex(0);
        break;
      default:
        break;
    }
  }, []);

  const drawOverlay = useCallback((canvas: HTMLCanvasElement, landmarks: Landmark[][]) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0, 255, 0, 0.3)";
    ctx.strokeStyle = "rgba(0, 255, 0, 0.8)";
    ctx.lineWidth = 2;

    for (const hand of landmarks) {
      for (let i = 0; i < hand.length; i++) {
        const x = hand[i].x * canvas.width;
        const y = hand[i].y * canvas.height;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Draw connections
      const connections = [
        [0, 1], [1, 2], [2, 3], [3, 4],
        [0, 5], [5, 6], [6, 7], [7, 8],
        [0, 9], [9, 10], [10, 11], [11, 12],
        [0, 13], [13, 14], [14, 15], [15, 16],
        [0, 17], [17, 18], [18, 19], [19, 20],
      ];

      for (const [start, end] of connections) {
        const x1 = hand[start].x * canvas.width;
        const y1 = hand[start].y * canvas.height;
        const x2 = hand[end].x * canvas.width;
        const y2 = hand[end].y * canvas.height;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }
  }, []);

  // ── Main detection loop (decoupled from render) ────────────────────────────
  const loop = useCallback(() => {
    if (!videoReadyRef.current || !modelReadyRef.current) {
      rafRef.current = requestAnimationFrame(loop);
      return;
    }

    const now = performance.now();
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas) {
      rafRef.current = requestAnimationFrame(loop);
      return;
    }

    // ── Detection interval (30 FPS) ────────────────────────────────────────
    if (now - lastDetectTimeRef.current >= DETECTION_INTERVAL_MS) {
      lastDetectTimeRef.current = now;

      try {
        const landmarker = landmarkerRef.current;
        if (!landmarker) {
          rafRef.current = requestAnimationFrame(loop);
          return;
        }

        const result = landmarker.detectForVideo(video, now);
        const landmarks: Landmark[][] = result.landmarks.map((hand) =>
          hand.map((lm) => ({ x: lm.x, y: lm.y, z: lm.z }))
        );

        // Smoothing
        if (smoothedLandmarksRef.current.length === 0) {
          smoothedLandmarksRef.current = landmarks;
        } else {
          smoothedLandmarksRef.current = landmarks.map((hand, i) =>
            smoothLandmarks(hand, smoothedLandmarksRef.current[i] || hand, LERP_FACTOR)
          );
        }

        const gestureManager = GestureManager.getInstance();

        // Recording logic
        if (isRecordingRef.current) {
          recordingFramesRef.current.push(smoothedLandmarksRef.current[0] || []);
          const elapsed = now - recordingStartTimeRef.current;
          const progress = Math.min(elapsed / 2000, 1); // 2 second recording
          setRecordingProgress(progress);

          if (progress >= 1) {
            isRecordingRef.current = false;
            setIsRecording(false);
            toast.success("Gesture recorded! Configure it in the panel.");
          }
        }

        // Gesture detection (only if not recording and in gesture mode)
        if (!isRecordingRef.current && mode === "Gesture") {
          if (smoothedLandmarksRef.current.length > 0) {
            const result = gestureManager.process(
              smoothedLandmarksRef.current[0],
              gestures,
              menuOpenRef.current
            );

            // Update debug state
            setDebugState((prev) => ({
              ...prev,
              landmarks: smoothedLandmarksRef.current,
              velocity: gestureManager.getVelocity(),
              currentGesture: result.id,
              confidence: result.confidence,
              isMenuOpen: menuOpenRef.current,
              effectIndex: effectIndexRef.current,
            }));

            // Execute confirmed actions
            if (result.isConfirmed && result.id) {
              const gesture = gestures.find((g) => g.id === result.id);
              if (gesture) {
                executeAction(gesture.action);
              }
            }
          }

          // Clap detection (two hands)
          if (smoothedLandmarksRef.current.length === 2 && !menuOpenRef.current) {
            const distance = calculateClapDistance(
              smoothedLandmarksRef.current[0],
              smoothedLandmarksRef.current[1]
            );

            if (distance < CLAP_THRESHOLD && now - lastClapTimeRef.current > CLAP_COOLDOWN_MS) {
              lastClapTimeRef.current = now;
              const nextEffect = (effectIndexRef.current + 1) % NUM_EFFECTS;
              effectIndexRef.current = nextEffect;
              setEffectIndex(nextEffect);
              boxRef.current = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
              smoothedBoxRef.current = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
            }
          }

          // Box calculation (two hands)
          if (smoothedLandmarksRef.current.length === 2 && !menuOpenRef.current) {
            const newBox = calculateBoxFromTwoHands(
              smoothedLandmarksRef.current[0],
              smoothedLandmarksRef.current[1]
            );
            boxRef.current = newBox;
            smoothedBoxRef.current = lerpBox(smoothedBoxRef.current, newBox, LERP_FACTOR);
          } else {
            boxRef.current = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
            smoothedBoxRef.current = lerpBox(smoothedBoxRef.current, boxRef.current, LERP_FACTOR);
          }
        }

        // Draw overlay
        drawOverlay(canvas, smoothedLandmarksRef.current);
      } catch (err) {
        console.error("Detection error:", err);
      }
    }

    // ── FPS calculation ────────────────────────────────────────────────────
    frameCountRef.current++;
    const timeSinceLastFps = now - lastFpsTimeRef.current;
    if (timeSinceLastFps >= 1000) {
      fpsRef.current = frameCountRef.current;
      frameCountRef.current = 0;
      lastFpsTimeRef.current = now;
      setDebugState((prev) => ({ ...prev, fps: fpsRef.current }));
    }

    rafRef.current = requestAnimationFrame(loop);
  }, [mode, gestures, executeAction, drawOverlay]);

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mode === "Gesture" || isRecording) {
      setStatus("loading-camera");
      initCamera();
    } else {
      const video = videoRef.current;
      if (video?.srcObject) {
        (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
        video.srcObject = null;
      }
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      setStatus("idle");
    }

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      const video = videoRef.current;
      if (video?.srcObject) {
        (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      }
    };
  }, [mode, isRecording, initCamera]);

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

  // ── Recording handler ───────────────────────────────────────────────────────
  const handleStartRecording = useCallback(() => {
    if (gestures.length >= 10) {
      toast.error("Maximum 10 gestures allowed");
      return;
    }
    setIsRecording(true);
    isRecordingRef.current = true;
    recordingFramesRef.current = [];
    recordingStartTimeRef.current = performance.now();
  }, [gestures.length]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-black">
      <Toaster position="top-center" theme="dark" />
      <video
        ref={videoRef}
        className="absolute"
        style={{ opacity: 0, pointerEvents: "none", width: 1, height: 1 }}
        playsInline
        muted
      />

      {/* UI Mode: Configuration Panel */}
      {mode === "UI" && !isRecording && (
        <div className="absolute inset-0 z-[60] overflow-auto bg-background">
          <GestureControlPanel
            isTrackingEnabled={false}
            onToggleTracking={() => setMode("Gesture")}
            gestures={gestures}
            onAddGesture={(g) => setGestures(prev => [...prev, { ...g, id: crypto.randomUUID() }])}
            onUpdateGesture={(id, updates) => setGestures(prev => prev.map(g => g.id === id ? { ...g, ...updates } : g))}
            onDeleteGesture={(id) => setGestures(prev => prev.filter(g => g.id !== id))}
            isRecording={false}
            onStartRecording={handleStartRecording}
            recordingProgress={0}
          />
        </div>
      )}

      {/* Recording Overlay */}
      {isRecording && (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="text-center space-y-4">
            <div className="text-4xl font-bold text-white mb-8">Recording Gesture...</div>
            <div className="w-64 h-2 bg-white/20 rounded-full overflow-hidden mx-auto">
              <div 
                className="h-full bg-primary transition-all duration-100" 
                style={{ width: `${recordingProgress * 100}%` }}
              />
            </div>
            <p className="text-white/60 font-mono text-sm">Keep your hand steady in front of the camera</p>
          </div>
        </div>
      )}

      {/* WebGL shader canvas (fullscreen) */}
      {(mode === "Gesture" || isRecording) && status === "active" && (
        <EffectsCanvas
          videoRef={videoRef}
          boxRef={smoothedBoxRef}
          effectIndex={effectIndex}
        />
      )}

      {/* 2D landmark overlay */}
      {(mode === "Gesture" || isRecording) && (
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ zIndex: 10 }}
        />
      )}

      {/* Loading state */}
      {(status === "loading-camera" || status === "loading-model") && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black z-50">
          <div className="flex flex-col items-center gap-6">
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

      {/* ── Visible UI overlay ─────────────────────────────────────────────── */}
      {mode === "Gesture" && status === "active" && (
        <>
          <div className="absolute top-4 left-4 z-30">
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => setMode("UI")}
              className="bg-black/60 border-white/20 text-white hover:bg-white/10"
            >
              Back to Settings
            </Button>
          </div>

          <div className="absolute top-4 right-4 z-30 flex items-center gap-2">
            <div
              style={{
                background: "rgba(0,0,0,0.6)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: "6px",
                padding: "6px 10px",
                fontFamily: "monospace",
                fontSize: "11px",
                color: "rgba(255,255,255,0.6)",
                letterSpacing: "0.1em",
              }}
            >
              {["BURNING","GLOW","THERMAL","PIXEL","GLITCH","NEON"][effectIndex]}
            </div>

            <button
              onClick={() => setMenuOpen((v) => !v)}
              style={{
                background: menuOpen ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.6)",
                border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: "6px",
                padding: "6px 12px",
                fontFamily: "monospace",
                fontSize: "11px",
                color: "rgba(255,255,255,0.9)",
                letterSpacing: "0.1em",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                transition: "background 0.15s ease",
              }}
            >
              <span>EFFECTS</span>
              <span style={{ fontSize: "8px" }}>{menuOpen ? "▲" : "▼"}</span>
            </button>

            <button
              onClick={() => setShowDebug(!showDebug)}
              style={{
                background: showDebug ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.6)",
                border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: "6px",
                padding: "6px 12px",
                fontFamily: "monospace",
                fontSize: "11px",
                color: "rgba(255,255,255,0.9)",
                letterSpacing: "0.1em",
                cursor: "pointer",
              }}
            >
              DEBUG
            </button>
          </div>

          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
            <p
              style={{
                color: "rgba(255,255,255,0.2)",
                fontSize: "11px",
                fontFamily: "monospace",
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                textAlign: "center",
              }}
            >
              👏 Clap to cycle effect &nbsp;·&nbsp; ✌️ Peace to open menu &nbsp;·&nbsp; ✊ Fist to close
            </p>
          </div>
        </>
      )}

      {/* Debug HUD */}
      {mode === "Gesture" && status === "active" && showDebug && (
        <DebugHUD state={debugState} />
      )}

      {/* Gesture-controlled dropdown */}
      {mode === "Gesture" && status === "active" && (
        <GestureDropdown
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          effectIndex={effectIndex}
          onEffectChange={(idx: number) => {
            setEffectIndex(idx);
            effectIndexRef.current = idx;
            setMenuOpen(false);
          }}
        />
      )}
    </div>
  );
}
