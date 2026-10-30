import { type FormEvent, type ReactElement, useEffect, useState } from "react";

import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import {
  api,
  type MigrationJob,
  type MigrationSource,
} from "../../lib/api-client";
import { getDashboardUrl } from "../../lib/dashboard-url";
import {
  buildMigrationCredentialInput,
  findSource,
  validateConnection,
  type ConnectionValues,
  type MigrationSourceDef,
} from "../../lib/migration-sources";
import { tauriApi } from "../../lib/tauri";
import { toast } from "../Toast";
import {
  decodeExactMigrationJob,
  migrationSourceSessionHealth,
  type MigrationSourceSessionHealth,
} from "./migration-source-session";
import { safeMigrationOperationText } from "./migrations-surface-helpers";

const CREDENTIAL_RECOVERY_SOURCES: ReadonlySet<MigrationSource> = new Set([
  "activecampaign",
  "beehiiv",
  "hubspot",
  "klaviyo",
  "customerio",
]);

const RUNNING_SESSION_REFRESH_STATUSES = new Set([
  "authenticating",
  "discovering",
  "dry_run",
  "importing",
  "rolling_back",
]);

export function MigrationSourceSessionRecovery({
  job,
  health,
  canAdmin = true,
  onVerifiedJob,
}: {
  job: MigrationJob;
  health: MigrationSourceSessionHealth;
  canAdmin?: boolean;
  onVerifiedJob: (job: MigrationJob) => void;
}): ReactElement {
  const [values, setValues] = useState<ConnectionValues>({});
  const [operationError, setOperationError] = useState<string | null>(null);
  const operation = useSingleFlightOperation({
    ownerId: "migration-source-session-" + job.id,
    label: "Verify migration source session",
    detail:
      "Wait for the same-job source reconnect and exact snapshot verification before leaving Moosewave.",
  });
  const definition = credentialRecoveryDefinition(job.source);
  const recoveryBlockedWhileRunning = RUNNING_SESSION_REFRESH_STATUSES.has(
    job.status,
  );
  const reasonId = "migration-source-session-recovery-" + safeDomId(job.id);

  useEffect(() => {
    setValues({});
    setOperationError(null);
  }, [job.id, job.source]);

  const verifyFreshSession = async (): Promise<MigrationJob> => {
    const snapshot = await Promise.resolve().then(() =>
      api.getMigration(job.id),
    );
    if (snapshot.error) throw snapshot.error;
    const exact = decodeExactMigrationJob(snapshot.data, job);
    if (!exact) {
      throw {
        kind: "parse",
        code: "migration_source_session_invalid_snapshot",
      };
    }
    if (migrationSourceSessionHealth(exact).blocksAction) {
      throw {
        kind: "parse",
        code: "migration_source_session_not_healthy",
      };
    }
    return exact;
  };

  const runVerifiedOperation = (
    action: string,
    task: () => Promise<MigrationJob>,
  ): void => {
    if (!canAdmin || recoveryBlockedWhileRunning) return;
    setOperationError(null);
    const flight = operation.run(task);
    if (!flight) return;
    void flight
      .then((exact) => {
        toast.success({
          message: "Source session verified",
          detail:
            "This exact migration job now has a healthy saved source session.",
        });
        onVerifiedJob(exact);
      })
      .catch((caught: unknown) => {
        setOperationError(safeMigrationOperationText(caught, action));
      });
  };

  const submitCredentials = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!definition || operation.active) return;
    const validation = validateConnection(definition, values);
    if (validation) {
      setOperationError(validation);
      return;
    }
    const input = buildMigrationCredentialInput(definition, values);
    // Never retain a submitted secret in renderer state while awaiting the
    // network result. Non-secret account selectors stay available for retry.
    setValues((current) => ({ ...current, api_key: "" }));
    runVerifiedOperation("Source session refresh", async () => {
      const refreshed = await Promise.resolve().then(() =>
        api.refreshMigrationSourceSession(job.id, input),
      );
      if (refreshed.error) throw refreshed.error;
      if (!decodeExactMigrationJob(refreshed.data, job)) {
        throw {
          kind: "parse",
          code: "migration_source_session_invalid_ack",
        };
      }
      // The write response is not mutation authority. Unlock only after a
      // separate no-cache exact-job GET confirms the new expiry.
      return verifyFreshSession();
    });
  };

  const openHostedWorkspace = (): void => {
    if (!canAdmin || recoveryBlockedWhileRunning) return;
    setOperationError(null);
    const flight = operation.run(async () => {
      const target = new URL(
        "/app/migrations/" + encodeURIComponent(job.id),
        getDashboardUrl().replace(/\/$/u, "") + "/",
      );
      await tauriApi.openUrl(target.toString());
      return job;
    });
    if (!flight) return;
    void flight.catch((caught: unknown) => {
      setOperationError(
        safeMigrationOperationText(caught, "Hosted source reconnect"),
      );
    });
  };

  return (
    <section
      className="migration-cancelled-recovery"
      aria-labelledby={reasonId + "-heading"}
    >
      <h3 id={reasonId + "-heading"}>Reconnect this exact source job</h3>
      <p>{health.message}</p>

      {!canAdmin ? (
        <p id={reasonId} className="migration-action-reason">
          Admin role required to replace and verify a tenant migration source
          session.
        </p>
      ) : recoveryBlockedWhileRunning ? (
        <p id={reasonId} className="migration-action-reason" role="status">
          The server cannot replace a source session while this job is reading,
          importing, or rolling back. Cancel or wait for a durable terminal
          checkpoint before reconnecting.
        </p>
      ) : definition ? (
        <form onSubmit={submitCredentials}>
          <p className="muted">
            The server will validate these credentials against the provider
            account, workspace, or publication already bound to job{" "}
            <code>{job.id}</code>. It cannot switch this job to another source
            identity.
          </p>
          {definition.fields.map((field) => {
            const inputId = reasonId + "-" + safeDomId(field.key);
            const raw = values[field.key];
            return (
              <div className="field" key={field.key}>
                <label className="field-label" htmlFor={inputId}>
                  {field.label}
                  {field.required ? " *" : ""}
                </label>
                <input
                  id={inputId}
                  className="input"
                  type={
                    field.kind === "password"
                      ? "password"
                      : field.kind === "url"
                        ? "url"
                        : "text"
                  }
                  autoComplete="off"
                  spellCheck={false}
                  required={field.required}
                  aria-required={field.required || undefined}
                  maxLength={field.maxLength}
                  placeholder={field.placeholder}
                  value={typeof raw === "string" ? raw : ""}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.key]: event.target.value,
                    }))
                  }
                />
              </div>
            );
          })}
          <div className="migration-inline-actions">
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              aria-disabled={operation.active || undefined}
              aria-busy={operation.active || undefined}
              onClick={(event) => {
                if (operation.active) event.preventDefault();
              }}
            >
              {operation.active
                ? "Refreshing and verifying…"
                : "Refresh this job's session"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              aria-disabled={operation.active || undefined}
              onClick={() => {
                if (!operation.active) {
                  runVerifiedOperation(
                    "Source session verification",
                    verifyFreshSession,
                  );
                }
              }}
            >
              Verify refreshed session
            </button>
          </div>
        </form>
      ) : (
        <div className="migration-inline-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            aria-disabled={operation.active || undefined}
            onClick={() => {
              if (!operation.active) openHostedWorkspace();
            }}
          >
            Open this exact job in web
          </button>
          <button
            type="button"
            className="btn btn-sm"
            aria-disabled={operation.active || undefined}
            onClick={() => {
              if (!operation.active) {
                runVerifiedOperation(
                  "Source session verification",
                  verifyFreshSession,
                );
              }
            }}
          >
            Verify refreshed session
          </button>
        </div>
      )}

      {operationError ? (
        <div className="field-error" role="alert">
          {operationError}
        </div>
      ) : null}
    </section>
  );
}

function credentialRecoveryDefinition(
  source: MigrationSource,
): MigrationSourceDef | null {
  if (!CREDENTIAL_RECOVERY_SOURCES.has(source)) return null;
  const definition = findSource(source);
  if (!definition || definition.authFlow !== "api_key") return null;
  return {
    ...definition,
    fields: definition.fields.map((field) =>
      // The service can safely reuse the exact Beehiiv publication already
      // bound to the job. Supplying it remains an optional mismatch check.
      source === "beehiiv" && field.key === "publication_id"
        ? { ...field, required: false }
        : field,
    ),
  };
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 160);
}
