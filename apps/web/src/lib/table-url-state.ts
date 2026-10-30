// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure parse/serialize core for URL-persisted table state (page, search,
// filters, sort). Kept dependency-free so list surfaces (subscribers today;
// segments/campaigns later) can share ONE canonical way to reflect their
// state in the URL — deep-linkable, refresh-safe, and Back-button-safe.
//
// The React hook that binds this to `useSearchParams`/`router.replace` lives
// in `use-table-url-state.ts`; everything here is synchronously testable.

/** A single URL-backed field: how to decode it from a raw string and whether
 *  the current value is the default (so we can OMIT it from the URL for clean,
 *  shareable links). */
export interface FieldSpec<T> {
  readonly default: T;
  /** Decode a raw query value; return `null` to fall back to the default. */
  readonly decode: (raw: string) => T | null;
  /** Encode for the URL. Returning `null` omits the key entirely. */
  readonly encode: (value: T) => string | null;
}

// `any` (not `unknown`) so a concrete `FieldSpec<number>` stays assignable to
// the index signature — `encode`'s parameter is contravariant, and `unknown`
// there would reject every concrete field spec.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Schema = Record<string, FieldSpec<any>>;

export type StateOf<S extends Schema> = {
  [K in keyof S]: S[K] extends FieldSpec<infer T> ? T : never;
};

/** Free-text string field (default ""). Trims and omits empties from the URL. */
export function stringParam(defaultValue = ""): FieldSpec<string> {
  return {
    default: defaultValue,
    decode: (raw) => raw,
    encode: (value) => {
      const trimmed = value.trim();
      return trimmed && trimmed !== defaultValue ? trimmed : null;
    },
  };
}

/** Positive integer field (e.g. page). Clamps to >= min; default omitted. */
export function intParam(defaultValue = 1, min = 1): FieldSpec<number> {
  return {
    default: defaultValue,
    decode: (raw) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      const floored = Math.floor(n);
      return floored < min ? min : floored;
    },
    encode: (value) => (value === defaultValue ? null : String(value)),
  };
}

/** Enumerated field constrained to a fixed set of allowed values. */
export function enumParam<T extends string>(
  values: readonly T[],
  defaultValue: T,
): FieldSpec<T> {
  const allowed = new Set<string>(values);
  return {
    default: defaultValue,
    decode: (raw) => (allowed.has(raw) ? (raw as T) : null),
    encode: (value) => (value === defaultValue ? null : value),
  };
}

/** Decode the full state from a raw query getter (e.g. URLSearchParams.get). */
export function parseParams<S extends Schema>(
  schema: S,
  get: (key: string) => string | null,
): StateOf<S> {
  const out = {} as StateOf<S>;
  for (const key of Object.keys(schema) as (keyof S)[]) {
    const spec = schema[key];
    const raw = get(key as string);
    const decoded = raw === null || raw === "" ? null : spec.decode(raw);
    (out[key] as unknown) = decoded === null ? spec.default : decoded;
  }
  return out;
}

/**
 * Serialize a (possibly partial) state patch merged onto defaults into a
 * `URLSearchParams`. Fields equal to their default are omitted so links stay
 * minimal. Keys are emitted in schema declaration order for stable URLs.
 */
export function serializeParams<S extends Schema>(
  schema: S,
  state: Partial<StateOf<S>>,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of Object.keys(schema) as (keyof S)[]) {
    const spec = schema[key];
    const value = key in state ? state[key] : spec.default;
    const encoded = spec.encode(value as never);
    if (encoded !== null) params.set(key as string, encoded);
  }
  return params;
}

/** Query string (no leading "?") for a state patch, "" when all defaults. */
export function serializeParamsString<S extends Schema>(
  schema: S,
  state: Partial<StateOf<S>>,
): string {
  return serializeParams(schema, state).toString();
}
