import React, { useState, useEffect } from "react";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { Trash2, Camera, Save, Play, Square } from "lucide-react";

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

interface GestureControlPanelProps {
  isTrackingEnabled: boolean;
  onToggleTracking: (enabled: boolean) => void;
  gestures: CustomGesture[];
  onAddGesture: (gesture: Omit<CustomGesture, "id">) => void;
  onUpdateGesture: (id: string, updates: Partial<CustomGesture>) => void;
  onDeleteGesture: (id: string) => void;
  isRecording: boolean;
  onStartRecording: () => void;
  recordingProgress: number;
}

const ACTION_LABELS: Record<GestureAction, string> = {
  toggleMenu: "Toggle Menu",
  switchEffect: "Switch Effect",
  nextEffect: "Next Effect",
  previousEffect: "Previous Effect",
  toggleTracking: "Toggle Tracking",
  resetEffects: "Reset Effects",
};

export default function GestureControlPanel({
  isTrackingEnabled,
  onToggleTracking,
  gestures,
  onAddGesture,
  onUpdateGesture,
  onDeleteGesture,
  isRecording,
  onStartRecording,
  recordingProgress,
}: GestureControlPanelProps) {
  return (
    <div className="flex flex-col gap-6 p-6 max-w-2xl mx-auto bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 min-h-screen">
      <Card className="border-primary/20 shadow-lg">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-2xl font-bold tracking-tight">Gesture Control System</CardTitle>
              <CardDescription>Configure and train custom hand gestures</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="tracking-mode" className="text-sm font-medium">
                {isTrackingEnabled ? "GESTURE MODE" : "UI MODE"}
              </Label>
              <Switch
                id="tracking-mode"
                checked={isTrackingEnabled}
                onCheckedChange={onToggleTracking}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Custom Gestures</h3>
              <Button 
                onClick={onStartRecording} 
                disabled={isRecording || isTrackingEnabled}
                variant={isRecording ? "destructive" : "default"}
                className="gap-2"
              >
                {isRecording ? (
                  <>
                    <Square className="w-4 h-4" />
                    Recording ({Math.round(recordingProgress * 100)}%)
                  </>
                ) : (
                  <>
                    <Camera className="w-4 h-4" />
                    Record New Gesture
                  </>
                )}
              </Button>
            </div>

            {gestures.length === 0 ? (
              <div className="text-center py-12 border-2 border-dashed rounded-lg border-muted">
                <p className="text-muted-foreground">No custom gestures recorded yet.</p>
                <p className="text-sm text-muted-foreground/60">Click the button above to start training.</p>
              </div>
            ) : (
              <div className="grid gap-4">
                {gestures.map((gesture) => (
                  <Card key={gesture.id} className="bg-muted/30">
                    <CardContent className="p-4 flex items-center gap-4">
                      <div className="flex-1 space-y-2">
                        <Input
                          value={gesture.name}
                          onChange={(e) => onUpdateGesture(gesture.id, { name: e.target.value })}
                          className="font-medium bg-transparent border-none p-0 h-auto focus-visible:ring-0 text-base"
                          placeholder="Gesture Name"
                        />
                        <Select
                          value={gesture.action}
                          onValueChange={(value) => onUpdateGesture(gesture.id, { action: value as GestureAction })}
                        >
                          <SelectTrigger className="w-[200px] h-8 text-xs">
                            <SelectValue placeholder="Select action" />
                          </SelectTrigger>
                          <SelectContent>
                            {Object.entries(ACTION_LABELS).map(([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onDeleteGesture(gesture.id)}
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>

          <div className="pt-4 border-t text-xs text-muted-foreground space-y-2">
            <p className="font-medium text-foreground/70">Performance & Usage:</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>Max 10 custom gestures allowed.</li>
              <li>Gestures are stored locally in your browser.</li>
              <li>Ensure good lighting when recording and using gestures.</li>
              <li>Gesture Mode hides this UI and enables hand control.</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
