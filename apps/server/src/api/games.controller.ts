import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import type { Game, ImportGameRequest } from '@chess/shared';
import { ChessService } from '../chess/chess.service';
import { GameStore } from '../chess/game.store';

/**
 * Direct (non-agent) game endpoints: import a game from PGN or FEN, and fetch a
 * previously imported game by id. Parsing/validation lives in ChessService, which
 * throws BadRequestException on bad input — those surface as HTTP 400.
 */
@Controller('games')
export class GamesController {
  constructor(
    private readonly chess: ChessService,
    private readonly store: GameStore,
  ) {}

  /**
   * Import a game from exactly one of `pgn` or `fen`, persist it, and return it.
   * Supplying neither (or both) is a client error → 400. Invalid PGN/FEN is also
   * 400, raised by ChessService.
   */
  @Post()
  importGame(@Body() body: ImportGameRequest): Game {
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
    return this.store.create(game);
  }

  /** Fetch a stored game by id, or 404 if it was never imported (or has reset). */
  @Get(':id')
  getGame(@Param('id') id: string): Game {
    const game = this.store.get(id);
    if (!game) {
      throw new NotFoundException(`Game not found: ${id}`);
    }
    return game;
  }
}
