import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CatalogEntry } from "@chess/shared";

// jsdom lacks the DOM APIs Radix Dialog/Tabs lean on. Stub the few they touch so
// the real component mounts and its portal content renders.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const CATALOG: CatalogEntry[] = [
  {
    id: "morphy",
    title: "Morphy Brilliancies",
    description: "A handful of Paul Morphy's most famous attacking games.",
    url: "https://example.test/morphy.pgn",
    bundled: true,
  },
];

// Mock the API client: no network. `openImportStream` returns a stub EventSource
// so the component's stream wiring runs without a live connection. The factory is
// hoisted, so the mock fns are created inside it and read back via `vi.mocked`.
vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  importGame: vi.fn(),
  startImport: vi.fn(
    (): Promise<{ jobId: string }> => Promise.resolve({ jobId: "job-xyz" }),
  ),
  getImportCatalog: vi.fn(
    (): Promise<CatalogEntry[]> => Promise.resolve(CATALOG),
  ),
  openImportStream: vi.fn(() => ({ close: vi.fn() })),
  getImportJob: vi.fn(),
}));

import * as api from "@/lib/api";
const startImport = vi.mocked(api.startImport);

beforeEach(() => {
  startImport.mockClear();
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  // Radix uses pointer-capture + scrollIntoView, absent in jsdom.
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

import { ImportDialog } from "@/components/import/ImportDialog";
import { useImportStore } from "@/store";

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ImportDialog />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Click the trigger and wait for the dialog content to appear. */
async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: /import/i }));
  await screen.findByRole("dialog");
}

afterEach(() => {
  cleanup();
  useImportStore.setState({ job: null });
  vi.unstubAllGlobals();
});

describe("ImportDialog (download dialog)", () => {
  it("renders all four source tabs once opened", async () => {
    renderDialog();
    await openDialog();
    expect(screen.getByRole("tab", { name: "Lichess" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Chess.com" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Catalog" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "URL / Paste" })).toBeDefined();
  });

  it("starts an import job from the URL / Paste tab", async () => {
    renderDialog();
    await openDialog();

    // URL/Paste is the default tab; paste a game and submit.
    fireEvent.change(screen.getByLabelText("PGN paste"), {
      target: { value: '[Event "x"]\n\n1. e4 e5 *' },
    });
    // The tab has both "Load to board" and "Import"; the import buttons match
    // /import/i — pick the submit one inside the dialog footer area by role+name.
    const importButtons = screen.getAllByRole("button", { name: /^import$/i });
    fireEvent.click(importButtons[importButtons.length - 1]);

    await waitFor(() => expect(startImport).toHaveBeenCalledTimes(1));
    expect(startImport).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "url",
        pgn: '[Event "x"]\n\n1. e4 e5 *',
      }),
    );
    // The job is now tracked in the import store.
    await waitFor(() =>
      expect(useImportStore.getState().job?.jobId).toBe("job-xyz"),
    );
  });

  it("starts a Lichess import with kind + id", async () => {
    renderDialog();
    await openDialog();

    // Radix Tabs activate on mousedown (not a bare click) in jsdom.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Lichess" }));
    fireEvent.change(await screen.findByLabelText("Lichess id"), {
      target: { value: "DrNykterstein" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /import from lichess/i }),
    );

    await waitFor(() => expect(startImport).toHaveBeenCalledTimes(1));
    expect(startImport).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "lichess",
        kind: "user",
        id: "DrNykterstein",
      }),
    );
  });

  it("shows a live progress panel reflecting the import store", async () => {
    renderDialog();
    await openDialog();
    // Seed a running job with some progress; the panel reads from the store.
    useImportStore.getState().startJob("job-xyz", "url");
    useImportStore.getState().applyEvent({
      type: "progress",
      imported: 3,
      skipped: 1,
      failed: 0,
      total: 8,
    });
    await waitFor(() =>
      expect(screen.getByText("Imported 3")).toBeDefined(),
    );
    expect(screen.getByText("Skipped 1")).toBeDefined();
    expect(screen.getByText("Total 8")).toBeDefined();
  });
});
