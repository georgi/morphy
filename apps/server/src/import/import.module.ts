import { Module } from '@nestjs/common';
import { ChessModule } from '../chess/chess.module';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { UrlSource } from './sources/url.source';
import { LichessSource } from './sources/lichess.source';
import { ChessComSource } from './sources/chesscom.source';
import { CatalogSource } from './sources/catalog.source';
import { PgnSplitter } from './pgn-splitter';

/**
 * Bulk-import subsystem. Depends on the `@Global()` PersistenceModule for the
 * (in-memory) import-jobs repository, and on {@link ChessModule} for the
 * probe-hardened PGN parser. {@link ImportService} is exported so a later agent
 * `import_games` tool can reuse it.
 *
 * The remote sources take an injectable `FetchFn` (defaulting to the global
 * `fetch`) as their first constructor argument, which Nest's reflection cannot
 * resolve — so they are wired as zero-dependency factory providers that let the
 * constructor defaults stand. Tests construct them directly with a stub fetch.
 */
@Module({
  imports: [ChessModule],
  controllers: [ImportController],
  providers: [
    ImportService,
    UrlSource,
    PgnSplitter,
    { provide: LichessSource, useFactory: () => new LichessSource() },
    { provide: ChessComSource, useFactory: () => new ChessComSource() },
    { provide: CatalogSource, useFactory: () => new CatalogSource() },
  ],
  exports: [ImportService],
})
export class ImportModule {}
