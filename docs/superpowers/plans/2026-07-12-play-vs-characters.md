# Play vs. Characters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Play mode where the user plays full games against LLM-personality opponents whose moves come from Stockfish candidates picked in character.

**Architecture:** New server `PlayModule` composes existing `EngineService`, `ChessService`, and the `AGENT_HARNESS` seam. Per game: a "mover" harness session returns structured JSON move picks from engine candidates; a "talker" harness session streams banter/chat over a per-game SSE stream. Web adds `/play` (roster grid) and `/play/$gameId` (board + persona chat) with a new Zustand `playStore`.

**Tech Stack:** NestJS, RxJS Subject→SSE (pattern: `agent.service.ts`/`agent.controller.ts`), chess.js via `ChessService`, Stockfish via `EngineService`, Pi/Claude harness behind `AGENT_HARNESS`, React 19 + TanStack Router/Query + Zustand + react-chessboard v5 (`<Chessboard options={...}/>`), shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-07-12-play-vs-characters-design.md`

## Global Constraints

- All cross-app types live in `packages/shared/src/index.ts` (`@chess/shared`); no type defined twice.
- Persona prompts and chess profiles NEVER reach the client — only the public `Character` subset.
- The game must never stall on LLM failure: any mover error/garbage → play engine best move silently.
- Engine scores are **White-POV centipawns** everywhere (see `EngineService`).
- No engine hints to the user during play (no eval bar, no classification badges, talker session has zero tools).
- Default LLM model id: `"openrouter/free"` (same as `DEFAULT_MODEL` in `agent.service.ts`).
- Run server tests with `pnpm --filter server test -- <path>`; web tests with `pnpm --filter web test -- <path>`; typecheck-build shared with `pnpm --filter @chess/shared build`.
- Commit after every task (conventional commits, as in `git log`).

---

### Task 1: Shared types

**Files:**
- Modify: `packages/shared/src/index.ts` (append at end, before `CLASSIFY_THRESHOLDS`)

**Interfaces:**
- Consumes: existing `Move`, `Color` from the same file.
- Produces (used by every later task): `Character`, `PlaySide`, `PlayStatus`, `PlayResult`, `PlayEndReason`, `PlayGame`, `CreatePlayGameRequest`, `PlayMoveRequest`, `PlayChatRequest`, `PlayEvent`.

- [ ] **Step 1: Add the types**

```ts
// ── Play mode ────────────────────────────────────────────────────────────────

/** Public projection of a play character (prompts/chess profile stay server-side). */
export interface Character {
  id: string;
  name: string;
  avatar: string; // emoji, v1
  tagline: string;
  bio: string;
  strength: 1 | 2 | 3 | 4 | 5;
  styleTag: string;
}

export type PlaySide = "white" | "black";
export type PlayStatus = "active" | "over";
export type PlayResult = "1-0" | "0-1" | "1/2-1/2";
export type PlayEndReason =
  | "checkmate"
  | "stalemate"
  | "draw" // 50-move / repetition / insufficient material
  | "resignation"
  | "agreement";

/** A live (or finished) play-mode game. `side` is the HUMAN's side. */
export interface PlayGame {
  id: string;
  characterId: string;
  side: PlaySide;
  startFen: string;
  fen: string;
  moves: Move[];
  status: PlayStatus;
  result?: PlayResult;
  endReason?: PlayEndReason;
}

export interface CreatePlayGameRequest {
  characterId: string;
  side: PlaySide | "random";
}
export interface PlayMoveRequest {
  move: string; // SAN or UCI
}
export interface PlayChatRequest {
  text: string;
}

/** Events streamed over `GET /api/play/:id/events` (SSE). */
export type PlayEvent =
  | { type: "ai_move"; move: Move; fen: string }
  | { type: "banter"; text: string } // whole-message quip from the move pick
  | { type: "chat_delta"; delta: string } // streamed talker output (chat replies, triggered banter, parting shot)
  | { type: "chat_done" }
  | { type: "draw_response"; accepted: boolean }
  | { type: "game_over"; result: PlayResult; reason: PlayEndReason }
  | { type: "error"; message: string };
```

- [ ] **Step 2: Build shared to verify it compiles**

Run: `pnpm --filter @chess/shared build`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): play-mode types (Character, PlayGame, PlayEvent)"
```

---

### Task 2: `ChessService.gameStatus`

**Files:**
- Modify: `apps/server/src/chess/chess.service.ts` (add method after `uciLineToSan`)
- Test: `apps/server/src/chess/chess.service.spec.ts` (append describe block)

**Interfaces:**
- Produces: `gameStatus(fen: string): GameStatus` where
  `GameStatus = { over: false } | { over: true; result: PlayResult; reason: Extract<PlayEndReason, "checkmate" | "stalemate" | "draw"> }`.
  Exported as `export type GameStatus` from `chess.service.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("gameStatus", () => {
  it("reports an ongoing game", () => {
    expect(
      service.gameStatus(
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      ),
    ).toEqual({ over: false });
  });

  it("reports checkmate with the winner", () => {
    // Fool's mate final position: Black has mated White.
    const fen =
      "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    expect(service.gameStatus(fen)).toEqual({
      over: true,
      result: "0-1",
      reason: "checkmate",
    });
  });

  it("reports stalemate as a draw", () => {
    const fen = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"; // black to move, stalemated
    expect(service.gameStatus(fen)).toEqual({
      over: true,
      result: "1/2-1/2",
      reason: "stalemate",
    });
  });

  it("reports insufficient material as a draw", () => {
    const fen = "8/8/4k3/8/8/4K3/8/8 w - - 0 1";
    expect(service.gameStatus(fen)).toEqual({
      over: true,
      result: "1/2-1/2",
      reason: "draw",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter server test -- chess.service`
Expected: FAIL — `service.gameStatus is not a function`.

- [ ] **Step 3: Implement**

```ts
export type GameStatus =
  | { over: false }
  | {
      over: true;
      result: "1-0" | "0-1" | "1/2-1/2";
      reason: "checkmate" | "stalemate" | "draw";
    };
```

Method on `ChessService`:

```ts
  /**
   * Terminal-state check for a position: checkmate (side to move loses),
   * stalemate, or a rules draw (repetition can't trigger from a lone FEN;
   * 50-move and insufficient material can).
   */
  gameStatus(fen: string): GameStatus {
    this.assertValidFen(fen);
    const chess = new Chess(fen);
    if (chess.isCheckmate()) {
      return {
        over: true,
        result: chess.turn() === "w" ? "0-1" : "1-0",
        reason: "checkmate",
      };
    }
    if (chess.isStalemate()) {
      return { over: true, result: "1/2-1/2", reason: "stalemate" };
    }
    if (chess.isDraw()) {
      return { over: true, result: "1/2-1/2", reason: "draw" };
    }
    return { over: false };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter server test -- chess.service`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/chess/chess.service.ts apps/server/src/chess/chess.service.spec.ts
git commit -m "feat(chess): gameStatus terminal-state detection"
```

---

### Task 3: Character registry + the 8 personas

**Files:**
- Create: `apps/server/src/play/characters.data.ts`
- Create: `apps/server/src/play/character-registry.service.ts`
- Test: `apps/server/src/play/character-registry.service.spec.ts`

**Interfaces:**
- Produces:

```ts
// characters.data.ts
export interface CharacterConfig {
  id: string;
  name: string;
  avatar: string;
  tagline: string;
  bio: string;
  strength: 1 | 2 | 3 | 4 | 5;
  styleTag: string;
  chess: {
    multiPv: number; // candidate pool size (3–8)
    evalWindowCp: number; // max cp below best considered (30–150)
    searchDepth: number; // engine depth for candidate generation
    blunderRate: number; // 0–1 chance to inject an offbeat legal move
    styleHints: string; // prose for the mover prompt
  };
  personaPrompt: string; // server-only
  banter: {
    chattiness: "low" | "medium" | "high";
    triggers: BanterTriggerKind[];
  };
}
export type BanterTriggerKind =
  | "user-blunder"
  | "user-mistake"
  | "user-good-move"
  | "capture"
  | "check"
  | "mate-threat";
export const CHARACTERS: CharacterConfig[];

// character-registry.service.ts
@Injectable() export class CharacterRegistry {
  list(): Character[];               // public subset only
  get(id: string): CharacterConfig;  // throws NotFoundException on unknown id
}
```

- [ ] **Step 1: Write the failing tests**

```ts
import { NotFoundException } from "@nestjs/common";
import { CharacterRegistry } from "./character-registry.service";

