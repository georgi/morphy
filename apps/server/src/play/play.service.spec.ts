import { BadRequestException, NotFoundException } from "@nestjs/common";
import { firstValueFrom } from "rxjs";
import { filter, map, skip, take, toArray } from "rxjs/operators";
import type { EngineEval, PlayEvent } from "@chess/shared";
import { ChessService } from "../chess/chess.service";
import { CharacterRegistry } from "./character-registry.service";
import { PlayService } from "./play.service";

const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const stubEval = (fen: string, bestUci: string): EngineEval => ({
  fen,
  bestMove: bestUci,
  depth: 8,
  lines: [{ pv: [bestUci], scoreCp: 20, mate: null, rank: 1 }],
});

function makeService(overrides?: {
  analyze?: (fen: string) => Promise<EngineEval>;
}) {
  const chess = new ChessService();
  const engine = {
    analyze: jest.fn(async (fen: string) => {
      if (overrides?.analyze) return overrides.analyze(fen);
      // Reply to any position with its first legal move.
      const san = chess.legalMoves(fen)[0];
      const uci = chess.applySan(fen, san).move.uci;
      return stubEval(fen, uci);
    }),
  };
  const harness = {
    listModels: jest.fn(async () => []),
    listSessions: jest.fn(async () => []),
    getSessionMessages: jest.fn(async () => []),
    createSession: jest.fn(async () => ({
      id: "stub",
      prompt: jest.fn(async () => undefined),
      dispose: jest.fn(),
    })),
    resumeSession: jest.fn(),
  };
  const service = new PlayService(
    chess,
    engine as never,
    new CharacterRegistry(),
    harness as never,
  );
  return { service, engine, harness, chess };
}

/**
 * Collect the next `n` PlayEvents from a game's stream. The service now backs
 * streams with a ReplaySubject, so a fresh subscription replays everything
 * already emitted; track how many events each game id has already handed out
 * so repeated calls only observe genuinely new events.
 */
const consumedByGame = new Map<string, number>();
function nextEvents(service: PlayService, id: string, n: number) {
  const alreadyConsumed = consumedByGame.get(id) ?? 0;
  consumedByGame.set(id, alreadyConsumed + n);
  return firstValueFrom(
    service.getStream(id).pipe(
      map((m) => JSON.parse(m.data as string) as PlayEvent),
      skip(alreadyConsumed),
      take(n),
      toArray(),
    ),
  );
}

