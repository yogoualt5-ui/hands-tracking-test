import { CustomGesture } from "../types";

export interface GesturePreset {
  version: string;
  timestamp: number;
  gestures: CustomGesture[];
  metadata: {
    author?: string;
    description?: string;
    tags?: string[];
  };
}

export class PresetManager {
  private static readonly CURRENT_VERSION = "1.0.0";

  /**
   * Export gestures to JSON file
   */
  static exportToJSON(gestures: CustomGesture[], metadata?: GesturePreset["metadata"]): string {
    const preset: GesturePreset = {
      version: this.CURRENT_VERSION,
      timestamp: Date.now(),
      gestures,
      metadata: metadata || {},
    };

    return JSON.stringify(preset, null, 2);
  }

  /**
   * Import gestures from JSON string
   */
  static importFromJSON(jsonString: string): { gestures: CustomGesture[]; metadata: GesturePreset["metadata"] } {
    try {
      const preset: GesturePreset = JSON.parse(jsonString);

      // Version validation
      if (!preset.version || !preset.gestures || !Array.isArray(preset.gestures)) {
        throw new Error("Invalid preset format");
      }

      return {
        gestures: preset.gestures,
        metadata: preset.metadata || {},
      };
    } catch (err) {
      throw new Error(`Failed to import preset: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }

  /**
   * Download preset as file
   */
  static downloadPreset(gestures: CustomGesture[], filename: string = "gestures.json", metadata?: GesturePreset["metadata"]) {
    const json = this.exportToJSON(gestures, metadata);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /**
   * Load preset from file input
   */
  static async loadPresetFromFile(file: File): Promise<{ gestures: CustomGesture[]; metadata: GesturePreset["metadata"] }> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const json = e.target?.result as string;
          const result = this.importFromJSON(json);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsText(file);
    });
  }

  /**
   * Merge multiple presets (with conflict resolution)
   */
  static mergePresets(
    presets: GesturePreset[],
    conflictStrategy: "keep-first" | "keep-latest" | "keep-all" = "keep-all"
  ): CustomGesture[] {
    const gestures: CustomGesture[] = [];
    const seenIds = new Set<string>();

    for (const preset of presets) {
      for (const gesture of preset.gestures) {
        if (seenIds.has(gesture.id)) {
          if (conflictStrategy === "keep-all") {
            gesture.id = `${gesture.id}-${Date.now()}`;
            gestures.push(gesture);
          }
          // else: skip duplicate
        } else {
          gestures.push(gesture);
          seenIds.add(gesture.id);
        }
      }
    }

    return gestures;
  }
}
