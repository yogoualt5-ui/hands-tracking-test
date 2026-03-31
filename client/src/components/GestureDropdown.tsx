/**
 * GestureDropdown.tsx — Gesture-controlled effect selector overlay
 *
 * Design: Minimal dark glass panel, fixed center of screen, z-index above canvas.
 * Smooth fade + scale animation on open/close.
 * Standard HTML — NOT WebGL.
 *
 * Interaction:
 *  - Open: ✌️ Peace sign (held 500ms)
 *  - Close: ✊ Fist (held 500ms) or clicking an item
 */

interface GestureDropdownProps {
  open: boolean;
  onClose: () => void;
  effectIndex: number;
  onEffectChange: (idx: number) => void;
}

const EFFECTS = [
  { index: 0, name: "Passthrough", description: "Live mirrored webcam feed" },
  { index: 1, name: "Chromatic Aberration", description: "RGB channel split in box region" },
  { index: 2, name: "Pixelation", description: "Mosaic / pixel art effect" },
  { index: 3, name: "Edge Detection", description: "Sobel operator — glowing outlines" },
  { index: 4, name: "Hue Rotation", description: "Animated color cycling" },
  { index: 5, name: "Glitch", description: "Scanline distortion & noise" },
];

export default function GestureDropdown({
  open,
  onClose,
  effectIndex,
  onEffectChange,
}: GestureDropdownProps) {
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          zIndex: 30,
          background: "rgba(0,0,0,0.4)",
          opacity: open ? 1 : 0,
          transition: "opacity 0.25s ease",
          pointerEvents: open ? "auto" : "none",
        }}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="fixed left-1/2 top-1/2"
        style={{
          zIndex: 40,
          transform: `translate(-50%, -50%) scale(${open ? 1 : 0.92})`,
          opacity: open ? 1 : 0,
          transition: "opacity 0.25s ease, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)",
          pointerEvents: open ? "auto" : "none",
          width: "min(90vw, 380px)",
        }}
      >
        <div
          style={{
            background: "rgba(10, 10, 15, 0.92)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: "12px",
            backdropFilter: "blur(20px)",
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "16px 20px 12px",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <p
              style={{
                color: "rgba(255,255,255,0.9)",
                fontSize: "11px",
                fontFamily: "monospace",
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                margin: 0,
              }}
            >
              Select Effect
            </p>
            <p
              style={{
                color: "rgba(255,255,255,0.25)",
                fontSize: "10px",
                fontFamily: "monospace",
                marginTop: "4px",
                margin: "4px 0 0",
              }}
            >
              ✊ Fist to close
            </p>
          </div>

          {/* Effect list */}
          <div style={{ padding: "8px 0" }}>
            {EFFECTS.map((effect) => {
              const isActive = effect.index === effectIndex;
              return (
                <button
                  key={effect.index}
                  onClick={() => onEffectChange(effect.index)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    width: "100%",
                    padding: "10px 20px",
                    background: isActive
                      ? "rgba(255,255,255,0.07)"
                      : "transparent",
                    border: "none",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "background 0.15s ease",
                    gap: "12px",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      (e.currentTarget as HTMLButtonElement).style.background =
                        "rgba(255,255,255,0.04)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      (e.currentTarget as HTMLButtonElement).style.background =
                        "transparent";
                    }
                  }}
                >
                  {/* Index badge */}
                  <span
                    style={{
                      width: "22px",
                      height: "22px",
                      borderRadius: "4px",
                      background: isActive
                        ? "rgba(255,255,255,0.15)"
                        : "rgba(255,255,255,0.05)",
                      border: `1px solid ${isActive ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.08)"}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      fontSize: "10px",
                      fontFamily: "monospace",
                      color: isActive
                        ? "rgba(255,255,255,0.9)"
                        : "rgba(255,255,255,0.3)",
                    }}
                  >
                    {effect.index}
                  </span>

                  {/* Text */}
                  <span style={{ flex: 1 }}>
                    <span
                      style={{
                        display: "block",
                        color: isActive
                          ? "rgba(255,255,255,0.95)"
                          : "rgba(255,255,255,0.65)",
                        fontSize: "13px",
                        fontFamily: "monospace",
                        fontWeight: isActive ? "600" : "400",
                        letterSpacing: "0.02em",
                      }}
                    >
                      {effect.name}
                    </span>
                    <span
                      style={{
                        display: "block",
                        color: "rgba(255,255,255,0.25)",
                        fontSize: "10px",
                        fontFamily: "monospace",
                        marginTop: "2px",
                      }}
                    >
                      {effect.description}
                    </span>
                  </span>

                  {/* Active indicator */}
                  {isActive && (
                    <span
                      style={{
                        width: "6px",
                        height: "6px",
                        borderRadius: "50%",
                        background: "rgba(255,255,255,0.6)",
                        flexShrink: 0,
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