describe("PlayService", () => {
  it("creates a game with the chosen side and character", async () => {
    const { service } = makeService();
    const game = await service.createGame({ characterId: "hustler", side: "white" });
    expect(game.characterId).toBe("hustler");
    expect(game.side).toBe("white");
    expect(game.fen).toBe(START_FEN);
    expect(game.status).toBe("active");
    expect(service.getGame(game.id)).toEqual(game);
  });

  it("rejects unknown character and unknown game ids", async () => {
    const { service } = makeService();
    await expect(
      service.createGame({ characterId: "nope", side: "white" }),
    ).rejects.toThrow(NotFoundException);
    expect(() => service.getGame("missing")).toThrow(NotFoundException);
  });

  it("applies a legal user move and streams the AI reply", async () => {
    const { service } = makeService();
    const game = await service.createGame({ characterId: "hustler", side: "white" });
    const eventsP = nextEvents(service, game.id, 1);

    const updated = await service.userMove(game.id, "e4");
    expect(updated.moves).toHaveLength(1);
    expect(updated.moves[0].san).toBe("e4");

    const [aiMove] = await eventsP;
    expect(aiMove.type).toBe("ai_move");
    const after = service.getGame(game.id);
    expect(after.moves).toHaveLength(2);
    expect(after.moves[1].color).toBe("b");
  });

  it("accepts UCI input", async () => {
    const { service } = makeService();
    const game = await service.createGame({ characterId: "hustler", side: "white" });
    const updated = await service.userMove(game.id, "e2e4");
    expect(updated.moves[0].san).toBe("e4");
  });

  it("rejects illegal moves and out-of-turn moves", async () => {
    const { service } = makeService();
    const game = await service.createGame({ characterId: "hustler", side: "black" });
    // AI (white) moves first; user is black but it may still be white's turn.
    await expect(service.userMove(game.id, "Ke2")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("makes the first move when the user plays black", async () => {
    const { service } = makeService();
    const game = await service.createGame({ characterId: "hustler", side: "black" });
    const [aiMove] = await nextEvents(service, game.id, 1);
    expect(aiMove.type).toBe("ai_move");
    expect(service.getGame(game.id).moves[0].color).toBe("w");
  });

  it("replays the AI's first move even when the subscriber attaches after it fired", async () => {
    const { service } = makeService();
    const game = await service.createGame({ characterId: "hustler", side: "black" });
    // Give the AI's scheduled turn a full macrotask to run BEFORE we subscribe.
    await new Promise((r) => setImmediate(r));
    const [aiMove] = await nextEvents(service, game.id, 1);
    expect(aiMove.type).toBe("ai_move");
  });

  it("ends the game on checkmate delivered by the user", async () => {
    // Force the AI into fool's mate: it plays f3 then g4.
    const replies = ["f2f3", "g2g4"];
    const { service } = makeService({
      analyze: async (fen) => stubEval(fen, replies.shift()!),
    });
    const game = await service.createGame({ characterId: "hustler", side: "black" });
    await nextEvents(service, game.id, 1); // f3
    const gEventsP = nextEvents(service, game.id, 1); // g4
    await service.userMove(game.id, "e5");
    await gEventsP;
    const overP = nextEvents(service, game.id, 1); // game_over
    await service.userMove(game.id, "Qh4");
    const [over] = await overP;
    expect(over).toMatchObject({ type: "game_over", result: "0-1", reason: "checkmate" });
    expect(service.getGame(game.id).status).toBe("over");
  });

  it("handles resignation", async () => {
    const { service } = makeService();
    const game = await service.createGame({ characterId: "hustler", side: "white" });
    const resigned = await service.resign(game.id);
    expect(resigned).toMatchObject({
      status: "over", result: "0-1", endReason: "resignation",
    });
  });

  it("answers a draw offer via the stream (declines when clearly better)", async () => {
    const { service } = makeService({
      analyze: async (fen) => ({
        ...stubEval(fen, "e2e4"),
        lines: [{ pv: ["e2e4"], scoreCp: 400, mate: null, rank: 1 }],
      }),
    });
    const game = await service.createGame({ characterId: "hustler", side: "black" });
    await nextEvents(service, game.id, 1); // let the AI's first turn set lastEval (+400 = winning for white AI)
    const eventsP = nextEvents(service, game.id, 1);
    await service.offerDraw(game.id);
    const [resp] = await eventsP;
    expect(resp).toEqual({ type: "draw_response", accepted: false });
    expect(service.getGame(game.id).status).toBe("active");
  });
});

describe("PlayService robustness", () => {
  it("rejects invalid side values on createGame", async () => {
    const { service } = makeService();
    await expect(
      service.createGame({ characterId: "hustler", side: "purple" as never }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.createGame({ characterId: "hustler" } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects missing or blank chat text", async () => {
    const { service } = makeService();
    const game = await service.createGame({ characterId: "hustler", side: "white" });
    await expect(service.chat(game.id, "")).rejects.toThrow(BadRequestException);
    await expect(service.chat(game.id, "   ")).rejects.toThrow(BadRequestException);
    await expect(
      service.chat(game.id, undefined as never),
    ).rejects.toThrow(BadRequestException);
  });

  it("bails out of aiTurn when the game ends while analyze() is pending", async () => {
    let resolveAnalyze!: (v: EngineEval) => void;
    const gate = new Promise<EngineEval>((resolve) => {
      resolveAnalyze = resolve;
    });
    const { service } = makeService({ analyze: async () => gate });
    const game = await service.createGame({ characterId: "hustler", side: "white" });
    const eventsP = nextEvents(service, game.id, 1); // only game_over should arrive

    await service.userMove(game.id, "e4"); // schedules aiTurn -> awaits the hung analyze
    await new Promise((r) => setImmediate(r)); // let aiTurn actually start awaiting
    await service.resign(game.id); // ends the game while the AI is "thinking"

    resolveAnalyze(stubEval(game.fen, "e7e5")); // release the hung analyze
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const [event] = await eventsP;
    expect(event).toMatchObject({ type: "game_over", reason: "resignation" });
    const after = service.getGame(game.id);
    expect(after.moves).toHaveLength(1); // only e4 — no stray ai_move after game over
    expect(after.status).toBe("over");
  });

  it("revives a bricked game when aiTurn crashes and the user pokes it", async () => {
    let shouldFail = true;
    const { service } = makeService({
      analyze: async (fen) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("engine hiccup");
        }
        const chess = new ChessService();
        const san = chess.legalMoves(fen)[0];
        const uci = chess.applySan(fen, san).move.uci;
        return stubEval(fen, uci);
      },
    });
    const game = await service.createGame({ characterId: "hustler", side: "white" });
    const errorP = nextEvents(service, game.id, 1);
    await service.userMove(game.id, "e4"); // schedules aiTurn -> analyze throws
    const [errEvent] = await errorP;
    expect(errEvent.type).toBe("error");
    expect(service.getGame(game.id).moves).toHaveLength(1); // AI never moved
    expect(service.getGame(game.id).status).toBe("active");

    // The user's next call is rejected (not their turn) but revives the AI.
    const aiMoveP = nextEvents(service, game.id, 1);
    await expect(service.userMove(game.id, "d4")).rejects.toThrow(BadRequestException);
    const [aiMove] = await aiMoveP;
    expect(aiMove.type).toBe("ai_move");
    expect(service.getGame(game.id).moves).toHaveLength(2);
  });
});

describe("PlayService mover", () => {
  function moverHarness(reply: string) {
    let emit: ((e: { type: string; delta?: string }) => void) | null = null;
    const prompts: string[] = [];
    return {
      prompts,
      harness: {
        listModels: jest.fn(async () => []),
        listSessions: jest.fn(async () => []),
        getSessionMessages: jest.fn(async () => []),
        createSession: jest.fn(async (cfg: { emit: typeof emit }) => {
          emit = cfg.emit;
          return {
            id: "mover",
            prompt: jest.fn(async (text: string) => {
              prompts.push(text);
              emit!({ type: "text_delta", delta: reply });
            }),
            dispose: jest.fn(),
          };
        }),
        resumeSession: jest.fn(),
      },
    };
  }

  function makeMoverService(reply: string) {
    const chess = new ChessService();
    // Two candidate lines so the LLM has a real choice: best d2d4, second g1f3.
    const engine = {
      analyze: jest.fn(async (fen: string) => ({
        fen,
        bestMove: "d2d4",
        depth: 8,
        lines: [
          { pv: ["d2d4"], scoreCp: 30, mate: null, rank: 1 },
          { pv: ["g1f3"], scoreCp: 20, mate: null, rank: 2 },
        ],
      })),
    };
    const { harness, prompts } = moverHarness(reply);
    const service = new PlayService(
      chess, engine as never, new CharacterRegistry(), harness as never,
    );
    return { service, prompts };
  }

  it("plays the LLM's candidate pick and emits its comment as banter", async () => {
    const { service, prompts } = makeMoverService(
      '{"move":"g1f3","comment":"Knights before bishops, professor."}',
    );
    const game = await service.createGame({ characterId: "hustler", side: "black" });
    const [aiMove, banter] = await nextEvents(service, game.id, 2);
    expect(aiMove).toMatchObject({ type: "ai_move" });
    expect((aiMove as { move: { san: string } }).move.san).toBe("Nf3");
    expect(banter).toEqual({
      type: "banter",
      text: "Knights before bishops, professor.",
    });
    // The turn prompt offered both candidates.
    expect(prompts[0]).toContain("d2d4");
    expect(prompts[0]).toContain("g1f3");
  });

  it("falls back to engine best on garbage output", async () => {
    const { service } = makeMoverService("chess is life, no JSON for you");
    const game = await service.createGame({ characterId: "hustler", side: "black" });
    const [aiMove] = await nextEvents(service, game.id, 1);
    expect((aiMove as { move: { san: string } }).move.san).toBe("d4");
  });

  it("falls back to engine best when the pick is not a candidate", async () => {
    const { service } = makeMoverService('{"move":"a2a4"}');
    const game = await service.createGame({ characterId: "hustler", side: "black" });
    const [aiMove] = await nextEvents(service, game.id, 1);
    expect((aiMove as { move: { san: string } }).move.san).toBe("d4");
  });
});

describe("PlayService talker", () => {
  function talkerSetup() {
    const chess = new ChessService();
    const engine = {
      analyze: jest.fn(async (fen: string) => {
        const san = chess.legalMoves(fen)[0];
        const uci = chess.applySan(fen, san).move.uci;
        return {
          fen, bestMove: uci, depth: 8,
          lines: [{ pv: [uci], scoreCp: 20, mate: null, rank: 1 }],
        };
      }),
    };
    const created: Array<{ systemPrompt: string; prompts: string[] }> = [];
    const harness = {
      listModels: jest.fn(async () => []),
      listSessions: jest.fn(async () => []),
      getSessionMessages: jest.fn(async () => []),
      createSession: jest.fn(
        async (cfg: { systemPrompt: string; emit: (e: never) => void }) => {
          const record = { systemPrompt: cfg.systemPrompt, prompts: [] as string[] };
          created.push(record);
          let disposed = false;
          return {
            id: `s${created.length}`,
            prompt: jest.fn(async (text: string) => {
              if (disposed) throw new Error("session disposed");
              record.prompts.push(text);
              (cfg.emit as (e: { type: string; delta: string }) => void)({
                type: "text_delta",
                delta: "Ha! ",
              });
            }),
            dispose: jest.fn(() => {
              disposed = true;
            }),
          };
        },
      ),
      resumeSession: jest.fn(),
    };
    const service = new PlayService(
      chess, engine as never, new CharacterRegistry(), harness as never,
    );
    return { service, created };
  }

  it("streams a chat reply as chat_delta then chat_done", async () => {
    const { service, created } = talkerSetup();
    const game = await service.createGame({ characterId: "hustler", side: "white" });
    const eventsP = nextEvents(service, game.id, 2);
    await service.chat(game.id, "you nervous yet?");
    const [delta, done] = await eventsP;
    expect(delta).toEqual({ type: "chat_delta", delta: "Ha! " });
    expect(done).toEqual({ type: "chat_done" });
    const talker = created.find((c) => c.systemPrompt.includes("talking across the board"));
    expect(talker?.prompts[0]).toContain("you nervous yet?");
    expect(talker?.prompts[0]).toContain(game.fen);
  });

  it("keeps chat usable after game over (recreates the disposed talker)", async () => {
    const { service, created } = talkerSetup();
    const game = await service.createGame({ characterId: "hustler", side: "white" });
    const overP = nextEvents(service, game.id, 3); // game_over, chat_delta, chat_done
    await service.resign(game.id);
    await overP; // parting shot has streamed; disposal is chained after it
    await new Promise((r) => setImmediate(r)); // let the dispose chain settle

    const chatP = nextEvents(service, game.id, 2);
    await service.chat(game.id, "good game, rematch?");
    const [delta, done] = await chatP;
    expect(delta).toEqual({ type: "chat_delta", delta: "Ha! " });
    expect(done).toEqual({ type: "chat_done" });
    const lastTalker = created.at(-1);
    expect(lastTalker?.prompts.at(-1)).toContain("good game, rematch?");
  });

  it("sends a parting shot after game over", async () => {
    const { service, created } = talkerSetup();
    const game = await service.createGame({ characterId: "hustler", side: "white" });
    const eventsP = nextEvents(service, game.id, 3); // game_over, chat_delta, chat_done
    await service.resign(game.id);
    const [over, delta, done] = await eventsP;
    expect(over).toMatchObject({ type: "game_over", reason: "resignation" });
    expect(delta).toMatchObject({ type: "chat_delta" });
    expect(done).toEqual({ type: "chat_done" });
    const talker = created.find((c) => c.systemPrompt.includes("talking across the board"));
    expect(talker?.prompts.at(-1)).toContain("resignation");
  });
});
