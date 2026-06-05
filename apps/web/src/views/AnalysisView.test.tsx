import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

// react-chessboard pulls in board assets and heavy layout work that adds no
// value to a smoke render; stub it to a marker element.
vi.mock("react-chessboard", () => ({
  Chessboard: () => <div data-testid="chessboard" />,
}));

// jsdom has no EventSource; the ChatPanel opens an SSE stream on mount. A no-op
// stub lets the real component code path run without a network connection.
class StubEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

// react-resizable-panels needs ResizeObserver, also absent in jsdom.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// jsdom has no matchMedia; ThemeProvider queries it to resolve the "system" theme.
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

beforeAll(() => {
  vi.stubGlobal("EventSource", StubEventSource);
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.stubGlobal("matchMedia", stubMatchMedia);
  // jsdom has no window.scrollTo; the router's scroll restoration calls it.
  vi.stubGlobal("scrollTo", () => {});
});

import { AnalysisView } from "@/views/AnalysisView";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { useAnalyzerStore } from "@/store";

function renderView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  // AnalysisView renders a TanStack <Link> in its header, which needs a router
  // context. Mount it as the index route of a throwaway memory router.
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: AnalysisView,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
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
  useAnalyzerStore.setState({ game: null });
});

describe("AnalysisView smoke render", () => {
  it("renders the shell with title, import + analyze controls, and the board", async () => {
    renderView();
    // The view now mounts inside a router, which resolves the route on a tick.
    expect(
      await screen.findByRole("heading", { name: "Chess Analyzer" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: /import/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /analyze game/i })).toBeDefined();
    expect(screen.getByTestId("chessboard")).toBeDefined();
    // No game loaded → prompt copy is present.
    expect(screen.getByText(/import a game to begin/i)).toBeDefined();
  });
});
