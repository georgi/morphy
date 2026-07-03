import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CatalogEntry, Game, MoveEval } from "@chess/shared";
import { resetLibraryDbForTests } from "@/lib/db/library-db";
import { gamesRepo } from "@/lib/db/games-repo";

// jsdom lacks the DOM APIs Radix Dialog/Tabs lean on. Stub the few they touch so
// the real component mounts and its portal content renders.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const CATALOG: CatalogEntry[] = [
  {
    id: "morphy",
    title: "Morphy Brilliancies",
    description: "A handful of Paul Morphy's most famous attacking games.",
    url: "https://example.test/morphy.pgn",
    bundled: true,
  },
];

// Mock the API client: no network. `openImportStream` returns a stub EventSource
// so the component's stream wiring runs without a live connection. The factory is
// hoisted, so the mock fns are created inside it and read back via `vi.mocked`.
vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  importGame: vi.fn(),
  startImport: vi.fn(
    (): Promise<{ jobId: string }> => Promise.resolve({ jobId: "job-xyz" }),
  ),
  getImportCatalog: vi.fn(
    (): Promise<CatalogEntry[]> => Promise.resolve(CATALOG),
  ),
  openImportStream: vi.fn(() => ({ close: vi.fn() })),
  getImportJob: vi.fn(),
  analyzeGame: vi.fn(),
}));

import * as api from "@/lib/api";
const startImport = vi.mocked(api.startImport);
const importGame = vi.mocked(api.importGame);
const analyzeGame = vi.mocked(api.analyzeGame);

const SINGLE_START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** A minimal one-ply game for the single-import (`Load to board`) path. */
function makeGame(id: string): Game {
  return {
    id,
    headers: { white: "Alice", black: "Bob", result: "1-0" },
    startFen: SINGLE_START_FEN,
    moves: [
      {
        ply: 1,
        moveNumber: 1,
        color: "w",
        san: "e4",
        uci: "e2e4",
        fenBefore: SINGLE_START_FEN,
        fenAfter: SINGLE_START_FEN,
      },
    ],
  };
}

beforeEach(() => {
  resetLibraryDbForTests();
  startImport.mockClear();
  importGame.mockReset();
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  // Radix uses pointer-capture + scrollIntoView, absent in jsdom.
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

import { ImportDialog, useAnalyzeGame } from "@/components/import/ImportDialog";
import { useAnalyzerStore, useImportStore } from "@/store";

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ImportDialog />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Click the trigger and wait for the dialog content to appear. */
async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: /import/i }));
  await screen.findByRole("dialog");
}

afterEach(() => {
  cleanup();
  useImportStore.setState({ job: null });
  useAnalyzerStore.setState({ game: null, analysis: null });
  vi.unstubAllGlobals();
});

describe("ImportDialog (download dialog)", () => {
  it("renders all four source tabs once opened", async () => {
    renderDialog();
    await openDialog();
    expect(screen.getByRole("tab", { name: "Lichess" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Chess.com" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Catalog" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "URL / Paste" })).toBeDefined();
  });

  it("starts an import job from the URL / Paste tab", async () => {
    renderDialog();
    await openDialog();

    // URL/Paste is the default tab; paste a game and submit.
    fireEvent.change(screen.getByLabelText("PGN paste"), {
      target: { value: '[Event "x"]\n\n1. e4 e5 *' },
    });
    // The tab has both "Load to board" and "Import"; the import buttons match
    // /import/i — pick the submit one inside the dialog footer area by role+name.
    const importButtons = screen.getAllByRole("button", { name: /^import$/i });
    fireEvent.click(importButtons[importButtons.length - 1]);

    await waitFor(() => expect(startImport).toHaveBeenCalledTimes(1));
    expect(startImport).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "url",
        pgn: '[Event "x"]\n\n1. e4 e5 *',
      }),
    );
    // The job is now tracked in the import store.
    await waitFor(() =>
      expect(useImportStore.getState().job?.jobId).toBe("job-xyz"),
    );
  });

  it("starts a Lichess import with kind + id", async () => {
    renderDialog();
    await openDialog();

    // Radix Tabs activate on mousedown (not a bare click) in jsdom.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Lichess" }));
    fireEvent.change(await screen.findByLabelText("Lichess id"), {
      target: { value: "DrNykterstein" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /import from lichess/i }),
    );

    await waitFor(() => expect(startImport).toHaveBeenCalledTimes(1));
    expect(startImport).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "lichess",
        kind: "user",
        id: "DrNykterstein",
      }),
    );
  });

  it("shows a live progress panel reflecting the import store", async () => {
    renderDialog();
    await openDialog();
    // Seed a running job with some progress directly; the panel just reads the
    // store (imported/skipped are computed by the store's IDB dedup elsewhere).
    useImportStore.setState({
      job: {
        jobId: "job-xyz",
        source: "url",
        status: "running",
        progress: { imported: 3, skipped: 1, failed: 0, total: 8 },
      },
    });
    await waitFor(() => expect(screen.getByText("Imported 3")).toBeDefined());
    expect(screen.getByText("Skipped 1")).toBeDefined();
    expect(screen.getByText("Total 8")).toBeDefined();
  });
});

