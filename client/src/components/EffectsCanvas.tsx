/**
 * EffectsCanvas.tsx — Fullscreen WebGL shader renderer
 *
 * FIXES:
 * 1. Canvas uses flat={true} → disables ACESFilmic tone mapping (was darkening video to black)
 * 2. VideoTexture.colorSpace = SRGBColorSpace → matches renderer outputColorSpace
 * 3. Box format changed to [xMin, yMin, xMax, yMax] matching spec
 * 4. All 6 effects rewritten exactly per spec
 *
 * CRITICAL SHADER RULES:
 * - NEVER sample texture inside if-branch
 * - Pre-sample ALL textures first, then branch on uEffect
 * - All outputs clamped to [0,1]
 *
 * Box uniform: uBox = vec4(xMin, yMin, xMax, yMax) in normalized UV space
 *
 * Effects (uEffect float):
 *  < 0.5 — Burning (fire gradient via simplex noise displacement)
 *  < 1.5 — Glow (stark silhouette + cyan halo)
 *  < 2.5 — Thermal Vision (bold color ramp)
 *  < 3.5 — Pixelated (dot matrix / green phosphor)
 *  < 4.5 — Glitch (chromatic aberration + scanlines)
 *  < 5.5 — Neon Edges (Sobel + cyan/green)
 */

