// SPDX-License-Identifier: AGPL-3.0-only
//
// Campaign Assurance runs. The API view and its content-free support functions
// (migration 1938) have been mounted since they shipped with nothing reading
// them; this is the reader.
//
// Ordered worst-first, because the reason to open this page is that something
// is wrong. A blocked run is deliberately NOT sorted next to a failed one:
// blocked means assurance worked and refused a send, which is the campaign
// owner's problem, while failed means the run itself broke, which is ours.

import {
  fetchAssuranceRuns,
  healthColor,
  runHealth,
  type AssuranceRunRow,
  type RunHealth,
} from "@/lib/campaignAssurance";

export const dynamic = "force-dynamic";

// Worst first. `complete` last: a finished, allowed run needs no operator.
const HEALTH_ORDER: Record<RunHealth, number> = {
  failed: 0,
  incomplete: 1,
  "at-cost-ceiling": 2,
  blocked: 3,
  running: 4,
  complete: 5,
};

const HEALTH_MEANING: Record<RunHealth, string> = {
  failed: "the run itself broke — platform problem",
  incomplete: "required evidence was unavailable — NOT a pass",
  "at-cost-ceiling": "stopped on its frozen cost ceiling, not on a verdict",
  blocked: "assurance refused the send — campaign problem, not ours",
  running: "in flight",
  complete: "finished and allowed to send",
};

/** Micro-USD to a readable figure. The ledger stores micro-units exactly. */
function usd(microunits: number): string {
  return `$${(microunits / 1_000_000).toFixed(4)}`;
}

function shortID(id: string): string {
  return id.slice(0, 8);
}

function progress(row: AssuranceRunRow): string {
  return `${row.terminal_extraction_count}/${row.required_extraction_count}`;
}

export default async function CampaignAssurancePage() {
  const result = await fetchAssuranceRuns();

  if (!result.ok) {
    return (
      <main id="main-content" tabIndex={-1} className="fail" role="alert">
        <h1 className="fail__title">CAMPAIGN ASSURANCE UNAVAILABLE</h1>
        <p className="fail__msg">{result.message}</p>
        <p className="fail__note">
          Assume runs are stuck or blocking sends until this loads. It reads a
          content-free support view, so an outage here is never a data-exposure
          question — only a visibility one.
        </p>
      </main>
    );
  }

  const rows = [...result.rows].sort((a, b) => {
    const byHealth = HEALTH_ORDER[runHealth(a)] - HEALTH_ORDER[runHealth(b)];
    if (byHealth !== 0) return byHealth;
    return b.created_at.localeCompare(a.created_at);
  });
  const needingAttention = rows.filter((row) => HEALTH_ORDER[runHealth(row)] <= 3).length;

  return (
    <main id="main-content" tabIndex={-1} className="page">
      <header className="page__head">
        <h1 className="page__title">
          Campaign Assurance <span className="page__count">({rows.length})</span>
        </h1>
      </header>
      <p className="page__lead">
        Worst first. {needingAttention} of {rows.length} need a decision.
        Content-free by construction: no subject, body, extraction, prompt,
        provider payload, or mailbox identity crosses this boundary — only a
        bounded error code.
      </p>

      {result.nextCursor ? (
        <p role="status" className="note note--warn">
          More runs exist beyond this page; the oldest are not shown.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p role="status" className="note note--ok">
          No assurance runs recorded.
        </p>
      ) : (
        <div className="scroll-x panel">
          <table style={{ minWidth: "72rem", fontSize: "0.9rem" }}>
            <caption>
              Campaign Assurance runs, worst health first. Cost is shown against
              the ceiling frozen before the first provider call.
            </caption>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Health</th>
                <th scope="col">State</th>
                <th scope="col">Gate</th>
                <th scope="col">Profile</th>
                <th scope="col">Extractions</th>
                <th scope="col">Blockers</th>
                <th scope="col">Attempts</th>
                <th scope="col">Cost / ceiling</th>
                <th scope="col">Error</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const health = runHealth(row);
                return (
                  <tr key={row.run_id}>
                    <th scope="row" style={{ textAlign: "left" }}>
                      {shortID(row.run_id)}
                      <span className="check__id"> · #{row.run_no}</span>
                      <br />
                      <span className="check__id">
                        tenant {shortID(row.tenant_id)} · campaign{" "}
                        {shortID(row.campaign_id)}
                      </span>
                    </th>
                    <td
                      style={{ color: healthColor(health), fontWeight: 600 }}
                      title={HEALTH_MEANING[health]}
                    >
                      {health}
                    </td>
                    <td>{row.state}</td>
                    <td>{row.gate_decision}</td>
                    <td style={{ color: "var(--text-3)" }}>
                      {row.profile} · {row.trigger_kind}
                    </td>
                    <td>
                      {progress(row)}
                      {row.extraction_error_count > 0 ? (
                        <span style={{ color: "var(--red)" }}>
                          {" "}
                          ({row.extraction_error_count} err)
                        </span>
                      ) : null}
                    </td>
                    <td
                      style={{
                        color:
                          row.blocking_finding_count > 0
                            ? "var(--amber)"
                            : undefined,
                        fontWeight: row.blocking_finding_count > 0 ? 600 : undefined,
                      }}
                    >
                      {row.blocking_finding_count}
                    </td>
                    <td
                      style={{
                        color:
                          row.attempt_count >= row.max_attempts
                            ? "var(--red)"
                            : undefined,
                      }}
                    >
                      {row.attempt_count}/{row.max_attempts}
                    </td>
                    <td
                      style={{
                        color:
                          health === "at-cost-ceiling" ? "var(--amber)" : undefined,
                      }}
                    >
                      {usd(row.cost_microunits)} / {usd(row.max_modeled_cost_microunits)}
                    </td>
                    <td style={{ color: "var(--text-3)" }}>{row.error_code ?? "—"}</td>
                    <td style={{ color: "var(--text-3)" }}>{row.created_at}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
