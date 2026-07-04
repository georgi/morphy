import { Inject, Injectable, Logger } from "@nestjs/common";
import { Observable, Subject } from "rxjs";
import { map } from "rxjs/operators";
import type { MessageEvent } from "@nestjs/common";
import type {
  AgentEvent,
  AgentMessageRequest,
  Game,
  ModelInfo,
  SessionSummary,
  TranscriptMessage,
} from "@chess/shared";
import { ChessService } from "../chess/chess.service";
import {
  ChessToolsService,
  type ToolSessionContext,
} from "./chess-tools.service";
import {
  AGENT_HARNESS,
  type AgentHarness,
  type AgentRunner,
} from "./harness/agent-harness";
import type { AgentTool } from "./harness/agent-tool";
import { MODEL_FILTER, type ModelFilter } from "./model-filter";

/** Options threaded from the SSE query string into session creation. */
interface StreamOptions {
  /** Chosen model id; undefined uses the backend default. */
  model?: string;
  /** SDK-native session id to resume instead of creating a fresh session. */
  resume?: string;
}

/** Per-chat-session state held in memory for the lifetime of the process. */
interface SessionState {
  /** The live agent runner (backend-neutral handle to the SDK session). */
  runner: AgentRunner;
  /** Fan-out channel: every translated AgentEvent is pushed here and streamed via SSE. */
  subject: Subject<AgentEvent>;
  /**
   * The session's current game (by value) and the ply the user is viewing. Mutated
   * IN PLACE on each posted message and by `load_pgn`/`load_fen` (via the tool
   * context's `setGame`), so the tools' `getContext()` closure always sees the
   * latest game.
   */
  context: { game?: Game; ply?: number };
  /**
   * The session's tools, bound once to `subject`/`context`. Held so a rate-limit
   * fallback can spawn a replacement runner (on a different model) against the same
   * tools without rebuilding them.
   */
  tools: AgentTool[];
  /** The model the live runner is running (`undefined` = harness default). */
  model?: string;
}

/**
 * How many models a single turn will try before giving up on rate limits. A small
 * bound: the fallback is a safety net for a transient 429 on an otherwise-healthy
 * model, not a cure for a broadly throttled free tier (each attempt is a serial
 * round-trip, so a large cap just adds latency before the friendly error).
 */
const MAX_MODEL_ATTEMPTS = 4;

/** How many recent moves to include in the prompt context when a game is active. */
const RECENT_MOVES_IN_CONTEXT = 6;

/**
 * The model used when the client makes no explicit choice: OpenRouter's "Free Models
 * Router", which routes each request to an available free model. Always available
 * (no single free model to be rate-limited), so a fresh chat is never dead on arrival.
 */
const DEFAULT_MODEL = "openrouter/free";

/**
 * Whether a failed turn's error is an upstream rate limit (HTTP 429 or a provider
 * "rate-limited" message) — the case a model fallback can recover from.
 */
function isRateLimited(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b429\b/.test(message) || /rate.?limit/i.test(message);
}

const SYSTEM_PROMPT = `You are a chess coach embedded in an analysis app. You are concise and never chatty.

Do NOT greet the user, restate their request, or present menus of options. When the user asks to review their game, find their mistakes, see where they went wrong, or be coached, immediately begin an interactive, move-by-move review using the coaching tools — do not first summarize or list anything.

Interactive review loop:
1. Call start_review to find the key turning points. It moves the board to the position BEFORE the first mistake and puts the UI in quiz mode.
2. In ONE short message (2-4 sentences) set the scene: whose move it is, the situation and rough evaluation, and that the move actually played here lost ground. Then ask the user to find a better move. Do NOT reveal the better move, and do NOT call score_guess yet. Stop and wait for the user's answer.
3. When the user replies with a move (they may play it on the board or type it in SAN), call score_guess with their move. If they say they don't know or give up, call score_guess with no move to reveal the answer.
4. React in 2-4 sentences: if their move was good, confirm it and say in one line why it works; if not, teach — name the best move, the key idea behind it, and briefly why their move falls short. The board and the best-move arrow are shown for you.
5. Call next_turning_point and repeat from step 2. When it reports done, give a one- or two-sentence wrap-up naming the main recurring theme, then stop.

Rules:
- Never dump a list of all the mistakes at once. Exactly one turning point at a time, always waiting for the user between them.
- Keep every message short and concrete. Use real move names and engine evaluations from the tools. Be encouraging but honest.
- If no game is loaded, ask the user to import one. If start_review finds no significant mistakes, say the game was cleanly played.
- You also have analyze_position, evaluate_move, explain_variation, analyze_game, get_position, list_legal_moves, material_balance, identify_opening, goto_move, load_pgn and load_fen for follow-up questions outside the structured review.`;

