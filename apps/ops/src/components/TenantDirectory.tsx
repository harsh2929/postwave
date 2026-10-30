// SPDX-License-Identifier: AGPL-3.0-only

import KillSwitchButton from "@/components/KillSwitchButton";
import Badge, { type BadgeVariant } from "@/components/Badge";

import {
  MAX_TENANT_ROWS,
  MAX_TENANT_SEARCH_LENGTH,
  type TenantHealth,
  type TenantRow,
} from "@/lib/tenants";

const HEALTH_VARIANT: Record<TenantHealth, BadgeVariant> = {
  ok: "green",
  dunning: "amber",
  suspended: "red",
};

interface TenantDirectoryProps {
  search: string;
  tenants: TenantRow[];
  truncated: boolean;
}

function tenantControls(tenant: TenantRow): string {
  const controls = [
    tenant.dunning ? "Dunning" : undefined,
    tenant.sending_paused ? "Sending paused" : undefined,
  ].filter((value): value is string => Boolean(value));
  return controls.length > 0 ? controls.join(", ") : "Normal";
}

// Render the period-end as a UTC calendar date. Slicing the raw ISO string's
// first 10 chars would echo whatever offset the API sent (e.g. a "-05:00"
// timestamp near midnight would show the wrong day); normalising through Date
// pins every row to the same UTC day. Unparseable input degrades to "—".
function periodEndUTC(iso: string | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "—" : new Date(ms).toISOString().slice(0, 10);
}

export function TenantDirectoryError({ message }: { message: string }) {
  return (
    <main
      id="main-content" tabIndex={-1}
      className="fail"
      role="alert"
      aria-labelledby="tenant-directory-error-title"
    >
      <h1 id="tenant-directory-error-title" className="fail__title">
        TENANT DIRECTORY UNAVAILABLE
      </h1>
      <p className="fail__msg">{message}</p>
      <p className="fail__note">
        Unknown is not empty. Assume something is wrong until it loads.
      </p>
    </main>
  );
}

export function TenantDirectory({ search, tenants, truncated }: TenantDirectoryProps) {
  const emptyMessage = search
    ? `No tenants matched “${search}”.`
    : "No tenants were returned. Verify that this is expected before treating the directory as clear.";

  return (
    <main id="main-content" tabIndex={-1} className="page">
      <header className="page__head">
        <h1 className="page__title">
          Tenants <span className="page__count">({tenants.length})</span>
        </h1>
      </header>

      <form
        action="/tenants"
        method="get"
        role="search"
        aria-label="Tenant directory search"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem",
          margin: "1rem 0 1.5rem",
        }}
      >
        <label htmlFor="tenant-search" style={{ alignSelf: "center" }}>
          Search
        </label>
        <input
          id="tenant-search"
          name="search"
          type="search"
          maxLength={MAX_TENANT_SEARCH_LENGTH}
          defaultValue={search}
          aria-describedby="tenant-search-help"
          style={{ minWidth: 0, flex: "1 1 20rem", maxWidth: "28rem" }}
        />
        <button type="submit">Find tenants</button>
      </form>
      <p id="tenant-search-help" style={{ color: "var(--text-3)", fontSize: "0.8rem" }}>
        Search by tenant name or slug. At most {MAX_TENANT_ROWS} rows are shown.
      </p>

      {truncated ? (
        <p role="status" className="note note--warn">
          The {MAX_TENANT_ROWS}-row result cap was reached. Refine the search before
          assuming a tenant is absent.
        </p>
      ) : null}

      {tenants.length === 0 ? (
        <p role="status" className={search ? "note note--info" : "note note--warn"}>
          {emptyMessage}
        </p>
      ) : (
        <div className="scroll-x panel">
          <table style={{ minWidth: "52rem", fontSize: "0.9rem" }}>
            <caption>
              Cross-tenant operator directory. Health and controls are stated in
              text and do not rely on color alone.
            </caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Slug</th>
                <th scope="col">Tier</th>
                <th scope="col">Health</th>
                <th scope="col">Controls</th>
                <th scope="col">Period end (UTC)</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => (
                <tr key={tenant.tenant_id}>
                  <th scope="row" style={{ textAlign: "left" }}>
                    {tenant.name}
                  </th>
                  <td><span className="check__id">{tenant.slug}</span></td>
                  <td><span className="badge badge--muted">{tenant.tier}</span></td>
                  <td><Badge variant={HEALTH_VARIANT[tenant.health]}>{tenant.health}</Badge></td>
                  <td>
                    <Badge variant={tenant.sending_paused ? "red" : tenant.dunning ? "amber" : "neutral"} muted={!tenant.sending_paused && !tenant.dunning}>
                      {tenantControls(tenant)}
                    </Badge>
                  </td>
                  <td
                    style={{ color: "var(--text-3)", whiteSpace: "nowrap" }}
                    title={tenant.current_period_end ?? undefined}
                  >
                    {periodEndUTC(tenant.current_period_end)}
                  </td>
                  <td>
                    <KillSwitchButton
                      tenantId={tenant.tenant_id}
                      tenantSlug={tenant.slug}
                      paused={tenant.sending_paused}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
