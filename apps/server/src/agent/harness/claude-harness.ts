import type {
  query as QueryFn,
  tool as ToolFn,
  createSdkMcpServer as CreateSdkMcpServerFn,
  listSessions as ListSessionsFn,
  getSessionMessages as GetSessionMessagesFn,
  Options,
  ModelInfo as SdkModelInfo,
  McpSdkServerConfigWithInstance,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Static, TObject } from '@sinclair/typebox';
import type { ModelInfo, SessionSummary, TranscriptMessage } from '@chess/shared';
import { loadEsm } from './esm-loader';
import { typeBoxObjectToZodShape } from './json-schema-to-zod';
import type {
  AgentHarness,
  AgentRunner,
  AgentSessionConfig,
} from './agent-harness';
import type { AgentTool, AgentToolResult } from './agent-tool';

/** The subset of the Claude Agent SDK surface this adapter uses (value imports). */
interface ClaudeSdk {
  query: typeof QueryFn;
  tool: typeof ToolFn;
  createSdkMcpServer: typeof CreateSdkMcpServerFn;
  listSessions: typeof ListSessionsFn;
  getSessionMessages: typeof GetSessionMessagesFn;
}

const CLAUDE_SPECIFIER = '@anthropic-ai/claude-agent-sdk';

/** The MCP server name the chess tools register under; also the `mcp__<name>__` prefix. */
const MCP_SERVER_NAME = 'chess';

/** Default model when neither the session config nor `CLAUDE_AGENT_MODEL` pins one. */
const DEFAULT_MODEL = 'claude-opus-4-8';

/**
 * {@link AgentHarness} backed by the Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`). Owns every Claude-specific concern: loading
 * the ESM-only SDK, bridging neutral TypeBox tools into an in-process MCP server
 * (Zod-shaped `tool()`s), running a turn through `query()`, translating its message
 * stream into the shared `AgentEvent` union, and reading the SDK-native session and
 * model stores.
 *
 * Dependency-free singleton: tools and the system prompt arrive per
 * `createSession`/`resumeSession` call via {@link AgentSessionConfig}.
 */
export class ClaudeHarness implements AgentHarness {
  /** Cached SDK handle so the module is loaded once across all sessions. */
  private sdkPromise?: Promise<ClaudeSdk>;

  // ── models ─────────────────────────────────────────────────────────────────

  /** Models the SDK reports as supported, mapped to the neutral {@link ModelInfo}. */
  async listModels(): Promise<ModelInfo[]> {
    const { query } = await this.sdk();
    // `supportedModels()` is a control request that resolves from the init
    // handshake without consuming the prompt; an empty prompt + `close()` is the
    // documented probe and never runs a turn.
    const q = query({ prompt: '', options: { settingSources: [], cwd: cwd() } });
    try {
      const models = await q.supportedModels();
      return models.map(toModelInfo);
    } finally {
      q.close();
    }
  }

  // ── sessions ─────────────────────────────────────────────────────────────────

  /** Stored sessions for the server cwd, mapped to {@link SessionSummary}. */
  async listSessions(): Promise<SessionSummary[]> {
    const { listSessions } = await this.sdk();
    // Scope to the server cwd (kept stable across restarts) so resume targets the
    // same native store. Returns [] (never throws) when no sessions exist yet.
    try {
      const sessions = await listSessions({ dir: cwd() });
      return sessions.map((s) => ({
        id: s.sessionId,
        title: s.customTitle ?? s.summary ?? s.firstPrompt,
        createdAt: s.createdAt
          ? new Date(s.createdAt).toISOString()
          : undefined,
        updatedAt: new Date(s.lastModified).toISOString(),
        // SDKSessionInfo carries no message count — leave it undefined.
      }));
    } catch (err) {
      // A missing transcript dir (no sessions ever created) must be empty, not an
      // error; only swallow that case and rethrow anything else.
      if (isMissingDir(err)) return [];
      throw err;
    }
  }

