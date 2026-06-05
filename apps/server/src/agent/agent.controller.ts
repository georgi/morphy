import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Sse,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { AgentMessageRequest } from '@chess/shared';
import { AgentService } from './agent.service';

/**
 * SSE bridge between the client and the Pi agent sessions.
 *
 * - GET  /api/agent/:sessionId/stream  — long-lived SSE stream of AgentEvents.
 * - POST /api/agent/:sessionId/messages — post a user message; returns 202. The
 *   answer (streamed text, tool activity, board updates) arrives on the stream.
 *
 * Both keyed by a client-chosen sessionId so the stream and messages line up.
 */
@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  /** Open the per-session event stream. The client subscribes once and keeps it open. */
  @Sse(':sessionId/stream')
  stream(@Param('sessionId') sessionId: string): Observable<MessageEvent> {
    return this.agent.getStream(sessionId);
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
    void this.agent.sendMessage(sessionId, body);
    return { accepted: true };
  }
}
