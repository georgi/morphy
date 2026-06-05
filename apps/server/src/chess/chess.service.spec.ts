import { BadRequestException } from '@nestjs/common';
import { Chess } from 'chess.js';
import { ChessService } from './chess.service';
import { CLASSIFY_THRESHOLDS } from '@chess/shared';

const START_FEN = new Chess().fen();

// A short, real, completed game (Scholar's Mate). Six half-moves, decisive.
const SCHOLARS_MATE_PGN = `[Event "Casual Game"]
[Site "?"]
[Date "????.??.??"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0`;

describe('ChessService', () => {
  let service: ChessService;

  beforeEach(() => {
    service = new ChessService();
  });

  describe('importPgn', () => {
    it('imports a short real game into an ordered Move[]', () => {
      const game = service.importPgn(SCHOLARS_MATE_PGN);

      expect(game.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(game.startFen).toBe(START_FEN);
      expect(game.moves).toHaveLength(7);

      const first = game.moves[0];
      expect(first).toMatchObject({
        ply: 1,
        moveNumber: 1,
        color: 'w',
        san: 'e4',
        uci: 'e2e4',
        fenBefore: START_FEN,
      });

      // Second half-move stays move number 1 but flips color.
      expect(game.moves[1]).toMatchObject({ ply: 2, moveNumber: 1, color: 'b', san: 'e5' });
      // Third half-move advances the move number.
      expect(game.moves[2]).toMatchObject({ ply: 3, moveNumber: 2, color: 'w' });

      // fenBefore of each move equals fenAfter of the previous one.
      for (let i = 1; i < game.moves.length; i++) {
        expect(game.moves[i].fenBefore).toBe(game.moves[i - 1].fenAfter);
      }

      // Final move is the mate.
      expect(game.moves.at(-1)?.san).toBe('Qxf7#');
    });

    it('resolves headers and drops chess.js placeholders', () => {
      const game = service.importPgn(SCHOLARS_MATE_PGN);
      expect(game.headers.white).toBe('Alice');
      expect(game.headers.black).toBe('Bob');
      expect(game.headers.result).toBe('1-0');
      expect(game.headers.event).toBe('Casual Game');
      // Site "?" and Date "????.??.??" are placeholders → omitted.
      expect(game.headers.date).toBeUndefined();
      expect(game.headers.site).toBeUndefined();
    });

    it('backfills an ECO/opening label when the PGN lacks one', () => {
      const game = service.importPgn(SCHOLARS_MATE_PGN);
      // 1.e4 e5 2.Bc4 → Italian-ish king's pawn; at minimum a king's pawn opening.
      expect(game.headers.eco).toBeDefined();
      expect(game.headers.opening).toBeDefined();
    });

    it('throws BadRequestException on invalid PGN', () => {
      expect(() => service.importPgn('1. e4 garbage??!')).toThrow(BadRequestException);
    });

    it('imports a Lichess export with per-move clock + annotation comments', () => {
      // Lichess emits two *consecutive* comments per move — `{ [%clk …] } { eco … }`
      // — which chess.js's strict parser rejects ("but { found"). We strip the
      // movetext comments and recover the moves + headers.
      const pgn = `[Event "rated rapid game"]
[White "IrinaFrol"]
[Black "mgeorgi"]
[Result "1-0"]
[ECO "D10"]
[Opening "Slav Defense: Exchange Variation"]

1. d4 { [%clk 0:15:00] } 1... d5 { [%clk 0:15:00] } 2. c4 { [%clk 0:15:08] } 2... c6 { [%clk 0:15:08] } 3. cxd5 { [%clk 0:15:17] } { D10 Slav Defense: Exchange Variation } 3... cxd5 { [%clk 0:15:16] } 4. Nc3 { [%clk 0:15:25] } 4... Nf6 { [%clk 0:15:23] } { Black resigns. } 1-0`;

      const game = service.importPgn(pgn);
      expect(game.moves).toHaveLength(8);
      expect(game.moves[0]).toMatchObject({ san: 'd4', uci: 'd2d4' });
      expect(game.moves.at(-1)?.san).toBe('Nf6');
      expect(game.headers.white).toBe('IrinaFrol');
      expect(game.headers.eco).toBe('D10');
      expect(game.headers.opening).toBe('Slav Defense: Exchange Variation');
    });

    it('imports PGN written in figurine notation', () => {
      const game = service.importPgn('1. e4 e5 2. ♘f3 ♘c6 3. ♗b5 a6 *');
      expect(game.moves.map((m) => m.san)).toEqual([
        'e4',
        'e5',
        'Nf3',
        'Nc6',
        'Bb5',
        'a6',
      ]);
    });

    it('imports only the first game when several are concatenated', () => {
      const pgn = `[Event "g1"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n\n[Event "g2"]\n\n1. d4 d5 0-1`;
      const game = service.importPgn(pgn);
      expect(game.headers.event).toBe('g1');
      expect(game.moves).toHaveLength(4);
      expect(game.moves[0].san).toBe('e4');
    });
  });

  describe('importFen', () => {
    it('builds a game from a valid FEN with no moves', () => {
      const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
      const game = service.importFen(fen);
      expect(game.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(game.startFen).toBe(fen);
      expect(game.moves).toHaveLength(0);
      expect(game.headers).toEqual({});
    });

    it('throws BadRequestException on invalid FEN', () => {
      expect(() => service.importFen('not a real fen')).toThrow(BadRequestException);
    });
  });

  describe('legalMoves', () => {
    it('returns the 20 opening moves from the start position', () => {
      const moves = service.legalMoves(START_FEN);
      expect(moves).toHaveLength(20);
      expect(moves).toContain('e4');
      expect(moves).toContain('Nf3');
    });

    it('throws BadRequestException on invalid FEN', () => {
      expect(() => service.legalMoves('bad')).toThrow(BadRequestException);
    });
  });

  describe('applySan', () => {
    it('applies a legal SAN move and reports UCI + resulting FEN', () => {
      const result = service.applySan(START_FEN, 'e4');
      expect(result.move.san).toBe('e4');
      expect(result.move.uci).toBe('e2e4');
      expect(result.move.color).toBe('w');
      expect(result.move.fenBefore).toBe(START_FEN);
      expect(result.fen).toBe(result.move.fenAfter);
      // Black to move after 1.e4.
      expect(result.fen.split(' ')[1]).toBe('b');
    });

    it('throws BadRequestException on an illegal move', () => {
      expect(() => service.applySan(START_FEN, 'e5')).toThrow(BadRequestException);
    });
  });

  describe('positionAtPly', () => {
    it('returns start FEN at ply 0 and the post-move FEN at later plies', () => {
      const game = service.importPgn(SCHOLARS_MATE_PGN);
      expect(service.positionAtPly(game, 0)).toBe(game.startFen);
      expect(service.positionAtPly(game, 1)).toBe(game.moves[0].fenAfter);
      expect(service.positionAtPly(game, 3)).toBe(game.moves[2].fenAfter);
    });

    it('clamps out-of-range plies', () => {
      const game = service.importPgn(SCHOLARS_MATE_PGN);
      expect(service.positionAtPly(game, -5)).toBe(game.startFen);
      expect(service.positionAtPly(game, 999)).toBe(game.moves.at(-1)?.fenAfter);
    });
  });

  describe('uciToSan', () => {
    it('converts a legal UCI move to SAN', () => {
      expect(service.uciToSan(START_FEN, 'e2e4')).toBe('e4');
      expect(service.uciToSan(START_FEN, 'g1f3')).toBe('Nf3');
    });

    it('renders a promotion UCI (5 chars) as a SAN promotion', () => {
      // White pawn on a7, kings only otherwise: a7a8q promotes with check.
      const fen = '8/P7/8/8/8/8/8/k6K w - - 0 1';
      expect(service.uciToSan(fen, 'a7a8q')).toBe('a8=Q+');
    });

    it('returns null for an illegal move', () => {
      // e7e5 is Black's move; it's not White's turn from the start position.
      expect(service.uciToSan(START_FEN, 'e7e5')).toBeNull();
    });

    it('returns null for a malformed UCI string', () => {
      expect(service.uciToSan(START_FEN, 'e2')).toBeNull();
      expect(service.uciToSan(START_FEN, 'z9z9')).toBeNull();
      expect(service.uciToSan(START_FEN, '')).toBeNull();
    });
  });

  describe('uciLineToSan', () => {
    it('walks a UCI line into SAN, threading each move', () => {
      const line = ['e2e4', 'e7e5', 'g1f3', 'b8c6'];
      expect(service.uciLineToSan(START_FEN, line)).toEqual([
        'e4',
        'e5',
        'Nf3',
        'Nc6',
      ]);
    });

    it('stops at the first illegal/malformed move and returns the prefix', () => {
      // Third entry is illegal in the resulting position → line stops at 2.
      const line = ['e2e4', 'e7e5', 'e2e4'];
      expect(service.uciLineToSan(START_FEN, line)).toEqual(['e4', 'e5']);

      const garbled = ['e2e4', 'nonsense'];
      expect(service.uciLineToSan(START_FEN, garbled)).toEqual(['e4']);
    });

    it('returns an empty array for an empty line', () => {
      expect(service.uciLineToSan(START_FEN, [])).toEqual([]);
    });
  });

  describe('materialBalance', () => {
    it('is balanced at the starting position', () => {
      const bal = service.materialBalance(START_FEN);
      // 8 pawns(8) + 2N(6) + 2B(6) + 2R(10) + 1Q(9) = 39 per side, kings count 0.
      expect(bal.white).toBe(39);
      expect(bal.black).toBe(39);
      expect(bal.diff).toBe(0);
    });

    it('reflects a captured queen (White up 9)', () => {
      // White has captured Black's queen: black side missing its queen.
      const fen = 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      const bal = service.materialBalance(fen);
      expect(bal.white).toBe(39);
      expect(bal.black).toBe(30);
      expect(bal.diff).toBe(9);
    });

    it('throws BadRequestException on invalid FEN', () => {
      expect(() => service.materialBalance('nope')).toThrow(BadRequestException);
    });
  });

  describe('classify', () => {
    it('treats ~0 loss as best', () => {
      expect(service.classify(0)).toBe('best');
      expect(service.classify(-5)).toBe('best');
    });

    it('uses CLASSIFY_THRESHOLDS boundary values', () => {
      // Sanity-check the constants we rely on.
      expect(CLASSIFY_THRESHOLDS).toEqual({ inaccuracy: 50, mistake: 100, blunder: 300 });

      expect(service.classify(1)).toBe('good');
      expect(service.classify(49)).toBe('good');
      expect(service.classify(50)).toBe('inaccuracy');
      expect(service.classify(99)).toBe('inaccuracy');
      expect(service.classify(100)).toBe('mistake');
      expect(service.classify(299)).toBe('mistake');
      expect(service.classify(300)).toBe('blunder');
      expect(service.classify(5000)).toBe('blunder');
    });

    it('rounds fractional losses to the nearest boundary', () => {
      expect(service.classify(49.4)).toBe('good');
      expect(service.classify(49.5)).toBe('inaccuracy');
      expect(service.classify(99.6)).toBe('mistake');
    });
  });

  describe('identifyOpening', () => {
    it('identifies the Ruy Lopez from a SAN sequence (longest match wins)', () => {
      const opening = service.identifyOpening(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
      expect(opening.eco).toBe('C60');
      expect(opening.name).toBe('Ruy Lopez');
    });

    it('identifies the Sicilian Defense from a SAN sequence', () => {
      expect(service.identifyOpening(['e4', 'c5'])).toMatchObject({
        eco: 'B20',
        name: 'Sicilian Defense',
      });
    });

    it('identifies an opening from PGN text', () => {
      const opening = service.identifyOpening('1. d4 d5 2. c4 e6');
      expect(opening.eco).toBe('D30');
      expect(opening.name).toBe("Queen's Gambit Declined");
    });

    it('identifies the start position as no opening (empty sequence)', () => {
      expect(service.identifyOpening(START_FEN)).toEqual({});
    });

    it('returns empty for an unmatched sequence', () => {
      expect(service.identifyOpening(['h4'])).toEqual({});
    });
  });
});