  /**
   * The ordered user/assistant text of a stored session, for transcript replay on
   * continue. Reads the SDK-native JSONL transcript via `getSessionMessages`
   * (chronological, parentUuid-chained) and keeps only the plain text of each
   * user/assistant turn — tool, thinking, and system entries are dropped, matching
   * what the chat bubbles show. Returns [] for an unknown session (the SDK already
   * degrades to []); a missing transcript dir is the same empty case.
   */
  async getSessionMessages(sessionId: string): Promise<TranscriptMessage[]> {
    const { getSessionMessages } = await this.sdk();
    try {
      // Scope to the server cwd so the lookup matches the same native store
      // `listSessions`/resume use. includeSystemMessages defaults to false.
      const messages = await getSessionMessages(sessionId, { dir: cwd() });
      const out: TranscriptMessage[] = [];
      for (const entry of messages) {
        if (entry.type !== 'user' && entry.type !== 'assistant') continue;
        const text = transcriptText(entry.message);
        // Skip turns that carry no plain text (e.g. a user turn that is only a
        // tool_result, or an assistant turn that is only a tool_use).
        if (text) out.push({ role: entry.type, text });
      }
      return out;
    } catch (err) {
      if (isMissingDir(err)) return [];
      throw err;
    }
  }

  // ── session lifecycle ────────────────────────────────────────────────────────

  /** Build a fresh Claude session (new id minted on the first prompt). */
  async createSession(config: AgentSessionConfig): Promise<AgentRunner> {
    const sdk = await this.sdk();
    return new ClaudeRunner(sdk, config);
  }

  /**
   * Resume a stored Claude session by id: seed the runner's session id so the very
   * first `prompt()` passes `resume` and continues the on-disk history.
   */
  async resumeSession(
    sessionId: string,
    config: AgentSessionConfig,
  ): Promise<AgentRunner> {
    const sdk = await this.sdk();
    return new ClaudeRunner(sdk, config, sessionId);
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /** Load (and cache) the ESM-only Claude SDK. */
  private sdk(): Promise<ClaudeSdk> {
    if (!this.sdkPromise) {
      this.sdkPromise = loadEsm<ClaudeSdk>(CLAUDE_SPECIFIER);
    }
    return this.sdkPromise;
  }
}

/**
 * A single Claude chat session. Holds the in-process MCP chess server built from
 * the neutral tools and runs one `query()` per `prompt()` turn, translating the SDK
 * message stream into `AgentEvent`s on `config.emit`. The SDK session id is minted
 * on the first turn (or pre-seeded for resume) and surfaced once via a `session`
 * event — the canonical handle the client resumes from.
 */
class ClaudeRunner implements AgentRunner {
  /** The in-process MCP server; built once and reused across every turn. */
  private readonly server: McpSdkServerConfigWithInstance;
  /** Fully-qualified MCP tool names (`mcp__chess__<name>`) auto-allowed per turn. */
  private readonly toolNames: string[];
  /** The session cwd; identical across prompt/resume so the native store lines up. */
  private readonly workingDir = cwd();
  /** Whether the one-off `session` event has fired (guards both create and resume). */
  private emitted = false;

  constructor(
    private readonly sdk: ClaudeSdk,
    private readonly config: AgentSessionConfig,
    /** Pre-seeded for resume; undefined on create until the first turn mints it. */
    private sessionId?: string,
  ) {
    this.server = sdk.createSdkMcpServer({
      name: MCP_SERVER_NAME,
      version: '1.0.0',
      tools: config.tools.map((tool) =>
        sdk.tool(
          tool.name,
          tool.description,
          // Every tool's `parameters` is a TObject in practice (the bridge only
          // handles object schemas); narrow the generic `TSchema` to it here.
          typeBoxObjectToZodShape(tool.parameters as TObject),
          // The TypeBox -> Zod bridge loses the static link, so cast `args` back to
          // the tool's own `Static<P>` when calling through. `toCallToolResult`
          // drops `details` (the text content is what the model reads).
          async (args) =>
            toCallToolResult(
              await tool.execute(args as Static<typeof tool.parameters>),
            ),
        ),
      ),
    });
    this.toolNames = config.tools.map(
      (tool) => `mcp__${MCP_SERVER_NAME}__${tool.name}`,
    );
  }

