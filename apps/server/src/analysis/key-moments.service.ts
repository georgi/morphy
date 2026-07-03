import { Injectable, Logger } from "@nestjs/common";
import type {
  Color,
  Game,
  KeyMoment,
  Move,
  MoveClassification,
  MoveEval,
} from "@chess/shared";
import { ChessService } from "../chess/chess.service";

/** How many key moments to surface at most — keep the review focused (PRODUCT §5). */
const MAX_KEY_MOMENTS = 5;

/**
 * cp-loss at or above which a move is mate-magnitude (a forced mate appeared or
 * was missed) rather than a finite material/positional swing — phrase it as a
 * mate instead of an absurd pawn count.
 */
const MATE_MAGNITUDE_CP = 50_000;

/**
 * Severity rank per classification, biggest first. Only the three "you erred"
 * classes ever become key moments; the rest are filtered out before ranking.
 */
const SEVERITY: Record<string, number> = {
  blunder: 3,
  mistake: 2,
  inaccuracy: 1,
};

/** Human, uppercase-free label per classification for the templated description. */
const CLASS_NOUN: Record<string, string> = {
  blunder: "Blunder",
  mistake: "Mistake",
  inaccuracy: "Inaccuracy",
};

/** Classifications that qualify as a key moment. */
const KEY_CLASSES = new Set<MoveClassification>([
  "inaccuracy",
  "mistake",
  "blunder",
]);

/** Time budget for the best-effort coach-prose call before falling back. */
const ENRICH_TIMEOUT_MS = 15_000;

/**
 * System prompt for the one-shot prose pass. Asks for a strict JSON array keyed
 * by ply so the result merges deterministically onto the selected moments. The
 * voice mirrors the product brand (lucid, candid, mentorly; second person).
 */
const ENRICH_SYSTEM_PROMPT = `You are a chess coach. You are given the decisive moments of a single game — each a move the player got wrong, with the engine's better move. For each moment, write one short coaching note (at most two sentences) in the second person ("you"), concrete and specific: name what the played move missed and why the better move holds. Be candid but never harsh; never gloat, never coddle, no filler.

Output ONLY a JSON array, no prose around it, in this exact shape:
[{"ply": <number>, "description": "<your note>"}]

Use the same ply numbers you were given. Do not add, drop, or reorder entries.`;

/**
 * Selects and (best-effort) narrates the decisive moments of a game.
 *
 * Selection is pure and deterministic — the same `MoveEval[]` always yields the
 * same {@link KeyMoment}s with templated descriptions — so the review renders
 * with or without the agent. {@link forGame} layers an optional one-shot coach
 * prose pass on top; if the agent is unavailable (no credentials, an error, a
 * timeout) the templated descriptions are kept and the endpoint still succeeds.
 */
@Injectable()
export class KeyMomentsService {
  private readonly logger = new Logger(KeyMomentsService.name);

  constructor(private readonly chess: ChessService) {}

  /**
   * Pick up to five decisive moments from a game's eval curve, newest analysis
   * wins. Pure and deterministic: from the moves classified inaccuracy/mistake/
   * blunder, rank by severity then centipawn loss (both descending) and keep the
   * top five, then return them in board order (ply ascending). The single largest
   * swing is flagged `isTurningPoint`. Each carries a templated `description`.
   */
  select(analysis: MoveEval[], game: Game): KeyMoment[] {
    const flagged = analysis.filter((e) => KEY_CLASSES.has(e.classification));
    if (flagged.length === 0) return [];

    // Rank the candidates: severity first, then cp-loss — both descending — so
    // the worst moves win the limited slots. The sort is stable for ties.
    const ranked = [...flagged].sort((a, b) => {
      const sev =
        (SEVERITY[b.classification] ?? 0) - (SEVERITY[a.classification] ?? 0);
      if (sev !== 0) return sev;
      return b.cpLoss - a.cpLoss;
    });

    const top = ranked.slice(0, MAX_KEY_MOMENTS);

    // The turning point is the single biggest swing. cp-loss already folds a
    // walked-into (or missed) mate into a dominating value (see AnalysisService),
    // so the largest cp-loss is mate-aware. Ties resolve to the earliest ply.
    const turningPly = this.turningPointPly(top);

    return top
      .map((moveEval) =>
        this.toKeyMoment(moveEval, game, moveEval.ply === turningPly),
      )
      .sort((a, b) => a.ply - b.ply);
  }

