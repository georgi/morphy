import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { MessageEvent } from "@nestjs/common";
import { Observable, ReplaySubject } from "rxjs";
import { map } from "rxjs/operators";
import { v4 as uuidv4 } from "uuid";
import type {
  CreatePlayGameRequest,
  Move,
  PlayEndReason,
  PlayEvent,
  PlayGame,
  PlayResult,
} from "@chess/shared";
import { ChessService } from "../chess/chess.service";
import { EngineService } from "../engine/engine.service";
import {
  AGENT_HARNESS,
  type AgentHarness,
  type AgentRunner,
} from "../agent/harness/agent-harness";
import { CharacterRegistry } from "./character-registry.service";
import type { CharacterConfig } from "./characters.data";
import { buildCandidates, type Candidate } from "./move-candidates";
import { cooldownPlies, detectMoment } from "./banter";
import type { EngineEval } from "@chess/shared";

const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
/** Character accepts a draw when its POV advantage is at most this. */
const DRAW_ACCEPT_MAX_CP = 50;
/** Model used for the mover and talker sessions. */
const PLAY_MODEL = "openrouter/free";

interface PlaySession {
  game: PlayGame;
  character: CharacterConfig;
  subject: ReplaySubject<PlayEvent>;
  mover: AgentRunner | null; // created lazily in Task 7
  talker: AgentRunner | null; // created lazily in Task 8
  moverOut: { text: string }; // mover emit sink
  talkQueue: Promise<void>; // serializes talker turns
  lastBanterPly: number;
  lastEval: import("@chess/shared").EngineEval | null; // analysis of the position after the user's PREVIOUS move
  thinking: boolean; // AI turn in flight
  rng: () => number;
}

@Injectable()
export class PlayService {
  private readonly logger = new Logger(PlayService.name);
  private readonly sessions = new Map<string, PlaySession>();

  constructor(
    private readonly chess: ChessService,
    private readonly engine: EngineService,
    private readonly registry: CharacterRegistry,
    @Inject(AGENT_HARNESS) private readonly harness: AgentHarness,
  ) {}

  async createGame(req: CreatePlayGameRequest): Promise<PlayGame> {
    const character = this.registry.get(req.characterId); // throws on unknown
    if (req.side !== "white" && req.side !== "black" && req.side !== "random") {
      throw new BadRequestException(`Invalid side "${String(req.side)}".`);
    }
    const rng = Math.random;
    const side =
      req.side === "random" ? (rng() < 0.5 ? "white" : "black") : req.side;
    const game: PlayGame = {
      id: uuidv4(),
      characterId: character.id,
      side,
      startFen: START_FEN,
      fen: START_FEN,
      moves: [],
      status: "active",
    };
    const session: PlaySession = {
      game,
      character,
      subject: new ReplaySubject<PlayEvent>(50),
      mover: null,
      talker: null,
      moverOut: { text: "" },
      talkQueue: Promise.resolve(),
      lastBanterPly: -99,
      lastEval: null,
      thinking: false,
      rng,
    };
    this.sessions.set(game.id, session);
    if (side === "black") this.scheduleAiTurn(session);
    return game;
  }

  getGame(id: string): PlayGame {
    return this.session(id).game;
  }

  getStream(id: string): Observable<MessageEvent> {
    return this.session(id)
      .subject.asObservable()
      .pipe(map((event): MessageEvent => ({ data: JSON.stringify(event) })));
  }

