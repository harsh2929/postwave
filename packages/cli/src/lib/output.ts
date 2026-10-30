// SPDX-License-Identifier: MIT

export type OutputFormat = "json" | "table" | "yaml";

export function formatOutput(data: unknown, format: OutputFormat = "json"): string {
  switch (format) {
    case "json":
      return JSON.stringify(data, null, 2);
    case "yaml":
      return toYaml(data);
    case "table":
      return toTable(data);
  }
}

function toYaml(data: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (data === null || data === undefined) return `${pad}null`;
  if (typeof data === "string") return `${pad}${quoteIfNeeded(data)}`;
  if (typeof data === "number" || typeof data === "boolean") return `${pad}${String(data)}`;
  if (Array.isArray(data)) {
    if (data.length === 0) return `${pad}[]`;
    return data
      .map((item) => `${pad}- ${toYamlInline(item, indent + 1)}`)
      .join("\n");
  }
  if (typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return `${pad}{}`;
    return entries
      .map(([k, v]) => {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        }
        if (Array.isArray(v) && v.length > 0) {
          return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        }
        return `${pad}${k}: ${toYamlInline(v, indent + 1)}`;
      })
      .join("\n");
  }
  return `${pad}${String(data)}`;
}

function toYamlInline(data: unknown, indent: number): string {
  if (data === null || data === undefined) return "null";
  if (typeof data === "string") return quoteIfNeeded(data);
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  if (Array.isArray(data) && data.length === 0) return "[]";
  if (typeof data === "object" && Object.keys(data as object).length === 0) return "{}";
  return `\n${toYaml(data, indent)}`;
}

function quoteIfNeeded(s: string): string {
  if (/^[\w\-./@]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function toTable(data: unknown): string {
  if (!Array.isArray(data)) return formatOutput(data, "json");
  if (data.length === 0) return "(no rows)";
  const rows = data as Record<string, unknown>[];
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => stringify(r[c]).length)),
  );
  const header = cols.map((c, i) => c.padEnd(widths[i] ?? c.length)).join("  ");
  const sep = cols.map((_, i) => "-".repeat(widths[i] ?? 1)).join("  ");
  const body = rows
    .map((r) =>
      cols.map((c, i) => stringify(r[c]).padEnd(widths[i] ?? 1)).join("  "),
    )
    .join("\n");
  return `${header}\n${sep}\n${body}`;
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
