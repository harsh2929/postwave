/**
 * AEO Sensor — Answer Engine Optimization tracking surface.
 *
 * sto-aeo-sensor (P3, surface=archive)
 *
 * The Moosewave answer to HubSpot's AEO Sensor: a daily probe-rotation
 * harness that hits ChatGPT / Gemini / Perplexity, scores per-brand
 * mention + citation, and exposes a 0-100 daily volatility score over a
 * rolling 14-day window. Lives next to the Archive page because
 * published newsletters are the substrate LLM crawlers index — operators
 * naturally arrive here from Archive.
 *
 * Page shape (top → bottom):
 *
 *   1. Header + KPI tile pack — mention_rate, citation_rate,
 *      volatility_score, ai_referral_pct.
 *   2. Per-engine tile row — most recent rollup per ChatGPT / Gemini /
 *      Perplexity.
 *   3. Brand setup card — brand_terms + brand_domain editor (the AEO
 *      signal can't compute without these).
 *   4. Competitor board — head-to-head mention rates with capped 5
 *      competitor rows.
 *   5. Prompt rotation library — list + add + toggle + delete.
 *   6. Probe audit list — last 50 probes with engine / status / hit
 *      indicators.
 *
 * DEFERRED in this scaffold:
 *   - The real engine clients (ChatGPT / Gemini / Perplexity) are not
 *     wired; the page renders an onboarding banner until
 *     credentials_status flips to 'ready'. Operators can still configure
 *     brand_terms / competitors / prompts so data lands as soon as creds
 *     arrive.
 *   - The fever-chart (multi-engine line over rolling window) is not
 *     drawn yet — the rollups endpoint returns the series and a basic
 *     summary tile, but the dedicated chart component will land in a
 *     follow-up PR.
 */

import { type ReactElement, useEffect, useMemo, useState } from "react";

import { PageHeader } from "../components/PageHeader";
import { SectionHeader } from "../components/SectionHeader";
import { StatStrip, type StatCell } from "../components/StatStrip";
import { toast } from "../components/Toast";
import {
  type AEOCompetitor,
  type AEODailyRollup,
  type AEOEngine,
  type AEOPrompt,
  type AEOPromptCategory,
  type AEOProbe,
  type AEOSensorSummary,
  type AEOSettings,
  api,
} from "../lib/api-client";
import {
  parseAeoCompetitors,
  parseAeoProbes,
  parseAeoPrompts,
  parseAeoSummary,
} from "./aeo-summary-contract";

const PROMPT_CATEGORIES: { key: AEOPromptCategory; label: string }[] = [
  { key: "discovery", label: "Discovery" },
  { key: "comparison", label: "Comparison" },
  { key: "buyer", label: "Buyer" },
  { key: "support", label: "Support" },
  { key: "other", label: "Other" },
];

const ENGINE_LABEL: Record<AEOEngine, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  perplexity: "Perplexity",
  grok: "Grok",
  copilot: "Copilot",
  _all: "All engines",
};

function pct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

function scoreColor(score: number): string {
  if (score >= 60) return "var(--pw-danger)";
  if (score >= 30) return "var(--pw-warning)";
  return "var(--pw-success)";
}

/* ---------- main component ----------------------------------------- */