  /** The SDK session id; empty until the first turn mints it (pre-seeded on resume). */
  get id(): string {
    return this.sessionId ?? '';
  }

  /**
   * Run one turn through `query()`: capture the session id, stream text deltas and
   * tool activity onto `config.emit`, and resolve on a `success` result (throw on
   * any error result, which {@link AgentRunner} leaves to AgentService to map to
   * `error`). The first turn omits `resume`; later turns pass the captured id.
   */
  async prompt(text: string): Promise<void> {
    const { emit } = this.config;

    // Lazy, once-per-runner `session` emit. On resume the id is pre-seeded, so
    // announce it now (the init message's id is suppressed below); on create the
    // id is minted by the first turn's init message, announced there.
    if (this.sessionId && !this.emitted) {
      this.emitted = true;
      emit({
        type: 'session',
        id: this.sessionId,
        model: this.config.model ?? agentModel(),
      });
    }

    const options: Options = {
      model: this.config.model ?? agentModel(),
      // A bare string is a fully custom system prompt — it replaces the Claude
      // Code preset, which is what the coaching prompt wants.
      systemPrompt: this.config.systemPrompt,
      mcpServers: { [MCP_SERVER_NAME]: this.server },
      allowedTools: this.toolNames,
      // Disable all built-in tools so the coach only has the chess MCP tools.
      tools: [],
      // SDK isolation: load nothing from disk (no user/project settings, no
      // CLAUDE.md) so the session stays scoped to the coaching prompt.
      settingSources: [],
      // Required to receive text deltas as `stream_event` messages.
      includePartialMessages: true,
      cwd: this.workingDir,
      ...(this.sessionId ? { resume: this.sessionId } : {}),
    };

    const q = this.sdk.query({ prompt: text, options });
    // tool_use id -> tool name, so a tool_result (which only carries the id) maps
    // back to a name for the `tool_end` event.
    const toolNameById = new Map<string, string>();

    try {
      for await (const message of q) {
        switch (message.type) {
          case 'system': {
            // Capture the freshly-minted session id from the init message and
            // announce it once. Guarded by `emitted` (not `!this.sessionId`) so a
            // resumed session — whose id is pre-seeded and already announced above —
            // does not double-emit.
            if (message.subtype === 'init' && !this.emitted) {
              this.sessionId = message.session_id;
              this.emitted = true;
              emit({
                type: 'session',
                id: this.sessionId,
                model: message.model,
              });
            }
            break;
          }
          case 'stream_event': {
            const ev = message.event;
            if (
              ev.type === 'content_block_delta' &&
              ev.delta.type === 'text_delta'
            ) {
              emit({ type: 'text_delta', delta: ev.delta.text });
            }
            break;
          }
          case 'assistant': {
            for (const block of message.message.content) {
              if (block.type === 'tool_use') {
                // The SDK names MCP tool_use blocks with the fully-qualified
                // `mcp__chess__<tool>`; strip the prefix once at capture so both
                // the `tool_start` here and the `tool_end` lookup below emit the
                // bare name, matching PiHarness (and the UI tool trail).
                const tool = bareToolName(block.name);
                toolNameById.set(block.id, tool);
                emit({ type: 'tool_start', tool, args: block.input });
              }
            }
            break;
          }
          case 'user': {
            const content = message.message.content;
            // MessageParam.content may be a bare string; only arrays carry blocks.
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'tool_result') {
                  emit({
                    type: 'tool_end',
                    tool:
                      toolNameById.get(block.tool_use_id) ?? block.tool_use_id,
                    ok: block.is_error !== true,
                    summary: summarizeToolResult(block.content),
                  });
                }
              }
            }
            break;
          }
          case 'result': {
            // A result always ends the turn: resolve on success, throw otherwise
            // so AgentService maps the rejection to an `error` event.
            if (message.subtype !== 'success' || message.is_error) {
              const detail = resultErrorDetail(message);
              throw new Error(`Claude turn failed: ${detail}`);
            }
            return;
          }
          default:
            // The union has many other system/status subtypes — ignore them.
            break;
        }
      }
    } finally {
      // Tear down this turn's subprocess; resume keeps the on-disk session.
      q.close();
    }
  }
}