describe("ImportDialog (single-game 'Load to board' path)", () => {
  /** Paste a PGN and click "Load to board" to fire the single-import mutation. */
  async function loadToBoard() {
    fireEvent.change(screen.getByLabelText("PGN paste"), {
      target: { value: "1. e4 e5 *" },
    });
    fireEvent.click(screen.getByRole("button", { name: /load to board/i }));
  }

  it("happy path: writes the returned game to IndexedDB", async () => {
    const game = makeGame("g1");
    importGame.mockResolvedValueOnce({ game, contentHash: "hash-1" });

    renderDialog();
    await openDialog();
    await loadToBoard();

    await waitFor(async () => {
      expect(await gamesRepo.get("g1")).toBeDefined();
    });
    expect(await gamesRepo.existsByHash("hash-1")).toBe(true);
  });

  it("skips the write (no duplicate, no thrown ConstraintError) when the contentHash already exists", async () => {
    const existing = makeGame("existing");
    await gamesRepo.put(existing, {
      source: "manual",
      createdAt: 1,
      contentHash: "dup-hash",
    });

    const incoming = makeGame("incoming");
    importGame.mockResolvedValueOnce({
      game: incoming,
      contentHash: "dup-hash",
    });

    renderDialog();
    await openDialog();
    await loadToBoard();

    // The board should still load the incoming game even though it's a dup —
    // the dialog closes once `setGame`/`setOpen(false)` run in `onSuccess`.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The `by-hash` index is unique — a naive put here would throw
    // ConstraintError. It must be skipped instead, with the original untouched.
    expect(await gamesRepo.get("incoming")).toBeUndefined();
    expect(await gamesRepo.get("existing")).toBeDefined();
    const page = await gamesRepo.search({});
    expect(page.total).toBe(1);
  });
});

describe("useAnalyzeGame", () => {
  const sampleEvals: MoveEval[] = [
    {
      ply: 1,
      san: "e4",
      scoreCpBefore: 20,
      scoreCpAfter: 30,
      cpLoss: 0,
      classification: "best",
      bestMove: "e2e4",
      bestLine: ["e2e4", "e7e5"],
    },
  ];

  beforeEach(() => {
    analyzeGame.mockReset();
  });

  /** Mount the hook with the QueryClientProvider `useMutation` needs. */
  function renderAnalyzeHook() {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    return renderHook(() => useAnalyzeGame(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });
  }

  it("persists the returned analysis to the game's IndexedDB record and flips hasAnalysis", async () => {
    const game = makeGame("g1");
    await gamesRepo.put(game, {
      source: "manual",
      createdAt: 1,
      contentHash: "hash-analyze-1",
    });
    useAnalyzerStore.setState({ game });
    analyzeGame.mockResolvedValueOnce(sampleEvals);

    const { result } = renderAnalyzeHook();
    result.current.analyze();

    await waitFor(() => expect(analyzeGame).toHaveBeenCalledTimes(1));
    expect(analyzeGame).toHaveBeenCalledWith({ game });

    await waitFor(async () => {
      const stored = await gamesRepo.get("g1");
      expect(stored?.analysis).toEqual(sampleEvals);
    });
    const page = await gamesRepo.search({});
    expect(page.games.find((g) => g.id === "g1")?.hasAnalysis).toBe(true);

    // The in-memory store updates exactly as before, alongside the IDB write.
    expect(useAnalyzerStore.getState().analysis).toEqual(sampleEvals);
  });

  it("analyzing a game that was never imported does not throw and still updates the in-memory store", async () => {
    // A transient game (e.g. a PGN pasted straight into chat) that never went
    // through `gamesRepo.put` — there is no IndexedDB record to write onto.
    const game = makeGame("transient-1");
    useAnalyzerStore.setState({ game });
    analyzeGame.mockResolvedValueOnce(sampleEvals);

    const { result } = renderAnalyzeHook();
    result.current.analyze();

    await waitFor(() =>
      expect(useAnalyzerStore.getState().analysis).toEqual(sampleEvals),
    );
    // No record was created and no error surfaced (an "Analysis failed" toast
    // would mean `gamesRepo.setAnalysis` threw instead of no-oping).
    expect(await gamesRepo.get("transient-1")).toBeUndefined();
  });
});
