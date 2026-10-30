/**
 * subscriberAccount — SUB-012 B2B account link ("which company does this
 * contact belong to"), phone-sized.
 *
 * Desktop's AccountSection translated: the canonical many-to-one
 * subscribers.account_id FK, settable to another account, clearable, or a
 * new account created inline (name + industry) and linked in one go. The
 * PATCH is conditional on the subscriber revision on screen.
 *
 * Import-free so every rule runs in the node vitest suite.
 */

export interface AccountRow {
  id: string;
  name: string;
  industry: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The GET /accounts {items} page, defensively. */
export function parseAccounts(payload: unknown): AccountRow[] {
  const rec =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  if (!Array.isArray(rec.items)) return [];
  return rec.items.flatMap((row): AccountRow[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const id = str(r.id);
    const name = str(r.name);
    if (!id || !name) return [];
    return [{ id, name, industry: str(r.industry) }];
  });
}

/** The linked account's display line, or null when unlinked/unknown. */
export function linkedAccountLine(
  accounts: readonly AccountRow[],
  accountId: string | null | undefined,
): string | null {
  if (!accountId) return null;
  const account = accounts.find((row) => row.id === accountId);
  if (!account) return `Linked to account ${accountId}`;
  return account.industry
    ? `${account.name} · ${account.industry}`
    : account.name;
}

/** Why the inline create cannot run, or null. */
export function createAccountProblem(name: string): string | null {
  if (!name.trim()) return "Enter the company's name first.";
  return null;
}

/** POST /accounts body. */
export function buildCreateAccountBody(
  name: string,
  industry: string,
): Record<string, string> {
  const body: Record<string, string> = { name: name.trim() };
  const ind = industry.trim();
  if (ind) body.industry = ind;
  return body;
}
