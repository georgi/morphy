import type { Static, TSchema } from '@sinclair/typebox';
import type { AgentEvent } from '@chess/shared';

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
 * tools use it to (a) push UI-affecting events onto the session's SSE stream and
 * (b) read the active game/ply the user is looking at, so tools that don't take an
 * explicit game can default to the current one.
 */
export interface ToolSessionContext {
  /** Emit an AgentEvent onto this session's stream (e.g. a board_update). */
  emit: (event: AgentEvent) => void;
  /** The game/ply the user is currently viewing, if any. */
  getContext: () => { gameId?: string; ply?: number };
}
