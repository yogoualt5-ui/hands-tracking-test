import { Box, Landmark } from "../types";
import { clampBox, isValidBox } from "./smoothing";

export function calculateBoxFromTwoHands(hand1: Landmark[], hand2: Landmark[]): Box {
  const lm1 = hand1[9]; // Middle MCP
  const lm2 = hand2[9];

  if (!lm1 || !lm2) {
    return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  }

  const dx = lm2.x - lm1.x;
  const dy = lm2.y - lm1.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  const cx = (lm1.x + lm2.x) / 2;
  const cy = (lm1.y + lm2.y) / 2;
  const w = Math.min(1, distance * 1.2);
  const h = w * 0.8;

  if (isNaN(cx) || isNaN(cy) || isNaN(w) || isNaN(h) || w < 0.01) {
    return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  }

  const halfW = w / 2;
  const halfH = h / 2;

  const box: Box = {
    xMin: cx - halfW,
    yMin: cy - halfH,
    xMax: cx + halfW,
    yMax: cy + halfH,
  };

  return clampBox(box);
}

export function calculateClapDistance(hand1: Landmark[], hand2: Landmark[]): number {
  const lm1 = hand1[9];
  const lm2 = hand2[9];

  if (!lm1 || !lm2) return Infinity;

  const dx = lm2.x - lm1.x;
  const dy = lm2.y - lm1.y;
  return Math.sqrt(dx * dx + dy * dy);
}
