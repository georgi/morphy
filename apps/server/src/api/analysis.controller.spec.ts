import { BadRequestException } from "@nestjs/common";
import type { Game, KeyMoment, MoveEval } from "@chess/shared";
import { AnalysisController } from "./analysis.controller";
import { AnalysisService } from "../analysis/analysis.service";
import { KeyMomentsService } from "../analysis/key-moments.service";

/** A minimal, valid two-ply `Game` for by-value request bodies. */
function fakeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: "g1",
    headers: { white: "A", black: "B" },
    startFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    moves: [
      {
        ply: 1,
        moveNumber: 1,
        color: "w",
        san: "e4",
        uci: "e2e4",
        fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
      },
    ],
    ...overrides,
  };
}

describe("AnalysisController", () => {
  let analysis: { analyzeGame: jest.Mock; analyzePosition: jest.Mock };
  let keyMoments: { forGame: jest.Mock };
  let controller: AnalysisController;

  beforeEach(() => {
    analysis = {
      analyzeGame: jest.fn(),
      analyzePosition: jest.fn(),
    };
    keyMoments = { forGame: jest.fn() };
    controller = new AnalysisController(
      analysis as unknown as AnalysisService,
      keyMoments as unknown as KeyMomentsService,
    );
  });

  describe("POST /analysis/game", () => {
    it("analyzeGame(game) returns the MoveEval[] the service produces off the engine", async () => {
      const game = fakeGame();
      const evals: MoveEval[] = [
        {
          ply: 1,
          san: "e4",
          scoreCpBefore: 0,
          scoreCpAfter: 20,
          cpLoss: 0,
          classification: "best",
          bestMove: "e2e4",
          bestLine: ["e2e4"],
        },
      ];
      analysis.analyzeGame.mockResolvedValue(evals);

      const result = await controller.analyzeGame({ game, depth: 10 });

      expect(analysis.analyzeGame).toHaveBeenCalledWith(game, 10);
      expect(result).toBe(evals);
      expect(result).toHaveLength(game.moves.length);
    });

    it("passes depth through as undefined when the client omits it", async () => {
      const game = fakeGame();
      analysis.analyzeGame.mockResolvedValue([]);

      await controller.analyzeGame({ game });

      expect(analysis.analyzeGame).toHaveBeenCalledWith(game, undefined);
    });

    it("rejects a missing game with 400 (not 404)", () => {
      expect(() => controller.analyzeGame({} as never)).toThrow(
        BadRequestException,
      );
      expect(analysis.analyzeGame).not.toHaveBeenCalled();
    });

    it("rejects an empty/malformed game with 400", () => {
      expect(() => controller.analyzeGame({ game: {} as Game })).toThrow(
        BadRequestException,
      );
      expect(analysis.analyzeGame).not.toHaveBeenCalled();
    });
  });

  describe("POST /analysis/key-moments", () => {
    it("keyMomentsForGame(game) delegates to KeyMomentsService.forGame", async () => {
      const game = fakeGame({ analysis: [] });
      const moments: KeyMoment[] = [];
      keyMoments.forGame.mockResolvedValue(moments);

      const result = await controller.keyMomentsForGame({ game });

      expect(keyMoments.forGame).toHaveBeenCalledWith(game);
      expect(result).toBe(moments);
    });

    it("rejects a missing game with 400 (not 404)", () => {
      expect(() => controller.keyMomentsForGame({} as never)).toThrow(
        BadRequestException,
      );
      expect(keyMoments.forGame).not.toHaveBeenCalled();
    });

    it("rejects an empty/malformed game with 400", () => {
      expect(() =>
        controller.keyMomentsForGame({ game: { headers: {} } as Game }),
      ).toThrow(BadRequestException);
      expect(keyMoments.forGame).not.toHaveBeenCalled();
    });
  });

  describe("POST /analysis/position (unchanged, already by-value)", () => {
    it("rejects a missing fen with 400", () => {
      expect(() => controller.analyzePosition({} as never)).toThrow(
        BadRequestException,
      );
    });
  });
});
