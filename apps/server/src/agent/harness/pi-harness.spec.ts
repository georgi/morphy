import { Type } from '@sinclair/typebox';
import type { AgentEvent } from '@chess/shared';

import type { AgentSessionConfig } from './agent-harness';
import type { AgentTool } from './agent-tool';

// ── fake Pi SDK ────────────────────────────────────────────────────────────────
//
// The Pi SDK is ESM-only and reached exclusively through `loadEsm`. We mock that
// module so the adapter loads a hand-rolled SDK instead of the real package: this
// keeps the test pure (no native import, no ~/.pi auth/session files) and lets us
// drive the exact session-event shapes the adapter translates. The fakes live in
// module scope so the test body can reach in and assert on them.

/** A subscriber registered on the fake session, plus the captured unsubscribe. */
type SessionListener = (event: unknown) => void;

/**
 * A minimal stand-in for a Pi `AgentSession`: records subscribers (so the test can
 * fire events through them), captures prompts, and exposes a mutable `state` whose
 * `errorMessage` the adapter reads after each turn.
 */
class FakeSession {
  readonly sessionId = 'pi-session-7';
  readonly model = { id: 'anthropic/opus' };
  readonly state: { errorMessage?: string } = {};
  /** The single subscriber the adapter registers (we only ever attach one). */
  listener?: SessionListener;
  unsubscribed = false;
  disposed = false;
  readonly prompts: string[] = [];

  subscribe(listener: SessionListener): () => void {
    this.listener = listener;
    return () => {
      this.unsubscribed = true;
    };
  }

  /** Fire a raw Pi event through the registered subscriber. */
  fire(event: unknown): void {
    this.listener?.(event);
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** The Pi `SessionInfo` shape `listSessions` reads (only the fields it touches). */
interface FakeSessionInfo {
  id: string;
  path: string;
  name?: string;
  firstMessage?: string;
  created: Date;
  modified: Date;
  messageCount: number;
}

/** Captures the `defineTool` payload so the test can invoke the wrapped `execute`. */
interface WrappedTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: unknown) => Promise<unknown>;
}

/** The live fakes the SDK factory hands out, exposed for assertions. */
const sdkState: {
  session: FakeSession;
  createArgs?: Record<string, unknown>;
  definedTools: WrappedTool[];
  // The Date instances `listSessions` maps onto ISO strings.
  created: Date;
  modified: Date;
} = {
  session: new FakeSession(),
  definedTools: [],
  created: new Date('2026-06-01T10:00:00.000Z'),
  modified: new Date('2026-06-02T11:30:00.000Z'),
};

/** Build a fresh fake SDK; called once per test via `beforeEach`. */
function makeFakeSdk() {
  return {
    // createAgentSession records its arguments and returns the live fake session.
    createAgentSession: jest.fn(async (args: Record<string, unknown>) => {
      sdkState.createArgs = args;
      return { session: sdkState.session };
    }),

    // defineTool is identity in Pi; we just record what the adapter wrapped so the
    // test can drive the `(id, params)` arity itself.
    defineTool: jest.fn((tool: WrappedTool) => {
      sdkState.definedTools.push(tool);
      return tool;
    }),

    getAgentDir: jest.fn(() => '/tmp/fake-agent-dir'),

    SessionManager: {
      inMemory: jest.fn(() => ({ kind: 'in-memory' })),
      create: jest.fn(() => ({
        setSessionFile: jest.fn(),
      })),
      list: jest.fn(
        async (): Promise<FakeSessionInfo[]> => [
          {
            id: 'pi-session-7',
            path: '/tmp/fake-sessions/pi-session-7.jsonl',
            name: 'Najdorf review',
            firstMessage: 'help me understand this game',
            created: sdkState.created,
            modified: sdkState.modified,
            messageCount: 12,
          },
        ],
      ),
      listAll: jest.fn(async (): Promise<FakeSessionInfo[]> => []),
    },

    // parseSessionEntries is the static read path getSessionMessages uses; the fake
    // stores JSON, so parsing is just JSON.parse of the file content.
    parseSessionEntries: jest.fn((content: string) => JSON.parse(content)),

    // DefaultResourceLoader only needs a `reload()` the adapter awaits.
    DefaultResourceLoader: jest.fn().mockImplementation(() => ({
      reload: jest.fn(async () => undefined),
    })),

    ModelRegistry: {
      create: jest.fn(() => ({
        getAvailable: jest.fn(() => [
          {
            id: 'anthropic/opus',
            provider: 'anthropic',
            contextWindow: 200000,
            name: 'Claude Opus',
          },
        ]),
        getAll: jest.fn(() => [
          { id: 'anthropic/opus', provider: 'anthropic' },
          { id: 'openai/gpt', provider: 'openai' },
        ]),
      })),
    },

    AuthStorage: {
      create: jest.fn(() => ({ kind: 'auth' })),
    },
  };
}

