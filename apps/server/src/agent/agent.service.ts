import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { map } from 'rxjs/operators';
import type { MessageEvent } from '@nestjs/common';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { AgentEvent, AgentMessageRequest, Game } from '@chess/shared';
import { ChessService } from '../chess/chess.service';
import { GameStore } from '../chess/game.store';
import { ChessToolsService, type ToolSessionContext } from './chess-tools.service';
import { loadPiSdk } from './pi-loader';

/** Per-chat-session state held in memory for the lifetime of the process. */
interface SessionState {
  /** The live Pi agent session. */
  piSession: AgentSession;
  /** Fan-out channel: every translated AgentEvent is pushed here and streamed via SSE. */
  subject: Subject<AgentEvent>;
  /** The game/ply the user is currently viewing, updated on each posted message. */
  context: { gameId?: string; ply?: number };
}

/** How many recent moves to include in the prompt context when a game is active. */
const RECENT_MOVES_IN_CONTEXT = 6;

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
 * Manages Pi agent chat sessions and bridges them to SSE.
 *
 * Each chat session has: a Pi {@link AgentSession} (with the chess tools bound to
 * that session's stream), an RxJS Subject the SSE endpoint reads from, and the
 * user's current game/ply context. Pi session events are translated into the
 * shared {@link AgentEvent} union and pushed onto the Subject.
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly sessions = new Map<string, SessionState>();
  /** Tracks in-flight session creation so concurrent calls share one creation. */
  private readonly creating = new Map<string, Promise<SessionState>>();
  /**
   * Subjects created by getStream before the Pi session finishes initializing.
   * createSession reuses the one stored here so the SSE Observable attached by
   * getStream receives events from the very first turn.
   */
  private readonly pendingSubjects = new Map<string, Subject<AgentEvent>>();

  constructor(
    private readonly tools: ChessToolsService,
    private readonly chess: ChessService,
    private readonly store: GameStore,
  ) {}

  /**
   * SSE source for a chat session. Lazily creates the Pi session (and its tools
   * bound to this session's Subject) on first access, then maps every AgentEvent
   * to the `{ data }` shape NestJS @Sse expects.
   */
  getStream(sessionId: string): Observable<MessageEvent> {
    const subject = this.ensureSubject(sessionId);
    // Kick off session creation eagerly so tools/prompt are ready by the time a
    // message is posted. Errors are surfaced onto the stream as an error event.
    void this.ensureSession(sessionId).catch((err) => {
      subject.next({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    });
    return subject.asObservable().pipe(
      map((event): MessageEvent => ({ data: JSON.stringify(event) })),
    );
  }

  /**
   * Handle a posted user message: record the user's current game/ply context,
   * build a context-enriched prompt, and run it through the Pi session. The
   * streamed answer, tool activity, and board updates flow out via the Subject
   * (see {@link getStream}). Resolves once the agent turn completes.
   */
  async sendMessage(
    sessionId: string,
    body: AgentMessageRequest,
  ): Promise<void> {
    const state = await this.ensureSession(sessionId);
    state.context = { gameId: body.gameId, ply: body.ply };

    const prompt = this.buildPrompt(body);
    try {
      await state.piSession.prompt(prompt);
      // The turn resolved — signal completion. (Pi has no dedicated done event;
      // prompt() resolving is the turn-completion signal.)
      const errorMessage = state.piSession.state.errorMessage;
      if (errorMessage) {
        state.subject.next({ type: 'error', message: errorMessage });
      } else {
        state.subject.next({ type: 'done' });
      }
    } catch (err) {
      state.subject.next({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
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
  private ensureSession(sessionId: string): Promise<SessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing) return Promise.resolve(existing);
    const pending = this.creating.get(sessionId);
    if (pending) return pending;

    const creation = this.createSession(sessionId)
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
   * Build a fresh Pi session for `sessionId`: a Subject (shared with any SSE
   * Observable already attached), the chess tools bound to that Subject, and a
   * Pi session restricted to those custom tools with a coaching system prompt.
   */
  private async createSession(sessionId: string): Promise<SessionState> {
    const subject =
      this.pendingSubjects.get(sessionId) ?? new Subject<AgentEvent>();
    this.pendingSubjects.delete(sessionId);

    const context: { gameId?: string; ply?: number } = {};
    const toolCtx: ToolSessionContext = {
      emit: (event) => subject.next(event),
      getContext: () => context,
    };

    const { createAgentSession, SessionManager, DefaultResourceLoader, getAgentDir } =
      await loadPiSdk();

    const customTools = await this.tools.buildToolsForSession(toolCtx);

    // Replace the system prompt with our coaching prompt and suppress all
    // project-local discovery (extensions/skills/AGENTS.md): this is a server,
    // there is no codebase context to load.
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt: SYSTEM_PROMPT,
      appendSystemPrompt: [],
      systemPromptOverride: () => SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      // Only our chess tools — no filesystem/bash access.
      noTools: 'builtin',
      customTools,
      tools: customTools.map((tool) => tool.name),
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
    });

    const state: SessionState = { piSession: session, subject, context };
    this.subscribeToSession(state);
    return state;
  }

  /**
   * Translate Pi session events into the shared AgentEvent union and push them
   * onto the session's Subject. `board_update` events are emitted directly by the
   * tools (see ChessToolsService), so they are not produced here.
   */
  private subscribeToSession(state: SessionState): void {
    const { piSession, subject } = state;
    piSession.subscribe((event) => {
      switch (event.type) {
        case 'message_update': {
          const inner = event.assistantMessageEvent;
          if (inner.type === 'text_delta') {
            subject.next({ type: 'text_delta', delta: inner.delta });
          }
          break;
        }
        case 'tool_execution_start': {
          subject.next({
            type: 'tool_start',
            tool: event.toolName,
            args: event.args,
          });
          break;
        }
        case 'tool_execution_end': {
          subject.next({
            type: 'tool_end',
            tool: event.toolName,
            ok: !event.isError,
            summary: this.summarizeToolResult(event.result),
          });
          break;
        }
        default:
          break;
      }
    });
  }

  // ── prompt building ──────────────────────────────────────────────────────

  /**
   * Build the prompt sent to the agent: the user's text, plus the current game
   * context (FEN at the active ply and the last few moves) when a game is known,
   * so the agent can act without re-querying basic state.
   */
  private buildPrompt(body: AgentMessageRequest): string {
    const game = body.gameId ? this.store.get(body.gameId) : undefined;
    if (!game) return body.text;

    const ply = body.ply ?? game.moves.length;
    const fen = this.chess.positionAtPly(game, ply);
    const recent = this.recentMoves(game, ply);

    const contextLines = [
      'Current context (the user is viewing this position):',
      `- gameId: ${game.id}`,
      `- ply: ${ply} of ${game.moves.length}`,
      `- FEN: ${fen}`,
      recent ? `- recent moves: ${recent}` : null,
      game.headers.opening
        ? `- opening: ${[game.headers.eco, game.headers.opening].filter(Boolean).join(' ')}`
        : null,
    ]
      .filter(Boolean)
      .join('\n');

    return `${contextLines}\n\nUser: ${body.text}`;
  }

  /** A compact SAN trail of the moves leading up to `ply`, with move numbers. */
  private recentMoves(game: Game, ply: number): string {
    const upto = Math.max(0, Math.min(ply, game.moves.length));
    const slice = game.moves.slice(Math.max(0, upto - RECENT_MOVES_IN_CONTEXT), upto);
    return slice
      .map((m) => {
        const num = m.color === 'w' ? `${m.moveNumber}.` : `${m.moveNumber}...`;
        return `${num}${m.san}`;
      })
      .join(' ');
  }

  /** Best-effort one-line summary of a tool result for the activity trail. */
  private summarizeToolResult(result: unknown): string | undefined {
    if (!result || typeof result !== 'object') return undefined;
    const content = (result as { content?: unknown }).content;
    if (!Array.isArray(content)) return undefined;
    const first = content.find(
      (part): part is { type: 'text'; text: string } =>
        !!part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    );
    if (!first) return undefined;
    const text = first.text.trim();
    const firstLine = text.split('\n', 1)[0];
    return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
  }
}
