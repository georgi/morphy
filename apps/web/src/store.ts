// apps/web/src/store.ts — Zustand store. Feature components only CONSUME it.
import { create } from "zustand";
import type {
  Game,
  EngineEval,
  MoveEval,
  AgentEvent,
  LibraryQuery,
  ImportEvent,
} from "@chess/shared";

export const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export type Orientation = "white" | "black";

export interface ChatToolEvent {
  tool: string;
  ok?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: ChatToolEvent[];
}

/** The `coach_question`/`coach_reveal` event payloads, mirrored from the contract. */
export type CoachQuestion = Extract<AgentEvent, { type: "coach_question" }>;
export type CoachReveal = Extract<AgentEvent, { type: "coach_reveal" }>;

/**
 * Interactive-coach review state. The agent drives the loop server-side; this
 * slice tracks what the board + banner should show.
 * - `idle`     → no review in progress.
 * - `question` → waiting for the user to play a better move (`current` set).
 * - `reveal`   → the agent has scored the guess (`lastReveal` set).
 */
export interface CoachState {
  mode: "idle" | "question" | "reveal";
  current: CoachQuestion | null;
  lastReveal: CoachReveal | null;
}

/**
 * Library browse state. Drives the `/library` view's search/filter/sort/paginate
 * controls; the actual rows are fetched via TanStack Query keyed on this object.
 * `collectionId` doubles as the active item in the collections sidebar.
 */
export interface LibraryState {
  query: LibraryQuery;
  setQuery: (patch: Partial<LibraryQuery>) => void;
  setCollection: (collectionId: string | undefined) => void;
  resetFilters: () => void;
}

export const DEFAULT_LIBRARY_QUERY: LibraryQuery = {
  sort: "createdAt",
  dir: "desc",
  limit: 25,
  offset: 0,
};

/**
 * A patch to a filter (anything other than pagination/sort) should send the user
 * back to the first page; otherwise the offset can point past the new result set.
 */
function isPageResetKey(key: string): boolean {
  return key !== "offset";
}

export const useLibraryStore = create<LibraryState>((set) => ({
  query: { ...DEFAULT_LIBRARY_QUERY },
  setQuery: (patch) =>
    set((s) => {
      const resetsPage = Object.keys(patch).some(isPageResetKey);
      return {
        query: {
          ...s.query,
          ...patch,
          offset: resetsPage && patch.offset === undefined ? 0 : s.query.offset,
        },
      };
    }),
  setCollection: (collectionId) =>
    set((s) => ({
      query: { ...s.query, collectionId, offset: 0 },
    })),
  resetFilters: () => set({ query: { ...DEFAULT_LIBRARY_QUERY } }),
}));

/**
 * Live progress for a bulk-import job, accumulated from the import SSE stream.
 * `status` mirrors the wire lifecycle: `running` while progress events arrive,
 * `done`/`error` on the terminal frame. `null` job means no import is active.
 */
export interface ImportProgress {
  imported: number;
  skipped: number;
  failed: number;
  total?: number;
}

export interface ImportJobState {
  jobId: string;
  source: string;
  status: "running" | "done" | "error";
  progress: ImportProgress;
  collectionId?: string;
  error?: string;
}

const ZERO_PROGRESS: ImportProgress = { imported: 0, skipped: 0, failed: 0 };

/**
 * Tracks the single active import job and its accumulated progress. The download
 * dialog calls `startJob` on `POST /api/import`, then feeds each SSE
 * {@link ImportEvent} through `applyEvent`; `clearJob` resets between imports.
 */
export interface ImportState {
  job: ImportJobState | null;
  startJob: (jobId: string, source: string) => void;
  applyEvent: (event: ImportEvent) => void;
  clearJob: () => void;
}

