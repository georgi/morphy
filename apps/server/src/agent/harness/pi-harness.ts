import type {
  createAgentSession as CreateAgentSessionFn,
  defineTool as DefineToolFn,
  getAgentDir as GetAgentDirFn,
  parseSessionEntries as ParseSessionEntriesFn,
  AgentSession,
  SessionManager as SessionManagerClass,
  DefaultResourceLoader as DefaultResourceLoaderClass,
  ModelRegistry as ModelRegistryClass,
  AuthStorage as AuthStorageClass,
  ToolDefinition,
  SessionMessageEntry,
} from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import type { ModelInfo, SessionSummary, TranscriptMessage } from '@chess/shared';
import { loadEsm } from './esm-loader';
import type {
  AgentHarness,
  AgentRunner,
  AgentSessionConfig,
} from './agent-harness';
import type { AgentTool } from './agent-tool';

/**
 * A stored Pi message entry's payload (`AgentMessage`), reached through the package
 * index without adding a transitive `@earendil-works/pi-agent-core` specifier (which
 * does not resolve under this project's classic node module resolution).
 */
type PiMessage = SessionMessageEntry['message'];

/** The two LLM-visible conversational roles — the only ones the replay keeps. */
type PiChatMessage = Extract<PiMessage, { role: 'user' | 'assistant' }>;

/** The text block of a Pi message's content array (others — thinking/toolCall/image — are dropped). */
type PiTextContent = { type: 'text'; text: string };

/** The subset of the Pi SDK surface this adapter uses (value imports only). */
interface PiSdk {
  createAgentSession: typeof CreateAgentSessionFn;
  defineTool: typeof DefineToolFn;
  getAgentDir: typeof GetAgentDirFn;
  parseSessionEntries: typeof ParseSessionEntriesFn;
  SessionManager: typeof SessionManagerClass;
  DefaultResourceLoader: typeof DefaultResourceLoaderClass;
  ModelRegistry: typeof ModelRegistryClass;
  AuthStorage: typeof AuthStorageClass;
}

const PI_SPECIFIER = '@earendil-works/pi-coding-agent';

/**
 * {@link AgentHarness} backed by the Pi Agent SDK
 * (`@earendil-works/pi-coding-agent`). Owns every Pi-specific concern: loading the
 * ESM-only SDK, wrapping neutral tools into Pi `ToolDefinition`s, building the
 * session with the coaching system prompt, translating Pi session events into the
 * shared `AgentEvent` union, and reading Pi's native model/session stores.
 *
 * Dependency-free singleton: tools and the system prompt arrive per
 * `createSession`/`resumeSession` call via {@link AgentSessionConfig}.
 */
export class PiHarness implements AgentHarness {
  /** Cached SDK handle so the module is loaded once across all sessions. */
  private sdkPromise?: Promise<PiSdk>;

  // ── models ─────────────────────────────────────────────────────────────────

  /** Models with auth configured, mapped to the neutral {@link ModelInfo}. */
  async listModels(): Promise<ModelInfo[]> {
    const { ModelRegistry, AuthStorage } = await this.sdk();
    // Let both helpers default to their file paths under ~/.pi/agent, exactly as
    // createAgentSession does internally.
    const authStorage = AuthStorage.create();
    const registry = ModelRegistry.create(authStorage);
    return registry.getAvailable().map((m) => ({
      id: m.id,
      provider: m.provider,
      contextWindow: m.contextWindow,
      label: m.name,
    }));
  }

  // ── sessions ─────────────────────────────────────────────────────────────────

  /** Stored sessions for the server cwd, mapped to {@link SessionSummary}. */
  async listSessions(): Promise<SessionSummary[]> {
    const { SessionManager } = await this.sdk();
    // Scope to the server cwd (kept stable across restarts); fall back to all
    // sessions in case storage uses a different cwd encoding.
    let infos = await SessionManager.list(process.cwd());
    if (infos.length === 0) {
      infos = await SessionManager.listAll();
    }
    return infos.map((s) => ({
      id: s.id,
      title: s.name ?? firstLine(s.firstMessage),
      createdAt: s.created.toISOString(),
      updatedAt: s.modified.toISOString(),
      messageCount: s.messageCount,
    }));
  }

