import { useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  FileUp,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import type {
  EngineEval,
  MoveEval,
  StartImportRequest,
  CatalogEntry,
} from "@chess/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import { ApiError } from "@/lib/api";
import { useAnalyzerStore, useImportStore } from "@/store";

/**
 * A well-known, heavily annotated game ending in a blunder: Morphy's "Opera
 * Game" (Paris, 1858). Black's loose play hands White a forced mate.
 */
const SAMPLE_PGN = `[Event "Paris Opera"]
[Site "Paris FRA"]
[Date "1858.??.??"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]
[ECO "C41"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7
8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8
13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`;

type DownloadTab = "lichess" | "chesscom" | "catalog" | "url";

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/**
 * Live progress panel fed by the import SSE stream. Shows imported / skipped /
 * failed (and total when the source reports one), plus a terminal banner on
 * done/error. Rendered only while a job is active.
 */
function ImportProgressPanel() {
  const job = useImportStore((s) => s.job);
  if (!job) return null;
  const { imported, skipped, failed, total } = job.progress;
  const done = imported + skipped + failed;

  return (
    <div className="rounded-md border bg-muted/40 p-3 text-sm">
      <div className="mb-2 flex items-center gap-2 font-medium">
        {job.status === "running" && (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            <span>Importing{total ? ` (${done}/${total})` : "…"}</span>
          </>
        )}
        {job.status === "done" && (
          <>
            <CheckCircle2 className="size-4 text-emerald-500" aria-hidden />
            <span>Import complete</span>
          </>
        )}
        {job.status === "error" && (
          <>
            <AlertCircle className="size-4 text-destructive" aria-hidden />
            <span>Import failed</span>
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">Imported {imported}</Badge>
        <Badge variant="outline">Skipped {skipped}</Badge>
        <Badge variant="outline">Failed {failed}</Badge>
        {total !== undefined && <Badge variant="outline">Total {total}</Badge>}
      </div>
      {job.status === "error" && job.error && (
        <p className="mt-2 text-xs text-destructive">{job.error}</p>
      )}
    </div>
  );
}

/**
 * The bulk-download dialog (SPEC §7). Four source tabs — Lichess, Chess.com,
 * Catalog, and URL/Paste — each build a {@link StartImportRequest}; submitting
 * starts an import job (`POST /api/import`), opens its SSE stream, and surfaces
 * live progress. On `done` the library/collections queries are invalidated and a
 * toast is shown. The single-game `useAnalyzeGame` hook is exported alongside so
 * the analysis view's import entry point and analyze action share this file.
 */
export function ImportDialog() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DownloadTab>("url");
  const queryClient = useQueryClient();
  const setGame = useAnalyzerStore((s) => s.setGame);

  const job = useImportStore((s) => s.job);
  const startJob = useImportStore((s) => s.startJob);
  const applyEvent = useImportStore((s) => s.applyEvent);
  const clearJob = useImportStore((s) => s.clearJob);

  // URL / Paste tab.
  const [url, setUrl] = useState("");
  const [pgn, setPgn] = useState("");
  const [collectionName, setCollectionName] = useState("");
  // Lichess tab.
  const [lichessKind, setLichessKind] = useState<"user" | "study" | "broadcast">(
    "user",
  );
  const [lichessId, setLichessId] = useState("");
  const [lichessMax, setLichessMax] = useState("");
  // Chess.com tab.
  const [chesscomUser, setChesscomUser] = useState("");
  const [chesscomMonths, setChesscomMonths] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  const catalogQuery = useQuery({
    queryKey: ["import-catalog"],
    queryFn: () => api.getImportCatalog(),
    enabled: open && tab === "catalog",
  });

  const sourceRef = useRef<EventSource | null>(null);
  const running = job?.status === "running";

  /** Tear down any live SSE stream (on submit of a new job, dialog close, etc). */
  const closeStream = () => {
    sourceRef.current?.close();
    sourceRef.current = null;
  };

  const startMutation = useMutation({
    mutationFn: (body: StartImportRequest) => api.startImport(body),
    onSuccess: ({ jobId }, body) => {
      closeStream();
      startJob(jobId, body.source);
      sourceRef.current = api.openImportStream(jobId, (event) => {
        applyEvent(event);
        if (event.type === "done") {
          closeStream();
          void queryClient.invalidateQueries({ queryKey: ["library"] });
          void queryClient.invalidateQueries({ queryKey: ["collections"] });
          const parts = [
            `${event.imported} imported`,
            event.skipped ? `${event.skipped} skipped` : null,
            event.failed ? `${event.failed} failed` : null,
          ].filter(Boolean);
          toast.success("Import complete", { description: parts.join(", ") });
        } else if (event.type === "error") {
          closeStream();
          toast.error("Import failed", { description: event.message });
        }
      });
    },
    onError: (err) => {
      toast.error("Could not start import", {
        description: errorMessage(err),
      });
    },
  });

  /** Single-game paste path: load the active game straight into the board. */
  const loadSingleMutation = useMutation({
    mutationFn: (body: { pgn: string }) => api.importGame(body),
    onSuccess: (game) => {
      setGame(game);
      setOpen(false);
      const white = game.headers.white ?? "White";
      const black = game.headers.black ?? "Black";
      toast.success("Game loaded", {
        description: `${white} vs ${black} — ${game.moves.length} half-moves.`,
      });
    },
    onError: (err) => {
      toast.error("Import failed", { description: errorMessage(err) });
    },
  });

  const submitUrl = () => {
    const trimmedUrl = url.trim();
    const trimmedPgn = pgn.trim();
    if (!trimmedUrl && !trimmedPgn) {
      toast.error("Nothing to import", {
        description: "Paste a PGN or enter a .pgn URL first.",
      });
      return;
    }
    startMutation.mutate({
      source: "url",
      url: trimmedUrl || undefined,
      pgn: trimmedPgn || undefined,
      collectionName: collectionName.trim() || undefined,
    });
  };

  const submitLichess = () => {
    const id = lichessId.trim();
    if (!id) {
      toast.error("Missing id", {
        description: "Enter a Lichess username, study, or broadcast id.",
      });
      return;
    }
    const max = Number.parseInt(lichessMax, 10);
    startMutation.mutate({
      source: "lichess",
      kind: lichessKind,
      id,
      max: Number.isFinite(max) && max > 0 ? max : undefined,
    });
  };

  const submitChesscom = () => {
    const username = chesscomUser.trim();
    if (!username) {
      toast.error("Missing username", {
        description: "Enter a Chess.com username.",
      });
      return;
    }
    const months = chesscomMonths
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    startMutation.mutate({
      source: "chesscom",
      username,
      months: months.length ? months : "all",
    });
  };

  const submitCatalog = (entry: CatalogEntry) => {
    startMutation.mutate({ source: "catalog", entryId: entry.id });
  };

  /** Read a dropped/chosen file into the paste box and switch to the URL tab. */
  const handleFile = async (file: File) => {
    let text: string;
    try {
      text = (await file.text()).trim();
    } catch {
      toast.error("Could not read file", { description: file.name });
      return;
    }
    if (!text) {
      toast.error("Empty file", { description: file.name });
      return;
    }
    setPgn(text);
    setTab("url");
  };

  const onFilePicked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
    e.target.value = "";
  };

  /** Reset transient state when the dialog closes. */
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && !running) {
      closeStream();
      clearJob();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Download />
          Import
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Download games</DialogTitle>
          <DialogDescription>
            Import from Lichess, Chess.com, the catalog, or a URL / pasted PGN.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as DownloadTab)}>
          <TabsList>
            <TabsTrigger value="lichess">Lichess</TabsTrigger>
            <TabsTrigger value="chesscom">Chess.com</TabsTrigger>
            <TabsTrigger value="catalog">Catalog</TabsTrigger>
            <TabsTrigger value="url">URL / Paste</TabsTrigger>
          </TabsList>

          {/* ── Lichess ─────────────────────────────────────────────────── */}
          <TabsContent value="lichess" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" htmlFor="lichess-kind">
                Type
              </label>
              <select
                id="lichess-kind"
                aria-label="Lichess type"
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                value={lichessKind}
                onChange={(e) =>
                  setLichessKind(
                    e.target.value as "user" | "study" | "broadcast",
                  )
                }
              >
                <option value="user">User games</option>
                <option value="study">Study</option>
                <option value="broadcast">Broadcast</option>
              </select>
            </div>
            <Input
              aria-label="Lichess id"
              placeholder={
                lichessKind === "user" ? "username" : "study / broadcast id"
              }
              value={lichessId}
              onChange={(e) => setLichessId(e.target.value)}
            />
            {lichessKind === "user" && (
              <Input
                aria-label="Max games"
                type="number"
                placeholder="Max games (optional)"
                value={lichessMax}
                onChange={(e) => setLichessMax(e.target.value)}
              />
            )}
            <Button
              type="button"
              onClick={submitLichess}
              disabled={running || startMutation.isPending}
            >
              <Download />
              Import from Lichess
            </Button>
          </TabsContent>

          {/* ── Chess.com ───────────────────────────────────────────────── */}
          <TabsContent value="chesscom" className="flex flex-col gap-3">
            <Input
              aria-label="Chess.com username"
              placeholder="username"
              value={chesscomUser}
              onChange={(e) => setChesscomUser(e.target.value)}
            />
            <Input
              aria-label="Months"
              placeholder="Months e.g. 2024/01, 2024/02 (blank = all)"
              value={chesscomMonths}
              onChange={(e) => setChesscomMonths(e.target.value)}
            />
            <Button
              type="button"
              onClick={submitChesscom}
              disabled={running || startMutation.isPending}
            >
              <Download />
              Import from Chess.com
            </Button>
          </TabsContent>

          {/* ── Catalog ─────────────────────────────────────────────────── */}
          <TabsContent value="catalog" className="flex flex-col gap-2">
            {catalogQuery.isLoading && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading catalog…
              </div>
            )}
            {catalogQuery.data && (
              <ScrollArea className="h-64">
                <div className="flex flex-col gap-2 pr-3">
                  {catalogQuery.data.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-start justify-between gap-3 rounded-md border p-2.5"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium">
                            {entry.title}
                          </span>
                          {entry.bundled && (
                            <Badge variant="secondary">bundled</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {entry.description}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={`Import ${entry.title}`}
                        onClick={() => submitCatalog(entry)}
                        disabled={running || startMutation.isPending}
                      >
                        Import
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </TabsContent>

          {/* ── URL / Paste ─────────────────────────────────────────────── */}
          <TabsContent value="url" className="flex flex-col gap-2">
            <Input
              aria-label="PGN URL"
              placeholder="https://…/games.pgn (or .pgn.gz)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Textarea
              aria-label="PGN paste"
              value={pgn}
              onChange={(e) => setPgn(e.target.value)}
              placeholder='Paste one or more games — [Event "…"] 1. e4 e5 …'
              rows={8}
              className="h-40 resize-none overflow-y-auto [field-sizing:fixed]"
            />
            <Input
              aria-label="Collection name"
              placeholder="Collection name (optional)"
              value={collectionName}
              onChange={(e) => setCollectionName(e.target.value)}
            />
            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPgn(SAMPLE_PGN)}
                disabled={running || startMutation.isPending}
              >
                Load sample game
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => loadSingleMutation.mutate({ pgn: pgn.trim() })}
                  disabled={
                    !pgn.trim() ||
                    loadSingleMutation.isPending ||
                    running ||
                    startMutation.isPending
                  }
                >
                  Load to board
                </Button>
                <Button
                  type="button"
                  onClick={submitUrl}
                  disabled={running || startMutation.isPending}
                >
                  <Download />
                  Import
                </Button>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <ImportProgressPanel />

        <input
          ref={fileInputRef}
          type="file"
          accept=".pgn,.txt,text/plain"
          className="hidden"
          onChange={onFilePicked}
        />

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={running}
          >
            <FileUp />
            From file
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {running ? "Run in background" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Projects a per-move evaluation into the {@link EngineEval} shape the board's
 * eval bar consumes for a given ply. `scoreCpAfter` is the engine score of the
 * position *after* the move, i.e. the eval to show once you reach that ply.
 */
function evalForPly(moveEval: MoveEval): EngineEval {
  return {
    fen: "",
    bestMove: moveEval.bestMove,
    depth: 0,
    lines: [
      {
        pv: moveEval.bestLine,
        scoreCp: moveEval.scoreCpAfter,
        mate: null,
        rank: 1,
      },
    ],
  };
}

/**
 * Drives the "Analyze game" top-bar action: runs full-game analysis for the
 * active game, stores the resulting {@link MoveEval}[], and fans the per-move
 * scores out into the store's `evalByPly` cache so the eval bar lights up at
 * every ply.
 *
 * Returns the TanStack mutation plus a ready-to-bind `analyze` handler and a
 * `canAnalyze` flag. The {@link AnalysisView} top bar calls `analyze()` and
 * binds `isPending`/`canAnalyze` to the button's loading + disabled state.
 */
export function useAnalyzeGame() {
  const game = useAnalyzerStore((s) => s.game);
  const setAnalysis = useAnalyzerStore((s) => s.setAnalysis);
  const setEvalForPly = useAnalyzerStore((s) => s.setEvalForPly);

  const mutation = useMutation({
    mutationFn: (gameId: string) => api.analyzeGame({ gameId }),
    onSuccess: (evals: MoveEval[]) => {
      setAnalysis(evals);
      for (const moveEval of evals) {
        setEvalForPly(moveEval.ply, evalForPly(moveEval));
      }
      const flagged = evals.filter(
        (e) =>
          e.classification === "inaccuracy" ||
          e.classification === "mistake" ||
          e.classification === "blunder",
      ).length;
      toast.success("Analysis complete", {
        description:
          flagged > 0
            ? `${flagged} move${flagged === 1 ? "" : "s"} flagged.`
            : "No mistakes found.",
      });
    },
    onError: (err) => {
      toast.error("Analysis failed", { description: errorMessage(err) });
    },
  });

  const analyze = () => {
    if (!game) {
      toast.error("No game loaded", {
        description: "Import a game before analyzing.",
      });
      return;
    }
    mutation.mutate(game.id);
  };

  return {
    analyze,
    isPending: mutation.isPending,
    canAnalyze: game !== null && !mutation.isPending,
  };
}
