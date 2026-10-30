/**
 * AccountSection — SUB-012 B2B account / company link for the subscriber
 * slideover Profile tab.
 *
 * Shows the contact's currently linked first-class account (the canonical
 * many-to-one subscribers.account_id FK), and lets the operator:
 *   - pick a different existing account from a dropdown, or unlink;
 *   - create a new account inline (name + industry) and link it in one go.
 *
 * Reads GET /api/v1/accounts for the picker and writes via PATCH
 * /api/v1/subscribers/{id}/account. On 404 (routes not deployed) the
 * whole section hides via onUnavailable, matching the slideover's
 * graceful-degradation convention. The returned SubscriberDetail is
 * handed back through onLinked so the parent can reconcile its row.
 */

import {
  type ReactElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { type Account, type SubscriberDetail, api } from "../../lib/api-client";
import { redact } from "../../lib/auth";
import { FormField } from "../FormField";
import { toast } from "../Toast";

interface Props {
  /** Subscriber UUID or email (the endpoint accepts both). */
  subscriberId: string;
  /** Current canonical link from the loaded subscriber detail. */
  accountId: string | null | undefined;
  /** Exact subscriber revision that the link decision was reviewed against. */
  subscriberVersion: string | undefined;
  /** Whether the session may mutate (write scope). */
  canMutate: boolean;
  /** Fired after a successful link/unlink with the updated detail. */
  onLinked?: (updated: SubscriberDetail) => void;
  /** Fired when the accounts routes are not deployed (404). */
  onUnavailable?: () => void;
}

export function AccountSection({
  subscriberId,
  accountId,
  subscriberVersion,
  canMutate,
  onLinked,
  onUnavailable,
}: Props): ReactElement | null {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const operationRef = useRef(false);
  const permissionReasonId = useId();

  // Inline-create form state.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newIndustry, setNewIndustry] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setErrMsg(null);
    void (async () => {
      try {
        const res = await api.listAccounts({ signal: controller.signal });
        if (controller.signal.aborted) return;
        if (res.error) {
          if (res.error.kind === "http" && res.error.status === 404) {
            onUnavailable?.();
            return;
          }
          setErrMsg("The account directory could not be loaded.");
          return;
        }
        setAccounts(res.data.items ?? []);
      } catch {
        if (!controller.signal.aborted) {
          setErrMsg("The account directory could not be loaded.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadNonce]);

  const linked = useMemo(
    () => accounts.find((a) => a.id === accountId) ?? null,
    [accounts, accountId],
  );

  // Distinct industries already in use, offered as datalist suggestions
  // so inline-create nudges toward a consistent vocabulary.
  const industries = useMemo(() => {
    const set = new Set<string>();
    for (const a of accounts) {
      const v = (a.industry ?? "").trim();
      if (v) set.add(v);
    }
    return [...set].sort();
  }, [accounts]);
  const nameBytes = new TextEncoder().encode(newName.trim()).length;
  const industryBytes = new TextEncoder().encode(newIndustry.trim()).length;
  const nameError =
    nameBytes > 200 ? "Account name must be 200 UTF-8 bytes or fewer." : null;
  const industryError =
    industryBytes > 120 ? "Industry must be 120 UTF-8 bytes or fewer." : null;

  async function link(nextId: string | null): Promise<void> {
    if (!canMutate || operationRef.current) return;
    operationRef.current = true;
    setSaving(true);
    try {
      const res = await api.setSubscriberAccount(
        subscriberId,
        nextId,
        subscriberVersion ?? "",
      );
      if (res.error) {
        toast.error(
          `Couldn't update account link: ${redact(res.error.message)}`,
        );
        return;
      }
      onLinked?.(res.data);
      toast.success(nextId ? "Account linked" : "Account unlinked");
    } catch {
      toast.error("Couldn't update the account link. Try again.");
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  async function createAndLink(): Promise<void> {
    const name = newName.trim();
    if (
      !canMutate ||
      operationRef.current ||
      name === "" ||
      nameError ||
      industryError
    ) {
      return;
    }
    operationRef.current = true;
    setSaving(true);
    try {
      const created = await api.createAccount({
        name,
        industry: newIndustry.trim() || undefined,
      });
      if (created.error) {
        toast.error(
          `Couldn't create account: ${redact(created.error.message)}`,
        );
        return;
      }
      // Optimistically add to the picker so the dropdown reflects it.
      setAccounts((prev) => [...prev, created.data]);
      const res = await api.setSubscriberAccount(
        subscriberId,
        created.data.id,
        subscriberVersion ?? "",
      );
      if (res.error) {
        toast.error(
          `Account created but couldn't link: ${redact(res.error.message)}`,
        );
        return;
      }
      onLinked?.(res.data);
      setCreating(false);
      setNewName("");
      setNewIndustry("");
      toast.success(`Created and linked “${created.data.name}”`);
    } catch {
      toast.error("Couldn't create and link the account. Try again.");
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section>
        <div className="label">Account</div>
        <div className="skel" style={{ height: 40 }} />
      </section>
    );
  }

  return (
    <section>
      <div className="label">Account</div>
      {errMsg ? (
        <div role="alert" style={{ fontSize: 12 }}>
          <span className="muted">{errMsg}</span>
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setReloadNonce((current) => current + 1)}
            >
              Retry account directory
            </button>
          </div>
        </div>
      ) : (
        <>
          {linked ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
                fontSize: 13,
              }}
            >
              <span style={{ fontWeight: 600 }}>{linked.name}</span>
              {(linked.industry ?? "").trim() ? (
                <span className="badge" style={{ fontSize: 11 }}>
                  {linked.industry}
                </span>
              ) : null}
            </div>
          ) : accountId ? (
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              This profile references an account that is no longer visible in
              the account directory.
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              Not linked to any account.
            </div>
          )}

          {!creating ? (
            <>
              <div style={{ display: "flex", gap: 6 }}>
                <select
                  className="input"
                  value={accountId ?? ""}
                  disabled={!canMutate || saving}
                  onChange={(ev) => void link(ev.target.value || null)}
                  aria-label="Linked account"
                  style={{ flex: 1 }}
                >
                  <option value="">— No account —</option>
                  {accountId && !linked ? (
                    <option value={accountId} disabled>
                      Linked account unavailable
                    </option>
                  ) : null}
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {(a.industry ?? "").trim() ? ` · ${a.industry}` : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn"
                  disabled={saving}
                  aria-disabled={!canMutate || undefined}
                  aria-describedby={!canMutate ? permissionReasonId : undefined}
                  onClick={() => {
                    if (canMutate) setCreating(true);
                  }}
                >
                  New
                </button>
              </div>
              {!canMutate ? (
                <p
                  id={permissionReasonId}
                  className="muted"
                  role="status"
                  style={{ fontSize: 11, margin: "6px 0 0" }}
                >
                  Viewer access can inspect account links but cannot change them
                  or create accounts.
                </p>
              ) : null}
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <FormField label="Account name" error={nameError}>
                <input
                  className="input"
                  value={newName}
                  disabled={saving}
                  onChange={(ev) => setNewName(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") void createAndLink();
                  }}
                  placeholder="Acme Inc."
                  aria-label="New account name"
                  maxLength={200}
                />
              </FormField>
              <FormField label="Industry" error={industryError}>
                <input
                  className="input"
                  value={newIndustry}
                  disabled={saving}
                  list="account-industry-suggestions"
                  onChange={(ev) => setNewIndustry(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") void createAndLink();
                  }}
                  placeholder="e.g. Retail"
                  aria-label="New account industry"
                  maxLength={120}
                />
                <datalist id="account-industry-suggestions">
                  {industries.map((ind) => (
                    <option key={ind} value={ind} />
                  ))}
                </datalist>
              </FormField>
              <div
                style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}
              >
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={saving}
                  onClick={() => {
                    setCreating(false);
                    setNewName("");
                    setNewIndustry("");
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={
                    saving ||
                    newName.trim() === "" ||
                    Boolean(nameError || industryError)
                  }
                  onClick={() => void createAndLink()}
                >
                  {saving ? "Saving…" : "Create & link"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
