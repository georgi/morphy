import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  BarChart3,
  Library,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  useDefaultLayout,
  usePanelRef,
} from "@/components/ui/resizable";
import { Separator } from "@/components/ui/separator";
import { BoardPanel } from "@/components/board/BoardPanel";
import { ReviewPanel } from "@/components/review/ReviewPanel";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ImportDialog, useAnalyzeGame } from "@/components/import/ImportDialog";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { useAnalyzerStore } from "@/store";

/**
 * Read a header field, treating blank strings and the PGN `"?"` placeholder as
 * absent so the subtitle never shows noise.
 */
function header(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw || raw === "?") return undefined;
  return raw;
}

/**
 * Top-bar subtitle: "Reviewing · {eco opening}" for the loaded game, or a prompt
 * to import when nothing is loaded yet. Omitted entirely when there is a game but
 * no opening metadata to name.
 */
function ReviewingSubtitle() {
  const game = useAnalyzerStore((s) => s.game);
  if (!game) {
    return (
      <span className="hidden text-sm text-muted-foreground sm:inline">
        Import a game to begin.
      </span>
    );
  }

  const opening = [header(game.headers.eco), header(game.headers.opening)]
    .filter(Boolean)
    .join(" ");
  if (!opening) return null;

  return (
    <span className="hidden truncate text-sm text-muted-foreground sm:inline">
      Reviewing · {opening}
    </span>
  );
}

/**
 * The single analysis route. An ember-branded top bar over a three-pane
 * resizable layout: the board, the review surface (header → key moments → moves →
 * advantage), and a collapsible agent chat as the smallest third pane.
 */
export function AnalysisView() {
  const { analyze, isPending, canAnalyze } = useAnalyzeGame();

  // The chat panel stays mounted when collapsed (size 0) so its persistent SSE
  // stream to the analyst survives a collapse. `chatCollapsed` mirrors the panel
  // so the header toggle and a manual handle-drag always agree.
  const chatPanel = usePanelRef();
  const [chatCollapsed, setChatCollapsed] = useState(false);

  // Persist the whole three-pane layout (incl. the chat collapse) across reloads.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "analysis-layout",
    panelIds: ["board", "review", "chat"],
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
  });

  const toggleChat = () => {
    const panel = chatPanel.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  };

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2">
        {/* Ember square logo — the brand mark, the one warm pool of light. */}
        <span aria-hidden className="size-6 shrink-0 rounded-md bg-primary" />
        <h1 className="text-lg font-semibold">Morphy</h1>
        <Separator orientation="vertical" className="!h-5" />
        <ReviewingSubtitle />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/library">
              <Library />
              Library
            </Link>
          </Button>
          <ImportDialog />
          <Button
            variant="default"
            size="sm"
            onClick={analyze}
            disabled={!canAnalyze}
          >
            {isPending ? <Loader2 className="animate-spin" /> : <BarChart3 />}
            {isPending ? "Analyzing…" : "Analyze game"}
          </Button>
          <Separator orientation="vertical" className="!h-5" />
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleChat}
            aria-label="Toggle analyst chat"
            aria-expanded={!chatCollapsed}
            title="Toggle analyst chat"
            className={!chatCollapsed ? "bg-primary/10 text-primary" : undefined}
          >
            {chatCollapsed ? <PanelRightOpen /> : <PanelRightClose />}
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel id="board" defaultSize={42} minSize={30}>
          <BoardPanel />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="review" defaultSize={33} minSize={22}>
          <ReviewPanel />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          id="chat"
          panelRef={chatPanel}
          defaultSize={25}
          minSize={16}
          collapsible
          collapsedSize={0}
          onResize={(size) =>
            setChatCollapsed(chatPanel.current?.isCollapsed() ?? size.asPercentage === 0)
          }
        >
          <ChatPanel />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
