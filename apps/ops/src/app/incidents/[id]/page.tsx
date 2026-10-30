// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";

import IncidentActions from "@/components/IncidentActions";
import {
  fetchIncidentTimeline,
  severityColor,
  statusColor,
} from "@/lib/incidents";

export const dynamic = "force-dynamic";

interface IncidentDetailPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ before?: string | string[] }>;
}

const when = (iso: string) => new Date(iso).toISOString().slice(0, 19).replace("T", " ");

export default async function IncidentDetailPage({ params, searchParams }: IncidentDetailPageProps) {
  const { id } = await params;
  const query = await searchParams;
  // Duplicate cursor parameters are invalid. Passing an intentionally invalid
  // value through the same client validator keeps the page fail-loud without
  // silently choosing one of the supplied cursors.
  const before = Array.isArray(query.before) ? "duplicate-cursor" : query.before;
  const result = await fetchIncidentTimeline(id, before);
  if (!result.ok) {
    return (
      <main id="main-content" tabIndex={-1} className="fail" role="alert">
        <h1 className="fail__title">
          {result.status === 404 ? "INCIDENT NOT FOUND" : "TIMELINE UNAVAILABLE"}
        </h1>
        <p className="fail__msg">{result.message}</p>
        <p className="fail__note">
          <Link href="/incidents">Back to incidents</Link>
        </p>
      </main>
    );
  }

  const incident = result.incident;
  return (
    <main id="main-content" tabIndex={-1} className="page">
      <p>
        <Link href="/incidents">← All incidents</Link>
      </p>

      <header className="page__head">
        <span style={{ color: severityColor(incident.severity), fontWeight: 800 }}>
          {incident.severity.toUpperCase()}
        </span>
        <h1 className="page__title">{incident.title}</h1>
        <span style={{ color: statusColor(incident.status), fontWeight: 700 }}>
          {incident.status}
        </span>
      </header>

      <section className="panel" style={{ padding: "1.1rem 1.3rem", marginBottom: "1.5rem" }}>
        <dl className="dl">
          <dt>Opened by</dt>
          <dd>{incident.opened_by}</dd>
          <dt>Opened at</dt>
          <dd>
            <time dateTime={incident.opened_at}>{when(incident.opened_at)} UTC</time>
          </dd>
          {incident.resolved_at ? (
            <>
              <dt>Resolved at</dt>
              <dd>
                <time dateTime={incident.resolved_at}>{when(incident.resolved_at)} UTC</time>
              </dd>
            </>
          ) : null}
        </dl>
        <div style={{ marginTop: "1rem" }}>
          <IncidentActions incidentId={incident.id} incidentStatus={incident.status} />
        </div>
      </section>

      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">
          Timeline page <span className="page__count">({incident.updates.length})</span>
        </h2>
        {incident.updates_truncated ? (
          <p role="status" className="note note--warn">
            Showing {incident.updates.length} entries in chronological order for this bounded page.{" "}
            <Link
              href={`/incidents/${encodeURIComponent(incident.id)}?${new URLSearchParams({ before: incident.next_before! }).toString()}`}
            >
              View older entries
            </Link>
            .
          </p>
        ) : null}
        {before !== undefined ? (
          <p>
            <Link href={`/incidents/${encodeURIComponent(incident.id)}`}>
              Back to newest entries
            </Link>
          </p>
        ) : null}
        <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {incident.updates.map((update) => (
            <li key={update.id} style={{ borderTop: "1px solid var(--border)", padding: "1rem 0" }}>
              <div style={{ display: "flex", gap: "0.6rem", alignItems: "baseline", flexWrap: "wrap" }}>
                <strong>{update.author}</strong>
                <time dateTime={update.created_at} style={{ color: "var(--text-4)", fontSize: "0.85rem" }}>
                  {when(update.created_at)} UTC
                </time>
                {update.requested_status ? (
                  <span style={{ color: statusColor(update.requested_status), fontSize: "0.8rem", fontWeight: 700 }}>
                    status → {update.requested_status}
                  </span>
                ) : null}
              </div>
              <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--text-2)" }}>{update.body}</p>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