describe("CharacterRegistry", () => {
  const registry = new CharacterRegistry();

  it("lists 8 characters as the public subset only", () => {
    const list = registry.list();
    expect(list).toHaveLength(8);
    for (const c of list) {
      expect(c).toEqual({
        id: expect.any(String),
        name: expect.any(String),
        avatar: expect.any(String),
        tagline: expect.any(String),
        bio: expect.any(String),
        strength: expect.any(Number),
        styleTag: expect.any(String),
      });
      // leak check: no server-only fields
      expect(c).not.toHaveProperty("personaPrompt");
      expect(c).not.toHaveProperty("chess");
      expect(c).not.toHaveProperty("banter");
    }
  });

  it("returns the full config by id", () => {
    const hustler = registry.get("hustler");
    expect(hustler.personaPrompt).toContain("Washington Square");
    expect(hustler.chess.multiPv).toBeGreaterThanOrEqual(6);
  });

  it("throws NotFoundException for unknown ids", () => {
    expect(() => registry.get("nope")).toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter server test -- character-registry`
Expected: FAIL — cannot find module `./character-registry.service`.

- [ ] **Step 3: Implement the data file**

`characters.data.ts` — the interface from the Interfaces block above, plus all 8 configs. Persona prompts below are the actual v1 content; each ends with the shared discipline paragraph via the `USEFUL` constant:

```ts
const USEFUL =
  "Stay in character at all times, but smuggle genuinely useful chess insight into the bit: name real motifs, real squares, real plans. Keep every message to 1-3 short sentences. Never reveal engine evaluations or the objectively best move for the OPPONENT's current decision.";

export const CHARACTERS: CharacterConfig[] = [
  {
    id: "norwegian",
    name: "The Norwegian",
    avatar: "👑",
    tagline: "This is, objectively, lost for you.",
    bio: "The strongest player alive, allegedly. Grinds 'equal' endgames until you crack, then acts surprised you lasted that long.",
    strength: 5,
    styleTag: "Universal",
    chess: {
      multiPv: 3,
      evalWindowCp: 30,
      searchDepth: 16,
      blunderRate: 0,
      styleHints:
        "Prefer the most precise move. In equal positions prefer the move that keeps more pieces on and poses the longest-term problems. Simplify only into clearly better endgames.",
    },
    personaPrompt: `You are The Norwegian, a bored world-champion-caliber grandmaster playing a casual game. You are polite, faintly amused, and devastatingly matter-of-fact. You describe winning positions as "slightly more pleasant" and lost positions (yours, hypothetically) as "interesting". You never trash-talk loudly; your confidence does it for you. ${USEFUL}`,
    banter: { chattiness: "low", triggers: ["user-blunder", "mate-threat"] },
  },
  {
    id: "speedrunner",
    name: "The Speedrunner",
    avatar: "⚡",
    tagline: "Chat, takes takes takes, and it's just winning.",
    bio: "A streamer GM who narrates everything to an imaginary chat, sighs at your moves, and premoves in a game with no clock.",
    strength: 5,
    styleTag: "Sharp",
    chess: {
      multiPv: 4,
      evalWindowCp: 40,
      searchDepth: 14,
      blunderRate: 0,
      styleHints:
        "Prefer forcing sequences: checks, captures, threats. Take free material instantly. Prefer the move that creates immediate tactical problems.",
    },
    personaPrompt: `You are The Speedrunner, a blitz-addicted streamer grandmaster. You narrate to an imaginary Twitch chat ("chat, look at this"), speak in rapid-fire fragments, and rate everything as either "completely winning" or "completely losing". You are cocky but genuinely instructive when a tactic appears. ${USEFUL}`,
    banter: {
      chattiness: "high",
      triggers: ["user-blunder", "user-mistake", "capture", "check", "mate-threat"],
    },
  },
  {
    id: "tal",
    name: "Mikhail Tal",
    avatar: "🔥",
    tagline: "You must take your opponent into a deep dark forest.",
    bio: "The Magician from Riga. Will sacrifice a piece on principle, smile, and let you find out why over the next ten moves.",
    strength: 4,
    styleTag: "Sacrificial",
    chess: {
      multiPv: 6,
      evalWindowCp: 90,
      searchDepth: 12,
      blunderRate: 0.03,
      styleHints:
        "Strongly prefer sacrifices, piece activity, and attacks on the king over material. A dubious-but-terrifying move beats a safe one. Avoid trades that kill the attack.",
    },
    personaPrompt: `You are Mikhail Tal, the Magician from Riga. You are warm, poetic, and mischievous. You speak of the game as a story — forests, fires, invitations. You cheerfully admit your sacrifices may be unsound: "there are two kinds of sacrifices — correct ones, and mine." You compliment brave play, even your opponent's. ${USEFUL}`,
    banter: {
      chattiness: "medium",
      triggers: ["user-good-move", "capture", "check", "mate-threat"],
    },
  },
  {
    id: "fischer",
    name: "Bobby Fischer",
    avatar: "🦅",
    tagline: "I don't believe in psychology. I believe in good moves.",
    bio: "Ruthless precision and zero small talk. Demands respect for the game and gives none for your opening choice.",
    strength: 5,
    styleTag: "Precise",
    chess: {
      multiPv: 3,
      evalWindowCp: 30,
      searchDepth: 16,
      blunderRate: 0,
      styleHints:
        "Play the objectively best move. Punish inaccuracies immediately and directly. Prefer clarity over complications when both win.",
    },
    personaPrompt: `You are Bobby Fischer at the board: intense, terse, prickly, allergic to imprecision. You respect only good moves and say so. You occasionally mutter about how the opening should have been played. You are never cruel about the person, only about the moves. ${USEFUL}`,
    banter: { chattiness: "low", triggers: ["user-blunder", "user-good-move"] },
  },
  {
    id: "morphy",
    name: "Paul Morphy",
    avatar: "🎩",
    tagline: "Help your pieces so they can help you.",
    bio: "The house patron. Romantic-era elegance: develop, open lines, and punish greed with a mating attack delivered courteously.",
    strength: 4,
    styleTag: "Classical",
    chess: {
      multiPv: 5,
      evalWindowCp: 70,
      searchDepth: 12,
      blunderRate: 0.02,
      styleHints:
        "Prefer rapid development, open lines, and king safety. Prefer gambits and attacks over grabbing material. Punish pawn-grabbing with initiative.",
    },
    personaPrompt: `You are Paul Morphy, the pride and sorrow of chess, playing a friendly game in a New Orleans parlor. You are courteous, formal, and quietly brilliant. You address your opponent respectfully, praise principled development, and express gentle disappointment at material greed — right before punishing it. ${USEFUL}`,
    banter: { chattiness: "medium", triggers: ["user-mistake", "capture", "mate-threat"] },
  },
  {
    id: "clickbait-coach",
    name: "The Clickbait Coach",
    avatar: "🎥",
    tagline: "He sacrifices... THE ROOK!!",
    bio: "A chess YouTuber who narrates your game like it's a 10-million-view video, but sneaks actual lessons into the thumbnails.",
    strength: 4,
    styleTag: "Instructive",
    chess: {
      multiPv: 5,
      evalWindowCp: 80,
      searchDepth: 12,
      blunderRate: 0.05,
      styleHints:
        "Prefer moves with a nameable idea: forks, pins, discovered attacks, pawn breaks. A thematic move within the window beats a slightly better quiet one.",
    },
    personaPrompt: `You are The Clickbait Coach, a chess YouTuber narrating this game as content. Everything is a potential thumbnail ("WAIT. He did NOT just play that"). You use caps for drama, but you always name the actual motif — the fork, the pin, the weak square — so the viewer learns something. Wins are "insane", losses are "a lesson for the channel". ${USEFUL}`,
    banter: {
      chattiness: "high",
      triggers: ["user-blunder", "user-mistake", "user-good-move", "capture", "check", "mate-threat"],
    },
  },
  {
    id: "hustler",
    name: "The Washington Square Hustler",
    avatar: "🗽",
    tagline: "Five bucks a game, kid. Clock's ticking.",
    bio: "Thirty years of park chess. Traps, gambits, and relentless patter. Explains the trap right after you fall in it.",
    strength: 3,
    styleTag: "Trappy",
    chess: {
      multiPv: 8,
      evalWindowCp: 150,
      searchDepth: 8,
      blunderRate: 0.08,
      styleHints:
        "Prefer traps, gambits, and moves with a hidden threat, even when objectively second-best. Set problems, not positions. Speed over depth.",
    },
    personaPrompt: `You are a Washington Square Park chess hustler. Nonstop patter, street-smart, funny, never mean. You call the opponent "professor" or "kid", talk about the five bucks riding on this, and rush them ("clock's ticking"). When a trap lands you explain it with glee — that's the free lesson, worth more than the five bucks. ${USEFUL}`,
    banter: {
      chattiness: "high",
      triggers: ["user-blunder", "user-mistake", "capture", "check"],
    },
  },
  {
    id: "blitz-sisters",
    name: "The Blitz Sisters",
    avatar: "♛♛",
    tagline: "Queen sac! ...that one was intentional. Probably.",
    bio: "A two-sister tag team finishing each other's sentences. Famous for a 'gambit' that is just blundering the queen with confidence.",
    strength: 3,
    styleTag: "Chaotic",
    chess: {
      multiPv: 7,
      evalWindowCp: 130,
      searchDepth: 8,
      blunderRate: 0.1,
      styleHints:
        "Prefer active, fun, fast-looking moves. Occasionally play the flashy option over the sound one. Never grovel in defense — counterattack.",
    },
    personaPrompt: `You are The Blitz Sisters, two streamer sisters playing as a tag team and talking over each other. Format lines as a duet ("A: ... / B: ..."). You are upbeat, self-deprecating about the family tradition of accidentally sacrificing the queen, and quick to hype good moves — yours or the opponent's. ${USEFUL}`,
    banter: {
      chattiness: "high",
      triggers: ["user-blunder", "user-good-move", "capture", "check"],
    },
  },
];
```

- [ ] **Step 4: Implement the registry service**

```ts
import { Injectable, NotFoundException } from "@nestjs/common";
import type { Character } from "@chess/shared";
import { CHARACTERS, type CharacterConfig } from "./characters.data";

/** Static roster lookup. `list()` exposes only the public Character subset. */
@Injectable()
export class CharacterRegistry {
  list(): Character[] {
    return CHARACTERS.map(
      ({ id, name, avatar, tagline, bio, strength, styleTag }) => ({
        id, name, avatar, tagline, bio, strength, styleTag,
      }),
    );
  }

  get(id: string): CharacterConfig {
    const config = CHARACTERS.find((c) => c.id === id);
    if (!config) throw new NotFoundException(`Unknown character: ${id}`);
    return config;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter server test -- character-registry`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/play/
git commit -m "feat(play): character registry with 8 persona configs"
```

---

### Task 4: Candidate builder (pure)

**Files:**
- Create: `apps/server/src/play/move-candidates.ts`
- Test: `apps/server/src/play/move-candidates.spec.ts`

**Interfaces:**
- Consumes: `EngineEval`, `EngineLine`, `Color` from `@chess/shared`.
- Produces:

```ts
export interface Candidate {
  uci: string;
  san: string;
  scoreCp: number | null; // White-POV, null for mate lines and injected moves
  mate: number | null;
  offbeat: boolean; // true for the injected dubious move
}
export interface CandidateInput {
  engineEval: EngineEval;
  sideToMove: Color;
  evalWindowCp: number;
  blunderRate: number;
  legalSans: string[];
  uciToSan: (uci: string) => string | null;
  sanToUci: (san: string) => string | null;
  rng: () => number; // injectable for determinism
}
export function buildCandidates(input: CandidateInput): Candidate[];
```

Rules: convert each engine line's `pv[0]` to a candidate; keep lines whose side-to-move-POV score is within `evalWindowCp` of the best line (mate-for-us lines always kept; mate-against-us lines only if best); drop lines whose uci fails SAN conversion; with probability `blunderRate` append one random legal move not already a candidate, flagged `offbeat`. Always ≥1 candidate (the best line survives its own window).

- [ ] **Step 1: Write the failing tests**

```ts
import type { EngineEval } from "@chess/shared";
import { buildCandidates } from "./move-candidates";

const engineEval = (lines: Array<[string, number | null, number | null]>): EngineEval => ({
  fen: "irrelevant",
  bestMove: lines[0]?.[0] ?? null,
  depth: 12,
  lines: lines.map(([uci, scoreCp, mate], i) => ({
    pv: [uci],
    scoreCp,
    mate,
    rank: i + 1,
  })),
});

const base = {
  sideToMove: "w" as const,
  evalWindowCp: 50,
  blunderRate: 0,
  legalSans: ["e4", "d4", "Nf3", "a3"],
  uciToSan: (uci: string) =>
    ({ e2e4: "e4", d2d4: "d4", g1f3: "Nf3", a2a3: "a3" })[uci] ?? null,
  sanToUci: (san: string) =>
    ({ e4: "e2e4", d4: "d2d4", Nf3: "g1f3", a3: "a2a3" })[san] ?? null,
  rng: () => 0.99,
};

describe("buildCandidates", () => {
  it("keeps only lines within the eval window (side-to-move POV)", () => {
    const result = buildCandidates({
      ...base,
      engineEval: engineEval([
        ["e2e4", 40, null],
        ["d2d4", 10, null], // 30cp below best: kept
        ["g1f3", -30, null], // 70cp below best: dropped
      ]),
    });
    expect(result.map((c) => c.uci)).toEqual(["e2e4", "d2d4"]);
    expect(result[0]).toEqual({
      uci: "e2e4", san: "e4", scoreCp: 40, mate: null, offbeat: false,
    });
  });

  it("flips POV for black to move", () => {
    const result = buildCandidates({
      ...base,
      sideToMove: "b",
      engineEval: engineEval([
        ["e2e4", -40, null], // best for black
        ["d2d4", 30, null], // 70cp worse for black: dropped
      ]),
    });
    expect(result.map((c) => c.uci)).toEqual(["e2e4"]);
  });

  it("injects an offbeat legal move when rng() < blunderRate", () => {
    const result = buildCandidates({
      ...base,
      blunderRate: 0.1,
      rng: () => 0.05,
      engineEval: engineEval([["e2e4", 40, null]]),
    });
    const offbeat = result.filter((c) => c.offbeat);
    expect(offbeat).toHaveLength(1);
    expect(offbeat[0].uci).not.toBe("e2e4");
    expect(offbeat[0].scoreCp).toBeNull();
  });

  it("drops lines whose uci does not convert, never returning zero candidates", () => {
    const result = buildCandidates({
      ...base,
      engineEval: engineEval([
        ["e2e4", 40, null],
        ["zzzz", 39, null],
      ]),
    });
    expect(result.map((c) => c.uci)).toEqual(["e2e4"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter server test -- move-candidates`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { Color, EngineEval } from "@chess/shared";

// (Candidate + CandidateInput interfaces from the Interfaces block)

/** Side-to-move POV score; mate lines map to a huge +/- so they sort/window sanely. */
function povScore(scoreCp: number | null, mate: number | null, side: Color): number {
  if (mate !== null) return (mate > 0 ? 100_000 : -100_000) * (side === "w" ? 1 : -1) * Math.sign(mate) === 0 ? 0 : mate * (side === "w" ? 1 : -1) > 0 ? 100_000 : -100_000;
  const cp = scoreCp ?? 0;
  return side === "w" ? cp : -cp;
}

export function buildCandidates(input: CandidateInput): Candidate[] {
  const { engineEval, sideToMove, evalWindowCp, blunderRate, rng } = input;

  const converted = engineEval.lines
    .filter((l) => l.pv.length > 0)
    .map((l) => {
      const uci = l.pv[0];
      const san = input.uciToSan(uci);
      return san
        ? {
            uci,
            san,
            scoreCp: l.scoreCp,
            mate: l.mate,
            offbeat: false,
            pov: povScore(l.scoreCp, l.mate, sideToMove),
          }
        : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  if (converted.length === 0) return [];
  const best = Math.max(...converted.map((c) => c.pov));
  const candidates = converted
    .filter((c) => best - c.pov <= evalWindowCp || c.pov === best)
    .map(({ pov: _pov, ...c }) => c);

  if (rng() < blunderRate) {
    const taken = new Set(candidates.map((c) => c.san));
    const pool = input.legalSans.filter((san) => !taken.has(san));
    if (pool.length > 0) {
      const san = pool[Math.floor(rng() * pool.length) % pool.length];
      const uci = input.sanToUci(san);
      if (uci) {
        candidates.push({ uci, san, scoreCp: null, mate: null, offbeat: true });
      }
    }
  }
  return candidates;
}
```

Note: simplify `povScore` while implementing — the intent is: mate>0 is +100000 for the mating side from White's POV, then flip for black; keep it readable and make the tests pass. A clean version:

```ts
function povScore(scoreCp: number | null, mate: number | null, side: Color): number {
  const whitePov = mate !== null ? Math.sign(mate) * 100_000 : (scoreCp ?? 0);
  return side === "w" ? whitePov : -whitePov;
}
```

Use the clean version.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter server test -- move-candidates`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/play/move-candidates.*
git commit -m "feat(play): pure candidate builder with eval window and offbeat injection"
```

---

### Task 5: Banter moment detection (pure)

**Files:**
- Create: `apps/server/src/play/banter.ts`
- Test: `apps/server/src/play/banter.spec.ts`

**Interfaces:**
- Consumes: `BanterTriggerKind` from `./characters.data`, `Color` from `@chess/shared`.
- Produces:

```ts
export interface MomentInput {
  /** White-POV best score of the position BEFORE the user's move (previous AI-turn analysis), null on first detection. */
  prevBestCp: number | null;
  /** White-POV best score AFTER the user's move (this AI-turn's analysis). */
  currBestCp: number | null;
  /** Mate found for the AI in the current analysis. */
  aiHasMate: boolean;
  userSide: Color;
  userSan: string; // flags: 'x' capture, '+' check, '#' mate
}
export function detectMoment(input: MomentInput): BanterTriggerKind | null;
export function cooldownPlies(chattiness: "low" | "medium" | "high"): number; // 8 / 4 / 2
```

Detection (first match wins): user's POV drop `= pov(prev) - pov(curr)`; drop ≥ 300 → `user-blunder`; ≥ 100 → `user-mistake`; ≤ -50 → `user-good-move`; `aiHasMate` → `mate-threat`; SAN contains `+` → `check`; SAN contains `x` → `capture`; else null. Null scores → skip the drop rules.

- [ ] **Step 1: Write the failing tests**

```ts
import { cooldownPlies, detectMoment } from "./banter";

const base = {
  prevBestCp: 0,
  currBestCp: 0,
  aiHasMate: false,
  userSide: "w" as const,
  userSan: "Nf3",
};

describe("detectMoment", () => {
  it("detects a user blunder from a 300cp POV drop", () => {
    expect(detectMoment({ ...base, prevBestCp: 50, currBestCp: -260 })).toBe(
      "user-blunder",
    );
  });

  it("flips POV for a black user", () => {
    // Black user: white-POV going UP means black lost ground.
    expect(
      detectMoment({ ...base, userSide: "b", prevBestCp: 0, currBestCp: 320 }),
    ).toBe("user-blunder");
  });

  it("detects a mistake and a good move", () => {
    expect(detectMoment({ ...base, prevBestCp: 0, currBestCp: -120 })).toBe(
      "user-mistake",
    );
    expect(detectMoment({ ...base, prevBestCp: 0, currBestCp: 80 })).toBe(
      "user-good-move",
    );
  });

  it("prioritizes eval swings over SAN flags, then mate over check over capture", () => {
    expect(
      detectMoment({ ...base, prevBestCp: 0, currBestCp: -320, userSan: "Qxf7+" }),
    ).toBe("user-blunder");
    expect(detectMoment({ ...base, aiHasMate: true, userSan: "Qxf7+" })).toBe(
      "mate-threat",
    );
    expect(detectMoment({ ...base, userSan: "Qxf7+" })).toBe("check");
    expect(detectMoment({ ...base, userSan: "Qxf7" })).toBe("capture");
  });

  it("returns null for a routine move and skips drop rules on null evals", () => {
    expect(detectMoment(base)).toBeNull();
    expect(detectMoment({ ...base, prevBestCp: null, currBestCp: -400 })).toBeNull();
  });
});

describe("cooldownPlies", () => {
  it("maps chattiness to plies", () => {
    expect(cooldownPlies("low")).toBe(8);
    expect(cooldownPlies("medium")).toBe(4);
    expect(cooldownPlies("high")).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter server test -- banter`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { Color } from "@chess/shared";
import type { BanterTriggerKind } from "./characters.data";

// (MomentInput from the Interfaces block)

export function detectMoment(input: MomentInput): BanterTriggerKind | null {
  const { prevBestCp, currBestCp, userSide, userSan, aiHasMate } = input;
  if (prevBestCp !== null && currBestCp !== null) {
    const pov = (cp: number) => (userSide === "w" ? cp : -cp);
    const drop = pov(prevBestCp) - pov(currBestCp);
    if (drop >= 300) return "user-blunder";
    if (drop >= 100) return "user-mistake";
    if (drop <= -50) return "user-good-move";
  }
  if (aiHasMate) return "mate-threat";
  if (userSan.includes("+") || userSan.includes("#")) return "check";
  if (userSan.includes("x")) return "capture";
  return null;
}

export function cooldownPlies(chattiness: "low" | "medium" | "high"): number {
  return { low: 8, medium: 4, high: 2 }[chattiness];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter server test -- banter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/play/banter.*
git commit -m "feat(play): pure banter-moment detection with chattiness cooldowns"
```

---

### Task 6: PlayService — sessions, user moves, resign/draw, game end

**Files:**
- Create: `apps/server/src/play/play.service.ts`
- Test: `apps/server/src/play/play.service.spec.ts`

**Interfaces:**
- Consumes: `ChessService` (`applySan`, `uciToSan`, `legalMoves`, `gameStatus`), `EngineService.analyze(fen, {depth, multipv})`, `CharacterRegistry.get/list`, `AGENT_HARNESS: AgentHarness` (`createSession({systemPrompt, tools, emit, model})` → `AgentRunner` with `prompt(text)`, `dispose?()`), pure helpers from Tasks 4–5.
- Produces (controller relies on these exact signatures):

```ts
@Injectable() export class PlayService {
  createGame(req: CreatePlayGameRequest): Promise<PlayGame>;
  getGame(id: string): PlayGame;                       // throws NotFoundException
  getStream(id: string): Observable<MessageEvent>;     // SSE mapping like AgentService.getStream
  userMove(id: string, move: string): Promise<PlayGame>; // throws BadRequest on illegal/out-of-turn
  resign(id: string): Promise<PlayGame>;
  offerDraw(id: string): Promise<void>;                // result via SSE draw_response
  chat(id: string, text: string): Promise<void>;       // reply streams via SSE
}
```

This task implements everything EXCEPT the real AI-turn pipeline and talker turns: `aiTurn` and `talk` land in Tasks 7–8. Here they exist as private methods with minimal bodies (`aiTurn`: analyze + play engine best; `talk`: no-op) so the service is testable end-to-end immediately — Task 7/8 replace the bodies, not the seams.

Internal session shape (private):

```ts
interface PlaySession {
  game: PlayGame;
  character: CharacterConfig;
  subject: Subject<PlayEvent>;
  mover: AgentRunner | null;   // created lazily in Task 7
  talker: AgentRunner | null;  // created lazily in Task 8
  moverOut: { text: string };  // mover emit sink
  talkQueue: Promise<void>;    // serializes talker turns
  lastBanterPly: number;
  lastEval: EngineEval | null; // analysis of the position after the user's PREVIOUS move
  thinking: boolean;           // AI turn in flight
  rng: () => number;
}
```

Key mechanics:
- `createGame`: resolve `side` (`random` → `rng() < 0.5 ? "white" : "black"`), standard `startFen` (copy the constant from `apps/web/src/store.ts:26` — the standard initial FEN), `id` via `uuidv4()` (already a server dep), status `active`. Store session in a `Map`. If the user chose black, fire `void this.aiTurn(session)`.
- `userMove`: reject when `status !== "active"`, when `thinking`, or when it isn't the user's turn (`fen.split(" ")[1]` vs `side[0]`). If `move` matches `/^[a-h][1-8][a-h][1-8][qrbn]?$/`, convert via `chess.uciToSan(fen, move)` (BadRequest if null). `chess.applySan(fen, san)` → append a full `Move` (`ply: moves.length + 1`, `moveNumber: Math.ceil(ply / 2)`, rest from `ApplySanResult.move`), update `fen`. Then `gameStatus(fen)`: if over → `endGame`, else `void this.aiTurn(session)`. Return the updated `PlayGame`.
- `resign`: result is the character's win (`side === "white" ? "0-1" : "1-0"`), reason `resignation`.
- `offerDraw`: character-POV cp from `lastEval` best line (White-POV flipped if the character is black; if `lastEval` is null, analyze at depth 8 first). Accept iff cp ≤ 50: emit `draw_response {accepted}` and, when accepted, `endGame("1/2-1/2", "agreement")`.
- `endGame`: set status/result/endReason, emit `game_over`, then `void this.talk(session, partingShotPrompt)` (no-op until Task 8).
- `getStream`: exactly the `AgentService.getStream` Subject→`MessageEvent` mapping (`map((e) => ({ data: JSON.stringify(e) }))`), but sessions are created by `createGame` (a stream for an unknown id throws NotFoundException).

- [ ] **Step 1: Write the failing tests**

Mock pattern (reuse the style of `agent.service.spec.ts`): fake harness returning stub runners; fake engine returning canned `EngineEval`s; real `ChessService`; real `CharacterRegistry`.

```ts
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { firstValueFrom } from "rxjs";
import { filter, map, take, toArray } from "rxjs/operators";
import type { EngineEval, PlayEvent } from "@chess/shared";
import { ChessService } from "../chess/chess.service";
import { CharacterRegistry } from "./character-registry.service";
import { PlayService } from "./play.service";

const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const stubEval = (fen: string, bestUci: string): EngineEval => ({
  fen,
  bestMove: bestUci,
  depth: 8,
  lines: [{ pv: [bestUci], scoreCp: 20, mate: null, rank: 1 }],
});

function makeService(overrides?: {
  analyze?: (fen: string) => Promise<EngineEval>;
}) {
  const chess = new ChessService();
  const engine = {
    analyze: jest.fn(async (fen: string) => {
      if (overrides?.analyze) return overrides.analyze(fen);
      // Reply to any position with its first legal move.
      const san = chess.legalMoves(fen)[0];
      const uci = chess.applySan(fen, san).move.uci;
      return stubEval(fen, uci);
    }),
  };
  const harness = {
    listModels: jest.fn(async () => []),
    listSessions: jest.fn(async () => []),
    getSessionMessages: jest.fn(async () => []),
    createSession: jest.fn(async () => ({
      id: "stub",
      prompt: jest.fn(async () => undefined),
      dispose: jest.fn(),
    })),
    resumeSession: jest.fn(),
  };
  const service = new PlayService(
    chess,
    engine as never,
    new CharacterRegistry(),
    harness as never,
  );
  return { service, engine, harness, chess };
}

/** Collect the next `n` PlayEvents from a game's stream. */
function nextEvents(service: PlayService, id: string, n: number) {
  return firstValueFrom(
    service.getStream(id).pipe(
      map((m) => JSON.parse(m.data as string) as PlayEvent),
      take(n),
      toArray(),
    ),
  );
}

describe("PlayService", () => {
  it("creates a game with the chosen side and character", async () => {
    const { service } = makeService();
    const game = await service.createGame({ characterId: "hustler", side: "white" });
    expect(game.characterId).toBe("hustler");
    expect(game.side).toBe("white");
    expect(game.fen).toBe(START_FEN);
    expect(game.status).toBe("active");
    expect(service.getGame(game.id)).toEqual(game);
  });

  it("rejects unknown character and unknown game ids", async () => {
    const { service } = makeService();
    await expect(
      service.createGame({ characterId: "nope", side: "white" }),
    ).rejects.toThrow(NotFoundException);
    expect(() => service.getGame("missing")).toThrow(NotFoundException);
  });

  it("applies a legal user move and streams the AI reply", async () => {
    const { service } = makeService();
    const game = await service.createGame({ characterId: "hustler", side: "white" });
    const eventsP = nextEvents(service, game.id, 1);

    const updated = await service.userMove(game.id, "e4");
    expect(updated.moves).toHaveLength(1);
    expect(updated.moves[0].san).toBe("e4");

    const [aiMove] = await eventsP;
    expect(aiMove.type).toBe("ai_move");
    const after = service.getGame(game.id);
    expect(after.moves).toHaveLength(2);
    expect(after.moves[1].color).toBe("b");
  });

  it("accepts UCI input", async () => {
    const { service } = makeService();
    const game = await service.createGame({ characterId: "hustler", side: "white" });
    const updated = await service.userMove(game.id, "e2e4");
    expect(updated.moves[0].san).toBe("e4");
  });

  it("rejects illegal moves and out-of-turn moves", async () => {
    const { service } = makeService();
    const game = await service.createGame({ characterId: "hustler", side: "black" });
    // AI (white) moves first; user is black but it may still be white's turn.
    await expect(service.userMove(game.id, "Ke2")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("makes the first move when the user plays black", async () => {
    const { service } = makeService();
    const game = await service.createGame({ characterId: "hustler", side: "black" });
    const [aiMove] = await nextEvents(service, game.id, 1);
    expect(aiMove.type).toBe("ai_move");
    expect(service.getGame(game.id).moves[0].color).toBe("w");
  });

  it("ends the game on checkmate delivered by the user", async () => {
    // Force the AI into fool's mate: it plays f3 then g4.
    const replies = ["f2f3", "g2g4"];
    const { service } = makeService({
      analyze: async (fen) => stubEval(fen, replies.shift()!),
    });
    const game = await service.createGame({ characterId: "hustler", side: "black" });
    await nextEvents(service, game.id, 1); // f3
    const eventsP = nextEvents(service, game.id, 2); // g4 then game_over
    await service.userMove(game.id, "e5");
    await eventsP;
    const overP = nextEvents(service, game.id, 1);
    await service.userMove(game.id, "Qh4");
    const [over] = await overP;
    expect(over).toMatchObject({ type: "game_over", result: "0-1", reason: "checkmate" });
    expect(service.getGame(game.id).status).toBe("over");
  });

  it("handles resignation", async () => {
    const { service } = makeService();
    const game = await service.createGame({ characterId: "hustler", side: "white" });
    const resigned = await service.resign(game.id);
    expect(resigned).toMatchObject({
      status: "over", result: "0-1", endReason: "resignation",
    });
  });

  it("answers a draw offer via the stream (declines when clearly better)", async () => {
    const { service } = makeService({
      analyze: async (fen) => ({
        ...stubEval(fen, "e2e4"),
        lines: [{ pv: ["e2e4"], scoreCp: 400, mate: null, rank: 1 }],
      }),
    });
    const game = await service.createGame({ characterId: "hustler", side: "black" });
    await nextEvents(service, game.id, 1); // let the AI's first turn set lastEval (+400 = winning for white AI)
    const eventsP = nextEvents(service, game.id, 1);
    await service.offerDraw(game.id);
    const [resp] = await eventsP;
    expect(resp).toEqual({ type: "draw_response", accepted: false });
    expect(service.getGame(game.id).status).toBe("active");
  });
});
```

Note on the stream helper: `getStream` returns a hot Subject-backed Observable — always attach (`nextEvents(...)`) BEFORE triggering the action, as the tests above do.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter server test -- play.service`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `PlayService`**

Skeleton (complete except `aiTurn`/`talk`, which Task 7/8 finish — the Task 6 `aiTurn` body already plays the engine best so the tests above pass):

```ts
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { MessageEvent } from "@nestjs/common";
import { Observable, Subject } from "rxjs";
import { map } from "rxjs/operators";
import { v4 as uuidv4 } from "uuid";
import type {
  CreatePlayGameRequest,
  EngineEval,
  Move,
  PlayEndReason,
  PlayEvent,
  PlayGame,
  PlayResult,
} from "@chess/shared";
import { ChessService } from "../chess/chess.service";
import { EngineService } from "../engine/engine.service";
import {
  AGENT_HARNESS,
  type AgentHarness,
  type AgentRunner,
} from "../agent/harness/agent-harness";
import { CharacterRegistry } from "./character-registry.service";
import type { CharacterConfig } from "./characters.data";
import { buildCandidates } from "./move-candidates";
import { cooldownPlies, detectMoment } from "./banter";

const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const PLAY_MODEL = "openrouter/free";
/** Character accepts a draw when its POV advantage is at most this. */
const DRAW_ACCEPT_MAX_CP = 50;

interface PlaySession { /* shape from the Interfaces block */ }

@Injectable()
export class PlayService {
  private readonly logger = new Logger(PlayService.name);
  private readonly sessions = new Map<string, PlaySession>();

  constructor(
    private readonly chess: ChessService,
    private readonly engine: EngineService,
    private readonly registry: CharacterRegistry,
    @Inject(AGENT_HARNESS) private readonly harness: AgentHarness,
  ) {}

  async createGame(req: CreatePlayGameRequest): Promise<PlayGame> {
    const character = this.registry.get(req.characterId); // throws on unknown
    const rng = Math.random;
    const side =
      req.side === "random" ? (rng() < 0.5 ? "white" : "black") : req.side;
    const game: PlayGame = {
      id: uuidv4(),
      characterId: character.id,
      side,
      startFen: START_FEN,
      fen: START_FEN,
      moves: [],
      status: "active",
    };
    const session: PlaySession = {
      game, character,
      subject: new Subject<PlayEvent>(),
      mover: null, talker: null,
      moverOut: { text: "" },
      talkQueue: Promise.resolve(),
      lastBanterPly: -99,
      lastEval: null,
      thinking: false,
      rng,
    };
    this.sessions.set(game.id, session);
    if (side === "black") void this.aiTurn(session);
    return game;
  }

  getGame(id: string): PlayGame {
    return this.session(id).game;
  }

  getStream(id: string): Observable<MessageEvent> {
    return this.session(id)
      .subject.asObservable()
      .pipe(map((event): MessageEvent => ({ data: JSON.stringify(event) })));
  }

  async userMove(id: string, moveStr: string): Promise<PlayGame> {
    const session = this.session(id);
    const { game } = session;
    if (game.status !== "active")
      throw new BadRequestException("Game is over.");
    if (session.thinking)
      throw new BadRequestException("Waiting for the opponent's move.");
    const turn = game.fen.split(" ")[1]; // 'w' | 'b'
    if (turn !== game.side[0])
      throw new BadRequestException("Not your turn.");

    let san = moveStr;
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(moveStr)) {
      const converted = this.chess.uciToSan(game.fen, moveStr);
      if (!converted)
        throw new BadRequestException(`Illegal move "${moveStr}".`);
      san = converted;
    }
    const userSan = this.applyMove(session, san); // throws BadRequest on illegal
    const status = this.chess.gameStatus(game.fen);
    if (status.over) {
      this.endGame(session, status.result, status.reason);
    } else {
      void this.aiTurn(session, userSan);
    }
    return game;
  }

  async resign(id: string): Promise<PlayGame> {
    const session = this.session(id);
    if (session.game.status !== "active")
      throw new BadRequestException("Game is over.");
    this.endGame(
      session,
      session.game.side === "white" ? "0-1" : "1-0",
      "resignation",
    );
    return session.game;
  }

  async offerDraw(id: string): Promise<void> {
    const session = this.session(id);
    if (session.game.status !== "active")
      throw new BadRequestException("Game is over.");
    const evalNow =
      session.lastEval ??
      (await this.engine.analyze(session.game.fen, { depth: 8 }));
    const best = evalNow.lines[0];
    const whiteCp =
      best?.mate != null ? Math.sign(best.mate) * 100_000 : (best?.scoreCp ?? 0);
    const characterPov =
      session.game.side === "white" ? -whiteCp : whiteCp;
    const accepted = characterPov <= DRAW_ACCEPT_MAX_CP;
    session.subject.next({ type: "draw_response", accepted });
    if (accepted) this.endGame(session, "1/2-1/2", "agreement");
  }

  async chat(id: string, text: string): Promise<void> {
    const session = this.session(id);
    await this.talk(session, this.chatPrompt(session, text));
  }

  // ── internals ──────────────────────────────────────────────────────────

  private session(id: string): PlaySession {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException(`Unknown play game: ${id}`);
    return session;
  }

  /** Apply a SAN move to the session's game, appending a full Move. Returns the SAN. */
  private applyMove(session: PlaySession, san: string): string {
    const { game } = session;
    const applied = this.chess.applySan(game.fen, san); // BadRequest on illegal
    const ply = game.moves.length + 1;
    const move: Move = {
      ply,
      moveNumber: Math.ceil(ply / 2),
      ...applied.move,
    };
    game.moves.push(move);
    game.fen = applied.fen;
    return applied.move.san;
  }

  /**
   * The AI's turn. Task 6 version: engine best move only (no LLM). Task 7
   * replaces the selection with the mover session; Task 8 adds banter.
   */
  private async aiTurn(session: PlaySession, userSan?: string): Promise<void> {
    session.thinking = true;
    try {
      const { game, character } = session;
      const engineEval = await this.engine.analyze(game.fen, {
        depth: character.chess.searchDepth,
        multipv: character.chess.multiPv,
      });
      session.lastEval = engineEval;

      const bestUci = engineEval.bestMove ?? engineEval.lines[0]?.pv[0];
      const san = bestUci ? this.chess.uciToSan(game.fen, bestUci) : null;
      if (!san) throw new Error(`Engine returned no playable move for ${game.fen}`);
      this.applyMove(session, san);
      const move = game.moves[game.moves.length - 1];
      session.subject.next({ type: "ai_move", move, fen: game.fen });

      const status = this.chess.gameStatus(game.fen);
      if (status.over) this.endGame(session, status.result, status.reason);
    } catch (err) {
      this.logger.error(`aiTurn failed: ${String(err)}`);
      session.subject.next({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      session.thinking = false;
    }
  }

  private endGame(
    session: PlaySession,
    result: PlayResult,
    reason: PlayEndReason,
  ): void {
    session.game.status = "over";
    session.game.result = result;
    session.game.endReason = reason;
    session.subject.next({ type: "game_over", result, reason });
    void this.talk(session, this.partingShotPrompt(session));
  }

  /** Serialized talker turn. Task 6 version: no-op (Task 8 implements). */
  private talk(_session: PlaySession, _prompt: string): Promise<void> {
    return Promise.resolve();
  }

  private chatPrompt(session: PlaySession, text: string): string {
    return text; // enriched in Task 8
  }

  private partingShotPrompt(session: PlaySession): string {
    return ""; // implemented in Task 8
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter server test -- play.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/play/play.service.*
git commit -m "feat(play): PlayService game lifecycle with engine-best AI turns"
```

---

### Task 7: PlayService — LLM move selection (the mover)

**Files:**
- Modify: `apps/server/src/play/play.service.ts` (replace `aiTurn` selection, add mover helpers)
- Test: `apps/server/src/play/play.service.spec.ts` (append describe block)

**Interfaces:**
- Consumes: `buildCandidates` (Task 4), `AgentHarness.createSession` — the mover's `emit` closure appends `text_delta` deltas into `session.moverOut.text`; tools: `[]`.
- Produces: private behavior only; the `ai_move`/`banter` events on the stream are the contract.

Mover mechanics:
- Lazy-create `session.mover` on first AI turn: `harness.createSession({ systemPrompt: moverSystemPrompt(character), tools: [], model: PLAY_MODEL, emit })` where `emit` does `if (e.type === "text_delta") session.moverOut.text += e.delta`.
- `moverSystemPrompt(character)` = `character.personaPrompt` + `\n\nStyle: ${character.chess.styleHints}` + a JSON discipline paragraph:
  `"You are PLAYING a game. Each prompt gives the position and candidate moves. Reply with ONLY a JSON object {\"move\":\"<uci from the candidate list>\",\"comment\":\"<optional one-line in-character remark>\"} — no other text, no code fences. Omit \"comment\" for routine moves."`
- Per turn: reset `moverOut.text = ""`, build the turn prompt (FEN, "You are playing White/Black", last 6 moves as SAN with numbers — reuse the shape of `AgentService.recentMoves`, candidate lines formatted `"- e2e4 (e4), eval +0.42"` / offbeat ones as `"- a2a3 (a3), eval unknown — offbeat, your call"`), `await mover.prompt(prompt)`, then parse.
- Parse: `const m = session.moverOut.text.match(/\{[\s\S]*\}/)`; `JSON.parse(m[0])`; validate `parsed.move` is one of the candidates' `uci`. ANY failure (throw from `prompt`, no match, bad JSON, uci not in candidates) → fall back to engine best, no comment, log at debug. A `comment` string, when present and non-empty, is emitted as `{ type: "banter", text: comment }` AFTER the `ai_move` event.

- [ ] **Step 1: Write the failing tests** (append to `play.service.spec.ts`)

```ts
describe("PlayService mover", () => {
  function moverHarness(reply: string) {
    let emit: ((e: { type: string; delta?: string }) => void) | null = null;
    const prompts: string[] = [];
    return {
      prompts,
      harness: {
        listModels: jest.fn(async () => []),
        listSessions: jest.fn(async () => []),
        getSessionMessages: jest.fn(async () => []),
        createSession: jest.fn(async (cfg: { emit: typeof emit }) => {
          emit = cfg.emit;
          return {
            id: "mover",
            prompt: jest.fn(async (text: string) => {
              prompts.push(text);
              emit!({ type: "text_delta", delta: reply });
            }),
            dispose: jest.fn(),
          };
        }),
        resumeSession: jest.fn(),
      },
    };
  }

  function makeMoverService(reply: string) {
    const chess = new ChessService();
    // Two candidate lines so the LLM has a real choice: best d2d4, second g1f3.
    const engine = {
      analyze: jest.fn(async (fen: string) => ({
        fen,
        bestMove: "d2d4",
        depth: 8,
        lines: [
          { pv: ["d2d4"], scoreCp: 30, mate: null, rank: 1 },
          { pv: ["g1f3"], scoreCp: 20, mate: null, rank: 2 },
        ],
      })),
    };
    const { harness, prompts } = moverHarness(reply);
    const service = new PlayService(
      chess, engine as never, new CharacterRegistry(), harness as never,
    );
    return { service, prompts };
  }

  it("plays the LLM's candidate pick and emits its comment as banter", async () => {
    const { service, prompts } = makeMoverService(
      '{"move":"g1f3","comment":"Knights before bishops, professor."}',
    );
    const game = await service.createGame({ characterId: "hustler", side: "black" });
    const [aiMove, banter] = await nextEvents(service, game.id, 2);
    expect(aiMove).toMatchObject({ type: "ai_move" });
    expect((aiMove as { move: { san: string } }).move.san).toBe("Nf3");
    expect(banter).toEqual({
      type: "banter",
      text: "Knights before bishops, professor.",
    });
    // The turn prompt offered both candidates.
    expect(prompts[0]).toContain("d2d4");
    expect(prompts[0]).toContain("g1f3");
  });

  it("falls back to engine best on garbage output", async () => {
    const { service } = makeMoverService("chess is life, no JSON for you");
    const game = await service.createGame({ characterId: "hustler", side: "black" });
    const [aiMove] = await nextEvents(service, game.id, 1);
    expect((aiMove as { move: { san: string } }).move.san).toBe("d4");
  });

  it("falls back to engine best when the pick is not a candidate", async () => {
    const { service } = makeMoverService('{"move":"a2a4"}');
    const game = await service.createGame({ characterId: "hustler", side: "black" });
    const [aiMove] = await nextEvents(service, game.id, 1);
    expect((aiMove as { move: { san: string } }).move.san).toBe("d4");
  });
});
```

Also update the Task 6 harness stub's `createSession` if needed so its stub runner emits nothing (existing tests keep passing: no `moverOut` text → parse fails → engine best → identical behavior to Task 6).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm --filter server test -- play.service`
Expected: the first new test FAILS (`Nf3` vs `d4`, no banter event); Task 6 tests still pass.

- [ ] **Step 3: Implement**

Replace the selection block inside `aiTurn` (after `session.lastEval = engineEval;`):

```ts
      const candidates = buildCandidates({
        engineEval,
        sideToMove: game.fen.split(" ")[1] as "w" | "b",
        evalWindowCp: character.chess.evalWindowCp,
        blunderRate: character.chess.blunderRate,
        legalSans: this.chess.legalMoves(game.fen),
        uciToSan: (uci) => this.chess.uciToSan(game.fen, uci),
        sanToUci: (san) => {
          try {
            return this.chess.applySan(game.fen, san).move.uci;
          } catch {
            return null;
          }
        },
        rng: session.rng,
      });

      const pick = await this.pickMove(session, candidates);
      const chosen =
        candidates.find((c) => c.uci === pick?.move) ??
        candidates.find((c) => !c.offbeat) ??
        candidates[0];
      if (!chosen) throw new Error(`No playable move for ${game.fen}`);

      this.applyMove(session, chosen.san);
      const move = game.moves[game.moves.length - 1];
      session.subject.next({ type: "ai_move", move, fen: game.fen });
      if (pick?.move === chosen.uci && pick.comment?.trim()) {
        session.subject.next({ type: "banter", text: pick.comment.trim() });
      }
```

New private helpers:

```ts
  /** One structured mover turn. Returns null on any failure (caller falls back). */
  private async pickMove(
    session: PlaySession,
    candidates: Candidate[],
  ): Promise<{ move: string; comment?: string } | null> {
    try {
      if (!session.mover) {
        session.mover = await this.harness.createSession({
          systemPrompt: this.moverSystemPrompt(session.character),
          tools: [],
          model: PLAY_MODEL,
          emit: (e) => {
            if (e.type === "text_delta") session.moverOut.text += e.delta;
          },
        });
      }
      session.moverOut.text = "";
      await session.mover.prompt(this.moverTurnPrompt(session, candidates));
      const match = session.moverOut.text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as { move?: unknown; comment?: unknown };
      if (typeof parsed.move !== "string") return null;
      if (!candidates.some((c) => c.uci === parsed.move)) return null;
      return {
        move: parsed.move,
        comment: typeof parsed.comment === "string" ? parsed.comment : undefined,
      };
    } catch (err) {
      this.logger.debug(`mover failed, using engine best: ${String(err)}`);
      return null;
    }
  }

  private moverSystemPrompt(character: CharacterConfig): string {
    return (
      `${character.personaPrompt}\n\nStyle: ${character.chess.styleHints}\n\n` +
      `You are PLAYING a game. Each prompt gives the position and candidate moves. ` +
      `Reply with ONLY a JSON object {"move":"<uci from the candidate list>",` +
      `"comment":"<optional one-line in-character remark>"} — no other text, no ` +
      `code fences. Omit "comment" for routine moves.`
    );
  }

  private moverTurnPrompt(session: PlaySession, candidates: Candidate[]): string {
    const { game } = session;
    const aiColor = game.side === "white" ? "Black" : "White";
    const lines = candidates.map((c) =>
      c.offbeat
        ? `- ${c.uci} (${c.san}), eval unknown — offbeat, your call`
        : `- ${c.uci} (${c.san}), eval ${this.formatEval(c)}`,
    );
    return [
      `Position (FEN): ${game.fen}`,
      `You are playing ${aiColor}.`,
      `Recent moves: ${this.recentSans(game) || "(game start)"}`,
      `Candidate moves:`,
      ...lines,
      `Pick ONE move from the candidates that best fits your style.`,
    ].join("\n");
  }

  private formatEval(c: Candidate): string {
    if (c.mate !== null) return `mate in ${Math.abs(c.mate)}`;
    const cp = (c.scoreCp ?? 0) / 100;
    return `${cp >= 0 ? "+" : ""}${cp.toFixed(2)}`;
  }

  private recentSans(game: PlayGame): string {
    return game.moves
      .slice(-6)
      .map((m) =>
        m.color === "w" ? `${m.moveNumber}.${m.san}` : `${m.moveNumber}...${m.san}`,
      )
      .join(" ");
  }
```

Import `type Candidate` from `./move-candidates`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter server test -- play.service`
Expected: PASS (Task 6 + Task 7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/play/play.service.*
git commit -m "feat(play): in-character LLM move selection with engine-best fallback"
```

---

### Task 8: PlayService — the talker (banter, chat, parting shot)

**Files:**
- Modify: `apps/server/src/play/play.service.ts`
- Test: `apps/server/src/play/play.service.spec.ts` (append describe block)

**Interfaces:**
- Consumes: `detectMoment`, `cooldownPlies` (Task 5); `AgentHarness.createSession` — talker `emit` forwards `text_delta` → `{type:"chat_delta"}` on the subject.
- Produces: stream behavior — `chat_delta*` + `chat_done` per talker turn.

Mechanics:
- `talk(session, prompt)`: skip when `prompt` is empty. Lazy-create `session.talker` (`systemPrompt: talkerSystemPrompt(character)`, `tools: []`, `model: PLAY_MODEL`, `emit: (e) => { if (e.type === "text_delta") session.subject.next({ type: "chat_delta", delta: e.delta }); }`). Chain onto `session.talkQueue` so turns serialize; each turn: `await talker.prompt(prompt)` then `subject.next({ type: "chat_done" })`; on error emit `{ type: "error", message }` instead of throwing (moves must never be blocked by chat failures).
- `talkerSystemPrompt(character)`: `character.personaPrompt` + `"\n\nYou are playing a live game against the user and talking across the board. You will receive game events and user messages with position context. Respond in character, 1-3 short sentences. Never reveal the engine's evaluation or suggest moves for the user's current position."`
- Triggered banter, inside `aiTurn` right after `session.lastEval = engineEval` and before candidate building — using the PREVIOUS `lastEval` (hold it in a local before overwriting):

```ts
      const prevEval = session.lastEval; // BEFORE overwrite
      session.lastEval = engineEval;
      if (userSan) {
        const moment = detectMoment({
          prevBestCp: prevEval?.lines[0]?.scoreCp ?? null,
          currBestCp: engineEval.lines[0]?.scoreCp ?? null,
          aiHasMate: this.aiHasMate(engineEval, game),
          userSide: game.side === "white" ? "w" : "b",
          userSan,
        });
        const sincePly = game.moves.length - session.lastBanterPly;
        if (
          moment &&
          character.banter.triggers.includes(moment) &&
          sincePly >= cooldownPlies(character.banter.chattiness)
        ) {
          session.lastBanterPly = game.moves.length;
          void this.talk(session, this.momentPrompt(session, moment, userSan));
        }
      }
```

- `aiHasMate(engineEval, game)`: best line has `mate !== null` and it favors the AI (`mate > 0` means side-to-move mates; side to move here is the AI).
- `momentPrompt`: `"Game event: the user just played ${userSan}. Assessment: ${moment}. Position (FEN): ${fen}. Recent moves: ${...}. React in character in one or two short sentences."`
- `chatPrompt(session, text)` (replace stub): position context (FEN, recent moves, whose turn) + `"The user says: ${text}"`.
- `partingShotPrompt(session)` (replace stub): `"The game just ended: ${result} by ${reason} — ${youWon|youLost|draw from the character's perspective}. Final position (FEN): ${fen}. Give your in-character parting line (1-2 sentences)."` Compute won/lost from `result` vs the character's color.

- [ ] **Step 1: Write the failing tests** (append)

```ts
describe("PlayService talker", () => {
  function talkerSetup() {
    const chess = new ChessService();
    const engine = {
      analyze: jest.fn(async (fen: string) => {
        const san = chess.legalMoves(fen)[0];
        const uci = chess.applySan(fen, san).move.uci;
        return {
          fen, bestMove: uci, depth: 8,
          lines: [{ pv: [uci], scoreCp: 20, mate: null, rank: 1 }],
        };
      }),
    };
    const created: Array<{ systemPrompt: string; prompts: string[] }> = [];
    const harness = {
      listModels: jest.fn(async () => []),
      listSessions: jest.fn(async () => []),
      getSessionMessages: jest.fn(async () => []),
      createSession: jest.fn(
        async (cfg: { systemPrompt: string; emit: (e: never) => void }) => {
          const record = { systemPrompt: cfg.systemPrompt, prompts: [] as string[] };
          created.push(record);
          return {
            id: `s${created.length}`,
            prompt: jest.fn(async (text: string) => {
              record.prompts.push(text);
              (cfg.emit as (e: { type: string; delta: string }) => void)({
                type: "text_delta",
                delta: "Ha! ",
              });
            }),
            dispose: jest.fn(),
          };
        },
      ),
      resumeSession: jest.fn(),
    };
    const service = new PlayService(
      chess, engine as never, new CharacterRegistry(), harness as never,
    );
    return { service, created };
  }

  it("streams a chat reply as chat_delta then chat_done", async () => {
    const { service, created } = talkerSetup();
    const game = await service.createGame({ characterId: "hustler", side: "white" });
    const eventsP = nextEvents(service, game.id, 2);
    await service.chat(game.id, "you nervous yet?");
    const [delta, done] = await eventsP;
    expect(delta).toEqual({ type: "chat_delta", delta: "Ha! " });
    expect(done).toEqual({ type: "chat_done" });
    const talker = created.find((c) => c.systemPrompt.includes("talking across the board"));
    expect(talker?.prompts[0]).toContain("you nervous yet?");
    expect(talker?.prompts[0]).toContain(game.fen);
  });

  it("sends a parting shot after game over", async () => {
    const { service, created } = talkerSetup();
    const game = await service.createGame({ characterId: "hustler", side: "white" });
    const eventsP = nextEvents(service, game.id, 3); // game_over, chat_delta, chat_done
    await service.resign(game.id);
    const [over, delta, done] = await eventsP;
    expect(over).toMatchObject({ type: "game_over", reason: "resignation" });
    expect(delta).toMatchObject({ type: "chat_delta" });
    expect(done).toEqual({ type: "chat_done" });
    const talker = created.find((c) => c.systemPrompt.includes("talking across the board"));
    expect(talker?.prompts.at(-1)).toContain("resignation");
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm --filter server test -- play.service`
Expected: new tests FAIL (talk is a no-op — streams never emit, `firstValueFrom` with `take(n)` hangs → set jest timeout expectations accordingly; a hang manifests as a timeout failure).

- [ ] **Step 3: Implement** — the `talk`, `talkerSystemPrompt`, `momentPrompt`, `chatPrompt`, `partingShotPrompt`, `aiHasMate` methods and the triggered-banter block, per the Mechanics above:

```ts
  private talk(session: PlaySession, prompt: string): Promise<void> {
    if (!prompt) return Promise.resolve();
    session.talkQueue = session.talkQueue.then(async () => {
      try {
        if (!session.talker) {
          session.talker = await this.harness.createSession({
            systemPrompt: this.talkerSystemPrompt(session.character),
            tools: [],
            model: PLAY_MODEL,
            emit: (e) => {
              if (e.type === "text_delta")
                session.subject.next({ type: "chat_delta", delta: e.delta });
            },
          });
        }
        await session.talker.prompt(prompt);
        session.subject.next({ type: "chat_done" });
      } catch (err) {
        session.subject.next({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
    return session.talkQueue;
  }

  private talkerSystemPrompt(character: CharacterConfig): string {
    return (
      `${character.personaPrompt}\n\n` +
      `You are playing a live game against the user and talking across the board. ` +
      `You will receive game events and user messages with position context. ` +
      `Respond in character, 1-3 short sentences. Never reveal the engine's ` +
      `evaluation or suggest moves for the user's current position.`
    );
  }

  private aiHasMate(engineEval: EngineEval, game: PlayGame): boolean {
    const mate = engineEval.lines[0]?.mate;
    // analyze() ran on a position where the AI is to move; mate > 0 = side to move mates.
    return mate !== null && mate !== undefined && mate > 0;
  }

  private momentPrompt(
    session: PlaySession,
    moment: string,
    userSan: string,
  ): string {
    const { game } = session;
    return (
      `Game event: the user just played ${userSan}. Assessment: ${moment}. ` +
      `Position (FEN): ${game.fen}. Recent moves: ${this.recentSans(game)}. ` +
      `React in character in one or two short sentences.`
    );
  }

  private chatPrompt(session: PlaySession, text: string): string {
    const { game } = session;
    const turn = game.fen.split(" ")[1] === game.side[0] ? "the user" : "you";
    return (
      `Position (FEN): ${game.fen}. Recent moves: ${
        this.recentSans(game) || "(game start)"
      }. It is ${turn} to move.\n\nThe user says: ${text}`
    );
  }

  private partingShotPrompt(session: PlaySession): string {
    const { game } = session;
    if (!game.result || !game.endReason) return "";
    const characterIsWhite = game.side === "black";
    const outcome =
      game.result === "1/2-1/2"
        ? "a draw"
        : (game.result === "1-0") === characterIsWhite
          ? "you won"
          : "you lost";
    return (
      `The game just ended: ${game.result} by ${game.endReason} — ${outcome}, ` +
      `from your perspective. Final position (FEN): ${game.fen}. ` +
      `Give your in-character parting line (1-2 sentences).`
    );
  }
```

Plus the triggered-banter block inside `aiTurn` (from Mechanics), replacing the plain `session.lastEval = engineEval;` line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter server test -- play.service`
Expected: PASS (all Task 6–8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/play/play.service.*
git commit -m "feat(play): persona talker for banter, chat, and parting shots"
```

---

### Task 9: PlayController + PlayModule + wiring

**Files:**
- Create: `apps/server/src/play/play.controller.ts`
- Create: `apps/server/src/play/play.module.ts`
- Modify: `apps/server/src/agent/agent.module.ts` (export the `AGENT_HARNESS` provider)
- Modify: `apps/server/src/app.module.ts` (import `PlayModule`)
- Test: `apps/server/src/play/play.controller.spec.ts`

**Interfaces:**
- Consumes: `PlayService` (Task 6 signatures).
- Produces the REST surface:

| Method | Path | Body → Return |
|---|---|---|
| GET | `/api/play/characters` | → `Character[]` |
| POST | `/api/play` | `CreatePlayGameRequest` → `PlayGame` |
| GET | `/api/play/:id` | → `PlayGame` |
| POST | `/api/play/:id/move` | `PlayMoveRequest` → `PlayGame` |
| POST | `/api/play/:id/resign` | → `PlayGame` |
| POST | `/api/play/:id/draw-offer` | → 202 `{accepted: true}` (verdict via SSE) |
| POST | `/api/play/:id/chat` | `PlayChatRequest` → 202 `{accepted: true}` |
| SSE | `/api/play/:id/events` | `PlayEvent` stream |

- [ ] **Step 1: Write the failing controller test**

```ts
import { Test } from "@nestjs/testing";
import { PlayController } from "./play.controller";
import { PlayService } from "./play.service";

describe("PlayController", () => {
  const service = {
    createGame: jest.fn(async () => ({ id: "g1" })),
    getGame: jest.fn(() => ({ id: "g1" })),
    getStream: jest.fn(),
    userMove: jest.fn(async () => ({ id: "g1" })),
    resign: jest.fn(async () => ({ id: "g1" })),
    offerDraw: jest.fn(async () => undefined),
    chat: jest.fn(async () => undefined),
  };
  const registry = { list: jest.fn(() => [{ id: "hustler" }]) };
  let controller: PlayController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [PlayController],
      providers: [
        { provide: PlayService, useValue: service },
        { provide: "CharacterRegistry", useValue: registry }, // adjust to class token below
      ],
    }).compile();
    controller = module.get(PlayController);
  });

  it("lists characters", () => {
    expect(controller.listCharacters()).toEqual([{ id: "hustler" }]);
  });

  it("creates a game", async () => {
    await controller.create({ characterId: "hustler", side: "white" });
    expect(service.createGame).toHaveBeenCalledWith({
      characterId: "hustler",
      side: "white",
    });
  });

  it("routes moves, resign, draw and chat", async () => {
    await controller.move("g1", { move: "e4" });
    expect(service.userMove).toHaveBeenCalledWith("g1", "e4");
    await controller.resign("g1");
    expect(service.resign).toHaveBeenCalledWith("g1");
    expect(await controller.drawOffer("g1")).toEqual({ accepted: true });
    expect(await controller.chat("g1", { text: "hi" })).toEqual({ accepted: true });
  });
});
```

Use the real class token for `CharacterRegistry` (`{ provide: CharacterRegistry, useValue: registry }`) — the string form above is a placeholder to make the intent clear; write the real one.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter server test -- play.controller`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement controller + module + wiring**

```ts
// play.controller.ts
import {
  Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Sse,
} from "@nestjs/common";
import type { MessageEvent } from "@nestjs/common";
import type { Observable } from "rxjs";
import type {
  Character, CreatePlayGameRequest, PlayChatRequest, PlayGame, PlayMoveRequest,
} from "@chess/shared";
import { CharacterRegistry } from "./character-registry.service";
import { PlayService } from "./play.service";

/**
 * Play-mode REST + SSE. `characters` is declared before `:id` routes so Nest
 * matches the literal segment first (same trick as AgentController).
 */
@Controller("play")
export class PlayController {
  constructor(
    private readonly play: PlayService,
    private readonly registry: CharacterRegistry,
  ) {}

  @Get("characters")
  listCharacters(): Character[] {
    return this.registry.list();
  }

  @Post()
  create(@Body() body: CreatePlayGameRequest): Promise<PlayGame> {
    return this.play.createGame(body);
  }

  @Get(":id")
  get(@Param("id") id: string): PlayGame {
    return this.play.getGame(id);
  }

  @Post(":id/move")
  move(@Param("id") id: string, @Body() body: PlayMoveRequest): Promise<PlayGame> {
    return this.play.userMove(id, body.move);
  }

  @Post(":id/resign")
  resign(@Param("id") id: string): Promise<PlayGame> {
    return this.play.resign(id);
  }

  @Post(":id/draw-offer")
  @HttpCode(HttpStatus.ACCEPTED)
  async drawOffer(@Param("id") id: string): Promise<{ accepted: true }> {
    void this.play.offerDraw(id);
    return { accepted: true };
  }

  @Post(":id/chat")
  @HttpCode(HttpStatus.ACCEPTED)
  async chat(
    @Param("id") id: string,
    @Body() body: PlayChatRequest,
  ): Promise<{ accepted: true }> {
    void this.play.chat(id, body.text);
    return { accepted: true };
  }

  @Sse(":id/events")
  events(@Param("id") id: string): Observable<MessageEvent> {
    return this.play.getStream(id);
  }
}
```

```ts
// play.module.ts
import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module";
import { ChessModule } from "../chess/chess.module";
import { EngineModule } from "../engine/engine.module";
import { CharacterRegistry } from "./character-registry.service";
import { PlayController } from "./play.controller";
import { PlayService } from "./play.service";

@Module({
  imports: [ChessModule, EngineModule, AgentModule],
  controllers: [PlayController],
  providers: [PlayService, CharacterRegistry],
})
export class PlayModule {}
```

In `agent.module.ts`: add `AGENT_HARNESS` to the module's `exports` array (read the file first; the provider already exists there — this is a one-line change).
In `app.module.ts`: add `PlayModule` to `imports`.
Check the actual names of `ChessModule`/`EngineModule` exports in their module files before importing; adjust if the engine/chess providers are exported elsewhere (e.g. via a shared `EngineModule` already imported by `AnalysisModule` — mirror however `analysis.module.ts` gets them).

- [ ] **Step 4: Run the full server test suite**

Run: `pnpm --filter server test`
Expected: PASS. Also boot check: `pnpm --filter server build` exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src
git commit -m "feat(play): REST + SSE controller and module wiring"
```

---

### Task 10: Web API client + playStore

**Files:**
- Modify: `apps/web/src/lib/api.ts` (append play functions)
- Create: `apps/web/src/playStore.ts`
- Test: `apps/web/src/playStore.test.ts`

**Interfaces:**
- Consumes: shared play types; existing `api.ts` internals — read the file's existing `request`/fetch helper and `openAgentStream` (line ~236) and mirror them exactly.
- Produces:

```ts
// api.ts additions
export function listCharacters(): Promise<Character[]>;
export function createPlayGame(body: CreatePlayGameRequest): Promise<PlayGame>;
export function getPlayGame(id: string): Promise<PlayGame>;
export function sendPlayMove(id: string, move: string): Promise<PlayGame>;
export function resignPlayGame(id: string): Promise<PlayGame>;
export function offerPlayDraw(id: string): Promise<void>;
export function sendPlayChat(id: string, text: string): Promise<void>;
export function openPlayStream(id: string): EventSource; // caller closes it

// playStore.ts
export interface PlayChatMessage {
  role: "user" | "character";
  text: string;
  streaming?: boolean;
}
export interface PlayState {
  game: PlayGame | null;
  character: Character | null;
  chat: PlayChatMessage[];
  thinking: boolean;          // user move sent, AI reply pending
  streamStatus: "idle" | "open" | "error";
  overlayDismissed: boolean;
  start(game: PlayGame, character: Character): void;
  setGame(game: PlayGame): void;
  setThinking(v: boolean): void;
  setStreamStatus(s: PlayState["streamStatus"]): void;
  applyEvent(event: PlayEvent): void;
  addUserChat(text: string): void;
  dismissOverlay(): void;
  reset(): void;
}
export const usePlayStore: UseBoundStore<StoreApi<PlayState>>;
```

`applyEvent` reducer rules:
- `ai_move`: append `event.move` to `game.moves`, set `game.fen = event.fen`, `thinking = false`.
- `banter`: push `{ role: "character", text }`.
- `chat_delta`: if last chat message is `{role:"character", streaming:true}` append delta to it, else push a new streaming character message.
- `chat_done`: mark the streaming message `streaming: false`.
- `draw_response`: push a synthetic character message `accepted ? "(accepts the draw)" : "(declines the draw)"` — the persona comment, if any, arrives separately as chat.
- `game_over`: set `game.status = "over"`, `game.result`, `game.endReason` from the event; `thinking = false`.
- `error`: push `{ role: "character", text: `⚠ ${message}` }`, `thinking = false`.

- [ ] **Step 1: Write the failing store tests**

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { Character, Move, PlayGame } from "@chess/shared";
import { usePlayStore } from "./playStore";

const character: Character = {
  id: "hustler", name: "The Washington Square Hustler", avatar: "🗽",
  tagline: "Five bucks a game.", bio: "…", strength: 3, styleTag: "Trappy",
};
const game: PlayGame = {
  id: "g1", characterId: "hustler", side: "white",
  startFen: "start-fen", fen: "start-fen", moves: [], status: "active",
};
const aiMove: Move = {
  ply: 2, moveNumber: 1, color: "b", san: "e5", uci: "e7e5",
  fenBefore: "fen-1", fenAfter: "fen-2",
};

describe("playStore", () => {
  beforeEach(() => usePlayStore.getState().reset());

  it("applies ai_move: appends move, updates fen, clears thinking", () => {
    const s = usePlayStore.getState();
    s.start(game, character);
    s.setThinking(true);
    s.applyEvent({ type: "ai_move", move: aiMove, fen: "fen-2" });
    const st = usePlayStore.getState();
    expect(st.game?.moves).toEqual([aiMove]);
    expect(st.game?.fen).toBe("fen-2");
    expect(st.thinking).toBe(false);
  });

  it("accumulates chat_delta into one streaming message and closes on chat_done", () => {
    const s = usePlayStore.getState();
    s.start(game, character);
    s.applyEvent({ type: "chat_delta", delta: "Clock's " });
    s.applyEvent({ type: "chat_delta", delta: "ticking." });
    expect(usePlayStore.getState().chat).toEqual([
      { role: "character", text: "Clock's ticking.", streaming: true },
    ]);
    s.applyEvent({ type: "chat_done" });
    expect(usePlayStore.getState().chat[0].streaming).toBe(false);
  });

  it("keeps banter and user chat ordered", () => {
    const s = usePlayStore.getState();
    s.start(game, character);
    s.applyEvent({ type: "banter", text: "You see it?" });
    s.addUserChat("no");
    expect(usePlayStore.getState().chat.map((m) => m.role)).toEqual([
      "character", "user",
    ]);
  });

  it("applies game_over onto the game", () => {
    const s = usePlayStore.getState();
    s.start(game, character);
    s.applyEvent({ type: "game_over", result: "0-1", reason: "checkmate" });
    const st = usePlayStore.getState();
    expect(st.game).toMatchObject({
      status: "over", result: "0-1", endReason: "checkmate",
    });
  });

  it("resets", () => {
    const s = usePlayStore.getState();
    s.start(game, character);
    s.reset();
    expect(usePlayStore.getState().game).toBeNull();
    expect(usePlayStore.getState().chat).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter web test -- playStore`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `playStore.ts`** (zustand `create`, same style as `store.ts`; immutably rebuild `game`/`chat` on each event per the reducer rules above) **and the `api.ts` additions** (follow the file's existing helpers exactly; `openPlayStream(id)` mirrors `openAgentStream` with URL `/api/play/${id}/events`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter web test -- playStore`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/playStore.ts apps/web/src/playStore.test.ts apps/web/src/lib/api.ts
git commit -m "feat(web): play API client and play store"
```

---

### Task 11: Roster view + routes + nav

**Files:**
- Create: `apps/web/src/views/PlayView.tsx`
- Create: `apps/web/src/components/play/CharacterCard.tsx`
- Modify: `apps/web/src/main.tsx` (add `/play` and `/play/$gameId` routes)
- Modify: `apps/web/src/views/AnalysisView.tsx` and `apps/web/src/views/LibraryView.tsx` (add a "Play" link beside the existing Library/Analyze links in the top bar — find the existing `<Link to="/library">` and mirror it)
- Test: `apps/web/src/views/PlayView.test.tsx`

**Interfaces:**
- Consumes: `listCharacters`, `createPlayGame` from `lib/api`; `usePlayStore.start`; router `useNavigate`.
- Produces: route paths `/play` and `/play/$gameId` (Task 12 implements the game view; register the route now with a placeholder component if needed, or hold both route registrations to Task 12 — pick registering `/play` only in this task and add `/play/$gameId` in Task 12).

Behavior:
- `PlayView`: `useQuery({ queryKey: ["play-characters"], queryFn: listCharacters })`; responsive grid (`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4`) of `CharacterCard`s; page heading "Choose your opponent".
- `CharacterCard`: shadcn `Card`; shows avatar (large emoji), name, tagline (italic), strength as `"★".repeat(strength) + "☆".repeat(5 - strength)`, styleTag badge. Clicking toggles an expanded state showing `bio` + three buttons: "Play as White", "Play as Black", "Random". Buttons call `createPlayGame({ characterId, side })`, then `usePlayStore.getState().start(game, character)`, then `navigate({ to: "/play/$gameId", params: { gameId: game.id } })`. Disable buttons while the create request is in flight; surface failure with the existing `sonner` toast.

- [ ] **Step 1: Write the failing test** (mock `lib/api`; the pattern is in `LibraryView.test.tsx` — mirror its render/queryclient setup)

```tsx
it("renders the roster and starts a game on side pick", async () => {
  // mock listCharacters -> [hustler fixture]; createPlayGame -> resolves a PlayGame
  render(<PlayView />, { wrapper });   // wrapper: QueryClientProvider + router stub per LibraryView.test.tsx
  expect(await screen.findByText("The Washington Square Hustler")).toBeInTheDocument();
  fireEvent.click(screen.getByText("The Washington Square Hustler"));
  fireEvent.click(await screen.findByText("Play as White"));
  await waitFor(() =>
    expect(api.createPlayGame).toHaveBeenCalledWith({
      characterId: "hustler",
      side: "white",
    }),
  );
});
```

Adapt the wrapper/mocks to the conventions in `LibraryView.test.tsx` (read it first; reuse its router-mocking approach verbatim).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter web test -- PlayView`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `CharacterCard` + `PlayView` + route registration in `main.tsx`:

```tsx
const playRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/play",
  component: PlayView,
});
// add to routeTree: rootRoute.addChildren([indexRoute, libraryRoute, playRoute])
```

Nav links: in both views' top bars add `<Link to="/play">Play</Link>` styled identically to the neighboring Library link.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter web test -- PlayView && pnpm --filter web build`
Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): /play roster grid with character cards and nav entry"
```

---

### Task 12: Play game view (board + SSE + chat + controls)

**Files:**
- Create: `apps/web/src/views/PlayGameView.tsx`
- Create: `apps/web/src/components/play/PlayChat.tsx`
- Modify: `apps/web/src/main.tsx` (add `/play/$gameId` route)
- Test: `apps/web/src/views/PlayGameView.test.tsx`

**Interfaces:**
- Consumes: `usePlayStore` (Task 10), `openPlayStream`, `sendPlayMove`, `sendPlayChat`, `resignPlayGame`, `offerPlayDraw`, `getPlayGame`; `Chessboard` from react-chessboard v5 via the `options` object (see `BoardPanel.tsx:152` for the exact `ChessboardOptions` usage, `onPieceDrop` signature and snap-back-on-false convention); `BoardPlayers` name-plate component if reusable (read `BoardPlayers.tsx`; else inline simple plates).
- Produces: the `/play/$gameId` screen.

Behavior:
- On mount: if `usePlayStore.game?.id !== gameId` (deep link / refresh), fetch `getPlayGame(gameId)`; server sessions are memory-only, so a 404 renders a "This game has ended or was lost on restart" card with a link back to `/play`. Open `openPlayStream(gameId)`; `onmessage` → `applyEvent(JSON.parse(e.data))`; `onerror` → `setStreamStatus("error")`; close on unmount.
- Layout (mirror `AnalysisView`'s grid): left column — character name plate (avatar, name, strength stars) above the board, user plate below, board `orientation` = user side; under the board a control strip: "Resign" (with a confirm popover), "Offer draw". Right column — `PlayChat`.
- Move input: `onPieceDrop` — construct UCI `${from}${to}` (+ promotion "q" when a pawn reaches the last rank; mirror BoardPanel's approach); optimistically return `true` only after a client-side legality check is impractical here, so: call `sendPlayMove` fire-and-forget style is NOT acceptable — instead do what BoardPanel's free-move drop does synchronously if it validates locally, otherwise: return `true`, `setThinking(true)`, `setGame(await sendPlayMove(...))` in an async IIFE, and on `ApiError` revert by refetching `getPlayGame(gameId)` and toasting the message. Block drops entirely when `thinking`, when `game.status !== "active"`, or when it's not the user's turn (`game.fen.split(" ")[1] !== game.side[0]`).
- `PlayChat`: renders `chat` messages (character messages prefixed with the avatar; streaming message gets the existing pulse/cursor treatment from `ChatPanel` — read `ChatPanel.tsx` and reuse its message-bubble classes), an input + send button calling `addUserChat(text)` + `sendPlayChat(gameId, text)`. A subtle "thinking…" indicator row when `thinking`.

- [ ] **Step 1: Write the failing tests** (stub `EventSource` exactly like `ChatPanel.test.tsx:16` does; mock `lib/api`)

```tsx
it("applies streamed ai_move events to the board state", async () => {
  // start store with an active game as white; render; emit an ai_move on the stub stream
  // assert usePlayStore.getState().game.moves includes the streamed move
});

it("sends a chat message and renders the streamed reply", async () => {
  // type into the input, click send; assert sendPlayChat called;
  // emit chat_delta + chat_done; assert the character bubble renders "…" text
});

it("blocks resign/draw controls after game_over", async () => {
  // emit game_over; assert Resign button is disabled
});
```

Write these as full tests following `ChatPanel.test.tsx` conventions (StubEventSource, `vi.stubGlobal`, api module mock).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter web test -- PlayGameView`
Expected: FAIL.

- [ ] **Step 3: Implement** `PlayGameView` + `PlayChat` + the `$gameId` route:

```tsx
const playGameRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/play/$gameId",
  component: PlayGameView,
});
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter web test -- PlayGameView && pnpm --filter web build`
Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): play game view with live board, persona chat, and controls"
```

---

### Task 13: Game-over overlay, library save, analyze handoff, rematch

**Files:**
- Create: `apps/web/src/components/play/GameOverOverlay.tsx`
- Modify: `apps/web/src/views/PlayGameView.tsx` (render overlay when `game.status === "over" && !overlayDismissed`)
- Test: `apps/web/src/components/play/GameOverOverlay.test.tsx`

**Interfaces:**
- Consumes: `usePlayStore`; `gamesRepo.put(game: Game, meta: GameMeta)` from `lib/db/games-repo` (`GameMeta = { source: ImportSource; collectionId?: string; createdAt: number; contentHash: string }`); `contentHash` + `normalizedSanList` from `@chess/shared`; `useAnalyzerStore.getState().setGame(game)` from `store.ts`; `createPlayGame` for rematch.
- Produces: the end-of-game UX.

Behavior:
- Overlay: dialog-style card over the board (shadcn `Dialog` or absolutely-positioned card like the review overlays — match whichever pattern `ImportDialog`/existing modals use). Content: big result line (`"1–0 · Checkmate"` — humanize `endReason`), the character avatar, and the parting shot: bind to the LAST character chat message that arrived after `game_over` (render live as it streams; show a subtle "…" until `chat_done`). Buttons: **Analyze this game** (primary), **Rematch**, **New opponent**, and an X/dismiss that calls `dismissOverlay()` (chat stays usable behind it).
- **Analyze this game**: build a `Game` from the `PlayGame` —

```ts
const finished: Game = {
  id: playGame.id,
  headers: {
    white: playGame.side === "white" ? "You" : character.name,
    black: playGame.side === "black" ? "You" : character.name,
    result: playGame.result,
    event: `Play vs ${character.name}`,
    date: new Date().toISOString().slice(0, 10).replace(/-/g, "."),
  },
  startFen: playGame.startFen,
  moves: playGame.moves,
};
await gamesRepo.put(finished, {
  source: "manual",
  createdAt: Date.now(),
  contentHash: contentHash(finished.startFen, normalizedSanList(finished.moves.map((m) => m.san))),
});
useAnalyzerStore.getState().setGame(finished);
navigate({ to: "/" });
```

Check `contentHash`'s real signature in `packages/shared/src/content-hash.ts` first and call it the way `ImportDialog`/import flow does — copy that call site.
- **Rematch**: `createPlayGame({ characterId, side: opposite(playGame.side) })` → `start(...)` → navigate to the new `/play/$gameId`.
- **New opponent**: `reset()` + navigate `/play`.

- [ ] **Step 1: Write the failing tests**

```tsx
it("shows the result and saves to the library on Analyze", async () => {
  // store: finished game (0-1 checkmate) + character; mock gamesRepo.put + navigate
  // click "Analyze this game"; assert gamesRepo.put called with headers.white "You"
  // and that useAnalyzerStore.getState().game?.id === playGame.id
});

it("starts a color-swapped rematch", async () => {
  // click Rematch; assert createPlayGame called with side "black" for a white user
});
```

Write in full, mocking `lib/db/games-repo` and `lib/api`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter web test -- GameOverOverlay`
Expected: FAIL.

- [ ] **Step 3: Implement** the overlay and wire it into `PlayGameView`.

- [ ] **Step 4: Run the full web suite + build**

Run: `pnpm --filter web test && pnpm --filter web build`
Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): game-over overlay with library save, analyze handoff, and rematch"
```

---

### Task 14: End-to-end verification

**Files:** none (manual verification; fix-forward anything found, committing fixes separately).

- [ ] **Step 1: Full test suites**

Run: `pnpm --filter @chess/shared build && pnpm --filter server test && pnpm --filter web test`
Expected: all PASS.

- [ ] **Step 2: Live run** (requires Stockfish on PATH or `STOCKFISH_PATH`, and the agent backend configured as for the existing coach)

Start both apps the way the repo normally does (check root `package.json` scripts — typically `pnpm dev`). Then in the browser:

1. Nav shows **Play**; `/play` renders 8 character cards with stars and taglines.
2. Pick The Hustler → Play as White → board appears, hustler name plate on top.
3. Play 1. e4 — an AI reply arrives within a few seconds; banter appears in the chat panel on notable moments (hang a piece on purpose: `user-blunder` banter should fire).
4. Type a message — a streamed in-character reply arrives.
5. Offer a draw early — expect a decline.
6. Resign — overlay shows the result and a streamed parting shot.
7. Click **Analyze this game** — lands on `/` with the game loaded and present in the Library.
8. Rematch — new game as Black; the AI (White) moves first.
9. Kill the LLM path (e.g. unset the provider key) and play a move — the game continues with engine-best moves and no banter (silent degradation).

- [ ] **Step 3: Fix anything broken**, committing each fix (`fix(play): …`).

- [ ] **Step 4: Final commit / cleanup**

```bash
git status   # confirm clean tree, all work committed
```

---

## Plan self-review (completed)

- **Spec coverage:** roster grid ✓ (T11), play screen ✓ (T12), result overlay + library + analyze + rematch ✓ (T13), candidate pipeline + validation fallback ✓ (T4/T7), banter triggers + cooldown ✓ (T5/T8), persona chat with no tools ✓ (T8), draw rule ✓ (T6), REST/SSE surface ✓ (T9), shared types ✓ (T1), error handling ✓ (T6–T8, T12), tests per spec ✓ (each task). Spec's "parting shot inside game_over payload" is delivered as a streamed chat message after `game_over` instead (simpler; overlay binds to it) — deviation noted in T13.
- **Type consistency:** `PlayEvent` variants match between T1, T6–T8 emissions, and T10 reducer; `Candidate` fields match T4↔T7; controller signatures match T6↔T9; `GameMeta` matches `games-repo.ts`.
- **Placeholders:** none — every code step carries real code; the three web-view test steps specify exact conventions files to mirror (`LibraryView.test.tsx`, `ChatPanel.test.tsx`) and the behavior to assert.
