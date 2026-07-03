import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Game, EngineEval, MoveEval, ImportEvent } from "@chess/shared";
import {
  useAnalyzerStore,
  useImportStore,
  useLibraryStore,
  DEFAULT_LIBRARY_QUERY,
  currentFen,
  currentNode,
  currentMainlinePly,
  START_FEN,
} from "@/store";
import { emptyTree } from "@/lib/moveTree";

/** A tiny two-move game (1. e4 e5) used across the store tests. */
function makeGame(): Game {
  const fenAfterE4 =
    "rnbqkbnr/pppppppp/8/4P3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  const fenAfterE5 =
    "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  return {
    id: "game-1",
    headers: { white: "Alice", black: "Bob", result: "1-0" },
    startFen: START_FEN,
    moves: [
      {
        ply: 1,
        moveNumber: 1,
        color: "w",
        san: "e4",
        uci: "e2e4",
        fenBefore: START_FEN,
        fenAfter: fenAfterE4,
      },
      {
        ply: 2,
        moveNumber: 1,
        color: "b",
        san: "e5",
        uci: "e7e5",
        fenBefore: fenAfterE4,
        fenAfter: fenAfterE5,
      },
    ],
  };
}

function evalAt(cp: number): EngineEval {
  return {
    fen: "x",
    bestMove: "e2e4",
    depth: 12,
    lines: [{ pv: ["e2e4"], scoreCp: cp, mate: null, rank: 1 }],
  };
}

/** Reset the singleton store before each test for isolation. */
beforeEach(() => {
  const t = emptyTree(START_FEN);
  useAnalyzerStore.setState({
    game: null,
    nodesById: t.nodesById,
    rootId: t.rootId,
    currentNodeId: t.rootId,
    orientation: "white",
    evalByPly: {},
    arrowEvalByFen: {},
    analysis: null,
    chat: [],
    streaming: false,
    model: undefined,
    currentSessionId: undefined,
    resumeId: undefined,
    agentFen: null,
  });
});

describe("currentFen selector", () => {
  it("returns the standard start position with no game loaded", () => {
    expect(currentFen(useAnalyzerStore.getState())).toBe(START_FEN);
  });

  it("returns the game start FEN at ply 0 and the move FEN after each ply", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);

    expect(currentFen(useAnalyzerStore.getState())).toBe(game.startFen);

    useAnalyzerStore.getState().gotoPly(1);
    expect(currentFen(useAnalyzerStore.getState())).toBe(
      game.moves[0].fenAfter,
    );

    useAnalyzerStore.getState().gotoPly(2);
    expect(currentFen(useAnalyzerStore.getState())).toBe(
      game.moves[1].fenAfter,
    );
  });

  it("prefers an agent-pushed FEN when one is set", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);
    const offGameFen = "8/8/8/8/8/8/8/k6K w - - 0 1";
    useAnalyzerStore.getState().setBoardFromAgent(offGameFen);
    expect(currentFen(useAnalyzerStore.getState())).toBe(offGameFen);
  });
});

describe("navigation", () => {
  it("clamps ply within the move range", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);

    useAnalyzerStore.getState().gotoPly(99);
    expect(currentMainlinePly(useAnalyzerStore.getState())).toBe(2);

    useAnalyzerStore.getState().gotoPly(-5);
    expect(currentMainlinePly(useAnalyzerStore.getState())).toBe(0);
  });

  it("next/prev step one ply and never escape the range", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);

    useAnalyzerStore.getState().prevPly();
    expect(currentMainlinePly(useAnalyzerStore.getState())).toBe(0);

    useAnalyzerStore.getState().nextPly();
    useAnalyzerStore.getState().nextPly();
    expect(currentMainlinePly(useAnalyzerStore.getState())).toBe(2);

    useAnalyzerStore.getState().nextPly();
    expect(currentMainlinePly(useAnalyzerStore.getState())).toBe(2);
  });

  it("flip toggles orientation", () => {
    expect(useAnalyzerStore.getState().orientation).toBe("white");
    useAnalyzerStore.getState().flip();
    expect(useAnalyzerStore.getState().orientation).toBe("black");
    useAnalyzerStore.getState().flip();
    expect(useAnalyzerStore.getState().orientation).toBe("white");
  });
});

