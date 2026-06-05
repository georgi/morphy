import { Global, Module } from '@nestjs/common';
import { DATABASE, openDatabase, type Db } from './database';
import { GamesRepository } from './games.repository';
import { EvalCacheRepository } from './eval-cache.repository';
import { CollectionsRepository } from './collections.repository';
import { ImportJobsRepository } from './import-jobs.repository';

/**
 * Durable storage layer. Opens the single better-sqlite3 connection on boot
 * (WAL, migrations) and exposes it via the {@link DATABASE} token alongside the
 * repositories. `@Global()` so any feature module can inject these without
 * re-importing.
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: (): Db => openDatabase(),
    },
    GamesRepository,
    EvalCacheRepository,
    CollectionsRepository,
    ImportJobsRepository,
  ],
  exports: [
    DATABASE,
    GamesRepository,
    EvalCacheRepository,
    CollectionsRepository,
    ImportJobsRepository,
  ],
})
export class PersistenceModule {}
