import { PgnSplitter, splitPgn } from './pgn-splitter';
import { ChessService } from '../chess/chess.service';

// ── Base games (transcribed from lichess_import_probe.mjs / adversarial-chesscom.mjs) ──
const A =
  '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O';
const B =
  '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0';

/**
 * The splitter is exercised against the *actual* adversarial variants the two
 * probe files POST today (which prove the parser's real-world quirk handling).
 * Single-game variants must split to exactly one game; multi-game files to the
 * correct count; and every split must re-parse cleanly through ChessService.
 */
describe('PgnSplitter', () => {
  const splitter = new PgnSplitter();
  const chess = new ChessService();

  describe('single-game variants split to exactly one game', () => {
    const cases: Array<{ label: string; pgn: string }> = [
      // — lichess probe —
      {
        label: 'plain PGN export (headers, no comments)',
        pgn:
          '[Event "Rated Blitz game"]\n[Site "https://lichess.org/abcd1234"]\n[White "alice"]\n[Black "bob"]\n[Result "1-0"]\n[UTCDate "2026.01.01"]\n[ECO "C41"]\n\n' +
          B,
      },
      {
        label: 'single per-move {[%clk]} comment',
        pgn:
          '1. e4 { [%clk 0:03:00] } e5 { [%clk 0:02:58] } 2. Nf3 { [%clk 0:02:55] } Nc6 { [%clk 0:02:57] } 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
      },
      {
        label: 'consecutive {[%clk]} {[%eval]} double comments per move',
        pgn:
          '1. e4 { [%clk 0:03:00] } { [%eval 0.3] } e5 { [%clk 0:03:00] } { [%eval 0.2] } 2. Nf3 { [%clk 0:02:58] } { [%eval 0.25] } Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
      },
      {
        label: 'single comment combining [%eval][%clk]',
        pgn:
          '1. e4 { [%eval 0.17] [%clk 0:00:30] } e5 { [%eval 0.2] [%clk 0:00:29] } 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
      },
      {
        label: 'eval with mate score {[%eval #-3]}',
        pgn:
          '1. e4 { [%eval #-3] } e5 { [%eval 0.3] } 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
      },
      {
        label: 'consecutive {[%clk]} {D10 Opening Name} comments',
        pgn:
          '1. e4 { [%clk 0:03:00] } { C60 Ruy Lopez } e5 2. Nf3 { [%clk 0:02:58] } { C60 } Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
      },
      {
        label: 'arrow/circle {[%cal] [%csl]} annotations',
        pgn:
          '1. e4 { [%cal Gd1d4] [%csl Re4] } e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
      },
      {
        label: 'nested variations with {[%eval]} comments (analysis)',
        pgn:
          '1. e4 { [%eval 0.2] } e5 { [%eval 0.3] } 2. Nf3 { [%eval 0.25] } (2. f4 { [%eval -0.1] } exf4 (2... d5 3. exd5)) 2... Nc6 3. Bb5 { [%eval 0.2] } a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
      },
      {
        label: 'NAG glyphs ($1 $6 etc.)',
        pgn:
          '1. e4 e5 2. Nf3 Nc6 $1 3. Bb5 $6 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O $10',
      },
      {
        label: 'comment before first move (study chapter intro)',
        pgn:
          '[Event "Study: Ruy Lopez"]\n[Result "*"]\n\n{ This chapter walks through the main line of the Ruy Lopez. } 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O *',
      },
      {
        label: 'Variant header (From Position) with SetUp+FEN, standard startpos',
        pgn:
          '[Event "Casual"]\n[Variant "From Position"]\n[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]\n\n' +
          A,
      },
      {
        label: 'full Lichess blitz: headers + per-move clk + result',
        pgn:
          '[Event "Rated Blitz"]\n[Result "1-0"]\n[TimeControl "180+0"]\n[Variant "Standard"]\n\n1. e4 { [%clk 0:03:00] } e5 { [%clk 0:03:00] } 2. Nf3 { [%clk 0:02:58] } d6 { [%clk 0:02:59] } 3. d4 { [%clk 0:02:55] } Bg4 { [%clk 0:02:56] } 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0',
      },
      {
        label: 'CRLF line endings (Windows download)',
        pgn:
          '[Event "x"]\r\n[White "a"]\r\n[Black "b"]\r\n[Result "1-0"]\r\n\r\n' +
          B,
      },
      // — chess.com probe —
      {
        label: 'chess.com Variant "Standard" header',
        pgn:
          '[Event "Live Chess"]\n[Site "Chess.com"]\n[Date "2024.01.15"]\n[Round "-"]\n[White "AliceCC"]\n[Black "BobCC"]\n[Result "1-0"]\n[Variant "Standard"]\n[TimeControl "600"]\n\n' +
          B,
      },
      {
        label: 'chess.com clk comments no inner spaces {[%clk 0:10:00]}',
        pgn:
          '[Event "Live Chess"]\n[Site "Chess.com"]\n[Date "2024.01.15"]\n[Round "-"]\n[White "AliceCC"]\n[Black "BobCC"]\n[Result "1-0"]\n[TimeControl "600"]\n\n1. e4 {[%clk 0:09:58]} e5 {[%clk 0:09:55]} 2. Nf3 {[%clk 0:09:50]} Nc6 {[%clk 0:09:48]} 3. Bb5 {[%clk 0:09:40]} a6 {[%clk 0:09:38]} 4. Ba4 {[%clk 0:09:30]} Nf6 {[%clk 0:09:28]} 5. O-O {[%clk 0:09:20]} Be7 {[%clk 0:09:18]} 6. Re1 {[%clk 0:09:10]} b5 {[%clk 0:09:08]} 7. Bb3 {[%clk 0:09:00]} d6 {[%clk 0:08:58]} 8. c3 {[%clk 0:08:50]} O-O {[%clk 0:08:48]}',
      },
      {
        label: 'chess.com CurrentPosition header (final fen)',
        pgn:
          '[Event "Live Chess"]\n[Site "Chess.com"]\n[Date "2024.01.15"]\n[Round "-"]\n[White "AliceCC"]\n[Black "BobCC"]\n[Result "1-0"]\n[CurrentPosition "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N2/PP1P1PPP/RNBQR1K1 w - - 0 9"]\n\n' +
          A,
      },
      {
        label: 'chess.com SetUp+FEN standard start position',
        pgn:
          '[Event "Live Chess"]\n[Site "Chess.com"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]\n\n' +
          B,
      },
      {
        label: 'chess.com Termination header (won by checkmate)',
        pgn:
          '[Event "Live Chess"]\n[Site "Chess.com"]\n[Date "2024.01.15"]\n[Round "-"]\n[White "AliceCC"]\n[Black "BobCC"]\n[Result "1-0"]\n[Termination "AliceCC won by checkmate"]\n\n' +
          B,
      },
    ];

    for (const { label, pgn } of cases) {
      it(label, () => {
        const games = splitter.split(pgn);
        expect(games).toHaveLength(1);
        // The single split must parse cleanly through the real parser.
        expect(() => chess.importPgn(games[0])).not.toThrow();
      });
    }
  });

  describe('multi-game files split to the correct count', () => {
    it('study multi-game file: 3 games concatenated (blank-line separated)', () => {
      const pgn =
        '[Event "Chapter 1"]\n[Result "*"]\n\n' +
        A +
        ' *\n\n[Event "Chapter 2"]\n[Result "1-0"]\n\n' +
        B +
        '\n\n[Event "Chapter 3"]\n[Result "*"]\n\n' +
        A +
        ' *';
      const games = splitter.split(pgn);
      expect(games).toHaveLength(3);
      expect(games[0]).toContain('[Event "Chapter 1"]');
      expect(games[1]).toContain('[Event "Chapter 2"]');
      expect(games[2]).toContain('[Event "Chapter 3"]');
      for (const g of games) expect(() => chess.importPgn(g)).not.toThrow();
    });

    it('multi-game, first game has clk+eval double comments', () => {
      const pgn =
        '[Event "Chapter 1"]\n\n1. e4 { [%clk 0:03:00] } { [%eval 0.1] } e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O\n\n[Event "Chapter 2"]\n\n' +
        B;
      const games = splitter.split(pgn);
      expect(games).toHaveLength(2);
      expect(games[0]).toContain('[Event "Chapter 1"]');
      expect(games[1]).toContain('[Event "Chapter 2"]');
      for (const g of games) expect(() => chess.importPgn(g)).not.toThrow();
    });

    it('recovers two games concatenated WITHOUT a blank-line separator', () => {
      // The lichess probe's negative control (a header tag directly after
      // movetext). chess.js rejects the concatenation, but the splitter
      // structurally recovers both halves so each parses independently.
      const pgn = '[Event "G1"]\n' + A + '\n[Event "G2"]\n' + B;
      const games = splitter.split(pgn);
      expect(games).toHaveLength(2);
      expect(games[0]).toContain('[Event "G1"]');
      expect(games[1]).toContain('[Event "G2"]');
      for (const g of games) expect(() => chess.importPgn(g)).not.toThrow();
    });

    it('splits a header-less concatenation of two movetext-only games', () => {
      // No headers at all on the second game: a blank line then movetext does
      // NOT start a new game (no header tag), so this is a single game by PGN
      // rules. Header tags are the only boundary.
      const pgn = A + '\n\n' + A;
      const games = splitter.split(pgn);
      expect(games).toHaveLength(1);
    });
  });

  describe('edge cases', () => {
    it('returns [] for empty or whitespace input', () => {
      expect(splitPgn('')).toEqual([]);
      expect(splitPgn('   \n\n \t ')).toEqual([]);
    });

    it('yields one game for a headerless movetext-only paste', () => {
      expect(splitter.split(A)).toEqual([A]);
    });

    it('does not treat a [%eval]-style bracket inside a comment as a header', () => {
      // A movetext line that begins with a brace comment containing bracketed
      // annotation must not be mistaken for a header boundary.
      const pgn =
        '[Event "G"]\n\n1. e4 e5 { [%eval 0.2] [%clk 0:03:00] } 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O';
      expect(splitter.split(pgn)).toHaveLength(1);
    });
  });
});
