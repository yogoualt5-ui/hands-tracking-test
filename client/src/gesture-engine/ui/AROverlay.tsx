import React, { useEffect, useRef, useState } from "react";
import { Landmark } from "../types";

interface AROverlayProps {
  landmarks: Landmark[][];
  canvasWidth: number;
  canvasHeight: number;
  isVisible: boolean;
}

export const AROverlay: React.FC<AROverlayProps> = ({ landmarks, canvasWidth, canvasHeight, isVisible }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [smoothPosition, setSmoothPosition] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !isVisible || landmarks.length === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw AR UI anchored to hand landmark 9 (middle MCP)
    const hand = landmarks[0];
    if (!hand || !hand[9]) return;

    const anchorX = hand[9].x * canvas.width;
    const anchorY = hand[9].y * canvas.height;

    // Smooth movement with lerp
    setSmoothPosition((prev) => ({
      x: prev.x + (anchorX - prev.x) * 0.2,
      y: prev.y + (anchorY - prev.y) * 0.2,
    }));

    // Draw AR UI elements
    drawARUI(ctx, smoothPosition.x, smoothPosition.y);
  }, [landmarks, canvasWidth, canvasHeight, isVisible]);

  const drawARUI = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
    // Draw circular menu
    const radius = 40;
    ctx.fillStyle = "rgba(0, 255, 200, 0.1)";
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();

    // Draw border
    ctx.strokeStyle = "rgba(0, 255, 200, 0.6)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Draw center dot
    ctx.fillStyle = "rgba(0, 255, 200, 0.8)";
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();

    // Draw dwell indicator (if needed)
    ctx.strokeStyle = "rgba(255, 100, 100, 0.4)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.arc(x, y, radius + 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  return (
    <canvas
      ref={canvasRef}
      width={canvasWidth}
      height={canvasHeight}
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ zIndex: 20 }}
    />
  );
};
