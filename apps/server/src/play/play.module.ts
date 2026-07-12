import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module";
import { ChessModule } from "../chess/chess.module";
import { EngineModule } from "../engine/engine.module";
import { CharacterRegistry } from "./character-registry.service";
import { PlayController } from "./play.controller";
import { PlayService } from "./play.service";

@Module({
  imports: [ChessModule, EngineModule, AgentModule],
  controllers: [PlayController],
  providers: [PlayService, CharacterRegistry],
})
export class PlayModule {}
