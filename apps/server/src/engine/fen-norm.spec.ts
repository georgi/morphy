import { normalizeFen } from './fen-norm';

const START =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const START_NORM = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

describe('normalizeFen', () => {
  it('keeps only the first four FEN fields, dropping the clocks', () => {
    expect(normalizeFen(START)).toBe(START_NORM);
  });

  it('maps "startpos" to the start position normal form', () => {
    expect(normalizeFen('startpos')).toBe(START_NORM);
    expect(normalizeFen('startpos')).toBe(normalizeFen(START));
  });

  describe('positions that differ only in clocks normalize identically', () => {
    const equivalent: [string, string, string][] = [
      [
        'start position, halfmove clock differs',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 5 1',
      ],
      [
        'start position, fullmove number differs',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 40',
      ],
      [
        'midgame transposition, both clocks differ',
        'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
        'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 7 18',
      ],
    ];

    it.each(equivalent)('%s', (_label, a, b) => {
      expect(normalizeFen(a)).toBe(normalizeFen(b));
    });
  });

  describe('positions that differ in any of the first four fields stay distinct', () => {
    const distinct: [string, string, string][] = [
      [
        'different piece placement',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      ],
      [
        'different side to move',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1',
      ],
      [
        'different castling rights',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w Kkq - 0 1',
      ],
      [
        'different en-passant target',
        'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
        'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      ],
    ];

    it.each(distinct)('%s', (_label, a, b) => {
      expect(normalizeFen(a)).not.toBe(normalizeFen(b));
    });
  });

  it('tolerates extra surrounding whitespace', () => {
    expect(normalizeFen(`  ${START}  `)).toBe(START_NORM);
  });
});
