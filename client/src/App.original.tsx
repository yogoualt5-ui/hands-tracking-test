/**
 * App.tsx — Root orchestrator for the Hand Tracking Shader App
 *
 * Design: Invisible UI when active. Loading/error states use minimal dark overlay.
 * All high-frequency data lives in refs to prevent React re-render loops.
 *
 * Box format: { xMin, yMin, xMax, yMax } — normalized 0-1 UV coords
 * Clap gesture: cycles effectIndex forward (effectIndex + 1) % 6
 * Peace sign: opens effect dropdown
 * Fist: closes effect dropdown
 */

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import EffectsCanvas, { type BoxRef } from "./components/EffectsCanvas";
import GestureDropdown from "./components/GestureDropdown";
import GestureControlPanel, { type CustomGesture, type GestureAction } from "./components/GestureControlPanel";
import { toast, Toaster } from "sonner";
import { Button } from "./components/ui/button";

// ─── Constants ────────────────────────────────────────────────────────────────

const LERP_FACTOR = 0.2;
const DETECTION_INTERVAL_MS = 1000 / 30; // ~30 FPS cap
const CLAP_THRESHOLD = 0.1;
const CLAP_COOLDOWN_MS = 1000;
const GESTURE_CONFIRM_MS = 500;
const GESTURE_COOLDOWN_MS = 500;
const NUM_EFFECTS = 6;

const MEDIAPIPE_WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

// ─── Types ────────────────────────────────────────────────────────────────────

type AppStatus = "loading-camera" | "loading-model" | "active" | "error" | "idle";

interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpBox(prev: BoxRef, next: BoxRef, t: number): BoxRef {
  return {
    xMin: lerp(prev.xMin, next.xMin, t),
    yMin: lerp(prev.yMin, next.yMin, t),
    xMax: lerp(prev.xMax, next.xMax, t),
    yMax: lerp(prev.yMax, next.yMax, t),
  };
}

const EMPTY_BOX: BoxRef = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };

// ─── Component ────────────────────────────────────────────────────────────────

