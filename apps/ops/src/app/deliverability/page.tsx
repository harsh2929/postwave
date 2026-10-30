// SPDX-License-Identifier: AGPL-3.0-only
//
// Deliverability: per-tenant 7-day complaint/bounce health, worst complaint rate
// first — who is approaching the 0.30% ceiling that gets mail rejected. Fail-loud.

import { fetchDeliverability, rateColor } from "@/lib/deliverability";

export const dynamic = "force-dynamic";

const pct = (r: number) => `${(r * 100).toFixed(3)}%`;

export default async function DeliverabilityPage() {
  const result = await fetchDeliverability();

  if (!result.ok) {
    return (
      <main id="main-content" tabIndex={-1} className="fail" role="alert">
        <h1 className="fail__title">DELIVERABILITY UNAVAILABLE</h1>
        <p className="fail__msg">{result.message}</p>
        <p className="fail__note">
          Assume a tenant is drifting toward the ceiling until it loads.
        </p>
      </main>
    );
  }

  return (
    <main id="main-content" tabIndex={-1} className="page">
      <header className="page__head">
        <h1 className="page__title">
          Deliverability — 7 day{" "}
          <span className="page__count">({result.rows.length})</span>
        </h1>
      </header>
      <p className="page__lead">
        Complaint ceiling 0.30% (mail is rejected above it); harm begins at
        0.10%.
      </p>

      {result.truncated ? (
        <p role="status" className="note note--warn">
          The 500-row cap was reached; lower-ranked tenants are not shown.
        </p>
      ) : null}

      {result.rows.length === 0 ? (
        <p role="status" className="note note--ok">
          No tenant has sent or had a complaint/bounce in the last 7 days.
        </p>
      ) : (
        <div className="scroll-x panel">
          <table style={{ minWidth: "62rem", fontSize: "0.9rem" }}>
            <caption>Seven-day tenant delivery events and rates.</caption>
            <thead>
              <tr>
                <th scope="col">Tenant</th>
                <th scope="col">Sent</th>
                <th scope="col">Complaints</th>
                <th scope="col">Complaint rate</th>
                <th scope="col">Bounces</th>
                <th scope="col">Bounce rate</th>
                <th scope="col">Unsub</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((t) => (
                <tr key={t.tenant_id}>
                  <th scope="row" style={{ textAlign: "left" }}>
                    {t.name}
                    <span className="check__id"> · {t.slug}</span>
                  </th>
                  <td>{t.sent_7d}</td>
                  <td>{t.complained_7d}</td>
                  <td style={{ color: rateColor(t.complaint_rate), fontWeight: 600 }}>
                    {pct(t.complaint_rate)}
                  </td>
                  <td>{t.bounced_7d}</td>
                  <td style={{ color: rateColor(t.bounce_rate) }}>
                    {pct(t.bounce_rate)}
                  </td>
                  <td style={{ color: "var(--text-3)" }}>{t.unsubscribed_7d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
