import { Landmark, Box, GestureResult, EngineState, CustomGesture, GestureAction } from "./types";

export class GestureManager {
  private static instance: GestureManager;
  
  // Configuration
  private readonly LERP_FACTOR = 0.2;
  private readonly GESTURE_CONFIRM_MS = 500;
  private readonly GESTURE_COOLDOWN_MS = 1000;
  private readonly VELOCITY_THRESHOLD = 0.05;
  private readonly CONFIDENCE_THRESHOLD = 0.8;
  
  // State
  private lastLandmarks: Landmark[] | null = null;
  private velocity: number = 0;
  private currentGestureId: string | null = null;
  private gestureStartTime: number = 0;
  private lastActionTime: number = 0;
  private confirmedGestureId: string | null = null;
  private gestureBuffer: (string | null)[] = [];
  private readonly BUFFER_SIZE = 5;

  private constructor() {}

  public static getInstance(): GestureManager {
    if (!GestureManager.instance) {
      GestureManager.instance = new GestureManager();
    }
    return GestureManager.instance;
  }

  /**
   * Main Pipeline: Detection → Normalization → Smoothing → Velocity Filter → 
   * Gesture Candidates → Confidence Scoring → Stability Timer → 
   * Priority Resolver → Action Dispatcher
   */
  public process(
    landmarks: Landmark[], 
    customGestures: CustomGesture[],
    isMenuOpen: boolean
  ): GestureResult {
    const now = performance.now();

    // 1. Normalization
    const normalized = this.normalize(landmarks);

    // 2. Velocity Filtering
    this.velocity = this.calculateVelocity(normalized);
    if (this.velocity > this.VELOCITY_THRESHOLD) {
      this.resetGestureState();
      return { id: null, confidence: 0, isConfirmed: false };
    }

    // 3. Detection & Confidence Scoring
    const { id: detectedId, confidence } = this.detect(normalized, customGestures);

    // 4. Temporal Consistency (Smoothing)
    this.updateBuffer(detectedId);
    const stableId = this.getStableGesture();

    // 5. Stability Timer & Priority Resolver
    if (stableId && confidence > this.CONFIDENCE_THRESHOLD) {
      if (this.currentGestureId !== stableId) {
        this.currentGestureId = stableId;
        this.gestureStartTime = now;
      }

      const heldDuration = now - this.gestureStartTime;
      const isCooldownOver = now - this.lastActionTime > this.GESTURE_COOLDOWN_MS;

      if (heldDuration > this.GESTURE_CONFIRM_MS && isCooldownOver) {
        // Priority Resolver
        if (isMenuOpen && stableId !== "fist" && stableId !== "closeMenu") {
          return { id: stableId, confidence, isConfirmed: false };
        }

        this.lastActionTime = now;
        return { id: stableId, confidence, isConfirmed: true };
      }
    } else {
      this.resetGestureState();
    }

    return { id: stableId, confidence, isConfirmed: false };
  }

  private normalize(landmarks: Landmark[]): Landmark[] {
    const wrist = landmarks[0];
    const middleMCP = landmarks[9];
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
  }

  private calculateVelocity(landmarks: Landmark[]): number {
    if (!this.lastLandmarks) {
      this.lastLandmarks = landmarks;
      return 0;
    }

    let totalDist = 0;
    for (let i = 0; i < landmarks.length; i++) {
      const dx = landmarks[i].x - this.lastLandmarks[i].x;
      const dy = landmarks[i].y - this.lastLandmarks[i].y;
      totalDist += Math.sqrt(dx * dx + dy * dy);
    }

    this.lastLandmarks = landmarks;
    return totalDist / landmarks.length;
  }

  private detect(landmarks: Landmark[], customGestures: CustomGesture[]): { id: string | null, confidence: number } {
    let bestMatch: { id: string; confidence: number } | null = null;

    // Weighted Landmark Matching (Fingertips have higher weight)
    const weights = new Array(21).fill(1);
    [4, 8, 12, 16, 20].forEach(idx => weights[idx] = 2); // Fingertips

    for (const gesture of customGestures) {
      let weightedDist = 0;
      let totalWeight = 0;

      for (let i = 0; i < 21; i++) {
        const dx = landmarks[i].x - gesture.landmarks[i][0];
        const dy = landmarks[i].y - gesture.landmarks[i][1];
        const dz = landmarks[i].z - gesture.landmarks[i][2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        
        weightedDist += dist * weights[i];
        totalWeight += weights[i];
      }

      const avgDist = weightedDist / totalWeight;
      const confidence = Math.max(0, 1 - (avgDist / 0.2)); // 0.2 is max expected distance

      if (confidence > 0.7) {
        if (!bestMatch || confidence > bestMatch.confidence) {
          bestMatch = { id: gesture.id, confidence };
        }
      }
    }

    if (bestMatch) return bestMatch;

    // Built-in gestures (simplified for now)
    const indexUp = landmarks[8].y < landmarks[6].y;
    const middleUp = landmarks[12].y < landmarks[10].y;
    const ringUp = landmarks[16].y < landmarks[14].y;
    const pinkyUp = landmarks[20].y < landmarks[18].y;

    if (indexUp && middleUp && !ringUp && !pinkyUp) return { id: "peace", confidence: 0.9 };
    if (!indexUp && !middleUp && !ringUp && !pinkyUp) return { id: "fist", confidence: 0.9 };

    return { id: null, confidence: 0 };
  }

  private updateBuffer(id: string | null) {
    this.gestureBuffer.push(id);
    if (this.gestureBuffer.length > this.BUFFER_SIZE) {
      this.gestureBuffer.shift();
    }
  }

  private getStableGesture(): string | null {
    if (this.gestureBuffer.length < this.BUFFER_SIZE) return null;
    const first = this.gestureBuffer[0];
    return this.gestureBuffer.every(id => id === first) ? first : null;
  }

  private resetGestureState() {
    this.currentGestureId = null;
    this.gestureStartTime = 0;
  }

  public getVelocity(): number { return this.velocity; }
}
