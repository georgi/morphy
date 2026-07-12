import { cooldownPlies, detectMoment, isCriticalChoice } from "./banter";

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

describe("isCriticalChoice", () => {
  const c = (scoreCp: number | null, extra?: Partial<{ mate: number | null; offbeat: boolean }>) => ({
    scoreCp,
    mate: extra?.mate ?? null,
    offbeat: extra?.offbeat ?? false,
  });

  it("is routine with fewer than two candidates", () => {
    expect(isCriticalChoice([], null)).toBe(false);
    expect(isCriticalChoice([c(30)], "user-blunder")).toBe(false);
  });

  it("is critical when a moment just happened", () => {
    expect(isCriticalChoice([c(30), c(25)], "user-blunder")).toBe(true);
  });

  it("is critical when a mate or offbeat option is on the menu", () => {
    expect(isCriticalChoice([c(null, { mate: 3 }), c(30)], null)).toBe(true);
    expect(isCriticalChoice([c(30), c(null, { offbeat: true })], null)).toBe(true);
  });

  it("is critical only when candidate evals genuinely diverge", () => {
    expect(isCriticalChoice([c(30), c(20)], null)).toBe(false); // 10cp: routine
    expect(isCriticalChoice([c(30), c(-20)], null)).toBe(true); // 50cp: stylistic fork
  });
});
