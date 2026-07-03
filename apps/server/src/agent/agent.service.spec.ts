import type { ModelInfo } from "@chess/shared";
import { AgentService } from "./agent.service";
import type { AgentHarness } from "./harness/agent-harness";
import type { ChessToolsService } from "./chess-tools.service";
import type { ChessService } from "../chess/chess.service";
import type { GameStore } from "../chess/game.store";
import { ModelFilter, createModelFilterFromEnv } from "./model-filter";

const MODELS: ModelInfo[] = [
  { id: "deepseek/deepseek-r1:free", provider: "openrouter" },
  { id: "claude-opus-4-8", provider: "anthropic" },
];

/**
 * Construct AgentService with only the collaborators the model-access paths touch
 * (harness.listModels + the filter). The chess/tools/store deps are unused here.
 */
function makeService(models: ModelInfo[], filter: ModelFilter): AgentService {
  const harness = {
    listModels: () => Promise.resolve(models),
  } as unknown as AgentHarness;
  return new AgentService(
    {} as ChessToolsService,
    {} as ChessService,
    {} as GameStore,
    harness,
    filter,
  );
}

/** resolveModel is private; reach it directly to test the session-creation guardrail. */
function resolveModel(
  svc: AgentService,
  requested?: string,
): Promise<string | undefined> {
  return (
    svc as unknown as {
      resolveModel(r?: string): Promise<string | undefined>;
    }
  ).resolveModel(requested);
}

const freeOnly = () =>
  makeService(
    MODELS,
    createModelFilterFromEnv({ AGENT_MODEL_FILTER: "openrouter-free" }),
  );

describe("AgentService.listModels", () => {
  it("passes every backend model through when unrestricted", async () => {
    const svc = makeService(MODELS, createModelFilterFromEnv({}));
    expect((await svc.listModels()).map((m) => m.id)).toEqual([
      "deepseek/deepseek-r1:free",
      "claude-opus-4-8",
    ]);
  });

  it("narrows to permitted models when restricted", async () => {
    expect((await freeOnly().listModels()).map((m) => m.id)).toEqual([
      "deepseek/deepseek-r1:free",
    ]);
  });
});

describe("AgentService session model resolution", () => {
  it("passes the request through untouched when unrestricted", async () => {
    const svc = makeService(MODELS, createModelFilterFromEnv({}));
    // undefined stays undefined → the harness picks its own default.
    expect(await resolveModel(svc, undefined)).toBeUndefined();
    expect(await resolveModel(svc, "claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("honors a permitted explicit model when restricted", async () => {
    expect(await resolveModel(freeOnly(), "deepseek/deepseek-r1:free")).toBe(
      "deepseek/deepseek-r1:free",
    );
  });

  it("substitutes the first permitted model for a disallowed explicit model", async () => {
    expect(await resolveModel(freeOnly(), "claude-opus-4-8")).toBe(
      "deepseek/deepseek-r1:free",
    );
  });

  it("substitutes a permitted model when none is chosen (never the paid harness default)", async () => {
    expect(await resolveModel(freeOnly(), undefined)).toBe(
      "deepseek/deepseek-r1:free",
    );
  });

  it("throws when the policy permits nothing", async () => {
    const svc = makeService(
      [{ id: "claude-opus-4-8", provider: "anthropic" }],
      createModelFilterFromEnv({ AGENT_MODEL_FILTER: "openrouter-free" }),
    );
    await expect(resolveModel(svc, undefined)).rejects.toThrow(
      /no permitted models/i,
    );
  });
});
