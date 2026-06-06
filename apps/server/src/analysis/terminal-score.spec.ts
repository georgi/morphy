import { terminalWhitePovCp } from "./analysis.service";

/**
 * `terminalWhitePovCp` resolves the White-POV score of a terminal position from
 * the board itself, since the engine returns no lines there. This is the guard
 * that stops a mate-delivering move from being scored as a total loss.
 */
describe("terminalWhitePovCp", () => {
  it("returns a winning White-POV score when Black is checkmated", () => {
    // Scholar's mate: 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7# — Black to move, mated.
    const fen =
      "r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4";
    const score = terminalWhitePovCp(fen);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(0);
  });

  it("returns a losing White-POV score when White is checkmated", () => {
    // Fool's mate: 1.f3 e5 2.g4 Qh4# — White to move, mated.
    const fen = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    const score = terminalWhitePovCp(fen);
    expect(score).not.toBeNull();
    expect(score!).toBeLessThan(0);
  });

  it("returns 0 for a stalemate", () => {
    // Black to move, not in check, no legal move.
    expect(terminalWhitePovCp("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")).toBe(0);
  });

  it("returns null for a normal, non-terminal position", () => {
    expect(
      terminalWhitePovCp(
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      ),
    ).toBeNull();
  });
});
