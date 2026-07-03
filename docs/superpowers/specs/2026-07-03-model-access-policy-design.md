# Configurable model-access policy (production = OpenRouter free tier)

**Date:** 2026-07-03
**Status:** implemented

## Problem

The model picker (and the `?model=` stream query) currently expose every model the
active agent backend offers. In production we want to restrict the agent to
**OpenRouter's free tier** so public traffic can never reach a paid model — while
keeping every model available in development. The restriction must be
**configurable**, not hardcoded to `NODE_ENV`.

## Decision

A small, env-driven **model-access policy** applied at the backend-neutral choke
points, mirroring the existing `createHarnessFromEnv` pattern.

- **Identification (semantic, not a maintained list):** OpenRouter tags every
  free-tier model with a `:free` id suffix; no paid model uses it. So the free-tier
  rule is simply `id` ends with `:free`. New free models appear automatically; paid
  models can never slip through, and there is no id list to keep up to date.
- **Activation (dedicated env var):** `AGENT_MODEL_FILTER`.
  - unset / `all` → no restriction (development default).
  - `openrouter-free` → only `:free` models. Set this in the production deploy.
    Decoupled from `NODE_ENV` so it is unit-testable and can be exercised locally/staging.

## Components

- **`ModelFilter`** (`apps/server/src/agent/model-filter.ts`): a policy object.
  - `apply(models: ModelInfo[]): ModelInfo[]` — keep only permitted models (the picker list).
  - `allows(id: string): boolean` — may this explicit model id create/resume a session?
  - `restricted: boolean` — is any restriction in force?
  - `createModelFilterFromEnv(env)` — pure factory resolving the mode from `AGENT_MODEL_FILTER`.
  - DI token `MODEL_FILTER`, provided in `AgentModule` alongside `AGENT_HARNESS`.

## Enforcement (two choke points — list filtering alone is bypassable)

1. **`AgentService.listModels()`** returns `modelFilter.apply(await harness.listModels())`
   — the picker only ever shows permitted models.
2. **`AgentService.createSession()`** resolves the effective model under the policy
   before handing it to the harness:
   - unrestricted → pass the request through as-is (`undefined` → harness default).
   - restricted → a permitted requested id is honored; anything else (a disallowed id,
     **or no explicit choice — whose harness default could be a paid model**) falls
     back to the first permitted model. Throws (surfaced onto the SSE stream as an
     `error` event) when the policy permits nothing.

   This closes the hole where the initial stream opens with no `?model=` and would
   otherwise fall through to the backend's own (possibly paid) default.

## Testing

- `model-filter.spec.ts` — factory mode resolution (unset/`all`/`openrouter-free`,
  case-insensitive) and `apply`/`allows`/`restricted` over a mixed model list.
- `agent.service.spec.ts` — `listModels()` filters in restricted mode and passes
  through when unrestricted; `resolveModel` honors a permitted id, and substitutes
  the first permitted model for a disallowed id / for no choice, and throws when the
  permitted set is empty.

## Out of scope

No frontend change: the picker already renders whatever `listModels()` returns and
sends the chosen id on `?model=`. Session-history/continue UI is unrelated.
