import { Landmark, CustomGesture } from "../types";

export class KNNMatcher {
  private static readonly WEIGHTS = [
    1, 1, 1, 1, 2,  // Thumb
    1, 1, 1, 2,     // Index
    1, 1, 1, 2,     // Middle
    1, 1, 1, 2,     // Ring
    1, 1, 1, 2,     // Pinky
  ];

  /**
   * Calculate weighted Euclidean distance between two landmarks
   */
  static weightedDistance(a: Landmark[], b: number[][]): number {
    let totalDist = 0;
    let totalWeight = 0;

    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const dx = a[i].x - b[i][0];
      const dy = a[i].y - b[i][1];
      const dz = a[i].z - b[i][2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const weight = this.WEIGHTS[i] || 1;

      totalDist += dist * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? totalDist / totalWeight : Infinity;
  }

  /**
   * K-Nearest Neighbors matching
   * Returns top-k matches sorted by distance
   */
  static knnMatch(
    current: Landmark[],
    gestures: CustomGesture[],
    k: number = 3
  ): Array<{ gesture: CustomGesture; distance: number }> {
    const matches = gestures.map((gesture) => ({
      gesture,
      distance: this.weightedDistance(current, gesture.landmarks),
    }));

    // Sort by distance (ascending)
    matches.sort((a, b) => a.distance - b.distance);

    // Return top-k
    return matches.slice(0, k);
  }

  /**
   * Cosine similarity between two normalized landmarks
   * Higher value = more similar (range: -1 to 1)
   */
  static cosineSimilarity(a: Landmark[], b: number[][]): number {
    let dotProduct = 0;
    let magA = 0;
    let magB = 0;

    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const ax = a[i].x;
      const ay = a[i].y;
      const az = a[i].z;
      const bx = b[i][0];
      const by = b[i][1];
      const bz = b[i][2];

      dotProduct += ax * bx + ay * by + az * bz;
      magA += ax * ax + ay * ay + az * az;
      magB += bx * bx + by * by + bz * bz;
    }

    const denominator = Math.sqrt(magA) * Math.sqrt(magB);
    return denominator > 0 ? dotProduct / denominator : 0;
  }

  /**
   * Voting-based confidence from KNN results
   * Returns confidence score 0-1
   */
  static confidenceFromKNN(
    matches: Array<{ gesture: CustomGesture; distance: number }>,
    maxDistance: number = 0.2
  ): number {
    if (matches.length === 0) return 0;

    // Normalize distances to confidence (inverse)
    const confidences = matches.map((m) => Math.max(0, 1 - m.distance / maxDistance));

    // Average confidence weighted by rank (first match has highest weight)
    let weightedSum = 0;
    let weightSum = 0;
    for (let i = 0; i < confidences.length; i++) {
      const weight = 1 / (i + 1); // Inverse rank weight
      weightedSum += confidences[i] * weight;
      weightSum += weight;
    }

    return weightSum > 0 ? Math.min(1, weightedSum / weightSum) : 0;
  }
}
