/**
 * SocialCaptureSection — "Social capture" block on the Forms page
 * (apps/api/internal/social_capture — ROADMAP-WRAPPERS T3).
 *
 * Desktop surface: the network catalog, auto-reply capture rules
 * (list/create, with the server's dry-run validator run before every
 * create), the captured-leads table (rule-filterable; the wire
 * exposes no paging), and tap-to-text links (list/create — the server
 * mints slug + sms_uri + public_url). This is the CAPTURE-RULE side
 * of tap-to-text; the SMS composer's TapToTextBlockEditor renders the
 * block inside messages and stays a separate surface.
 *
 * NOT wired (machine-to-machine per the manifest): auto-reply event
 * ingestion, tap-to-text consent callbacks, the public slug redirect.
 * Creates are admin-scoped; lists need read scopes only.
 */

import { type ReactElement, useCallback, useEffect, useState } from "react";

import { ConfirmModal } from "../ConfirmModal";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";
import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import { lifecycleOperationError } from "../../hooks/useSettingsDraftLifecycle";
import {
  type SocialCaptureLead,
  type SocialCaptureRule,
  type SocialCaptureTapLink,
  socialCaptureApi,
} from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import {
  type CatalogNetwork,
  type RuleDraft,
  type RuleVerdict,
  type TapLinkDraft,
  answersCount,
  buildRuleInput,
  buildTapLinkInput,
  catalogNetworks,
  leadIdentity,
  newRuleDraft,
  newTapLinkDraft,
  ruleVerdict,
} from "./social-capture-helpers";

type Tab = "rules" | "leads" | "taptotext";
const SOCIAL_CAPTURE_TABS: readonly { value: Tab; label: string }[] = [
  { value: "rules", label: "Capture rules" },
  { value: "leads", label: "Leads" },
  { value: "taptotext", label: "Tap-to-text" },
];

