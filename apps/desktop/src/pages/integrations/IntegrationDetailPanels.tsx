/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Persistent unavailable-action explanations must remain independently keyboard discoverable. */

import { useId, type ReactElement } from "react";

import type {
  IntegrationCatalogItem,
  IntegrationConnection,
  IntegrationConnectorContract,
  IntegrationDetailResponse,
  IntegrationHealthReport,
  IntegrationRecipe,
  IntegrationRecipeApplyResponse,
  IntegrationRecipeBlueprint,
  IntegrationRecipeDetailResponse,
  IntegrationSetupStep,
} from "../../lib/api-client";
import { SlideoverShell } from "../../components/SlideoverShell";
import {
  badgeLabel,
  categoryLabel,
  countAvailableRecipes,
  firstActionableSetupStep,
  lifecycleActionButtonClass,
  lifecycleActionLabel,
  lifecycleActionNeedsConnection,
  nativeProviderFamily,
} from "../integrations-helpers";
import { IconArrow, IconPlug, IconRefresh } from "./IntegrationPresentation";
import { MiniMetric } from "./IntegrationPanelPrimitives";

type SurfaceTone = "danger" | "info" | "neutral" | "success" | "warning";

const supportedLifecycleActions = new Set([
  "connect/start",
  "connect/callback",
  "sync",
  "backfill",
  "pause",
  "disconnect",
  "roadmap",
]);

function textValue(
  value: string | null | undefined,
  fallback = "Unknown",
): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function labeledValue(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? categoryLabel(trimmed, new Map()) : "Unknown";
}

function countValue(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value.toLocaleString()
    : "Unknown";
}

function statusTone(value: string | null | undefined): SurfaceTone {
  switch (value?.trim().toLowerCase()) {
    case "active":
    case "available":
    case "completed":
    case "connected":
    case "healthy":
    case "ok":
    case "ready":
      return "success";
    case "action_required":
    case "error":
    case "failed":
    case "outage":
    case "unhealthy":
      return "danger";
    case "delegated":
    case "needs_attention":
    case "partial":
    case "paused":
    case "planned":
      return "warning";
    case "not_configured":
    case "queued":
    case "ready_to_configure":
    case "running":
      return "info";
    default:
      return "neutral";
  }
}

function healthInterpretation(value: string): string {
  switch (value.trim().toLowerCase()) {
    case "healthy":
      return "No current health issue is reported by this response.";
    case "action_required":
      return "Operator action is required; review the checks and latest error before retrying.";
    case "needs_attention":
      return "The connector reports degraded or incomplete operation that needs review.";
    case "ready_to_configure":
      return "The connector reports that setup can begin; this is not a connected state.";
    case "not_configured":
      return "No configured connection is reported.";
    case "planned":
      return "The connector is planned and does not report live operating health.";
    default:
      return "The response does not provide a recognized health classification.";
  }
}

function recipeEstimate(minutes: number): string {
  return Number.isFinite(minutes) && minutes > 0
    ? `${minutes.toLocaleString()} min`
    : "Estimate unknown";
}

function SafeTime({
  value,
  emptyLabel = "Not reported",
}: {
  value?: string | null;
  emptyLabel?: string;
}): ReactElement {
  const candidate = value?.trim();
  if (!candidate) {
    return <span className="int-time-fallback">{emptyLabel}</span>;
  }
  const date = new Date(candidate);
  if (!Number.isFinite(date.getTime())) {
    return <span className="int-time-fallback">Timestamp unavailable</span>;
  }
  return (
    <time className="int-safe-time" dateTime={date.toISOString()}>
      {date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })}
    </time>
  );
}

function StatusBadge({
  value,
  tone = statusTone(value),
}: {
  value: string | null | undefined;
  tone?: SurfaceTone;
}): ReactElement {
  return (
    <span className="int-status-pill" data-tone={tone}>
      {labeledValue(value)}
    </span>
  );
}

function EmptyCollection({ message }: { message: string }): ReactElement {
  return (
    <p className="int-collection-empty" data-empty-state="true">
      {message}
    </p>
  );
}

function SectionHeading({
  id,
  eyebrow,
  title,
  description,
  status,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  status?: ReactElement;
}): ReactElement {
  return (
    <header className="int-section-heading">
      <div className="int-section-heading-copy">
        <p className="int-section-eyebrow">{eyebrow}</p>
        <h3 id={id}>{title}</h3>
        <p>{description}</p>
      </div>
      {status ? <div className="int-section-status">{status}</div> : null}
    </header>
  );
}

