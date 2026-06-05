// A small, bundled ECO table. This is intentionally a curated handful of common
// openings — enough to label the most frequent games without shipping the full
// ~3000-line ECO database. Matching is by the leading SAN sequence of a game.
//
// Each entry lists the opening's SAN move prefix. A game matches an entry when
// the game's first N half-moves equal the entry's `moves` (N = entry length).
// We pick the longest matching entry so e.g. "Ruy Lopez" wins over "King's Pawn".

export interface EcoEntry {
  eco: string;
  name: string;
  /** Ordered SAN half-moves that define this opening's prefix. */
  moves: string[];
}

export const ECO_TABLE: readonly EcoEntry[] = [
  // King's Pawn family
  { eco: 'B00', name: "King's Pawn Game", moves: ['e4'] },
  { eco: 'C20', name: "King's Pawn Game", moves: ['e4', 'e5'] },
  { eco: 'C40', name: "King's Knight Opening", moves: ['e4', 'e5', 'Nf3'] },
  { eco: 'C44', name: "King's Pawn Game", moves: ['e4', 'e5', 'Nf3', 'Nc6'] },
  { eco: 'C60', name: 'Ruy Lopez', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'] },
  {
    eco: 'C65',
    name: 'Ruy Lopez: Berlin Defense',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nf6'],
  },
  {
    eco: 'C50',
    name: 'Italian Game',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'],
  },
  {
    eco: 'C53',
    name: 'Italian Game: Giuoco Piano',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'],
  },
  {
    eco: 'C42',
    name: 'Petrov Defense',
    moves: ['e4', 'e5', 'Nf3', 'Nf6'],
  },

  // Sicilian
  { eco: 'B20', name: 'Sicilian Defense', moves: ['e4', 'c5'] },
  {
    eco: 'B21',
    name: 'Sicilian Defense: Smith-Morra Gambit',
    moves: ['e4', 'c5', 'd4'],
  },
  {
    eco: 'B27',
    name: 'Sicilian Defense',
    moves: ['e4', 'c5', 'Nf3'],
  },
  {
    eco: 'B90',
    name: 'Sicilian Defense: Najdorf Variation',
    moves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'],
  },

  // French / Caro-Kann / Pirc / Scandinavian
  { eco: 'C00', name: 'French Defense', moves: ['e4', 'e6'] },
  { eco: 'B10', name: 'Caro-Kann Defense', moves: ['e4', 'c6'] },
  { eco: 'B07', name: 'Pirc Defense', moves: ['e4', 'd6'] },
  { eco: 'B01', name: 'Scandinavian Defense', moves: ['e4', 'd5'] },

  // Queen's Pawn family
  { eco: 'A40', name: "Queen's Pawn Game", moves: ['d4'] },
  { eco: 'D00', name: "Queen's Pawn Game", moves: ['d4', 'd5'] },
  {
    eco: 'D06',
    name: "Queen's Gambit",
    moves: ['d4', 'd5', 'c4'],
  },
  {
    eco: 'D20',
    name: "Queen's Gambit Accepted",
    moves: ['d4', 'd5', 'c4', 'dxc4'],
  },
  {
    eco: 'D30',
    name: "Queen's Gambit Declined",
    moves: ['d4', 'd5', 'c4', 'e6'],
  },
  {
    eco: 'D10',
    name: 'Slav Defense',
    moves: ['d4', 'd5', 'c4', 'c6'],
  },
  { eco: 'A45', name: 'Indian Defense', moves: ['d4', 'Nf6'] },
  {
    eco: 'E60',
    name: "King's Indian Defense",
    moves: ['d4', 'Nf6', 'c4', 'g6'],
  },
  {
    eco: 'E20',
    name: 'Nimzo-Indian Defense',
    moves: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'],
  },
  {
    eco: 'A50',
    name: "Queen's Indian Defense",
    moves: ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'b6'],
  },
  {
    eco: 'D70',
    name: 'Grünfeld Defense',
    moves: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5'],
  },

  // Flank openings
  { eco: 'A04', name: 'Réti Opening', moves: ['Nf3'] },
  { eco: 'A10', name: 'English Opening', moves: ['c4'] },
  { eco: 'A00', name: 'Bird Opening', moves: ['f4'] },
] as const;
