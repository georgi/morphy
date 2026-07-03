import type { Static, TSchema } from '@sinclair/typebox';
import type { AgentEvent, Game } from '@chess/shared';

/**
 * A backend-neutral tool result. The text `content` is what the model reads; the
 * optional `details` carries structured data for callers (e.g. tests / logging).
 * Each adapter maps this onto its SDK's own result shape.
 */
export interface AgentToolResult {
  content: { type: 'text'; text: string }[];
  details?: Record<string, unknown>;
}

/**
 * A backend-neutral tool definition. Parameters are TypeBox (= JSON Schema), which
 * Pi consumes directly and the Claude adapter bridges to a Zod shape. `execute`
 * takes only the parsed params — no SDK-specific tool-call id — so the chess tools
 * stay free of any harness coupling.
 */
export interface AgentTool<P extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: P;
  execute: (params: Static<P>) => Promise<AgentToolResult>;
}

/** Identity helper that pins `P` so `params` is fully typed inside `execute`. */
export const defineAgentTool = <P extends TSchema>(
  tool: AgentTool<P>,
): AgentTool<P> => tool;

/**
 * Context handed to the chess tools when they are built for a chat session. The
 * tools use it to (a) push UI-affecting events onto the session's SSE stream,
 * (b) read the session's current game (held by value) and the ply the user is
 * looking at, and (c) replace the current game (`load_pgn`/`load_fen`). There is
 * no shared game store: the client sends the open game with each message, and
 * imports made mid-turn live only on this session context.
 */
export interface ToolSessionContext {
  /** Emit an AgentEvent onto this session's stream (e.g. a board_update). */
  emit: (event: AgentEvent) => void;
  /** The session's current game (by value) and the ply the user is viewing, if any. */
  getContext: () => { game?: Game; ply?: number };
  /** Replace the session's current game (used by `load_pgn`/`load_fen`). */
  setGame: (game: Game) => void;
}
