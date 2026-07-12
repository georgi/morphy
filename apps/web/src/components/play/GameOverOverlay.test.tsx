import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
import { useAnalyzerStore } from "@/store";

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Mock the games repo and API client so the overlay's Analyze/Rematch handlers
// never touch IndexedDB or the network.
vi.mock("@/lib/db/games-repo", () => ({
  gamesRepo: { put: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/lib/api", () => ({
  createPlayGame: vi.fn(),
}));

import { gamesRepo } from "@/lib/db/games-repo";
import { createPlayGame } from "@/lib/api";
const put = vi.mocked(gamesRepo.put);
const createPlayGameMock = vi.mocked(createPlayGame);

import { GameOverOverlay } from "./GameOverOverlay";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 =
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

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

function makeFinishedGame(overrides: Partial<PlayGame> = {}): PlayGame {
  return {
    id: "game-1",
    characterId: "morphy",
    side: "white",
    startFen: START_FEN,
    fen: AFTER_E4,
    moves: [
      {
        ply: 1,
        moveNumber: 1,
        color: "w",
        san: "e4",
        uci: "e2e4",
        fenBefore: START_FEN,
        fenAfter: AFTER_E4,
      },
    ],
    status: "over",
    result: "0-1",
    endReason: "checkmate",
    ...overrides,
  };
}

function renderOverlay() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div>home</div>,
  });
  const playRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/play",
    component: () => <div>play</div>,
  });
  const playGameRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/play/$gameId",
    component: GameOverOverlay,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, playRoute, playGameRoute]),
    history: createMemoryHistory({ initialEntries: ["/play/game-1"] }),
  });

  return render(
    <TooltipProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.stubGlobal("scrollTo", () => {});
  usePlayStore.getState().reset();
  put.mockClear();
  createPlayGameMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GameOverOverlay", () => {
  it("shows the result and saves to the library on Analyze", async () => {
    const character = makeCharacter();
    const game = makeFinishedGame();
    act(() => {
      usePlayStore.getState().start(game, character);
      usePlayStore.getState().applyEvent({
        type: "chat_delta",
        delta: "Well played — a fine finish.",
      });
      usePlayStore.getState().applyEvent({ type: "chat_done" });
    });

    renderOverlay();

    await waitFor(() => expect(screen.getByText(/0–1/)).toBeTruthy());
    expect(screen.getByText(/Checkmate/i)).toBeTruthy();
    expect(screen.getByText("Well played — a fine finish.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /analyze this game/i }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(put).toHaveBeenCalledTimes(1);
    const [finishedGame, meta] = put.mock.calls[0];
    expect(finishedGame.id).toBe("game-1");
    expect(finishedGame.headers.white).toBe("You");
    expect(finishedGame.headers.black).toBe("Paul Morphy");
    expect(meta.source).toBe("manual");
    expect(typeof meta.contentHash).toBe("string");
    expect(useAnalyzerStore.getState().game?.id).toBe("game-1");
  });

  it("starts a color-swapped rematch", async () => {
    const character = makeCharacter();
    const game = makeFinishedGame({ side: "white" });
    act(() => {
      usePlayStore.getState().start(game, character);
    });

    const rematchGame: PlayGame = {
      ...makeFinishedGame({ side: "black" }),
      id: "game-2",
      status: "active",
      result: undefined,
      endReason: undefined,
      moves: [],
      fen: START_FEN,
    };
    createPlayGameMock.mockResolvedValue(rematchGame);

    renderOverlay();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /rematch/i }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /rematch/i }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(createPlayGameMock).toHaveBeenCalledWith({
      characterId: "morphy",
      side: "black",
    });
  });
});