describe("move tree", () => {
  it("setGame builds the tree and parks the cursor at the root", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);
    const s = useAnalyzerStore.getState();
    expect(s.currentNodeId).toBe(s.rootId);
    expect(currentFen(s)).toBe(game.startFen);
    expect(currentNode(s).mainline).toBe(true);
  });

  it("playMove at the root opens a variation and moves the cursor onto it", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);
    // 1. d4 instead of the mainline 1. e4.
    const ok = useAnalyzerStore.getState().playMove({ from: "d2", to: "d4" });
    expect(ok).toBe(true);
    const s = useAnalyzerStore.getState();
    expect(currentNode(s).move?.san).toBe("d4");
    expect(currentNode(s).mainline).toBe(false);
    expect(currentFen(s)).toBe(currentNode(s).fen);
    // In the variation the branch-point ply is 0 (root).
    expect(currentMainlinePly(s)).toBe(0);
  });

  it("replaying the existing move navigates without duplicating", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);
    const before = Object.keys(useAnalyzerStore.getState().nodesById).length;
    const ok = useAnalyzerStore.getState().playMove({ from: "e2", to: "e4" });
    expect(ok).toBe(true);
    const s = useAnalyzerStore.getState();
    expect(Object.keys(s.nodesById)).toHaveLength(before);
    expect(currentNode(s).move?.san).toBe("e4");
    expect(currentMainlinePly(s)).toBe(1);
  });

  it("illegal playMove is a no-op and returns false", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);
    const before = useAnalyzerStore.getState().currentNodeId;
    const ok = useAnalyzerStore.getState().playMove({ from: "e2", to: "e5" });
    expect(ok).toBe(false);
    expect(useAnalyzerStore.getState().currentNodeId).toBe(before);
  });

  it("gotoNode moves the cursor and clears agentFen", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);
    const s0 = useAnalyzerStore.getState();
    const firstId = s0.nodesById[s0.rootId].children[0];
    useAnalyzerStore.setState({ agentFen: "junk" });
    useAnalyzerStore.getState().gotoNode(firstId);
    const s = useAnalyzerStore.getState();
    expect(s.currentNodeId).toBe(firstId);
    expect(s.agentFen).toBeNull();
    expect(currentMainlinePly(s)).toBe(1);
  });

  it("currentMainlinePly is the real ply on the mainline", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);
    useAnalyzerStore.getState().gotoPly(2);
    expect(currentMainlinePly(useAnalyzerStore.getState())).toBe(2);
  });
});

describe("setGame", () => {
  it("resets ply/eval/agentFen and adopts cached analysis", () => {
    const analysis: MoveEval[] = [
      {
        ply: 1,
        san: "e4",
        scoreCpBefore: 20,
        scoreCpAfter: 30,
        cpLoss: 0,
        classification: "best",
        bestMove: "e2e4",
        bestLine: ["e2e4"],
      },
    ];
    const game = { ...makeGame(), analysis };

    // dirty the store first
    useAnalyzerStore.setState({
      agentFen: "junk",
      evalByPly: { 1: evalAt(10) },
      arrowEvalByFen: { abc: evalAt(10) },
    });

    useAnalyzerStore.getState().setGame(game);
    const s = useAnalyzerStore.getState();
    expect(currentMainlinePly(s)).toBe(0);
    expect(s.agentFen).toBeNull();
    expect(s.evalByPly).toEqual({});
    expect(s.arrowEvalByFen).toEqual({});
    expect(s.analysis).toEqual(analysis);
  });
});

