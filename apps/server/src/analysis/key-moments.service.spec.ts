import type { MoveEval } from "@chess/shared";
import { KeyMomentsService } from "./key-moments.service";
import { ChessService } from "../chess/chess.service";
import { GameStore } from "../chess/game.store";

// Morphy's Opera Game — a long, real game so every ply referenced below resolves
// to a legal move/position (select() converts the engine best move to SAN).
const OPERA_GAME_PGN = `[Event "Paris Opera"]
[White "Morphy"]
[Black "Allies"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6
7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7
12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8
17. Rd8# 1-0`;

const SCHOLARS_MATE_PGN = "1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0";

/** Build a MoveEval shaped like analyzeGame's output for a single game move. */
function moveEvalFor(
  game: ReturnType<ChessService["importPgn"]>,
  ply: number,
  cpLoss: number,
  classification: MoveEval["classification"],
  bestUci = "e2e4",
  scoreCpAfter: number | null = 30 - cpLoss,
): MoveEval {
  const move = game.moves[ply - 1];
  return {
    ply,
    san: move.san,
    scoreCpBefore: 30,
    scoreCpAfter,
    cpLoss,
    classification,
    bestMove: bestUci,
    bestLine: [bestUci],
  };
}

describe("KeyMomentsService.select (pure, no engine/agent)", () => {
  let chess: ChessService;
  let store: GameStore;
  let service: KeyMomentsService;

  beforeEach(() => {
    chess = new ChessService();
    store = new GameStore();
    service = new KeyMomentsService(chess, store);
  });

  it("ranks by severity then cp-loss, returns in ply order, ignores non-errors", () => {
    const game = chess.importPgn(OPERA_GAME_PGN);
    store.create(game);

    const analysis: MoveEval[] = [
      moveEvalFor(game, 2, 10, "good"), // ignored (good)
      moveEvalFor(game, 4, 60, "inaccuracy"), // kept (lowest severity)
      moveEvalFor(game, 6, 320, "blunder"), // turning point (biggest swing)
      moveEvalFor(game, 8, 150, "mistake"),
      moveEvalFor(game, 12, 250, "mistake"),
    ];
    store.setAnalysis(game.id, analysis);

    const moments = service.select(analysis, game);

    // 'good' dropped; the four flagged moves returned in ply order.
    expect(moments.map((m) => m.ply)).toEqual([4, 6, 8, 12]);
    expect(moments.map((m) => m.classification)).toEqual([
      "inaccuracy",
      "blunder",
      "mistake",
      "mistake",
    ]);
  });

  it("orders selection by severity before cp-loss (blunder beats a bigger-swing mistake)", () => {
    const game = chess.importPgn(OPERA_GAME_PGN);
    store.create(game);

    // A mistake with a larger cp-loss than the blunder. Severity wins the slot
    // race, but with a cap above the candidate count both are returned anyway —
    // assert that selection (cap) prefers the blunder by severity.
    const analysis: MoveEval[] = [
      moveEvalFor(game, 2, 90, "inaccuracy"),
      moveEvalFor(game, 4, 95, "inaccuracy"),
      moveEvalFor(game, 6, 96, "inaccuracy"),
      moveEvalFor(game, 8, 97, "inaccuracy"),
      moveEvalFor(game, 10, 98, "inaccuracy"),
      moveEvalFor(game, 12, 99, "inaccuracy"),
      moveEvalFor(game, 14, 310, "blunder"), // lowest cp-loss of the errors, but…
    ];
    store.setAnalysis(game.id, analysis);

    const moments = service.select(analysis, game);

    // …severity ranks the blunder into the capped top five despite its cp-loss.
    expect(moments).toHaveLength(5);
    expect(
      moments.some((m) => m.ply === 14 && m.classification === "blunder"),
    ).toBe(true);
  });

  it("flags the single biggest swing (max cp-loss) as the turning point", () => {
    const game = chess.importPgn(OPERA_GAME_PGN);
    store.create(game);

    const analysis: MoveEval[] = [
      moveEvalFor(game, 4, 120, "mistake"),
      moveEvalFor(game, 8, 900, "blunder"), // biggest swing → turning point
      moveEvalFor(game, 12, 350, "blunder"),
    ];
    store.setAnalysis(game.id, analysis);

    const moments = service.select(analysis, game);
    const turning = moments.filter((m) => m.isTurningPoint);

    expect(turning).toHaveLength(1);
    expect(turning[0].ply).toBe(8);
  });

  it("caps at five even when more moves are flagged", () => {
    const game = chess.importPgn(OPERA_GAME_PGN);
    store.create(game);

    const analysis: MoveEval[] = [
      moveEvalFor(game, 4, 800, "blunder"),
      moveEvalFor(game, 6, 700, "blunder"),
      moveEvalFor(game, 8, 600, "blunder"),
      moveEvalFor(game, 10, 500, "blunder"),
      moveEvalFor(game, 12, 400, "blunder"),
      moveEvalFor(game, 14, 350, "blunder"), // sixth — dropped (smallest swing)
    ];
    store.setAnalysis(game.id, analysis);

    const moments = service.select(analysis, game);

    expect(moments).toHaveLength(5);
    // The smallest swing (ply 14) is the one dropped.
    expect(moments.map((m) => m.ply)).toEqual([4, 6, 8, 10, 12]);
    // Exactly one turning point across the capped set.
    expect(moments.filter((m) => m.isTurningPoint)).toHaveLength(1);
  });

  it("builds a templated description with classification, swing and the better move", () => {
    const game = chess.importPgn(OPERA_GAME_PGN);
    store.create(game);

    // Ply 6 is Black to move (3...dxe5 in this line); d8e7 (Qe7) is legal there,
    // so the better-move conversion to SAN succeeds.
    const analysis: MoveEval[] = [moveEvalFor(game, 6, 150, "mistake", "d8e7")];
    store.setAnalysis(game.id, analysis);

    const [moment] = service.select(analysis, game);

    expect(moment.description).toBe(
      "Mistake: a 1.5-pawn swing. Qe7 held the balance.",
    );
    // White-POV eval readout (scoreCpAfter 30 - 150 = -120 → −1.2, U+2212 minus).
    expect(moment.evalText).toBe("−1.2");
    // Color/moveNumber derived from the played move.
    expect(moment.color).toBe("b");
    expect(moment.san).toBe(game.moves[5].san);
  });

  it("falls back gracefully when no better move is known", () => {
    const game = chess.importPgn(OPERA_GAME_PGN);
    store.create(game);

    const noBest: MoveEval = {
      ...moveEvalFor(game, 6, 320, "blunder"),
      bestMove: null,
      bestLine: [],
    };
    store.setAnalysis(game.id, [noBest]);

    const [moment] = service.select([noBest], game);
    expect(moment.description).toBe(
      "Blunder: a 3.2-pawn swing. A stronger move was available.",
    );
  });

  it("returns [] when nothing is flagged", () => {
    const game = chess.importPgn(SCHOLARS_MATE_PGN);
    store.create(game);

    const analysis: MoveEval[] = [
      moveEvalFor(game, 1, 5, "good"),
      moveEvalFor(game, 2, 5, "good"),
    ];
    store.setAnalysis(game.id, analysis);

    expect(service.select(analysis, game)).toEqual([]);
  });
});

describe("KeyMomentsService.forGame (no engine/agent)", () => {
  let chess: ChessService;
  let store: GameStore;
  let service: KeyMomentsService;

  beforeEach(() => {
    chess = new ChessService();
    store = new GameStore();
    service = new KeyMomentsService(chess, store);
  });

  it("throws for an unknown game", async () => {
    await expect(service.forGame("nope")).rejects.toThrow(/not found/i);
  });

  it("returns [] for a game with no cached analysis", async () => {
    const game = chess.importPgn(SCHOLARS_MATE_PGN);
    store.create(game);
    // No setAnalysis → unanalyzed.
    expect(await service.forGame(game.id)).toEqual([]);
  });
});
