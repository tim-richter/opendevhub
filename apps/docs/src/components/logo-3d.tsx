"use client";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

import { EXTENT, HEX_RADIUS, RING, STROKE } from "./logo-3d-geometry";

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Start fetching three.js as soon as this module runs in the browser, rather than after hydration.
const scene =
  typeof window !== "undefined" && !reducedMotion()
    ? import("./logo-3d-scene").catch(() => null)
    : null;

// Cube corners in the logo pose, as seen by the 3D camera (y up): one at the top, then every 60°.
const CORNERS = Array.from({ length: 6 }, (_, i) => {
  const a = Math.PI / 2 + (i * Math.PI) / 3;
  return [HEX_RADIUS * Math.cos(a), -HEX_RADIUS * Math.sin(a)] as const;
});

/**
 * The opendevhub mark as a 3D wireframe cube with an "O" inside. It starts in the exact pose of the
 * flat logo (looking down the cube's diagonal), then turns around itself so every side shows.
 * Click and drag to turn the cube by hand; let go and it springs back to the logo pose and carries on.
 * Until three.js has loaded (and when reduced motion is requested) it shows an SVG of that first frame,
 * drawn in the same coordinates as the 3D camera so the canvas fades in exactly on top of it.
 */
export const Logo3D = ({
  size = 160,
  className,
}: {
  size?: number;
  className?: string;
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !scene) {
      return;
    }
    let disposed = false;
    let cleanup: () => void = () => undefined;

    void scene.then((mod) => {
      if (disposed || !mod) {
        return;
      }
      cleanup = mod.mountLogoScene(host, size, () => setReady(true));
    });

    return () => {
      disposed = true;
      cleanup();
      setReady(false);
    };
  }, [size]);

  return (
    <div
      ref={hostRef}
      className={cn("relative shrink-0", className)}
      style={{ height: size, width: size }}
    >
      {!ready && (
        <svg
          className="absolute inset-0"
          width={size}
          height={size}
          viewBox={`${-EXTENT} ${-EXTENT} ${2 * EXTENT} ${2 * EXTENT}`}
          aria-hidden="true"
          focusable="false"
        >
          <g
            stroke="currentColor"
            strokeWidth={2 * STROKE}
            fill="none"
            strokeLinejoin="round"
            strokeLinecap="round"
          >
            <polygon points={CORNERS.map(([x, y]) => `${x},${y}`).join(" ")} />
            <circle r={RING} />
            {CORNERS.map(([x, y]) => (
              <line key={`${x},${y}`} x1={x} y1={y} x2={0} y2={0} />
            ))}
          </g>
        </svg>
      )}
    </div>
  );
};
