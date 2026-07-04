// apps/web/src/store.ts — Zustand store. Feature components only CONSUME it.
import { create } from "zustand";
import type {
  Game,
  EngineEval,
  MoveEval,
  AgentEvent,
  ImportSource,
  LibraryQuery,
  ImportEvent,
} from "@chess/shared";
import {
  type MoveNode,
  type MoveTree,
  type DropInput,
  buildTree,
  emptyTree,
  applyMove,
  mainlineNodeAtPly,
  nearestMainlinePly,
} from "@/lib/moveTree";
import { gamesRepo } from "@/lib/db/games-repo";
import { collectionsRepo } from "@/lib/db/collections-repo";
import * as api from "@/lib/api";

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
  /** Set when the turn failed: the error is rendered inline in the bubble. */
  error?: string;
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
  // Newest games first by game date — matches the import default of pulling the
  // most recent games first.
  sort: "date",
  dir: "desc",
  limit: 25,
  offset: 0,
};

/**
 * Any change other than the offset itself (a filter or sort) should send the user
 * back to the first page; otherwise the offset can point past the new result set.
 */
function isPageResetKey(key: string): boolean {
  return key !== "offset";
}

export const useLibraryStore = create<LibraryState>((set) => ({
  query: { ...DEFAULT_LIBRARY_QUERY },
  setQuery: (patch) =>
    set((s) => {
      const query = { ...s.query, ...patch };
      // A filter/sort change returns to page one. A pure pagination patch
      // ({ offset }) carries its own offset through the spread above — don't
      // clobber it back to the previous page.
      if (
        patch.offset === undefined &&
        Object.keys(patch).some(isPageResetKey)
      ) {
        query.offset = 0;
      }
      return { query };
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
 * Tracks the single active import job and its accumulated progress, AND owns the
 * client library writes for a bulk import. The download dialog calls `startJob`
 * on `POST /api/import`, then feeds each SSE {@link ImportEvent} through
 * `applyEvent`; `clearJob` resets between imports.
 *
 * The server now STREAMS games instead of persisting them, so `applyEvent` writes
 * into IndexedDB: a `collection` frame creates the collection, each `game` frame
 * is deduped by content hash and stored (or counted as skipped), and `done`
 * recounts (and drops an empty) collection. `imported`/`skipped` are computed
 * here from the client's own dedup; `failed`/`total` come from the server.
 */
export interface ImportState {
  job: ImportJobState | null;
  startJob: (jobId: string, source: string) => void;
  applyEvent: (event: ImportEvent) => Promise<void>;
  clearJob: () => void;
}

export const useImportStore = create<ImportState>((set, get) => {
  // Serialize the async IDB writes. SSE frames arrive in order, but each handler
  // now awaits IndexedDB — chaining them onto a single promise keeps writes (and
  // the counts) in arrival order rather than letting overlapping awaits reorder.
  let queue: Promise<void> = Promise.resolve();
  // A strictly-increasing timestamp so games in one batch get distinct, ordered
  // `createdAt`s. A shared Date.now() for the whole batch would make newest-first
  // library ordering non-deterministic within the batch. Seeded per job from the
  // wall clock, never regressing below the last value used.
  let createdAtSeq = Date.now();
  // Client-side IDB write failures this job (distinct from the server's own
  // parse-failure count). A `progress`/`done` frame sets `progress.failed` from
  // `event.failed`, which only knows about server-side failures — folding this
  // in there too keeps a write failure from being clobbered back to 0 by the
  // next frame instead of staying visible through to the terminal count.
  let writeFailures = 0;

  /** Fold one import event into the store + client library (runs serialized). */
  async function handle(event: ImportEvent): Promise<void> {
    const job = get().job;
    if (!job) return;
    switch (event.type) {
      case "collection": {
        await collectionsRepo.put(event.collection);
        set((s) =>
          s.job ? { job: { ...s.job, collectionId: event.collection.id } } : s,
        );
        return;
      }
      case "game": {
        if (await gamesRepo.existsByHash(event.contentHash)) {
          set((s) =>
            s.job
              ? {
                  job: {
                    ...s.job,
                    progress: {
                      ...s.job.progress,
                      skipped: s.job.progress.skipped + 1,
                    },
                  },
                }
              : s,
          );
          return;
        }
        const collectionId = job.collectionId;
        // A bare URL/paste with no collection is provenance `'manual'` (matching
        // the single-game import); grouped/remote imports carry the real source.
        const source: ImportSource =
          job.source === "url" && !collectionId
            ? "manual"
            : (job.source as ImportSource);
        try {
          await gamesRepo.put(event.game, {
            source,
            collectionId,
            createdAt: createdAtSeq++,
            contentHash: event.contentHash,
          });
        } catch (err) {
          // A failed write must not silently drop the game from every count —
          // surface it as a failure, same as a server-side parse failure.
          console.error("Failed to write imported game to the library", err);
          writeFailures += 1;
          set((s) =>
            s.job
              ? {
                  job: {
                    ...s.job,
                    progress: {
                      ...s.job.progress,
                      failed: s.job.progress.failed + 1,
                    },
                  },
                }
              : s,
          );
          return;
        }
        set((s) =>
          s.job
            ? {
                job: {
                  ...s.job,
                  progress: {
                    ...s.job.progress,
                    imported: s.job.progress.imported + 1,
                  },
                },
              }
            : s,
        );
        return;
      }
      case "progress": {
        set((s) =>
          s.job
            ? {
                job: {
                  ...s.job,
                  progress: {
                    ...s.job.progress,
                    failed: event.failed + writeFailures,
                    total: event.total ?? s.job.progress.total,
                  },
                },
              }
            : s,
        );
        return;
      }
      case "done": {
        let collectionId = job.collectionId;
        if (collectionId) {
          try {
            await collectionsRepo.recountGames(collectionId);
            const collection = await collectionsRepo.get(collectionId);
            // Nothing landed in the up-front collection → drop it (mirrors the
            // old server-side "nothing imported, delete the empty collection").
            if (collection && collection.gameCount === 0) {
              await collectionsRepo.delete(collectionId);
              collectionId = undefined;
            }
          } catch (err) {
            // The terminal status flip below must run regardless — a throw here
            // must not leave `job.status` stuck on "running" while the caller
            // (which awaits this frame) goes on to report success.
            console.error("Failed to finalize the import collection", err);
          }
        }
        set((s) =>
          s.job
            ? {
                job: {
                  ...s.job,
                  status: "done",
                  collectionId,
                  progress: {
                    ...s.job.progress,
                    failed: event.failed + writeFailures,
                  },
                },
              }
            : s,
        );
        return;
      }
      case "error": {
        const collectionId = job.collectionId;
        // The server only emits `error` before any game streamed, so an up-front
        // collection (written on the `collection` frame) is empty — drop it.
        if (collectionId) await collectionsRepo.delete(collectionId);
        set((s) =>
          s.job
            ? {
                job: {
                  ...s.job,
                  status: "error",
                  collectionId: undefined,
                  error: event.message,
                },
              }
            : s,
        );
        return;
      }
    }
  }

  return {
    job: null,
    startJob: (jobId, source) => {
      createdAtSeq = Math.max(createdAtSeq, Date.now());
      writeFailures = 0;
      set({
        job: {
          jobId,
          source,
          status: "running",
          progress: { ...ZERO_PROGRESS },
        },
      });
    },
    // Enqueue behind any in-flight event so writes stay ordered. Returns the tail
    // so callers (and tests) can await this event's completion; failures are
    // logged, not propagated, so one bad frame can't wedge the queue.
    applyEvent: (event) => {
      const next = queue
        .then(() => handle(event))
        .catch((err) => {
          console.error("Failed to apply import event", err);
        });
      queue = next;
      return next;
    },
    clearJob: () => set({ job: null }),
  };
});

export interface AnalyzerState {
  game: Game | null;
  nodesById: Record<string, MoveNode>;
  rootId: string;
  currentNodeId: string;
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
  /** Selected agent model id (undefined → backend default). Per-session: changing
   *  it starts a fresh chat. */
  model?: string;
  /** SDK-native session id from the `session` AgentEvent; shown in the header and
   *  used as the resume seed when continuing. */
  currentSessionId?: string;
  /** When set, the next stream opens with `?resume=<id>` to continue that SDK
   *  session; cleared by `newChat`. */
  resumeId?: string;
  /**
   * A raw FEN pushed by the agent (e.g. an off-game variation). When set it
   * overrides the game+ply derivation in `currentFen`. Cleared on navigation
   * and when a new game is loaded.
   */
  agentFen: string | null;
  coach: CoachState;

  setGame: (game: Game) => void;
  gotoPly: (n: number) => void;
  gotoNode: (id: string) => void;
  playMove: (drop: DropInput) => boolean;
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
  failAssistantMessage: (message: string) => void;
  setModel: (id: string) => void;
  noteServerModel: (id: string) => void;
  newChat: () => void;
  continueSession: (sdkId: string) => Promise<void>;
  setSessionId: (sdkId: string) => void;
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

const INITIAL_TREE: MoveTree = emptyTree(START_FEN);

export const useAnalyzerStore = create<AnalyzerState>((set, get) => ({
  game: null,
  nodesById: INITIAL_TREE.nodesById,
  rootId: INITIAL_TREE.rootId,
  currentNodeId: INITIAL_TREE.rootId,
  orientation: "white",
  evalByPly: {},
  arrowEvalByFen: {},
  arrowsEnabled: readArrowsEnabled(),
  analysis: null,
  chat: [],
  streaming: false,
  sessionId: crypto.randomUUID(),
  model: undefined,
  currentSessionId: undefined,
  resumeId: undefined,
  agentFen: null,
  coach: IDLE_COACH,

  setGame: (game) => {
    const tree = buildTree(game);
    set({
      game,
      nodesById: tree.nodesById,
      rootId: tree.rootId,
      currentNodeId: tree.rootId,
      analysis: game.analysis ?? null,
      evalByPly: {},
      arrowEvalByFen: {},
      agentFen: null,
      // A fresh game ends any review in progress.
      coach: IDLE_COACH,
    });
  },

  gotoNode: (id) => {
    const s = get();
    if (!s.nodesById[id]) return;
    set({ currentNodeId: id, agentFen: null });
  },

  playMove: (drop) => {
    const s = get();
    const res = applyMove(s.nodesById, s.currentNodeId, drop);
    if (!res) return false;
    set({
      nodesById: res.nodesById,
      currentNodeId: res.nodeId,
      agentFen: null,
    });
    return true;
  },

  gotoPly: (n) => {
    const s = get();
    const id = mainlineNodeAtPly(
      { nodesById: s.nodesById, rootId: s.rootId },
      n,
    );
    set({ currentNodeId: id, agentFen: null });
  },

  nextPly: () => {
    const s = get();
    const next = s.nodesById[s.currentNodeId].children[0];
    if (next === undefined) return;
    set({ currentNodeId: next, agentFen: null });
  },

  prevPly: () => {
    const s = get();
    const parentId = s.nodesById[s.currentNodeId].parentId;
    if (parentId === null) return;
    set({ currentNodeId: parentId, agentFen: null });
  },

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

  failAssistantMessage: (message) =>
    set((s) => {
      const chat = s.chat.slice();
      const last = chat[chat.length - 1];
      if (last && last.role === "assistant") {
        chat[chat.length - 1] = { ...last, error: message };
      }
      return { chat, streaming: false };
    }),

  setModel: (id) =>
    set({
      model: id,
      // Model is per-session: a new model starts a fresh chat.
      chat: [],
      resumeId: undefined,
      currentSessionId: undefined,
      sessionId: crypto.randomUUID(),
    }),

  // Reflect the model the server actually served (after a rate-limit fallback)
  // without the session-rotating side effects of `setModel`: keep the chat and the
  // open stream, just update the shown model so the picker matches reality.
  noteServerModel: (id) => set({ model: id }),

  newChat: () =>
    set({
      chat: [],
      resumeId: undefined,
      currentSessionId: undefined,
      // A new connection id re-keys the ChatPanel effect → the SSE stream reopens.
      sessionId: crypto.randomUUID(),
    }),

  continueSession: async (sdkId) => {
    const messages = await api.getSessionMessages(sdkId);
    set({
      chat: messages.map((m) => ({
        id: crypto.randomUUID(),
        role: m.role,
        text: m.text,
        tools: [],
      })),
      resumeId: sdkId,
      currentSessionId: sdkId,
      // New connection id → stream reopens with `?resume=sdkId`.
      sessionId: crypto.randomUUID(),
    });
  },

  setSessionId: (sdkId) => set({ currentSessionId: sdkId }),

  setBoardFromAgent: (fen, ply) => {
    const s = get();
    if (ply !== undefined) {
      const id = mainlineNodeAtPly(
        { nodesById: s.nodesById, rootId: s.rootId },
        ply,
      );
      set({ currentNodeId: id, agentFen: null });
    } else {
      set({ agentFen: fen });
    }
  },

  setCoachQuestion: (question) =>
    set({ coach: { mode: "question", current: question, lastReveal: null } }),

  setCoachReveal: (reveal) =>
    set((s) => ({
      coach: { mode: "reveal", current: s.coach.current, lastReveal: reveal },
    })),

  clearCoach: () => set({ coach: IDLE_COACH }),
}));

/** The active tree node (always defined — the store seeds an empty-tree root). */
export function currentNode(state: AnalyzerState): MoveNode {
  return state.nodesById[state.currentNodeId];
}

/**
 * The FEN to render. An agent-pushed off-game FEN wins; otherwise the active
 * node's position (the empty-tree root is the standard start position).
 */
export function currentFen(state: AnalyzerState): string {
  if (state.agentFen) return state.agentFen;
  return currentNode(state).fen;
}

/** Ply of the active node, or — in a variation — its branch-point mainline ply. */
export function currentMainlinePly(state: AnalyzerState): number {
  return nearestMainlinePly(state.nodesById, state.currentNodeId);
}
