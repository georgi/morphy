import type { ModelInfo } from "@chess/shared";
import { ModelFilter, createModelFilterFromEnv } from "./model-filter";

/** A mixed list: two OpenRouter free models (`:free`) and two paid ones. */
const MODELS: ModelInfo[] = [
  { id: "deepseek/deepseek-r1:free", provider: "openrouter" },
  { id: "meta-llama/llama-3.3-70b-instruct:free", provider: "openrouter" },
  { id: "anthropic/claude-opus-4-8", provider: "openrouter" },
  { id: "claude-opus-4-8", provider: "anthropic" },
];

describe("createModelFilterFromEnv", () => {
  it("is unrestricted when AGENT_MODEL_FILTER is unset", () => {
    const filter = createModelFilterFromEnv({});
    expect(filter.restricted).toBe(false);
    expect(filter.apply(MODELS)).toEqual(MODELS);
  });

  it("is unrestricted for AGENT_MODEL_FILTER=all", () => {
    const filter = createModelFilterFromEnv({ AGENT_MODEL_FILTER: "all" });
    expect(filter.restricted).toBe(false);
    expect(filter.apply(MODELS)).toHaveLength(MODELS.length);
  });

  it("treats an unrecognized value as unrestricted (never silently over-restricts)", () => {
    const filter = createModelFilterFromEnv({ AGENT_MODEL_FILTER: "nonsense" });
    expect(filter.restricted).toBe(false);
    expect(filter.apply(MODELS)).toHaveLength(MODELS.length);
  });

  it("restricts to the OpenRouter free tier for AGENT_MODEL_FILTER=openrouter-free", () => {
    const filter = createModelFilterFromEnv({
      AGENT_MODEL_FILTER: "openrouter-free",
    });
    expect(filter.restricted).toBe(true);
    expect(filter.apply(MODELS).map((m) => m.id)).toEqual([
      "deepseek/deepseek-r1:free",
      "meta-llama/llama-3.3-70b-instruct:free",
    ]);
  });

  it("matches the mode case-insensitively (AGENT_MODEL_FILTER=OpenRouter-Free)", () => {
    const filter = createModelFilterFromEnv({
      AGENT_MODEL_FILTER: "OpenRouter-Free",
    });
    expect(filter.restricted).toBe(true);
    expect(filter.apply(MODELS)).toHaveLength(2);
  });
});

describe("ModelFilter.allows (free tier)", () => {
  const filter = createModelFilterFromEnv({
    AGENT_MODEL_FILTER: "openrouter-free",
  });

  it("permits a :free model id", () => {
    expect(filter.allows("deepseek/deepseek-r1:free")).toBe(true);
  });

  it("rejects a paid model id", () => {
    expect(filter.allows("claude-opus-4-8")).toBe(false);
  });

  it("matches the :free suffix case-insensitively", () => {
    expect(filter.allows("Some/Model:FREE")).toBe(true);
  });

  it("permits the openrouter/free auto-router (a free-only router, no :free suffix)", () => {
    expect(filter.allows("openrouter/free")).toBe(true);
  });

  it("still rejects openrouter/auto (routes to paid models)", () => {
    expect(filter.allows("openrouter/auto")).toBe(false);
  });
});

describe("ModelFilter (unrestricted) allows everything", () => {
  const filter = new ModelFilter(() => true, false);
  it("permits any id", () => {
    expect(filter.allows("claude-opus-4-8")).toBe(true);
    expect(filter.allows("deepseek/deepseek-r1:free")).toBe(true);
  });
});
