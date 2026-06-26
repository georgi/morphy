import type { AgentEvent } from '@chess/shared';
import { ClaudeHarness } from '../src/agent/harness/claude-harness';

/**
 * Opt-in live smoke test for the Claude Agent SDK backend, mirroring the network
 * smoke spec for the import sources. It runs the REAL SDK (a subprocess + a real
 * model turn against Anthropic), so it is skipped by default and only runs when
 * `RUN_CLAUDE_TESTS=1`. The deterministic behavior — message translation, session
 * emit, error detail, transcript reading — is covered by `claude-harness.spec.ts`
 * against a fake SDK; this is just a live wiring sanity check.
 *
 * Credentials: the SDK authenticates the same way the Claude Code CLI does — either
 * an `ANTHROPIC_API_KEY` in the environment, or an existing Claude Code login
 * (`~/.claude` OAuth). No key is read by this harness directly; the SDK subprocess
 * resolves auth. It lives under `test/` (not `src/`) and matches neither jest
 * suite's `testRegex`, so the normal `test:unit` / `test:e2e` runs never touch it;
 * run it by naming the file explicitly:
 * `RUN_CLAUDE_TESTS=1 pnpm --filter server exec jest --config ./test/jest-e2e.json test/claude-harness.smoke.spec.ts`.
 */
const live = process.env.RUN_CLAUDE_TESTS ? describe : describe.skip;

live('ClaudeHarness (live smoke)', () => {
  jest.setTimeout(120_000);

  it('lists models, runs one real prompt turn, and stores the session', async () => {
    const harness = new ClaudeHarness();

    const models = await harness.listModels();
    expect(models.length).toBeGreaterThan(0);

    const events: AgentEvent[] = [];
    // No tools — the cheapest possible turn through the real query() loop.
    const runner = await harness.createSession({
      systemPrompt: 'You are a terse assistant.',
      tools: [],
      emit: (e) => events.push(e),
    });

    // One turn; resolving is itself the success assertion (prompt() throws on a
    // failed result), and some assistant text must have streamed through.
    await runner.prompt('Say the single word: ready.');
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(runner.id).toBeTruthy();

    // The just-created session is now in the SDK-native store for the server cwd.
    const sessions = await harness.listSessions();
    expect(sessions.some((s) => s.id === runner.id)).toBe(true);
  });
});
