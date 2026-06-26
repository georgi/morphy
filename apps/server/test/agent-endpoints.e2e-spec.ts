import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type {
  ModelInfo,
  SessionSummary,
  TranscriptMessage,
} from '@chess/shared';
import { AppModule } from '../src/app.module';
import {
  AGENT_HARNESS,
  type AgentHarness,
  type AgentRunner,
  type AgentSessionConfig,
} from '../src/agent/harness/agent-harness';

/**
 * REST contract test for the agent discovery endpoints.
 *
 * Boots the application with the `api` global prefix exactly as `main.ts` does,
 * but swaps the real {@link AGENT_HARNESS} provider for a fake whose `listModels`
 * / `listSessions` return known arrays. This keeps the test on the HTTP wiring
 * (controller route + global prefix + service delegation) and away from any SDK,
 * auth, or transcript-store access — the real adapters are never constructed.
 *
 * Only the two static discovery routes are exercised. The SSE stream and posting
 * messages drive a live agent turn (real SDKs), so they live in their own manual
 * / integration surface and are intentionally not touched here.
 */
describe('Agent discovery endpoints (e2e)', () => {
  let app: INestApplication;

  const MODELS: ModelInfo[] = [
    {
      id: 'claude-opus-4-8',
      provider: 'anthropic',
      label: 'Claude Opus 4.8',
      contextWindow: 1_000_000,
    },
    { id: 'gpt-mini', provider: 'openai' },
  ];

  const SESSIONS: SessionSummary[] = [
    {
      id: 'sess-1',
      title: 'Ruy Lopez review',
      createdAt: '2026-06-20T10:00:00.000Z',
      updatedAt: '2026-06-21T12:30:00.000Z',
      messageCount: 8,
    },
    { id: 'sess-2' },
  ];

  const TRANSCRIPT: TranscriptMessage[] = [
    { role: 'user', text: 'why is this losing?' },
    { role: 'assistant', text: 'Your king is exposed.' },
  ];

  // A fake harness that answers the discovery/transcript calls with fixed arrays
  // and refuses the session-lifecycle methods, which this test must never reach.
  const fakeHarness: AgentHarness = {
    listModels: () => Promise.resolve(MODELS),
    listSessions: () => Promise.resolve(SESSIONS),
    getSessionMessages: (_id: string) => Promise.resolve(TRANSCRIPT),
    createSession: (_config: AgentSessionConfig): Promise<AgentRunner> =>
      Promise.reject(new Error('createSession not expected in this test')),
    resumeSession: (
      _sessionId: string,
      _config: AgentSessionConfig,
    ): Promise<AgentRunner> =>
      Promise.reject(new Error('resumeSession not expected in this test')),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AGENT_HARNESS)
      .useValue(fakeHarness)
      .compile();

    app = moduleRef.createNestApplication();
    // Mirror main.ts so the routes here match production exactly.
    app.enableCors();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/agent/models returns the backend models', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/agent/models')
      .expect(200);

    expect(res.body).toEqual(MODELS);
  });

  it('GET /api/agent/sessions returns the backend sessions', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/agent/sessions')
      .expect(200);

    expect(res.body).toEqual(SESSIONS);
  });

  it('GET /api/agent/sessions/:id returns the session transcript', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/agent/sessions/sess-1')
      .expect(200);

    expect(res.body).toEqual(TRANSCRIPT);
  });
});
