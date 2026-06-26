# Agent Harness Interface — Design Spec

Date: 2026-06-23
Status: approved for implementation

## Goal

Hide the agent harness behind a single interface (`AgentHarness`) with two
interchangeable, process-level-selectable backends:

- **Pi Agent SDK** (`@earendil-works/pi-coding-agent`) — the current backend.
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — new backend.

Beyond running a turn, the interface must also support: **list models**,
**list sessions**, and **continue (resume) a session** — backed by each SDK's
own native storage.

## Decisions (settled in brainstorming)

1. **Both backends live, swappable** at runtime via a process-level env var
   `AGENT_BACKEND` ∈ `pi` (default) | `claude`. Only the selected adapter is
   instantiated, so the unused SDK is never imported.
2. **Neutral tools use TypeBox** (= JSON Schema). Pi consumes them directly; the
   Claude adapter bridges TypeBox → Zod (`ZodRawShape`) for its `tool()` helper.
3. **SDK-native session store.** `listSessions`/`resumeSession` use each SDK's
   own on-disk sessions (Pi `SessionManager`; Claude transcript dir). The app
   keeps no separate session registry. Sessions are scoped to the server's
   working directory, which must stay stable across restarts.
4. **Per-session model selection.** `listModels` feeds a picker; the chosen model
   is passed in the session config at create/resume.
5. **Claude backend = `@anthropic-ai/claude-agent-sdk`** (installed `0.3.186`),
   the symmetric in-process agent harness (its `query()` runs the loop).
6. Default Claude model: env `CLAUDE_AGENT_MODEL`, default `claude-opus-4-8`.

The output side is **already SDK-neutral**: the shared `AgentEvent` union and the
tool `ctx.emit` channel (`board_update`, `coach_*`) know nothing about Pi. Only
three things are coupled and move behind the interface: tool *definition*,
*session lifecycle*, and SDK-event → `AgentEvent` *translation*.

## Confirmed SDK facts

### Pi (`@earendil-works/pi-coding-agent@0.78.1`, installed)
- Exports: `createAgentSession`, `defineTool`, `getAgentDir`, `SessionManager`,
  `DefaultResourceLoader`, `ModelRegistry`, `AuthStorage`,
  `FileAuthStorageBackend`, `AgentSession`, `SessionInfo`.
- Models: `ModelRegistry.create(authStorage, modelsJsonPath?)` →
  `.getAvailable()` / `.getAll()` → `Model<Api>[]`. (RPC `ModelInfo` shape:
  `{ provider, id, contextWindow, reasoning }`.)
- Sessions: `SessionManager.list(cwd, sessionDir?, onProgress?)` and
  `SessionManager.listAll(sessionDir?, onProgress?)` → `SessionInfo[]`.
  `getSessionsDir()` for the dir. Resume: `SessionManager.setSessionFile(file)`
  ("used for resume and branching") then `createAgentSession({ sessionManager })`.