let fakeSdk: ReturnType<typeof makeFakeSdk>;

// The mock factory reads `fakeSdk` lazily (set in `beforeEach`) so each test gets a
// clean SDK; the factory itself is hoisted above the imports by Jest.
jest.mock('./esm-loader', () => ({
  loadEsm: jest.fn(async () => fakeSdk),
}));

// getSessionMessages reads the resolved session file statically; mock readFile so
// the test scripts the stored entries without touching the real filesystem.
jest.mock('node:fs/promises', () => ({ readFile: jest.fn() }));
import { readFile } from 'node:fs/promises';

// Imported after the mock is registered so the adapter binds to the mocked loader.
import { PiHarness } from './pi-harness';

/** A neutral tool whose `execute` records its params, to prove the `(_id, params)` unwrap. */
function makeTool(): {
  tool: AgentTool;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const tool: AgentTool = {
    name: 'open_game',
    label: 'Open game',
    description: 'Load a game onto the board',
    parameters: Type.Object({ id: Type.String() }),
    execute: async (params) => {
      calls.push(params);
      return {
        content: [{ type: 'text', text: `opened ${(params as { id: string }).id}` }],
      };
    },
  };
  return { tool, calls };
}

/** A session config wired to an array sink, mirroring the real SSE subject. */
function makeConfig(tools: AgentTool[]): {
  config: AgentSessionConfig;
  emitted: AgentEvent[];
} {
  const emitted: AgentEvent[] = [];
  const config: AgentSessionConfig = {
    systemPrompt: 'You are a chess coach.',
    tools,
    emit: (event) => emitted.push(event),
  };
  return { config, emitted };
}

