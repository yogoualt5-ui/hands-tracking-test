import { Box, Landmark } from "../types";

export function lerpLandmark(a: Landmark, b: Landmark, t: number): Landmark {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

export function lerpBox(a: Box, b: Box, t: number): Box {
  return {
    xMin: a.xMin + (b.xMin - a.xMin) * t,
    yMin: a.yMin + (b.yMin - a.yMin) * t,
    xMax: a.xMax + (b.xMax - a.xMax) * t,
    yMax: a.yMax + (b.yMax - a.yMax) * t,
  };
}

export function smoothLandmarks(landmarks: Landmark[], previous: Landmark[], factor: number = 0.2): Landmark[] {
  return landmarks.map((lm, i) => lerpLandmark(previous[i] || lm, lm, factor));
}

export function isValidBox(box: Box): boolean {
  return (
    box.xMax - box.xMin > 0.01 &&
    box.yMax - box.yMin > 0.01 &&
    !isNaN(box.xMin) &&
    !isNaN(box.yMin) &&
    !isNaN(box.xMax) &&
    !isNaN(box.yMax)
  );
}

export function clampBox(box: Box): Box {
  return {
    xMin: Math.max(0, Math.min(1, box.xMin)),
    yMin: Math.max(0, Math.min(1, box.yMin)),
    xMax: Math.max(0, Math.min(1, box.xMax)),
    yMax: Math.max(0, Math.min(1, box.yMax)),
  };
}
