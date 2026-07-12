// apps/web/src/playStore.ts — Zustand store for play-vs-character mode.
// Feature components only CONSUME it; SSE events funnel through `applyEvent`.
import { create } from "zustand";
import type { Character, PlayEvent, PlayGame } from "@chess/shared";

export interface PlayChatMessage {
  role: "user" | "character";
  text: string;
  /** True while a `chat_delta` stream is still appending to this message. */
  streaming?: boolean;
}

export interface PlayState {
  game: PlayGame | null;
  character: Character | null;
  chat: PlayChatMessage[];
  /** User move sent, AI reply pending. */
  thinking: boolean;
  streamStatus: "idle" | "open" | "error";
  overlayDismissed: boolean;
  start(game: PlayGame, character: Character): void;
  setGame(game: PlayGame): void;
  setThinking(v: boolean): void;
  setStreamStatus(s: PlayState["streamStatus"]): void;
  applyEvent(event: PlayEvent): void;
  addUserChat(text: string): void;
  dismissOverlay(): void;
  reset(): void;
}

const initialState = {
  game: null,
  character: null,
  chat: [] as PlayChatMessage[],
  thinking: false,
  streamStatus: "idle" as const,
  overlayDismissed: false,
};

export const usePlayStore = create<PlayState>((set) => ({
  ...initialState,

  start: (game, character) =>
    set({ ...initialState, game, character }),

  setGame: (game) => set({ game }),

  setThinking: (v) => set({ thinking: v }),

  setStreamStatus: (streamStatus) => set({ streamStatus }),

  applyEvent: (event) =>
    set((state) => {
      switch (event.type) {
        case "ai_move": {
          if (!state.game) return state;
          // The server stream replays past events (ReplaySubject) — after a
          // deep link/refresh the getPlayGame snapshot already contains the
          // replayed moves. Skip stale plies so the move list never duplicates.
          if (event.move.ply <= state.game.moves.length) {
            return { thinking: false };
          }
          return {
            game: {
              ...state.game,
              moves: [...state.game.moves, event.move],
              fen: event.fen,
            },
            thinking: false,
          };
        }
        case "banter":
          return {
            chat: [...state.chat, { role: "character", text: event.text }],
          };
        case "chat_delta": {
          const last = state.chat[state.chat.length - 1];
          if (last?.role === "character" && last.streaming) {
            return {
              chat: [
                ...state.chat.slice(0, -1),
                { ...last, text: last.text + event.delta },
              ],
            };
          }
          return {
            chat: [
              ...state.chat,
              { role: "character", text: event.delta, streaming: true },
            ],
          };
        }
        case "chat_done":
          return {
            chat: state.chat.map((m, i) =>
              i === state.chat.length - 1 && m.streaming
                ? { ...m, streaming: false }
                : m,
            ),
          };
        case "draw_response":
          // The persona's comment (if any) arrives separately as chat.
          return {
            chat: [
              ...state.chat,
              {
                role: "character",
                text: event.accepted
                  ? "(accepts the draw)"
                  : "(declines the draw)",
              },
            ],
          };
        case "game_over": {
          if (!state.game) return { thinking: false };
          return {
            game: {
              ...state.game,
              status: "over",
              result: event.result,
              endReason: event.reason,
            },
            thinking: false,
          };
        }
        case "error":
          return {
            chat: [
              ...state.chat,
              { role: "character", text: `⚠ ${event.message}` },
            ],
            thinking: false,
          };
        default:
          return state;
      }
    }),

  addUserChat: (text) =>
    set((state) => ({ chat: [...state.chat, { role: "user", text }] })),

  dismissOverlay: () => set({ overlayDismissed: true }),

  reset: () => set({ ...initialState }),
}));
