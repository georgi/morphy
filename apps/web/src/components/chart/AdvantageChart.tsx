import { useEffect, useMemo, useRef, useState } from "react";
import { useAnalyzerStore, currentMainlinePly } from "@/store";
import { formatScore } from "@/lib/eval";
import { buildChartModel, plyAtX, type MarkerKind } from "@/lib/advantage";

/** Panel height in px. Width is measured from the container so dots stay round. */
const H = 80;
const DOT_R = 4;

/**
 * Dot colors, welded to the move-quality severity tokens. Paired with a distinct
 * shape per kind (see {@link AdvantageChart}) so the markers survive with color
 * turned off, per the Glyph-First Rule.
 */
const MARKER_COLOR: Record<MarkerKind, string> = {
  blunder: "var(--class-blunder)",
  mistake: "var(--class-mistake)",
  inaccuracy: "var(--class-inaccuracy)",
  brilliant: "var(--class-brilliant)",
};

/** White-POV readout; `null` (no score) collapses to an en-dash placeholder. */
function scoreLabel(cp: number | null): string {
  return formatScore(cp) ?? "–";
}

/**
 * Horizontal "advantage chart": White's win-probability over the game as an
 * eval-white area on a warm panel, with shape-coded classification markers
 * riding the curve, an equal midline, and an ember playhead at the current ply.
 * Hovering shows the move + eval; clicking or dragging scrubs the board to that
 * ply (two-way synced via the store). A compact severity legend sits below.
 * Driven entirely by `store.analysis`; renders a placeholder until the game has
 * been analyzed.
 */
export function AdvantageChart() {
  const game = useAnalyzerStore((s) => s.game);
  const analysis = useAnalyzerStore((s) => s.analysis);
  const currentPly = useAnalyzerStore(currentMainlinePly);
  const gotoPly = useAnalyzerStore((s) => s.gotoPly);

  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [hoverPly, setHoverPly] = useState<number | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    if (el.clientWidth) setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const model = useMemo(() => buildChartModel(analysis), [analysis]);

  if (!analysis || model.plyCount === 0) {
    return (
      <div
        ref={ref}
        className="flex h-20 w-full items-center justify-center rounded-md bg-card text-xs text-muted-foreground"
      >
        {game ? "Analyze game to see evaluation" : "No game loaded"}
      </div>
    );
  }

  const W = width;
  const n = model.plyCount;
  const xPx = (x: number): number => x * W;
  const yArea = (p: number): number => (1 - p) * H;

  const curve = model.points
    .map(
      (pt, i) =>
        `${i === 0 ? "M" : "L"} ${xPx(pt.x).toFixed(2)} ${yArea(pt.whiteProb).toFixed(2)}`,
    )
    .join(" ");
  const area = `${curve} L ${W.toFixed(2)} ${H} L 0 ${H} Z`;

  const cursorX = xPx(currentPly / n);
  const hoverX = hoverPly != null ? xPx(hoverPly / n) : null;

  const tooltip = (ply: number): string => {
    if (ply <= 0) return "Start";
    const mv = game?.moves[ply - 1];
    const score = analysis[ply - 1]?.scoreCpAfter ?? null;
    const label = mv
      ? `${mv.moveNumber}${mv.color === "w" ? "." : "…"} ${mv.san}`
      : `ply ${ply}`;
    return `${label}  ${scoreLabel(score)}`;
  };

  const plyFromEvent = (e: React.PointerEvent<SVGSVGElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    return plyAtX(e.clientX - rect.left, rect.width, n);
  };

  return (
    <div
      ref={ref}
      className="relative w-full select-none"
      data-testid="advantage-chart"
    >
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block h-20 w-full cursor-pointer rounded-md bg-card"
        role="img"
        aria-label="Game evaluation over time"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          gotoPly(plyFromEvent(e));
        }}
        onPointerMove={(e) => {
          const ply = plyFromEvent(e);
          setHoverPly(ply);
          if (dragging.current) gotoPly(ply);
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          e.currentTarget.releasePointerCapture?.(e.pointerId);
        }}
        onPointerLeave={() => setHoverPly(null)}
      >
        {/* Advantage area, filled with the foreground tone so it contrasts
            with the card in both themes (light area on dark, dark on light). */}
        <path d={area} fill="var(--foreground)" />
        <path d={curve} fill="none" stroke="var(--border)" strokeWidth={1} />
        {/* Equal (0.5) reference line. */}
        <line
          x1={0}
          y1={yArea(0.5)}
          x2={W}
          y2={yArea(0.5)}
          stroke="var(--border)"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
        {/* Hover cursor. */}
        {hoverX != null && (
          <line
            x1={hoverX}
            y1={0}
            x2={hoverX}
            y2={H}
            stroke="var(--muted-foreground)"
            strokeWidth={1}
          />
        )}
        {/* Current-ply playhead (ember). */}
        <line
          x1={cursorX}
          y1={0}
          x2={cursorX}
          y2={H}
          stroke="var(--primary)"
          strokeWidth={1.5}
        />
        {/* Classification markers — shape-coded per kind (triangle / hollow
            circle / filled circle / diamond) so they read with color turned
            off, matching the legend below (Glyph-First Rule). */}
        {model.markers.map((m) => {
          const cx = xPx(m.x);
          const cy = Math.max(DOT_R, Math.min(H - DOT_R, yArea(m.whiteProb)));
          const c = MARKER_COLOR[m.kind];
          const r = DOT_R;
          const title = <title>{`${m.san} — ${m.kind}`}</title>;
          if (m.kind === "brilliant") {
            // Filled up-triangle.
            return (
              <polygon
                key={m.ply}
                data-kind={m.kind}
                points={`${cx},${cy - r} ${cx - r},${cy + r} ${cx + r},${cy + r}`}
                fill={c}
                stroke="var(--card)"
                strokeWidth={1}
              >
                {title}
              </polygon>
            );
          }
          if (m.kind === "blunder") {
            // Filled diamond.
            return (
              <polygon
                key={m.ply}
                data-kind={m.kind}
                points={`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`}
                fill={c}
                stroke="var(--card)"
                strokeWidth={1}
              >
                {title}
              </polygon>
            );
          }
          if (m.kind === "inaccuracy") {
            // Hollow circle.
            return (
              <circle
                key={m.ply}
                data-kind={m.kind}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={c}
                strokeWidth={1.5}
              >
                {title}
              </circle>
            );
          }
          // Mistake → filled circle.
          return (
            <circle
              key={m.ply}
              data-kind={m.kind}
              cx={cx}
              cy={cy}
              r={r}
              fill={c}
              stroke="var(--card)"
              strokeWidth={1}
            >
              {title}
            </circle>
          );
        })}
      </svg>
      {/* Severity legend: glyph + shape + token, never color alone. */}
      <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span style={{ color: "var(--class-brilliant)" }}>▲</span>! brilliant
        </span>
        <span className="inline-flex items-center gap-1">
          <span style={{ color: "var(--class-inaccuracy)" }}>○</span>?!
          inaccuracy
        </span>
        <span className="inline-flex items-center gap-1">
          <span style={{ color: "var(--class-blunder)" }}>◆</span>?? blunder
        </span>
      </div>
      {hoverX != null && (
        <div
          className="pointer-events-none absolute -top-7 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-popover px-1.5 py-0.5 text-[11px] tabular-nums text-popover-foreground shadow"
          style={{ left: Math.max(28, Math.min(W - 28, hoverX)) }}
        >
          {tooltip(hoverPly!)}
        </div>
      )}
    </div>
  );
}
