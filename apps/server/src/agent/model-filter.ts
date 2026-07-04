import type { ModelInfo } from "@chess/shared";

/** DI token for the {@link ModelFilter} provider. */
export const MODEL_FILTER = "MODEL_FILTER";

/**
 * OpenRouter tags every free-tier model with a `:free` id suffix (e.g.
 * `deepseek/deepseek-r1:free`); no paid model uses it. So free-tier membership is
 * decidable from the id alone — which lets the same rule gate both the picker list
 * and an explicit `?model=` at session creation.
 */
function isOpenRouterFree(id: string): boolean {
  const lower = id.toLowerCase();
  // `openrouter/free` is OpenRouter's "Free Models Router" — it routes only among
  // free models, so it belongs to the free tier despite lacking the `:free` suffix.
  // (`openrouter/auto` is deliberately excluded: it can route to paid models.)
  return lower === "openrouter/free" || lower.endsWith(":free");
}

const ALLOW_ALL = (): boolean => true;

/**
 * A model-access policy: which models the agent may list and use. `apply` narrows
 * the picker's list; `allows` gates an explicit model id at session creation. Kept
 * backend-neutral so it wraps whatever the active harness offers.
 */
export class ModelFilter {
  constructor(
    private readonly permits: (id: string) => boolean,
    /** Whether any restriction is in force (`false` = every model is permitted). */
    readonly restricted: boolean,
  ) {}

  /** Keep only permitted models — the set the picker shows. */
  apply(models: ModelInfo[]): ModelInfo[] {
    return models.filter((m) => this.permits(m.id));
  }

  /** Whether an explicit model id may be used to create or resume a session. */
  allows(id: string): boolean {
    return this.permits(id);
  }
}

/**
 * Resolve the model-access policy from the environment, mirroring
 * {@link createHarnessFromEnv}. `AGENT_MODEL_FILTER=openrouter-free` restricts the
 * agent to OpenRouter free-tier models (id ending in `:free`) — set it in production
 * so public traffic can never reach a paid model. Unset or `all` permits every model.
 * Pure, so it is unit-testable without booting Nest.
 */
export function createModelFilterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ModelFilter {
  const mode = (env.AGENT_MODEL_FILTER ?? "all").toLowerCase();
  return mode === "openrouter-free"
    ? new ModelFilter(isOpenRouterFree, true)
    : new ModelFilter(ALLOW_ALL, false);
}
