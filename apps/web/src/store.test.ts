import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Collection,
  Game,
  EngineEval,
  ImportSource,
  MoveEval,
  ImportEvent,
} from "@chess/shared";
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
import { gamesRepo } from "@/lib/db/games-repo";
import { collectionsRepo } from "@/lib/db/collections-repo";
import { resetLibraryDbForTests } from "@/lib/db/library-db";

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

  describe("rehydrating a previously-analyzed game from IndexedDB", () => {
    beforeEach(() => {
      resetLibraryDbForTests();
    });

    it("opening a game after gamesRepo.setAnalysis restores its analysis into the store", async () => {
      const analysis: MoveEval[] = [
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
      const game = makeGame();
      await gamesRepo.put(game, {
        source: "manual",
        createdAt: 1,
        contentHash: "hash-rehydrate-1",
      });
      // Games start with no analysis attached.
      expect((await gamesRepo.get(game.id))?.analysis).toBeUndefined();

      await gamesRepo.setAnalysis(game.id, analysis);

      // This is the library-open path: `gamesRepo.get(id)` -> `setGame(game)`.
      const reopened = await gamesRepo.get(game.id);
      expect(reopened?.analysis).toEqual(analysis);

      useAnalyzerStore.getState().setGame(reopened!);
      expect(useAnalyzerStore.getState().analysis).toEqual(analysis);
    });
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

describe("model selection", () => {
  it("setModel selects the model and starts a fresh chat", () => {
    useAnalyzerStore.getState().appendUserMessage("stale turn");
    useAnalyzerStore.setState({ resumeId: "sdk-1", currentSessionId: "sdk-1" });
    const before = useAnalyzerStore.getState().sessionId;

    useAnalyzerStore.getState().setModel("gpt-5.4");

    const s = useAnalyzerStore.getState();
    expect(s.model).toBe("gpt-5.4");
    expect(s.chat).toEqual([]);
    expect(s.resumeId).toBeUndefined();
    expect(s.currentSessionId).toBeUndefined();
    // A new connection id re-keys the ChatPanel effect → the stream reopens.
    expect(s.sessionId).not.toBe(before);
  });

  it("newChat clears the transcript but keeps the selected model", () => {
    useAnalyzerStore.getState().setModel("gpt-5.4");
    useAnalyzerStore.getState().appendUserMessage("hi");
    const before = useAnalyzerStore.getState().sessionId;

    useAnalyzerStore.getState().newChat();

    const s = useAnalyzerStore.getState();
    expect(s.model).toBe("gpt-5.4");
    expect(s.chat).toEqual([]);
    expect(s.sessionId).not.toBe(before);
  });
});

describe("import job progress", () => {
  /** A `game` event carrying a game with the given id + a content hash. */
  function gameEvent(id: string, contentHash: string): ImportEvent {
    return { type: "game", game: { ...makeGame(), id }, contentHash };
  }

  /** A `collection` event for a streamed collection. */
  function collectionEvent(
    id: string,
    source: ImportSource = "lichess",
  ): ImportEvent {
    const collection: Collection = {
      id,
      name: `Collection ${id}`,
      source,
      gameCount: 0,
      createdAt: Date.now(),
    };
    return { type: "collection", collection };
  }

  beforeEach(() => {
    resetLibraryDbForTests();
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

  it("a progress event adopts failed/total but leaves client counts alone", async () => {
    useImportStore.getState().startJob("job-1", "chesscom");
    // The server no longer knows imported/skipped (the client dedups); those
    // fields on a progress frame are ignored — only failed/total are adopted.
    await useImportStore.getState().applyEvent({
      type: "progress",
      imported: 99,
      skipped: 99,
      failed: 2,
      total: 10,
    });
    expect(useImportStore.getState().job?.progress).toEqual({
      imported: 0,
      skipped: 0,
      failed: 2,
      total: 10,
    });
  });

  it("a game event writes to IndexedDB and increments imported", async () => {
    useImportStore.getState().startJob("job-1", "url");
    await useImportStore.getState().applyEvent(gameEvent("g1", "hash-1"));

    expect(useImportStore.getState().job?.progress.imported).toBe(1);
    expect(await gamesRepo.existsByHash("hash-1")).toBe(true);
    // A bare URL import with no collection stores provenance `'manual'`.
    const stored = await gamesRepo.get("g1");
    expect(stored).toBeDefined();
    const page = await gamesRepo.search({});
    expect(page.games[0].source).toBe("manual");
  });

  it("a duplicate contentHash increments skipped and does not double-write", async () => {
    useImportStore.getState().startJob("job-1", "url");
    await useImportStore.getState().applyEvent(gameEvent("g1", "dup"));
    // A second, different game id but the SAME content hash is a dedup skip.
    await useImportStore.getState().applyEvent(gameEvent("g2", "dup"));

    expect(useImportStore.getState().job?.progress).toMatchObject({
      imported: 1,
      skipped: 1,
    });
    expect(await gamesRepo.get("g1")).toBeDefined();
    expect(await gamesRepo.get("g2")).toBeUndefined();
  });

  it("assigns strictly increasing createdAt to games in one batch", async () => {
    useImportStore.getState().startJob("job-1", "url");
    await useImportStore.getState().applyEvent(gameEvent("g1", "h1"));
    await useImportStore.getState().applyEvent(gameEvent("g2", "h2"));
    await useImportStore.getState().applyEvent(gameEvent("g3", "h3"));

    // Each game gets a distinct, strictly increasing createdAt (not one shared
    // Date.now()), so newest-first ordering within a batch is deterministic.
    const page = await gamesRepo.search({ sort: "createdAt", dir: "asc" });
    const createdAts = page.games.map((g) => g.createdAt);
    expect(createdAts).toHaveLength(3);
    expect(createdAts[0]).toBeLessThan(createdAts[1]);
    expect(createdAts[1]).toBeLessThan(createdAts[2]);
    // Ascending createdAt == arrival order.
    expect(page.games.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
  });

  it("a collection event creates the collection and links later games", async () => {
    useImportStore.getState().startJob("job-1", "lichess");
    await useImportStore.getState().applyEvent(collectionEvent("col-1"));
    await useImportStore.getState().applyEvent(gameEvent("g1", "h1"));

    expect(useImportStore.getState().job?.collectionId).toBe("col-1");
    expect(await collectionsRepo.get("col-1")).toBeDefined();
    const page = await gamesRepo.search({ collectionId: "col-1" });
    expect(page.total).toBe(1);
    expect(page.games[0].source).toBe("lichess");
  });

  it("done recounts a non-empty collection and finalizes the job", async () => {
    useImportStore.getState().startJob("job-1", "lichess");
    await useImportStore.getState().applyEvent(collectionEvent("col-1"));
    await useImportStore.getState().applyEvent(gameEvent("g1", "h1"));
    await useImportStore.getState().applyEvent({
      type: "done",
      imported: 1,
      skipped: 0,
      failed: 0,
      collectionId: "col-1",
    });

    const { job } = useImportStore.getState();
    expect(job?.status).toBe("done");
    expect(job?.collectionId).toBe("col-1");
    const collection = await collectionsRepo.get("col-1");
    expect(collection?.gameCount).toBe(1);
  });

  it("done drops an up-front collection that ended empty", async () => {
    useImportStore.getState().startJob("job-1", "lichess");
    await useImportStore.getState().applyEvent(collectionEvent("col-1"));
    // No games streamed before done.
    await useImportStore.getState().applyEvent({
      type: "done",
      imported: 0,
      skipped: 0,
      failed: 0,
      collectionId: "col-1",
    });

    const { job } = useImportStore.getState();
    expect(job?.status).toBe("done");
    expect(job?.collectionId).toBeUndefined();
    expect(await collectionsRepo.get("col-1")).toBeUndefined();
  });

  it("an error event marks the job failed and drops an orphaned collection", async () => {
    useImportStore.getState().startJob("job-1", "lichess");
    await useImportStore.getState().applyEvent(collectionEvent("col-1"));
    await useImportStore.getState().applyEvent({
      type: "error",
      message: "404: study not found",
    });
    const { job } = useImportStore.getState();
    expect(job?.status).toBe("error");
    expect(job?.error).toBe("404: study not found");
    expect(job?.collectionId).toBeUndefined();
    expect(await collectionsRepo.get("col-1")).toBeUndefined();
  });

  it("applyEvent is a no-op when no job is active", async () => {
    await useImportStore.getState().applyEvent({
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

describe("import write queue (serialization + failure surfacing)", () => {
  /** A `game` event carrying a game with the given id + a content hash. */
  function gameEvent(id: string, contentHash: string): ImportEvent {
    return { type: "game", game: { ...makeGame(), id }, contentHash };
  }

  beforeEach(() => {
    resetLibraryDbForTests();
    useImportStore.setState({ job: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes overlapping applyEvent calls so writes land in arrival order", async () => {
    useImportStore.getState().startJob("job-1", "url");
    const { applyEvent } = useImportStore.getState();

    // Fire back-to-back WITHOUT awaiting each call — only the store's internal
    // queue chaining should keep the IDB writes (and counts) in arrival order.
    void applyEvent(gameEvent("g1", "h1"));
    void applyEvent(gameEvent("g2", "h2"));
    const tail = applyEvent(gameEvent("g3", "h3"));
    await tail;

    const page = await gamesRepo.search({ sort: "createdAt", dir: "asc" });
    expect(page.games.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
    const createdAts = page.games.map((g) => g.createdAt);
    expect(createdAts[0]).toBeLessThan(createdAts[1]);
    expect(createdAts[1]).toBeLessThan(createdAts[2]);

    expect(useImportStore.getState().job?.progress).toMatchObject({
      imported: 3,
      skipped: 0,
      failed: 0,
    });
  });

  it("a failed write is counted as failed and does not poison the queue for the next frame", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const putSpy = vi
      .spyOn(gamesRepo, "put")
      .mockRejectedValueOnce(new Error("write boom"));

    useImportStore.getState().startJob("job-1", "url");
    const { applyEvent } = useImportStore.getState();

    // The bad frame's write rejects; a following good frame is fired back-to-back
    // (no await between them) so this also exercises queue serialization.
    void applyEvent(gameEvent("bad", "hash-bad"));
    const tail = applyEvent(gameEvent("good", "hash-good"));
    await tail;

    expect(putSpy).toHaveBeenCalledTimes(2);
    // The bad frame must not silently vanish — it's counted as failed, not lost
    // from all three counts.
    expect(useImportStore.getState().job?.progress).toMatchObject({
      imported: 1,
      skipped: 0,
      failed: 1,
    });
    expect(await gamesRepo.get("bad")).toBeUndefined();
    // The chain must not be poisoned — the following good frame still writes.
    expect(await gamesRepo.get("good")).toBeDefined();
  });

  it('done still flips status to "done" when collection bookkeeping throws', async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(collectionsRepo, "recountGames").mockRejectedValueOnce(
      new Error("recount boom"),
    );

    useImportStore.getState().startJob("job-1", "lichess");
    const collection: Collection = {
      id: "col-1",
      name: "Collection col-1",
      source: "lichess",
      gameCount: 0,
      createdAt: Date.now(),
    };
    await useImportStore
      .getState()
      .applyEvent({ type: "collection", collection });
    await useImportStore.getState().applyEvent(gameEvent("g1", "h1"));
    // Bookkeeping (recountGames) throws, but the terminal status flip must
    // still happen — otherwise job.status stays stuck on "running" while the
    // caller (which awaits this frame) goes on to report success.
    await useImportStore.getState().applyEvent({
      type: "done",
      imported: 1,
      skipped: 0,
      failed: 0,
      collectionId: "col-1",
    });

    expect(useImportStore.getState().job?.status).toBe("done");
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