describe('PiHarness', () => {
  beforeEach(() => {
    fakeSdk = makeFakeSdk();
    sdkState.session = new FakeSession();
    sdkState.createArgs = undefined;
    sdkState.definedTools = [];
  });

  describe('event translation', () => {
    it('translates a Pi text_delta into a text_delta AgentEvent', async () => {
      const { config, emitted } = makeConfig([]);
      await new PiHarness().createSession(config);

      sdkState.session.fire({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Nf3 ' },
      });

      expect(emitted).toContainEqual({ type: 'text_delta', delta: 'Nf3 ' });
    });

    it('translates tool_execution_start into a tool_start AgentEvent', async () => {
      const { config, emitted } = makeConfig([]);
      await new PiHarness().createSession(config);

      sdkState.session.fire({
        type: 'tool_execution_start',
        toolName: 'open_game',
        args: { id: 'm' },
      });

      expect(emitted).toContainEqual({
        type: 'tool_start',
        tool: 'open_game',
        args: { id: 'm' },
      });
    });

    it('translates tool_execution_end into a tool_end AgentEvent with a summary', async () => {
      const { config, emitted } = makeConfig([]);
      await new PiHarness().createSession(config);

      sdkState.session.fire({
        type: 'tool_execution_end',
        toolName: 'open_game',
        isError: false,
        result: {
          content: [{ type: 'text', text: 'Magnus Carlsen vs Hikaru Nakamura\nmore' }],
        },
      });

      expect(emitted).toContainEqual({
        type: 'tool_end',
        tool: 'open_game',
        ok: true,
        summary: 'Magnus Carlsen vs Hikaru Nakamura',
      });
    });

    it('marks a failed tool_execution_end as not ok', async () => {
      const { config, emitted } = makeConfig([]);
      await new PiHarness().createSession(config);

      sdkState.session.fire({
        type: 'tool_execution_end',
        toolName: 'open_game',
        isError: true,
        result: { content: [{ type: 'text', text: 'not found' }] },
      });

      const end = emitted.find((e) => e.type === 'tool_end');
      expect(end).toMatchObject({ type: 'tool_end', tool: 'open_game', ok: false });
    });
  });

  describe('session event', () => {
    it('does not emit the session event until the first prompt', async () => {
      const { config, emitted } = makeConfig([]);
      const runner = await new PiHarness().createSession(config);

      expect(emitted.find((e) => e.type === 'session')).toBeUndefined();
      // The runner id is still available synchronously (the resume handle).
      expect(runner.id).toBe('pi-session-7');
    });

    it('emits the session event once at the start of the first prompt', async () => {
      const { config, emitted } = makeConfig([]);
      const runner = await new PiHarness().createSession(config);

      await runner.prompt('first');
      await runner.prompt('second');

      const sessionEvents = emitted.filter((e) => e.type === 'session');
      expect(sessionEvents).toEqual([
        { type: 'session', id: 'pi-session-7', model: 'anthropic/opus' },
      ]);
    });
  });

  describe('prompt()', () => {
    it('resolves normally and forwards the text to the session', async () => {
      const { config } = makeConfig([]);
      const runner = await new PiHarness().createSession(config);

      await expect(runner.prompt('why is this losing?')).resolves.toBeUndefined();
      expect(sdkState.session.prompts).toEqual(['why is this losing?']);
    });

    it('throws when the session state carries an errorMessage', async () => {
      const { config } = makeConfig([]);
      const runner = await new PiHarness().createSession(config);

      sdkState.session.state.errorMessage = 'model overloaded';

      await expect(runner.prompt('go')).rejects.toThrow('model overloaded');
    });
  });

  describe('tool wrapping', () => {
    it('wraps a neutral tool so Pi (_id, params) calls reach execute with just params', async () => {
      const { tool, calls } = makeTool();
      const { config } = makeConfig([tool]);
      await new PiHarness().createSession(config);

      // The adapter defined exactly one Pi tool, carrying our neutral metadata.
      expect(sdkState.definedTools).toHaveLength(1);
      const wrapped = sdkState.definedTools[0];
      expect(wrapped).toMatchObject({
        name: 'open_game',
        label: 'Open game',
        description: 'Load a game onto the board',
      });

      // Pi calls execute with a leading tool-call id; the neutral tool sees params only.
      const result = (await wrapped.execute('call-123', { id: 'm' })) as {
        content: { type: string; text: string }[];
        details: Record<string, unknown>;
      };
      expect(calls).toEqual([{ id: 'm' }]);
      expect(result.content[0].text).toBe('opened m');
      // The adapter backfills `details` (Pi requires it; the neutral result omits it).
      expect(result.details).toEqual({});

      // The session was built with the wrapped tool registered by name.
      expect(sdkState.createArgs).toMatchObject({
        noTools: 'builtin',
        tools: ['open_game'],
      });
    });
  });

  describe('listModels()', () => {
    it('maps the Pi available models to ModelInfo[]', async () => {
      const models = await new PiHarness().listModels();

      expect(models).toEqual([
        {
          id: 'anthropic/opus',
          provider: 'anthropic',
          contextWindow: 200000,
          label: 'Claude Opus',
        },
      ]);
    });
  });

  describe('listSessions()', () => {
    it('maps Pi SessionInfo to SessionSummary[] with ISO dates', async () => {
      const sessions = await new PiHarness().listSessions();

      expect(sessions).toEqual([
        {
          id: 'pi-session-7',
          title: 'Najdorf review',
          createdAt: sdkState.created.toISOString(),
          updatedAt: sdkState.modified.toISOString(),
          messageCount: 12,
        },
      ]);
    });

    it('falls back to listAll() when the cwd-scoped list is empty', async () => {
      fakeSdk.SessionManager.list.mockResolvedValueOnce([]);
      fakeSdk.SessionManager.listAll.mockResolvedValueOnce([
        {
          id: 'other',
          path: '/tmp/fake-sessions/other.jsonl',
          name: undefined,
          firstMessage: 'first prompt line\nrest',
          created: sdkState.created,
          modified: sdkState.modified,
          messageCount: 3,
        },
      ]);

      const sessions = await new PiHarness().listSessions();

      expect(fakeSdk.SessionManager.listAll).toHaveBeenCalled();
      // With no `name`, the title falls back to the first line of `firstMessage`.
      expect(sessions[0]).toMatchObject({
        id: 'other',
        title: 'first prompt line',
        messageCount: 3,
      });
    });
  });

  describe('getSessionMessages()', () => {
    it('maps user/assistant message entries to TranscriptMessage[] and skips the rest', async () => {
      (readFile as jest.Mock).mockResolvedValueOnce(
        JSON.stringify([
          { type: 'session', id: 'pi-session-7' },
          {
            type: 'message',
            message: { role: 'user', content: 'why is this losing?' },
          },
          {
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'hmm' },
                { type: 'text', text: 'Because ' },
                { type: 'text', text: 'your king is exposed.' },
                { type: 'toolCall', id: 't1', name: 'open_game', arguments: {} },
              ],
            },
          },
          {
            type: 'message',
            message: {
              role: 'toolResult',
              toolName: 'open_game',
              content: [],
              isError: false,
            },
          },
          { type: 'model_change', provider: 'anthropic', modelId: 'opus' },
        ]),
      );

      const messages = await new PiHarness().getSessionMessages('pi-session-7');

      expect(messages).toEqual([
        { role: 'user', text: 'why is this losing?' },
        { role: 'assistant', text: 'Because your king is exposed.' },
      ]);
    });

    it('returns [] when the session id is unknown', async () => {
      fakeSdk.SessionManager.list.mockResolvedValueOnce([]);
      fakeSdk.SessionManager.listAll.mockResolvedValueOnce([]);
      expect(await new PiHarness().getSessionMessages('nope')).toEqual([]);
    });
  });
});
