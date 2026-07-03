import { Global, Module } from '@nestjs/common';
import { DATABASE, openDatabase, type Db } from './database';
import { EvalCacheRepository } from './eval-cache.repository';
import { ImportJobsRepository } from './import-jobs.repository';

/**
 * Durable storage layer. Opens the single better-sqlite3 connection on boot
 * (WAL, migrations) and exposes it via the {@link DATABASE} token alongside the
 * {@link EvalCacheRepository} (the only persisted table). `@Global()` so any
 * feature module can inject these without re-importing.
 *
 * {@link ImportJobsRepository} is in-memory (no SQLite backing) but lives here so
 * the import subsystem injects it like any other shared, process-wide singleton.
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: (): Db => openDatabase(),
    },
    EvalCacheRepository,
    ImportJobsRepository,
  ],
  exports: [DATABASE, EvalCacheRepository, ImportJobsRepository],
})
export class PersistenceModule {}
