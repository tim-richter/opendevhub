// Isometric lattice edge length (px). Vertical edges plus ±30° diagonals, the same angles as the logo cube.
const EDGE = 36;
const TILE_W = EDGE * Math.sqrt(3);

/**
 * Decorative backdrop for the homepage hero: a faint isometric grid that fades out towards the edges,
 * with two soft colour glows drifting slowly behind the logo. Sits behind its positioned parent's content.
 */
export function HomeBackground() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute left-1/2 top-[14%] -translate-x-[75%]">
        <div className="size-[34rem] rounded-full bg-indigo-500/20 blur-[120px] motion-safe:animate-[home-drift_22s_ease-in-out_infinite_alternate] dark:bg-indigo-500/25" />
      </div>
      <div className="absolute left-1/2 top-[26%] -translate-x-[25%]">
        <div className="size-[28rem] rounded-full bg-cyan-400/15 blur-[120px] motion-safe:animate-[home-drift_28s_ease-in-out_infinite_alternate-reverse] dark:bg-teal-400/15" />
      </div>

      <svg className="absolute inset-0 size-full text-fd-foreground/[0.07] [mask-image:radial-gradient(ellipse_60%_55%_at_50%_42%,black_20%,transparent_100%)] dark:text-fd-foreground/[0.06]">
        <defs>
          <pattern
            id="home-iso-grid"
            width={TILE_W}
            height={EDGE}
            patternUnits="userSpaceOnUse"
            x="50%"
          >
            <path
              d={`M0 0V${EDGE}M${TILE_W / 2} 0V${EDGE}M0 0L${TILE_W} ${EDGE}M0 ${EDGE}L${TILE_W} 0`}
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#home-iso-grid)" />
      </svg>

      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-fd-background to-transparent" />
    </div>
  );
}
