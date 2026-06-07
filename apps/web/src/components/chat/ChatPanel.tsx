import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Loader2, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { AgentEvent } from "@chess/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  useAnalyzerStore,
  currentMainlinePly,
  type ChatMessage,
  type ChatToolEvent,
} from "@/store";
import * as api from "@/lib/api";

const QUICK_PROMPTS = [
  "What did I do wrong?",
  "Explain this position",
  "How can I improve?",
] as const;

/**
 * Right column: the agent chat. Opens a persistent SSE stream on mount, renders
 * the transcript (user + assistant bubbles) with an inline tool-activity trail
 * under the streaming reply, and sends user messages through the agent endpoint.
 */
export function ChatPanel() {
  const chat = useAnalyzerStore((s) => s.chat);
  const streaming = useAnalyzerStore((s) => s.streaming);
  const [draft, setDraft] = useState("");

  const viewportRef = useRef<HTMLDivElement>(null);

  // Open the agent SSE stream once and translate AgentEvents into store actions.
  useEffect(() => {
    const onEvent = (e: AgentEvent) => {
      const store = useAnalyzerStore.getState();
      switch (e.type) {
        case "text_delta":
          store.appendAssistantDelta(e.delta);
          break;
        case "tool_start":
          store.addToolEvent(e.tool);
          break;
        case "tool_end":
          store.addToolEvent(e.tool, e.ok);
          break;
        case "board_update":
          store.setBoardFromAgent(e.fen, e.ply);
          break;
        case "coach_question":
          store.setCoachQuestion(e);
          break;
        case "coach_reveal":
          store.setCoachReveal(e);
          break;
        case "done":
          store.endAssistantMessage();
          break;
        case "error":
          toast.error(e.message || "The analyst hit an error.");
          store.endAssistantMessage();
          break;
      }
    };

    const source = api.openAgentStream(
      useAnalyzerStore.getState().sessionId,
      onEvent,
    );
    source.onerror = () => {
      // The browser auto-reconnects EventSource; surface a hint without tearing
      // down the stream so an in-flight reply can resume.
      if (useAnalyzerStore.getState().streaming) {
        toast.error("Lost the connection to the analyst. Reconnecting…");
        useAnalyzerStore.getState().endAssistantMessage();
      }
    };

    return () => source.close();
  }, []);

  // Auto-scroll the transcript to the newest content as it streams in.
  useEffect(() => {
    const viewport = viewportRef.current?.querySelector<HTMLElement>(
      "[data-slot='scroll-area-viewport']",
    );
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [chat]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;

    const store = useAnalyzerStore.getState();
    const { sessionId, game } = store;
    // Branch-point mainline ply: in a variation the agent reasons about the
    // nearest mainline position (variation-aware chat is a documented follow-up).
    const currentPly = currentMainlinePly(store);
    store.appendUserMessage(trimmed);
    store.startAssistantMessage();
    setDraft("");

    api
      .sendAgentMessage(sessionId, {
        text: trimmed,
        gameId: game?.id,
        ply: currentPly,
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : "Failed to reach the analyst.";
        toast.error(message);
        useAnalyzerStore.getState().endAssistantMessage();
      });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    send(draft);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(draft);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={viewportRef} className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-4 p-3">
            {chat.length === 0 ? (
              <EmptyState />
            ) : (
              chat.map((msg, i) => (
                <MessageBubble
                  key={msg.id}
                  msg={msg}
                  streaming={streaming && i === chat.length - 1}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="border-t p-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {QUICK_PROMPTS.map((prompt) => (
            <Button
              key={prompt}
              type="button"
              variant="outline"
              size="xs"
              className="rounded-full font-normal text-muted-foreground"
              disabled={streaming}
              onClick={() => send(prompt)}
            >
              {prompt}
            </Button>
          ))}
        </div>
        <form className="flex items-end gap-2" onSubmit={onSubmit}>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about a move, position, or your whole game…"
            disabled={streaming}
            rows={1}
            className="max-h-32 min-h-9 resize-none"
          />
          <Button
            type="submit"
            size="icon"
            disabled={streaming || draft.trim().length === 0}
            aria-label="Send"
          >
            {streaming ? <Loader2 className="animate-spin" /> : <Send />}
          </Button>
        </form>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <Sparkles className="size-5 text-muted-foreground" />
      <p className="text-sm font-medium">Ask the analyst about your game.</p>
      <p className="text-xs text-muted-foreground">
        It can analyze positions, walk through variations, and show you what to
        play instead.
      </p>
    </div>
  );
}

function MessageBubble({
  msg,
  streaming,
}: {
  msg: ChatMessage;
  streaming: boolean;
}) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
          {msg.text}
        </div>
      </div>
    );
  }

  // Assistant: streamed text, with the live tool-activity trail underneath.
  const showThinking = streaming && msg.text.length === 0;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">Analyst</span>
      {msg.tools.length > 0 && (
        <ToolTrail tools={msg.tools} streaming={streaming} />
      )}
      {msg.text.length > 0 ? (
        <p className="text-sm whitespace-pre-wrap">
          {msg.text}
          {streaming && (
            <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-foreground/70 align-middle" />
          )}
        </p>
      ) : (
        showThinking &&
        msg.tools.length === 0 && (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Thinking…
          </span>
        )
      )}
    </div>
  );
}

/**
 * Compact inline trail of tool activity. The store records a `tool_start`
 * (no `ok`) followed by a `tool_end` (with `ok`) as two entries, so an entry
 * with `ok === undefined` is still running.
 */
function ToolTrail({
  tools,
  streaming,
}: {
  tools: ChatToolEvent[];
  streaming: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-muted/40 px-2 py-1.5">
      {tools.map((t, i) => {
        const running = t.ok === undefined;
        // A pending start whose end hasn't arrived yet only spins while the
        // overall reply is still streaming; otherwise treat it as settled.
        const pending = running && streaming;
        return (
          <div
            key={`${t.tool}-${i}`}
            className="flex items-center gap-1.5 text-xs"
          >
            <ToolStatusIcon ok={t.ok} pending={pending} />
            <span
              className={cn(
                "font-mono",
                pending ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {t.tool}
              {pending && "…"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ToolStatusIcon({ ok, pending }: { ok?: boolean; pending: boolean }) {
  if (pending) {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />;
  }
  if (ok === false) {
    return <CircleAlert className="size-3.5 shrink-0 text-destructive" />;
  }
  return <Check className="size-3.5 shrink-0 text-emerald-500" />;
}
