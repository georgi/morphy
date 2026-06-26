import { createHarnessFromEnv } from './agent.module';
import { PiHarness } from './harness/pi-harness';
import { ClaudeHarness } from './harness/claude-harness';

/**
 * Unit coverage for the env-driven harness factory. Constructing either adapter
 * lazy-loads its SDK only inside the harness methods, so the factory itself
 * pulls in neither Pi nor Claude — this test needs no SDK install or credentials
 * and asserts purely on the selection logic.
 */
describe('createHarnessFromEnv', () => {
  it('defaults to the Pi backend when AGENT_BACKEND is unset', () => {
    expect(createHarnessFromEnv({})).toBeInstanceOf(PiHarness);
  });

  it('selects the Pi backend for AGENT_BACKEND=pi', () => {
    expect(createHarnessFromEnv({ AGENT_BACKEND: 'pi' })).toBeInstanceOf(
      PiHarness,
    );
  });

  it('selects the Claude backend for AGENT_BACKEND=claude', () => {
    expect(createHarnessFromEnv({ AGENT_BACKEND: 'claude' })).toBeInstanceOf(
      ClaudeHarness,
    );
  });

  it('matches the backend case-insensitively (AGENT_BACKEND=CLAUDE)', () => {
    expect(createHarnessFromEnv({ AGENT_BACKEND: 'CLAUDE' })).toBeInstanceOf(
      ClaudeHarness,
    );
  });
});
