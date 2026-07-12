import { beforeEach, describe, expect, it } from "vitest";
import type { Character, Move, PlayGame } from "@chess/shared";
import { usePlayStore } from "./playStore";

const character: Character = {
  id: "hustler", name: "The Washington Square Hustler", avatar: "🗽",
  tagline: "Five bucks a game.", bio: "…", strength: 3, styleTag: "Trappy",
};
const game: PlayGame = {
  id: "g1", characterId: "hustler", side: "white",
  startFen: "start-fen", fen: "start-fen", moves: [], status: "active",
};
const aiMove: Move = {
  ply: 2, moveNumber: 1, color: "b", san: "e5", uci: "e7e5",
  fenBefore: "fen-1", fenAfter: "fen-2",
};

describe("playStore", () => {
  beforeEach(() => usePlayStore.getState().reset());

  it("applies ai_move: appends move, updates fen, clears thinking", () => {
    const s = usePlayStore.getState();
    s.start(game, character);
    s.setThinking(true);
    s.applyEvent({ type: "ai_move", move: aiMove, fen: "fen-2" });
    const st = usePlayStore.getState();
    expect(st.game?.moves).toEqual([aiMove]);
    expect(st.game?.fen).toBe("fen-2");
    expect(st.thinking).toBe(false);
  });

  it("ignores replayed ai_move events already in the game snapshot", () => {
    // Deep-link/refresh: the server stream replays past events, but the
    // getPlayGame snapshot already contains those moves.
    const move1: Move = {
      ply: 1, moveNumber: 1, color: "w", san: "e4", uci: "e2e4",
      fenBefore: "fen-0", fenAfter: "fen-1",
    };
    const move2: Move = { ...aiMove }; // ply 2
    const s = usePlayStore.getState();
    s.start({ ...game, moves: [move1, move2], fen: "fen-2" }, character);
    s.setThinking(true);

    // Stale replay of the ply-2 AI move: no duplicate append, thinking cleared.
    s.applyEvent({ type: "ai_move", move: move2, fen: "fen-2" });
    let st = usePlayStore.getState();
    expect(st.game?.moves).toHaveLength(2);
    expect(st.game?.fen).toBe("fen-2");
    expect(st.thinking).toBe(false);

    // A genuinely new ply-3 move still appends.
    const move3: Move = {
      ply: 3, moveNumber: 2, color: "w", san: "Nf3", uci: "g1f3",
      fenBefore: "fen-2", fenAfter: "fen-3",
    };
    s.applyEvent({ type: "ai_move", move: move3, fen: "fen-3" });
    st = usePlayStore.getState();
    expect(st.game?.moves).toEqual([move1, move2, move3]);
    expect(st.game?.fen).toBe("fen-3");
  });

  it("accumulates chat_delta into one streaming message and closes on chat_done", () => {
    const s = usePlayStore.getState();
    s.start(game, character);
    s.applyEvent({ type: "chat_delta", delta: "Clock's " });
    s.applyEvent({ type: "chat_delta", delta: "ticking." });
    expect(usePlayStore.getState().chat).toEqual([
      { role: "character", text: "Clock's ticking.", streaming: true },
    ]);
    s.applyEvent({ type: "chat_done" });
    expect(usePlayStore.getState().chat[0].streaming).toBe(false);
  });

  it("keeps banter and user chat ordered", () => {
    const s = usePlayStore.getState();
    s.start(game, character);
    s.applyEvent({ type: "banter", text: "You see it?" });
    s.addUserChat("no");
    expect(usePlayStore.getState().chat.map((m) => m.role)).toEqual([
      "character", "user",
    ]);
  });

  it("applies game_over onto the game", () => {
    const s = usePlayStore.getState();
    s.start(game, character);
    s.applyEvent({ type: "game_over", result: "0-1", reason: "checkmate" });
    const st = usePlayStore.getState();
    expect(st.game).toMatchObject({
      status: "over", result: "0-1", endReason: "checkmate",
    });
  });

  it("resets", () => {
    const s = usePlayStore.getState();
    s.start(game, character);
    s.reset();
    expect(usePlayStore.getState().game).toBeNull();
    expect(usePlayStore.getState().chat).toEqual([]);
  });
});