describe("best-move arrows state", () => {
  it("stores arrow evals keyed by FEN", () => {
    const fen = "8/8/8/8/8/8/8/k6K w - - 0 1";
    useAnalyzerStore.getState().setArrowEval(fen, evalAt(42));
    expect(
      useAnalyzerStore.getState().arrowEvalByFen[fen].lines[0].scoreCp,
    ).toBe(42);
  });

  it("setArrowEval merges without dropping prior entries", () => {
    const a = "fen-a";
    const b = "fen-b";
    useAnalyzerStore.getState().setArrowEval(a, evalAt(1));
    useAnalyzerStore.getState().setArrowEval(b, evalAt(2));
    expect(Object.keys(useAnalyzerStore.getState().arrowEvalByFen)).toEqual([
      a,
      b,
    ]);
  });

  describe("toggleArrows", () => {
    let store: Record<string, string>;

    beforeEach(() => {
      store = {};
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
        removeItem: (k: string) => {
          delete store[k];
        },
        clear: () => {
          store = {};
        },
      });
      // Start from a known enabled state regardless of hydration.
      useAnalyzerStore.setState({ arrowsEnabled: true });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("flips arrowsEnabled and persists the new value", () => {
      useAnalyzerStore.getState().toggleArrows();
      expect(useAnalyzerStore.getState().arrowsEnabled).toBe(false);
      expect(store["chess:arrowsEnabled"]).toBe("false");

      useAnalyzerStore.getState().toggleArrows();
      expect(useAnalyzerStore.getState().arrowsEnabled).toBe(true);
      expect(store["chess:arrowsEnabled"]).toBe("true");
    });
  });
});

describe("eval cache + setBoardFromAgent ply path", () => {
  it("stores per-ply evals", () => {
    useAnalyzerStore.getState().setEvalForPly(2, evalAt(55));
    expect(useAnalyzerStore.getState().evalByPly[2].lines[0].scoreCp).toBe(55);
  });

  it("with an explicit ply, navigates and clears any agentFen", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);
    useAnalyzerStore.getState().setBoardFromAgent("ignored", 1);
    const s = useAnalyzerStore.getState();
    expect(currentMainlinePly(s)).toBe(1);
    expect(s.agentFen).toBeNull();
    expect(currentFen(s)).toBe(game.moves[0].fenAfter);
  });
});

describe("chat / streaming reducers", () => {
  it("appends a user message", () => {
    useAnalyzerStore.getState().appendUserMessage("what went wrong?");
    const chat = useAnalyzerStore.getState().chat;
    expect(chat).toHaveLength(1);
    expect(chat[0]).toMatchObject({ role: "user", text: "what went wrong?" });
  });

  it("streams an assistant message with deltas and tool events", () => {
    const store = useAnalyzerStore.getState();
    store.startAssistantMessage();
    expect(useAnalyzerStore.getState().streaming).toBe(true);

    store.appendAssistantDelta("Around ");
    store.appendAssistantDelta("move 14 ");
    store.addToolEvent("analyze_position", true);
    store.appendAssistantDelta("you blundered.");

    const last = useAnalyzerStore.getState().chat.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.text).toBe("Around move 14 you blundered.");
    expect(last.tools).toEqual([{ tool: "analyze_position", ok: true }]);

    store.endAssistantMessage();
    expect(useAnalyzerStore.getState().streaming).toBe(false);
  });

  it("delta with no assistant message in flight is a no-op", () => {
    useAnalyzerStore.getState().appendAssistantDelta("orphan");
    expect(useAnalyzerStore.getState().chat).toHaveLength(0);
  });
});

