// SPDX-License-Identifier: AGPL-3.0-only
//
// The `postwave_app` role is defined twice:
//
//   infra/postgres/init.sql          local dev, via docker-entrypoint-initdb.d
//   .github/workflows/test.yml       CI, inlined with the comment
//                                    "Mirrors infra/postgres/init.sql verbatim"
//
// A comment is not a check. They agree today; nothing keeps them agreeing.
//
// WHY THIS ROLE AND NOT ANY OTHER. Every RLS isolation test in this repo is only
// meaningful because it connects as an UNPRIVILEGED role. A superuser — or any
// role with BYPASSRLS — passes tenant-isolation assertions while proving
// nothing, because the policies never run. The attributes below are what make
// `postwave_app` unprivileged, so if CI's copy drifted to a more permissive
// definition, the isolation suite would go green against a role that is not the
// one production uses, and the failure would look like success.
//
// Deliberately compared as an attribute SET, not as text: formatting,
// indentation and the extra statements each file legitimately carries (init.sql
// also provisions listmonk_user) are not drift. The privilege posture is.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(process.cwd(), "../..");
const INIT_SQL = resolve(REPO, "infra/postgres/init.sql");
const CI_WORKFLOW = resolve(REPO, ".github/workflows/test.yml");

/** Attribute keywords Postgres accepts on CREATE ROLE that affect privilege. */
const PRIVILEGE_KEYWORDS = [
  "LOGIN", "NOLOGIN",
  "SUPERUSER", "NOSUPERUSER",
  "CREATEDB", "NOCREATEDB",
  "CREATEROLE", "NOCREATEROLE",
  "INHERIT", "NOINHERIT",
  "REPLICATION", "NOREPLICATION",
  "BYPASSRLS", "NOBYPASSRLS",
];

/**
 * The privilege attributes and password of the `postwave_app` CREATE ROLE
 * statement in a file, or null when there isn't one.
 */
function roleDefinition(
  path: string,
): { attributes: string[]; password: string | null } | null {
  const text = readFileSync(path, "utf8");
  // Up to the terminating semicolon — both files write one statement.
  const stmt = /CREATE\s+ROLE\s+postwave_app\s+WITH([\s\S]*?);/i.exec(text);
  if (!stmt?.[1]) return null;
  const body = stmt[1];
  const attributes = PRIVILEGE_KEYWORDS.filter((kw) =>
    // \b on both sides so NOSUPERUSER does not also match SUPERUSER.
    new RegExp(`\\b${kw}\\b`, "i").test(body),
  ).sort();
  const password = /PASSWORD\s+'([^']*)'/i.exec(body)?.[1] ?? null;
  return { attributes, password };
}

describe("the postwave_app role is defined identically in dev and CI", () => {
  const dev = roleDefinition(INIT_SQL);
  const ci = roleDefinition(CI_WORKFLOW);

  it("finds the role in both places", () => {
    // Guard the guard: a renamed file or a reworded statement would leave one
    // side null, and two nulls would compare equal.
    expect(dev, `no CREATE ROLE postwave_app in ${INIT_SQL}`).not.toBeNull();
    expect(ci, `no CREATE ROLE postwave_app in ${CI_WORKFLOW}`).not.toBeNull();
    expect(dev!.attributes.length).toBeGreaterThan(3);
  });

  it("grants the same privilege attributes", () => {
    expect(ci!.attributes).toEqual(dev!.attributes);
  });

  it("uses the same password, so one DATABASE_URL works against both", () => {
    expect(ci!.password).toBe(dev!.password);
  });

  it("keeps the role unprivileged, which is what makes RLS tests mean anything", () => {
    // Stated positively rather than left implicit in the equality above: if
    // BOTH copies gained SUPERUSER together, the parity assertions would still
    // pass while every isolation test silently stopped proving anything.
    for (const def of [dev!, ci!]) {
      expect(def.attributes).toContain("NOSUPERUSER");
      expect(def.attributes).toContain("NOCREATEROLE");
      expect(def.attributes).not.toContain("SUPERUSER");
      expect(def.attributes).not.toContain("BYPASSRLS");
      expect(def.attributes).not.toContain("REPLICATION");
    }
  });

  it("still grants CONNECT in both", () => {
    // The role is useless without it, and a silent removal would surface as a
    // confusing auth failure rather than a clear one.
    for (const path of [INIT_SQL, CI_WORKFLOW]) {
      expect(
        /GRANT\s+CONNECT\s+ON\s+DATABASE\s+postwave\s+TO\s+postwave_app/i.test(
          readFileSync(path, "utf8"),
        ),
        `${path} no longer grants CONNECT to postwave_app`,
      ).toBe(true);
    }
  });
});
