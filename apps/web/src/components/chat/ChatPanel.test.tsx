import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Game } from "@chess/shared";
import * as api from "@/lib/api";

// Capture every stream URL the ChatPanel opens so we can assert what it forwards.
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
  /** Deliver a server AgentEvent to the panel, as the SSE onmessage would. */
  emit(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }
}

// react-scroll-area / the picker's dropdown need ResizeObserver, absent in jsdom.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  opened.length = 0;
  sources.length = 0;
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
    game: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

import { ChatPanel } from "./ChatPanel";
import { START_FEN, useAnalyzerStore } from "@/store";

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

describe("ChatPanel error and notice handling", () => {
  it("renders a turn error inline in the assistant bubble", () => {
    renderPanel();
    act(() => {
      useAnalyzerStore.getState().startAssistantMessage();
    });
    act(() => {
      sources.at(-1)!.emit({
        type: "error",
        message: "Every available model is rate-limited upstream right now.",
      });
    });

    // getByText throws if the inline error is not rendered.
    expect(screen.getByText(/rate-limited upstream/i)).toBeTruthy();
    expect(useAnalyzerStore.getState().streaming).toBe(false);
  });

  it("updates the shown model when the server falls back via a notice", () => {
    act(() => {
      useAnalyzerStore.setState({ model: "m1" });
    });
    renderPanel();
    act(() => {
      sources.at(-1)!.emit({
        type: "notice",
        level: "warn",
        message: "The previous model was rate-limited; retrying with m2.",
      });
      sources.at(-1)!.emit({ type: "session", id: "sid", model: "m2" });
    });

    expect(useAnalyzerStore.getState().model).toBe("m2");
  });
});

describe("ChatPanel message send", () => {
  it("posts the current open game by value", () => {
    const send = vi.spyOn(api, "sendAgentMessage").mockResolvedValue();
    const game: Game = {
      id: "g-1",
      headers: { white: "Alice", black: "Bob" },
      startFen: START_FEN,
      moves: [],
    };
    act(() => {
      useAnalyzerStore.getState().setGame(game);
    });
    renderPanel();

    // A quick-prompt button fires send() with the current draft/context.
    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "What did I do wrong?" }),
      );
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [, body] = send.mock.calls[0];
    // The open game rides along by value (not just its id).
    expect(body).toEqual({
      text: "What did I do wrong?",
      game,
      ply: 0,
    });
  });

  it("posts an undefined game when none is open", () => {
    const send = vi.spyOn(api, "sendAgentMessage").mockResolvedValue();
    renderPanel();

    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "Explain this position" }),
      );
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [, body] = send.mock.calls[0];
    expect(body.game).toBeUndefined();
    expect(body.text).toBe("Explain this position");
  });
});
