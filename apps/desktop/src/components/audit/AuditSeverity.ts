/**
 * AuditSeverity — small helper module that classifies an audit action
 * verb into a severity bucket. Refined Audit PR 1.
 *
 * The bucket drives row coloring + the slideover header + filter chips
 * (e.g. "Destructive only"). The classifier is deliberately string-
 * matching rather than enum-driven so it works for any tenant whose
 * actions follow the canonical `resource.verb` pattern without
 * registering each new action in a central list.
 *
 * Categories:
 *   - destructive  → delete / purge / drop / remove / wipe / unsubscribe
 *                    / suppress / revoke / rotate / disable / archive
 *   - auth         → login / logout / mfa / password / token /
 *                    permission / role / api_key.*
 *   - export       → export / download / sar / dump
 *   - ops          → everything else (create, update, view, send, ...)
 *
 * Why these in particular: those are the verbs an auditor cares about
 * in a SOC 2 / HIPAA review window. Highlighting them visually saves
 * the manual ctrl-F pass.
 */

export type AuditSeverity = "destructive" | "auth" | "export" | "ops";

const DESTRUCTIVE_TOKENS = [
  "delete",
  "purge",
  "drop",
  "remove",
  "wipe",
  "unsubscribe",
  "suppress",
  "revoke",
  "rotate",
  "disable",
  "archive",
  "destroy",
];

const AUTH_TOKENS = [
  "login",
  "logout",
  "signin",
  "signout",
  "mfa",
  "password",
  "token",
  "permission",
  "role",
  "api_key",
  "session",
];

const EXPORT_TOKENS = ["export", "download", "sar", "dump"];

export function classifyAction(action: string): AuditSeverity {
  const a = (action || "").toLowerCase();
  if (!a) return "ops";
  // Order matters: destructive wins over export which wins over auth.
  // An "api_key.rotate" is destructive (it invalidates the prior key),
  // not auth, even though it touches credentials.
  for (const t of DESTRUCTIVE_TOKENS) if (a.includes(t)) return "destructive";
  for (const t of EXPORT_TOKENS) if (a.includes(t)) return "export";
  for (const t of AUTH_TOKENS) if (a.includes(t)) return "auth";
  return "ops";
}

export function severityLabel(s: AuditSeverity): string {
  switch (s) {
    case "destructive":
      return "Destructive";
    case "auth":
      return "Auth";
    case "export":
      return "Export";
    default:
      return "Ops";
  }
}
