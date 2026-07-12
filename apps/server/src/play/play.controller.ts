import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Sse,
} from "@nestjs/common";
import type { MessageEvent } from "@nestjs/common";
import type { Observable } from "rxjs";
import type {
  Character,
  CreatePlayGameRequest,
  PlayChatRequest,
  PlayGame,
  PlayMoveRequest,
} from "@chess/shared";
import { CharacterRegistry } from "./character-registry.service";
import { PlayService } from "./play.service";

/**
 * Play-mode REST + SSE. `characters` is declared before `:id` routes so Nest
 * matches the literal segment first (same trick as AgentController).
 */
@Controller("play")
export class PlayController {
  private readonly logger = new Logger(PlayController.name);

  constructor(
    private readonly play: PlayService,
    private readonly registry: CharacterRegistry,
  ) {}

  @Get("characters")
  listCharacters(): Character[] {
    return this.registry.list();
  }

  @Post()
  create(@Body() body: CreatePlayGameRequest): Promise<PlayGame> {
    return this.play.createGame(body);
  }

  @Get(":id")
  get(@Param("id") id: string): PlayGame {
    return this.play.getGame(id);
  }

  @Post(":id/move")
  move(@Param("id") id: string, @Body() body: PlayMoveRequest): Promise<PlayGame> {
    return this.play.userMove(id, body.move);
  }

  @Post(":id/resign")
  resign(@Param("id") id: string): Promise<PlayGame> {
    return this.play.resign(id);
  }

  @Post(":id/draw-offer")
  @HttpCode(HttpStatus.ACCEPTED)
  async drawOffer(@Param("id") id: string): Promise<{ accepted: true }> {
    this.play
      .offerDraw(id)
      .catch((err) => this.logger.warn(`draw-offer failed: ${String(err)}`));
    return { accepted: true };
  }

  @Post(":id/chat")
  @HttpCode(HttpStatus.ACCEPTED)
  async chat(
    @Param("id") id: string,
    @Body() body: PlayChatRequest,
  ): Promise<{ accepted: true }> {
    this.play
      .chat(id, body.text)
      .catch((err) => this.logger.warn(`chat failed: ${String(err)}`));
    return { accepted: true };
  }

  @Sse(":id/events")
  events(@Param("id") id: string): Observable<MessageEvent> {
    return this.play.getStream(id);
  }
}
