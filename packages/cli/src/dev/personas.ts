// SPDX-License-Identifier: MIT

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface Persona {
  name: string;
  email: string;
  custom_fields: Record<string, string | number | boolean | null>;
}

const DEFAULT_PERSONA: Persona = {
  name: "Default",
  email: "preview@postwave.local",
  custom_fields: { first_name: "Friend" },
};

const MAX_PERSONAS_FILE_BYTES = 64 * 1024;
const MAX_PERSONAS = 100;
const MAX_CUSTOM_FIELDS_PER_PERSONA = 100;
const MAX_SCALAR_CHARS = 4_096;

/**
 * Load `postwave.test-personas.yaml` from `cwd` (or the supplied dir).
 * If absent, returns a single default persona. The file schema is:
 *
 *   personas:
 *     - name: VC Marc
 *       email: marc@example.com
 *       custom_fields:
 *         first_name: Marc
 *         tier: premium
 */
export function loadPersonas(cwd: string = process.cwd()): Persona[] {
  const path = resolve(cwd, "postwave.test-personas.yaml");
  if (!existsSync(path)) return [DEFAULT_PERSONA];
  const size = statSync(path).size;
  if (size > MAX_PERSONAS_FILE_BYTES) {
    throw new Error(
      `postwave.test-personas.yaml is too large (${size} bytes, max ${MAX_PERSONAS_FILE_BYTES}).`,
    );
  }
  const raw = readFileSync(path, "utf8");
  const parsed = parsePersonasYaml(raw);
  if (parsed.length === 0) return [DEFAULT_PERSONA];
  return parsed;
}

/**
 * Tiny purpose-built YAML parser for the personas file. Supports the
 * exact schema documented above (no anchors, no flow-style, no nested
 * lists — just two-space indentation with scalar leaves).
 */
export function parsePersonasYaml(src: string): Persona[] {
  const bytes = Buffer.byteLength(src, "utf8");
  if (bytes > MAX_PERSONAS_FILE_BYTES) {
    throw new Error(
      `postwave.test-personas.yaml is too large (${bytes} bytes, max ${MAX_PERSONAS_FILE_BYTES}).`,
    );
  }
  const lines = src
    .split(/\r?\n/)
    .map((l) => stripComment(l))
    .filter((l) => l.trim().length > 0);

  const personas: Persona[] = [];
  let inPersonas = false;
  let current: Persona | null = null;
  let inCustomFields = false;
  let personaIndent = -1;
  let fieldIndent = -1;

  for (const line of lines) {
    const indent = leadingSpaces(line);
    const trimmed = line.trim();

    if (!inPersonas) {
      if (/^personas\s*:\s*$/.test(trimmed)) inPersonas = true;
      continue;
    }

    if (trimmed.startsWith("- ")) {
      if (current) pushPersona(personas, current);
      current = { name: "", email: "", custom_fields: {} };
      inCustomFields = false;
      personaIndent = indent;
      const rest = trimmed.slice(2).trim();
      applyKeyValue(current, rest);
      continue;
    }

    if (!current) continue;

    if (indent <= personaIndent) {
      pushPersona(personas, current);
      current = null;
      inCustomFields = false;
      continue;
    }

    if (/^custom_fields\s*:\s*$/.test(trimmed)) {
      inCustomFields = true;
      fieldIndent = indent;
      continue;
    }

    if (inCustomFields && indent > fieldIndent) {
      const m = trimmed.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
      if (m) {
        if (Object.keys(current.custom_fields).length >= MAX_CUSTOM_FIELDS_PER_PERSONA) {
          throw new Error(
            `persona ${current.email || current.name || "(unnamed)"} has too many custom fields.`,
          );
        }
        current.custom_fields[m[1] as string] = coerceScalar(m[2] ?? "");
      }
      continue;
    }

    inCustomFields = false;
    applyKeyValue(current, trimmed);
  }
  if (current) pushPersona(personas, current);
  return personas.filter((p) => p.email.length > 0);
}

function pushPersona(personas: Persona[], current: Persona): void {
  if (personas.length >= MAX_PERSONAS) {
    throw new Error(`postwave.test-personas.yaml contains more than ${MAX_PERSONAS} personas.`);
  }
  personas.push(current);
}

function applyKeyValue(p: Persona, line: string): void {
  const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
  if (!m) return;
  const key = m[1] as string;
  const val = (m[2] ?? "").trim();
  if (key === "name") p.name = truncateScalar(stripQuotes(val));
  else if (key === "email") p.email = truncateScalar(stripQuotes(val), 320);
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function leadingSpaces(s: string): number {
  let n = 0;
  while (n < s.length && s[n] === " ") n++;
  return n;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function coerceScalar(raw: string): string | number | boolean | null {
  const v = truncateScalar(stripQuotes(raw.trim()));
  if (v === "" || v === "null" || v === "~") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return Number.parseFloat(v);
  return v;
}

function truncateScalar(value: string, maxChars = MAX_SCALAR_CHARS): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars);
}
