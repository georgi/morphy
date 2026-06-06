import { useQuery } from "@tanstack/react-query";
import type { KeyMoment, MoveClassification } from "@chess/shared";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useAnalyzerStore } from "@/store";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";

/**
 * Per-classification glyph, label, and the `--class-*` token that tints both.
 * Severity stays colorblind-safe: the glyph and label always travel with the hue
 * (the Glyph-First Rule), so a moment reads with the color channel turned off.
 */
const CLASS_META: Partial<
  Record<MoveClassification, { glyph: string; label: string; color: string }>
> = {
  best: { glyph: "!", label: "BRILLIANT", color: "var(--class-brilliant)" },
  inaccuracy: {
    glyph: "?!",
    label: "INACCURACY",
    color: "var(--class-inaccuracy)",
  },
  mistake: { glyph: "?", label: "MISTAKE", color: "var(--class-mistake)" },
  blunder: { glyph: "??", label: "BLUNDER", color: "var(--class-blunder)" },
};

/** Section wrapper: the `KEY MOMENTS` header (with an optional count) over `children`. */
function Section({
  count,
  children,
}: {
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Key Moments
        </h2>
        {count !== undefined && count > 0 ? (
          <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** A single moment card. Navigates the board to its ply on click. */
function MomentCard({
  moment,
  onSelect,
}: {
  moment: KeyMoment;
  onSelect: (ply: number) => void;
}) {
  const meta = CLASS_META[moment.classification];
  const glyph = meta?.glyph ?? "?";
  const label = meta?.label ?? moment.classification.toUpperCase();
  const color = meta?.color;
  // A blunder or the decisive turning point gets a full class-blunder border —
  // never a side stripe (the Don't rule).
  const emphasized =
    moment.isTurningPoint || moment.classification === "blunder";

  return (
    <button
      type="button"
      onClick={() => onSelect(moment.ply)}
      className={cn(
        "flex w-full flex-col gap-1.5 rounded-md border border-border bg-card p-3 text-left transition-colors hover:bg-accent",
      )}
      style={emphasized ? { borderColor: "var(--class-blunder)" } : undefined}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="font-mono text-sm font-semibold"
          style={color ? { color } : undefined}
        >
          {glyph}
        </span>
        <span className="font-mono text-sm tabular-nums">
          {moment.moveNumber}…{moment.san}
        </span>
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={color ? { color } : undefined}
        >
          {label}
        </span>
        {moment.isTurningPoint ? (
          // Pill is tinted by the moment's OWN severity (the turning point is
          // chosen by cp-loss, not necessarily a blunder), so it never
          // contradicts the card's glyph/label. Falls back to ember identity.
          <span
            className="rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider"
            style={{
              color: color ?? "var(--primary)",
              borderColor: color ?? "var(--primary)",
            }}
          >
            Turning point
          </span>
        ) : null}
        <span className="ml-auto font-mono text-sm tabular-nums text-muted-foreground">
          {moment.evalText}
        </span>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {moment.description}
      </p>
    </button>
  );
}

/** Skeleton placeholder mirroring a moment card's shape while fetching. */
function MomentSkeleton() {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-6" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="ml-auto h-4 w-10" />
      </div>
      <Skeleton className="h-4 w-full" />
    </div>
  );
}

/**
 * Review section listing a game's decisive moments. Reads the loaded game +
 * analysis from the store and fetches the curated moments via TanStack Query.
 * Renders nothing without a game; prompts to analyze when there's no analysis
 * yet (or the list is empty); shows skeletons while fetching. Clicking a card
 * navigates the board to that ply.
 */
export function KeyMoments() {
  const gameId = useAnalyzerStore((s) => s.game?.id);
  const analysis = useAnalyzerStore((s) => s.analysis);
  const gotoPly = useAnalyzerStore((s) => s.gotoPly);

  const hasAnalysis = Boolean(analysis && analysis.length > 0);

  const { data, isPending } = useQuery({
    queryKey: ["key-moments", gameId],
    queryFn: () => api.keyMoments(gameId as string),
    enabled: Boolean(gameId) && hasAnalysis,
  });

  // Nothing to review until a game is loaded.
  if (!gameId) return null;

  // No analysis yet — invite the user to run it (matches the server's `[]` state).
  if (!hasAnalysis) {
    return (
      <Section>
        <p className="text-sm text-muted-foreground">
          Analyze game to surface key moments.
        </p>
      </Section>
    );
  }

  if (isPending) {
    return (
      <Section>
        <div className="flex flex-col gap-2">
          <MomentSkeleton />
          <MomentSkeleton />
        </div>
      </Section>
    );
  }

  const moments = data ?? [];
  if (moments.length === 0) {
    return (
      <Section>
        <p className="text-sm text-muted-foreground">
          Analyze game to surface key moments.
        </p>
      </Section>
    );
  }

  return (
    <Section count={moments.length}>
      <ScrollArea className="max-h-[40vh]">
        <div className="flex flex-col gap-2">
          {moments.map((moment) => (
            <MomentCard key={moment.ply} moment={moment} onSelect={gotoPly} />
          ))}
        </div>
      </ScrollArea>
    </Section>
  );
}