  async userMove(id: string, moveStr: string): Promise<PlayGame> {
    const session = this.session(id);
    const { game } = session;
    if (game.status !== "active")
      throw new BadRequestException("Game is over.");
    if (session.thinking)
      throw new BadRequestException("Waiting for the opponent's move.");
    const turn = game.fen.split(" ")[1]; // 'w' | 'b'
    if (turn !== game.side[0]) {
      // The AI is on turn but not thinking: a prior aiTurn must have crashed
      // before completing (engine hiccup), bricking the game. Revive it so
      // the user's poke gets the AI moving again, then still reject this call.
      this.scheduleAiTurn(session);
      throw new BadRequestException("Not your turn.");
    }

    let san = moveStr;
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(moveStr)) {
      const converted = this.chess.uciToSan(game.fen, moveStr);
      if (!converted)
        throw new BadRequestException(`Illegal move "${moveStr}".`);
      san = converted;
    }
    const userSan = this.applyMove(session, san); // throws BadRequest on illegal
    const status = this.chess.gameStatus(game.fen);
    if (status.over) {
      this.endGame(session, status.result, status.reason);
    } else {
      this.scheduleAiTurn(session, userSan);
    }
    return game;
  }

  async resign(id: string): Promise<PlayGame> {
    const session = this.session(id);
    if (session.game.status !== "active")
      throw new BadRequestException("Game is over.");
    this.endGame(
      session,
      session.game.side === "white" ? "0-1" : "1-0",
      "resignation",
    );
    return session.game;
  }

  async offerDraw(id: string): Promise<void> {
    const session = this.session(id);
    if (session.game.status !== "active")
      throw new BadRequestException("Game is over.");
    const evalNow =
      session.lastEval ??
      (await this.engine.analyze(session.game.fen, { depth: 8 }));
    const best = evalNow.lines[0];
    const whiteCp =
      best?.mate != null ? Math.sign(best.mate) * 100_000 : (best?.scoreCp ?? 0);
    const characterPov =
      session.game.side === "white" ? -whiteCp : whiteCp;
    const accepted = characterPov <= DRAW_ACCEPT_MAX_CP;
    session.subject.next({ type: "draw_response", accepted });
    if (accepted) this.endGame(session, "1/2-1/2", "agreement");
  }

  async chat(id: string, text: string): Promise<void> {
    if (typeof text !== "string" || !text.trim())
      throw new BadRequestException("Chat text is required.");
    const session = this.session(id);
    await this.talk(session, this.chatPrompt(session, text));
  }

  // ── internals ──────────────────────────────────────────────────────────

  private session(id: string): PlaySession {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException(`Unknown play game: ${id}`);
    return session;
  }

  /** Apply a SAN move to the session's game, appending a full Move. Returns the SAN. */
  private applyMove(session: PlaySession, san: string): string {
    const { game } = session;
    const applied = this.chess.applySan(game.fen, san); // BadRequest on illegal
    const ply = game.moves.length + 1;
    const move: Move = {
      ply,
      moveNumber: Math.ceil(ply / 2),
      ...applied.move,
    };
    game.moves.push(move);
    game.fen = applied.fen;
    return applied.move.san;
  }

  /**
   * Kick off the AI's turn on the next macrotask, after the current call
   * (createGame/userMove) has returned its synchronous snapshot and the
   * caller has had a chance to subscribe to the game's event stream. Without
   * this deferral, a fast-resolving engine can let `aiTurn` mutate session
   * state and emit its event before the caller observes either.
   */
  private scheduleAiTurn(session: PlaySession, userSan?: string): void {
    setImmediate(() => void this.aiTurn(session, userSan));
  }

  /**
   * The AI's turn. Task 6 version: engine best move only (no LLM). Task 7
   * replaces the selection with the mover session; Task 8 adds banter.
   */
  private async aiTurn(session: PlaySession, userSan?: string): Promise<void> {
    session.thinking = true;
    try {
      const { game, character } = session;
      const engineEval = await this.engine.analyze(game.fen, {
        depth: character.chess.searchDepth,
        multipv: character.chess.multiPv,
      });
      // The game may have ended (resign/draw-accept) while analyze() was in
      // flight. Bail before touching session/game state any further.
      if (session.game.status !== "active") return;
      const prevEval = session.lastEval; // BEFORE overwrite
      session.lastEval = engineEval;
      if (userSan) {
        const moment = detectMoment({
          prevBestCp: prevEval?.lines[0]?.scoreCp ?? null,
          currBestCp: engineEval.lines[0]?.scoreCp ?? null,
          aiHasMate: this.aiHasMate(engineEval, game),
          userSide: game.side === "white" ? "w" : "b",
          userSan,
        });
        const sincePly = game.moves.length - session.lastBanterPly;
        if (
          moment &&
          character.banter.triggers.includes(moment) &&
          sincePly >= cooldownPlies(character.banter.chattiness)
        ) {
          session.lastBanterPly = game.moves.length;
          void this.talk(session, this.momentPrompt(session, moment, userSan));
        }
      }

      const candidates = buildCandidates({
        engineEval,
        sideToMove: game.fen.split(" ")[1] as "w" | "b",
        evalWindowCp: character.chess.evalWindowCp,
        blunderRate: character.chess.blunderRate,
        legalSans: this.chess.legalMoves(game.fen),
        uciToSan: (uci) => this.chess.uciToSan(game.fen, uci),
        sanToUci: (san) => {
          try {
            return this.chess.applySan(game.fen, san).move.uci;
          } catch {
            return null;
          }
        },
        rng: session.rng,
      });

      const pick = await this.pickMove(session, candidates);
      // Same guard after the (potentially slow) LLM mover call.
      if (session.game.status !== "active") return;
      const chosen =
        candidates.find((c) => c.uci === pick?.move) ??
        candidates.find((c) => !c.offbeat) ??
        candidates[0];
      if (!chosen) throw new Error(`No playable move for ${game.fen}`);

      this.applyMove(session, chosen.san);
      const move = game.moves[game.moves.length - 1];
      session.subject.next({ type: "ai_move", move, fen: game.fen });
      if (pick?.move === chosen.uci && pick.comment?.trim()) {
        session.subject.next({ type: "banter", text: pick.comment.trim() });
      }

      const status = this.chess.gameStatus(game.fen);
      if (status.over) this.endGame(session, status.result, status.reason);
    } catch (err) {
      this.logger.error(`aiTurn failed: ${String(err)}`);
      session.subject.next({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      session.thinking = false;
    }
  }

  /** One structured mover turn. Returns null on any failure (caller falls back). */
  private async pickMove(
    session: PlaySession,
    candidates: Candidate[],
  ): Promise<{ move: string; comment?: string } | null> {
    try {
      if (!session.mover) {
        session.mover = await this.harness.createSession({
          systemPrompt: this.moverSystemPrompt(session.character),
          tools: [],
          model: PLAY_MODEL,
          emit: (e) => {
            if (e.type === "text_delta") session.moverOut.text += e.delta;
          },
        });
      }
      session.moverOut.text = "";
      await session.mover.prompt(this.moverTurnPrompt(session, candidates));
      const match = session.moverOut.text.match(/\{[\s\S]*\}/);
      if (!match) {
        this.logger.debug("mover returned no JSON, using engine best");
        return null;
      }
      const parsed = JSON.parse(match[0]) as { move?: unknown; comment?: unknown };
      if (typeof parsed.move !== "string") {
        this.logger.debug("mover JSON has no move string, using engine best");
        return null;
      }
      if (!candidates.some((c) => c.uci === parsed.move)) {
        this.logger.debug(
          `mover picked non-candidate "${parsed.move}", using engine best`,
        );
        return null;
      }
      return {
        move: parsed.move,
        comment: typeof parsed.comment === "string" ? parsed.comment : undefined,
      };
    } catch (err) {
      this.logger.debug(`mover failed, using engine best: ${String(err)}`);
      return null;
    }
  }

  private moverSystemPrompt(character: CharacterConfig): string {
    return (
      `${character.personaPrompt}\n\nStyle: ${character.chess.styleHints}\n\n` +
      `You are PLAYING a game. Each prompt gives the position and candidate moves. ` +
      `Reply with ONLY a JSON object {"move":"<uci from the candidate list>",` +
      `"comment":"<optional one-line in-character remark>"} — no other text, no ` +
      `code fences. Omit "comment" for routine moves.`
    );
  }

  private moverTurnPrompt(session: PlaySession, candidates: Candidate[]): string {
    const { game } = session;
    const aiColor = game.side === "white" ? "Black" : "White";
    const lines = candidates.map((c) =>
      c.offbeat
        ? `- ${c.uci} (${c.san}), eval unknown — offbeat, your call`
        : `- ${c.uci} (${c.san}), eval ${this.formatEval(c)}`,
    );
    return [
      `Position (FEN): ${game.fen}`,
      `You are playing ${aiColor}.`,
      `Recent moves: ${this.recentSans(game) || "(game start)"}`,
      `Candidate moves:`,
      ...lines,
      `Pick ONE move from the candidates that best fits your style.`,
    ].join("\n");
  }

  private formatEval(c: Candidate): string {
    if (c.mate !== null) return `mate in ${Math.abs(c.mate)}`;
    const cp = (c.scoreCp ?? 0) / 100;
    return `${cp >= 0 ? "+" : ""}${cp.toFixed(2)}`;
  }

  private recentSans(game: PlayGame): string {
    return game.moves
      .slice(-6)
      .map((m: Move) =>
        m.color === "w" ? `${m.moveNumber}.${m.san}` : `${m.moveNumber}...${m.san}`,
      )
      .join(" ");
  }

  private endGame(
    session: PlaySession,
    result: PlayResult,
    reason: PlayEndReason,
  ): void {
    session.game.status = "over";
    session.game.result = result;
    session.game.endReason = reason;
    session.subject.next({ type: "game_over", result, reason });
    void this.talk(session, this.partingShotPrompt(session));
    // Release the LLM runners once the parting shot (and anything queued
    // before it) has settled — no more turns are coming for a finished game.
    session.talkQueue = session.talkQueue.then(async () => {
      try {
        await session.mover?.dispose?.();
        await session.talker?.dispose?.();
      } catch (err) {
        this.logger.debug(`runner dispose failed: ${String(err)}`);
      }
    });
  }

  /** Serialized talker turn: chain onto talkQueue so turns never interleave. */
  private talk(session: PlaySession, prompt: string): Promise<void> {
    if (!prompt) return Promise.resolve();
    session.talkQueue = session.talkQueue.then(async () => {
      try {
        if (!session.talker) {
          session.talker = await this.harness.createSession({
            systemPrompt: this.talkerSystemPrompt(session.character),
            tools: [],
            model: PLAY_MODEL,
            emit: (e) => {
              if (e.type === "text_delta")
                session.subject.next({ type: "chat_delta", delta: e.delta });
            },
          });
        }
        await session.talker.prompt(prompt);
        session.subject.next({ type: "chat_done" });
      } catch (err) {
        session.subject.next({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
    return session.talkQueue;
  }

  private talkerSystemPrompt(character: CharacterConfig): string {
    return (
      `${character.personaPrompt}\n\n` +
      `You are playing a live game against the user and talking across the board. ` +
      `You will receive game events and user messages with position context. ` +
      `Respond in character, 1-3 short sentences. Never reveal the engine's ` +
      `evaluation or suggest moves for the user's current position.`
    );
  }

  private aiHasMate(engineEval: EngineEval, _game: PlayGame): boolean {
    const mate = engineEval.lines[0]?.mate;
    // analyze() ran on a position where the AI is to move; mate > 0 = side to move mates.
    return mate !== null && mate !== undefined && mate > 0;
  }

  private momentPrompt(
    session: PlaySession,
    moment: string,
    userSan: string,
  ): string {
    const { game } = session;
    return (
      `Game event: the user just played ${userSan}. Assessment: ${moment}. ` +
      `Position (FEN): ${game.fen}. Recent moves: ${this.recentSans(game)}. ` +
      `React in character in one or two short sentences.`
    );
  }

  private chatPrompt(session: PlaySession, text: string): string {
    const { game } = session;
    const turn = game.fen.split(" ")[1] === game.side[0] ? "the user" : "you";
    return (
      `Position (FEN): ${game.fen}. Recent moves: ${
        this.recentSans(game) || "(game start)"
      }. It is ${turn} to move.\n\nThe user says: ${text}`
    );
  }

  private partingShotPrompt(session: PlaySession): string {
    const { game } = session;
    if (!game.result || !game.endReason) return "";
    const characterIsWhite = game.side === "black";
    const outcome =
      game.result === "1/2-1/2"
        ? "a draw"
        : (game.result === "1-0") === characterIsWhite
          ? "you won"
          : "you lost";
    return (
      `The game just ended: ${game.result} by ${game.endReason} — ${outcome}, ` +
      `from your perspective. Final position (FEN): ${game.fen}. ` +
      `Give your in-character parting line (1-2 sentences).`
    );
  }
}
