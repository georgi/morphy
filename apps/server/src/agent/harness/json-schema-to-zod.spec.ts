import { Type } from '@sinclair/typebox';
import { z } from 'zod';

import { typeBoxObjectToZodShape } from './json-schema-to-zod';

/**
 * Unit coverage for the TypeBox -> Zod bridge that lets the Claude adapter feed
 * the chess tools' TypeBox `parameters` into the SDK's `tool()` helper. The
 * schemas built here mirror the constructs the 17 real tools actually use:
 * required `Type.String`/`Type.Number`, `Type.Optional(...)` (which drops the
 * key from `required[]`), `Type.Array(Type.String())`, and a `Type.String` with
 * an `enum` plus a `description`. We assemble the converted shape into a
 * `z.object(...)` and assert through `safeParse`, since that round-trip is
 * exactly how the SDK exercises the validators.
 */
describe('typeBoxObjectToZodShape', () => {
  // A schema that touches every supported construct in one object, shaped like a
  // real analysis tool's params: a required FEN string, a required SAN string,
  // an optional depth number, a required line array of strings, and an enum
  // string with a description.
  const schema = Type.Object({
    fen: Type.String({ description: 'A valid FEN position string.' }),
    san: Type.String({ description: 'The played move in SAN, e.g. "Nf3".' }),
    depth: Type.Optional(
      Type.Number({ description: 'Search depth (default ~18).' }),
    ),
    line: Type.Array(Type.String(), {
      description: 'Candidate moves in SAN order.',
    }),
    mode: Type.String({
      enum: ['fast', 'deep'],
      description: 'Analysis mode.',
    }),
  });

  it('marks keys present in required[] as required', () => {
    const object = z.object(typeBoxObjectToZodShape(schema));
    // Omitting a required key (`fen`) must fail.
    const missing = object.safeParse({
      san: 'Nf3',
      line: ['e4'],
      mode: 'fast',
    });
    expect(missing.success).toBe(false);

    // The same payload with every required key present parses cleanly.
    const complete = object.safeParse({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      san: 'Nf3',
      line: ['e4'],
      mode: 'fast',
    });
    expect(complete.success).toBe(true);
  });

  it('treats keys absent from required[] as optional', () => {
    const object = z.object(typeBoxObjectToZodShape(schema));
    // `depth` is wrapped in Type.Optional, so omitting it is valid.
    const result = object.safeParse({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      san: 'Nf3',
      line: ['e4'],
      mode: 'fast',
    });
    expect(result.success).toBe(true);

    // And supplying it with the right type still parses.
    const withDepth = object.safeParse({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      san: 'Nf3',
      line: ['e4'],
      mode: 'fast',
      depth: 22,
    });
    expect(withDepth.success).toBe(true);
  });

  it('validates array element types', () => {
    const object = z.object(typeBoxObjectToZodShape(schema));
    const base = {
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      san: 'Nf3',
      mode: 'fast',
    };
    // A string array passes element validation.
    expect(object.safeParse({ ...base, line: ['e4', 'e5'] }).success).toBe(true);
    // A number in the array fails the element type.
    expect(object.safeParse({ ...base, line: ['e4', 7] }).success).toBe(false);
  });

  it('restricts an enum string to its members', () => {
    const object = z.object(typeBoxObjectToZodShape(schema));
    const base = {
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      san: 'Nf3',
      line: ['e4'],
    };
    expect(object.safeParse({ ...base, mode: 'deep' }).success).toBe(true);
    expect(object.safeParse({ ...base, mode: 'sideways' }).success).toBe(false);
  });

  it('carries descriptions onto the Zod types', () => {
    const shape = typeBoxObjectToZodShape(schema);
    expect(shape.fen.description).toBe('A valid FEN position string.');
    expect(shape.line.description).toBe('Candidate moves in SAN order.');
    expect(shape.mode.description).toBe('Analysis mode.');
    // An optional field describes its inner type before the `.optional()` wrap,
    // so the description lives one level down (reachable via `.unwrap()`).
    expect((shape.depth as z.ZodOptional<z.ZodNumber>).unwrap().description).toBe(
      'Search depth (default ~18).',
    );
  });

  it('converts a boolean property', () => {
    const shape = typeBoxObjectToZodShape(
      Type.Object({ flag: Type.Boolean() }),
    );
    const object = z.object(shape);
    expect(object.safeParse({ flag: true }).success).toBe(true);
    expect(object.safeParse({ flag: 'yes' }).success).toBe(false);
  });

  it('throws when the root is not an object schema', () => {
    expect(() =>
      typeBoxObjectToZodShape(Type.String() as never),
    ).toThrow(/object schema/);
  });

  it('throws on an unsupported property construct', () => {
    // `null` is outside the supported subset; the converter must surface it
    // loudly rather than silently dropping validation.
    expect(() =>
      typeBoxObjectToZodShape(Type.Object({ nope: Type.Null() })),
    ).toThrow(/Unsupported JSON Schema/);
  });
});