export function AEOSensor(): ReactElement {
  const [summary, setSummary] = useState<AEOSensorSummary | null>(null);
  const [prompts, setPrompts] = useState<AEOPrompt[]>([]);
  const [probes, setProbes] = useState<AEOProbe[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const [s, p, pr] = await Promise.all([
        api.getAEOSummary(),
        api.listAEOPrompts(),
        api.listAEOProbes({ limit: 50 }),
      ]);
      if (cancelled) return;
      let contractError: string | null = null;
      if (!s.error) {
        const parsed = parseAeoSummary(s.data);
        if (parsed) setSummary(parsed);
        else {
          setSummary(null);
          contractError = "AEO summary response was malformed.";
        }
      }
      if (!p.error) {
        const parsed = parseAeoPrompts(p.data);
        if (parsed) setPrompts(parsed);
        else {
          setPrompts([]);
          contractError ??= "AEO prompts response was malformed.";
        }
      }
      if (!pr.error) {
        const parsed = parseAeoProbes(pr.data);
        if (parsed) setProbes(parsed);
        else {
          setProbes([]);
          contractError ??= "AEO probes response was malformed.";
        }
      }
      // Surface load failures — pre-fix all three error results were
      // ignored and an outage rendered as a healthy zero-KPI page.
      const firstErr = s.error ?? p.error ?? pr.error;
      setErr(firstErr ? (firstErr.message ?? "Unknown error") : contractError);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const tiles = useMemo<StatCell[]>(() => {
    const v = summary?.volatility_score ?? 0;
    // [D09-analytics-dashboard#6] When every latest rollup has sample_size=0
    // no engine was actually queried (stub mode / no credentials). Render
    // "—" instead of a measured-looking 0.0% so the strip doesn't claim a
    // 0% brand-mention rate that was never measured.
    const measured = (summary?.latest_rollups ?? []).some(
      (r) => r.sample_size > 0,
    );
    const rate = (x: number | undefined): string =>
      measured ? pct(x ?? 0) : "—";
    const noSampleHint = summary
      ? "No measured sample yet — add engine credentials in Brand setup to begin probing."
      : undefined;
    return [
      {
        label: "Mention rate",
        value: rate(summary?.overall_mention_rate),
        hint: measured
          ? "% of AI responses that mention your brand"
          : (noSampleHint ?? "% of AI responses that mention your brand"),
      },
      {
        label: "Citation rate",
        value: rate(summary?.overall_citation_rate),
        hint: measured
          ? "% that link to your domain"
          : (noSampleHint ?? "% that link to your domain"),
      },
      {
        label: "Volatility",
        value: measured ? v.toFixed(1) : "—",
        hint: "0-100; higher = more re-shuffling",
      },
      {
        label: "AI referral",
        value: rate(summary?.ai_referral_pct),
        hint: "% of archive traffic from AI crawlers",
      },
    ];
  }, [summary]);

  async function reloadSummary(): Promise<void> {
    const s = await api.getAEOSummary();
    if (s.error) {
      setErr(s.error.message ?? "Unable to refresh AEO summary.");
      return;
    }
    const parsed = parseAeoSummary(s.data);
    if (!parsed) {
      setErr("AEO summary response was malformed.");
      return;
    }
    setSummary(parsed);
    setErr(null);
  }

  async function reloadPrompts(): Promise<void> {
    const p = await api.listAEOPrompts();
    if (p.error) {
      setErr(p.error.message ?? "Unable to refresh AEO prompts.");
      return;
    }
    const parsed = parseAeoPrompts(p.data);
    if (!parsed) {
      setErr("AEO prompts response was malformed.");
      return;
    }
    setPrompts(parsed);
    setErr(null);
  }

  async function onRunNow(): Promise<void> {
    setRunning(true);
    const res = await api.runAEONow();
    setRunning(false);
    if (res.error) {
      toast.error({
        message: "Probe run failed",
        detail: res.error.message ?? "See server logs",
      });
      return;
    }
    // [D09-analytics-dashboard#6] In stub mode (no engine clients wired)
    // every probe is recorded with status "skipped" and the rollups come
    // back sample_size=0, yet probesWritten still increments. Don't imply a
    // measurement happened — tell the operator the probes never reached an
    // engine so the 0.0% KPIs aren't read as measured.
    const n = res.data?.probes ?? 0;
    const measured = (res.data?.rollups ?? []).some((r) => r.sample_size > 0);
    if (measured) {
      toast.success({
        message: "Probe pass complete",
        detail: `${n} probes recorded`,
      });
    } else {
      toast.info({
        message: "Probe pass complete",
        detail: `${n} probes ran, but none reached an AI engine yet — add engine credentials in Brand setup to start measuring.`,
      });
    }
    await reloadSummary();
    const pr = await api.listAEOProbes({ limit: 50 });
    if (pr.error) {
      setErr(pr.error.message ?? "Unable to refresh AEO probes.");
      return;
    }
    const parsedProbes = parseAeoProbes(pr.data);
    if (!parsedProbes) {
      setErr("AEO probes response was malformed.");
      return;
    }
    setProbes(parsedProbes);
  }

  return (
    <div className="page">
      <PageHeader
        title="AEO Sensor"
        subtitle="Track how ChatGPT, Gemini, and Perplexity cite your brand."
        actions={[
          {
            label: running ? "Running…" : "Run probe pass now",
            onClick: () => void onRunNow(),
            variant: "primary",
            disabled: running,
          },
        ]}
      />

      {err ? (
        <div className="notice">
          <span>Couldn&apos;t load AEO Sensor data: {err}</span>
        </div>
      ) : null}

      {summary?.warning_banner ? (
        <div
          role="status"
          className="banner banner-warn"
          style={{
            background: "color-mix(in srgb, var(--pw-warning) 14%, var(--pw-bg-elev))",
            border: "1px solid color-mix(in srgb, var(--pw-warning) 42%, var(--pw-border))",
            padding: "10px 14px",
            borderRadius: 6,
            margin: "12px 0",
            fontSize: 13,
          }}
        >
          {summary.warning_banner}
        </div>
      ) : null}

      {/* [D09-analytics-dashboard#6] The server only emits warning_banner
          while there are zero rollups, so it disappears after a single stub
          run even though no engine credentials are configured. Keep the
          setup guidance visible whenever credentials aren't ready. */}
      {summary &&
      !summary.warning_banner &&
      summary.settings.credentials_status !== "ready" ? (
        <div
          role="status"
          className="banner banner-warn"
          style={{
            background: "color-mix(in srgb, var(--pw-warning) 14%, var(--pw-bg-elev))",
            border: "1px solid color-mix(in srgb, var(--pw-warning) 42%, var(--pw-border))",
            padding: "10px 14px",
            borderRadius: 6,
            margin: "12px 0",
            fontSize: 13,
          }}
        >
          No AI engine credentials are configured yet — probe passes are
          recorded as skipped and the metrics above stay unmeasured. Add
          engine credentials to start probing.
        </div>
      ) : null}

      <StatStrip cells={tiles} />

      {/* Per-engine rollups */}
      <SectionHeader title="Per-engine snapshot" />
      <PerEngineGrid rollups={summary?.latest_rollups ?? []} />

      {/* Brand + competitor configuration */}
      <SectionHeader title="Brand setup" />
      <BrandSetupCard
        settings={summary?.settings ?? null}
        onSaved={() => void reloadSummary()}
      />

      <SectionHeader title="Competitor comparison" />
      <CompetitorBoard
        scores={summary?.competitor_board ?? []}
        onChanged={() => void reloadSummary()}
      />

      {/* Prompts */}
      <SectionHeader title="Prompt rotation" />
      <PromptLibrary
        prompts={prompts}
        onChanged={() => void reloadPrompts()}
      />

      {/* Probe audit */}
      <SectionHeader title="Recent probes" />
      <ProbeAudit probes={probes} loading={loading} />
    </div>
  );
}

/* ---------- per-engine card grid ----------------------------------- */

function PerEngineGrid({
  rollups,
}: {
  rollups: AEODailyRollup[];
}): ReactElement {
  const byEngine = useMemo(() => {
    const map = new Map<AEOEngine, AEODailyRollup>();
    for (const r of rollups) {
      if (r.engine === "_all") continue;
      if (!map.has(r.engine)) map.set(r.engine, r);
    }
    return map;
  }, [rollups]);

  const engines: AEOEngine[] = ["chatgpt", "gemini", "perplexity"];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: 12,
        marginBottom: 20,
      }}
    >
      {engines.map((eng) => {
        const r = byEngine.get(eng);
        return (
          <div
            key={eng}
            className="card"
            style={{
              padding: 14,
              border: "1px solid var(--pw-border)",
              borderRadius: 6,
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: "var(--pw-fg-muted)",
                marginBottom: 4,
              }}
            >
              {ENGINE_LABEL[eng]}
            </div>
            {r ? (
              <>
                <div style={{ fontSize: 22, fontWeight: 600 }}>
                  {pct(r.mention_rate)}
                </div>
                <div style={{ fontSize: 12, marginTop: 6 }}>
                  Citation {pct(r.citation_rate)} · Sample {r.sample_size}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    marginTop: 4,
                    color: scoreColor(r.volatility_score),
                  }}
                >
                  Volatility {r.volatility_score.toFixed(1)}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13, color: "var(--pw-fg-muted)" }}>
                No data yet — waiting for first probe pass.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- brand setup card --------------------------------------- */

function BrandSetupCard({
  settings,
  onSaved,
}: {
  settings: AEOSettings | null;
  onSaved: () => void;
}): ReactElement {
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [domain, setDomain] = useState(settings?.brand_domain ?? "");
  const [termsText, setTermsText] = useState(
    (settings?.brand_terms ?? []).join(", "),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setDomain(settings.brand_domain);
    setTermsText(settings.brand_terms.join(", "));
  }, [settings]);

  async function onSave(): Promise<void> {
    setSaving(true);
    const terms = termsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 8);
    const res = await api.putAEOSettings({
      enabled,
      brand_domain: domain.trim(),
      brand_terms: terms,
    });
    setSaving(false);
    if (res.error) {
      toast.error({
        message: "Save failed",
        detail: res.error.message ?? "",
      });
      return;
    }
    toast.success("Brand setup saved");
    onSaved();
  }

  return (
    <div
      className="card"
      style={{
        padding: 16,
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        marginBottom: 20,
      }}
    >
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.currentTarget.checked)}
        />
        <span>Enable AEO Sensor probing</span>
      </label>
      <div style={{ marginBottom: 12 }}>
        <label
          htmlFor="aeo-brand-domain"
          style={{ display: "block", fontSize: 12, marginBottom: 4 }}
        >
          Brand domain (for citation_rate)
        </label>
        <input
          id="aeo-brand-domain"
          type="text"
          value={domain}
          placeholder="moosewave.com"
          onChange={(e) => setDomain(e.currentTarget.value)}
          style={{ width: "100%", maxWidth: 320, padding: 6 }}
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label
          htmlFor="aeo-brand-terms"
          style={{ display: "block", fontSize: 12, marginBottom: 4 }}
        >
          Brand terms (comma-separated, max 8)
        </label>
        <input
          id="aeo-brand-terms"
          type="text"
          value={termsText}
          placeholder="Moosewave, Moosewave Marketing, postwave"
          onChange={(e) => setTermsText(e.currentTarget.value)}
          style={{ width: "100%", maxWidth: 480, padding: 6 }}
        />
      </div>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => void onSave()}
        disabled={saving}
      >
        {saving ? "Saving…" : "Save brand setup"}
      </button>
    </div>
  );
}

