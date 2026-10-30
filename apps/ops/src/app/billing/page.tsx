// SPDX-License-Identifier: AGPL-3.0-only
//
// Billing: per-tenant billing health — dunning (failed payment) first, then
// highest quota usage. The two things that make an operator act: a tenant whose
// card is failing, and a tenant about to blow through its send cap. Fail-loud.
import { fetchBilling, usageColor } from "@/lib/billing";
import Badge from "@/components/Badge";

export const dynamic = "force-dynamic";

const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
const num = (n: number) => n.toLocaleString();

export default async function BillingPage() {
  const result = await fetchBilling();

  if (!result.ok) {
    return (
      <main id="main-content" tabIndex={-1} className="fail" role="alert">
        <h1 className="fail__title">BILLING UNAVAILABLE</h1>
        <p className="fail__msg">{result.message}</p>
        <p className="fail__note">Assume a payment is failing until it loads.</p>
      </main>
    );
  }

  const dunningCount = result.rows.filter((t) => t.dunning).length;

  return (
    <main id="main-content" tabIndex={-1} className="page">
      <header className="page__head">
        <h1 className="page__title">
          Billing <span className="page__count">({result.rows.length})</span>
        </h1>
      </header>
      <p className="page__lead">
        Dunning first, then quota usage. {dunningCount > 0 ? (
          <span style={{ color: "var(--red-ink)" }}>{dunningCount} tenant{dunningCount === 1 ? "" : "s"} with a failing payment.</span>
        ) : (
          <span style={{ color: "var(--green-ink)" }}>No failing payments.</span>
        )}
      </p>
      {result.truncated ? <p role="status" className="note note--warn">The 500-row cap was reached; lower-ranked tenants are not shown.</p> : null}
      {result.rows.length === 0 ? (
        <p role="status" className="note note--warn">No tenants were returned. Verify this before treating billing as clear.</p>
      ) : (
        <div className="scroll-x panel"><table style={{ minWidth: "54rem", fontSize: "0.9rem" }}>
          <caption>Tenant payment state and current-month sending quota usage.</caption>
          <thead>
            <tr>
              <th scope="col">Tenant</th><th scope="col">Tier</th><th scope="col">Payment</th><th scope="col">Sends (month)</th><th scope="col">Cap</th><th scope="col">Usage</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((t) => (
              <tr key={t.tenant_id}>
                <th scope="row" style={{ textAlign: "left" }}>{t.name}<span className="check__id"> · {t.slug}</span></th>
                <td><span className="badge badge--muted">{t.tier || "—"}</span></td>
                <td>
                  <Badge variant={t.dunning ? "red" : "green"}>{t.dunning ? "DUNNING" : "ok"}</Badge>
                </td>
                <td>{num(t.monthly_sends_used)}</td>
                <td style={{ color: "var(--text-4)" }}>{num(t.monthly_sends_cap)}</td>
                <td style={{ color: usageColor(t.usage_fraction, t.dunning), fontWeight: 600 }}>
                  {pct(t.usage_fraction)}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </main>
  );
}
