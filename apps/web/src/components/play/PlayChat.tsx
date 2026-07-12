import { useEffect, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { sendPlayChat } from "@/lib/api";
import { usePlayStore } from "@/playStore";

/**
 * Right column: chat with the character. Renders the transcript (user bubbles
 * right-aligned, character bubbles prefixed with the avatar — the streaming
 * reply gets the same pulse/cursor treatment as {@link ChatPanel}'s assistant
 * bubble), an input + send button, and a "thinking…" row while a move or
 * chat reply is in flight.
 */
export function PlayChat({ gameId }: { gameId: string }) {
  const chat = usePlayStore((s) => s.chat);
  const thinking = usePlayStore((s) => s.thinking);
  const character = usePlayStore((s) => s.character);
  const [draft, setDraft] = useState("");
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current?.querySelector<HTMLElement>(
      "[data-slot='scroll-area-viewport']",
    );
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [chat, thinking]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    usePlayStore.getState().addUserChat(trimmed);
    setDraft("");
    sendPlayChat(gameId, trimmed).catch((err: unknown) => {
      const message =
        err instanceof Error ? err.message : "Failed to reach the character.";
      toast.error(message);
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    send(draft);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(draft);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={viewportRef} className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-3 p-3">
            {chat.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Say hello, or just make your move.
              </p>
            ) : (
              chat.map((msg, i) => (
                <MessageBubble
                  key={i}
                  role={msg.role}
                  text={msg.text}
                  avatar={character?.avatar}
                  streaming={Boolean(msg.streaming)}
                />
              ))
            )}
            {thinking && (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {character?.name ?? "The character"} is thinking…
              </span>
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="border-t p-3">
        <form className="flex items-end gap-2" onSubmit={onSubmit}>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message the character…"
            rows={1}
            className="max-h-32 min-h-9 resize-none"
          />
          <Button
            type="submit"
            size="icon"
            disabled={draft.trim().length === 0}
            aria-label="Send"
          >
            <Send />
          </Button>
        </form>
      </div>
    </div>
  );
}

function MessageBubble({
  role,
  text,
  avatar,
  streaming,
}: {
  role: "user" | "character";
  text: string;
  avatar?: string;
  streaming: boolean;
}) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2">
      {avatar && (
        <span aria-hidden className="text-xl leading-none">
          {avatar}
        </span>
      )}
      <p className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
        {text}
        {streaming && (
          <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-foreground/70 align-middle" />
        )}
      </p>
    </div>
  );
}
