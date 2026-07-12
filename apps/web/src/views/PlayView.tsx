import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { CharacterCard } from "@/components/play/CharacterCard";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { Separator } from "@/components/ui/separator";
import { listCharacters } from "@/lib/api";

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/**
 * The `/play` route: a roster of characters to challenge. Picking a side on a
 * card creates a game and hands off to `PlayGameView`.
 */
export function PlayView() {
  const charactersQuery = useQuery({
    queryKey: ["play-characters"],
    queryFn: listCharacters,
  });

  const characters = charactersQuery.data ?? [];

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <h1 className="text-lg font-semibold">Choose your opponent</h1>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
        </div>
      </header>

      <Separator />

      <div className="flex-1 overflow-y-auto p-4">
        {charactersQuery.isLoading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        )}

        {charactersQuery.isError && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Could not load characters. {errorMessage(charactersQuery.error)}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {characters.map((character) => (
            <CharacterCard key={character.id} character={character} />
          ))}
        </div>
      </div>
    </div>
  );
}
