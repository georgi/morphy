import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Sse,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type {
  CatalogEntry,
  ImportJob,
  StartImportRequest,
} from '@chess/shared';
import { ImportService } from './import.service';
import { ImportJobsRepository } from '../persistence/import-jobs.repository';
import { CATALOG } from './catalog.manifest';

/** Import source ids the API accepts (all four sources are wired up). */
const KNOWN_SOURCES = new Set(['url', 'lichess', 'chesscom', 'catalog']);

/**
 * Bulk-import REST surface (SPEC §6):
 *  - POST `/api/import`                 → start a job, returns `{ jobId }`.
 *  - GET  `/api/import/:jobId/stream`   → SSE of {@link ImportEvent}.
 *  - GET  `/api/import/:jobId`          → the {@link ImportJob} (poll fallback).
 *  - GET  `/api/import/catalog`         → curated {@link CatalogEntry} list.
 *
 * The job runs asynchronously inside {@link ImportService}; this controller is a
 * thin transport layer (validate the body, hand off, expose the stream/poll).
 */
@Controller('import')
export class ImportController {
  constructor(
    private readonly importer: ImportService,
    private readonly jobs: ImportJobsRepository,
  ) {}

  /**
   * The curated download catalog (SPEC §6): the bundled `catalog.json` manifest of
   * {@link CatalogEntry}s (World Championships, Morphy / Fischer / Kasparov,
   * bundled brilliancies), each pointing at a remote PGN URL with a couple of
   * classics bundled offline (`bundled: true`).
   */
  @Get('catalog')
  catalog(): CatalogEntry[] {
    return [...CATALOG];
  }

  /**
   * Start an import job. Validates that the body carries a known `source`, then
   * hands off to {@link ImportService.start} (which runs the pipeline in the
   * background). Returns the new job id immediately.
   */
  @Post()
  start(@Body() body: StartImportRequest): { jobId: string } {
    const source = (body as { source?: unknown } | null)?.source;
    if (typeof source !== 'string' || !KNOWN_SOURCES.has(source)) {
      throw new BadRequestException(
        'Provide a valid import "source" (url, lichess, chesscom, catalog).',
      );
    }
    return this.importer.start(body);
  }

  /** Open the per-job SSE stream. The client subscribes once and keeps it open. */
  @Sse(':jobId/stream')
  stream(@Param('jobId') jobId: string): Observable<MessageEvent> {
    return this.importer.getStream(jobId);
  }

  /** Fetch the current job state (poll fallback). 404 if the job is unknown. */
  @Get(':jobId')
  job(@Param('jobId') jobId: string): ImportJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new NotFoundException(`Import job not found: ${jobId}`);
    }
    return job;
  }
}
