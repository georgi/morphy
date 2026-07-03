import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { contentHash } from '@chess/shared';
import type { ImportGameRequest, ImportGameResponse } from '@chess/shared';
import { ChessService } from '../chess/chess.service';

/**
 * Direct (non-agent) game endpoint: import a game from PGN or FEN and return the
 * parsed {@link Game} plus its dedup content hash. The server no longer persists
 * games — the client writes the result into its own library. Parsing/validation
 * lives in ChessService, which throws BadRequestException on bad input (HTTP 400).
 */
@Controller('games')
export class GamesController {
  constructor(private readonly chess: ChessService) {}

  /**
   * Import a game from exactly one of `pgn` or `fen`, returning the parsed
   * {@link Game} plus its dedup content hash. The server no longer persists it —
   * the client writes it into its own library. Supplying neither (or both) is a
   * client error → 400. Invalid PGN/FEN is also 400, raised by ChessService.
   */
  @Post()
  importGame(@Body() body: ImportGameRequest): ImportGameResponse {
    const pgn = typeof body?.pgn === 'string' ? body.pgn.trim() : '';
    const fen = typeof body?.fen === 'string' ? body.fen.trim() : '';

    if (pgn && fen) {
      throw new BadRequestException(
        'Provide either "pgn" or "fen", not both.',
      );
    }
    if (!pgn && !fen) {
      throw new BadRequestException('Provide a "pgn" or "fen" to import.');
    }

    const game = pgn ? this.chess.importPgn(pgn) : this.chess.importFen(fen);
    return { game, contentHash: contentHash(game) };
  }
}
