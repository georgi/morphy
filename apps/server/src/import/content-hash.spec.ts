import type { Game, Move } from "@chess/shared";
import { contentHash, normalizedSanList } from "@chess/shared";
import { ChessService } from "../chess/chess.service";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function move(ply: number, san: string): Move {
  return {
    ply,
    moveNumber: Math.floor((ply - 1) / 2) + 1,
    color: ply % 2 === 1 ? "w" : "b",
    san,
    uci: "0000",
    fenBefore: START_FEN,
    fenAfter: START_FEN,
  };
}

function game(sans: string[], headers: Game["headers"] = {}, id = "g"): Game {
  return {
    id,
    headers,
    startFen: START_FEN,
    moves: sans.map((san, i) => move(i + 1, san)),
  };
}

/**
 * The import dedup key. Re-exported from `persistence/content-hash` — this spec
 * pins the import-pipeline-relevant properties (stability across runs, dedup of
 * re-exports, distinctness across different games) so the pipeline's
 * `existsByHash` skip is trustworthy.
 */
describe("content-hash (import dedup)", () => {
  it("is stable: the same game hashes identically across calls", () => {
    const g = game(["e4", "e5", "Nf3"], {
      white: "A",
      black: "B",
      result: "*",
    });
    expect(contentHash(g)).toBe(contentHash(g));
  });

  it("ignores the game id (same moves + headers, different id → same hash)", () => {
    const a = game(["e4", "e5"], { white: "A", black: "B" }, "id-1");
    const b = game(["e4", "e5"], { white: "A", black: "B" }, "id-2");
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("collapses check/mate marks and annotation glyphs in SAN", () => {
    const plain = game(["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7"], {
      white: "A",
      black: "B",
    });
    const decorated = game(["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6?", "Qxf7#"], {
      white: "A",
      black: "B",
    });
    expect(contentHash(decorated)).toBe(contentHash(plain));
  });

  it("distinguishes games with different moves", () => {
    const a = game(["e4", "e5"], { white: "A", black: "B" });
    const b = game(["d4", "d5"], { white: "A", black: "B" });
    expect(contentHash(a)).not.toBe(contentHash(b));
  });

  it("distinguishes games with the same moves but different players", () => {
    const a = game(["e4", "e5"], { white: "Carlsen", black: "Nakamura" });
    const b = game(["e4", "e5"], { white: "Fischer", black: "Spassky" });
    expect(contentHash(a)).not.toBe(contentHash(b));
  });

  it("normalizedSanList strips marks but preserves order and move count", () => {
    const g = game(["e4", "e5", "Bb5+", "c6", "Bxc6"]);
    expect(normalizedSanList(g)).toBe("e4 e5 Bb5 c6 Bxc6");
  });

  it("dedups two real PGN exports of one game that differ only in decoration", () => {
    const chess = new ChessService();
    const clean = chess.importPgn(
      '[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6',
    );
    const annotated = chess.importPgn(
      '[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 { [%clk 0:03:00] } e5 2. Nf3 Nc6 $1 3. Bb5 a6',
    );
    // Same moves + players + result; different ids and decorations → one hash.
    expect(contentHash(annotated)).toBe(contentHash(clean));
  });
});
