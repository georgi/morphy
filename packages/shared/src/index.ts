// packages/shared/src/index.ts — the canonical contract, imported by BOTH apps as "@chess/shared"
export { contentHash, normalizedSanList } from "./content-hash";

export type Color = "w" | "b";
export type MoveClassification =
  | "best"
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder"
  | "book";

export interface EngineLine {
  pv: string[];
  scoreCp: number | null;
  mate: number | null;
  rank: number;
}
export interface EngineEval {
  fen: string;
  bestMove: string | null;
  lines: EngineLine[];
  depth: number;
}

export interface Move {
  ply: number;
  moveNumber: number;
  color: Color;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
}
export interface MoveEval {
  ply: number;
  san: string;
  scoreCpBefore: number | null;
  scoreCpAfter: number | null;
  cpLoss: number;
  classification: MoveClassification;
  bestMove: string | null;
  bestLine: string[];
}
export interface GameHeaders {
  event?: string;
  white?: string;
  black?: string;
  result?: string;
  date?: string;
  eco?: string;
  opening?: string;
  [k: string]: string | undefined;
}
export interface Game {
  id: string;
  headers: GameHeaders;
  startFen: string;
  moves: Move[];
  analysis?: MoveEval[];
}

export interface TurningPoint {
  index: number; // 0-based position within the review
  ply: number; // half-move of the mistake
  moveNumber: number;
  sideToMove: Color; // side to move at fenBefore (the side that erred)
  fenBefore: string; // position BEFORE the mistake
  playedSan: string;
  classification: MoveClassification;
  cpLoss: number;
  scoreCpBefore: number | null;
  bestMove: string | null; // engine best move, SAN
  bestLine: string[]; // engine best line, SAN
}

/** A decisive moment surfaced in the review (selected from a game's `MoveEval[]`). */
export interface KeyMoment {
  ply: number;
  moveNumber: number;
  color: Color; // side that moved
  san: string; // e.g. "Bg4"
  classification: MoveClassification; // inaccuracy | mistake | blunder | ...
  scoreCpAfter: number | null; // White-POV
  evalText: string; // White-POV readout, e.g. "+0.9"
  isTurningPoint: boolean; // the single decisive moment
  description: string; // coach prose (agent) or templated fallback
}

/** Where a stored game / collection originated. Direct imports are `'manual'`. */
export type ImportSource =
  | "manual"
  | "lichess"
  | "chesscom"
  | "catalog"
  | "url";

/** A lightweight projection of a stored game for library list/search views. */
export interface GameSummary {
  id: string;
  white?: string;
  black?: string;
  result?: string;
  eco?: string;
  opening?: string;
  date?: string;
  plyCount: number;
  source: ImportSource;
  collectionId?: string;
  hasAnalysis: boolean;
  createdAt: number;
}

/** A named group of games (a Lichess study, a Chess.com archive, a catalog entry, …). */
export interface Collection {
  id: string;
  name: string;
  description?: string;
  source: ImportSource;
  sourceRef?: string;
  gameCount: number;
  createdAt: number;
}

