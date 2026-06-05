import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { EngineUnavailableError } from '../engine/errors';

/** Minimal shape of the HTTP response we use — avoids a hard dep on express types. */
interface HttpResponseLike {
  status(code: number): { json(body: unknown): unknown };
}

/**
 * Maps a typed {@link EngineUnavailableError} (missing / unspawnable Stockfish
 * binary) to HTTP 503 with the install hint carried by the error message.
 *
 * Scoped to the error class, so ordinary HttpExceptions (e.g. the 400/404 the
 * controllers throw) pass straight through Nest's default handling untouched.
 */
@Catch(EngineUnavailableError)
export class EngineExceptionFilter implements ExceptionFilter {
  catch(exception: EngineUnavailableError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponseLike>();
    const status = HttpStatus.SERVICE_UNAVAILABLE;
    const body = new HttpException(
      {
        statusCode: status,
        error: 'Service Unavailable',
        message: exception.message,
      },
      status,
    ).getResponse();
    response.status(status).json(body);
  }
}