/**
 * Manages agent chat sessions and bridges them to SSE.
 *
 * Each chat session has: an {@link AgentRunner} (a backend-neutral handle to the
 * harness session, with the chess tools bound to that session's stream), an RxJS
 * Subject the SSE endpoint reads from, and the user's current game/ply context.
 * The harness translates SDK events into the shared {@link AgentEvent} union and
 * pushes them onto the Subject; `done`/`error` stay app-level here.
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly sessions = new Map<string, SessionState>();
  /** Tracks in-flight session creation so concurrent calls share one creation. */
  private readonly creating = new Map<string, Promise<SessionState>>();
  /**
   * Subjects created by getStream before the agent session finishes initializing.
   * createSession reuses the one stored here so the SSE Observable attached by
   * getStream receives events from the very first turn.
   */
  private readonly pendingSubjects = new Map<string, Subject<AgentEvent>>();

  constructor(
    private readonly tools: ChessToolsService,
    private readonly chess: ChessService,
    @Inject(AGENT_HARNESS) private readonly harness: AgentHarness,
    @Inject(MODEL_FILTER) private readonly modelFilter: ModelFilter,
  ) {}

  /**
   * List the models the picker may offer: the active backend's models, narrowed by
   * the {@link ModelFilter} access policy (e.g. OpenRouter free tier in production).
   */
  async listModels(): Promise<ModelInfo[]> {
    return this.modelFilter.apply(await this.harness.listModels());
  }

  /** List the active backend's stored sessions, for the continue UI. */
  listSessions(): Promise<SessionSummary[]> {
    return this.harness.listSessions();
  }

  /** Replay a stored session's user/assistant text turns, for the continue UI. */
  getSessionMessages(id: string): Promise<TranscriptMessage[]> {
    return this.harness.getSessionMessages(id);
  }

  /**
   * SSE source for a chat session. Lazily creates the agent session (and its tools
   * bound to this session's Subject) on first access, then maps every AgentEvent
   * to the `{ data }` shape NestJS @Sse expects. `opts.model`/`opts.resume` thread
   * into session creation (only honored on the first, creating access).
   */
  getStream(sessionId: string, opts?: StreamOptions): Observable<MessageEvent> {
    const subject = this.ensureSubject(sessionId);
    // Kick off session creation eagerly so tools/prompt are ready by the time a
    // message is posted. Errors are surfaced onto the stream as an error event.
    void this.ensureSession(sessionId, opts).catch((err) => {
      subject.next({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    });
    return subject
      .asObservable()
      .pipe(map((event): MessageEvent => ({ data: JSON.stringify(event) })));
  }

  /**
   * Handle a posted user message: record the user's current game/ply context,
   * build a context-enriched prompt, and run it through the agent session. The
   * streamed answer, tool activity, and board updates flow out via the Subject
   * (see {@link getStream}). Resolves once the agent turn completes.
   */
  async sendMessage(
    sessionId: string,
    body: AgentMessageRequest,
  ): Promise<void> {
    const state = await this.ensureSession(sessionId);
    // Mutate in place: the tools' getContext() closure holds this same object, so
    // a fresh assignment would leave them pointing at the stale context.
    state.context.game = body.game;
    state.context.ply = body.ply;

    const prompt = this.buildPrompt(body);
    await this.runTurn(state, prompt);
  }

  /**
   * Run one turn, transparently falling back to another permitted model when the
   * chosen one is rate-limited upstream (common on OpenRouter's free tier). Each
   * fallback spawns a replacement runner on the next candidate model — which loses
   * the previous runner's in-memory history, an acceptable trade since the dominant
   * case is a first-turn 429 with nothing to lose. Non-rate-limit errors surface
   * immediately; exhausting the candidates surfaces a friendly, actionable error.
   */
  private async runTurn(state: SessionState, prompt: string): Promise<void> {
    const tried = new Set<string>();
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_MODEL_ATTEMPTS; attempt++) {
      try {
        // The harness resolves on turn completion and throws on a failed turn (the
        // backend's error surfacing lives behind the interface now).
        await state.runner.prompt(prompt);
        state.subject.next({ type: "done" });
        return;
      } catch (err) {
        lastError = err;
        if (state.model) tried.add(state.model);
        if (!isRateLimited(err)) break;

        const next = await this.nextCandidateModel(tried);
        if (!next) break;

        await state.runner.dispose?.();
        state.model = next;
        state.runner = await this.spawnRunner(state, next);
        state.subject.next({
          type: "notice",
          level: "warn",
          message: `The previous model was rate-limited; retrying with ${next}.`,
        });
      }
    }

    state.subject.next({
      type: "error",
      message: this.friendlyTurnError(lastError),
    });
  }

  /** The first permitted model not yet tried this turn, or `undefined` if none remain. */
  private async nextCandidateModel(
    tried: Set<string>,
  ): Promise<string | undefined> {
    const models = await this.listModels();
    return models.find((m) => !tried.has(m.id))?.id;
  }

  /** Spawn a replacement runner on `model`, reusing the session's subject and tools. */
  private spawnRunner(
    state: SessionState,
    model: string,
  ): Promise<AgentRunner> {
    return this.harness.createSession({
      systemPrompt: SYSTEM_PROMPT,
      tools: state.tools,
      emit: (event) => state.subject.next(event),
      model,
    });
  }

  /**
   * Turn a failed turn's error into user-facing text: a rate-limit exhaustion gets
   * an actionable message (all free models throttled — add a key or pick another);
   * anything else passes through as-is.
   */
  private friendlyTurnError(err: unknown): string {
    if (isRateLimited(err)) {
      return (
        "Every available model is rate-limited upstream right now. Try again in a " +
        "moment, pick a different model, or add your own provider key to raise your limits."
      );
    }
    return err instanceof Error ? err.message : String(err);
  }

  // ── session lifecycle ────────────────────────────────────────────────────

  /**
   * Return the Subject the SSE Observable should read from. Reuses the live
   * session's Subject if it exists, an in-flight pending one if creation is
   * already underway, or creates a fresh pending Subject that createSession will
   * adopt.
   */
  private ensureSubject(sessionId: string): Subject<AgentEvent> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing.subject;
    const pending = this.pendingSubjects.get(sessionId);
    if (pending) return pending;
    const subject = new Subject<AgentEvent>();
    this.pendingSubjects.set(sessionId, subject);
    return subject;
  }

  /** Get-or-create the session state, deduplicating concurrent creation. */
  private ensureSession(
    sessionId: string,
    opts?: StreamOptions,
  ): Promise<SessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing) return Promise.resolve(existing);
    const pending = this.creating.get(sessionId);
    if (pending) return pending;

    const creation = this.createSession(sessionId, opts)
      .then((state) => {
        this.sessions.set(sessionId, state);
        this.creating.delete(sessionId);
        return state;
      })
      .catch((err) => {
        this.creating.delete(sessionId);
        throw err;
      });
    this.creating.set(sessionId, creation);
    return creation;
  }

  /**
   * Build a fresh agent session for `sessionId`: a Subject (shared with any SSE
   * Observable already attached), the chess tools bound to that Subject, and a
   * harness runner restricted to those tools with the coaching system prompt.
   * Resumes an existing SDK-native session when `opts.resume` is set.
   */
  private async createSession(
    sessionId: string,
    opts?: StreamOptions,
  ): Promise<SessionState> {
    const subject =
      this.pendingSubjects.get(sessionId) ?? new Subject<AgentEvent>();
    this.pendingSubjects.delete(sessionId);

    const context: { game?: Game; ply?: number } = {};
    const toolCtx: ToolSessionContext = {
      emit: (event) => subject.next(event),
      getContext: () => context,
      // load_pgn/load_fen replace the session's current game in place.
      setGame: (game) => {
        context.game = game;
      },
    };

    const tools = await this.tools.buildToolsForSession(toolCtx);

    const model = await this.resolveModel(opts?.model);
    const cfg = {
      systemPrompt: SYSTEM_PROMPT,
      tools,
      emit: (event: AgentEvent) => subject.next(event),
      model,
    };
    const runner = opts?.resume
      ? await this.harness.resumeSession(opts.resume, cfg)
      : await this.harness.createSession(cfg);

    return { runner, subject, context, tools, model };
  }

  /**
   * Resolve the model a session is created with under the access policy. With no
   * explicit choice the default is {@link DEFAULT_MODEL} — OpenRouter's always-available
   * free-models router — rather than the harness default (whose first free model is
   * often rate-limited). When unrestricted the resolved id passes through. When
   * restricted, a permitted id is honored; a disallowed explicit id falls back to the
   * first permitted model. Throws when the policy permits nothing, surfaced onto the
   * stream as an `error` event by getStream.
   */
  private async resolveModel(requested?: string): Promise<string | undefined> {
    const wanted = requested ?? DEFAULT_MODEL;
    if (!this.modelFilter.restricted) return wanted;
    if (this.modelFilter.allows(wanted)) return wanted;
    const [fallback] = await this.listModels();
    if (!fallback) {
      throw new Error(
        "No permitted models are available (AGENT_MODEL_FILTER restricts the model list).",
      );
    }
    return fallback.id;
  }

  // ── prompt building ──────────────────────────────────────────────────────

  /**
   * Build the prompt sent to the agent: the user's text, plus the current game
   * context (FEN at the active ply and the last few moves) when a game is known,
   * so the agent can act without re-querying basic state.
   */
  private buildPrompt(body: AgentMessageRequest): string {
    const game = body.game;
    if (!game) return body.text;

    const ply = body.ply ?? game.moves.length;
    const fen = this.chess.positionAtPly(game, ply);
    const recent = this.recentMoves(game, ply);

    const contextLines = [
      "Current context (the user is viewing this position):",
      `- gameId: ${game.id}`,
      `- ply: ${ply} of ${game.moves.length}`,
      `- FEN: ${fen}`,
      recent ? `- recent moves: ${recent}` : null,
      game.headers.opening
        ? `- opening: ${[game.headers.eco, game.headers.opening].filter(Boolean).join(" ")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    return `${contextLines}\n\nUser: ${body.text}`;
  }

  /** A compact SAN trail of the moves leading up to `ply`, with move numbers. */
  private recentMoves(game: Game, ply: number): string {
    const upto = Math.max(0, Math.min(ply, game.moves.length));
    const slice = game.moves.slice(
      Math.max(0, upto - RECENT_MOVES_IN_CONTEXT),
      upto,
    );
    return slice
      .map((m) => {
        const num = m.color === "w" ? `${m.moveNumber}.` : `${m.moveNumber}...`;
        return `${num}${m.san}`;
      })
      .join(" ");
  }
}
