import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Character, PlaySide } from "@chess/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { createPlayGame } from "@/lib/api";
import { usePlayStore } from "@/playStore";

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

function strengthStars(strength: Character["strength"]): string {
  return "★".repeat(strength) + "☆".repeat(5 - strength);
}

/**
 * A roster entry for `/play`: collapsed shows avatar/name/tagline/strength/style,
 * expanded (on click) adds the bio and three side-pick buttons that create a game
 * and hand off to `PlayGameView`.
 */
export function CharacterCard({ character }: { character: Character }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);

  const startMutation = useMutation({
    mutationFn: (side: PlaySide | "random") =>
      createPlayGame({ characterId: character.id, side }),
    onSuccess: (game) => {
      usePlayStore.getState().start(game, character);
      // route registered in Task 12 (play game view)
      void navigate({
        to: "/play/$gameId",
        params: { gameId: game.id },
      } as never);
    },
    onError: (err) =>
      toast.error("Could not start game", { description: errorMessage(err) }),
  });

  return (
    <Card
      className="cursor-pointer gap-3 p-4 text-center"
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="text-5xl" aria-hidden>
        {character.avatar}
      </div>
      <div className="font-semibold">{character.name}</div>
      <div className="text-sm italic text-muted-foreground">
        {character.tagline}
      </div>
      <div className="text-sm" aria-label={`Strength ${character.strength} of 5`}>
        {strengthStars(character.strength)}
      </div>
      <Badge variant="secondary" className="mx-auto">
        {character.styleTag}
      </Badge>

      {expanded && (
        <div
          className="flex flex-col gap-3 pt-2"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-left text-sm text-muted-foreground">
            {character.bio}
          </p>
          <div className="flex flex-col gap-2">
            <Button
              size="sm"
              disabled={startMutation.isPending}
              onClick={() => startMutation.mutate("white")}
            >
              Play as White
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={startMutation.isPending}
              onClick={() => startMutation.mutate("black")}
            >
              Play as Black
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={startMutation.isPending}
              onClick={() => startMutation.mutate("random")}
            >
              Random
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
