// SPDX-License-Identifier: AGPL-3.0-only
//
// Launch readiness. The gates that are CONFIGURATION rather than code — live
// keys, approvals, quotas, sidecar contracts — which is the category no test
// suite can speak to and therefore the category that is discovered at 3am on
// launch day.
//
// Failing checks are rendered FIRST and blocking ones first within that,
// because the only question this page exists to answer is "what is still
// stopping us", and an operator should never have to scroll past a wall of
// green to find it.

import { fetchReadiness, summarise, type ReadinessCheck } from "@/lib/launch";

export const dynamic = "force-dynamic";

const STATUS_COPY: Record<string, { tag: string; headline: string }> = {
  ok: { tag: "green", headline: "Every configured gate passes." },
  warning: {
    tag: "amber",
    headline: "Nothing is blocking launch, but optional gates are failing.",
  },
  blocked: {
    tag: "red",
    headline: "Launch is blocked. Required gates are failing.",
  },
};

// Blocking first, then other failures, then passes. Within a tier the API's
// order is preserved so related gates stay together.
function triage(checks: ReadinessCheck[]): ReadinessCheck[] {
  const rank = (c: ReadinessCheck) =>
    c.status === "fail" ? (c.severity === "required" ? 0 : 1) : 2;
  return [...checks].sort((a, b) => rank(a) - rank(b));
}

export default async function LaunchPage() {
  const result = await fetchReadiness();

  if (!result.ok) {
    return (
      <main id="main-content" tabIndex={-1} className="fail" role="alert">
        <h1 className="fail__title">READINESS UNAVAILABLE</h1>
        <p className="fail__msg">{result.message}</p>
        <p className="fail__note">
          An unreadable readiness report is not a passing one. Assume the
          launch gates are unmet until this loads.
        </p>
      </main>
    );
  }

  const { report } = result;
  const { total, failing, blocking } = summarise(report);
  const copy = STATUS_COPY[report.status] ?? { tag: "muted", headline: report.status };

  return (
    <main id="main-content" tabIndex={-1} className="page">
      <header className="page__head">
        <h1 className="page__title">Launch readiness</h1>
        <span className={`tag tag--${copy.tag}`}>{report.status}</span>
        <div className="page__meta">
          environment <code className="check__id">{report.environment}</code>
        </div>
      </header>

      <p className="coverage" role="status">
        {copy.headline}{" "}
        <strong>
          {total - failing} of {total}
        </strong>{" "}
        gates pass
        {blocking > 0 ? (
          <>
            {" "}
            — <strong>{blocking}</strong> required{" "}
            {blocking === 1 ? "gate is" : "gates are"} still failing.
          </>
        ) : (
          "."
        )}
      </p>

      {report.groups.map((group) => {
        const groupFailing = group.checks.filter((c) => c.status === "fail").length;
        return (
          <section key={group.id} style={{ margin: "1.5rem 0" }}>
            <h2>
              {group.label}{" "}
              <span className="page__count">
                ({group.checks.length - groupFailing}/{group.checks.length})
              </span>
            </h2>
            <ul className="checks">
              {triage(group.checks).map((check) => {
                const blocked = check.status === "fail" && check.severity === "required";
                return (
                  <li
                    className="check"
                    key={check.id}
                    // Only failures are visually promoted. A green row that
                    // shouts is a green row that trains people to skim.
                    data-severity={blocked ? "blocking" : undefined}
                  >
                    <span
                      className={`tag tag--${
                        check.status === "pass" ? "green" : blocked ? "red" : "amber"
                      }`}
                    >
                      {check.status === "pass" ? "pass" : blocked ? "blocking" : "warn"}
                    </span>
                    <strong className="check__title">{check.label}</strong>
                    <code className="check__id">{check.id}</code>
                    {check.status === "fail" && check.remediation ? (
                      <span className="check__why">{check.remediation}</span>
                    ) : null}
                    <span className="check__owner">{check.severity}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </main>
  );
}