/* ---------- competitor board --------------------------------------- */

function CompetitorBoard({
  scores,
  onChanged,
}: {
  scores: AEOSensorSummary["competitor_board"];
  onChanged: () => void;
}): ReactElement {
  const [competitors, setCompetitors] = useState<AEOCompetitor[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Partial<AEOCompetitor>>({
    competitor_key: "",
    display_name: "",
    terms: [],
    domain: "",
  });

  useEffect(() => {
    void (async () => {
      const res = await api.listAEOCompetitors();
      if (res.error) {
        setLoadError(res.error.message ?? "Unable to load competitors.");
        return;
      }
      const parsed = parseAeoCompetitors(res.data);
      if (!parsed) {
        setLoadError("AEO competitors response was malformed.");
        return;
      }
      setCompetitors(parsed);
      setLoadError(null);
    })();
  }, []);

  async function onAdd(): Promise<void> {
    const key = (draft.competitor_key ?? "").trim().toLowerCase();
    const name = (draft.display_name ?? "").trim();
    if (!key || !name) {
      toast.error("Key + display name required");
      return;
    }
    setAdding(true);
    const res = await api.upsertAEOCompetitor({
      competitor_key: key,
      display_name: name,
      terms: draft.terms ?? [],
      domain: draft.domain ?? "",
    });
    setAdding(false);
    if (res.error) {
      toast.error({
        message: "Add competitor failed",
        detail: res.error.message ?? "",
      });
      return;
    }
    setDraft({ competitor_key: "", display_name: "", terms: [], domain: "" });
    const refreshed = await api.listAEOCompetitors();
    if (refreshed.error) {
      setLoadError(refreshed.error.message ?? "Unable to refresh competitors.");
    } else {
      const parsed = parseAeoCompetitors(refreshed.data);
      if (parsed) {
        setCompetitors(parsed);
        setLoadError(null);
      } else {
        setLoadError("AEO competitors response was malformed.");
      }
    }
    onChanged();
  }

  async function onRemove(key: string): Promise<void> {
    const res = await api.deleteAEOCompetitor(key);
    if (res.error) {
      toast.error("Remove failed");
      return;
    }
    setCompetitors((cs) => cs.filter((c) => c.competitor_key !== key));
    onChanged();
  }

  const scoreByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of scores) m.set(s.key, s.mention_rate);
    return m;
  }, [scores]);

  return (
    <div
      className="card"
      style={{
        padding: 16,
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        marginBottom: 20,
      }}
    >
      {loadError ? (
        <div className="notice" style={{ marginBottom: 12 }}>
          Couldn&apos;t load competitor configuration: {loadError}
        </div>
      ) : null}
      {competitors.length === 0 ? (
        <div
          style={{
            fontSize: 13,
            color: "var(--pw-fg-muted)",
            marginBottom: 12,
          }}
        >
          Add up to 5 competitors to track head-to-head mention rates.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", fontSize: 12 }}>
              <th>Competitor</th>
              <th>Domain</th>
              <th style={{ textAlign: "right" }}>Mention rate</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {competitors.map((c) => (
              <tr key={c.competitor_key} style={{ borderTop: "1px solid var(--pw-border)" }}>
                <td style={{ padding: "6px 0" }}>
                  <strong>{c.display_name}</strong>
                  <span style={{ color: "var(--pw-fg-muted)", marginLeft: 6 }}>
                    ({c.competitor_key})
                  </span>
                </td>
                <td>{c.domain || "—"}</td>
                <td style={{ textAlign: "right" }}>
                  {pct(scoreByKey.get(c.competitor_key) ?? 0)}
                </td>
                <td style={{ textAlign: "right" }}>
                  <button
                    type="button"
                    className="btn btn-link"
                    onClick={() => void onRemove(c.competitor_key)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {competitors.length < 5 ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr 1fr auto",
            gap: 8,
          }}
        >
          <input
            type="text"
            placeholder="key"
            value={draft.competitor_key ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, competitor_key: e.currentTarget.value })
            }
          />
          <input
            type="text"
            placeholder="Display name"
            value={draft.display_name ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, display_name: e.currentTarget.value })
            }
          />
          <input
            type="text"
            placeholder="terms (comma-sep)"
            value={(draft.terms ?? []).join(", ")}
            onChange={(e) =>
              setDraft({
                ...draft,
                terms: e.currentTarget.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
          <input
            type="text"
            placeholder="domain"
            value={draft.domain ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, domain: e.currentTarget.value })
            }
          />
          <button
            type="button"
            className="btn"
            onClick={() => void onAdd()}
            disabled={adding}
          >
            {adding ? "Adding…" : "Add"}
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "var(--pw-fg-muted)" }}>
          Maximum 5 competitors reached. Remove one to add another.
        </div>
      )}
    </div>
  );
}

