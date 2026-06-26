import { Type } from '@sinclair/typebox';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentEvent } from '@chess/shared';
import type { AgentSessionConfig } from './agent-harness';
import type { AgentTool } from './agent-tool';

// The harness loads the ESM-only SDK through `loadEsm`; mock that single seam so
// the whole test runs against an in-memory fake SDK (no native import, no auth, no
// subprocess). `requireMock` reaches the same module instance the harness imports.
jest.mock('./esm-loader');

import { loadEsm } from './esm-loader';
import { ClaudeHarness } from './claude-harness';

const loadEsmMock = loadEsm as jest.MockedFunction<typeof loadEsm>;

// ── fake SDK message stream ────────────────────────────────────────────────────

/** One scripted turn: the message sequence the harness iterates over per `query()`. */
function turnMessages(sessionId: string): unknown[] {
  return [
    // init/system carries the freshly-minted session id and the resolved model.
    {
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model: 'claude-opus-4-8',
    },
    // partial text deltas arrive as `stream_event`s (includePartialMessages).
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello' },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: ', world' },
      },
    },
    // assistant tool_use opens a tool call; the harness records id -> name. The
    // SDK delivers MCP tool_use blocks with the fully-qualified `mcp__chess__`
    // name, so script that here — the adapter must strip the prefix before it
    // emits, matching the bare names PiHarness uses.
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'mcp__chess__open_game',
            input: { id: 'm' },
          },
        ],
      },
    },
    // user tool_result closes it; only the id is carried, so the harness maps it
    // back to the name it stashed from the tool_use block.
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            is_error: false,
            content: [{ type: 'text', text: 'Opened Carlsen vs Nakamura' }],
          },
        ],
      },
    },
    // a success result ends the turn -> `prompt()` resolves.
    { type: 'result', subtype: 'success', is_error: false },
  ];
}

/**
 * A fake `query()` handle: an async-iterable over the scripted messages that also
 * exposes the `supportedModels()` / `close()` surface the harness calls. Every call
 * pushes its params onto `calls` so the test can assert what the harness sent
 * (notably `resume` on the second turn).
 */
function makeFakeSdk(opts?: {
  models?: unknown[];
  sessions?: unknown[];
  transcript?: unknown[];
}) {
  const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
  // Each turn mints a distinct session id; the harness keeps the first and replays
  // it as `resume` thereafter, so only the first id ever surfaces.
  let turn = 0;

  const query = jest.fn((params: { prompt: unknown; options?: unknown }) => {
    calls.push({
      prompt: params.prompt,
      options: (params.options ?? {}) as Record<string, unknown>,
    });
    const sessionId = `sess-${++turn}`;
    const messages = turnMessages(sessionId);
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
      },
      supportedModels: jest.fn(async () => opts?.models ?? []),
      close: jest.fn(),
    };
  });

  const sdk = {
    query,
    // `tool()` just records its inputs and returns an opaque handle; the harness
    // only forwards it into `createSdkMcpServer`.
    tool: jest.fn((name: string, description: string, inputSchema, handler) => ({
      name,
      description,
      inputSchema,
      handler,
    })),
    // `createSdkMcpServer()` returns a stand-in MCP server config.
    createSdkMcpServer: jest.fn((options) => ({
      type: 'sdk' as const,
      name: options.name,
      instance: {},
      tools: options.tools,
    })),
    listSessions: jest.fn(async () => opts?.sessions ?? []),
    getSessionMessages: jest.fn(async () => opts?.transcript ?? []),
  };

  return { sdk, calls, query };
}

// ── fixtures ───────────────────────────────────────────────────────────────────

/** A minimal neutral tool whose TypeBox params exercise the Zod bridge. */
function fakeTool(): AgentTool {
  return {
    name: 'open_game',
    label: 'Open game',
    description: 'Load a game onto the board',
    parameters: Type.Object({
      id: Type.String({ description: 'Game id' }),
    }),
    execute: jest.fn(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      details: { gameId: 'm' },
    })),
  };
}

