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
