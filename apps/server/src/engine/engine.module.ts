import { Module } from '@nestjs/common';
import { EngineService } from './engine.service';
import { CachedEngine } from './cached-engine';

/**
 * Exposes the pure UCI {@link EngineService} and the caching {@link CachedEngine}
 * gateway in front of it. AnalysisService depends on CachedEngine so every
 * analysis path is served from the global eval cache. CachedEngine injects the
 * `@Global` EvalCacheRepository, so no extra import is needed here.
 */
@Module({
  providers: [EngineService, CachedEngine],
  exports: [EngineService, CachedEngine],
})
export class EngineModule {}