  // ── session lifecycle ────────────────────────────────────────────────────────

  /** Build a fresh in-memory Pi session and return a runner bound to it. */
  async createSession(config: AgentSessionConfig): Promise<AgentRunner> {
    const sdk = await this.sdk();
    const { createAgentSession, SessionManager } = sdk;

    const customTools = this.buildCustomTools(sdk, config);
    const resourceLoader = await this.buildResourceLoader(sdk, config);
    const model = await this.resolveModel(sdk, config.model);

    const { session } = await createAgentSession({
      // Only our chess tools — no filesystem/bash access.
      noTools: 'builtin',
      customTools,
      tools: customTools.map((tool) => tool.name),
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      model,
    });

    return this.makeRunner(session, config);
  }

  /**
   * Resume a stored Pi session by id: resolve its on-disk file from the listing,
   * bind a file-backed `SessionManager` to it, then build the session as usual so
   * the resumed history continues.
   */
  async resumeSession(
    sessionId: string,
    config: AgentSessionConfig,
  ): Promise<AgentRunner> {
    const sdk = await this.sdk();
    const { createAgentSession, SessionManager } = sdk;

    const path = await this.resolveSessionFile(sessionId);
    if (!path) throw new Error(`Session not found: ${sessionId}`);

    // Bind a persisting SessionManager to that file (loads its JSONL history).
    const sessionManager = SessionManager.create(process.cwd());
    sessionManager.setSessionFile(path);

    const customTools = this.buildCustomTools(sdk, config);
    const resourceLoader = await this.buildResourceLoader(sdk, config);
    const model = await this.resolveModel(sdk, config.model);

    const { session } = await createAgentSession({
      noTools: 'builtin',
      customTools,
      tools: customTools.map((tool) => tool.name),
      resourceLoader,
      sessionManager,
      model,
    });

    return this.makeRunner(session, config);
  }