export default function App() {
  // ── Refs ──────────────────────────────────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const rafRef = useRef<number>(0);
  const lastDetectTimeRef = useRef<number>(0);
  const lastClapTimeRef = useRef<number>(0);
  const boxRef = useRef<BoxRef>({ ...EMPTY_BOX });
  const smoothedBoxRef = useRef<BoxRef>({ ...EMPTY_BOX });
  const videoReadyRef = useRef(false);
  const modelReadyRef = useRef(false);

  // effectIndex as ref for RAF loop (avoids stale closure)
  const effectIndexRef = useRef(0);

  // Gesture state machine refs
  const currentGestureRef = useRef<string | null>(null);
  const gestureStartTimeRef = useRef<number>(0);
  const confirmedGestureRef = useRef<string | null>(null);
  const lastGestureActionTimeRef = useRef<number>(0);

  // Recording refs
  const isRecordingRef = useRef(false);
  const recordingFramesRef = useRef<NormalizedLandmark[][]>([]);
  const recordingStartTimeRef = useRef(0);

  // ── State (minimal — only for UI layer) ───────────────────────────────────
  const [status, setStatus] = useState<AppStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [effectIndex, setEffectIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpenRef = useRef(false);

  const [mode, setMode] = useState<"UI" | "Gesture">("UI");
  const [gestures, setGestures] = useState<CustomGesture[]>(() => {
    const saved = localStorage.getItem("customGestures");
    return saved ? JSON.parse(saved) : [];
  });
  const [isRecording, setIsRecording] = useState(false);
  const [recordingProgress, setRecordingProgress] = useState(0);

  // Sync gestures to localStorage
  useEffect(() => {
    localStorage.setItem("customGestures", JSON.stringify(gestures));
  }, [gestures]);

  // Keep menuOpenRef in sync with menuOpen state
  useEffect(() => {
    menuOpenRef.current = menuOpen;
  }, [menuOpen]);

  // Keep effectIndexRef in sync with effectIndex state
  useEffect(() => {
    effectIndexRef.current = effectIndex;
  }, [effectIndex]);

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

  // ── Gesture Normalization ───────────────────────────────────────────────
  const normalizeLandmarks = useCallback(
    (landmarks: Array<{ x: number; y: number; z: number }>): NormalizedLandmark[] => {
      const wrist = landmarks[0];
      const middleMCP = landmarks[9];

      // Hand size (distance wrist to middle MCP)
      const handSize = Math.sqrt(
        Math.pow(middleMCP.x - wrist.x, 2) +
        Math.pow(middleMCP.y - wrist.y, 2) +
        Math.pow(middleMCP.z - wrist.z, 2)
      );

      return landmarks.map((lm) => ({
        x: (lm.x - wrist.x) / handSize,
        y: (lm.y - wrist.y) / handSize,
        z: (lm.z - wrist.z) / handSize,
      }));
    },
    []
  );

  // ── Gesture Matching ──────────────────────────────────────────────────────
  const compareGestures = useCallback(
    (current: NormalizedLandmark[], saved: number[][]): number => {
      let totalDistance = 0;
      for (let i = 0; i < 21; i++) {
        const dx = current[i].x - saved[i][0];
        const dy = current[i].y - saved[i][1];
        const dz = current[i].z - saved[i][2];
        totalDistance += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      return totalDistance / 21; // Average distance per point
    },
    []
  );

  // ── Finger up detection (for built-in gestures) ───────────────────────────
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
      // 1. Check custom gestures first
      if (gestures.length > 0) {
        const normalized = normalizeLandmarks(landmarks);
        let bestMatch: { id: string; distance: number } | null = null;

        for (const gesture of gestures) {
          const distance = compareGestures(normalized, gesture.landmarks);
          if (distance < 0.15) { // Match threshold
            if (!bestMatch || distance < bestMatch.distance) {
              bestMatch = { id: gesture.id, distance };
            }
          }
        }

        if (bestMatch) return bestMatch.id;
      }

      // 2. Fallback to built-in gestures
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
    [gestures, normalizeLandmarks, compareGestures, isFingerUp]
  );

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
      case "switchEffect":
        setEffectIndex((prev) => (prev + 1) % NUM_EFFECTS);
        break;
      case "toggleTracking":
        setMode((prev) => (prev === "UI" ? "Gesture" : "UI"));
        break;
      case "resetEffects":
        setEffectIndex(0);
        break;
    }
  }, []);

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

      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      ctx.clearRect(0, 0, width, height);

      // Finger connection pairs
      const connections: [number, number][] = [
        [0, 1], [1, 2], [2, 3], [3, 4],
        [0, 5], [5, 6], [6, 7], [7, 8],
        [5, 9], [9, 10], [10, 11], [11, 12],
        [9, 13], [13, 14], [14, 15], [15, 16],
        [13, 17], [17, 18], [18, 19], [19, 20],
        [0, 17],
      ];

      for (const hand of landmarks) {
        // Draw connections
        ctx.strokeStyle = "rgba(255,255,255,0.6)";
        ctx.lineWidth = 2;
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
          ctx.fillStyle = "#ffffff";
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

    // ── Recording Logic ─────────────────────────────────────────────────────
    if (isRecordingRef.current) {
      if (landmarks.length > 1) {
        // Cancel recording if multiple hands detected
        isRecordingRef.current = false;
        setIsRecording(false);
        setRecordingProgress(0);
        recordingFramesRef.current = [];
        toast.error("Recording cancelled: Multiple hands detected");
        return;
      }

      const firstHand = landmarks[0];
      if (firstHand) {
        const normalized = normalizeLandmarks(firstHand);
        recordingFramesRef.current.push(normalized);
        
        const elapsed = now - recordingStartTimeRef.current;
        const progress = Math.min(1, elapsed / 1000);
        setRecordingProgress(progress);

        if (progress >= 1) {
          // Finish recording
          isRecordingRef.current = false;
          setIsRecording(false);
          setRecordingProgress(0);

          // Average frames
          const frames = recordingFramesRef.current;
          const avgLandmarks: number[][] = Array.from({ length: 21 }, () => [0, 0, 0]);
          
          for (const frame of frames) {
            for (let i = 0; i < 21; i++) {
              avgLandmarks[i][0] += frame[i].x / frames.length;
              avgLandmarks[i][1] += frame[i].y / frames.length;
              avgLandmarks[i][2] += frame[i].z / frames.length;
            }
          }

          // Check similarity with existing
          let tooSimilar = false;
          for (const g of gestures) {
            if (compareGestures(avgLandmarks.map(l => ({x:l[0], y:l[1], z:l[2]})), g.landmarks) < 0.05) {
              tooSimilar = true;
              break;
            }
          }

          if (tooSimilar) {
            toast.warning("Gesture too similar to an existing one");
          }

          const newGesture: CustomGesture = {
            id: crypto.randomUUID(),
            name: `Gesture ${gestures.length + 1}`,
            landmarks: avgLandmarks,
            action: "nextEffect",
          };

          setGestures(prev => [...prev.slice(-9), newGesture]);
          recordingFramesRef.current = [];
          toast.success("Gesture recorded successfully");
        }
      }
      return; // Don't run gesture matching while recording
    }

    // ── Gesture state machine (runs on first hand if available) ─────────────
    const firstHand = landmarks[0] ?? null;

    if (!firstHand) {
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
        now - lastGestureActionTimeRef.current >= 1000 // Cooldown from requirements
      ) {
        // Gesture confirmed — trigger action ONCE
        if (detected !== confirmedGestureRef.current) {
          confirmedGestureRef.current = detected;
          lastGestureActionTimeRef.current = now;

          // Check if it's a custom gesture
          const custom = gestures.find(g => g.id === detected);
          if (custom) {
            executeAction(custom.action);
          } else {
            // Built-in gestures
            if (detected === "peace" && !menuOpenRef.current) {
              setMenuOpen(true);
            } else if (detected === "fist" && menuOpenRef.current) {
              setMenuOpen(false);
            }
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
      boxRef.current = { ...EMPTY_BOX };
      smoothedBoxRef.current = lerpBox(smoothedBoxRef.current, EMPTY_BOX, LERP_FACTOR);
      return;
    }

    const [hand1, hand2] = landmarks;
    const lm1 = hand1[9];
    const lm2 = hand2[9];

    if (!lm1 || !lm2) return;

    const dx = lm2.x - lm1.x;
    const dy = lm2.y - lm1.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Clap detection — cycle to next effect
    if (
      distance < CLAP_THRESHOLD &&
      now - lastClapTimeRef.current > CLAP_COOLDOWN_MS
    ) {
      lastClapTimeRef.current = now;
      // Cycle effect index
      const nextEffect = (effectIndexRef.current + 1) % NUM_EFFECTS;
      effectIndexRef.current = nextEffect;
      setEffectIndex(nextEffect);
      // Hide box during clap
      boxRef.current = { ...EMPTY_BOX };
      smoothedBoxRef.current = { ...EMPTY_BOX };
      return;
    }

    // Compute box: center = midpoint, width = distance * 1.2, height = width * 0.8
    const cx = (lm1.x + lm2.x) / 2;
    const cy = (lm1.y + lm2.y) / 2;
    const w = Math.min(1, distance * 1.2);
    const h = w * 0.8;

    // Validate (no NaN, no too-small values)
    if (isNaN(cx) || isNaN(cy) || isNaN(w) || isNaN(h) || w < 0.01) return;

    const halfW = w / 2;
    const halfH = h / 2;

    const newBox: BoxRef = {
      xMin: Math.max(0, Math.min(1, cx - halfW)),
      yMin: Math.max(0, Math.min(1, cy - halfH)),
      xMax: Math.max(0, Math.min(1, cx + halfW)),
      yMax: Math.max(0, Math.min(1, cy + halfH)),
    };

    boxRef.current = newBox;
    smoothedBoxRef.current = lerpBox(smoothedBoxRef.current, newBox, LERP_FACTOR);
  }, [drawOverlay, detectGesture]);

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mode === "Gesture" || isRecording) {
      setStatus("loading-camera");
      initCamera();
    } else {
      // Release camera
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
      {/* Hidden video element — must be in DOM for VideoTexture to work */}
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

      {/* ── Visible UI overlay (always on top when active) ─────────────────── */}
      {mode === "Gesture" && status === "active" && (
        <>
          {/* Back to UI button */}
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

          {/* Effect selector button — always visible for debugging */}
          <div
            className="absolute top-4 right-4 z-30 flex items-center gap-2"
          >
            {/* Current effect badge */}
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

            {/* Dropdown toggle button */}
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
          </div>

          {/* Gesture hint */}
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
