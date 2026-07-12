import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Character, PlayGame } from "@chess/shared";
import { usePlayStore } from "@/playStore";
import * as api from "@/lib/api";

// Capture every stream URL PlayGameView opens, matching ChatPanel.test.tsx's
// StubEventSource convention.
const opened: string[] = [];
const sources: StubEventSource[] = [];
class StubEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    opened.push(url);
    sources.push(this);
  }
  close() {}
  /** Deliver a server PlayEvent to the view, as the SSE onmessage would. */
  emit(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }
}

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: "morphy",
    name: "Paul Morphy",
    avatar: "♞",
    tagline: "Romantic tactician",
    bio: "A 19th-century attacking genius.",
    strength: 4,
    styleTag: "Tactical",
    ...overrides,
  };
}

function makeGame(overrides: Partial<PlayGame> = {}): PlayGame {
  return {
    id: "game-1",
    characterId: "morphy",
    side: "white",
    startFen: START_FEN,
    fen: START_FEN,
    moves: [],
    status: "active",
    ...overrides,
  };
}

beforeEach(() => {
  opened.length = 0;
  sources.length = 0;
  vi.stubGlobal("EventSource", StubEventSource);
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.stubGlobal("scrollTo", () => {});
  usePlayStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

import { PlayGameView } from "./PlayGameView";

function renderView(gameId = "game-1") {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const gameRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/play/$gameId",
    component: PlayGameView,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([gameRoute]),
    history: createMemoryHistory({ initialEntries: [`/play/${gameId}`] }),
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("PlayGameView", () => {
  it("applies streamed ai_move events to the board state", async () => {
    act(() => {
      usePlayStore.getState().start(makeGame(), makeCharacter());
    });
    renderView();

    await waitFor(() => expect(sources.length).toBeGreaterThan(0));

    act(() => {
      sources.at(-1)!.emit({
        type: "ai_move",
        move: {
          ply: 1,
          moveNumber: 1,
          color: "w",
          san: "e4",
          uci: "e2e4",
          fenBefore: START_FEN,
          fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        },
        fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      });
    });

    expect(
      usePlayStore.getState().game?.moves.map((m) => m.uci),
    ).toContain("e2e4");
  });

  it("sends a chat message and renders the streamed reply", async () => {
    const sendChat = vi.spyOn(api, "sendPlayChat").mockResolvedValue();
    act(() => {
      usePlayStore.getState().start(makeGame(), makeCharacter());
    });
    renderView();

    await waitFor(() => expect(sources.length).toBeGreaterThan(0));

    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: "Nice opening!" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(sendChat).toHaveBeenCalledWith("game-1", "Nice opening!");

    act(() => {
      sources.at(-1)!.emit({ type: "chat_delta", delta: "Th" });
      sources.at(-1)!.emit({ type: "chat_delta", delta: "anks!" });
      sources.at(-1)!.emit({ type: "chat_done" });
    });

    expect(screen.getByText("Thanks!")).toBeTruthy();
  });

  it("blocks resign/draw controls after game_over", async () => {
    act(() => {
      usePlayStore.getState().start(makeGame(), makeCharacter());
    });
    renderView();

    await waitFor(() => expect(sources.length).toBeGreaterThan(0));

    expect(
      (screen.getByRole("button", { name: /resign/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    act(() => {
      sources.at(-1)!.emit({
        type: "game_over",
        result: "1-0",
        reason: "checkmate",
      });
    });

    expect(
      (screen.getByRole("button", { name: /resign/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: /offer draw/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
