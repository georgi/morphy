import { describe, expect, it } from "vitest";
import type { GameHeaders } from "@chess/shared";
import { boardPlayers } from "./BoardPlayers";

const HEADERS: GameHeaders = {
  white: "Alice",
  black: "Bob",
  whiteElo: "2100",
  blackElo: "1950",
};

describe("boardPlayers", () => {
  it("puts the side you're viewing from on the bottom (White orientation)", () => {
    const { top, bottom } = boardPlayers(HEADERS, "white");
    expect(bottom).toMatchObject({ color: "white", name: "Alice", rating: "2100" });
    expect(top).toMatchObject({ color: "black", name: "Bob", rating: "1950" });
  });

  it("flips top/bottom with the board (Black orientation)", () => {
    const { top, bottom } = boardPlayers(HEADERS, "black");
    expect(bottom).toMatchObject({ color: "black", name: "Bob" });
    expect(top).toMatchObject({ color: "white", name: "Alice" });
  });

  it("falls back to the side label when a name is missing or a '?' placeholder", () => {
    const { top, bottom } = boardPlayers({ white: "?" }, "white");
    expect(bottom.name).toBe("White");
    expect(top.name).toBe("Black");
    expect(bottom.rating).toBeUndefined();
  });
});