- ESM-only (loaded via native dynamic import; today's `pi-loader.ts`).

### Claude (`@anthropic-ai/claude-agent-sdk@0.3.186`, installed)
- ESM (`type: module`) → load via the same native-import shim.
- `query(params): Query` — async-iterable of SDK messages.
- `Query.supportedModels(): Promise<ModelInfo[]>`.
- `tool<Schema extends AnyZodRawShape>(name, description, inputSchema, handler)` —
  handler returns `CallToolResult` (`{ content: [...] }`).
- `createSdkMcpServer(options): McpSdkServerConfigWithInstance`.
- Options include: `mcpServers?: Record<string, McpServerConfig>`,
  `allowedTools?`, `disallowedTools?`, `includePartialMessages?`,
  `resume?: string`, `settingSources?: SettingSource[]`, plus `model` /
  `systemPrompt`.
- **No list-sessions API** — session is "New session UUID, resumable via
  `query({ options: { resume: sessionId } })`". Listing requires enumerating the
  Claude Code transcript directory (the SDK-native store). THIS IS THE ONE
  VERIFICATION RISK; everything else is confirmed.
- Peer note: it prefers `@anthropic-ai/sdk>=0.93.0` (found 0.91.1 via Pi). Lazy
  load + Pi-default means this is a non-fatal warning; the integration phase
  confirms the Claude adapter still typechecks/builds (skipLibCheck is on).

## File layout

```
apps/server/src/agent/
  harness/
    agent-tool.ts          # AgentTool, AgentToolResult, defineAgentTool, ToolSessionContext
    agent-harness.ts       # AgentHarness, AgentSessionConfig, AgentRunner, AGENT_HARNESS token
    esm-loader.ts          # loadEsm<T>(specifier) native-import shim (generalizes pi-loader)
    json-schema-to-zod.ts  # TypeBox TObject -> Zod ZodRawShape (subset used by the tools)
    pi-harness.ts          # PiHarness implements AgentHarness
    claude-harness.ts      # ClaudeHarness implements AgentHarness
  chess-tools.service.ts   # returns AgentTool[]; no Pi import; re-exports ToolSessionContext
  agent.service.ts         # depends on AGENT_HARNESS; owns subject + prompt-context + done/error
  agent.controller.ts      # + GET models, GET sessions; stream gains ?model & ?resume
  agent.module.ts          # env-driven AGENT_HARNESS factory provider
  # pi-loader.ts           # REMOVED (folded into esm-loader.ts)
```

## Contracts

### Shared types (`packages/shared/src/index.ts`)
```ts
export interface ModelInfo {
  id: string;
  provider?: string;
  label?: string;
  contextWindow?: number;
}
export interface SessionSummary {
  id: string;
  title?: string;
  createdAt?: string;   // ISO 8601
  updatedAt?: string;   // ISO 8601
  messageCount?: number;
}
// Add to the AgentEvent union:
//   | { type: "session"; id: string; model?: string }
```
`AgentMessageRequest` is unchanged (`model`/`resume` are stream query params).

### Neutral tools (`harness/agent-tool.ts`)
```ts
import type { Static, TSchema } from '@sinclair/typebox';
import type { AgentEvent } from '@chess/shared';

export interface AgentToolResult {
  content: { type: 'text'; text: string }[];
  details?: Record<string, unknown>;
}
export interface AgentTool<P extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: P;
  execute: (params: Static<P>) => Promise<AgentToolResult>;
}
export const defineAgentTool = <P extends TSchema>(tool: AgentTool<P>): AgentTool<P> => tool;

export interface ToolSessionContext {
  emit: (event: AgentEvent) => void;
  getContext: () => { gameId?: string; ply?: number };
}
```
`chess-tools.service.ts` re-exports `ToolSessionContext` from here so existing
imports (`import type { ToolSessionContext } from './chess-tools.service'`) keep
working.

### Port (`harness/agent-harness.ts`)
```ts
import type { AgentEvent, ModelInfo, SessionSummary } from '@chess/shared';
import type { AgentTool } from './agent-tool';

export interface AgentSessionConfig {
  systemPrompt: string;
  tools: AgentTool[];
  emit: (event: AgentEvent) => void;   // the session's SSE subject sink
  model?: string;                      // undefined -> backend default
}
export interface AgentRunner {
  /** SDK-native session id. May be populated asynchronously (Claude: after the
   *  first turn). The adapter ALSO emits a `session` AgentEvent when the id is
   *  known, which is the canonical way the id reaches the client. */
  readonly id: string;
  prompt(text: string): Promise<void>;  // run one turn; stream via emit; resolve on end, throw on error
  dispose?(): Promise<void> | void;
}
export interface AgentHarness {
  listModels(): Promise<ModelInfo[]>;
  listSessions(): Promise<SessionSummary[]>;
  createSession(config: AgentSessionConfig): Promise<AgentRunner>;
  resumeSession(sessionId: string, config: AgentSessionConfig): Promise<AgentRunner>;
}
export const AGENT_HARNESS = 'AGENT_HARNESS';  // Nest DI token
```

### esm-loader (`harness/esm-loader.ts`)
A `new Function('s','return import(s)')` shim (so the CJS emit doesn't rewrite
`import()`), with a per-specifier cache. `loadEsm<T>(specifier): Promise<T>`.

### json-schema-to-zod (`harness/json-schema-to-zod.ts`)
`typeBoxObjectToZodShape(schema): Record<string, ZodTypeAny>` — reads
`schema.properties` + `schema.required`; supports the subset the 17 tools use:
`object`, `string`, `number`/`integer`, `boolean`, `array(items)`, optional (key
absent from `required` → `.optional()`), `enum`, and `description` (→ `.describe`).
Throw on an unsupported construct so gaps surface loudly. Uses `zod` (direct dep).

## Adapter behavior

### Event flow (both adapters)
- The adapter emits onto `config.emit`: `text_delta`, `tool_start`, `tool_end`,
  and a single `{ type: 'session', id, model }` when the SDK session id is known.
- `board_update` / `coach_question` / `coach_reveal` are emitted by the tools
  themselves via their captured `ctx.emit` (same subject) — the adapter does not
  produce them.
- `done` / `error` stay app-level in `AgentService`: `prompt()` resolving →
  `done`; throwing → `error`.

### PiHarness (`pi-harness.ts`)
- Loads the Pi SDK via `loadEsm`.
- `createSession(config)`: build `DefaultResourceLoader` with
  `noExtensions/noSkills/noPromptTemplates/noContextFiles` + systemPrompt
  override (verbatim from today's `agent.service.ts`), `createAgentSession({
  noTools:'builtin', customTools, tools: names, resourceLoader,
  sessionManager: SessionManager.inMemory() })`. Wrap each `AgentTool` with
  `defineTool({ name, label, description, parameters, execute:(_id,params)=>
  tool.execute(params) })`. Subscribe → translate to `AgentEvent`
  (`message_update.text_delta`→`text_delta`; `tool_execution_start`→`tool_start`;
  `tool_execution_end`→`tool_end` with the existing `summarizeToolResult`). Emit
  the `session` event with `getSessionId()`. `prompt()` calls `session.prompt()`
  and throws if `session.state.errorMessage` is set.
- `resumeSession(id, config)`: resolve the session file for `id` (via
  `getSessionsDir()` / `SessionManager.list`), `setSessionFile(file)`, then build
  the session as above bound to it.
- `listModels()`: `ModelRegistry.create(authStorage).getAvailable()` → map to
  `ModelInfo`. Build `authStorage` from the agent dir (see Pi research guide).
- `listSessions()`: `SessionManager.list(process.cwd())` (fall back to
  `listAll()`) → map `SessionInfo` → `SessionSummary`.

### ClaudeHarness (`claude-harness.ts`)
- Loads the Claude SDK via `loadEsm`.
- `createSession(config)`/`resumeSession(id,config)`: build
  `createSdkMcpServer({ name:'chess', version:'1.0.0', tools: config.tools.map(t
  => tool(t.name, t.description, typeBoxObjectToZodShape(t.parameters),
  async(args)=> toCallToolResult(await t.execute(args)))) })`. Hold session
  config + (for resume) the seed session id.
- `prompt(text)`: run `query({ prompt: text, options: { resume: this.sessionId,
  model: config.model ?? CLAUDE_AGENT_MODEL, systemPrompt: config.systemPrompt,
  mcpServers: { chess: server }, allowedTools: toolNames, settingSources: [],
  includePartialMessages: true, cwd } })`. Iterate messages: capture the session
  id from the init/system message → set `this.sessionId`, emit the `session`
  event once; partial text deltas → `text_delta`; assistant `tool_use` block →
  `tool_start`; user `tool_result` block → `tool_end` (map `tool_use_id`→name);
  `result` message → resolve (throw on error result). First turn has no `resume`;
  later turns pass `resume: this.sessionId`.
- `toCallToolResult(r)`: `{ content: r.content }` (drop `details`; the text
  carries the human-readable summary the model reads).
- `listModels()`: open a `query` and call `.supportedModels()`; map to
  `ModelInfo`; dispose.
- `listSessions()`: enumerate the Claude transcript dir (SDK-native store; pin
  the path/format in the Claude research guide), parse `{ id, title (first user
  text), updatedAt (mtime), messageCount (lines) }`. **Verification risk.**

## App wiring

### agent.service.ts
Inject `@Inject(AGENT_HARNESS) harness: AgentHarness`. Keep the subject /
pending-subject / creating-dedup logic. `SessionState` holds `runner: AgentRunner`
(not `piSession`). `getStream(sessionId, opts?: { model?: string; resume?: string })`
threads the params into session creation. `ensureSession` calls
`harness.resumeSession(opts.resume, cfg)` when `resume` is present, else
`harness.createSession(cfg)`. `cfg = { systemPrompt: SYSTEM_PROMPT, tools, emit:
subject.next, model: opts.model }`. `sendMessage` → `await runner.prompt(prompt)`
then emit `done` (the Pi `errorMessage` check now lives in PiHarness, which
throws → caught → `error`). Add `listModels()`/`listSessions()` delegating to the
harness. `SYSTEM_PROMPT` and `buildPrompt`/`recentMoves` stay here unchanged.

### agent.controller.ts
- `@Sse(':sessionId/stream') stream(@Param sessionId, @Query('model') model?,
  @Query('resume') resume?)` → `agent.getStream(sessionId, { model, resume })`.
- `@Get('models') listModels()` → `agent.listModels()`.
- `@Get('sessions') listSessions()` → `agent.listSessions()`.
- `postMessage` unchanged. (Static `models`/`sessions` routes coexist with the
  `:sessionId/...` routes.)

### agent.module.ts
```ts
{
  provide: AGENT_HARNESS,
  useFactory: () =>
    (process.env.AGENT_BACKEND ?? 'pi').toLowerCase() === 'claude'
      ? new ClaudeHarness()
      : new PiHarness(),
}
```
Adapters are dependency-free singletons (tools/systemPrompt arrive per session).

## REST surface
- `GET  /api/agent/models`  → `ModelInfo[]`
- `GET  /api/agent/sessions` → `SessionSummary[]`
- `GET  /api/agent/:sessionId/stream?model=<id>&resume=<sdkSessionId>` → SSE
- `POST /api/agent/:sessionId/messages` → `202` (unchanged)

## Testing

- `harness/json-schema-to-zod.spec.ts` — pure unit; convert real tool TypeBox
  schemas; assert required/optional/array/enum parse behavior; assert throw on
  unsupported. (No ESM; runs cleanly under Jest.)
- `harness/pi-harness.spec.ts` — mock `esm-loader` to return a fake Pi SDK; assert
  Pi events → `AgentEvent` translation, `session` emission, `prompt()`
  resolve/throw, tool wrapping (`_id,params`), and `listModels`/`listSessions`
  mapping.
- `harness/claude-harness.spec.ts` — mock `esm-loader` to return a fake
  claude-agent-sdk (fake async-iterable `query`, `supportedModels`,
  `createSdkMcpServer`, `tool`); assert message → `AgentEvent` translation,
  session-id capture + emit, resume passing on the 2nd turn, Zod tool wrapping,
  `listModels` mapping.
- `agent/agent.module.spec.ts` — assert the env-driven factory returns
  `PiHarness` by default and `ClaudeHarness` when `AGENT_BACKEND=claude`.
- `agent/agent-endpoints.e2e-spec.ts` — Nest `TestingModule` with
  `.overrideProvider(AGENT_HARNESS).useValue(fakeHarness)`; assert
  `GET /api/agent/models` and `/sessions` return the fake arrays. No SDK/auth.
- Update `chess-tools.library.spec.ts` — drop the `jest.mock('./pi-loader')`
  hack (tools no longer import the Pi SDK); update `BuiltTool.execute` to
  `(params)` (drop the `_id` arg).

## Verification gates (all must pass)
1. `pnpm --filter @chess/shared build`
2. `pnpm --filter server build` (full typecheck incl. both adapters)
3. `pnpm --filter server typecheck`
4. `pnpm --filter server test:unit`
5. `pnpm --filter server test:e2e`
6. `pnpm --filter web typecheck` (and build) — keep web compiling; if the new
   `session` AgentEvent variant breaks an exhaustive switch, add a benign
   case/default. (Building the React model-picker / session-list / continue UI is
   OUT OF SCOPE here — backend interface + REST only.)

## Out of scope
- Frontend UI for model selection, session list, and continue (separate, not yet
  designed). This spec delivers the server interface, both adapters, and the REST
  endpoints, end-to-end and verified.
- Cross-backend resume (a Pi session continued under Claude). Backend is fixed at
  boot; `listSessions`/`resume` are scoped to the active backend.

---

## Addendum (2026-06-23): transcript continue, polish, and the agent UI

Builds on everything above (which is implemented and verified). Adds the frontend
(model picker / session list / continue) plus the backend pieces it needs.
Decisions: **continue replays the prior transcript**, and the controls live in a
**slim header bar on the chat column**.

### Backend additions
- **Shared:** `TranscriptMessage { role: 'user' | 'assistant'; text: string }`.
  Add optional `model?: string` to `SessionSummary` (populated when the SDK
  surfaces it; the header shows it on a resumed session).
- **Port:** `getSessionMessages(sessionId: string): Promise<TranscriptMessage[]>`
  on `AgentHarness`.
  - Pi: load the session file (`SessionManager` + `parseSessionEntries` /
    `buildSessionContext`), map message entries to `{role, text}` (assistant text
    + user text; skip tool/thinking/system/compaction entries).
  - Claude: read the SDK-native transcript for the session id (jsonl of SDKMessage
    lines), extract user text and assistant text blocks. Confirm transcript
    path/format in research; degrade to `[]` if absent.
- **REST:** `GET /api/agent/sessions/:id` → `TranscriptMessage[]`;
  `AgentService.getSessionMessages` delegates. (Coexists with `GET .../sessions`.)
- **Polish (fold in):**
  - Both adapters emit the `{type:'session', id, model}` event **once, lazily, at
    the start of the first `prompt()`** (not at session creation) — guarantees the
    SSE subscriber receives it (the client posts a message only after the stream is
    open) and fixes the resumed-session asymmetry. Pi reads the session id then;
    Claude takes it from the first query's `init` message.
  - Claude: when a `success` result carries `is_error: true`, throw with a real
    detail field, not `subtype`.
- **Live smoke test:** `apps/server/test/claude-harness.smoke.spec.ts`, guarded
  (skipped unless `RUN_CLAUDE_TESTS=1`), runs a real one-turn create + prompt +
  `listModels` against the SDK. Run it once live if Anthropic credentials are
  present; otherwise leave skipped and note that the live Claude path is unverified.

### Frontend
- **api.ts:** `listModels()`, `listSessions()`, `getSessionMessages(id)`;
  `openAgentStream(sessionId, onEvent, opts?: { model?; resume? })` appends
  `?model=&resume=`.
- **store.ts:** add `model?: string`, `currentSessionId?: string` (the SDK id from
  the `session` event), `resumeId?: string`. Actions:
  - `setModel(id)` — set model AND start a new chat with it (model is per-session;
    resume keeps the original).
  - `newChat()` — new connection `sessionId` (randomUUID), clear `chat`, clear
    `resumeId`/`currentSessionId`; keep the selected model.
  - `continueSession(sdkId)` — fetch transcript → populate `chat`; set
    `resumeId = sdkId`; new connection `sessionId`; (header shows that session's
    model). The stream reopens with `?resume`.
  - Handle the `session` `AgentEvent` → set `currentSessionId`.
  Changing the connection `sessionId` is what re-opens the SSE stream (the
  `ChatPanel` effect is keyed on it); `model`/`resume` are read at open time.
- **ui primitives:** add `dropdown-menu.tsx` and `popover.tsx` wrappers over the
  unified `radix-ui` package, matching the existing `dialog.tsx`/`tabs.tsx` style
  (no new dependency — `radix-ui` is already installed).
- **components/chat/ChatHeader.tsx:** slim header on the chat column —
  a model dropdown (current label; lists `listModels`, backend default marked),
  a `History` popover (`listSessions`: title + relative time; click →
  `continueSession`; empty + refresh states), and a `+ New` button. Design-system
  faithful (read `DESIGN.md`): Plex Sans labels, ember only for interactive/active
  state, hairline bottom border, muted-foreground secondary, no gamification,
  honor `prefers-reduced-motion`, nothing below 12px.
- **ChatPanel.tsx:** render `<ChatHeader/>` above the transcript; handle the
  `session` event; reopen the stream (with model/resume) when the connection
  `sessionId` changes. No "Continued" marker needed — the transcript is replayed.

### Frontend behavior notes
- The model picker lists the **active backend's** models (depends on
  `AGENT_BACKEND`). Changing it resets the chat to a new session on that model.
- Continue replays prior **user/assistant text bubbles** only; the tool-activity
  trail is live-only and not replayed. New messages continue the resumed
  conversation.

### Verification (additional)
- `pnpm --filter web typecheck`, `pnpm --filter web build`, `pnpm --filter web test`
  (Vitest) — all green; the existing chat flow still works.
- All server gates remain green; the transcript endpoint covered by an e2e test
  (overridden harness), and each adapter's `getSessionMessages` by a unit test.
