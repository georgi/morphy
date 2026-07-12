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
import type { Character, PlayGame } from "@chess/shared";
import { PlayView } from "@/views/PlayView";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { usePlayStore } from "@/playStore";
import * as api from "@/lib/api";

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

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof api>("@/lib/api");
  return {
    ...actual,
    listCharacters: vi.fn(),
    createPlayGame: vi.fn(),
  };
});

const HUSTLER: Character = {
  id: "hustler",
  name: "The Washington Square Hustler",
  avatar: "♟️",
  tagline: "Speed over soul.",
  bio: "Grew up hustling blitz in the park.",
  strength: 3,
  styleTag: "Blitz shark",
};

function makeGame(overrides: Partial<PlayGame> = {}): PlayGame {
  return {
    id: "game-1",
    characterId: "hustler",
    side: "white",
    startFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    moves: [],
    status: "active",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.stubGlobal("matchMedia", stubMatchMedia);
  vi.stubGlobal("scrollTo", () => {});
  usePlayStore.setState({ game: null, character: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderView() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: PlayView,
  });
  const playGameRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/play/$gameId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, playGameRoute]),
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

describe("PlayView", () => {
  it("renders the roster and starts a game on side pick", async () => {
    vi.mocked(api.listCharacters).mockResolvedValue([HUSTLER]);
    const game = makeGame();
    vi.mocked(api.createPlayGame).mockResolvedValue(game);

    renderView();

    expect(
      await screen.findByRole("heading", { name: "Choose your opponent" }),
    ).toBeDefined();
    expect(
      await screen.findByText("The Washington Square Hustler"),
    ).toBeDefined();

    fireEvent.click(screen.getByText("The Washington Square Hustler"));
    fireEvent.click(await screen.findByText("Play as White"));

    await waitFor(() =>
      expect(api.createPlayGame).toHaveBeenCalledWith({
        characterId: "hustler",
        side: "white",
      }),
    );

    await waitFor(() => {
      expect(usePlayStore.getState().game?.id).toBe("game-1");
      expect(usePlayStore.getState().character?.id).toBe("hustler");
    });
  });

  it("surfaces a toast when creating a game fails", async () => {
    vi.mocked(api.listCharacters).mockResolvedValue([HUSTLER]);
    vi.mocked(api.createPlayGame).mockRejectedValue(new Error("boom"));

    renderView();

    fireEvent.click(
      await screen.findByText("The Washington Square Hustler"),
    );
    fireEvent.click(await screen.findByText("Random"));

    await waitFor(() =>
      expect(api.createPlayGame).toHaveBeenCalledWith({
        characterId: "hustler",
        side: "random",
      }),
    );
  });
});
