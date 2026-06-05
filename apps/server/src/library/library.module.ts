import { Module } from '@nestjs/common';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';

/**
 * Game library browse/search surface. Depends only on the repositories exported
 * by the `@Global()` PersistenceModule, so it needs no explicit imports.
 * {@link LibraryService} is exported for the agent's library tools to reuse.
 */
@Module({
  controllers: [LibraryController],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
