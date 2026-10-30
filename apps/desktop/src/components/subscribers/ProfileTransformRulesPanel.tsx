/**
 * ProfileTransformRulesPanel — the first UI for the profile-transform-rules
 * engine (apps/api/internal/subscribers, property_transforms.go). The backend
 * derives normalized keys under a subscriber's custom_fields from existing
 * profile fields — copy / lowercase / uppercase / trim / date / number /
 * boolean / json_path — with full GET/POST/DELETE, but shipped with no client,
 * so operators couldn't see or manage their tenant's transform rules from the
 * app. This lists the rules with their source → target mapping, transform kind,
 * and status.
 *
 * Read-first: the mutating methods (upsert / remove) exist on the client
 * (createprofileTransformRulesApi); the gap this closes is visibility, so the
 * panel starts there.
 *
 * Constructed from the shared apiRequest + the factory rather than editing the
 * shared api-client barrel, so this feature adds exactly two new files.
 */
import { useEffect, useState } from "react";

import { profileTransformRulesApi } from "../../lib/api-client";
import type { PropertyTransformRule } from "../../lib/api/profile-transform-rules";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; rules: PropertyTransformRule[] };

// Human labels for the engine's transform kinds.
const TRANSFORM_LABEL: Record<string, string> = {
  copy: "Copy",
  lowercase: "Lowercase",
  uppercase: "Uppercase",
  trim: "Trim",
  date: "Date",
  number: "Number",
  boolean: "Boolean",
  json_path: "JSON path",
};

export function ProfileTransformRulesPanel() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    profileTransformRulesApi
      .list()
      .then((res) => {
        if (!alive) return;
        setState(
          res.error
            ? { kind: "error", message: res.error.message }
            : { kind: "ready", rules: res.data },
        );
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setState({
          kind: "error",
          message:
            error instanceof Error ? error.message : "Unexpected request error",
        });
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section
      aria-label="Profile transform rules"
      style={{ display: "grid", gap: 12, padding: 12 }}
    >
      <header>
        <h3 style={{ margin: 0, fontSize: 14 }}>Profile transform rules</h3>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
          Derive normalized keys under each subscriber’s custom fields from
          existing profile data.
        </p>
      </header>

      {state.kind === "loading" ? (
        <div className="skel" style={{ height: 12, width: "55%" }} />
      ) : null}
      {state.kind === "error" ? (
        <p
          role="alert"
          className="muted"
          style={{ fontSize: 12, margin: 0, color: "var(--pw-danger)" }}
        >
          Couldn’t load transform rules: {state.message}
        </p>
      ) : null}
      {state.kind === "ready" && state.rules.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          No transform rules yet. Rules map a source field to a normalized
          target key each time a profile is saved.
        </p>
      ) : null}
      {state.kind === "ready" && state.rules.length > 0 ? (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gap: 8,
          }}
        >
          {state.rules.map((rule) => (
            <RuleRow key={rule.id} rule={rule} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case "active":
      return "var(--pw-success)";
    case "paused":
      return "var(--pw-warning)";
    case "archived":
      return "var(--pw-fg-muted)";
    default:
      return "var(--pw-fg-muted)";
  }
}

function RuleRow({ rule }: { rule: PropertyTransformRule }) {
  const transformLabel = TRANSFORM_LABEL[rule.transform] ?? rule.transform;

  return (
    <li
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: "var(--pw-radius-md, 8px)",
        background: "var(--pw-bg-elev)",
        padding: "10px 12px",
        display: "grid",
        gap: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontWeight: 600 }}>{rule.name}</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: "1px 8px",
            borderRadius: "var(--pw-radius-pill, 999px)",
            color: statusColor(rule.status),
            background: "color-mix(in srgb, currentColor 16%, transparent)",
          }}
        >
          {rule.status}
        </span>
        <span
          className="muted"
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: "1px 8px",
            borderRadius: "var(--pw-radius-pill, 999px)",
            border: "1px solid var(--pw-border)",
            marginLeft: "auto",
          }}
        >
          {transformLabel}
        </span>
      </div>
      <div
        className="muted tabular"
        style={{
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        <code style={{ fontSize: 12 }}>{rule.source_path}</code>
        <span aria-hidden>→</span>
        <code style={{ fontSize: 12 }}>custom_fields.{rule.target_key}</code>
      </div>
    </li>
  );
}
