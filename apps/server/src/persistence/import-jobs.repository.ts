import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import type {
  ImportJob,
  ImportSource,
  StartImportRequest,
} from '@chess/shared';

/** Fields supplied when creating an import job; counts/timestamps are managed. */
export interface NewImportJob {
  source: ImportSource;
  /** The original request, retained for diagnostics / poll responses. */
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

/** Internal in-memory record for one job (superset of the {@link ImportJob} projection). */
interface JobRecord {
  id: string;
  source: ImportSource;
  params?: StartImportRequest;
  status: ImportJob['status'];
  total?: number;
  imported: number;
  skipped: number;
  failed: number;
  collectionId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * In-memory tracking of bulk-import jobs. A record tracks one job's lifecycle
 * (`pending` → `running` → `done`/`error`) and its running counts. It is the
 * poll fallback (`GET /api/import/:jobId`) and the source the SSE stream replays
 * a terminal frame from when a client reconnects after the job finished.
 *
 * Job state is intentionally NOT persisted: the server keeps a single SQLite
 * table (`eval_cache`); import progress is ephemeral and only meaningful for the
 * lifetime of the running process. A process-wide `Map` is the whole store.
 */
@Injectable()
export class ImportJobsRepository {
  private readonly jobs = new Map<string, JobRecord>();

  /** Create a job and return its {@link ImportJob} projection. */
  create(input: NewImportJob): ImportJob {
    const now = Date.now();
    const record: JobRecord = {
      id: uuidv4(),
      source: input.source,
      params: input.params,
      status: input.status ?? 'running',
      total: input.total,
      imported: 0,
      skipped: 0,
      failed: 0,
      collectionId: input.collectionId,
      error: undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(record.id, record);
    return this.project(record);
  }

  /** Look up a job by id, or `undefined` if absent. */
  get(id: string): ImportJob | undefined {
    const record = this.jobs.get(id);
    return record ? this.project(record) : undefined;
  }

  /**
   * Apply a partial update to a job (status, counts, collection, error), bumping
   * `updatedAt`. Only the provided fields change; omitted fields keep their
   * stored value. Returns the updated {@link ImportJob}, or `undefined` if the
   * job does not exist.
   */
  update(id: string, patch: ImportJobUpdate): ImportJob | undefined {
    const record = this.jobs.get(id);
    if (!record) return undefined;

    if (patch.status !== undefined) record.status = patch.status;
    if (patch.total !== undefined) record.total = patch.total;
    if (patch.imported !== undefined) record.imported = patch.imported;
    if (patch.skipped !== undefined) record.skipped = patch.skipped;
    if (patch.failed !== undefined) record.failed = patch.failed;
    if (patch.collectionId !== undefined)
      record.collectionId = patch.collectionId;
    if (patch.error !== undefined) record.error = patch.error;
    record.updatedAt = Date.now();

    return this.project(record);
  }

  /** Project the internal record to the public {@link ImportJob}, dropping absent optionals. */
  private project(record: JobRecord): ImportJob {
    const job: ImportJob = {
      id: record.id,
      source: record.source,
      status: record.status,
      imported: record.imported,
      skipped: record.skipped,
      failed: record.failed,
    };
    if (record.total !== undefined) job.total = record.total;
    if (record.collectionId !== undefined)
      job.collectionId = record.collectionId;
    if (record.error !== undefined) job.error = record.error;
    return job;
  }
}