  /**
   * Key moments for a game sent by value, with coach prose merged in when the
   * agent is reachable. Reads the analysis attached to `game` (the client owns
   * running/caching it); an unanalyzed game (`game.analysis` empty/absent)
   * yields `[]` so the client can show an "analyze to see key moments" state.
   *
   * Enrichment is strictly best-effort: any failure (missing credentials, agent
   * error, timeout, malformed JSON) leaves the templated descriptions in place.
   */
  async forGame(game: Game): Promise<KeyMoment[]> {
    if (!game.analysis || game.analysis.length === 0) {
      return [];
    }

    const moments = this.select(game.analysis, game);
    if (moments.length === 0) return moments;

    try {
      const prose = await this.enrichDescriptions(game, moments);
      if (prose.size > 0) {
        for (const moment of moments) {
          const text = prose.get(moment.ply);
          if (text) moment.description = text;
        }
      }
    } catch (err) {
      // Never fail the endpoint because the agent is unavailable — the templated
      // descriptions already render a complete review.
      this.logger.warn(
        `Key-moment prose enrichment skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return moments;
  }

  // ── selection internals ────────────────────────────────────────────────────

  /** Ply of the single largest swing (max cp-loss; earliest ply breaks ties). */
  private turningPointPly(moments: MoveEval[]): number | null {
    let best: MoveEval | null = null;
    for (const m of moments) {
      if (
        !best ||
        m.cpLoss > best.cpLoss ||
        (m.cpLoss === best.cpLoss && m.ply < best.ply)
      ) {
        best = m;
      }
    }
    return best?.ply ?? null;
  }

  /** Build a {@link KeyMoment} from one flagged move, with a templated description. */
  private toKeyMoment(
    moveEval: MoveEval,
    game: Game,
    isTurningPoint: boolean,
  ): KeyMoment {
    const move = this.moveForPly(game, moveEval.ply);
    const color: Color = move?.color ?? (moveEval.ply % 2 === 1 ? "w" : "b");
    const moveNumber =
      move?.moveNumber ?? Math.floor((moveEval.ply - 1) / 2) + 1;

    return {
      ply: moveEval.ply,
      moveNumber,
      color,
      san: moveEval.san,
      classification: moveEval.classification,
      scoreCpAfter: moveEval.scoreCpAfter,
      evalText: formatWhitePovScore(moveEval.scoreCpAfter),
      isTurningPoint,
      description: this.templatedDescription(moveEval, game),
    };
  }

  /** Look up the played move for a ply (1-based), or `undefined` if out of range. */
  private moveForPly(game: Game, ply: number): Move | undefined {
    return game.moves[ply - 1];
  }

  /**
   * Deterministic fallback description: classification + pawn swing + the move
   * that should have been played. Always renders, even with no agent. Example:
   * "Mistake: a 1.5-pawn swing. Bg4 held the balance."
   */
  private templatedDescription(moveEval: MoveEval, game: Game): string {
    const noun = CLASS_NOUN[moveEval.classification] ?? "Inaccuracy";
    const better = this.bestMoveSan(moveEval, game);

    // A mate-magnitude cp-loss means a forced mate appeared (or was missed);
    // phrase it that way instead of as an absurd pawn count.
    const lead =
      moveEval.cpLoss >= MATE_MAGNITUDE_CP
        ? `${noun}: walks into a forced mate.`
        : `${noun}: a ${(moveEval.cpLoss / 100).toFixed(1)}-pawn swing.`;
    if (!better) return `${lead} A stronger move was available.`;
    return `${lead} ${better} held the balance.`;
  }

  /**
   * The engine's better move in SAN for the position before the played move.
   * Prefers the first move of the best line, falling back to `bestMove`; both are
   * UCI, so they are converted relative to the pre-move position. Returns `null`
   * when no better move is known or it can't be resolved.
   */
  private bestMoveSan(moveEval: MoveEval, game: Game): string | null {
    const uci = moveEval.bestLine[0] ?? moveEval.bestMove;
    if (!uci) return null;
    const fenBefore = this.chess.positionAtPly(game, moveEval.ply - 1);
    return this.chess.uciToSan(fenBefore, uci);
  }

  // ── agent enrichment ───────────────────────────────────────────────────────

  /**
   * One-shot coach-prose pass: spin up a tool-less Pi session, ask for a
   * `[{ply, description}]` array, and return the parsed descriptions keyed by
   * ply. Time-boxed; the caller wraps this in try/catch so any failure (missing
   * credentials, agent error, timeout, malformed output) falls back to templates.
   */
  private async enrichDescriptions(
    game: Game,
    moments: KeyMoment[],
  ): Promise<Map<number, string>> {
    const session = await this.createOneShotSession();
    try {
      const prompt = this.buildEnrichPrompt(game, moments);
      await this.withTimeout(session.prompt(prompt), ENRICH_TIMEOUT_MS);
      const text = session.getLastAssistantText() ?? "";
      return this.parseProse(text, moments);
    } finally {
      session.dispose();
    }
  }

  /**
   * Create a fresh, tool-less Pi session with the JSON-only coach system prompt.
   * Mirrors {@link AgentService}'s session setup (suppress all project-local
   * discovery; this is a server with no codebase context), minus the custom tools.
   */
  private async createOneShotSession() {
    const { loadEsm } = await import("../agent/harness/esm-loader");
    const {
      createAgentSession,
      SessionManager,
      DefaultResourceLoader,
      getAgentDir,
    } = await loadEsm<typeof import("@earendil-works/pi-coding-agent")>(
      "@earendil-works/pi-coding-agent",
    );

    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt: ENRICH_SYSTEM_PROMPT,
      appendSystemPrompt: [],
      systemPromptOverride: () => ENRICH_SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      // No tools at all — this is a single text generation, not an agent loop.
      noTools: "all",
      tools: [],
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
    });
    return session;
  }

  /**
   * The user prompt for the prose pass: game framing plus one compact line per
   * moment (ply, move played, classification, swing, the better move) so the
   * model has the facts it needs and returns notes keyed to the right plies.
   */
  private buildEnrichPrompt(game: Game, moments: KeyMoment[]): string {
    const white = game.headers.white ?? "White";
    const black = game.headers.black ?? "Black";
    const opening = [game.headers.eco, game.headers.opening]
      .filter(Boolean)
      .join(" ");

    const header = [
      `Game: ${white} (White) vs ${black} (Black).`,
      opening ? `Opening: ${opening}.` : null,
      `Decisive moments (write a note for each ply):`,
    ]
      .filter(Boolean)
      .join("\n");

    const rows = moments.map((m) => {
      const idx = m.color === "w" ? `${m.moveNumber}.` : `${m.moveNumber}...`;
      const moveEval = game.analysis?.find((e) => e.ply === m.ply);
      const better = moveEval ? this.bestMoveSan(moveEval, game) : null;
      const swing = moveEval ? (moveEval.cpLoss / 100).toFixed(1) : "?";
      return (
        `- ply ${m.ply}: ${idx}${m.san} by ${m.color === "w" ? "White" : "Black"} ` +
        `(${m.classification}, ${swing}-pawn swing, eval after ${m.evalText})` +
        (better ? `; engine preferred ${better}.` : ".")
      );
    });

    return `${header}\n${rows.join("\n")}`;
  }

  /**
   * Parse the model's JSON array into a ply→description map, keeping only entries
   * whose ply matches a selected moment. Tolerant of stray prose around the JSON
   * (extracts the first bracketed array). Returns an empty map on any parse miss.
   */
  private parseProse(text: string, moments: KeyMoment[]): Map<number, string> {
    const out = new Map<number, string>();
    const valid = new Set(moments.map((m) => m.ply));

    const json = extractJsonArray(text);
    if (!json) return out;

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return out;
    }
    if (!Array.isArray(parsed)) return out;

    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const ply = (entry as { ply?: unknown }).ply;
      const description = (entry as { description?: unknown }).description;
      if (
        typeof ply === "number" &&
        typeof description === "string" &&
        description.trim() &&
        valid.has(ply)
      ) {
        out.set(ply, description.trim());
      }
    }
    return out;
  }

  /** Reject if `promise` doesn't settle within `ms`, so a slow agent can't hang. */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Enrichment timed out after ${ms}ms`)),
        ms,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}

/**
 * White-POV score readout matching the shared formatter convention
 * (`+0.9` / `−2.3`, U+2212 minus). A mate folds to a `null` centipawn score on
 * the MoveEval, so it surfaces as `M` — the sign is unknown without a mate count.
 */
function formatWhitePovScore(scoreCp: number | null): string {
  // A null centipawn score is a mate line (no finite value); show the mate glyph.
  if (scoreCp === null) return "#";
  const pawns = scoreCp / 100;
  return `${pawns >= 0 ? "+" : "−"}${Math.abs(pawns).toFixed(1)}`;
}

/**
 * Extract the first top-level JSON array from a blob of text (the model may wrap
 * the array in code fences or commentary). Returns the bracketed substring, or
 * `null` if no balanced `[...]` is found.
 */
function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
