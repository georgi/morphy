import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type {
  AgentMessageRequest,
  ModelInfo,
  SessionSummary,
  TranscriptMessage,
} from '@chess/shared';
import { AgentService } from './agent.service';

/**
 * SSE bridge between the client and the agent sessions, plus model/session
 * discovery for the picker and continue UI.
 *
 * - GET  /api/agent/models   — models the active backend offers.
 * - GET  /api/agent/sessions — the active backend's stored sessions.
 * - GET  /api/agent/sessions/:id — a stored session's user/assistant transcript.
 * - GET  /api/agent/:sessionId/stream  — long-lived SSE stream of AgentEvents.
 *   Accepts `?model=<id>` and `?resume=<sdkSessionId>` (honored on first access).
 * - POST /api/agent/:sessionId/messages — post a user message; returns 202. The
 *   answer (streamed text, tool activity, board updates) arrives on the stream.
 *
 * The streaming routes are keyed by a client-chosen sessionId so the stream and
 * messages line up. The `models`/`sessions`/`sessions/:id` routes (all rooted at
 * literal segments) are declared before the `:sessionId/...` routes so Nest matches
 * them first.
 */
@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(private readonly agent: AgentService) {}

  /** List the models the active backend offers. */
  @Get('models')
  listModels(): Promise<ModelInfo[]> {
    return this.agent.listModels();
  }

  /** List the active backend's stored sessions. */
  @Get('sessions')
  listSessions(): Promise<SessionSummary[]> {
    return this.agent.listSessions();
  }

  /** Replay a stored session's user/assistant text turns, for the continue UI. */
  @Get('sessions/:id')
  getSessionMessages(@Param('id') id: string): Promise<TranscriptMessage[]> {
    return this.agent.getSessionMessages(id);
  }

  /**
   * Open the per-session event stream. The client subscribes once and keeps it
   * open. `model`/`resume` are threaded into session creation on first access.
   */
  @Sse(':sessionId/stream')
  stream(
    @Param('sessionId') sessionId: string,
    @Query('model') model?: string,
    @Query('resume') resume?: string,
  ): Observable<MessageEvent> {
    return this.agent.getStream(sessionId, { model, resume });
  }

  /**
   * Post a user message into a session. Accepted asynchronously: the agent runs
   * the turn and emits results onto the SSE stream, so we return 202 immediately
   * rather than blocking the request on the full turn.
   */
  @Post(':sessionId/messages')
  @HttpCode(HttpStatus.ACCEPTED)
  postMessage(
    @Param('sessionId') sessionId: string,
    @Body() body: AgentMessageRequest,
  ): { accepted: true } {
    this.agent
      .sendMessage(sessionId, body)
      .catch((err) => this.logger.warn(`sendMessage failed: ${String(err)}`));
    return { accepted: true };
  }
}
