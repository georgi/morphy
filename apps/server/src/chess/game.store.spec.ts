import type { Game, MoveEval } from '@chess/shared';
import { GameStore } from './game.store';

function makeGame(id: string): Game {
  return {
    id,
    headers: { white: 'Alice', black: 'Bob' },
    startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moves: [],
  };
}

const sampleAnalysis: MoveEval[] = [
  {
    ply: 1,
    san: 'e4',
    scoreCpBefore: 20,
    scoreCpAfter: 30,
    cpLoss: 0,
    classification: 'best',
    bestMove: 'e2e4',
    bestLine: ['e2e4', 'e7e5'],
  },
];

describe('GameStore', () => {
  let store: GameStore;

  beforeEach(() => {
    store = new GameStore();
  });

  it('creates and retrieves a game', () => {
    const game = makeGame('g1');
    expect(store.create(game)).toBe(game);
    // Reads round-trip through durable JSON, so they are value-equal (not the
    // same reference) to the object passed to create.
    expect(store.get('g1')).toEqual(game);
    expect(store.has('g1')).toBe(true);
  });

  it('returns undefined for a missing game', () => {
    expect(store.get('nope')).toBeUndefined();
    expect(store.has('nope')).toBe(false);
  });

  it('updates an existing game and ignores unknown ids', () => {
    store.create(makeGame('g1'));
    const replacement = makeGame('g1');
    replacement.headers.event = 'World Championship';

    expect(store.update('g1', replacement)).toBe(replacement);
    expect(store.get('g1')?.headers.event).toBe('World Championship');

    expect(store.update('missing', makeGame('missing'))).toBeUndefined();
    expect(store.has('missing')).toBe(false);
  });

  it('attaches analysis to a stored game without mutating the original', () => {
    const game = makeGame('g1');
    store.create(game);

    const updated = store.setAnalysis('g1', sampleAnalysis);
    expect(updated?.analysis).toEqual(sampleAnalysis);
    expect(store.get('g1')?.analysis).toEqual(sampleAnalysis);

    // Original object reference is not mutated (setAnalysis returns a copy).
    expect(game.analysis).toBeUndefined();
  });

  it('returns undefined when setting analysis on a missing game', () => {
    expect(store.setAnalysis('ghost', sampleAnalysis)).toBeUndefined();
  });

  it('lists and deletes games', () => {
    store.create(makeGame('a'));
    store.create(makeGame('b'));
    expect(store.list().map((g) => g.id)).toEqual(['a', 'b']);

    expect(store.delete('a')).toBe(true);
    expect(store.delete('a')).toBe(false);
    expect(store.list().map((g) => g.id)).toEqual(['b']);
  });
});
