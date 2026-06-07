import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { Move, MoveClassification, MoveEval } from "@chess/shared";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAnalyzerStore } from "@/store";
import type { MoveNode } from "@/lib/moveTree";
import { cn } from "@/lib/utils";
import { formatScore } from "@/lib/eval";

/** Glyph + tone for the classifications worth surfacing in the move list. */
const CLASSIFICATION_GLYPH: Partial<Record<MoveClassification, string>> = {
  inaccuracy: "?!",
  mistake: "?",
  blunder: "??",
};

function classificationColor(c: MoveClassification): string {
  switch (c) {
    case "blunder":
      return "text-[var(--class-blunder)]";
    case "mistake":
      return "text-[var(--class-mistake)]";
    case "inaccuracy":
      return "text-[var(--class-inaccuracy)]";
    default:
      return "";
  }
}

function formatEval(evaluation: MoveEval): string | null {
  return formatScore(evaluation.scoreCpAfter);
}

/** The mainline chain (root excluded), following `children[0]`. */
function mainlineNodes(nodesById: Record<string, MoveNode>, rootId: string): MoveNode[] {
  const out: MoveNode[] = [];
  let id: string | undefined = nodesById[rootId]?.children[0];
  while (id) {
    const node: MoveNode = nodesById[id];
    out.push(node);
    id = node.children[0];
  }
  return out;
}

/** A mainline ply cell: classification glyph + post-move eval, like the old list. */
function MoveCell({
  node,
  evaluation,
  active,
  onSelect,
}: {
  node: MoveNode;
  evaluation?: MoveEval;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const classification = evaluation?.classification;
  const glyph = classification ? CLASSIFICATION_GLYPH[classification] : undefined;
  const evalText = evaluation ? formatEval(evaluation) : null;
  const color = classification ? classificationColor(classification) : "";
  const san = node.move?.san ?? "";

  return (
    <button
      type="button"
      onClick={() => onSelect(node.id)}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full items-baseline gap-1 rounded px-2 py-1 text-left tabular-nums hover:bg-accent",
        active && "bg-primary/15 font-medium ring-1 ring-primary/40",
      )}
    >
      <span className={cn("truncate", color)}>
        {san}
        {glyph ? <span className="ml-0.5 font-semibold">{glyph}</span> : null}
      </span>
      {evalText ? (
        <span className="ml-auto text-xs text-muted-foreground">{evalText}</span>
      ) : null}
    </button>
  );
}

