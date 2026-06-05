import { Link } from "@tanstack/react-router";
import { BarChart3, Library, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Separator } from "@/components/ui/separator";
import { BoardPanel } from "@/components/board/BoardPanel";
import { MoveList } from "@/components/moves/MoveList";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ImportDialog, useAnalyzeGame } from "@/components/import/ImportDialog";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { useAnalyzerStore } from "@/store";

/**
 * Subtitle for the top bar: the loaded game's matchup (and result when known),
 * or a prompt to import when nothing is loaded yet.
 */
function GameSummary() {
  const game = useAnalyzerStore((s) => s.game);
  if (!game) {
    return (
      <span className="hidden text-sm text-muted-foreground sm:inline">
        Import a game to begin.
      </span>
    );
  }

  const white = game.headers.white ?? "White";
  const black = game.headers.black ?? "Black";
  const result = game.headers.result;
  return (
    <span className="hidden truncate text-sm text-muted-foreground sm:inline">
      {white} vs {black}
      {result && result !== "*" ? ` · ${result}` : ""}
    </span>
  );
}

/**
 * The single analysis route. Top bar (import + analyze) over a three-pane
 * resizable layout: board + eval bar + controls | move list | agent chat.
 */
export function AnalysisView() {
  const { analyze, isPending, canAnalyze } = useAnalyzeGame();

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <h1 className="text-lg font-semibold">Chess Analyzer</h1>
        <Separator orientation="vertical" className="!h-5" />
        <GameSummary />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/library">
              <Library />
              Library
            </Link>
          </Button>
          <ImportDialog />
          <Button
            variant="outline"
            size="sm"
            onClick={analyze}
            disabled={!canAnalyze}
          >
            {isPending ? <Loader2 className="animate-spin" /> : <BarChart3 />}
            {isPending ? "Analyzing…" : "Analyze game"}
          </Button>
          <Separator orientation="vertical" className="!h-5" />
          <ThemeToggle />
        </div>
      </header>

      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={45} minSize={30}>
          <BoardPanel />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={25} minSize={15}>
          <div className="flex h-full flex-col">
            <div className="px-3 py-2 text-sm font-medium text-muted-foreground">
              Moves
            </div>
            <Separator />
            <div className="min-h-0 flex-1">
              <MoveList />
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={30} minSize={20}>
          <ChatPanel />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
