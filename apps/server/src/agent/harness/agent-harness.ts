import type {
  AgentEvent,
  ModelInfo,
  SessionSummary,
  TranscriptMessage,
} from '@chess/shared';
import type { AgentTool } from './agent-tool';

/**
 * Everything a backend needs to spin up a single chat session. Tools and the
 * system prompt arrive here (not in the adapter constructor) so the adapter stays
 * a dependency-free singleton.
 */
export interface AgentSessionConfig {
  systemPrompt: string;
  tools: AgentTool[];
  /** The session's SSE subject sink: the adapter emits translated events here. */
  emit: (event: AgentEvent) => void;
  /** Chosen model id; `undefined` uses the backend default. */
  model?: string;
}

/**
 * A live, single-session handle returned by the harness. One turn per `prompt`
 * call; streamed output flows out via {@link AgentSessionConfig.emit}.
 */
export interface AgentRunner {
  /**
   * SDK-native session id. May be populated asynchronously (Claude: after the
   * first turn). The adapter ALSO emits a `session` AgentEvent when the id is
   * known, which is the canonical way the id reaches the client.
   */
  readonly id: string;
  /** Run one turn; stream via emit; resolve on end, throw on error. */
  prompt(text: string): Promise<void>;
  /** Release the underlying SDK session, if the backend holds one. */
  dispose?(): Promise<void> | void;
}

/**
 * The single seam every agent backend sits behind. Beyond running a turn it also
 * lists models, lists stored sessions, and resumes one — each backed by the
 * selected SDK's own native storage.
 */
export interface AgentHarness {
  listModels(): Promise<ModelInfo[]>;
  listSessions(): Promise<SessionSummary[]>;
  /** The stored session's ordered user/assistant text turns, for transcript replay. */
  getSessionMessages(sessionId: string): Promise<TranscriptMessage[]>;
  createSession(config: AgentSessionConfig): Promise<AgentRunner>;
  resumeSession(
    sessionId: string,
    config: AgentSessionConfig,
  ): Promise<AgentRunner>;
}

/** Nest DI token for the process-selected {@link AgentHarness} implementation. */
export const AGENT_HARNESS = 'AGENT_HARNESS';