describe("import job progress", () => {
  beforeEach(() => {
    useImportStore.setState({ job: null });
  });

  it("startJob opens a running job with zeroed progress", () => {
    useImportStore.getState().startJob("job-1", "lichess");
    const { job } = useImportStore.getState();
    expect(job).toMatchObject({
      jobId: "job-1",
      source: "lichess",
      status: "running",
      progress: { imported: 0, skipped: 0, failed: 0 },
    });
  });

  it("folds progress events into the running counts (incl. total)", () => {
    useImportStore.getState().startJob("job-1", "chesscom");
    const progress: ImportEvent = {
      type: "progress",
      imported: 3,
      skipped: 1,
      failed: 0,
      total: 10,
    };
    useImportStore.getState().applyEvent(progress);
    expect(useImportStore.getState().job?.progress).toEqual({
      imported: 3,
      skipped: 1,
      failed: 0,
      total: 10,
    });
  });

  it("a done event finalizes status, counts, and collectionId", () => {
    useImportStore.getState().startJob("job-1", "catalog");
    useImportStore.getState().applyEvent({
      type: "progress",
      imported: 4,
      skipped: 0,
      failed: 1,
      total: 5,
    });
    useImportStore.getState().applyEvent({
      type: "done",
      imported: 5,
      skipped: 0,
      failed: 1,
      collectionId: "c-9",
    });
    const { job } = useImportStore.getState();
    expect(job?.status).toBe("done");
    expect(job?.collectionId).toBe("c-9");
    expect(job?.progress).toEqual({
      imported: 5,
      skipped: 0,
      failed: 1,
      total: 5, // carried over from the last progress event
    });
  });

  it("an error event marks the job failed with a message", () => {
    useImportStore.getState().startJob("job-1", "lichess");
    useImportStore.getState().applyEvent({
      type: "error",
      message: "404: study not found",
    });
    const { job } = useImportStore.getState();
    expect(job?.status).toBe("error");
    expect(job?.error).toBe("404: study not found");
  });

  it("game events do not disturb the running counts", () => {
    useImportStore.getState().startJob("job-1", "url");
    useImportStore.getState().applyEvent({
      type: "progress",
      imported: 2,
      skipped: 0,
      failed: 0,
    });
    useImportStore.getState().applyEvent({
      type: "game",
      summary: {
        id: "g1",
        plyCount: 10,
        source: "url",
        hasAnalysis: false,
        createdAt: 1,
      },
    });
    expect(useImportStore.getState().job?.progress.imported).toBe(2);
  });

  it("applyEvent is a no-op when no job is active", () => {
    useImportStore.getState().applyEvent({
      type: "progress",
      imported: 9,
      skipped: 9,
      failed: 9,
    });
    expect(useImportStore.getState().job).toBeNull();
  });

  it("clearJob resets to no active job", () => {
    useImportStore.getState().startJob("job-1", "url");
    useImportStore.getState().clearJob();
    expect(useImportStore.getState().job).toBeNull();
  });
});

describe("library query (setQuery)", () => {
  beforeEach(() => {
    useLibraryStore.setState({ query: { ...DEFAULT_LIBRARY_QUERY } });
  });

  it("applies a pagination offset (Next/Prev actually move pages)", () => {
    const { setQuery } = useLibraryStore.getState();
    setQuery({ offset: 25 });
    expect(useLibraryStore.getState().query.offset).toBe(25);
    setQuery({ offset: 50 });
    expect(useLibraryStore.getState().query.offset).toBe(50);
    setQuery({ offset: 25 });
    expect(useLibraryStore.getState().query.offset).toBe(25);
  });

  it("resets the offset to 0 when a filter changes", () => {
    useLibraryStore.getState().setQuery({ offset: 50 });
    useLibraryStore.getState().setQuery({ q: "carlsen" });
    expect(useLibraryStore.getState().query.offset).toBe(0);
    expect(useLibraryStore.getState().query.q).toBe("carlsen");
  });

  it("resets the offset to 0 when the sort changes", () => {
    useLibraryStore.getState().setQuery({ offset: 50 });
    useLibraryStore.getState().setQuery({ sort: "white", dir: "asc" });
    expect(useLibraryStore.getState().query.offset).toBe(0);
  });

  it("setCollection switches collection and returns to the first page", () => {
    useLibraryStore.getState().setQuery({ offset: 50 });
    useLibraryStore.getState().setCollection("col-1");
    const { query } = useLibraryStore.getState();
    expect(query.collectionId).toBe("col-1");
    expect(query.offset).toBe(0);
  });
});