/** Filter/sort/paginate parameters for `GET /api/library/games`. */
export interface LibraryQuery {
  q?: string;
  player?: string;
  eco?: string;
  result?: string;
  source?: ImportSource;
  collectionId?: string;
  sort?: "createdAt" | "white" | "black" | "date";
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/** One page of library search results plus the unpaginated total. */
export interface LibraryPage {
  games: GameSummary[];
  total: number;
}

/** An entry in the curated bulk-download catalog (a remote or bundled PGN). */
export interface CatalogEntry {
  id: string;
  title: string;
  description: string;
  gameCount?: number;
  url: string;
  bundled?: boolean;
}

/**
 * Request body for `POST /api/import`. A discriminated union over the import
 * sources; the pipeline resolves a `GameSource` from `source`. Only the `'url'`
 * variant is wired up today — the others are part of the contract so the web/API
 * surface is stable while later phases add the remote providers.
 */
export type StartImportRequest =
  | { source: "url"; url?: string; pgn?: string; collectionName?: string }
  | {
      source: "lichess";
      kind: "user" | "study" | "broadcast";
      id: string;
      max?: number;
    }
  | { source: "chesscom"; username: string; months?: string[] | "all" }
  | { source: "catalog"; entryId: string };

/** A bulk-import job's persistent state (`GET /api/import/:jobId`, poll fallback). */
export interface ImportJob {
  id: string;
  source: ImportSource;
  status: "pending" | "running" | "done" | "error";
  total?: number;
  imported: number;
  skipped: number;
  failed: number;
  collectionId?: string;
  error?: string;
}

/** Progress/result events streamed over `GET /api/import/:jobId/stream` (SSE). */
export type ImportEvent =
  | {
      type: "progress";
      imported: number;
      skipped: number;
      failed: number;
      total?: number;
    }
  | { type: "game"; game: Game; contentHash: string }
  | { type: "collection"; collection: Collection }
  | {
      type: "done";
      collectionId?: string;
      imported: number;
      skipped: number;
      failed: number;
    }
  | { type: "error"; message: string };

export interface ImportGameRequest {
  pgn?: string;
  fen?: string;
}
/** Response for `POST /api/games`: the parsed game plus its dedup content hash. */
export interface ImportGameResponse {
  game: Game;
  contentHash: string;
}
export interface AnalyzePositionRequest {
  fen: string;
  depth?: number;
  multipv?: number;
}
export interface AnalyzeGameRequest {
  game: Game;
  depth?: number;
}
/** Progress/result events streamed over `POST /api/analysis/game/stream` (SSE). */
export type AnalyzeGameStreamEvent =
  | {
      type: "progress";
      ply: number;
      total: number;
      eval: MoveEval;
    }
  | { type: "done"; evals: MoveEval[] }
  | { type: "error"; message: string };
export interface KeyMomentsRequest {
  game: Game;
}
export interface AgentMessageRequest {
  text: string;
  /** The open game, sent by value — the coach operates on it directly (no library lookup). */
  game?: Game;
  ply?: number;
}

/** A model offered by the active agent backend, for the model picker. */
export interface ModelInfo {
  id: string;
  provider?: string;
  label?: string;
  contextWindow?: number;
}

/** A summary of a stored agent session (for the session list / continue UI). */
export interface SessionSummary {
  id: string;
  title?: string;
  createdAt?: string; // ISO 8601
  updatedAt?: string; // ISO 8601
  messageCount?: number;
  model?: string; // populated when the SDK surfaces it; shown on a resumed session
}

/** A replayed transcript turn (user/assistant text only) for the continue UI. */
export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
}

export type AgentEvent =
  | { type: "text_delta"; delta: string }
  | { type: "session"; id: string; model?: string }
  | { type: "tool_start"; tool: string; args?: unknown }
  | { type: "tool_end"; tool: string; ok: boolean; summary?: string }
  | { type: "board_update"; fen: string; gameId?: string; ply?: number }
  | {
      type: "coach_question";
      gameId: string;
      ply: number;
      fen: string;
      sideToMove: Color;
      index: number;
      total: number;
    }
  | {
      type: "coach_reveal";
      ply: number;
      bestMove: string | null;
      bestLine: string[];
      playedSan: string;
      userSan?: string;
      verdict: "correct" | "close" | "off" | "revealed";
      evalText: string;
    }
  | { type: "notice"; level: "info" | "warn"; message: string }
  | { type: "done" }
  | { type: "error"; message: string };

// ── Play mode ────────────────────────────────────────────────────────────────

/** Public projection of a play character (prompts/chess profile stay server-side). */
export interface Character {
  id: string;
  name: string;
  avatar: string; // emoji, v1
  tagline: string;
  bio: string;
  strength: 1 | 2 | 3 | 4 | 5;
  styleTag: string;
}

export type PlaySide = "white" | "black";
export type PlayStatus = "active" | "over";
export type PlayResult = "1-0" | "0-1" | "1/2-1/2";
export type PlayEndReason =
  | "checkmate"
  | "stalemate"
  | "draw" // 50-move / repetition / insufficient material
  | "resignation"
  | "agreement";

/** A live (or finished) play-mode game. `side` is the HUMAN's side. */
export interface PlayGame {
  id: string;
  characterId: string;
  side: PlaySide;
  startFen: string;
  fen: string;
  moves: Move[];
  status: PlayStatus;
  result?: PlayResult;
  endReason?: PlayEndReason;
}

export interface CreatePlayGameRequest {
  characterId: string;
  side: PlaySide | "random";
}
export interface PlayMoveRequest {
  move: string; // SAN or UCI
}
export interface PlayChatRequest {
  text: string;
}

/** Events streamed over `GET /api/play/:id/events` (SSE). */
export type PlayEvent =
  | { type: "ai_move"; move: Move; fen: string }
  | { type: "banter"; text: string } // whole-message quip from the move pick
  | { type: "chat_delta"; delta: string } // streamed talker output (chat replies, triggered banter, parting shot)
  | { type: "chat_done" }
  | { type: "draw_response"; accepted: boolean }
  | { type: "game_over"; result: PlayResult; reason: PlayEndReason }
  | { type: "error"; message: string };

export const CLASSIFY_THRESHOLDS = {
  inaccuracy: 50,
  mistake: 100,
  blunder: 300,
} as const;
