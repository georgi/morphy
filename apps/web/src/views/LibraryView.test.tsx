import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
import type { Collection, Game } from "@chess/shared";
import { resetLibraryDbForTests } from "@/lib/db/library-db";
import { gamesRepo, type GameMeta } from "@/lib/db/games-repo";
import { collectionsRepo } from "@/lib/db/collections-repo";
import { LibraryView } from "@/views/LibraryView";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { useLibraryStore, DEFAULT_LIBRARY_QUERY } from "@/store";

// react-resizable-panels / radix scroll-area lean on ResizeObserver, absent in
// jsdom. matchMedia is queried by ThemeProvider to resolve the "system" theme.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
function stubMatchMedia(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  } as unknown as MediaQueryList;
}

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function makeGame(id: string, headers: Record<string, string>): Game {
  return {
    id,
    headers,
    startFen: START_FEN,
    moves: [
      {
        ply: 1,
        moveNumber: 1,
        color: "w",
        san: id,
        uci: "0000",
        fenBefore: START_FEN,
        fenAfter: START_FEN,
      },
    ],
  };
}

function makeMeta(overrides: Partial<GameMeta> = {}): GameMeta {
  return {
    source: "manual",
    createdAt: 1,
    contentHash: `hash-${Math.random()}`,
    ...overrides,
  };
}

/** Seed a game with the given id/headers/creation order into the IDB fake. */
function seedGame(
  id: string,
  headers: Record<string, string>,
  overrides: Partial<GameMeta> = {},
): Promise<Game> {
  return gamesRepo.put(makeGame(id, headers), makeMeta(overrides));
}

beforeEach(() => {
  resetLibraryDbForTests();
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.stubGlobal("matchMedia", stubMatchMedia);
  // jsdom has no window.scrollTo; the router's scroll restoration calls it.
  vi.stubGlobal("scrollTo", () => {});
});

function renderView() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: LibraryView,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <ThemeProvider defaultTheme="system">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <RouterProvider router={router as any} />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  useLibraryStore.setState({ query: { ...DEFAULT_LIBRARY_QUERY } });
});

describe("LibraryView", () => {
  it("renders the header, search controls, and the collections sidebar", async () => {
    const collection: Collection = {
      id: "c1",
      name: "Sicilians",
      source: "lichess",
      gameCount: 1,
      createdAt: 1,
    };
    await collectionsRepo.put(collection);
    await seedGame("m", {
      white: "Magnus Carlsen",
      black: "Hikaru Nakamura",
      result: "1-0",
      eco: "B90",
      opening: "Sicilian Najdorf",
      date: "2021.01.01",
    });

    renderView();
    expect(
      await screen.findByRole("heading", { name: "Library" }),
    ).toBeDefined();
    expect(screen.getByLabelText("Search")).toBeDefined();
    expect(screen.getByLabelText("Player")).toBeDefined();
    // Collections sidebar shows the collection with its game count.
    expect(await screen.findByText("Sicilians")).toBeDefined();
    expect(screen.getByText("All games")).toBeDefined();
  });

  it("renders a row per stored game with player, opening, and source", async () => {
    await seedGame("m", {
      white: "Magnus Carlsen",
      black: "Hikaru Nakamura",
      result: "1-0",
      eco: "B90",
      opening: "Sicilian Najdorf",
      date: "2021.01.01",
    });
    await seedGame("f", {
      white: "Bobby Fischer",
      black: "Boris Spassky",
      result: "0-1",
      eco: "C95",
      opening: "Ruy Lopez",
      date: "1972.07.11",
    });
    await gamesRepo.setAnalysis("m", []);

    renderView();
    expect(await screen.findByText("Magnus Carlsen")).toBeDefined();
    expect(screen.getByText("Bobby Fischer")).toBeDefined();
    expect(screen.getByText("Sicilian Najdorf")).toBeDefined();
    expect(screen.getByText("Ruy Lopez")).toBeDefined();
    // The analyzed badge appears for the analyzed game only.
    expect(screen.getByText("analyzed")).toBeDefined();
  });

  it("shows the total count in the footer pager", async () => {
    await seedGame("m", { white: "Magnus Carlsen", date: "2021.01.01" });
    await seedGame("f", { white: "Bobby Fischer", date: "1972.07.11" });

    renderView();
    await waitFor(() => expect(screen.getByText(/1–2 of 2/)).toBeDefined());
  });

  it("renders games newest-first by game date", async () => {
    await seedGame("oldest", { white: "Old Player", date: "1972.07.11" });
    await seedGame("newest", { white: "New Player", date: "2021.01.01" });
    await seedGame("middle", { white: "Mid Player", date: "2004.03.02" });

    renderView();
    await screen.findByText("New Player");
    const rows = (await screen.findAllByRole("row")).filter(
      (row) => row.querySelector("td") !== null,
    );
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("New Player"),
      expect.stringContaining("Mid Player"),
      expect.stringContaining("Old Player"),
    ]);
  });

  it("paginates: shows a page of results and advances on Next", async () => {
    for (let i = 0; i < 30; i++) {
      // Descending date strings sort "game-29" first (newest).
      const date = `2000.01.${String(30 - i).padStart(2, "0")}`;
      await seedGame(`game-${i}`, { white: `Player ${i}`, date });
    }

    renderView();
    await waitFor(() => expect(screen.getByText(/1–25 of 30/)).toBeDefined());
    expect(screen.getByText("Player 0")).toBeDefined();
    expect(screen.queryByText("Player 25")).toBeNull();

    const nextButton = screen.getByRole("button", { name: /next/i });
    expect(nextButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(nextButton);

    await waitFor(() => expect(screen.getByText(/26–30 of 30/)).toBeDefined());
    expect(screen.getByText("Player 25")).toBeDefined();
    expect(screen.queryByText("Player 0")).toBeNull();
  });
});
