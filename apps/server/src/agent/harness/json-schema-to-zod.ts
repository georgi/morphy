import { z, type ZodTypeAny } from 'zod';
import type { TObject } from '@sinclair/typebox';

/**
 * Bridge a TypeBox object schema (= JSON Schema) into the `ZodRawShape` the Claude
 * SDK's `tool()` helper wants. Covers exactly the subset the chess tools use:
 * `object`, `string`, `number`/`integer`, `boolean`, `array` (with `items`),
 * `enum`, optionality (a key absent from `required` becomes `.optional()`), and
 * `description` (mapped to `.describe()`). Anything outside that subset throws, so
 * a new tool construct surfaces loudly instead of silently dropping validation.
 *
 * @param schema A TypeBox `TObject` (what every tool's `parameters` is).
 * @returns A flat record of property name -> Zod type, ready for `tool()`.
 */
export function typeBoxObjectToZodShape(
  schema: TObject,
): Record<string, ZodTypeAny> {
  if (!schema || schema.type !== 'object') {
    throw new Error(
      `typeBoxObjectToZodShape expects an object schema, got ${schema?.type ?? 'undefined'}`,
    );
  }
  const required = new Set(schema.required ?? []);
  const properties = schema.properties ?? {};
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(properties)) {
    let zod = jsonSchemaToZod(prop as JsonSchemaNode);
    if (!required.has(key)) zod = zod.optional();
    shape[key] = zod;
  }
  return shape;
}

/** The slim JSON-Schema node shape this converter walks. */
interface JsonSchemaNode {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
}

/** Convert a single JSON-Schema node to a Zod type, applying its description. */
function jsonSchemaToZod(node: JsonSchemaNode): ZodTypeAny {
  const base = baseType(node);
  return node.description ? base.describe(node.description) : base;
}

/** Map a node's `type`/`enum` to the corresponding Zod constructor. */
function baseType(node: JsonSchemaNode): ZodTypeAny {
  if (node.enum) {
    if (node.enum.length === 0) {
      throw new Error('Unsupported JSON Schema: empty enum');
    }
    return z.enum(node.enum.map(String) as [string, ...string[]]);
  }
  switch (node.type) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array': {
      if (!node.items) {
        throw new Error('Unsupported JSON Schema: array without items');
      }
      return z.array(jsonSchemaToZod(node.items));
    }
    case 'object': {
      const required = new Set(node.required ?? []);
      const properties = node.properties ?? {};
      const shape: Record<string, ZodTypeAny> = {};
      for (const [key, prop] of Object.entries(properties)) {
        let zod = jsonSchemaToZod(prop);
        if (!required.has(key)) zod = zod.optional();
        shape[key] = zod;
      }
      return z.object(shape);
    }
    default:
      throw new Error(
        `Unsupported JSON Schema construct: ${JSON.stringify(node)}`,
      );
  }
}
