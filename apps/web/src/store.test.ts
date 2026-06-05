import { beforeEach, describe, expect, it } from "vitest";
import type { Game, EngineEval, MoveEval, ImportEvent } from "@chess/shared";
import {
  useAnalyzerStore,
  useImportStore,
  currentFen,
  START_FEN,
} from "@/store";

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
  useAnalyzerStore.setState({
    game: null,
    currentPly: 0,
    orientation: "white",
    evalByPly: {},
    analysis: null,
    chat: [],
    streaming: false,
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
    expect(currentFen(useAnalyzerStore.getState())).toBe(game.moves[0].fenAfter);

    useAnalyzerStore.getState().gotoPly(2);
    expect(currentFen(useAnalyzerStore.getState())).toBe(game.moves[1].fenAfter);
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
    expect(useAnalyzerStore.getState().currentPly).toBe(2);

    useAnalyzerStore.getState().gotoPly(-5);
    expect(useAnalyzerStore.getState().currentPly).toBe(0);
  });

  it("next/prev step one ply and never escape the range", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);

    useAnalyzerStore.getState().prevPly();
    expect(useAnalyzerStore.getState().currentPly).toBe(0);

    useAnalyzerStore.getState().nextPly();
    useAnalyzerStore.getState().nextPly();
    expect(useAnalyzerStore.getState().currentPly).toBe(2);

    useAnalyzerStore.getState().nextPly();
    expect(useAnalyzerStore.getState().currentPly).toBe(2);
  });

  it("flip toggles orientation", () => {
    expect(useAnalyzerStore.getState().orientation).toBe("white");
    useAnalyzerStore.getState().flip();
    expect(useAnalyzerStore.getState().orientation).toBe("black");
    useAnalyzerStore.getState().flip();
    expect(useAnalyzerStore.getState().orientation).toBe("white");
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
      currentPly: 5,
      agentFen: "junk",
      evalByPly: { 1: evalAt(10) },
    });

    useAnalyzerStore.getState().setGame(game);
    const s = useAnalyzerStore.getState();
    expect(s.currentPly).toBe(0);
    expect(s.agentFen).toBeNull();
    expect(s.evalByPly).toEqual({});
    expect(s.analysis).toEqual(analysis);
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
    expect(s.currentPly).toBe(1);
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
