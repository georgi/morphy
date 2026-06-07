/**
 * Presentational SVG overlay that draws the engine's top candidate moves as
 * ranked arrows with eval chips. Pure function of its props — no store access and
 * no side effects; the {@link useBestMoveArrows} hook owns all of that. Mapping to
 * the board uses {@link squareToXY}'s 0–8 unit space, so geometry is
 * resolution-independent and orientation is just a coordinate transform.
 */
import { type ArrowSpec, squareToXY } from "@/lib/arrows";
import type { Orientation } from "@/store";

/**
 * Per-rank visual styling. OKLCH values mirror `DESIGN.md` (ember / ember-soft /
 * muted); they are hardcoded here because DESIGN.md is not yet wired into
 * `index.css` as tokens. Rank readability never leans on hue alone — width and
 * lightness vary with rank, and each arrow carries a numeric eval chip — so the
 * encoding stays colorblind-safe per the Glyph-First rule.
 */
const RANK_STYLE: Record<
  1 | 2 | 3,
  { color: string; width: number; opacity: number }
> = {
  1: { color: "oklch(0.63 0.14 48)", width: 0.14, opacity: 0.95 },
  2: { color: "oklch(0.72 0.10 55)", width: 0.11, opacity: 0.72 },
  3: { color: "oklch(0.70 0.006 60)", width: 0.09, opacity: 0.55 },
};

/** Dark translucent chip background (`ink-elevated` per DESIGN.md). */
const CHIP_BG = "oklch(0.20 0.006 60 / 0.92)";

/** Half-length of the arrowhead along the shaft, in board units. */
const HEAD_LENGTH = 0.38;
/** Half-width of the arrowhead across the shaft, in board units. */
const HEAD_WIDTH = 0.27;

interface BestMoveArrowsProps {
  /** Ranked candidate moves to draw (already top-N, rank-ordered). */
  arrows: ArrowSpec[];
  /** Board orientation; flips the coordinate mapping. */
  orientation: Orientation;
  /** Show the per-arrow eval chips (only while the board is hovered). */
  showEvals?: boolean;
}

/**
 * Render ranked best-move arrows over the board. Returns `null` when there is
 * nothing to draw. Higher ranks are drawn first so rank 1 paints on top. The
 * whole layer fades in (~120ms ease-out) on mount; under `prefers-reduced-motion`
 * it snaps in (no transition, no layout-property animation).
 */
export function BestMoveArrows({
  arrows,
  orientation,
  showEvals = false,
}: BestMoveArrowsProps) {
  if (arrows.length === 0) return null;

  // Draw weakest first so the best move ends up on top.
  const ordered = [...arrows].sort((a, b) => b.rank - a.rank);

  return (
    <svg
      viewBox="0 0 8 8"
      aria-hidden
      className="best-move-arrows pointer-events-none absolute inset-0 h-full w-full"
    >
      {/*
        Scoped fade-in. tw-animate-css works on the element's own box, but this
        SVG is the box, so an inline keyframe keeps the motion self-contained and
        lets us cleanly disable it under reduced-motion.
      */}
      <style>{`
        .best-move-arrows {
          animation: best-move-arrows-in 120ms ease-out both;
        }
        @keyframes best-move-arrows-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .best-move-arrows { animation: none; }
        }
      `}</style>
      {ordered.map((arrow) => (
        <Arrow
          key={`${arrow.from}${arrow.to}`}
          arrow={arrow}
          orientation={orientation}
          showEval={showEvals}
        />
      ))}
    </svg>
  );
}

/** A single arrow: shortened shaft + arrowhead + (on hover) eval chip near the target. */
function Arrow({
  arrow,
  orientation,
  showEval,
}: {
  arrow: ArrowSpec;
  orientation: Orientation;
  showEval: boolean;
}) {
  const style = RANK_STYLE[arrow.rank];
  const s = squareToXY(arrow.from, orientation);
  const e = squareToXY(arrow.to, orientation);

  // Unit vector from origin to target (guard against a zero-length move).
  const dx = e.x - s.x;
  const dy = e.y - s.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;

  // Stop the shaft short of the target so the arrowhead fills the gap.
  const shaftEndX = e.x - ux * HEAD_LENGTH;
  const shaftEndY = e.y - uy * HEAD_LENGTH;

  // Arrowhead tip a touch inside the square; base two perpendicular points back.
  const tipX = e.x - ux * 0.04;
  const tipY = e.y - uy * 0.04;
  const baseX = tipX - ux * HEAD_LENGTH;
  const baseY = tipY - uy * HEAD_LENGTH;
  const px = -uy; // perpendicular
  const py = ux;
  const head = [
    `${tipX},${tipY}`,
    `${baseX + px * HEAD_WIDTH},${baseY + py * HEAD_WIDTH}`,
    `${baseX - px * HEAD_WIDTH},${baseY - py * HEAD_WIDTH}`,
  ].join(" ");

  return (
    <g opacity={style.opacity}>
      <line
        x1={s.x}
        y1={s.y}
        x2={shaftEndX}
        y2={shaftEndY}
        stroke={style.color}
        strokeWidth={style.width}
        strokeLinecap="round"
      />
      <polygon points={head} fill={style.color} />
      {showEval && (
        <EvalChip
          x={e.x}
          y={e.y}
          ux={ux}
          uy={uy}
          text={arrow.evalText}
          color={style.color}
        />
      )}
    </g>
  );
}

/**
 * Compact eval chip near the target square, nudged back along the shaft so it
 * does not fully cover the destination piece. Plex Mono / monospace, text in the
 * arrow's color over a dark translucent background with a thin colored border.
 */
function EvalChip({
  x,
  y,
  ux,
  uy,
  text,
  color,
}: {
  x: number;
  y: number;
  ux: number;
  uy: number;
  text: string;
  color: string;
}) {
  if (!text) return null;

  // Nudge toward the origin so the chip clears the destination square's center.
  const cx = x - ux * 0.34;
  const cy = y - uy * 0.34;

  const fontSize = 0.18;
  const padX = 0.06;
  const height = fontSize + 0.08;
  // Approximate monospace advance width (~0.6em) to size the background rect.
  const width = text.length * fontSize * 0.6 + padX * 2;

  return (
    <g>
      <rect
        x={cx - width / 2}
        y={cy - height / 2}
        width={width}
        height={height}
        rx={0.05}
        fill={CHIP_BG}
        stroke={color}
        strokeWidth={0.025}
      />
      <text
        x={cx}
        y={cy}
        fill={color}
        fontSize={fontSize}
        fontFamily="ui-monospace, monospace"
        textAnchor="middle"
        dominantBaseline="central"
      >
        {text}
      </text>
    </g>
  );
}