import { useEffect, useRef, MutableRefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

// ─── Vertex shader ────────────────────────────────────────────────────────────

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// ─── Fragment shader ──────────────────────────────────────────────────────────

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uTexture;
  uniform float     uTime;
  uniform vec4      uBox;       // xMin, yMin, xMax, yMax (normalized 0-1)
  uniform float     uEffect;
  uniform vec2      uResolution;

  varying vec2 vUv;

  // ─── Simplex 2D noise ─────────────────────────────────────────────────────
  vec3 mod289(vec3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
  vec2 mod289v(vec2 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289((x * 34.0 + 1.0) * x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                       -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289v(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  // ─── Hash noise ───────────────────────────────────────────────────────────
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  // ─── Luminance ────────────────────────────────────────────────────────────
  float luma(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
  }

  // ─── Sobel edge detection ─────────────────────────────────────────────────
  float sobel(vec2 uv, vec2 texelSize) {
    float tl = luma(texture2D(uTexture, uv + vec2(-1.0, -1.0) * texelSize).rgb);
    float tc = luma(texture2D(uTexture, uv + vec2( 0.0, -1.0) * texelSize).rgb);
    float tr = luma(texture2D(uTexture, uv + vec2( 1.0, -1.0) * texelSize).rgb);
    float ml = luma(texture2D(uTexture, uv + vec2(-1.0,  0.0) * texelSize).rgb);
    float mr = luma(texture2D(uTexture, uv + vec2( 1.0,  0.0) * texelSize).rgb);
    float bl = luma(texture2D(uTexture, uv + vec2(-1.0,  1.0) * texelSize).rgb);
    float bc = luma(texture2D(uTexture, uv + vec2( 0.0,  1.0) * texelSize).rgb);
    float br = luma(texture2D(uTexture, uv + vec2( 1.0,  1.0) * texelSize).rgb);
    float gx = -tl - 2.0*ml - bl + tr + 2.0*mr + br;
    float gy = -tl - 2.0*tc - tr + bl + 2.0*bc + br;
    return clamp(sqrt(gx*gx + gy*gy), 0.0, 1.0);
  }

  // ─── Fire gradient ────────────────────────────────────────────────────────
  vec3 fireGradient(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 c0 = vec3(0.1, 0.0, 0.0);
    vec3 c1 = vec3(1.0, 0.0, 0.0);
    vec3 c2 = vec3(1.0, 0.5, 0.0);
    vec3 c3 = vec3(1.0, 1.0, 0.0);
    if (t < 0.333) return mix(c0, c1, t * 3.0);
    if (t < 0.666) return mix(c1, c2, (t - 0.333) * 3.0);
    return mix(c2, c3, (t - 0.666) * 3.0);
  }

  // ─── Thermal gradient ─────────────────────────────────────────────────────
  vec3 thermalGradient(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 c0 = vec3(0.0, 0.0, 0.2);
    vec3 c1 = vec3(0.1, 0.0, 1.0);
    vec3 c2 = vec3(0.0, 1.0, 0.0);
    vec3 c3 = vec3(1.0, 0.9, 0.0);
    vec3 c4 = vec3(1.0, 0.0, 0.0);
    if (t < 0.25) return mix(c0, c1, t * 4.0);
    if (t < 0.50) return mix(c1, c2, (t - 0.25) * 4.0);
    if (t < 0.75) return mix(c2, c3, (t - 0.50) * 4.0);
    return mix(c3, c4, (t - 0.75) * 4.0);
  }

  void main() {
    // ── 1. Flip UV horizontally (mirror) ──────────────────────────────────
    vec2 uv = vec2(1.0 - vUv.x, vUv.y);

    // ── 2. Sample base color FIRST (before any branching) ─────────────────
    vec4 baseColor = texture2D(uTexture, uv);

    // ── 3. Check if box is valid ───────────────────────────────────────────
    float xMin = uBox.x;
    float yMin = uBox.y;
    float xMax = uBox.z;
    float yMax = uBox.w;
    bool validBox = (xMax - xMin > 0.01 && yMax - yMin > 0.01);

    if (!validBox) {
      gl_FragColor = baseColor;
      return;
    }

    // ── 4. Check if pixel is inside box ───────────────────────────────────
    bool inBox = (uv.x >= xMin && uv.x <= xMax && uv.y >= yMin && uv.y <= yMax);

    if (!inBox) {
      gl_FragColor = baseColor;
      return;
    }

    // ── 5. Border detection ────────────────────────────────────────────────
    float borderThickness = 0.005;
    bool onBorder = (
      uv.x <= xMin + borderThickness ||
      uv.x >= xMax - borderThickness ||
      uv.y <= yMin + borderThickness ||
      uv.y >= yMax - borderThickness
    );

    if (onBorder) {
      gl_FragColor = vec4(1.0);
      return;
    }

    // ── 6. Pre-sample ALL textures (GPU rule: no tex inside if) ───────────
    vec2 texelSize = 1.0 / uResolution;

    // Effect 0 — Burning: displaced UV sample
    vec2 noiseOffset = vec2(snoise(uv * 4.0 + uTime * 0.8), snoise(uv * 4.0 + uTime * 0.8 + 100.0)) * 0.03;
    vec2 burnUv = clamp(uv + noiseOffset, 0.0, 1.0);
    vec4 burnSample = texture2D(uTexture, burnUv);

    // Effect 1 — Glow: same base sample (uses luminance)
    // (uses baseColor.rgb)

    // Effect 2 — Thermal: same base sample
    // (uses baseColor.rgb)

    // Effect 3 — Pixelated: downsampled grid sample
    float aspect = uResolution.x / uResolution.y;
    float gridCells = 80.0;
    vec2 pixCellSize = vec2(1.0 / gridCells, aspect / gridCells);
    vec2 pixCell = floor(uv / pixCellSize);
    vec2 pixUv = (pixCell + 0.5) * pixCellSize;
    pixUv = clamp(pixUv, 0.0, 1.0);
    vec4 pixSample = texture2D(uTexture, pixUv);

    // Effect 4 — Glitch: chromatic aberration samples
    float noiseShiftR = snoise(vec2(floor(uv.y * 40.0), floor(uTime * 8.0))) * 0.012;
    float noiseShiftB = snoise(vec2(floor(uv.y * 40.0) + 50.0, floor(uTime * 8.0))) * 0.012;
    vec2 glitchUvR = clamp(vec2(uv.x + noiseShiftR, uv.y), 0.0, 1.0);
    vec2 glitchUvB = clamp(vec2(uv.x + noiseShiftB, uv.y), 0.0, 1.0);
    float glitchR = texture2D(uTexture, glitchUvR).r;
    float glitchG = baseColor.g;
    float glitchB = texture2D(uTexture, glitchUvB).b;

    // Effect 5 — Neon Edges: Sobel
    float edge = sobel(uv, texelSize * 1.5);

    // ── 7. Apply effect ────────────────────────────────────────────────────
    vec4 result = baseColor;

    if (uEffect < 0.5) {
      // ── BURNING ──────────────────────────────────────────────────────────
      float lum = luma(burnSample.rgb);
      result = vec4(fireGradient(lum), 1.0);

    } else if (uEffect < 1.5) {
      // ── GLOW ─────────────────────────────────────────────────────────────
      float lum = luma(baseColor.rgb);
      lum = pow(lum, 1.2) * 1.5;
      float edgeNoise = snoise(uv * 200.0 + uTime * 0.5) * 0.15;
      float core = smoothstep(0.5 + edgeNoise, 0.7 + edgeNoise, lum);
      float halo = smoothstep(0.2 + edgeNoise, 0.6 + edgeNoise, lum);
      vec3 cyanHalo = vec3(0.4, 0.9, 1.0);
      vec3 col = mix(vec3(0.0), cyanHalo * halo, halo);
      col = mix(col, vec3(1.0), core);
      result = vec4(clamp(col, 0.0, 1.0), 1.0);

    } else if (uEffect < 2.5) {
      // ── THERMAL VISION ────────────────────────────────────────────────────
      float lum = luma(baseColor.rgb);
      float t = clamp((lum - 0.1) * 1.2, 0.0, 1.0);
      result = vec4(thermalGradient(t), 1.0);

    } else if (uEffect < 3.5) {
      // ── PIXELATED (dot matrix) ────────────────────────────────────────────
      float lum = luma(pixSample.rgb);
      vec2 cellFrac = fract(uv / pixCellSize);
      float dist = length(cellFrac - 0.5);
      vec3 dotColor = (dist < 0.35)
        ? vec3(0.0, (lum > 0.25) ? 1.0 : 0.0, 0.0)
        : vec3(0.0, 0.1, 0.0);
      result = vec4(dotColor, 1.0);

    } else if (uEffect < 4.5) {
      // ── GLITCH ────────────────────────────────────────────────────────────
      vec3 glitched = vec3(glitchR, glitchG, glitchB);
      // Scanlines
      glitched -= sin(uv.y * 800.0 + uTime * 10.0) * 0.05;
      result = vec4(clamp(glitched, 0.0, 1.0), 1.0);

    } else if (uEffect < 5.5) {
      // ── NEON EDGES ────────────────────────────────────────────────────────
      vec3 neonColor = vec3(0.1, 1.0, 0.8) * edge * 2.5;
      vec3 col = neonColor + baseColor.rgb * 0.3;
      result = vec4(clamp(col, 0.0, 1.0), 1.0);
    }

    gl_FragColor = result;
  }
`;

// ─── Inner scene component ────────────────────────────────────────────────────

interface BoxRef {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

interface SceneProps {
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  boxRef: MutableRefObject<BoxRef>;
  effectIndex: number;
}

function Scene({ videoRef, boxRef, effectIndex }: SceneProps) {
  const { size, gl } = useThree();
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const videoTextureRef = useRef<THREE.VideoTexture | null>(null);

  // Create video texture once — must set colorSpace to match renderer
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const texture = new THREE.VideoTexture(video);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.format = THREE.RGBAFormat;
    // CRITICAL: match the renderer's outputColorSpace to avoid color distortion
    texture.colorSpace = gl.outputColorSpace;
    videoTextureRef.current = texture;

    return () => {
      texture.dispose();
      videoTextureRef.current = null;
    };
  }, [videoRef, gl]);

  // Update per-frame uniforms
  useFrame(({ clock }) => {
    const mat = materialRef.current;
    const tex = videoTextureRef.current;
    if (!mat || !tex) return;

    // VideoTexture.update() is called automatically by THREE.WebGLRenderer
    // but we also set needsUpdate for safety
    tex.needsUpdate = true;

    const box = boxRef.current;
    mat.uniforms.uTime.value = clock.getElapsedTime();
    mat.uniforms.uBox.value.set(box.xMin, box.yMin, box.xMax, box.yMax);
    mat.uniforms.uResolution.value.set(size.width, size.height);
    mat.uniforms.uEffect.value = effectIndex;
    mat.uniforms.uTexture.value = tex;
  });

  const uniforms = useRef({
    uTexture: { value: null as THREE.VideoTexture | null },
    uTime: { value: 0 },
    uBox: { value: new THREE.Vector4(0, 0, 0, 0) },
    uEffect: { value: 0 },
    uResolution: { value: new THREE.Vector2(size.width, size.height) },
  });

  return (
    <mesh>
      {/* 2x2 plane fills NDC space exactly with the custom vertex shader */}
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
  boxRef: MutableRefObject<BoxRef>;
  effectIndex: number;
}

export default function EffectsCanvas({
  videoRef,
  boxRef,
  effectIndex,
}: EffectsCanvasProps) {
  return (
    <div className="absolute inset-0 w-full h-full" style={{ zIndex: 1 }}>
      <Canvas
        // flat=true → THREE.NoToneMapping (prevents ACESFilmic darkening video to black)
        flat
        // linear=false → outputColorSpace = SRGBColorSpace (correct for video)
        linear={false}
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
          boxRef={boxRef}
          effectIndex={effectIndex}
        />
      </Canvas>
    </div>
  );
}

// Export the BoxRef type for use in App.tsx
export type { BoxRef };