function VerdictNotice({ v }: { v: RuleVerdict | null }): ReactElement | null {
  if (!v) return null;
  if (v.valid !== false && v.errors.length === 0 && v.warnings.length === 0) {
    return null;
  }
  return (
    <div className="notice" role="alert" style={{ marginBottom: 10 }}>
      <span style={{ fontSize: 12 }}>
        {v.valid === false || v.errors.length > 0 ? (
          <>
            <strong>Validation failed:</strong>
            {v.errors.length > 0 ? (
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {v.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            ) : (
              " the server rejected the rule without details."
            )}
          </>
        ) : null}
        {v.warnings.length > 0 ? (
          <>
            <strong>Warnings:</strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {v.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </>
        ) : null}
      </span>
    </div>
  );
}

export function SocialCaptureSection(): ReactElement {
  const canAdmin = useCanAdmin();
  const [tab, setTab] = useState<Tab>("rules");
  const [networks, setNetworks] = useState<CatalogNetwork[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const tabs = useTabsInteraction({
    activation: "manual",
    value: tab,
    items: SOCIAL_CAPTURE_TABS,
    onChange: setTab,
  });

  useEffect(() => {
    void (async () => {
      const res = await socialCaptureApi.catalog();
      if (res.error) {
        if (res.error.status === 404 || res.error.status === 501) {
          setUnavailable(true);
        }
        setNetworks([]);
        return;
      }
      setNetworks(catalogNetworks(res.data));
    })();
  }, []);

  return (
    <div style={{ marginTop: 32 }}>
      <SectionHeader
        title="Social capture"
        description="Turn social DMs and comments into subscribers: auto-reply rules capture leads, tap-to-text links capture SMS opt-ins."
        helpText="Lead events arrive from the connected social platforms machine-to-machine — this section manages the rules and shows what they captured. Tap-to-text links here are the capture side; the SMS composer's tap-to-text block is a separate message-content surface."
      />

      {unavailable ? (
        <p className="muted" style={{ fontSize: 12 }}>
          This API build doesn&apos;t expose social capture
          (/api/v1/social-capture returned not-found). Upgrade the backend to
          use it.
        </p>
      ) : (
        <>
          {networks && networks.length > 0 ? (
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                marginBottom: 12,
                alignItems: "center",
              }}
            >
              <span className="muted" style={{ fontSize: 11 }}>
                Supported networks:
              </span>
              {networks.map((n) => (
                <span
                  key={n.key}
                  className="badge"
                  title={
                    n.capabilities.length > 0
                      ? `Capabilities: ${n.capabilities.join(", ")}`
                      : undefined
                  }
                >
                  {n.label}
                </span>
              ))}
            </div>
          ) : networks && networks.length === 0 ? (
            <p className="muted" style={{ fontSize: 11, marginBottom: 12 }}>
              Network catalog unavailable or in an unrecognised shape — rules
              can still be created with a free-form network key.
            </p>
          ) : null}

          <div
            ref={tabs.listRef}
            {...tabs.listProps}
            aria-label="Social capture sections"
            style={{ display: "flex", gap: 6, marginBottom: 14 }}
          >
            {SOCIAL_CAPTURE_TABS.map((item) => (
              <button
                key={item.value}
                type="button"
                {...tabs.getTabProps(item.value)}
                className={`chip${tab === item.value ? " is-active" : ""}`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div {...tabs.getPanelProps("rules")}>
            <RulesTab canAdmin={canAdmin} networks={networks ?? []} />
          </div>
          <div {...tabs.getPanelProps("leads")}>
            <LeadsTab />
          </div>
          <div {...tabs.getPanelProps("taptotext")}>
            <TapToTextTab canAdmin={canAdmin} />
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- capture rules ---------------------------------------------- */

function RulesTab({
  canAdmin,
  networks,
}: {
  canAdmin: boolean;
  networks: CatalogNetwork[];
}): ReactElement {
  const [items, setItems] = useState<SocialCaptureRule[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [draftErr, setDraftErr] = useState<{
    field: string;
    error: string;
  } | null>(null);
  const [verdict, setVerdict] = useState<RuleVerdict | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const res = await socialCaptureApi.listRules();
    if (res.error) {
      setErr(res.error.message);
      setItems([]);
      return;
    }
    setErr(null);
    setItems(res.data?.items ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<boolean> => {
    if (!draft) return false;
    setDraftErr(null);
    setVerdict(null);
    const built = buildRuleInput(draft);
    if (!built.ok) {
      setDraftErr({ field: built.field, error: built.error });
      return false;
    }
    // Dry-run validate first: create 400s on invalid rules too, but
    // the explicit validate call yields the field-level verdict.
    const check = await socialCaptureApi.validateRule(built.rule);
    if (check.error) {
      toast.error(`Validation call failed: ${check.error.message}`);
      return false;
    }
    const v = ruleVerdict(check.data);
    setVerdict(v);
    if (v.valid === false || v.errors.length > 0) {
      return false;
    }
    const res = await socialCaptureApi.createRule(built.rule);
    if (res.error) {
      toast.error(`Create failed: ${res.error.message}`);
      return false;
    }
    toast.success(`Capture rule "${built.rule.name}" created`);
    setDraft(null);
    setVerdict(null);
    void load();
    return true;
  };

  const ruleLifecycle = useDraftLifecycleController({
    ownerId: "social-capture-rule-create",
    label: "New social-capture rule draft",
    mode: "create",
    enabled: draft !== null,
    dirty:
      draft !== null &&
      JSON.stringify(draft) !== JSON.stringify(newRuleDraft()),
    save,
    discard: () => {
      setDraft(null);
      setDraftErr(null);
      setVerdict(null);
    },
    detail:
      "This social-capture rule has not been created. Return to the editor or explicitly discard it.",
    operationDetail:
      "Wait for the social-capture rule request to finish before leaving Moosewave.",
    onError: (error) =>
      toast.error(
        lifecycleOperationError(error, "The capture rule couldn't be created."),
      ),
  });

  if (err) return <p className="field-error">{err}</p>;
  if (items === null) return <p className="muted">Loading capture rules…</p>;

  return (
    <div>
      {items.length === 0 && !draft ? (
        <p className="muted" style={{ fontSize: 12 }}>
          No capture rules yet. A rule watches a network for trigger phrases (in
          DMs or comments), auto-replies, asks its questions, and files the
          answers as a lead — optionally subscribing the person to a list.
          {canAdmin ? "" : " Creating rules requires an admin role."}
        </p>
      ) : null}

      {items.map((r) => (
        <div
          key={r.id ?? r.name}
          style={{
            border: "1px solid var(--pw-border)",
            borderRadius: 6,
            padding: 10,
            marginBottom: 8,
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
            <strong style={{ fontSize: 13 }}>{r.name}</strong>
            <span className="badge">{r.network}</span>
            <span className="badge">{r.status}</span>
            <span className="spacer" />
            {r.questions?.length ? (
              <span className="muted" style={{ fontSize: 11 }}>
                {r.questions.length} question
                {r.questions.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          {r.trigger_phrases?.length ? (
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              Triggers: {r.trigger_phrases.join(" · ")}
            </div>
          ) : null}
        </div>
      ))}

      {!draft && canAdmin ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setDraftErr(null);
            setVerdict(null);
            setDraft(newRuleDraft());
          }}
        >
          New capture rule
        </button>
      ) : null}

      {draft ? (
        <div
          style={{
            border: "1px solid var(--pw-border)",
            borderRadius: 6,
            padding: 12,
            marginTop: 8,
          }}
        >
          <div className="field">
            <label className="field-label" htmlFor="sc-rule-name">
              Name
            </label>
            <input
              id="sc-rule-name"
              className="input"
              placeholder="IG comment capture"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            {draftErr?.field === "name" ? (
              <div className="field-error">{draftErr.error}</div>
            ) : null}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="sc-rule-network">
              Network
            </label>
            {networks.length > 0 ? (
              <select
                id="sc-rule-network"
                className="input"
                value={draft.network}
                onChange={(e) =>
                  setDraft({ ...draft, network: e.target.value })
                }
              >
                <option value="">Pick a network…</option>
                {networks.map((n) => (
                  <option key={n.key} value={n.key}>
                    {n.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="sc-rule-network"
                className="input mono"
                placeholder="instagram"
                value={draft.network}
                onChange={(e) =>
                  setDraft({ ...draft, network: e.target.value })
                }
              />
            )}
            {draftErr?.field === "network" ? (
              <div className="field-error">{draftErr.error}</div>
            ) : null}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="sc-rule-triggers">
              Trigger phrases <span className="muted">(comma-separated)</span>
            </label>
            <input
              id="sc-rule-triggers"
              className="input"
              placeholder="GUIDE, FREEBIE"
              value={draft.triggerPhrasesText}
              onChange={(e) =>
                setDraft({ ...draft, triggerPhrasesText: e.target.value })
              }
            />
            {draftErr?.field === "triggerPhrases" ? (
              <div className="field-error">{draftErr.error}</div>
            ) : null}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="sc-rule-reply">
              Auto-reply template <span className="muted">(optional)</span>
            </label>
            <textarea
              id="sc-rule-reply"
              className="input"
              rows={2}
              style={{ padding: 8 }}
              placeholder="Thanks! Drop your email and we'll send the guide."
              value={draft.replyTemplate}
              onChange={(e) =>
                setDraft({ ...draft, replyTemplate: e.target.value })
              }
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="sc-rule-list">
              Target list id <span className="muted">(optional)</span>
            </label>
            <input
              id="sc-rule-list"
              className="input mono"
              placeholder="list UUID to subscribe captured leads to"
              value={draft.targetListId}
              onChange={(e) =>
                setDraft({ ...draft, targetListId: e.target.value })
              }
            />
          </div>
          <VerdictNotice v={verdict} />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void ruleLifecycle.submit()}
              disabled={ruleLifecycle.active}
            >
              {ruleLifecycle.active
                ? "Validating + creating…"
                : "Validate + create"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={ruleLifecycle.requestClose}
              disabled={ruleLifecycle.active}
            >
              Cancel
            </button>
          </div>
          <ConfirmModal
            open={ruleLifecycle.discardConfirmOpen}
            title="Discard capture-rule draft?"
            description="The capture rule has not been created."
            confirmLabel="Discard draft"
            danger
            busy={ruleLifecycle.active}
            onConfirm={ruleLifecycle.discardAndClose}
            onClose={ruleLifecycle.keepEditing}
          />
        </div>
      ) : null}
    </div>
  );
}

/* ---------- leads -------------------------------------------------------- */

function LeadsTab(): ReactElement {
  const [items, setItems] = useState<SocialCaptureLead[] | null>(null);
  const [rules, setRules] = useState<SocialCaptureRule[]>([]);
  const [ruleId, setRuleId] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await socialCaptureApi.listRules();
      if (!res.error) setRules(res.data?.items ?? []);
    })();
  }, []);

  useEffect(() => {
    setItems(null);
    void (async () => {
      const res = await socialCaptureApi.listLeads(ruleId ? { ruleId } : {});
      if (res.error) {
        setErr(res.error.message);
        setItems([]);
        return;
      }
      setErr(null);
      setItems(res.data?.items ?? []);
    })();
  }, [ruleId]);

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 10,
        }}
      >
        <select
          className="input"
          aria-label="Filter leads by capture rule"
          style={{ width: 280 }}
          value={ruleId}
          onChange={(e) => setRuleId(e.target.value)}
        >
          <option value="">All capture rules</option>
          {rules.map((r) => (
            <option key={r.id ?? r.name} value={r.id ?? ""}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      {err ? (
        <p className="field-error">{err}</p>
      ) : items === null ? (
        <p className="muted">Loading leads…</p>
      ) : items.length === 0 ? (
        <p className="muted" style={{ fontSize: 12 }}>
          No leads captured{ruleId ? " by this rule" : ""} yet. Leads land here
          when a capture rule's conversation completes — the platforms push them
          machine-to-machine, so there's nothing to enter manually.
        </p>
      ) : (
        <div className="list">
          <div
            className="list-header"
            style={{ gridTemplateColumns: "1.4fr 100px 110px 90px 140px" }}
          >
            <div>Lead</div>
            <div>Network</div>
            <div>Status</div>
            <div>Answers</div>
            <div>Captured</div>
          </div>
          {items.map((l, i) => (
            <div
              key={l.id ?? i}
              className="list-row"
              style={{
                gridTemplateColumns: "1.4fr 100px 110px 90px 140px",
                cursor: "default",
              }}
            >
              <div
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={leadIdentity(l)}
              >
                {leadIdentity(l)}
              </div>
              <div className="muted">{l.network}</div>
              <div>
                <span className="badge">{l.status}</span>
              </div>
              <div className="tabular">{answersCount(l.answers)}</div>
              <div className="muted" style={{ fontSize: 11 }}>
                {l.created_at ? new Date(l.created_at).toLocaleString() : "—"}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- tap-to-text --------------------------------------------------- */

function TapToTextTab({ canAdmin }: { canAdmin: boolean }): ReactElement {
  const [items, setItems] = useState<SocialCaptureTapLink[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<TapLinkDraft | null>(null);
  const [draftErr, setDraftErr] = useState<{
    field: string;
    error: string;
  } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const res = await socialCaptureApi.listTapLinks();
    if (res.error) {
      setErr(res.error.message);
      setItems([]);
      return;
    }
    setErr(null);
    setItems(res.data?.items ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<boolean> => {
    if (!draft) return false;
    setDraftErr(null);
    const built = buildTapLinkInput(draft);
    if (!built.ok) {
      setDraftErr({ field: built.field, error: built.error });
      return false;
    }
    const res = await socialCaptureApi.createTapLink(built.link);
    if (res.error) {
      toast.error(`Create failed: ${res.error.message}`);
      return false;
    }
    toast.success(
      res.data?.public_url
        ? `Tap-to-text link created — ${res.data.public_url}`
        : "Tap-to-text link created",
    );
    setDraft(null);
    void load();
    return true;
  };

  const tapLifecycle = useDraftLifecycleController({
    ownerId: "social-capture-tap-link-create",
    label: "New tap-to-text link draft",
    mode: "create",
    enabled: draft !== null,
    dirty:
      draft !== null &&
      JSON.stringify(draft) !== JSON.stringify(newTapLinkDraft()),
    save,
    discard: () => {
      setDraft(null);
      setDraftErr(null);
    },
    detail:
      "This tap-to-text link has not been created. Return to the editor or explicitly discard it.",
    operationDetail:
      "Wait for the tap-to-text link request to finish before leaving Moosewave.",
    onError: (error) =>
      toast.error(
        lifecycleOperationError(
          error,
          "The tap-to-text link couldn't be created.",
        ),
      ),
  });

  if (err) return <p className="field-error">{err}</p>;
  if (items === null)
    return <p className="muted">Loading tap-to-text links…</p>;

  return (
    <div>
      {items.length === 0 && !draft ? (
        <p className="muted" style={{ fontSize: 12 }}>
          No tap-to-text links yet. A link opens the visitor's SMS app with your
          number and a pre-filled keyword message — one tap to opt in from a
          story, bio, or poster QR code. The server mints the public slug and
          sms: URI on create.
          {canAdmin ? "" : " Creating links requires an admin role."}
        </p>
      ) : null}

      {items.map((t, i) => (
        <div
          key={t.id ?? i}
          style={{
            border: "1px solid var(--pw-border)",
            borderRadius: 6,
            padding: 10,
            marginBottom: 8,
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
            <strong style={{ fontSize: 13 }}>{t.name}</strong>
            <span className="badge">{t.status}</span>
            <span className="muted mono" style={{ fontSize: 11 }}>
              {t.keyword} → {t.destination_phone}
            </span>
          </div>
          {t.public_url || t.sms_uri ? (
            <div
              className="muted mono"
              style={{
                fontSize: 11,
                marginTop: 6,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={t.public_url ?? t.sms_uri}
            >
              {t.public_url ?? t.sms_uri}
            </div>
          ) : null}
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            “{t.message_body}”
          </div>
        </div>
      ))}

      {!draft && canAdmin ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setDraftErr(null);
            setDraft(newTapLinkDraft());
          }}
        >
          New tap-to-text link
        </button>
      ) : null}

      {draft ? (
        <div
          style={{
            border: "1px solid var(--pw-border)",
            borderRadius: 6,
            padding: 12,
            marginTop: 8,
          }}
        >
          <div className="field">
            <label className="field-label" htmlFor="sc-tap-name">
              Name
            </label>
            <input
              id="sc-tap-name"
              className="input"
              placeholder="Story swipe-up opt-in"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            {draftErr?.field === "name" ? (
              <div className="field-error">{draftErr.error}</div>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label className="field-label" htmlFor="sc-tap-phone">
                Destination phone (E.164)
              </label>
              <input
                id="sc-tap-phone"
                className="input mono"
                placeholder="+14155551234"
                value={draft.destinationPhone}
                onChange={(e) =>
                  setDraft({ ...draft, destinationPhone: e.target.value })
                }
              />
              {draftErr?.field === "destinationPhone" ? (
                <div className="field-error">{draftErr.error}</div>
              ) : null}
            </div>
            <div className="field" style={{ width: 160 }}>
              <label className="field-label" htmlFor="sc-tap-keyword">
                Keyword
              </label>
              <input
                id="sc-tap-keyword"
                className="input mono"
                placeholder="JOIN"
                value={draft.keyword}
                onChange={(e) =>
                  setDraft({ ...draft, keyword: e.target.value })
                }
              />
              {draftErr?.field === "keyword" ? (
                <div className="field-error">{draftErr.error}</div>
              ) : null}
            </div>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="sc-tap-body">
              Pre-filled message
            </label>
            <textarea
              id="sc-tap-body"
              className="input"
              rows={2}
              style={{ padding: 8 }}
              placeholder="JOIN — sign me up for texts"
              value={draft.messageBody}
              onChange={(e) =>
                setDraft({ ...draft, messageBody: e.target.value })
              }
            />
            {draftErr?.field === "messageBody" ? (
              <div className="field-error">{draftErr.error}</div>
            ) : null}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="sc-tap-consent">
              Consent text <span className="muted">(optional)</span>
            </label>
            <textarea
              id="sc-tap-consent"
              className="input"
              rows={2}
              style={{ padding: 8 }}
              placeholder="By texting JOIN you agree to receive marketing texts…"
              value={draft.consentText}
              onChange={(e) =>
                setDraft({ ...draft, consentText: e.target.value })
              }
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="sc-tap-success">
              Success URL <span className="muted">(optional)</span>
            </label>
            <input
              id="sc-tap-success"
              className="input mono"
              placeholder="https://example.com/thanks"
              value={draft.successUrl}
              onChange={(e) =>
                setDraft({ ...draft, successUrl: e.target.value })
              }
            />
            {draftErr?.field === "successUrl" ? (
              <div className="field-error">{draftErr.error}</div>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void tapLifecycle.submit()}
              disabled={tapLifecycle.active}
            >
              {tapLifecycle.active ? "Creating…" : "Create link"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={tapLifecycle.requestClose}
              disabled={tapLifecycle.active}
            >
              Cancel
            </button>
          </div>
          <ConfirmModal
            open={tapLifecycle.discardConfirmOpen}
            title="Discard tap-to-text draft?"
            description="The tap-to-text link has not been created."
            confirmLabel="Discard draft"
            danger
            busy={tapLifecycle.active}
            onConfirm={tapLifecycle.discardAndClose}
            onClose={tapLifecycle.keepEditing}
          />
        </div>
      ) : null}
    </div>
  );
}
