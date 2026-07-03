import { ChevronsUpDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { ModelInfo } from "@chess/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import * as api from "@/lib/api";
import { useAnalyzerStore } from "@/store";

/** Human label for a model row: its `label`, falling back to the raw id. */
function modelLabel(m: ModelInfo): string {
  return m.label ?? m.id;
}

/**
 * Chat-header control for choosing the agent model. Lists the active backend's
 * models (`GET /agent/models`) and calls `setModel`, which starts a fresh chat on
 * the new model and reopens the stream with `?model=`.
 *
 * The store's `model` is undefined until the user picks one (undefined = backend
 * default). With no explicit choice we present the first offered model as the
 * default so the trigger always names a concrete model; re-picking the currently
 * shown model is a no-op so it never needlessly resets the chat.
 */
export function ModelPicker() {
  const model = useAnalyzerStore((s) => s.model);
  const setModel = useAnalyzerStore((s) => s.setModel);

  const {
    data: models = [],
    isPending,
    isError,
  } = useQuery({
    queryKey: ["agent-models"],
    queryFn: api.listModels,
    staleTime: Infinity, // the backend's model set is stable within a session
  });

  const effectiveId = model ?? models[0]?.id;
  const selected = models.find((m) => m.id === effectiveId);
  const triggerLabel = selected
    ? modelLabel(selected)
    : isPending
      ? "Loading…"
      : "Model";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          disabled={isError || models.length === 0}
          className="min-w-0 gap-1 font-normal text-muted-foreground"
          aria-label="Select model"
          title="Model"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[12rem]">
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={effectiveId}
          onValueChange={(id) => {
            // Re-picking the active model would needlessly reset the chat.
            if (id !== effectiveId) setModel(id);
          }}
        >
          {models.map((m) => (
            <DropdownMenuRadioItem key={m.id} value={m.id}>
              <span className="truncate">{modelLabel(m)}</span>
              {m.contextWindow ? (
                <span className="ml-auto pl-3 text-xs text-muted-foreground">
                  {Math.round(m.contextWindow / 1000)}k
                </span>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
