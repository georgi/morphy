/**
 * Thrown when the Stockfish binary cannot be spawned (missing / not executable).
 * Mapped to HTTP 503 by the API layer.
 */
export class EngineUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'EngineUnavailableError';
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Thrown when a single analyze request exceeds its time budget. */
export class EngineTimeoutError extends Error {
  constructor(message = 'engine analysis timed out') {
    super(message);
    this.name = 'EngineTimeoutError';
  }
}