function TokenCollection({
  title,
  description,
  values,
  empty,
  exact = false,
}: {
  title: string;
  description?: string;
  values: string[];
  empty: string;
  exact?: boolean;
}): ReactElement {
  return (
    <section className="int-token-collection">
      <h4>{title}</h4>
      {description ? <p>{description}</p> : null}
      {values.length === 0 ? (
        <EmptyCollection message={empty} />
      ) : (
        <ul className="int-token-collection-list">
          {values.map((value, index) => (
            <li key={`${value}-${index}`}>
              {exact ? <code>{textValue(value)}</code> : labeledValue(value)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ActionReason({
  id,
  message,
  live = false,
}: {
  id: string;
  message: string;
  live?: boolean;
}): ReactElement {
  return (
    <p
      id={id}
      className="int-action-reason int-action-reason--visible"
      role="note"
      tabIndex={0}
      aria-live={live ? "polite" : undefined}
    >
      {message}
    </p>
  );
}

export function DetailPanel({
  detail,
  loading,
  categoryLabels,
  onClose,
  onOpenPath,
  onOpenRecipe,
  onApplyRecipe,
  applyingRecipeID,
  onLifecycleAction,
  busyLifecycleAction,
  canAdmin,
}: {
  detail: IntegrationDetailResponse | null;
  loading: boolean;
  categoryLabels: Map<string, string>;
  onClose: () => void;
  onOpenPath: (path?: string) => void;
  onOpenRecipe: (recipe: IntegrationRecipe) => void;
  onApplyRecipe: (recipe: IntegrationRecipe) => void;
  applyingRecipeID: string;
  onLifecycleAction: (item: IntegrationCatalogItem, action: string) => void;
  busyLifecycleAction: string;
  canAdmin: boolean;
}): ReactElement {
  const item = detail?.item;
  const connection = detail?.connection;
  const primaryStep = firstActionableSetupStep(detail?.setup ?? []);
  const subtitle = item
    ? `${categoryLabel(item.category, categoryLabels)} · ${badgeLabel(item.badge, item.runtime_status)} · ${labeledValue(item.runtime_status)}`
    : "Connection identity, contract assurance, health, and setup";
  const setupSummary = primaryStep?.action?.trim()
    ? primaryStep.action
    : detail?.setup.length
      ? "Instructions only"
      : "No steps";

  return (
    <SlideoverShell
      open
      onClose={onClose}
      size="xl"
      eyebrow="Integration detail"
      title={
        loading && !item
          ? "Verifying integration…"
          : (item?.name ?? "Integration")
      }
      subtitle={subtitle}
      busy={Boolean(busyLifecycleAction)}
      className="int-detail-slideover int-operator-slideover"
    >
      {loading && !detail ? (
        <div className="int-detail-loading int-operator-loading" role="status">
          <span aria-hidden="true" />
          <div>
            <strong>Verifying setup details</strong>
            <p>
              Resolving the exact connection, declared scopes, health, and
              lifecycle contract.
            </p>
          </div>
        </div>
      ) : detail && item ? (
        <div className="int-operator-detail">
          <section className="int-operator-overview" aria-label="At a glance">
            <div className="int-operator-metrics">
              <MiniMetric
                label="Reported health"
                value={labeledValue(detail.health.state)}
              />
              <MiniMetric
                label="Connection status"
                value={labeledValue(connection?.status)}
              />
              <MiniMetric
                label="Ready playbooks"
                value={countAvailableRecipes(detail.recipes).toLocaleString()}
              />
              <MiniMetric
                label="Lifecycle actions"
                value={detail.lifecycle_actions.length.toLocaleString()}
              />
              <MiniMetric label="Setup entry" value={setupSummary} />
            </div>
          </section>

          <ConnectionIdentityPanel item={item} connection={connection} />
          <ContractPanel contract={detail.contract} />
          <LifecycleActionsPanel
            item={item}
            connection={connection}
            actions={detail.lifecycle_actions}
            canAdmin={canAdmin}
            busyAction={busyLifecycleAction}
            onLifecycleAction={onLifecycleAction}
          />
          <HealthPanel health={detail.health} onOpenPath={onOpenPath} />

          <div className="int-operator-secondary-grid">
            <GuideList
              title="Setup guide"
              description="Ordered operator instructions returned for this exact connector."
              steps={detail.setup}
              onOpenPath={onOpenPath}
            />
            <RecipeList
              recipes={detail.recipes}
              onOpenPath={onOpenPath}
              onOpenRecipe={onOpenRecipe}
              onApplyRecipe={onApplyRecipe}
              applyingRecipeID={applyingRecipeID}
              canAdmin={canAdmin}
            />
          </div>
        </div>
      ) : (
        <div className="int-detail-unavailable" role="status">
          <strong>Integration detail unavailable</strong>
          <p>
            No detail response is available. Connection identity, health, and
            setup remain unknown.
          </p>
        </div>
      )}
    </SlideoverShell>
  );
}

function ConnectionIdentityPanel({
  item,
  connection,
}: {
  item: IntegrationCatalogItem;
  connection?: IntegrationConnection;
}): ReactElement {
  const headingId = useId();
  const connectionIDs = connection?.connection_ids ?? [];
  const configuredCount = Math.max(
    connection?.count ?? 0,
    connectionIDs.length,
  );
  const primaryID = connection?.primary_connection_id?.trim() || null;
  const ambiguousConnection = configuredCount > 1;
  const actionableTarget = ambiguousConnection ? null : primaryID;
  const exactTargetStatus = ambiguousConnection
    ? "Multiple accounts configured; choose an exact target in Manage before account-specific actions"
    : actionableTarget
      ? "Exact primary connection selected"
      : configuredCount === 1
        ? "One account is reported, but its primary target is unknown"
        : "No exact connection target is selected";
  const targetTone: SurfaceTone = ambiguousConnection
    ? "warning"
    : actionableTarget
      ? "success"
      : configuredCount > 0
        ? "warning"
        : "neutral";

  return (
    <section className="int-operator-section" aria-labelledby={headingId}>
      <SectionHeading
        id={headingId}
        eyebrow="Account boundary"
        title="Connection identity"
        description="Confirm the exact saved account before running lifecycle operations. Catalog identity is not a substitute for a connection ID."
        status={
          <StatusBadge
            value={connection?.status ?? "unknown"}
            tone={statusTone(connection?.status)}
          />
        }
      />

      {connection ? (
        <>
          <div className="int-identity-hero" data-tone={targetTone}>
            <div className="int-identity-marker" aria-hidden="true" />
            <div>
              <span>Exact lifecycle target</span>
              <strong>
                {actionableTarget ? (
                  <code>{actionableTarget}</code>
                ) : (
                  "Not selected"
                )}
              </strong>
              <p>{exactTargetStatus}</p>
            </div>
          </div>

          <dl className="int-definition-grid">
            <div>
              <dt>Catalog slug</dt>
              <dd>
                <code>{textValue(connection.slug)}</code>
              </dd>
            </div>
            <div>
              <dt>Connected flag</dt>
              <dd>{connection.connected ? "Connected" : "Not connected"}</dd>
            </div>
            <div>
              <dt>Configured accounts</dt>
              <dd>{countValue(configuredCount)}</dd>
            </div>
            <div>
              <dt>Runtime status</dt>
              <dd>{labeledValue(connection.runtime_status)}</dd>
            </div>
            <div>
              <dt>Reported health</dt>
              <dd>{labeledValue(connection.health_state)}</dd>
            </div>
            <div>
              <dt>Last reported sync</dt>
              <dd>
                <SafeTime value={connection.last_sync_at} />
              </dd>
            </div>
            <div>
              <dt>Manage surface</dt>
              <dd>{textValue(connection.manage_path, "Not provided")}</dd>
            </div>
            <div>
              <dt>Connection source</dt>
              <dd>{textValue(connection.source)}</dd>
            </div>
          </dl>

          <div className="int-identity-detail-grid">
            <TokenCollection
              title="Reported connection IDs"
              description="Identifiers returned for this catalog entry. The primary target above controls exact-account actions."
              values={connectionIDs}
              empty="No connection identifiers were returned. Exact targeting remains unknown."
              exact
            />
            <section className="int-connection-observation">
              <h4>Latest connection message</h4>
              {connection.last_error?.trim() ? (
                <div className="int-inline-alert" data-tone="danger">
                  <strong>Error reported</strong>
                  <p>{connection.last_error}</p>
                </div>
              ) : connection.health_message?.trim() ? (
                <div className="int-inline-alert" data-tone="neutral">
                  <strong>Health message</strong>
                  <p>{connection.health_message}</p>
                </div>
              ) : (
                <EmptyCollection message="No connection error or health message was returned." />
              )}
            </section>
          </div>
          <div className="int-identity-catalog-grid">
            <TokenCollection
              title="Catalog capabilities"
              description="Capabilities declared for the catalog entry; runtime availability is reported separately above."
              values={item.capabilities}
              empty="No catalog capabilities are declared for this integration."
              exact
            />
            <TokenCollection
              title="Catalog source families"
              description="Source families associated with the catalog entry."
              values={item.sources ?? []}
              empty="No catalog source families are declared for this integration."
              exact
            />
          </div>
        </>
      ) : (
        <EmptyCollection message="No connection record was returned. Exact targeting and connection state are unknown." />
      )}
    </section>
  );
}

function lifecycleActionIcon(action: string): ReactElement | null {
  if (action === "connect/start" || action === "oauth/start") {
    return (
      <span className="int-lifecycle-icon" aria-hidden="true">
        <IconPlug />
      </span>
    );
  }
  if (action === "connect/callback" || action === "oauth/callback") {
    return (
      <span className="int-lifecycle-icon" aria-hidden="true">
        <IconArrow />
      </span>
    );
  }
  if (action === "sync" || action === "backfill") {
    return (
      <span className="int-lifecycle-icon" aria-hidden="true">
        <IconRefresh />
      </span>
    );
  }
  return null;
}

function lifecycleLabel(action: string): string {
  switch (action) {
    case "oauth/availability":
      return "Check OAuth availability";
    case "oauth/start":
      return "Start OAuth";
    case "oauth/callback":
      return "Complete OAuth";
    case "provider-cleanup/acknowledge":
      return "Acknowledge provider cleanup";
    default:
      return lifecycleActionLabel(action);
  }
}

function actionNeedsExactConnection(action: string): boolean {
  return (
    lifecycleActionNeedsConnection(action) ||
    action === "provider-cleanup/acknowledge"
  );
}

function LifecycleActionsPanel({
  item,
  connection,
  actions,
  canAdmin,
  busyAction,
  onLifecycleAction,
}: {
  item: IntegrationCatalogItem;
  connection?: IntegrationConnection;
  actions: string[];
  canAdmin: boolean;
  busyAction: string;
  onLifecycleAction: (item: IntegrationCatalogItem, action: string) => void;
}): ReactElement {
  const headingId = useId();
  const reasonIDBase = useId();
  const visibleActions = actions.filter((action) => action.trim().length > 0);
  const connectionIDs = connection?.connection_ids ?? [];
  const connectionCount = Math.max(
    connection?.count ?? 0,
    connectionIDs.length,
  );
  const primaryID = connection?.primary_connection_id?.trim() || null;
  const hasConnection = Boolean(primaryID || connectionCount);
  const ambiguousConnection = connectionCount > 1;
  const identityLabel = ambiguousConnection
    ? `${connectionCount.toLocaleString()} accounts; exact target not selected`
    : primaryID
      ? `Exact target: ${primaryID}`
      : connectionCount === 1
        ? "One account reported; primary ID unknown"
        : "No saved connection target";

  return (
    <section className="int-operator-section" aria-labelledby={headingId}>
      <SectionHeading
        id={headingId}
        eyebrow="Controlled operations"
        title="Lifecycle controls"
        description="Each account-specific operation is gated on one exact connection identity. Unavailable controls remain discoverable and explain why they cannot run."
        status={
          <StatusBadge
            value={connection?.status ?? "unknown"}
            tone={statusTone(connection?.status)}
          />
        }
      />
      <div className="int-lifecycle-target">
        <span>Current action target</span>
        <strong>{identityLabel}</strong>
      </div>

      {visibleActions.length === 0 ? (
        <EmptyCollection message="No lifecycle actions are declared for this connector." />
      ) : (
        <ul className="int-lifecycle-actions">
          {visibleActions.map((action, index) => {
            const key = `${item.slug}:${action}`;
            const busy = busyAction === key;
            const unavailableReason =
              nativeProviderFamily(item) === "support_integration"
                ? "Support provider lifecycle is release-held. No runtime request will be sent (support_integration_runtime_held)."
                : !supportedLifecycleActions.has(action)
              ? "This action is not supported by this version of Moosewave."
              : busyAction !== ""
                ? "Wait for the current integration operation to finish."
                : item.runtime_status === "planned" && action !== "roadmap"
                  ? "This integration is planned and cannot run yet."
                  : !canAdmin && action !== "roadmap"
                    ? "Admin role required for integration lifecycle actions."
                    : ambiguousConnection && actionNeedsExactConnection(action)
                      ? "Choose one exact configured account in Manage first."
                      : actionNeedsExactConnection(action) && !hasConnection
                        ? "Connect this integration and verify its exact connection ID first."
                        : null;
            const reasonId = `${reasonIDBase}-${index}`;
            const label = lifecycleLabel(action);
            return (
              <li key={`${action}-${index}`}>
                <button
                  type="button"
                  className={`${lifecycleActionButtonClass(action)} int-lifecycle-action`}
                  aria-disabled={unavailableReason ? true : undefined}
                  aria-describedby={unavailableReason ? reasonId : undefined}
                  aria-busy={busy ? true : undefined}
                  onClick={() => {
                    if (unavailableReason) return;
                    onLifecycleAction(item, action);
                  }}
                >
                  {lifecycleActionIcon(action)}
                  {busy ? `${label} in progress…` : label}
                </button>
                {unavailableReason ? (
                  <ActionReason
                    id={reasonId}
                    message={unavailableReason}
                    live={busy}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function contractAssurance(contract: IntegrationConnectorContract): {
  label: string;
  detail: string;
  tone: SurfaceTone;
} {
  if (contract.native_verified) {
    return {
      label: "API-verified native contract",
      detail:
        "The response marks this connector as API-verified. Review the declared scope, storage, and compliance boundaries below before making customer claims.",
      tone: "success",
    };
  }
  if (contract.native_managed) {
    return {
      label: "Native foundation — verification incomplete",
      detail:
        "Moosewave ownership is reported, but API verification is not. Treat this as foundation-level capability, not verified-native evidence.",
      tone: "warning",
    };
  }
  return {
    label: "Delegated or planned contract",
    detail:
      "The response does not mark this connector as native-managed or API-verified. Follow the declared setup surface and public claim exactly.",
    tone: "neutral",
  };
}

function ContractPanel({
  contract,
}: {
  contract: IntegrationConnectorContract;
}): ReactElement {
  const headingId = useId();
  const assurance = contractAssurance(contract);
  return (
    <section className="int-operator-section" aria-labelledby={headingId}>
      <SectionHeading
        id={headingId}
        eyebrow="Claim boundary"
        title="Contract assurance"
        description="Separate API-verified capability from native foundation, delegated setup, and planned coverage."
        status={<StatusBadge value={contract.badge} tone={assurance.tone} />}
      />

      <div className="int-assurance-callout" data-tone={assurance.tone}>
        <span className="int-assurance-symbol" aria-hidden="true" />
        <div>
          <strong>{assurance.label}</strong>
          <p>{assurance.detail}</p>
          <blockquote>{textValue(contract.public_claim)}</blockquote>
        </div>
      </div>

      <dl className="int-definition-grid int-definition-grid--contract">
        <div>
          <dt>Contract owner</dt>
          <dd>{labeledValue(contract.owner)}</dd>
        </div>
        <div>
          <dt>Implementation depth</dt>
          <dd>{labeledValue(contract.implementation_depth)}</dd>
        </div>
        <div>
          <dt>Runtime status</dt>
          <dd>{labeledValue(contract.runtime_status)}</dd>
        </div>
        <div>
          <dt>Setup surface</dt>
          <dd>{textValue(contract.setup_surface)}</dd>
        </div>
        <div>
          <dt>Partner review</dt>
          <dd>{labeledValue(contract.partner_review)}</dd>
        </div>
        <div>
          <dt>Native managed</dt>
          <dd>{contract.native_managed ? "Reported yes" : "Reported no"}</dd>
        </div>
      </dl>

      <div className="int-contract-grid">
        <section className="int-contract-auth-card">
          <h4>Authentication & credential handling</h4>
          <TokenCollection
            title="Declared authentication modes"
            values={contract.auth_modes}
            empty="No authentication modes are declared by this contract."
            exact
          />
          <dl className="int-stacked-definitions">
            <div>
              <dt>Credential storage</dt>
              <dd>{textValue(contract.credential_storage)}</dd>
            </div>
            <div>
              <dt>Secret policy</dt>
              <dd>{textValue(contract.secret_policy)}</dd>
            </div>
            <div>
              <dt>Rate-limit policy</dt>
              <dd>{textValue(contract.rate_limit_policy)}</dd>
            </div>
          </dl>
        </section>

        <section className="int-contract-access-card">
          <h4>Scopes & consent</h4>
          <div className="int-contract-access-grid">
            <TokenCollection
              title="Required scopes"
              description="Exact scope identifiers declared by the connector contract."
              values={contract.required_scopes ?? []}
              empty="No connector scopes are declared by this contract."
              exact
            />
            <TokenCollection
              title="Consent & compliance gates"
              description="Conditions to verify before data is transferred or activated."
              values={contract.compliance_gates}
              empty="No consent or compliance gates are declared by this contract."
            />
          </div>
        </section>
      </div>

      <div className="int-contract-token-grid">
        <TokenCollection
          title="Monitoring surfaces"
          values={contract.monitoring}
          empty="No monitoring surfaces are declared."
        />
        <TokenCollection
          title="Declared lifecycle"
          values={contract.lifecycle_actions}
          empty="No lifecycle actions are declared by the contract."
          exact
        />
        <TokenCollection
          title="Data objects"
          values={contract.data_objects}
          empty="No data objects are declared."
          exact
        />
        <TokenCollection
          title="Event topics"
          values={contract.event_topics}
          empty="No event topics are declared."
          exact
        />
        <TokenCollection
          title="Privacy actions"
          values={contract.privacy_actions}
          empty="No privacy actions are declared."
        />
        <TokenCollection
          title="Bridge channels"
          values={contract.bridge_channels ?? []}
          empty="No bridge channels are declared."
          exact
        />
      </div>
    </section>
  );
}

function HealthPanel({
  health,
  onOpenPath,
}: {
  health: IntegrationHealthReport;
  onOpenPath: (path?: string) => void;
}): ReactElement {
  const headingId = useId();
  const checksId = useId();
  const retryId = useId();
  const historyId = useId();
  const observationsId = useId();
  const lifecycleId = useId();
  const tone = statusTone(health.state);

  return (
    <section className="int-operator-section" aria-labelledby={headingId}>
      <SectionHeading
        id={headingId}
        eyebrow="Operations"
        title="Health, outages & recovery"
        description="Reported health taxonomy, check-level context, retry boundaries, recent runs, and non-audit observations."
        status={<StatusBadge value={health.state} tone={tone} />}
      />

      <div className="int-health-taxonomy" data-tone={tone}>
        <div className="int-health-signal" aria-hidden="true" />
        <div className="int-health-taxonomy-copy">
          <span>Reported classification</span>
          <strong>{labeledValue(health.state)}</strong>
          <p>{textValue(health.message)}</p>
          <small>{healthInterpretation(health.state)}</small>
        </div>
        <dl>
          <div>
            <dt>Severity</dt>
            <dd>{labeledValue(health.severity)}</dd>
          </div>
          <div>
            <dt>Monitoring surface</dt>
            <dd>{textValue(health.monitoring_surface)}</dd>
          </div>
        </dl>
        {health.docs_url?.trim() ? (
          <button
            type="button"
            className="btn"
            onClick={() => onOpenPath(health.docs_url)}
          >
            Open health guidance
          </button>
        ) : null}
      </div>

      <div className="int-health-grid">
        <section className="int-health-card" aria-labelledby={checksId}>
          <header>
            <h4 id={checksId}>Health checks</h4>
            <span>{health.checks.length.toLocaleString()} reported</span>
          </header>
          {health.checks.length === 0 ? (
            <EmptyCollection message="No health checks were returned. Overall health cannot substitute for check-level evidence." />
          ) : (
            <ul className="int-health-checks">
              {health.checks.map((check, index) => (
                <li key={`${check.key}-${index}`}>
                  <div>
                    <strong>{textValue(check.label)}</strong>
                    <code>{textValue(check.key)}</code>
                  </div>
                  <StatusBadge
                    value={check.state}
                    tone={statusTone(check.state)}
                  />
                  <p>{textValue(check.message)}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="int-health-card" aria-labelledby={retryId}>
          <header>
            <h4 id={retryId}>Retry & failure policy</h4>
            <span>Declared behavior</span>
          </header>
          <dl className="int-stacked-definitions int-retry-policy">
            <div>
              <dt>Mode</dt>
              <dd>{labeledValue(health.retry_policy.mode)}</dd>
            </div>
            <div>
              <dt>Maximum attempts</dt>
              <dd>
                {health.retry_policy.max_attempts > 0
                  ? countValue(health.retry_policy.max_attempts)
                  : "Unknown"}
              </dd>
            </div>
            <div>
              <dt>Backoff</dt>
              <dd>{textValue(health.retry_policy.backoff)}</dd>
            </div>
            <div>
              <dt>Dead-letter handling</dt>
              <dd>{textValue(health.retry_policy.dead_letter)}</dd>
            </div>
            <div>
              <dt>Idempotency boundary</dt>
              <dd>{textValue(health.retry_policy.idempotency)}</dd>
            </div>
          </dl>
        </section>

        <section className="int-health-card" aria-labelledby={historyId}>
          <header>
            <h4 id={historyId}>Recent operation history</h4>
            <span>{health.sync_history.length.toLocaleString()} entries</span>
          </header>
          {health.sync_history.length === 0 ? (
            <EmptyCollection message="No recent operation history was returned. A successful run must not be inferred." />
          ) : (
            <ol className="int-operation-history">
              {health.sync_history.map((entry, index) => (
                <li key={`${entry.action}-${entry.at ?? "unknown"}-${index}`}>
                  <div className="int-history-marker" aria-hidden="true" />
                  <article>
                    <header>
                      <strong>{labeledValue(entry.action)}</strong>
                      <StatusBadge
                        value={entry.status}
                        tone={statusTone(entry.status)}
                      />
                    </header>
                    <dl className="int-history-metadata">
                      <div>
                        <dt>Reported at</dt>
                        <dd>
                          <SafeTime value={entry.at} />
                        </dd>
                      </div>
                      <div>
                        <dt>Attempts</dt>
                        <dd>{countValue(entry.attempts)}</dd>
                      </div>
                    </dl>
                    <p>{textValue(entry.message)}</p>
                    {entry.error?.trim() ? (
                      <p className="int-history-error">
                        <strong>Error:</strong> {entry.error}
                      </p>
                    ) : null}
                  </article>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="int-health-card" aria-labelledby={observationsId}>
          <header>
            <h4 id={observationsId}>Operational observations</h4>
            <span>{health.audit_trail.length.toLocaleString()} entries</span>
          </header>
          <p className="int-evidence-disclaimer">
            These connector or system observations provide context only. They
            are not independently verified audit evidence.
          </p>
          {health.audit_trail.length === 0 ? (
            <EmptyCollection message="No operational observations were returned." />
          ) : (
            <ol className="int-observation-list">
              {health.audit_trail.map((entry, index) => (
                <li key={`${entry.action}-${entry.at ?? "unknown"}-${index}`}>
                  <div>
                    <strong>{labeledValue(entry.action)}</strong>
                    <span>{textValue(entry.actor, "Actor unknown")}</span>
                  </div>
                  <SafeTime value={entry.at} />
                  <p>{textValue(entry.message)}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="int-data-lifecycle" aria-labelledby={lifecycleId}>
        <header>
          <div>
            <p className="int-section-eyebrow">Instruction boundary</p>
            <h4 id={lifecycleId}>Data lifecycle instructions</h4>
          </div>
          <span className="int-instruction-only">Instructions only</span>
        </header>
        <p className="int-data-lifecycle-disclaimer">
          Nothing is deleted or disconnected by viewing this panel. Opening an
          instruction template is intentionally unavailable here; review it in
          the authorized management surface. A reference does not prove that
          deletion occurred.
        </p>
        {health.data_delete.length === 0 ? (
          <EmptyCollection message="No data-lifecycle instructions were returned. Retention and deletion behavior remain unknown." />
        ) : (
          <ul className="int-data-lifecycle-list">
            {health.data_delete.map((action, index) => (
              <li key={`${action.method}-${action.path}-${index}`}>
                <div className="int-data-lifecycle-route">
                  <span>{textValue(action.method)}</span>
                  <code>{textValue(action.path)}</code>
                </div>
                <p>{textValue(action.description)}</p>
                <p className="int-reference-only">
                  Reference only — review and execute this instruction in its
                  authorized management surface.
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function serializeSamplePayload(
  payload: Record<string, unknown> | undefined,
): string | null {
  if (!payload || Object.keys(payload).length === 0) return null;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return null;
  }
}

export function RecipeBlueprintPanel({
  detail,
  fallbackRecipe,
  loading,
  applyResult,
  applyingRecipeID,
  onApplyRecipe,
  onOpenPath,
  onClose,
  canAdmin,
}: {
  detail: IntegrationRecipeDetailResponse | null;
  fallbackRecipe: IntegrationRecipe | null;
  loading: boolean;
  applyResult: IntegrationRecipeApplyResponse | null;
  applyingRecipeID: string;
  onApplyRecipe: (recipe: IntegrationRecipe) => void;
  onOpenPath: (path?: string) => void;
  onClose: () => void;
  canAdmin: boolean;
}): ReactElement {
  const recipe = detail?.recipe ?? fallbackRecipe;
  const matchingApplyResult =
    recipe && applyResult?.recipe_id === recipe.id ? applyResult : null;
  const blueprint = matchingApplyResult?.blueprint ?? recipe?.blueprint;
  const sourceName = textValue(
    detail?.source.name ?? recipe?.source_slug,
    "Unknown source",
  );
  const targetName = textValue(
    detail?.target?.name ?? recipe?.target_slug ?? blueprint?.destination,
    "Unknown destination",
  );
  const samplePayload = serializeSamplePayload(blueprint?.sample_payload);
  const prepareUnavailableReason = !recipe?.available
    ? "This playbook is planned; its blueprint is available for review only."
    : !canAdmin
      ? "Admin role required to prepare an integration setup plan."
      : applyingRecipeID
        ? "Wait for the current setup preparation to finish."
        : null;
  const prepareReasonId = useId();
  const openReasonId = useId();
  const setupPath = matchingApplyResult?.manage_path ?? recipe?.setup_path;
  const hasSetupPath = Boolean(setupPath?.trim());

  return (
    <SlideoverShell
      open
      onClose={onClose}
      size="xl"
      eyebrow="Setup playbook"
      title={
        loading && !recipe
          ? "Verifying playbook…"
          : (recipe?.name ?? "Playbook")
      }
      subtitle={
        recipe
          ? `${textValue(recipe.provider)} · ${sourceName} to ${targetName}`
          : "Access, data path, field mapping, payload, and setup instructions"
      }
      busy={Boolean(applyingRecipeID)}
      className="int-recipe-slideover int-playbook-slideover"
    >
      {loading && !recipe ? (
        <div className="int-detail-loading int-operator-loading" role="status">
          <span aria-hidden="true" />
          <div>
            <strong>Verifying playbook</strong>
            <p>
              Checking the exact recipe identity, declared access, secret
              references, and field mappings.
            </p>
          </div>
        </div>
      ) : recipe && blueprint ? (
        <div className="int-playbook-detail">
          <section className="int-playbook-route" aria-label="Playbook route">
            <div>
              <span>Source</span>
              <strong>{sourceName}</strong>
              <code>{textValue(recipe.source_slug)}</code>
            </div>
            <span className="int-playbook-route-arrow" aria-hidden="true">
              →
            </span>
            <div>
              <span>Destination</span>
              <strong>{targetName}</strong>
              <code>
                {textValue(
                  recipe.target_slug ?? blueprint.destination,
                  "Unknown",
                )}
              </code>
            </div>
          </section>

          <div className="int-operator-metrics int-playbook-metrics">
            <MiniMetric label="Trigger" value={textValue(blueprint.trigger)} />
            <MiniMetric
              label="Destination"
              value={textValue(blueprint.destination)}
            />
            <MiniMetric
              label="Moosewave surface"
              value={textValue(blueprint.postwave_surface)}
            />
            <MiniMetric
              label="Preparation"
              value={recipe.available ? "Ready" : "Planned"}
            />
          </div>

          <PlaybookAccessPanel blueprint={blueprint} />

          <div className="int-playbook-content-grid">
            <FieldMappings blueprint={blueprint} />
            <section className="int-payload-panel">
              <header>
                <p className="int-section-eyebrow">Example data</p>
                <h3>Sample payload</h3>
                <p>
                  Review field shape only. Sample values are not proof of a
                  completed transfer.
                </p>
              </header>
              {samplePayload ? (
                <pre aria-label="Sample payload">
                  <code>{samplePayload}</code>
                </pre>
              ) : (
                <EmptyCollection message="No sample payload was provided." />
              )}
            </section>
          </div>

          <GuideList
            title="Playbook setup steps"
            description="Ordered setup instructions declared by this recipe."
            steps={recipe.steps}
            onOpenPath={onOpenPath}
          />

          {matchingApplyResult ? (
            <PreparationResult
              result={matchingApplyResult}
              onOpenPath={onOpenPath}
            />
          ) : null}

          <div className="int-playbook-actions">
            <div>
              <button
                type="button"
                className="btn btn-primary"
                aria-disabled={prepareUnavailableReason ? true : undefined}
                aria-describedby={
                  prepareUnavailableReason ? prepareReasonId : undefined
                }
                aria-busy={applyingRecipeID === recipe.id ? true : undefined}
                onClick={() => {
                  if (!prepareUnavailableReason) onApplyRecipe(recipe);
                }}
              >
                {applyingRecipeID === recipe.id
                  ? "Preparing setup…"
                  : "Prepare setup"}
              </button>
              <button
                type="button"
                className="btn"
                aria-disabled={!hasSetupPath || undefined}
                aria-describedby={!hasSetupPath ? openReasonId : undefined}
                onClick={() => {
                  if (hasSetupPath) onOpenPath(setupPath);
                }}
              >
                Open setup
              </button>
            </div>
            {prepareUnavailableReason ? (
              <ActionReason
                id={prepareReasonId}
                message={prepareUnavailableReason}
                live={Boolean(applyingRecipeID)}
              />
            ) : null}
            {!hasSetupPath ? (
              <ActionReason
                id={openReasonId}
                message="No setup destination was provided for this playbook."
              />
            ) : null}
          </div>
        </div>
      ) : (
        <div className="int-detail-unavailable" role="status">
          <strong>Playbook detail unavailable</strong>
          <p>
            No recipe blueprint is available. Access, mappings, and setup
            behavior remain unknown.
          </p>
        </div>
      )}
    </SlideoverShell>
  );
}

function PlaybookAccessPanel({
  blueprint,
}: {
  blueprint: IntegrationRecipeBlueprint;
}): ReactElement {
  const headingId = useId();
  return (
    <section className="int-playbook-section" aria-labelledby={headingId}>
      <SectionHeading
        id={headingId}
        eyebrow="Preflight"
        title="Access, consent & data handling"
        description="Verify exact scope identifiers, secret-reference names, event bindings, and handling requirements before setup."
      />
      <div className="int-playbook-access-grid">
        <TokenCollection
          title="Required scopes"
          values={blueprint.required_scopes ?? []}
          empty="No required scopes are declared by this playbook."
          exact
        />
        <TokenCollection
          title="Required secret references"
          description="Names only; secret values must never be placed in this surface."
          values={blueprint.required_secrets ?? []}
          empty="No secret references are declared by this playbook."
          exact
        />
        <TokenCollection
          title="Event bindings"
          values={blueprint.events ?? []}
          empty="No event bindings are declared by this playbook."
          exact
        />
        <TokenCollection
          title="Consent & data handling"
          values={blueprint.data_handling ?? []}
          empty="No consent or special data-handling instructions are declared."
        />
      </div>
    </section>
  );
}

function FieldMappings({
  blueprint,
}: {
  blueprint: IntegrationRecipeBlueprint;
}): ReactElement {
  const mappings = blueprint.field_mappings ?? [];
  return (
    <section className="int-field-mapping-panel">
      <header>
        <p className="int-section-eyebrow">Transformation contract</p>
        <h3>Field mappings</h3>
        <p>Exact source-to-destination field paths declared by the playbook.</p>
      </header>
      {mappings.length === 0 ? (
        <EmptyCollection message="No explicit field mappings were provided." />
      ) : (
        <div
          className="int-field-table-wrap"
          role="region"
          aria-label="Scrollable field mappings"
          tabIndex={0}
        >
          <table>
            <caption>
              {mappings.length.toLocaleString()} declared field mappings
            </caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Destination</th>
                <th scope="col">Requirement</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((field, index) => (
                <tr key={`${field.source}-${field.target}-${index}`}>
                  <td>
                    <code>{textValue(field.source)}</code>
                  </td>
                  <td>
                    <code>{textValue(field.target)}</code>
                  </td>
                  <td>
                    <span
                      className="int-mapping-requirement"
                      data-required={field.required ? "true" : "false"}
                    >
                      {field.required ? "Required" : "Optional"}
                    </span>
                  </td>
                  <td>
                    {textValue(
                      field.description,
                      field.required
                        ? "Required mapping; no additional description provided."
                        : "Optional mapping; no additional description provided.",
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PreparationResult({
  result,
  onOpenPath,
}: {
  result: IntegrationRecipeApplyResponse;
  onOpenPath: (path?: string) => void;
}): ReactElement {
  const headingId = useId();
  return (
    <section
      className="int-preparation-result"
      aria-labelledby={headingId}
      aria-live="polite"
    >
      <SectionHeading
        id={headingId}
        eyebrow="Preparation response"
        title="Setup plan prepared"
        description="This is a setup plan response, not proof that a connector was configured or data was transferred."
        status={<StatusBadge value={result.status} />}
      />
      <p className="int-preparation-message">{textValue(result.message)}</p>
      <dl className="int-definition-grid int-definition-grid--compact">
        <div>
          <dt>Delegated to</dt>
          <dd>{textValue(result.delegated_to, "Not delegated")}</dd>
        </div>
        <div>
          <dt>Manage path</dt>
          <dd>{textValue(result.manage_path, "Not provided")}</dd>
        </div>
      </dl>
      <TokenCollection
        title="Additional required fields"
        values={result.required_fields ?? []}
        empty="No additional required fields were returned."
        exact
      />
      <GuideList
        title="Prepared next steps"
        description="Next steps returned by setup preparation."
        steps={result.next_steps ?? []}
        onOpenPath={onOpenPath}
      />
    </section>
  );
}

function recipePreparationUnavailableReason(
  recipe: IntegrationRecipe,
  canAdmin: boolean,
  applyingRecipeID: string,
): string | null {
  if (!recipe.available) {
    return "Planned playbook; blueprint review only.";
  }
  if (!canAdmin) return "Admin role required to prepare setup.";
  if (applyingRecipeID) {
    return "Wait for the current setup preparation to finish.";
  }
  return null;
}

export function RecipeLibrary({
  recipes,
  loading,
  onOpenRecipe,
  onApplyRecipe,
  applyingRecipeID,
  onOpenSource,
  canAdmin,
}: {
  recipes: IntegrationRecipe[];
  loading: boolean;
  onOpenRecipe: (recipe: IntegrationRecipe) => void;
  onApplyRecipe: (recipe: IntegrationRecipe) => void;
  applyingRecipeID: string;
  onOpenSource: (slug: string) => void;
  canAdmin: boolean;
}): ReactElement {
  if (loading) {
    return (
      <div className="int-playbook-library-state" role="status">
        <span aria-hidden="true" />
        <div>
          <strong>Loading setup playbooks</strong>
          <p>Resolving availability, steps, and blueprint metadata.</p>
        </div>
      </div>
    );
  }
  if (recipes.length === 0) {
    return (
      <div className="int-playbook-library-state" data-empty-state="true">
        <span aria-hidden="true" />
        <div>
          <strong>No matching setup playbooks</strong>
          <p>
            No recipes match the current filters. Change the filters to inspect
            additional planned or ready playbooks.
          </p>
        </div>
      </div>
    );
  }
  return (
    <section className="int-playbook-library" aria-label="Setup playbooks">
      <div className="int-playbook-library-grid">
        {recipes.map((recipe, index) => (
          <RecipeLibraryCard
            key={recipe.id}
            recipe={recipe}
            reasonID={`recipe-library-${index}`}
            applyingRecipeID={applyingRecipeID}
            canAdmin={canAdmin}
            onOpenRecipe={onOpenRecipe}
            onApplyRecipe={onApplyRecipe}
            onOpenSource={onOpenSource}
          />
        ))}
      </div>
    </section>
  );
}

function RecipeLibraryCard({
  recipe,
  reasonID,
  applyingRecipeID,
  canAdmin,
  onOpenRecipe,
  onApplyRecipe,
  onOpenSource,
}: {
  recipe: IntegrationRecipe;
  reasonID: string;
  applyingRecipeID: string;
  canAdmin: boolean;
  onOpenRecipe: (recipe: IntegrationRecipe) => void;
  onApplyRecipe: (recipe: IntegrationRecipe) => void;
  onOpenSource: (slug: string) => void;
}): ReactElement {
  const titleId = useId();
  const unavailableReason = recipePreparationUnavailableReason(
    recipe,
    canAdmin,
    applyingRecipeID,
  );
  const busy = applyingRecipeID === recipe.id;
  return (
    <article className="int-playbook-card" aria-labelledby={titleId}>
      <header>
        <div>
          <p>{textValue(recipe.provider)}</p>
          <h3 id={titleId}>{textValue(recipe.name)}</h3>
          <code>{textValue(recipe.id)}</code>
        </div>
        <StatusBadge
          value={recipe.available ? "ready" : "planned"}
          tone={recipe.available ? "success" : "warning"}
        />
      </header>

      <p className="int-playbook-summary">{textValue(recipe.summary)}</p>

      <dl className="int-playbook-card-route">
        <div>
          <dt>Source</dt>
          <dd>
            <code>{textValue(recipe.source_slug)}</code>
          </dd>
        </div>
        <div>
          <dt>Destination</dt>
          <dd>
            <code>{textValue(recipe.target_slug)}</code>
          </dd>
        </div>
        <div>
          <dt>Estimate</dt>
          <dd>{recipeEstimate(recipe.estimated_minutes)}</dd>
        </div>
        <div>
          <dt>Delivery model</dt>
          <dd>{badgeLabel(recipe.badge)}</dd>
        </div>
      </dl>

      <TokenCollection
        title="Capabilities"
        values={recipe.capabilities}
        empty="No capabilities are declared for this playbook."
        exact
      />

      <section className="int-playbook-card-steps">
        <h4>First setup steps</h4>
        {recipe.steps.length === 0 ? (
          <EmptyCollection message="No setup steps are declared for this playbook." />
        ) : (
          <ol>
            {recipe.steps.slice(0, 3).map((step, index) => (
              <li key={`${step.title}-${index}`}>{textValue(step.title)}</li>
            ))}
          </ol>
        )}
        {recipe.steps.length > 3 ? (
          <p>{recipe.steps.length - 3} more steps in the blueprint</p>
        ) : null}
      </section>

      <div className="int-playbook-card-actions">
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={unavailableReason ? true : undefined}
          aria-describedby={unavailableReason ? reasonID : undefined}
          aria-busy={busy ? true : undefined}
          onClick={() => {
            if (!unavailableReason) onApplyRecipe(recipe);
          }}
        >
          {busy ? "Preparing setup…" : "Prepare setup"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onOpenRecipe(recipe)}
        >
          Review blueprint
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onOpenSource(recipe.source_slug)}
        >
          Source details
        </button>
      </div>
      {unavailableReason ? (
        <ActionReason id={reasonID} message={unavailableReason} live={busy} />
      ) : null}
    </article>
  );
}

function GuideList({
  title,
  description,
  steps,
  onOpenPath,
}: {
  title: string;
  description: string;
  steps: IntegrationSetupStep[];
  onOpenPath: (path?: string) => void;
}): ReactElement {
  const headingId = useId();
  return (
    <section className="int-guide-list" aria-labelledby={headingId}>
      <header>
        <p className="int-section-eyebrow">Operator sequence</p>
        <h3 id={headingId}>{title}</h3>
        <p>{description}</p>
      </header>
      {steps.length === 0 ? (
        <EmptyCollection message="No setup steps were returned. Setup behavior remains unknown." />
      ) : (
        <ol>
          {steps.map((step, index) => {
            const hasAction = Boolean(step.action?.trim());
            const hasPath = Boolean(step.path?.trim());
            const reasonId = `${headingId}-step-${index}`;
            return (
              <li key={`${step.title}-${index}`}>
                <span className="int-guide-step-number" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <article>
                  <h4>{textValue(step.title)}</h4>
                  <p>{textValue(step.description)}</p>
                  <TokenCollection
                    title="Required fields"
                    values={step.required_fields ?? []}
                    empty="No required fields are declared for this step."
                    exact
                  />
                  {hasAction ? (
                    <>
                      <button
                        type="button"
                        className="btn"
                        aria-disabled={!hasPath || undefined}
                        aria-describedby={!hasPath ? reasonId : undefined}
                        onClick={() => {
                          if (hasPath) onOpenPath(step.path);
                        }}
                      >
                        {step.action}
                      </button>
                      {!hasPath ? (
                        <ActionReason
                          id={reasonId}
                          message="This step does not provide an action destination."
                        />
                      ) : null}
                    </>
                  ) : (
                    <p className="int-instruction-note">
                      Instruction only; no direct action is provided.
                    </p>
                  )}
                </article>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function RecipeList({
  recipes,
  onOpenPath,
  onOpenRecipe,
  onApplyRecipe,
  applyingRecipeID,
  canAdmin,
}: {
  recipes: IntegrationRecipe[];
  onOpenPath: (path?: string) => void;
  onOpenRecipe: (recipe: IntegrationRecipe) => void;
  onApplyRecipe: (recipe: IntegrationRecipe) => void;
  applyingRecipeID: string;
  canAdmin: boolean;
}): ReactElement {
  const headingId = useId();
  return (
    <section className="int-detail-recipes" aria-labelledby={headingId}>
      <header>
        <p className="int-section-eyebrow">Curated paths</p>
        <h3 id={headingId}>Setup playbooks</h3>
        <p>
          Review the blueprint and prepare an operator-owned setup plan. No
          connection is created from this list alone.
        </p>
      </header>
      {recipes.length === 0 ? (
        <EmptyCollection message="No curated setup playbooks were returned for this connector." />
      ) : (
        <div className="int-detail-recipe-list">
          {recipes.map((recipe, index) => {
            const unavailableReason = recipePreparationUnavailableReason(
              recipe,
              canAdmin,
              applyingRecipeID,
            );
            const reasonId = `${headingId}-prepare-${index}`;
            const pathReasonId = `${headingId}-path-${index}`;
            const hasSetupPath = Boolean(recipe.setup_path?.trim());
            const busy = applyingRecipeID === recipe.id;
            return (
              <article key={recipe.id} className="int-detail-recipe-card">
                <header>
                  <div>
                    <h4>{textValue(recipe.name)}</h4>
                    <p>
                      {textValue(recipe.provider)} ·{" "}
                      {recipeEstimate(recipe.estimated_minutes)}
                    </p>
                  </div>
                  <StatusBadge
                    value={recipe.available ? "ready" : "planned"}
                    tone={recipe.available ? "success" : "warning"}
                  />
                </header>
                <p className="int-playbook-summary">
                  {textValue(recipe.summary)}
                </p>
                <TokenCollection
                  title="Capabilities"
                  values={recipe.capabilities}
                  empty="No capabilities are declared for this playbook."
                  exact
                />
                <div className="int-detail-recipe-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    aria-disabled={unavailableReason ? true : undefined}
                    aria-describedby={unavailableReason ? reasonId : undefined}
                    aria-busy={busy ? true : undefined}
                    onClick={() => {
                      if (!unavailableReason) onApplyRecipe(recipe);
                    }}
                  >
                    {busy ? "Preparing setup…" : "Prepare setup"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onOpenRecipe(recipe)}
                  >
                    Review blueprint
                  </button>
                  <button
                    type="button"
                    className="btn"
                    aria-disabled={!hasSetupPath || undefined}
                    aria-describedby={!hasSetupPath ? pathReasonId : undefined}
                    onClick={() => {
                      if (hasSetupPath) onOpenPath(recipe.setup_path);
                    }}
                  >
                    Open setup
                  </button>
                </div>
                {unavailableReason ? (
                  <ActionReason
                    id={reasonId}
                    message={unavailableReason}
                    live={busy}
                  />
                ) : null}
                {!hasSetupPath ? (
                  <ActionReason
                    id={pathReasonId}
                    message="No setup path is declared for this playbook."
                  />
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
