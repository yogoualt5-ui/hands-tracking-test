export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export interface Box {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export type GestureAction = 
  | "toggleMenu"
  | "switchEffect"
  | "nextEffect"
  | "previousEffect"
  | "toggleTracking"
  | "resetEffects";

export interface CustomGesture {
  id: string;
  name: string;
  landmarks: number[][]; // 21 points, each [x, y, z]
  action: GestureAction;
}

export interface GestureResult {
  id: string | null;
  confidence: number;
  isConfirmed: boolean;
}

export interface EngineState {
  landmarks: Landmark[][];
  velocity: number;
  currentGesture: string | null;
  confidence: number;
  isMenuOpen: boolean;
  effectIndex: number;
  fps: number;
}