export const useImportStore = create<ImportState>((set) => ({
  job: null,
  startJob: (jobId, source) =>
    set({
      job: {
        jobId,
        source,
        status: "running",
        progress: { ...ZERO_PROGRESS },
      },
    }),
  applyEvent: (event) =>
    set((s) => {
      if (!s.job) return s;
      switch (event.type) {
        case "progress":
          return {
            job: {
              ...s.job,
              progress: {
                imported: event.imported,
                skipped: event.skipped,
                failed: event.failed,
                total: event.total ?? s.job.progress.total,
              },
            },
          };
        case "done":
          return {
            job: {
              ...s.job,
              status: "done",
              collectionId: event.collectionId,
              progress: {
                imported: event.imported,
                skipped: event.skipped,
                failed: event.failed,
                total: s.job.progress.total,
              },
            },
          };
        case "error":
          return {
            job: { ...s.job, status: "error", error: event.message },
          };
        // `game` events carry a per-game summary; the running counts already
        // arrive via `progress`, so nothing to fold in here.
        default:
          return s;
      }
    }),
  clearJob: () => set({ job: null }),
}));

export interface AnalyzerState {
  game: Game | null;
  currentPly: number;
  orientation: Orientation;
  evalByPly: Record<number, EngineEval>;
  /**
   * Best-move-arrow evals keyed by FEN (any position, not just in-game plies).
   * Filled cache-first/live by the arrows hook; cleared on `setGame` to avoid
   * unbounded growth across games.
   */
  arrowEvalByFen: Record<string, EngineEval>;
  /** Whether best-move arrows are drawn. Persisted to localStorage. */
  arrowsEnabled: boolean;
  analysis: MoveEval[] | null;
  chat: ChatMessage[];
  streaming: boolean;
  sessionId: string;
  /**
   * A raw FEN pushed by the agent (e.g. an off-game variation). When set it
   * overrides the game+ply derivation in `currentFen`. Cleared on navigation
   * and when a new game is loaded.
   */
  agentFen: string | null;
  coach: CoachState;

  setGame: (game: Game) => void;
  gotoPly: (n: number) => void;
  nextPly: () => void;
  prevPly: () => void;
  flip: () => void;
  setEvalForPly: (ply: number, evaluation: EngineEval) => void;
  setArrowEval: (fen: string, evaluation: EngineEval) => void;
  toggleArrows: () => void;
  setAnalysis: (evals: MoveEval[]) => void;
  appendUserMessage: (text: string) => void;
  startAssistantMessage: () => void;
  appendAssistantDelta: (delta: string) => void;
  addToolEvent: (tool: string, ok?: boolean) => void;
  endAssistantMessage: () => void;
  setBoardFromAgent: (fen: string, ply?: number) => void;
  setCoachQuestion: (question: CoachQuestion) => void;
  setCoachReveal: (reveal: CoachReveal) => void;
  clearCoach: () => void;
}

const IDLE_COACH: CoachState = {
  mode: "idle",
  current: null,
  lastReveal: null,
};

/** localStorage key for the persisted best-move-arrows toggle. */
const ARROWS_ENABLED_KEY = "chess:arrowsEnabled";

/**
 * Read the persisted arrows toggle, defaulting to `true`. Guarded so jsdom/SSR
 * (no `window`/`localStorage`) and storage exceptions never break the store.
 */
