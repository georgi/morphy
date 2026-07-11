import { Injectable, NotFoundException } from "@nestjs/common";
import type { Character } from "@chess/shared";
import { CHARACTERS, type CharacterConfig } from "./characters.data";

/** Static roster lookup. `list()` exposes only the public Character subset. */
@Injectable()
export class CharacterRegistry {
  list(): Character[] {
    return CHARACTERS.map(
      ({ id, name, avatar, tagline, bio, strength, styleTag }) => ({
        id,
        name,
        avatar,
        tagline,
        bio,
        strength,
        styleTag,
      }),
    );
  }

  get(id: string): CharacterConfig {
    const config = CHARACTERS.find((c) => c.id === id);
    if (!config) throw new NotFoundException(`Unknown character: ${id}`);
    return config;
  }
}
