// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";

import DeclareIncidentForm from "@/components/DeclareIncidentForm";
import IncidentActions from "@/components/IncidentActions";
import { fetchIncidents } from "@/lib/incidents";
import Badge, { type BadgeVariant } from "@/components/Badge";

const SEVERITY_VARIANT: Record<string, BadgeVariant> = { sev1: "red", sev2: "amber", sev3: "info" };
const STATUS_VARIANT: Record<string, BadgeVariant> = { open: "red", monitoring: "amber", resolved: "green" };

export const dynamic = "force-dynamic";

interface IncidentsPageProps {
  searchParams?: Promise<{ resolved?: string | string[] }>;
}

const when = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ");

export default async function IncidentsPage({ searchParams }: IncidentsPageProps) {
  const params = searchParams ? await searchParams : {};
  const raw = Array.isArray(params.resolved) ? params.resolved[0] : params.resolved;
  const includeResolved = raw === "1";
  const result = await fetchIncidents(includeResolved);

  if (!result.ok) {
    return (
      <main id="main-content" tabIndex={-1} className="fail" role="alert">
        <h1 className="fail__title">INCIDENTS UNAVAILABLE</h1>
        <p className="fail__msg">{result.message}</p>
        <p className="fail__note">Unknown is not quiet. Assume an incident is live until it loads.</p>
      </main>
    );
  }

  const openCount = result.rows.filter((incident) => incident.status !== "resolved").length;

  return (
    <main id="main-content" tabIndex={-1} className="page">
      <header className="page__head">
        <h1 className="page__title">
          Incidents <span className="page__count">({result.rows.length})</span>
        </h1>
        <span style={{ color: openCount > 0 ? "var(--red-ink)" : "var(--green-ink)", fontSize: "0.85rem" }}>
          {openCount > 0 ? `${openCount} unresolved` : "nothing unresolved"}
        </span>
        <div className="page__meta">
          <Link href={includeResolved ? "/incidents" : "/incidents?resolved=1"}>
            {includeResolved ? "Hide resolved" : "Show resolved"}
          </Link>
        </div>
      </header>

      <DeclareIncidentForm />

      {result.truncated ? (
        <p role="status" className="note note--warn">
          The 500-incident result cap was reached. Change the resolved filter before assuming an older incident is absent.
        </p>
      ) : null}

      {result.rows.length === 0 ? (
        <p role="status" className="note note--ok">No incidents{includeResolved ? "" : " open"}.</p>
      ) : (
        <div className="scroll-x panel">
          <table style={{ minWidth: "58rem", fontSize: "0.9rem" }}>
            <caption>
              Platform incidents. Open a title to read the bounded, append-only timeline.
            </caption>
            <thead>
              <tr>
                <th scope="col">Severity</th><th scope="col">Title</th><th scope="col">Status</th><th scope="col">Opened</th><th scope="col">By</th><th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((incident) => (
                <tr key={incident.id}>
                  <td><Badge variant={SEVERITY_VARIANT[incident.severity] ?? "neutral"}>{incident.severity.toUpperCase()}</Badge></td>
                  <th scope="row" style={{ textAlign: "left" }}>
                    <Link href={`/incidents/${encodeURIComponent(incident.id)}`}>
                      {incident.title}
                    </Link>
                  </th>
                  <td><Badge variant={STATUS_VARIANT[incident.status] ?? "neutral"}>{incident.status}</Badge></td>
                  <td style={{ color: "var(--text-3)", whiteSpace: "nowrap" }}>
                    <time dateTime={incident.opened_at}>{when(incident.opened_at)} UTC</time>
                  </td>
                  <td style={{ color: "var(--text-4)" }}>{incident.opened_by}</td>
                  <td><IncidentActions incidentId={incident.id} incidentStatus={incident.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
