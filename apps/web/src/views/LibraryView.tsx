import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Library as LibraryIcon,
  Loader2,
  Swords,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type {
  Collection,
  GameSummary,
  ImportSource,
  LibraryQuery,
} from "@chess/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { ImportDialog } from "@/components/import/ImportDialog";
import { cn } from "@/lib/utils";
import { gamesRepo } from "@/lib/db/games-repo";
import { collectionsRepo } from "@/lib/db/collections-repo";
import { useAnalyzerStore, useLibraryStore } from "@/store";

const SOURCES: ImportSource[] = [
  "manual",
  "lichess",
  "chesscom",
  "catalog",
  "url",
];

type SortKey = NonNullable<LibraryQuery["sort"]>;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/** Shared styling for the native filter selects so they match Input/Button. */
const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";

/** The collections sidebar: "All games" plus one row per collection, with counts. */
function CollectionsSidebar({
  collections,
  activeId,
  onSelect,
}: {
  collections: Collection[];
  activeId: string | undefined;
  onSelect: (id: string | undefined) => void;
}) {
  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await gamesRepo.deleteByCollection(id);
      return collectionsRepo.delete(id);
    },
    onSuccess: (_data, id) => {
      if (activeId === id) onSelect(undefined);
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      toast.success("Collection deleted");
    },
    onError: (err) =>
      toast.error("Delete failed", { description: errorMessage(err) }),
  });

  return (
    <div className="flex h-full w-56 flex-col border-r">
      <div className="px-3 py-2 text-sm font-medium text-muted-foreground">
        Collections
      </div>
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 p-2">
          <button
            type="button"
            onClick={() => onSelect(undefined)}
            className={cn(
              "flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent",
              activeId === undefined && "bg-accent font-medium",
            )}
          >
            All games
          </button>
          {collections.map((c) => (
            <div
              key={c.id}
              className={cn(
                "group flex items-center gap-1 rounded-md pr-1 hover:bg-accent",
                activeId === c.id && "bg-accent",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                className={cn(
                  "flex min-w-0 flex-1 items-center justify-between gap-2 px-2 py-1.5 text-left text-sm",
                  activeId === c.id && "font-medium",
                )}
              >
                <span className="truncate">{c.name}</span>
                <Badge variant="secondary">{c.gameCount}</Badge>
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Delete collection ${c.name}`}
                className="opacity-0 group-hover:opacity-100"
                onClick={() => deleteMutation.mutate(c.id)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          {collections.length === 0 && (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              No collections yet.
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/** A clickable, sortable column header. */
function SortHeader({
  label,
  column,
  query,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  query: LibraryQuery;
  onSort: (column: SortKey) => void;
  className?: string;
}) {
  const active = query.sort === column;
  return (
    <th className={cn("px-3 py-2 text-left font-medium", className)}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        {active &&
          (query.dir === "asc" ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          ))}
      </button>
    </th>
  );
}

/**
 * The `/library` route: a searchable/sortable/paginated table of stored games
 * with a collections sidebar. Clicking a row loads the full game into the shared
 * analysis store and navigates to the board.
 */
export function LibraryView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useLibraryStore((s) => s.query);
  const setQuery = useLibraryStore((s) => s.setQuery);
  const setCollection = useLibraryStore((s) => s.setCollection);
  const setGame = useAnalyzerStore((s) => s.setGame);

  const collectionsQuery = useQuery({
    queryKey: ["collections"],
    queryFn: () => collectionsRepo.list(),
  });

  const libraryQuery = useQuery({
    queryKey: ["library", query],
    queryFn: () => gamesRepo.search(query),
  });

  const openMutation = useMutation({
    mutationFn: async (id: string) => {
      const game = await gamesRepo.get(id);
      if (!game) throw new Error("Game not found");
      return game;
    },
    onSuccess: (game) => {
      setGame(game);
      void navigate({ to: "/" });
    },
    onError: (err) =>
      toast.error("Could not open game", { description: errorMessage(err) }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => gamesRepo.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      toast.success("Game deleted");
    },
    onError: (err) =>
      toast.error("Delete failed", { description: errorMessage(err) }),
  });

  const onSort = (column: SortKey) => {
    if (query.sort === column) {
      setQuery({ dir: query.dir === "asc" ? "desc" : "asc" });
    } else {
      setQuery({ sort: column, dir: "asc" });
    }
  };

  const page = libraryQuery.data;
  const games = page?.games ?? [];
  const total = page?.total ?? 0;
  const limit = query.limit ?? 25;
  const offset = query.offset ?? 0;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + games.length, total);
  const canPrev = offset > 0;
  const canNext = offset + limit < total;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <LibraryIcon className="size-5" />
        <h1 className="text-lg font-semibold">Library</h1>
        <Separator orientation="vertical" className="!h-5" />
        <span className="hidden text-sm text-muted-foreground sm:inline">
          {total} {total === 1 ? "game" : "games"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/play">
              <Swords />
              Play
            </Link>
          </Button>
          <ImportDialog />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void navigate({ to: "/" })}
          >
            <ArrowLeft />
            Back to board
          </Button>
          <Separator orientation="vertical" className="!h-5" />
          <ThemeToggle />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <CollectionsSidebar
          collections={collectionsQuery.data ?? []}
          activeId={query.collectionId}
          onSelect={setCollection}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
            <Input
              value={query.q ?? ""}
              onChange={(e) => setQuery({ q: e.target.value || undefined })}
              placeholder="Search players, opening, ECO…"
              className="h-9 w-56"
              aria-label="Search"
            />
            <Input
              value={query.player ?? ""}
              onChange={(e) =>
                setQuery({ player: e.target.value || undefined })
              }
              placeholder="Player"
              className="h-9 w-36"
              aria-label="Player"
            />
            <Input
              value={query.eco ?? ""}
              onChange={(e) => setQuery({ eco: e.target.value || undefined })}
              placeholder="ECO"
              className="h-9 w-20"
              aria-label="ECO"
            />
            <select
              className={selectClass}
              aria-label="Result"
              value={query.result ?? ""}
              onChange={(e) =>
                setQuery({ result: e.target.value || undefined })
              }
            >
              <option value="">Any result</option>
              <option value="1-0">1-0</option>
              <option value="0-1">0-1</option>
              <option value="1/2-1/2">½-½</option>
            </select>
            <select
              className={selectClass}
              aria-label="Source"
              value={query.source ?? ""}
              onChange={(e) =>
                setQuery({
                  source: (e.target.value || undefined) as
                    | ImportSource
                    | undefined,
                })
              }
            >
              <option value="">Any source</option>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-background text-muted-foreground">
                <tr className="border-b">
                  <SortHeader
                    label="White"
                    column="white"
                    query={query}
                    onSort={onSort}
                  />
                  <SortHeader
                    label="Black"
                    column="black"
                    query={query}
                    onSort={onSort}
                  />
                  <th className="px-3 py-2 text-left font-medium">Result</th>
                  <th className="px-3 py-2 text-left font-medium">Opening</th>
                  <SortHeader
                    label="Date"
                    column="date"
                    query={query}
                    onSort={onSort}
                  />
                  <th className="px-3 py-2 text-left font-medium">Source</th>
                  <th className="px-3 py-2 text-left font-medium">Analyzed</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {games.map((g: GameSummary) => (
                  <tr
                    key={g.id}
                    onClick={() => openMutation.mutate(g.id)}
                    className="cursor-pointer border-b hover:bg-accent"
                  >
                    <td className="px-3 py-2">{g.white ?? "—"}</td>
                    <td className="px-3 py-2">{g.black ?? "—"}</td>
                    <td className="px-3 py-2">
                      {g.result && g.result !== "*" ? g.result : "—"}
                    </td>
                    <td className="max-w-48 truncate px-3 py-2">
                      {g.eco ? (
                        <span className="mr-1.5 text-muted-foreground">
                          {g.eco}
                        </span>
                      ) : null}
                      {g.opening ?? "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {g.date ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="outline">{g.source}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      {g.hasAnalysis ? (
                        <Badge variant="secondary">analyzed</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Delete game ${g.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteMutation.mutate(g.id);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {libraryQuery.isLoading && (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading…
              </div>
            )}
            {!libraryQuery.isLoading && games.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No games match these filters.
              </div>
            )}
          </ScrollArea>

          <div className="flex items-center justify-between border-t px-4 py-2 text-sm text-muted-foreground">
            <span>
              {pageStart}–{pageEnd} of {total}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!canPrev}
                onClick={() =>
                  setQuery({ offset: Math.max(0, offset - limit) })
                }
              >
                <ChevronLeft />
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!canNext}
                onClick={() => setQuery({ offset: offset + limit })}
              >
                Next
                <ChevronRight />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
