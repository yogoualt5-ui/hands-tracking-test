// Core
export { GestureManager } from "./GestureManager";
export type { EngineState, GestureResult, CustomGesture, GestureAction, Landmark, Box } from "./types";

// Processing
export { lerpLandmark, lerpBox, smoothLandmarks, isValidBox, clampBox } from "./processing/smoothing";
export { calculateBoxFromTwoHands, calculateClapDistance } from "./processing/boxCalculation";

// Gestures
export { KNNMatcher } from "./gestures/KNNMatcher";
export { PresetManager } from "./gestures/PresetManager";
export type { GesturePreset } from "./gestures/PresetManager";

// UI
export { AROverlay } from "./ui/AROverlay";

// Debug
export { DebugHUD } from "./debug/DebugHUD";
