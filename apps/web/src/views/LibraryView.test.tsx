import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
import type { Collection, GameSummary, LibraryPage } from "@chess/shared";

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

const SUMMARIES: GameSummary[] = [
  {
    id: "m",
    white: "Magnus Carlsen",
    black: "Hikaru Nakamura",
    result: "1-0",
    eco: "B90",
    opening: "Sicilian Najdorf",
    date: "2021.01.01",
    plyCount: 40,
    source: "lichess",
    collectionId: "c1",
    hasAnalysis: true,
    createdAt: 1,
  },
  {
    id: "f",
    white: "Bobby Fischer",
    black: "Boris Spassky",
    result: "0-1",
    eco: "C95",
    opening: "Ruy Lopez",
    date: "1972.07.11",
    plyCount: 84,
    source: "manual",
    hasAnalysis: false,
    createdAt: 2,
  },
];

const COLLECTIONS: Collection[] = [
  {
    id: "c1",
    name: "Sicilians",
    source: "lichess",
    gameCount: 1,
    createdAt: 1,
  },
];

// Mock the API client so the view renders against fixed data, no network.
vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  searchLibrary: vi.fn(
    (): Promise<LibraryPage> =>
      Promise.resolve({ games: SUMMARIES, total: SUMMARIES.length }),
  ),
  listCollections: vi.fn((): Promise<Collection[]> => Promise.resolve(COLLECTIONS)),
  getLibraryGame: vi.fn(),
  deleteLibraryGame: vi.fn(),
  deleteCollection: vi.fn(),
}));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.stubGlobal("matchMedia", stubMatchMedia);
  // jsdom has no window.scrollTo; the router's scroll restoration calls it.
  vi.stubGlobal("scrollTo", () => {});
});

import { LibraryView } from "@/views/LibraryView";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { useLibraryStore, DEFAULT_LIBRARY_QUERY } from "@/store";

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

  it("renders a row per game summary with player, opening, and source", async () => {
    renderView();
    expect(await screen.findByText("Magnus Carlsen")).toBeDefined();
    expect(screen.getByText("Bobby Fischer")).toBeDefined();
    expect(screen.getByText("Sicilian Najdorf")).toBeDefined();
    expect(screen.getByText("Ruy Lopez")).toBeDefined();
    // The analyzed badge appears for the analyzed game only.
    expect(screen.getByText("analyzed")).toBeDefined();
  });

  it("shows the total count in the footer pager", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getByText(/1–2 of 2/)).toBeDefined(),
    );
  });
});
