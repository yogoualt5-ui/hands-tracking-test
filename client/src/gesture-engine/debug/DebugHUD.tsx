import React from "react";
import { EngineState } from "../types";

interface DebugHUDProps {
  state: EngineState;
}

export const DebugHUD: React.FC<DebugHUDProps> = ({ state }) => {
  return (
    <div className="absolute top-4 left-4 z-[100] p-4 bg-black/80 border border-white/20 rounded-lg font-mono text-[10px] text-white/80 pointer-events-none">
      <div className="space-y-1">
        <div className="flex justify-between gap-4">
          <span>FPS:</span>
          <span className="text-green-400">{state.fps.toFixed(1)}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span>GESTURE:</span>
          <span className="text-cyan-400">{state.currentGesture || "NONE"}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span>CONFIDENCE:</span>
          <span className="text-yellow-400">{(state.confidence * 100).toFixed(1)}%</span>
        </div>
        <div className="flex justify-between gap-4">
          <span>VELOCITY:</span>
          <span className={state.velocity > 0.05 ? "text-red-400" : "text-green-400"}>
            {state.velocity.toFixed(4)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span>MENU:</span>
          <span className={state.isMenuOpen ? "text-green-400" : "text-white/40"}>
            {state.isMenuOpen ? "OPEN" : "CLOSED"}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span>EFFECT:</span>
          <span className="text-purple-400">{state.effectIndex}</span>
        </div>
      </div>
    </div>
  );
};