  /**
   * Read a stored session's ordered message turns without mutating or creating any
   * session file: resolve the file from the listing, parse it statically, and map
   * user/assistant text. Tool calls, thinking, system, and compaction entries are
   * skipped — the continue UI replays plain text bubbles only.
   */
  async getSessionMessages(sessionId: string): Promise<TranscriptMessage[]> {
    const { parseSessionEntries } = await this.sdk();

    const path = await this.resolveSessionFile(sessionId);
    if (!path) return [];

    const content = await readFile(path, 'utf8');
    const entries = parseSessionEntries(content);

    const out: TranscriptMessage[] = [];
    for (const entry of entries) {
      // Skip the header and every non-message entry (thinking_level_change,
      // model_change, compaction, branch_summary, custom, custom_message, label,
      // session_info).
      if (entry.type !== 'message') continue;
      const message = (entry as SessionMessageEntry).message;
      // Only the two LLM-visible conversational roles; toolResult and the custom
      // roles (bashExecution/custom/branchSummary/compactionSummary) are dropped.
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      const text = extractMessageText(message);
      if (text) out.push({ role: message.role, text });
    }
    return out;
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /** Load (and cache) the ESM-only Pi SDK. */
  private sdk(): Promise<PiSdk> {
    if (!this.sdkPromise) {
      this.sdkPromise = loadEsm<PiSdk>(PI_SPECIFIER);
    }
    return this.sdkPromise;
  }

  /**
   * Resolve a stored session's on-disk file from its id. There is no public
   * id -> path helper other than the listing API, so scope to this cwd and fall
   * back to all sessions, mirroring `listSessions`.
   */
  private async resolveSessionFile(
    sessionId: string,
  ): Promise<string | undefined> {
    const { SessionManager } = await this.sdk();
    let infos = await SessionManager.list(process.cwd());
    let info = infos.find((s) => s.id === sessionId);
    if (!info) {
      infos = await SessionManager.listAll();
      info = infos.find((s) => s.id === sessionId);
    }
    return info?.path;
  }

  /**
   * Wrap each neutral {@link AgentTool} into a Pi `ToolDefinition`, discarding the
   * leading `toolCallId` Pi passes (the neutral tool only takes parsed params).
   */
  private buildCustomTools(
    sdk: PiSdk,
    config: AgentSessionConfig,
  ): ToolDefinition[] {
    const { defineTool } = sdk;
    return config.tools.map((tool) =>
      defineTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (_id, params) => {
          const result = await tool.execute(params);
          // Pi's ToolDefinition requires `details`; the neutral result makes it
          // optional, so backfill an empty object when a tool omits it.
          return { ...result, details: result.details ?? {} };
        },
      }),
    );
  }

  /**
   * Build a {@link DefaultResourceLoader} that replaces the system prompt with our
   * coaching prompt and suppresses all project-local discovery (extensions /
   * skills / AGENTS.md): this is a server, there is no codebase context to load.
   */
  private async buildResourceLoader(
    sdk: PiSdk,
    config: AgentSessionConfig,
  ): Promise<DefaultResourceLoaderClass> {
    const { DefaultResourceLoader, getAgentDir } = sdk;
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt: config.systemPrompt,
      appendSystemPrompt: [],
      systemPromptOverride: () => config.systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();
    return resourceLoader;
  }

  /** Resolve a model id to a Pi `Model`, or `undefined` for the backend default. */
  private async resolveModel(sdk: PiSdk, modelId: string | undefined) {
    if (!modelId) return undefined;
    const { ModelRegistry, AuthStorage } = sdk;
    const registry = ModelRegistry.create(AuthStorage.create());
    // The neutral ModelInfo.id is just Model.id; first match wins. (If two
    // providers share an id, getAvailable() order — which createSession favors —
    // would disambiguate; getAll() also surfaces unauthenticated models.)
    return registry.getAll().find((m) => m.id === modelId);
  }

  /**
   * Subscribe to a Pi session, translate its events to the neutral `AgentEvent`
   * union onto `config.emit`, and return an {@link AgentRunner} whose `prompt()`
   * emits the one-off `session` event at the start of its first turn and throws on
   * a failed turn.
   */
  private makeRunner(
    session: AgentSession,
    config: AgentSessionConfig,
  ): AgentRunner {
    const { emit } = config;
    const unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case 'message_update': {
          const inner = event.assistantMessageEvent;
          if (inner.type === 'text_delta') {
            emit({ type: 'text_delta', delta: inner.delta });
          }
          break;
        }
        case 'tool_execution_start': {
          emit({ type: 'tool_start', tool: event.toolName, args: event.args });
          break;
        }
        case 'tool_execution_end': {
          emit({
            type: 'tool_end',
            tool: event.toolName,
            ok: !event.isError,
            summary: summarizeToolResult(event.result),
          });
          break;
        }
        default:
          break;
      }
    });

    // Emit the canonical `session` event lazily — once, at the start of the first
    // turn — so the SSE subscriber (attached only after the client opens the
    // stream) reliably receives it, and resumed sessions stay symmetric with new
    // ones. The id/model are read from the live session getters at that moment.
    let sessionAnnounced = false;

    return {
      id: session.sessionId,
      async prompt(text: string): Promise<void> {
        if (!sessionAnnounced) {
          sessionAnnounced = true;
          emit({
            type: 'session',
            id: session.sessionId,
            model: session.model?.id,
          });
        }
        await session.prompt(text);
        // Pi has no done event — prompt() resolving is turn completion. A
        // failed/aborted assistant turn leaves a message on state instead of
        // rejecting, so surface it as a throw for AgentService to map to `error`.
        const errorMessage = session.state.errorMessage;
        if (errorMessage) throw new Error(errorMessage);
      },
      dispose(): void {
        unsubscribe();
        session.dispose();
      },
    };
  }
}

/** Best-effort one-line summary of a tool result for the activity trail. */
function summarizeToolResult(result: unknown): string | undefined {
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

/** The first non-empty line of a message, for a session title. */
function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text.split('\n', 1)[0].trim();
  return line.length > 0 ? line : undefined;
}

/** Plain text of a user/assistant message: string content verbatim, else the
 *  concatenation of its `text` blocks (thinking, tool calls, and images dropped). */
function extractMessageText(message: PiChatMessage): string {
  if (typeof message.content === 'string') return message.content.trim();
  return message.content
    .filter(
      (block): block is PiTextContent =>
        (block as { type?: unknown }).type === 'text',
    )
    .map((block) => block.text)
    .join('')
    .trim();
}