/** An inline variation token: move number (white, or first-in-run) + SAN. */
function VarToken({
  node,
  first,
  active,
  onSelect,
}: {
  node: MoveNode;
  first: boolean;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const mv = node.move as Move;
  const showNumber = mv.color === "w" || first;
  const label = mv.color === "w" ? `${mv.moveNumber}.` : `${mv.moveNumber}…`;
  return (
    <button
      type="button"
      onClick={() => onSelect(node.id)}
      aria-current={active ? "true" : undefined}
      className={cn(
        "rounded px-1 py-0.5 tabular-nums hover:bg-accent",
        active && "bg-primary/15 font-medium ring-1 ring-primary/40",
      )}
    >
      {showNumber ? <span className="mr-0.5 text-muted-foreground">{label}</span> : null}
      {mv.san}
    </button>
  );
}

/**
 * One variation line: an inline run following `children[0]`, with any nested
 * variations rendered as deeper indented blocks (a full-width child forces a
 * line break inside the flex-wrap container).
 */
function VariationLine({
  startId,
  nodesById,
  currentNodeId,
  onSelect,
  depth = 0,
}: {
  startId: string;
  nodesById: Record<string, MoveNode>;
  currentNodeId: string;
  onSelect: (id: string) => void;
  depth?: number;
}) {
  const els: ReactNode[] = [];
  let id: string | undefined = startId;
  let first = true;
  while (id) {
    const node: MoveNode = nodesById[id];
    els.push(
      <VarToken
        key={node.id}
        node={node}
        first={first}
        active={node.id === currentNodeId}
        onSelect={onSelect}
      />,
    );
    // Nested variations branch off this node's primary continuation.
    if (node.children.length > 1) {
      for (const vid of node.children.slice(1)) {
        els.push(
          <div key={`nv-${vid}`} className="w-full">
            <VariationLine
              startId={vid}
              nodesById={nodesById}
              currentNodeId={currentNodeId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          </div>,
        );
      }
    }
    first = false;
    id = node.children[0];
  }
  return (
    <div
      className="my-1 flex flex-wrap items-baseline gap-x-1 gap-y-0.5 border-l-2 border-border bg-muted/30 py-1 pl-2 text-[0.8125rem] text-muted-foreground"
      style={{ marginLeft: depth * 10 }}
    >
      {els}
    </div>
  );
}

/**
 * The move list as a tree. The mainline renders as two-column White/Black rows;
 * wherever a node carries variations (alternatives to its primary continuation),
 * an inset run is emitted right after the row of that continuation. Any token
 * navigates the tree on click; the active node is highlighted and auto-scrolled.
 */
export function MoveList() {
  const nodesById = useAnalyzerStore((s) => s.nodesById);
  const rootId = useAnalyzerStore((s) => s.rootId);
  const currentNodeId = useAnalyzerStore((s) => s.currentNodeId);
  const gotoNode = useAnalyzerStore((s) => s.gotoNode);
  const analysis = useAnalyzerStore((s) => s.analysis);

  const mainline = useMemo(() => mainlineNodes(nodesById, rootId), [nodesById, rootId]);
  const evalByPly = useMemo(() => {
    const map = new Map<number, MoveEval>();
    for (const e of analysis ?? []) map.set(e.ply, e);
    return map;
  }, [analysis]);

  const containerRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    containerRef.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [currentNodeId, mainline]);

  if (mainline.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        No game loaded.
      </div>
    );
  }

  // Assemble ordered render items: 2-col rows interleaved with variation blocks.
  const out: ReactNode[] = [];
  let rowNum = 0;
  let whiteEl: ReactNode = null;
  let blackEl: ReactNode = null;
  let key = 0;

  const flushRow = () => {
    if (whiteEl || blackEl) {
      out.push(
        <li key={`row-${key++}`} className="flex items-stretch gap-1">
          <span className="w-8 shrink-0 select-none py-1 pr-1 text-right text-muted-foreground">
            {rowNum}.
          </span>
          <div className="grid min-w-0 flex-1 grid-cols-2 gap-1">
            {whiteEl ?? <span aria-hidden />}
            {blackEl ?? <span aria-hidden />}
          </div>
        </li>,
      );
    }
    whiteEl = null;
    blackEl = null;
  };

  for (const node of mainline) {
    const mv = node.move as Move;
    const cell = (
      <MoveCell
        node={node}
        evaluation={evalByPly.get(mv.ply)}
        active={node.id === currentNodeId}
        onSelect={gotoNode}
      />
    );
    if (mv.color === "w") {
      flushRow();
      rowNum = mv.moveNumber;
      whiteEl = cell;
    } else {
      if (rowNum !== mv.moveNumber) {
        flushRow();
        rowNum = mv.moveNumber;
      }
      blackEl = cell;
      flushRow();
    }

    // Variations are alternatives to THIS node (its parent's non-primary children).
    const parent = node.parentId ? nodesById[node.parentId] : null;
    if (parent && parent.children.length > 1 && parent.children[0] === node.id) {
      flushRow();
      for (const vid of parent.children.slice(1)) {
        out.push(
          <li key={`var-${vid}`} className="list-none">
            <VariationLine
              startId={vid}
              nodesById={nodesById}
              currentNodeId={currentNodeId}
              onSelect={gotoNode}
            />
          </li>,
        );
      }
    }
  }
  flushRow();

  return (
    <ScrollArea className="h-full">
      <ol ref={containerRef} className="flex flex-col p-2 text-sm">
        {out}
      </ol>
    </ScrollArea>
  );
}
