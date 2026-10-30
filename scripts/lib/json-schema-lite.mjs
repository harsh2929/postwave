/**
 * A small, dependency-free validator for the JSON Schema subset the
 * release-evidence schema actually uses.
 *
 * Why not ajv: the repo's only ajv is an UNDECLARED transitive dependency at
 * v6, which supports draft-07 and not the draft 2020-12 constructs here
 * (`$defs`, `propertyNames`, `const`). Adding a declared dependency to make one
 * CI guard work is a poor trade when the schema uses a dozen keywords; a
 * validator that fails closed on anything it does not recognise is safer than
 * one that silently ignores a keyword it cannot evaluate.
 *
 * Supported: $ref (local `#/...` only), type, const, enum, required,
 * properties, additionalProperties (boolean), patternProperties, propertyNames,
 * items, minItems, minLength, maxLength, pattern, oneOf.
 *
 * UNSUPPORTED KEYWORDS THROW. That is the point: an unrecognised keyword in the
 * schema means part of the contract is not being enforced, and discovering that
 * at review time beats discovering it after a bad manifest passes.
 */

const SUPPORTED = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "items",
  "minItems",
  "minLength",
  "maxLength",
  "pattern",
  "oneOf",
]);

function resolveRef(root, ref) {
  if (!ref.startsWith("#/")) {
    throw new Error(
      `json-schema-lite: only local $ref is supported, got ${ref}`,
    );
  }
  let node = root;
  for (const rawPart of ref.slice(2).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    node = node?.[part];
    if (node === undefined) {
      throw new Error(`json-schema-lite: unresolvable $ref ${ref}`);
    }
  }
  return node;
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  if (type === "integer") return actual === "integer";
  return actual === type;
}

/**
 * @returns {string[]} human-readable errors, empty when valid.
 */
export function validate(schema, value, { root = schema, path = "$" } = {}) {
  const errors = [];

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) {
      throw new Error(
        `json-schema-lite: unsupported keyword "${keyword}" at ${path}. The ` +
          `validator refuses to run rather than silently skip a constraint.`,
      );
    }
  }

  if (schema.$ref) {
    return validate(resolveRef(root, schema.$ref), value, { root, path });
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(
        `${path}: expected ${types.join(" | ")}, got ${typeOf(value)}`,
      );
      return errors; // further checks would be noise
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(
      `${path}: ${JSON.stringify(value)} is not one of ${schema.enum
        .map((v) => JSON.stringify(v))
        .join(", ")}`,
    );
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
    if (
      schema.pattern !== undefined &&
      !new RegExp(schema.pattern, "u").test(value)
    ) {
      errors.push(
        `${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`,
      );
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: needs at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(
          ...validate(schema.items, item, { root, path: `${path}[${i}]` }),
        );
      });
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    for (const req of schema.required ?? []) {
      if (!keys.includes(req))
        errors.push(`${path}: missing required key "${req}"`);
    }
    if (schema.propertyNames) {
      for (const key of keys) {
        const keyErrors = validate(schema.propertyNames, key, {
          root,
          path: `${path} key "${key}"`,
        });
        if (keyErrors.length > 0) {
          errors.push(`${path}: key "${key}" is not an allowed property name`);
        }
      }
    }
    const patternEntries = Object.entries(schema.patternProperties ?? {});
    for (const key of keys) {
      const child = `${path}.${key}`;
      const propSchema = schema.properties?.[key];
      let handled = false;
      if (propSchema) {
        errors.push(...validate(propSchema, value[key], { root, path: child }));
        handled = true;
      }
      for (const [pattern, sub] of patternEntries) {
        if (new RegExp(pattern, "u").test(key)) {
          errors.push(...validate(sub, value[key], { root, path: child }));
          handled = true;
        }
      }
      if (!handled && schema.additionalProperties === false) {
        errors.push(
          `${path}: unknown property "${key}" (the schema is closed, so this is ` +
            `a typo or an unreviewed field, not an extension)`,
        );
      }
    }
  }

  if (schema.oneOf) {
    const branchErrors = schema.oneOf.map((branch) =>
      validate(branch, value, { root, path }),
    );
    const passing = branchErrors.filter((e) => e.length === 0).length;
    if (passing === 0) {
      errors.push(
        `${path}: matches none of the ${schema.oneOf.length} allowed shapes ` +
          `(${branchErrors.map((e) => e[0] ?? "?").join(" | ")})`,
      );
    } else if (passing > 1) {
      errors.push(`${path}: ambiguously matches ${passing} allowed shapes`);
    }
  }

  return errors;
}
