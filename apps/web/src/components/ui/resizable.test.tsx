import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./resizable";

// react-resizable-panels measures with ResizeObserver, absent in jsdom.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

afterEach(() => cleanup());

describe("ResizableHandle", () => {
  // The separator resizes the panels on arrow keys while focused; this app uses
  // arrow keys for move navigation, so the handle must never retain focus.
  it("refuses keyboard focus (blurs immediately) so arrow keys aren't hijacked", () => {
    const { container } = render(
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel id="a">a</ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="b">b</ResizablePanel>
      </ResizablePanelGroup>,
    );

    const handle = container.querySelector(
      '[data-slot="resizable-handle"]',
    ) as HTMLElement;
    expect(handle).toBeTruthy();

    handle.focus();
    expect(document.activeElement).not.toBe(handle);
  });
});
