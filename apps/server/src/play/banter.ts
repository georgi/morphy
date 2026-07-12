import type { Color } from "@chess/shared";
import type { BanterTriggerKind } from "./characters.data";
import type { Candidate } from "./move-candidates";

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

/** Minimum White-POV spread between candidates for the choice to count as stylistic. */
const CRITICAL_SPREAD_CP = 40;

/**
 * Whether the AI's move choice is worth an LLM call. Routine positions —
 * one candidate, or several near-identical ones with nothing going on — play
 * the engine's best move directly, keeping play fast and cheap. The LLM is
 * consulted only when the pick can express character: a tactical moment just
 * happened, a mate or an offbeat option is on the menu, or the candidates
 * genuinely diverge in evaluation.
 */
export function isCriticalChoice(
  candidates: Array<Pick<Candidate, "scoreCp" | "mate" | "offbeat">>,
  moment: BanterTriggerKind | null,
): boolean {
  if (candidates.length < 2) return false;
  if (moment !== null) return true;
  if (candidates.some((c) => c.offbeat || c.mate !== null)) return true;
  const cps = candidates
    .map((c) => c.scoreCp)
    .filter((cp): cp is number => cp !== null);
  if (cps.length < 2) return false;
  return Math.max(...cps) - Math.min(...cps) >= CRITICAL_SPREAD_CP;
}
