/**
 * EffectsCanvas.tsx — Fullscreen WebGL shader renderer
 *
 * Design: Invisible infrastructure. Renders a fullscreen quad with a custom
 * GLSL shader that processes the live webcam feed.
 *
 * CRITICAL SHADER RULES:
 * - NEVER sample texture inside an if-branch (causes undefined behavior on some GPUs)
 * - Sample ALL textures first, then branch on uEffect
 * - All outputs must be clamped to [0,1]
 * - Noise functions must be deterministic
 *
 * Effects (0–5):
 *  0 — Passthrough (mirrored webcam)
 *  1 — Chromatic aberration in box region
 *  2 — Pixelation / mosaic in box region
 *  3 — Edge detection (Sobel) in box region
 *  4 — Hue rotation in box region
 *  5 — Glitch / scanline in box region
 */

import { useEffect, useRef, MutableRefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

// ─── Shader source ────────────────────────────────────────────────────────────

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uTexture;
  uniform float     uTime;
  uniform vec4      uBox;       // cx, cy, w, h  (normalized 0-1)
  uniform int       uEffect;
  uniform vec2      uResolution;

  varying vec2 vUv;

  // ── Deterministic noise ──────────────────────────────────────────────────
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  // ── Hue rotation ─────────────────────────────────────────────────────────
  vec3 hueRotate(vec3 col, float angle) {
    float cosA = cos(angle);
    float sinA = sin(angle);
    vec3 k = vec3(0.57735);
    return col * cosA + cross(k, col) * sinA + k * dot(k, col) * (1.0 - cosA);
  }

  // ── Sobel edge detection ──────────────────────────────────────────────────
  float sobel(sampler2D tex, vec2 uv, vec2 texelSize) {
    float tl = dot(texture2D(tex, uv + vec2(-1.0, -1.0) * texelSize).rgb, vec3(0.299, 0.587, 0.114));
    float tc = dot(texture2D(tex, uv + vec2( 0.0, -1.0) * texelSize).rgb, vec3(0.299, 0.587, 0.114));
    float tr = dot(texture2D(tex, uv + vec2( 1.0, -1.0) * texelSize).rgb, vec3(0.299, 0.587, 0.114));
    float ml = dot(texture2D(tex, uv + vec2(-1.0,  0.0) * texelSize).rgb, vec3(0.299, 0.587, 0.114));
    float mr = dot(texture2D(tex, uv + vec2( 1.0,  0.0) * texelSize).rgb, vec3(0.299, 0.587, 0.114));
    float bl = dot(texture2D(tex, uv + vec2(-1.0,  1.0) * texelSize).rgb, vec3(0.299, 0.587, 0.114));
    float bc = dot(texture2D(tex, uv + vec2( 0.0,  1.0) * texelSize).rgb, vec3(0.299, 0.587, 0.114));
    float br = dot(texture2D(tex, uv + vec2( 1.0,  1.0) * texelSize).rgb, vec3(0.299, 0.587, 0.114));
    float gx = -tl - 2.0*ml - bl + tr + 2.0*mr + br;
    float gy = -tl - 2.0*tc - tr + bl + 2.0*bc + br;
    return clamp(sqrt(gx*gx + gy*gy), 0.0, 1.0);
  }

  void main() {
    // ── 1. Flip UV horizontally (mirror effect) ──────────────────────────
    vec2 uv = vec2(1.0 - vUv.x, vUv.y);

    // ── 2. Sample base color FIRST (before any branching) ───────────────
    vec4 baseColor = texture2D(uTexture, uv);

    // ── 3. Check if box is valid ─────────────────────────────────────────
    float boxW = uBox.z;
    float boxH = uBox.w;
    bool validBox = (boxW > 0.01 && boxH > 0.01);

    if (!validBox) {
      gl_FragColor = clamp(baseColor, 0.0, 1.0);
      return;
    }

    // ── 4. Compute box bounds ─────────────────────────────────────────────
    float cx = uBox.x;
    float cy = uBox.y;
    float halfW = boxW * 0.5;
    float halfH = boxH * 0.5;

    float xMin = cx - halfW;
    float xMax = cx + halfW;
    float yMin = cy - halfH;
    float yMax = cy + halfH;

    // ── 5. Check if pixel is inside box ──────────────────────────────────
    bool inBox = (uv.x >= xMin && uv.x <= xMax && uv.y >= yMin && uv.y <= yMax);

    // ── 6. Border detection ───────────────────────────────────────────────
    float borderThickness = 0.005;
    bool onBorder = inBox && (
      uv.x <= xMin + borderThickness ||
      uv.x >= xMax - borderThickness ||
      uv.y <= yMin + borderThickness ||
      uv.y >= yMax - borderThickness
    );

    if (onBorder) {
      gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
      return;
    }

    if (!inBox) {
      gl_FragColor = clamp(baseColor, 0.0, 1.0);
      return;
    }

    // ── 7. Pre-sample textures for all effects (GPU rule: no tex in if) ──
    vec2 texelSize = 1.0 / uResolution;

    // Chromatic aberration samples
    float aberration = 0.012;
    vec4 chromaR = texture2D(uTexture, vec2(1.0 - (uv.x + aberration), uv.y));
    vec4 chromaG = texture2D(uTexture, uv);
    vec4 chromaB = texture2D(uTexture, vec2(1.0 - (uv.x - aberration), uv.y));

    // Pixelation sample
    float pixelSize = 0.025;
    vec2 pixUv = floor(uv / pixelSize) * pixelSize + pixelSize * 0.5;
    pixUv.x = 1.0 - pixUv.x;
    vec4 pixelColor = texture2D(uTexture, vec2(1.0 - pixUv.x, pixUv.y));

    // Sobel edge detection
    float edge = sobel(uTexture, uv, texelSize * 2.0);

    // Hue rotation
    vec3 hueColor = hueRotate(baseColor.rgb, uTime * 1.5);

    // Glitch / scanline
    float scanline = step(0.5, fract(uv.y * uResolution.y * 0.25));
    float glitchNoise = noise(vec2(floor(uv.y * 40.0), floor(uTime * 8.0)));
    float glitchShift = (glitchNoise - 0.5) * 0.04;
    vec2 glitchUv = vec2(1.0 - (uv.x + glitchShift), uv.y);
    glitchUv = clamp(glitchUv, 0.0, 1.0);
    vec4 glitchColor = texture2D(uTexture, glitchUv);

    // ── 8. Apply effect based on uEffect ─────────────────────────────────
    vec4 result = baseColor;

    if (uEffect == 0) {
      // Passthrough
      result = baseColor;
    } else if (uEffect == 1) {
      // Chromatic aberration
      result = vec4(chromaR.r, chromaG.g, chromaB.b, 1.0);
    } else if (uEffect == 2) {
      // Pixelation
      result = pixelColor;
    } else if (uEffect == 3) {
      // Edge detection (Sobel) — white edges on dark background
      result = vec4(vec3(edge), 1.0);
    } else if (uEffect == 4) {
      // Hue rotation
      result = vec4(hueColor, 1.0);
    } else if (uEffect == 5) {
      // Glitch + scanline
      vec3 glitched = glitchColor.rgb * (0.85 + scanline * 0.15);
      result = vec4(clamp(glitched, 0.0, 1.0), 1.0);
    }

    gl_FragColor = clamp(result, 0.0, 1.0);
  }
`;

// ─── Inner scene component ────────────────────────────────────────────────────

interface SceneProps {
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  smoothedBoxRef: MutableRefObject<{ cx: number; cy: number; w: number; h: number }>;
  effectIndex: number;
}

function Scene({ videoRef, smoothedBoxRef, effectIndex }: SceneProps) {
  const { size } = useThree();
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const videoTextureRef = useRef<THREE.VideoTexture | null>(null);

  // Create video texture once
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const texture = new THREE.VideoTexture(video);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.format = THREE.RGBAFormat;
    videoTextureRef.current = texture;

    return () => {
      texture.dispose();
      videoTextureRef.current = null;
    };
  }, [videoRef]);

  // Update per-frame uniforms
  useFrame(({ clock }) => {
    const mat = materialRef.current;
    const tex = videoTextureRef.current;
    if (!mat || !tex) return;

    // Update video texture every frame
    tex.needsUpdate = true;

    const box = smoothedBoxRef.current;
    mat.uniforms.uTime.value = clock.getElapsedTime();
    mat.uniforms.uBox.value.set(box.cx, box.cy, box.w, box.h);
    mat.uniforms.uResolution.value.set(size.width, size.height);
    mat.uniforms.uEffect.value = effectIndex;
    mat.uniforms.uTexture.value = tex;
  });

  const uniforms = useRef({
    uTexture: { value: null as THREE.VideoTexture | null },
    uTime: { value: 0 },
    uBox: { value: new THREE.Vector4(0.5, 0.5, 0, 0) },
    uEffect: { value: 0 },
    uResolution: { value: new THREE.Vector2(size.width, size.height) },
  });

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={materialRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms.current}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

interface EffectsCanvasProps {
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  smoothedBoxRef: MutableRefObject<{ cx: number; cy: number; w: number; h: number }>;
  effectIndex: number;
}

export default function EffectsCanvas({
  videoRef,
  smoothedBoxRef,
  effectIndex,
}: EffectsCanvasProps) {
  return (
    <div className="absolute inset-0 w-full h-full" style={{ zIndex: 1 }}>
      <Canvas
        orthographic
        camera={{ zoom: 1, position: [0, 0, 1], near: 0.1, far: 10 }}
        gl={{
          antialias: false,
          alpha: false,
          powerPreference: "high-performance",
        }}
        style={{ width: "100%", height: "100%" }}
        frameloop="always"
      >
        <Scene
          videoRef={videoRef}
          smoothedBoxRef={smoothedBoxRef}
          effectIndex={effectIndex}
        />
      </Canvas>
    </div>
  );
}
