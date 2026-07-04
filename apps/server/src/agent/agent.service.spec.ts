import type { AgentEvent, ModelInfo } from "@chess/shared";
import { AgentService } from "./agent.service";
import type {
  AgentHarness,
  AgentRunner,
  AgentSessionConfig,
} from "./harness/agent-harness";
import type { ChessToolsService } from "./chess-tools.service";
import type { ChessService } from "../chess/chess.service";
import { ModelFilter, createModelFilterFromEnv } from "./model-filter";

const MODELS: ModelInfo[] = [
  { id: "deepseek/deepseek-r1:free", provider: "openrouter" },
  { id: "claude-opus-4-8", provider: "anthropic" },
];

/**
 * Construct AgentService with only the collaborators the model-access paths touch
 * (harness.listModels + the filter). The chess/tools deps are unused here.
 */
function makeService(models: ModelInfo[], filter: ModelFilter): AgentService {
  const harness = {
    listModels: () => Promise.resolve(models),
  } as unknown as AgentHarness;
  return new AgentService(
    {} as ChessToolsService,
    {} as ChessService,
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
  it("defaults to openrouter/free when none is chosen, else honors the request", async () => {
    const svc = makeService(MODELS, createModelFilterFromEnv({}));
    // No explicit choice → the always-available free router, not the harness default.
    expect(await resolveModel(svc, undefined)).toBe("openrouter/free");
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

  it("defaults to openrouter/free (permitted, always available) when none is chosen", async () => {
    expect(await resolveModel(freeOnly(), undefined)).toBe("openrouter/free");
  });

  it("throws when the policy permits nothing and an explicit disallowed model is asked for", async () => {
    const svc = makeService(
      [{ id: "claude-opus-4-8", provider: "anthropic" }],
      createModelFilterFromEnv({ AGENT_MODEL_FILTER: "openrouter-free" }),
    );
    await expect(resolveModel(svc, "claude-opus-4-8")).rejects.toThrow(
      /no permitted models/i,
    );
  });
});

// ── rate-limit fallback ──────────────────────────────────────────────────────

const FALLBACK_MODELS: ModelInfo[] = [
  { id: "m1", provider: "openrouter" },
  { id: "m2", provider: "openrouter" },
  { id: "m3", provider: "openrouter" },
];

function rateLimitError(model: string): Error {
  return new Error(
    `429 Provider returned error\n${model} is temporarily rate-limited upstream.`,
  );
}

/**
 * Build an AgentService over a fake harness whose runners rate-limit any model in
 * `rateLimited` and stream a token for the rest. Records the models actually
 * prompted so a test can assert which ones were tried and in what order.
 */
function makeFallbackService(rateLimited: Set<string>): {
  svc: AgentService;
  tried: string[];
} {
  const tried: string[] = [];
  const harness = {
    listModels: () => Promise.resolve(FALLBACK_MODELS),
    createSession: (cfg: AgentSessionConfig): Promise<AgentRunner> => {
      const model = cfg.model ?? "m1";
      const runner: AgentRunner = {
        id: `runner-${model}`,
        prompt: async () => {
          tried.push(model);
          cfg.emit({ type: "session", id: "sid", model });
          if (rateLimited.has(model)) throw rateLimitError(model);
          cfg.emit({ type: "text_delta", delta: "ok" });
        },
        dispose: () => {},
      };
      return Promise.resolve(runner);
    },
  } as unknown as AgentHarness;
  const tools = {
    buildToolsForSession: () => Promise.resolve([]),
  } as unknown as ChessToolsService;
  const svc = new AgentService(
    tools,
    {} as ChessService,
    harness,
    createModelFilterFromEnv({}),
  );
  return { svc, tried };
}

/** Collect the AgentEvents a turn emits: subscribe, run it, end the subject. */
async function runTurn(
  svc: AgentService,
  sessionId: string,
  model: string | undefined,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const stream = svc.getStream(sessionId, { model });
  const sub = stream.subscribe((e) => events.push(JSON.parse(e.data as string)));
  await svc.sendMessage(sessionId, { text: "hi" });
  sub.unsubscribe();
  return events;
}

describe("AgentService rate-limit fallback", () => {
  it("falls back to the next permitted model when the chosen one is rate-limited", async () => {
    const { svc, tried } = makeFallbackService(new Set(["m1"]));
    const events = await runTurn(svc, "s1", "m1");

    expect(tried).toEqual(["m1", "m2"]);
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("emits a notice announcing the model switch", async () => {
    const { svc } = makeFallbackService(new Set(["m1"]));
    const events = await runTurn(svc, "s2", "m1");

    const notice = events.find((e) => e.type === "notice");
    expect(notice).toBeDefined();
    expect((notice as { message: string }).message).toContain("m2");
  });

  it("surfaces a friendly error, not the raw 429, when every model is rate-limited", async () => {
    const { svc } = makeFallbackService(new Set(["m1", "m2", "m3"]));
    const events = await runTurn(svc, "s3", "m1");

    const error = events.find((e) => e.type === "error") as
      | { message: string }
      | undefined;
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/rate-limited/i);
    expect(error!.message).not.toContain("429 Provider returned error");
  });
});
