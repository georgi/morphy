import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Capture every stream URL the ChatPanel opens so we can assert what it forwards.
const opened: string[] = [];
class StubEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    opened.push(url);
  }
  close() {}
}

// react-scroll-area / the picker's dropdown need ResizeObserver, absent in jsdom.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  opened.length = 0;
  vi.stubGlobal("EventSource", StubEventSource);
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  // The ModelPicker fetches /agent/models on mount; keep it off the network.
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in test")));
  useAnalyzerStore.setState({
    chat: [],
    streaming: false,
    model: undefined,
    resumeId: undefined,
    currentSessionId: undefined,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

import { ChatPanel } from "./ChatPanel";
import { useAnalyzerStore } from "@/store";

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatPanel />
    </QueryClientProvider>,
  );
}

describe("ChatPanel SSE wiring", () => {
  it("opens the stream with the selected model", () => {
    act(() => {
      useAnalyzerStore.setState({ model: "gpt-5.4" });
    });
    renderPanel();
    expect(opened.at(-1)).toContain("model=gpt-5.4");
  });

  it("omits the model param when none is selected (backend default)", () => {
    renderPanel();
    expect(opened.at(-1)).not.toContain("model=");
  });

  it("reopens the stream when the model changes", () => {
    renderPanel();
    const before = opened.length;
    act(() => {
      useAnalyzerStore.getState().setModel("claude-opus-4-8");
    });
    expect(opened.length).toBeGreaterThan(before);
    expect(opened.at(-1)).toContain("model=claude-opus-4-8");
  });
});