/* ---------- prompt library ----------------------------------------- */

function PromptLibrary({
  prompts,
  onChanged,
}: {
  prompts: AEOPrompt[];
  onChanged: () => void;
}): ReactElement {
  const [text, setText] = useState("");
  const [category, setCategory] = useState<AEOPromptCategory>("discovery");
  const [busy, setBusy] = useState(false);

  async function onAdd(): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length < 4) return;
    setBusy(true);
    const res = await api.createAEOPrompt({
      category,
      prompt_text: trimmed,
    });
    setBusy(false);
    if (res.error) {
      toast.error("Add prompt failed");
      return;
    }
    setText("");
    onChanged();
  }

  async function onToggle(p: AEOPrompt): Promise<void> {
    const res = await api.toggleAEOPrompt(p.id, !p.enabled);
    if (res.error) {
      toast.error({
        message: `${p.enabled ? "Disable" : "Enable"} prompt failed`,
        detail: res.error.message ?? "",
      });
      return;
    }
    onChanged();
  }

  async function onDelete(p: AEOPrompt): Promise<void> {
    const res = await api.deleteAEOPrompt(p.id);
    if (res.error) {
      toast.error({
        message: "Delete prompt failed",
        detail: res.error.message ?? "",
      });
      return;
    }
    onChanged();
  }

  return (
    <div
      className="card"
      style={{
        padding: 16,
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        marginBottom: 20,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "120px 1fr auto",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <select
          aria-label="Prompt category"
          value={category}
          onChange={(e) => setCategory(e.currentTarget.value as AEOPromptCategory)}
        >
          {PROMPT_CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Best email marketing platform for ecommerce?"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
        />
        <button
          type="button"
          className="btn"
          onClick={() => void onAdd()}
          disabled={busy || text.trim().length < 4}
        >
          {busy ? "Adding…" : "Add prompt"}
        </button>
      </div>

      {prompts.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--pw-fg-muted)" }}>
          No prompts yet. Add a discovery-style prompt to start probing.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", fontSize: 12 }}>
              <th>Category</th>
              <th>Prompt</th>
              <th>Source</th>
              <th>Enabled</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {prompts.map((p) => (
              <tr key={p.id} style={{ borderTop: "1px solid var(--pw-border)" }}>
                <td style={{ padding: "6px 0", textTransform: "capitalize" }}>
                  {p.category}
                </td>
                <td>{p.prompt_text}</td>
                <td style={{ fontSize: 12, color: "var(--pw-fg-muted)" }}>
                  {p.source}
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={() => void onToggle(p)}
                  />
                </td>
                <td style={{ textAlign: "right" }}>
                  <button
                    type="button"
                    className="btn btn-link"
                    onClick={() => void onDelete(p)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ---------- probe audit -------------------------------------------- */

function ProbeAudit({
  probes,
  loading,
}: {
  probes: AEOProbe[];
  loading: boolean;
}): ReactElement {
  if (loading) {
    return (
      <div style={{ fontSize: 13, color: "var(--pw-fg-muted)" }}>
        Loading recent probes…
      </div>
    );
  }
  if (probes.length === 0) {
    return (
      <div
        className="card"
        style={{
          padding: 16,
          border: "1px dashed var(--pw-border)",
          borderRadius: 6,
          fontSize: 13,
          color: "var(--pw-fg-muted)",
        }}
      >
        No probes recorded yet. Run a pass after configuring brand terms +
        enabling at least one engine.
      </div>
    );
  }
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ textAlign: "left", fontSize: 12 }}>
          <th>Engine</th>
          <th>Mentioned</th>
          <th>Cited</th>
          <th>Status</th>
          <th>Probed at</th>
        </tr>
      </thead>
      <tbody>
        {probes.map((p) => (
          <tr key={p.id} style={{ borderTop: "1px solid var(--pw-border)" }}>
            <td style={{ padding: "6px 0" }}>{ENGINE_LABEL[p.engine] ?? p.engine}</td>
            <td>{p.mentioned ? "Yes" : "No"}</td>
            <td>{p.cited ? "Yes" : "No"}</td>
            <td style={{ textTransform: "capitalize" }}>{p.status}</td>
            <td style={{ fontSize: 12, color: "var(--pw-fg-muted)" }}>
              {new Date(p.probed_at).toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
