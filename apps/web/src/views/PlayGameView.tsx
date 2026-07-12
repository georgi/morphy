import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { Chess } from "chess.js";
import { Chessboard, type ChessboardOptions, type PieceDropHandlerArgs } from "react-chessboard";
import { Flag, Handshake, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Character, PlayEvent, PlayGame } from "@chess/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PlayChat } from "@/components/play/PlayChat";
import {
  ApiError,
  getPlayGame,
  listCharacters,
  offerPlayDraw,
  openPlayStream,
  resignPlayGame,
  sendPlayMove,
} from "@/lib/api";
import { usePlayStore } from "@/playStore";

function strengthStars(strength: Character["strength"]): string {
  return "★".repeat(strength) + "☆".repeat(5 - strength);
}

/** A minimal fallback if the character roster no longer has this id (shouldn't happen). */
function unknownCharacter(characterId: string): Character {
  return {
    id: characterId,
    name: "Unknown opponent",
    avatar: "♟",
    tagline: "",
    bio: "",
    strength: 3,
    styleTag: "",
  };
}

/**
 * Compute the UCI move (with auto-queen promotion) for a drag from→to on `fen`,
 * mirroring `BoardPanel`'s free-move drop: chess.js validates locally so an
 * illegal drop can snap back without a round trip, and a legal one yields the
 * long-algebraic UCI string the server expects.
 */