/** The `mcp__chess__` prefix the SDK prepends to this server's tool names. */
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * Strip the `mcp__chess__` prefix the SDK puts on MCP tool_use block names, so the
 * adapter emits the bare tool name (`open_game`) like PiHarness does. Non-MCP names
 * (none in practice — built-ins are disabled) pass through unchanged.
 */
function bareToolName(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX)
    ? name.slice(MCP_TOOL_PREFIX.length)
    : name;
}

/** Map an SDK `ModelInfo` onto the neutral one (no provider/contextWindow here). */
function toModelInfo(m: SdkModelInfo): ModelInfo {
  return {
    id: m.value,
    label: m.displayName,
    // provider, contextWindow: not surfaced by this SDK -> omitted.
  };
}

/** Project a neutral tool result onto the MCP `CallToolResult` shape (drop details). */
function toCallToolResult(result: AgentToolResult): {
  content: AgentToolResult['content'];
} {
  return { content: result.content };
}

/** The text/blocks a tool_result block carries: a string, or an array of parts. */
type ToolResultContent =
  | string
  | Array<{ type?: string; text?: unknown }>
  | undefined;

/**
 * Best-effort one-line summary of a tool result for the activity trail, mirroring
 * PiHarness's `summarizeToolResult`: the first `{type:'text'}` part of an array, or
 * the string itself, trimmed to its first line.
 */
function summarizeToolResult(content: ToolResultContent): string | undefined {
  let text: string | undefined;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const first = content.find(
      (part) =>
        !!part && part.type === 'text' && typeof part.text === 'string',
    );
    text = first?.text as string | undefined;
  }
  if (text === undefined) return undefined;
  const firstLine = text.trim().split('\n', 1)[0];
  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
}

/**
 * The concatenated plain text of a transcript message. `SessionMessage.message` is
 * typed `unknown` (it is a raw Anthropic message: a `MessageParam` for user turns,
 * a `BetaMessage` for assistant turns), so narrow defensively: a bare string is the
 * text; an array contributes every `{ type: 'text', text }` block in order. Tool,
 * thinking, and image blocks yield nothing.
 */
function transcriptText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      !!block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('').trim();
}

/**
 * The human-readable reason a `result` message represents a failure. Error-subtype
 * results carry an `errors` array; a `success` result that still sets `is_error`
 * (e.g. an API error surfaced mid-success) carries its reason in `result` (with an
 * optional `api_error_status`), NOT in `errors` — so fall through to that text, and
 * to `subtype` only as a last resort.
 */
function resultErrorDetail(message: SDKResultMessage): string {
  if ('errors' in message && message.errors.length) {
    return message.errors.join('; ');
  }
  if ('result' in message && message.result) {
    const status =
      'api_error_status' in message && message.api_error_status
        ? ` (status ${message.api_error_status})`
        : '';
    return `${message.result}${status}`;
  }
  return message.subtype;
}

/** The default Claude model: env override, then the pinned fallback. */
function agentModel(): string {
  return process.env.CLAUDE_AGENT_MODEL ?? DEFAULT_MODEL;
}

/** The server cwd: scopes the SDK-native session store across create/prompt/list. */
function cwd(): string {
  return process.cwd();
}

/** Whether an error is a missing-directory ENOENT (no sessions ever created). */
function isMissingDir(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
