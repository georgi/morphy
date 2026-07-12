import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import type { Game, PlayEndReason, PlayResult, PlaySide } from "@chess/shared";
import { normalizedSanList } from "@chess/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { gamesRepo } from "@/lib/db/games-repo";
import { createPlayGame } from "@/lib/api";
import { usePlayStore } from "@/playStore";
import { useAnalyzerStore } from "@/store";

const RESULT_LABELS: Record<PlayResult, string> = {
  "1-0": "1–0",
  "0-1": "0–1",
  "1/2-1/2": "½–½",
};

const REASON_LABELS: Record<PlayEndReason, string> = {
  checkmate: "Checkmate",
  stalemate: "Stalemate",
  draw: "Draw",
  resignation: "Resignation",
  agreement: "Draw by agreement",
};

function opposite(side: PlaySide): PlaySide {
  return side === "white" ? "black" : "white";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/**
 * Browser-safe re-implementation of `@chess/shared`'s `contentHash`: same
 * `sha256(normalizedSanList + '|' + white + '|' + black + '|' + date + '|' +
 * result)` recipe, but via SubtleCrypto instead of `node:crypto` —
 * `createHash` isn't available client-side (Vite externalizes `node:crypto`
 * to an empty stub in the browser bundle, so calling the shared function
 * directly here would throw at runtime).
 */
async function browserContentHash(game: Game): Promise<string> {
  const h = game.headers;
  const parts = [
    normalizedSanList(game),
    h.white ?? "",
    h.black ?? "",
    h.date ?? "",
    h.result ?? "",
  ];
  const data = new TextEncoder().encode(parts.join("|"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The end-of-game card shown once `game.status === "over"` (and not yet
 * dismissed): result line, character avatar, the streaming parting shot (the
 * last character chat message — arrives AFTER `game_over`), and the
 * Analyze/Rematch/New opponent/dismiss actions. Dismissing (the built-in
 * Dialog X) just sets `overlayDismissed` — the chat behind it stays usable.
 */
export function GameOverOverlay() {
  const navigate = useNavigate();
  const game = usePlayStore((s) => s.game);
  const character = usePlayStore((s) => s.character);
  const chat = usePlayStore((s) => s.chat);
  const overlayDismissed = usePlayStore((s) => s.overlayDismissed);

  if (!game || game.status !== "over") return null;
  const finishedGame = game;

  const open = !overlayDismissed;
  const resultLabel = game.result ? RESULT_LABELS[game.result] : "Game over";
  const reasonLabel = game.endReason ? REASON_LABELS[game.endReason] : null;

  let partingShot: (typeof chat)[number] | undefined;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i].role === "character") {
      partingShot = chat[i];
      break;
    }
  }
  const showEllipsis = !partingShot || partingShot.streaming;

  async function handleAnalyze() {
    if (!character) return;
    const finished: Game = {
      id: finishedGame.id,
      headers: {
        white: finishedGame.side === "white" ? "You" : character.name,
        black: finishedGame.side === "black" ? "You" : character.name,
        result: finishedGame.result,
        event: `Play vs ${character.name}`,
        date: new Date().toISOString().slice(0, 10).replace(/-/g, "."),
      },
      startFen: finishedGame.startFen,
      moves: finishedGame.moves,
    };
    try {
      await gamesRepo.put(finished, {
        source: "manual",
        createdAt: Date.now(),
        contentHash: await browserContentHash(finished),
      });
      useAnalyzerStore.getState().setGame(finished);
      void navigate({ to: "/" });
    } catch (err) {
      toast.error("Could not save the game", { description: errorMessage(err) });
    }
  }

  async function handleRematch() {
    if (!character) return;
    try {
      const rematch = await createPlayGame({
        characterId: character.id,
        side: opposite(finishedGame.side),
      });
      usePlayStore.getState().start(rematch, character);
      void navigate({ to: "/play/$gameId", params: { gameId: rematch.id } });
    } catch (err) {
      toast.error("Could not start a rematch", { description: errorMessage(err) });
    }
  }

  function handleNewOpponent() {
    usePlayStore.getState().reset();
    void navigate({ to: "/play" });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) usePlayStore.getState().dismissOverlay();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-2xl">
            {resultLabel}
            {reasonLabel ? ` · ${reasonLabel}` : ""}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex items-start gap-2 pt-1 text-left">
              {character && (
                <span aria-hidden className="text-xl leading-none">
                  {character.avatar}
                </span>
              )}
              <p className="text-sm text-foreground">
                {partingShot?.text}
                {showEllipsis && (
                  <span className="text-muted-foreground">…</span>
                )}
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="sm:justify-start">
          <Button onClick={() => void handleAnalyze()}>
            Analyze this game
          </Button>
          <Button variant="outline" onClick={() => void handleRematch()}>
            Rematch
          </Button>
          <Button variant="outline" onClick={handleNewOpponent}>
            New opponent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
