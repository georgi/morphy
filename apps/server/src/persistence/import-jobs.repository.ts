import { Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import type { ImportJob, ImportSource, StartImportRequest } from '@chess/shared';
import { DATABASE, type Db } from './database';

/** Fields supplied when creating an import job; counts/timestamps are managed. */
export interface NewImportJob {
  source: ImportSource;
  /** The original request, stored as JSON for diagnostics / poll responses. */
  params?: StartImportRequest;
  /** Initial status; defaults to `'running'` (the pipeline starts immediately). */
  status?: ImportJob['status'];
  /** Known total game count up front, when the source can report it. */
  total?: number;
  /** Collection these games are linked to, when a collection was created. */
  collectionId?: string;
}

/** Mutable progress/result fields the pipeline writes as it advances. */
export interface ImportJobUpdate {
  status?: ImportJob['status'];
  total?: number;
  imported?: number;
  skipped?: number;
  failed?: number;
  collectionId?: string;
  error?: string;
}

/** Row shape for the `import_jobs` table (snake_case columns). */
interface ImportJobRow {
  id: string;
  source: string;
  params: string | null;
  status: string;
  total: number | null;
  imported: number;
  skipped: number;
  failed: number;
  collection_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Synchronous CRUD over the `import_jobs` table. A row tracks one bulk-import
 * job's lifecycle (`pending` → `running` → `done`/`error`) and its running
 * counts. The pipeline updates this row as it streams; the row is the poll
 * fallback (`GET /api/import/:jobId`) when an SSE client reconnects.
 */
@Injectable()
export class ImportJobsRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  /** Create a job row and return its {@link ImportJob} projection. */
  create(input: NewImportJob): ImportJob {
    const now = Date.now();
    const row: ImportJobRow = {
      id: uuidv4(),
      source: input.source,
      params: input.params ? JSON.stringify(input.params) : null,
      status: input.status ?? 'running',
      total: input.total ?? null,
      imported: 0,
      skipped: 0,
      failed: 0,
      collection_id: input.collectionId ?? null,
      error: null,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO import_jobs
           (id, source, params, status, total, imported, skipped, failed,
            collection_id, error, created_at, updated_at)
         VALUES
           (@id, @source, @params, @status, @total, @imported, @skipped, @failed,
            @collection_id, @error, @created_at, @updated_at)`,
      )
      .run(row);
    return this.fromRow(row);
  }

  /** Look up a job by id, or `undefined` if absent. */
  get(id: string): ImportJob | undefined {
    const row = this.db
      .prepare('SELECT * FROM import_jobs WHERE id = ?')
      .get(id) as ImportJobRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  /**
   * Apply a partial update to a job row (status, counts, collection, error),
   * bumping `updated_at`. Only the provided fields change; omitted fields keep
   * their stored value. Returns the updated {@link ImportJob}, or `undefined` if
   * the job does not exist.
   */
  update(id: string, patch: ImportJobUpdate): ImportJob | undefined {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, updated_at: Date.now() };

    const assign = (column: string, value: unknown): void => {
      sets.push(`${column} = @${column}`);
      params[column] = value;
    };

    if (patch.status !== undefined) assign('status', patch.status);
    if (patch.total !== undefined) assign('total', patch.total);
    if (patch.imported !== undefined) assign('imported', patch.imported);
    if (patch.skipped !== undefined) assign('skipped', patch.skipped);
    if (patch.failed !== undefined) assign('failed', patch.failed);
    if (patch.collectionId !== undefined)
      assign('collection_id', patch.collectionId);
    if (patch.error !== undefined) assign('error', patch.error);

    if (sets.length === 0) return this.get(id);

    const info = this.db
      .prepare(
        `UPDATE import_jobs SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`,
      )
      .run(params);
    if (info.changes === 0) return undefined;
    return this.get(id);
  }

  private fromRow(row: ImportJobRow): ImportJob {
    const job: ImportJob = {
      id: row.id,
      source: row.source as ImportSource,
      status: row.status as ImportJob['status'],
      imported: row.imported,
      skipped: row.skipped,
      failed: row.failed,
    };
    if (row.total !== null) job.total = row.total;
    if (row.collection_id !== null) job.collectionId = row.collection_id;
    if (row.error !== null) job.error = row.error;
    return job;
  }
}
