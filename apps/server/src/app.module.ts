import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { PersistenceModule } from './persistence/persistence.module';
import { EngineModule } from './engine/engine.module';
import { ChessModule } from './chess/chess.module';
import { AnalysisModule } from './analysis/analysis.module';
import { ApiModule } from './api/api.module';
import { AgentModule } from './agent/agent.module';
import { LibraryModule } from './library/library.module';
import { ImportModule } from './import/import.module';

@Module({
  imports: [
    PersistenceModule,
    EngineModule,
    ChessModule,
    AnalysisModule,
    ApiModule,
    AgentModule,
    LibraryModule,
    ImportModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