function computeUci(fen: string, from: string, to: string): string | null {
  try {
    const move = new Chess(fen).move({ from, to, promotion: "q" });
    return move.lan;
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/**
 * The `/play/$gameId` screen: a live board (SSE-driven AI replies), the
 * character's name plate above and the human's below, a resign/draw control
 * strip, and the persona chat. Deep-linking (a fresh tab, a refresh) refetches
 * the game and resolves the character from the roster since sessions are
 * memory-only server-side.
 */
export function PlayGameView() {
  const { gameId } = useParams({ from: "/play/$gameId" });
  const game = usePlayStore((s) => s.game);
  const character = usePlayStore((s) => s.character);
  const thinking = usePlayStore((s) => s.thinking);

  const [loadState, setLoadState] = useState<"loading" | "ready" | "not-found">(
    usePlayStore.getState().game?.id === gameId ? "ready" : "loading",
  );

  // Fetch the game (+ resolve the character) when this isn't already the game
  // in the store — i.e. a deep link or a refresh, since the store resets.
  useEffect(() => {
    let cancelled = false;
    if (usePlayStore.getState().game?.id === gameId) {
      setLoadState("ready");
      return;
    }
    setLoadState("loading");
    (async () => {
      try {
        const [fetchedGame, characters] = await Promise.all([
          getPlayGame(gameId),
          listCharacters(),
        ]);
        if (cancelled) return;
        const resolvedCharacter =
          characters.find((c) => c.id === fetchedGame.characterId) ??
          unknownCharacter(fetchedGame.characterId);
        usePlayStore.getState().start(fetchedGame, resolvedCharacter);
        setLoadState("ready");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setLoadState("not-found");
        } else {
          toast.error("Could not load the game", { description: errorMessage(err) });
          setLoadState("not-found");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameId]);

  // Open the live event stream and translate PlayEvents into store actions.
  // Gated on `loadState === "ready"` so a deep link never opens the stream
  // before the game (and thus `applyEvent`'s null-`game` guards) is in the
  // store — otherwise an early `ai_move` could arrive and be silently
  // dropped — and never opens it at all for a 404'd game.
  useEffect(() => {
    if (loadState !== "ready") return;
    const source = openPlayStream(gameId);
    source.onmessage = (msg) => {
      try {
        usePlayStore.getState().applyEvent(JSON.parse(msg.data) as PlayEvent);
      } catch {
        // ignore malformed frames; the server controls the wire format
      }
    };
    source.onerror = () => {
      usePlayStore.getState().setStreamStatus("error");
    };
    usePlayStore.getState().setStreamStatus("open");
    return () => source.close();
  }, [gameId, loadState]);

  if (loadState === "not-found") {
    return <GameNotFoundCard />;
  }

  if (loadState === "loading" || !game) {
    return (
      <div className="flex h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading…
      </div>
    );
  }

  return <PlayGameLayout gameId={gameId} game={game} character={character} thinking={thinking} />;
}

function GameNotFoundCard() {
  return (
    <div className="flex h-screen items-center justify-center p-4">
      <Card className="max-w-sm gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          This game has ended or was lost on restart.
        </p>
        <Button asChild>
          <Link to="/play">Back to characters</Link>
        </Button>
      </Card>
    </div>
  );
}

function PlayGameLayout({
  gameId,
  game,
  character,
  thinking,
}: {
  gameId: string;
  game: PlayGame;
  character: Character | null;
  thinking: boolean;
}) {
  const orientation = game.side;
  const gameOver = game.status !== "active";

  const onPieceDrop = useMemo(
    () =>
      ({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean => {
        if (!targetSquare) return false;
        const store = usePlayStore.getState();
        const current = store.game;
        if (!current) return false;
        if (store.thinking) return false;
        if (current.status !== "active") return false;
        // Not the human's turn: fen's active-color letter must match their side.
        if (current.fen.split(" ")[1] !== current.side[0]) return false;

        const uci = computeUci(current.fen, sourceSquare, targetSquare);
        if (!uci) return false;

        store.setThinking(true);
        void (async () => {
          try {
            const updated = await sendPlayMove(gameId, uci);
            usePlayStore.getState().setGame(updated);
          } catch (err) {
            usePlayStore.getState().setThinking(false);
            toast.error("Move failed", { description: errorMessage(err) });
            try {
              const fresh = await getPlayGame(gameId);
              usePlayStore.getState().setGame(fresh);
            } catch {
              // If the resync also fails, the SSE stream/error banner covers it.
            }
          }
        })();
        return true;
      },
    [gameId],
  );

  const options: ChessboardOptions = useMemo(
    () => ({
      position: game.fen,
      boardOrientation: orientation,
      allowDragging: !gameOver && !thinking,
      onPieceDrop,
      allowDrawingArrows: false,
      showAnimations: true,
      animationDurationInMs: 200,
      lightSquareStyle: { backgroundColor: "var(--board-light)" },
      darkSquareStyle: { backgroundColor: "var(--board-dark)" },
      lightSquareNotationStyle: { color: "var(--board-dark)" },
      darkSquareNotationStyle: { color: "var(--board-light)" },
      showNotation: true,
    }),
    [game.fen, orientation, gameOver, thinking, onPieceDrop],
  );

  return (
    <div className="grid h-screen grid-cols-[1fr_360px]">
      <div className="flex min-h-0 flex-col items-center justify-center gap-2 p-4">
        <CharacterPlate character={character} />
        <div className="aspect-square w-full max-w-[min(70vh,100%)]">
          <Chessboard options={options} />
        </div>
        <UserPlate side={game.side} />
        <ControlStrip gameId={gameId} gameOver={gameOver} />
      </div>
      <div className="min-h-0 border-l">
        <PlayChat gameId={gameId} />
      </div>
    </div>
  );
}

function CharacterPlate({ character }: { character: Character | null }) {
  if (!character) return null;
  return (
    <div className="flex w-full max-w-[min(70vh,100%)] items-center gap-2 px-1 text-sm">
      <span aria-hidden className="text-2xl leading-none">
        {character.avatar}
      </span>
      <span className="font-medium">{character.name}</span>
      <span
        className="ml-auto text-muted-foreground"
        aria-label={`Strength ${character.strength} of 5`}
      >
        {strengthStars(character.strength)}
      </span>
    </div>
  );
}

function UserPlate({ side }: { side: "white" | "black" }) {
  return (
    <div className="flex w-full max-w-[min(70vh,100%)] items-center gap-1.5 px-1 text-sm">
      <span aria-hidden className="text-muted-foreground">
        {side === "white" ? "○" : "●"}
      </span>
      <span className="font-medium">You</span>
    </div>
  );
}

function ControlStrip({ gameId, gameOver }: { gameId: string; gameOver: boolean }) {
  const [resigning, setResigning] = useState(false);
  const [offeringDraw, setOfferingDraw] = useState(false);

  async function confirmResign() {
    setResigning(true);
    try {
      const updated = await resignPlayGame(gameId);
      usePlayStore.getState().setGame(updated);
    } catch (err) {
      toast.error("Could not resign", { description: errorMessage(err) });
    } finally {
      setResigning(false);
    }
  }

  async function offerDraw() {
    setOfferingDraw(true);
    try {
      await offerPlayDraw(gameId);
    } catch (err) {
      toast.error("Could not offer a draw", { description: errorMessage(err) });
    } finally {
      setOfferingDraw(false);
    }
  }

  return (
    <div className="flex w-full max-w-[min(70vh,100%)] gap-2 px-1 pt-1">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={gameOver || resigning}
          >
            <Flag />
            Resign
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56">
          <p className="mb-2 text-sm">Resign this game?</p>
          <Button
            variant="destructive"
            size="sm"
            disabled={resigning}
            onClick={confirmResign}
          >
            Confirm resign
          </Button>
        </PopoverContent>
      </Popover>
      <Button
        variant="outline"
        size="sm"
        disabled={gameOver || offeringDraw}
        onClick={offerDraw}
      >
        <Handshake />
        Offer draw
      </Button>
    </div>
  );
}
