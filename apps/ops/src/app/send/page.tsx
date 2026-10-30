// SPDX-License-Identifier: AGPL-3.0-only
//
// Send & Delivery: cross-tenant send backlog + the outbox dead-letter queue.
// Each panel fails loud independently — one view being down must not blank the
// other, and a down view must never render as an empty (all-clear) table.
import { fetchQueueDepth, fetchDeadLetters } from "@/lib/send";

export const dynamic = "force-dynamic";

function PanelError({ title, message }: { title: string; message: string }) {
  return (
    <section role="alert" className="fail fail--panel">
      <h2 className="fail__title">{title} — UNAVAILABLE</h2>
      <p className="fail__msg">{message}. Assume something is wrong until it loads.</p>
    </section>
  );
}

export default async function SendPage() {
  const [depth, dead] = await Promise.all([fetchQueueDepth(), fetchDeadLetters()]);

  return (
    <main id="main-content" tabIndex={-1} className="page">
      <header className="page__head">
        <h1 className="page__title">Send &amp; delivery</h1>
      </header>

      {depth.ok ? (
        <section style={{ margin: "1.5rem 0" }}>
          <h2>Queue depth by tenant <span className="page__count">({depth.rows.length})</span></h2>
          {depth.truncated ? <p role="status" className="note note--warn">The 500-row cap was reached; lower-ranked tenant backlogs are not shown.</p> : null}
          {depth.rows.length === 0 ? (
            <p role="status" className="note note--ok">No tenant has a send backlog.</p>
          ) : (
            <div className="scroll-x panel"><table style={{ minWidth: "40rem", fontSize: "0.9rem" }}>
              <caption>Pending and failed recipients grouped by tenant.</caption>
              <thead>
                <tr>
                  <th scope="col">Tenant</th><th scope="col">Slug</th><th scope="col">Pending</th><th scope="col">Failed</th>
                </tr>
              </thead>
              <tbody>
                {depth.rows.map((r) => (
                  <tr key={r.tenant_id}>
                    <th scope="row" style={{ textAlign: "left" }}>{r.name}</th>
                    <td><span className="check__id">{r.slug}</span></td>
                    <td style={{ color: r.pending > 0 ? "var(--amber-ink)" : "var(--text-2)" }}>{r.pending}</td>
                    <td style={{ color: r.failed > 0 ? "var(--red-ink)" : "var(--text-2)" }}>{r.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </section>
      ) : (
        <PanelError title="Queue depth" message={depth.message} />
      )}

      {dead.ok ? (
        <section style={{ margin: "1.5rem 0" }}>
          <h2>Outbox dead-letter queue <span className="page__count">({dead.rows.length})</span></h2>
          {dead.truncated ? <p role="status" className="note note--warn">The 500-row cap was reached; newer dead-letter groups may not be shown because this view is oldest-first.</p> : null}
          {dead.rows.length === 0 ? (
            <p role="status" className="note note--ok">The outbox has no dead-lettered events.</p>
          ) : (
            <div className="scroll-x panel"><table style={{ minWidth: "40rem", fontSize: "0.9rem" }}>
              <caption>Dead-lettered outbox groups, oldest first.</caption>
              <thead>
                <tr>
                  <th scope="col">Tenant</th><th scope="col">Kind</th><th scope="col">Dead</th><th scope="col">Oldest</th>
                </tr>
              </thead>
              <tbody>
                {dead.rows.map((r) => (
                  <tr key={`${r.tenant_id}-${r.kind}`}>
                    <th scope="row" style={{ textAlign: "left" }}><span className="check__id">{r.slug}</span></th>
                    <td>{r.kind}</td>
                    <td style={{ color: "var(--red-ink)" }}>{r.dead_count}</td>
                    <td style={{ color: "var(--text-3)" }}><time dateTime={r.oldest_dead_at}>{new Date(r.oldest_dead_at).toISOString().slice(0, 16).replace("T", " ")} UTC</time></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </section>
      ) : (
        <PanelError title="Dead-letter queue" message={dead.message} />
      )}
    </main>
  );
}