function readArrowsEnabled(): boolean {
  try {
    if (typeof window === "undefined" || !window.localStorage) return true;
    return window.localStorage.getItem(ARROWS_ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Persist the arrows toggle; silently ignored where storage is unavailable. */
function writeArrowsEnabled(enabled: boolean): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(ARROWS_ENABLED_KEY, String(enabled));
  } catch {
    // Best-effort persistence; a failure here must not affect state.
  }
}

/** Clamp a target ply into the valid range for the active game. */
function clampPly(game: Game | null, n: number): number {
  if (!game) return 0;
  if (n < 0) return 0;
  if (n > game.moves.length) return game.moves.length;
  return n;
}

export const useAnalyzerStore = create<AnalyzerState>((set, get) => ({
  game: null,
  currentPly: 0,
  orientation: "white",
  evalByPly: {},
  arrowEvalByFen: {},
  arrowsEnabled: readArrowsEnabled(),
  analysis: null,
  chat: [],
  streaming: false,
  sessionId: crypto.randomUUID(),
  agentFen: null,
  coach: IDLE_COACH,

  setGame: (game) =>
    set({
      game,
      currentPly: 0,
      analysis: game.analysis ?? null,
      evalByPly: {},
      arrowEvalByFen: {},
      agentFen: null,
      // A fresh game ends any review in progress.
      coach: IDLE_COACH,
    }),

  gotoPly: (n) => set({ currentPly: clampPly(get().game, n), agentFen: null }),

  nextPly: () =>
    set({
      currentPly: clampPly(get().game, get().currentPly + 1),
      agentFen: null,
    }),

  prevPly: () =>
    set({
      currentPly: clampPly(get().game, get().currentPly - 1),
      agentFen: null,
    }),

  flip: () =>
    set((s) => ({
      orientation: s.orientation === "white" ? "black" : "white",
    })),

  setEvalForPly: (ply, evaluation) =>
    set((s) => ({ evalByPly: { ...s.evalByPly, [ply]: evaluation } })),

  setArrowEval: (fen, evaluation) =>
    set((s) => ({
      arrowEvalByFen: { ...s.arrowEvalByFen, [fen]: evaluation },
    })),

  toggleArrows: () =>
    set((s) => {
      const arrowsEnabled = !s.arrowsEnabled;
      writeArrowsEnabled(arrowsEnabled);
      return { arrowsEnabled };
    }),

  setAnalysis: (evals) => set({ analysis: evals }),

  appendUserMessage: (text) =>
    set((s) => ({
      chat: [
        ...s.chat,
        { id: crypto.randomUUID(), role: "user", text, tools: [] },
      ],
    })),

  startAssistantMessage: () =>
    set((s) => ({
      streaming: true,
      chat: [
        ...s.chat,
        { id: crypto.randomUUID(), role: "assistant", text: "", tools: [] },
      ],
    })),

  appendAssistantDelta: (delta) =>
    set((s) => {
      const chat = s.chat.slice();
      const last = chat[chat.length - 1];
      if (last && last.role === "assistant") {
        chat[chat.length - 1] = { ...last, text: last.text + delta };
      }
      return { chat };
    }),

  addToolEvent: (tool, ok) =>
    set((s) => {
      const chat = s.chat.slice();
      const last = chat[chat.length - 1];
      if (last && last.role === "assistant") {
        chat[chat.length - 1] = {
          ...last,
          tools: [...last.tools, { tool, ok }],
        };
      }
      return { chat };
    }),

  endAssistantMessage: () => set({ streaming: false }),

  setBoardFromAgent: (fen, ply) =>
    set((s) => ({
      currentPly: ply !== undefined ? clampPly(s.game, ply) : s.currentPly,
      // When the agent supplies a matching ply we let the board derive its FEN
      // from the game; otherwise we surface the raw agent FEN directly.
      agentFen: ply !== undefined ? null : fen,
    })),

  setCoachQuestion: (question) =>
    set({ coach: { mode: "question", current: question, lastReveal: null } }),

  setCoachReveal: (reveal) =>
    set((s) => ({
      coach: { mode: "reveal", current: s.coach.current, lastReveal: reveal },
    })),

  clearCoach: () => set({ coach: IDLE_COACH }),
}));

/**
 * Selector: the FEN to render for the current board state.
 * - An agent-pushed FEN (off-game variation) wins when present.
 * - No game loaded → standard start position.
 * - ply 0 → game's starting FEN.
 * - ply n → the FEN after the n-th move.
 */
export function currentFen(state: AnalyzerState): string {
  if (state.agentFen) return state.agentFen;
  const { game, currentPly } = state;
  if (!game) return START_FEN;
  if (currentPly > 0) return game.moves[currentPly - 1].fenAfter;
  return game.startFen;
}