/** A session config wired to a fresh event sink the test inspects. */
function makeConfig(): { config: AgentSessionConfig; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    events,
    config: {
      systemPrompt: 'You are a chess coach.',
      tools: [fakeTool()],
      emit: (event) => events.push(event),
      model: 'claude-opus-4-8',
    },
  };
}

describe('ClaudeHarness', () => {
  describe('prompt() message translation', () => {
    it('translates the SDK message stream into AgentEvents', async () => {
      const { sdk } = makeFakeSdk();
      loadEsmMock.mockResolvedValue(sdk);

      const harness = new ClaudeHarness();
      const { config, events } = makeConfig();
      const runner = await harness.createSession(config);

      await runner.prompt('analyse this');

      // The two text deltas surface in order as `text_delta` events.
      const deltas = events.filter((e) => e.type === 'text_delta');
      expect(deltas).toEqual([
        { type: 'text_delta', delta: 'Hello' },
        { type: 'text_delta', delta: ', world' },
      ]);

      // The tool_use block opens a `tool_start` carrying the model's input.
      const start = events.find((e) => e.type === 'tool_start');
      expect(start).toEqual({
        type: 'tool_start',
        tool: 'open_game',
        args: { id: 'm' },
      });

      // The tool_result block closes it; the name is recovered from tool_use_id
      // and the summary is the first text part of the result.
      const end = events.find((e) => e.type === 'tool_end');
      expect(end).toEqual({
        type: 'tool_end',
        tool: 'open_game',
        ok: true,
        summary: 'Opened Carlsen vs Nakamura',
      });
    });

    it('emits a single `session` event with the captured id and model', async () => {
      const { sdk } = makeFakeSdk();
      loadEsmMock.mockResolvedValue(sdk);

      const harness = new ClaudeHarness();
      const { config, events } = makeConfig();
      const runner = await harness.createSession(config);

      await runner.prompt('first');
      // A second turn must not re-announce the session id.
      await runner.prompt('second');

      const sessions = events.filter((e) => e.type === 'session');
      expect(sessions).toEqual([
        { type: 'session', id: 'sess-1', model: 'claude-opus-4-8' },
      ]);
      // The runner exposes the same captured id.
      expect(runner.id).toBe('sess-1');
    });
  });

  describe('prompt() error result', () => {
    /** A turn that ends in a non-success result with the given fields. */
    function errorTurn(result: Record<string, unknown>): unknown[] {
      return [
        { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm' },
        { type: 'result', ...result },
      ];
    }

    /** A fake SDK whose single turn yields the given error result message. */
    function makeErrorSdk(result: Record<string, unknown>) {
      const messages = errorTurn(result);
      return {
        query: jest.fn(() => ({
          async *[Symbol.asyncIterator]() {
            for (const message of messages) yield message;
          },
          supportedModels: jest.fn(async () => []),
          close: jest.fn(),
        })),
        tool: jest.fn((name, description, inputSchema, handler) => ({
          name,
          description,
          inputSchema,
          handler,
        })),
        createSdkMcpServer: jest.fn(() => ({ type: 'sdk', instance: {} })),
        listSessions: jest.fn(async () => []),
        getSessionMessages: jest.fn(async () => []),
      };
    }

    it('throws joining message.errors when the turn fails', async () => {
      loadEsmMock.mockResolvedValue(
        makeErrorSdk({
          subtype: 'error_max_turns',
          is_error: true,
          errors: ['rate limited', 'try later'],
        }),
      );

      const harness = new ClaudeHarness();
      const { config } = makeConfig();
      const runner = await harness.createSession(config);

      await expect(runner.prompt('go')).rejects.toThrow(
        'Claude turn failed: rate limited; try later',
      );
    });

    it('falls back to the subtype when no errors array is present', async () => {
      loadEsmMock.mockResolvedValue(
        makeErrorSdk({ subtype: 'error_during_execution', is_error: true }),
      );

      const harness = new ClaudeHarness();
      const { config } = makeConfig();
      const runner = await harness.createSession(config);

      await expect(runner.prompt('go')).rejects.toThrow(
        'Claude turn failed: error_during_execution',
      );
    });

    it('uses the `result` text (and status) when a success result sets is_error', async () => {
      // A `success` subtype carries no `errors` array; the real reason lives in
      // `result` with an optional `api_error_status`.
      loadEsmMock.mockResolvedValue(
        makeErrorSdk({
          subtype: 'success',
          is_error: true,
          result: 'Insufficient balance',
          api_error_status: 402,
        }),
      );

      const harness = new ClaudeHarness();
      const { config } = makeConfig();
      const runner = await harness.createSession(config);

      await expect(runner.prompt('go')).rejects.toThrow(
        'Claude turn failed: Insufficient balance (status 402)',
      );
    });
  });

  describe('resume', () => {
    it('omits resume on the first turn and passes the captured id on the second', async () => {
      const { sdk, calls } = makeFakeSdk();
      loadEsmMock.mockResolvedValue(sdk);

      const harness = new ClaudeHarness();
      const { config } = makeConfig();
      const runner = await harness.createSession(config);

      await runner.prompt('first');
      await runner.prompt('second');

      expect(calls).toHaveLength(2);
      // First turn mints the id, so it carries no `resume`.
      expect(calls[0].options).not.toHaveProperty('resume');
      expect(calls[0].prompt).toBe('first');
      // Second turn replays the id captured from the init message.
      expect(calls[1].options.resume).toBe('sess-1');
      expect(calls[1].prompt).toBe('second');
    });

    it('passes resume on the very first turn of a resumed session', async () => {
      const { sdk, calls } = makeFakeSdk();
      loadEsmMock.mockResolvedValue(sdk);

      const harness = new ClaudeHarness();
      const { config } = makeConfig();
      const runner = await harness.resumeSession('seed-session', config);

      // The seed id is exposed before any turn runs.
      expect(runner.id).toBe('seed-session');

      await runner.prompt('continue');

      expect(calls[0].options.resume).toBe('seed-session');
    });

    it('emits the session event once on resume, with the seeded id', async () => {
      const { sdk } = makeFakeSdk();
      loadEsmMock.mockResolvedValue(sdk);

      const harness = new ClaudeHarness();
      const { config, events } = makeConfig();
      const runner = await harness.resumeSession('seed', config);

      await runner.prompt('continue');
      // A second turn must not re-announce; the init message's `sess-1` id must not
      // win over the seeded `seed` id either.
      await runner.prompt('again');

      const sessions = events.filter((e) => e.type === 'session');
      expect(sessions).toEqual([
        { type: 'session', id: 'seed', model: 'claude-opus-4-8' },
      ]);
      expect(runner.id).toBe('seed');
    });
  });

  describe('tool wiring', () => {
    it('bridges each neutral tool into a Zod-shaped `tool()` on the MCP server', async () => {
      const { sdk } = makeFakeSdk();
      loadEsmMock.mockResolvedValue(sdk);

      const harness = new ClaudeHarness();
      const { config } = makeConfig();
      await harness.createSession(config);

      expect(sdk.createSdkMcpServer).toHaveBeenCalledTimes(1);
      const serverArgs = sdk.createSdkMcpServer.mock.calls[0][0];
      expect(serverArgs.name).toBe('chess');

      // One `tool()` per neutral tool, with name + description forwarded and a Zod
      // shape produced by the TypeBox bridge.
      expect(sdk.tool).toHaveBeenCalledTimes(1);
      const [name, description, inputSchema] = sdk.tool.mock.calls[0];
      expect(name).toBe('open_game');
      expect(description).toBe('Load a game onto the board');
      // The bridge yields a flat record of property name -> Zod type.
      expect(Object.keys(inputSchema)).toEqual(['id']);
      expect(typeof (inputSchema as Record<string, unknown>).id).toBe('object');
    });
  });

  describe('listModels()', () => {
    it('maps supportedModels() output to ModelInfo[]', async () => {
      const { sdk, query } = makeFakeSdk({
        models: [
          {
            value: 'claude-opus-4-8',
            displayName: 'Claude Opus 4.8',
            description: 'Most capable',
          },
          {
            value: 'claude-haiku-4',
            displayName: 'Claude Haiku 4',
            description: 'Fast',
          },
        ],
      });
      loadEsmMock.mockResolvedValue(sdk);

      const harness = new ClaudeHarness();
      const models = await harness.listModels();

      expect(models).toEqual([
        { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
        { id: 'claude-haiku-4', label: 'Claude Haiku 4' },
      ]);
      // The probe opens a query and tears it down without running a turn.
      expect(query).toHaveBeenCalledTimes(1);
      const handle = query.mock.results[0].value;
      expect(handle.close).toHaveBeenCalled();
    });
  });

  describe('listSessions()', () => {
    it('returns [] when the transcript dir is absent', async () => {
      const { sdk } = makeFakeSdk();
      // Point the SDK at a directory that does not exist: it raises ENOENT, which
      // the harness must treat as "no sessions yet" rather than an error.
      const missingDir = join(tmpdir(), `morphy-no-such-${Date.now()}`);
      sdk.listSessions.mockRejectedValue(
        Object.assign(new Error(`ENOENT: ${missingDir}`), { code: 'ENOENT' }),
      );
      loadEsmMock.mockResolvedValue(sdk);

      const harness = new ClaudeHarness();
      await expect(harness.listSessions()).resolves.toEqual([]);
    });

    it('maps stored sessions to SessionSummary[]', async () => {
      const { sdk } = makeFakeSdk({
        sessions: [
          {
            sessionId: 'sess-1',
            summary: 'Najdorf review',
            firstPrompt: 'Look at this Najdorf',
            createdAt: Date.UTC(2026, 5, 1, 12, 0, 0),
            lastModified: Date.UTC(2026, 5, 2, 9, 30, 0),
          },
        ],
      });
      loadEsmMock.mockResolvedValue(sdk);

      const harness = new ClaudeHarness();
      const sessions = await harness.listSessions();

      expect(sessions).toEqual([
        {
          id: 'sess-1',
          title: 'Najdorf review',
          createdAt: new Date(Date.UTC(2026, 5, 1, 12, 0, 0)).toISOString(),
          updatedAt: new Date(Date.UTC(2026, 5, 2, 9, 30, 0)).toISOString(),
        },
      ]);
    });

    it('rethrows non-ENOENT errors', async () => {
      const { sdk } = makeFakeSdk();
      sdk.listSessions.mockRejectedValue(new Error('disk on fire'));
      loadEsmMock.mockResolvedValue(sdk);

      const harness = new ClaudeHarness();
      await expect(harness.listSessions()).rejects.toThrow('disk on fire');
    });
  });

  describe('getSessionMessages()', () => {
    it('maps user/assistant text turns and drops tool-only turns', async () => {
      const { sdk } = makeFakeSdk({
        transcript: [
          // user turn: bare string content.
          { type: 'user', message: { content: 'why is this losing?' } },
          // assistant turn: text blocks (a tool_use block contributes nothing).
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'Because ' },
                { type: 'text', text: 'your king is exposed.' },
                { type: 'tool_use', id: 't1', name: 'open_game', input: {} },
              ],
            },
          },
          // user turn that is only a tool_result -> no plain text -> dropped.
          {
            type: 'user',
            message: {
              content: [
                { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
              ],
            },
          },
          // a system entry is dropped regardless of content.
          { type: 'system', message: { content: 'init' } },
        ],
      });
      loadEsmMock.mockResolvedValue(sdk);

      const harness = new ClaudeHarness();
      const messages = await harness.getSessionMessages('sess-1');

      expect(messages).toEqual([
        { role: 'user', text: 'why is this losing?' },
        { role: 'assistant', text: 'Because your king is exposed.' },
      ]);
    });

    it('returns [] for an unknown session (the SDK degrades to [])', async () => {
      const { sdk } = makeFakeSdk();
      loadEsmMock.mockResolvedValue(sdk);

      const harness = new ClaudeHarness();
      await expect(harness.getSessionMessages('nope')).resolves.toEqual([]);
    });
  });
});
