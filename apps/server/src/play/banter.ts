import type { Color } from "@chess/shared";
import type { BanterTriggerKind } from "./characters.data";

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
