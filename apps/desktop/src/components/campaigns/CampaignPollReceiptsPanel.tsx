// SPDX-License-Identifier: AGPL-3.0-only

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  listCampaignPollReceipts,
  materializeCurrentCampaignPolls,
  type CampaignPollReceipt,
} from "../../lib/campaign-polls";
import { toast } from "../Toast";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; receipts: CampaignPollReceipt[] };

export function CampaignPollReceiptsPanel({
  campaignId,
  hasSemanticPoll,
  canConfigure,
  configurationBlockedReason,
}: {
  campaignId: string;
  hasSemanticPoll: boolean;
  canConfigure: boolean;
  configurationBlockedReason?: string | undefined;
}): ReactElement | null {
  const mounted = useRef(true);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [materializing, setMaterializing] = useState(false);
  const [materializeError, setMaterializeError] = useState<string | null>(null);
  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const materialize = async (): Promise<void> => {
    if (!canConfigure || materializing) return;
    setMaterializing(true);
    setMaterializeError(null);
    let result: Awaited<ReturnType<typeof materializeCurrentCampaignPolls>>;
    try {
      result = await materializeCurrentCampaignPolls(campaignId);
    } catch {
      if (mounted.current) {
        setMaterializing(false);
        setMaterializeError(
          "The immutable poll contract request failed before it could be verified.",
        );
        refresh();
      }
      return;
    }
    if (!mounted.current) return;
    setMaterializing(false);
    if (result.error) {
      setMaterializeError(result.error.message);
      refresh();
      return;
    }
    toast.success(
      `${result.data.definitions.length} two-step poll contract${result.data.definitions.length === 1 ? "" : "s"} materialized from the exact frozen revision`,
    );
    refresh();
  };

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void (async () => {
      const result = await listCampaignPollReceipts(campaignId);
      if (cancelled) return;
      if (result.error) {
        setState({ kind: "error", message: result.error.message });
      } else {
        setState({ kind: "ready", receipts: result.data });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId, nonce]);

  if (
    state.kind === "ready" &&
    state.receipts.length === 0 &&
    !hasSemanticPoll
  ) {
    return null;
  }

  return (
    <section
      className="card pw-chart-card"
      aria-labelledby="campaign-poll-receipts-title"
    >
      <div style={headingStyle}>
        <h3 id="campaign-poll-receipts-title" className="section-title">
          Poll confirmation receipts
        </h3>
        <span className="badge">Observed outcomes</span>
      </div>
      <p className="muted" style={smallStyle}>
        Confirmed poll results bound to an exact immutable campaign revision.
        Each receipt states whether two-step confirmation was required. These
        are observed outcomes, not predicted engagement.
      </p>

      {canConfigure && hasSemanticPoll ? (
        <div className="notice" style={smallStyle}>
          <p>
            Freeze the currently saved semantic v2 draft, then materialize every
            poll key read back from that exact immutable revision. Question and
            option content stays server-owned; every new contract requires
            scanner-safe two-step confirmation. Repeating this action verifies
            or reuses the same revision contract.
          </p>
          <button
            type="button"
            className="btn btn-sm"
            disabled={materializing}
            aria-disabled={materializing || undefined}
            onClick={() => void materialize()}
          >
            {materializing
              ? "Freezing and materializing…"
              : "Freeze current revision and materialize polls"}
          </button>
        </div>
      ) : null}

      {materializeError ? (
        <p className="field-error" role="alert">
          {materializeError}
        </p>
      ) : null}

      {state.kind === "loading" ? (
        <p className="muted" role="status">
          Loading immutable poll receipts…
        </p>
      ) : state.kind === "error" ? (
        <div className="notice" role="alert">
          <p>
            Poll receipts could not be verified. This is unknown, not zero
            responses. {state.message}
          </p>
          <button type="button" className="btn btn-sm" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : state.receipts.length === 0 ? (
        <div className="notice" role="status" style={smallStyle}>
          <p>No immutable poll response contract has been materialized.</p>
        </div>
      ) : (
        state.receipts.map((receipt) => (
          <PollReceipt key={receipt.definition.id} receipt={receipt} />
        ))
      )}
      {hasSemanticPoll && !canConfigure && configurationBlockedReason ? (
        <p className="notice muted" style={smallStyle}>
          {configurationBlockedReason}
        </p>
      ) : null}
    </section>
  );
}

function PollReceipt({
  receipt,
}: {
  receipt: CampaignPollReceipt;
}): ReactElement {
  const { definition, tally } = receipt;
  const counted = tally.options.reduce(
    (sum, option) => sum + option.counted,
    0,
  );
  const excluded =
    tally.machineExcluded +
    tally.unclassifiedExcluded +
    tally.voidedMultiOption +
    tally.supersededChoices +
    tally.previewedOnly;
  return (
    <article style={receiptStyle}>
      <div style={headingStyle}>
        <div>
          <strong>{definition.question}</strong>
          <div className="muted" style={smallStyle}>
            Poll <code>{definition.pollKey}</code> · created{" "}
            {new Date(definition.createdAt).toLocaleString()}
          </div>
        </div>
        <span
          className={`badge ${definition.twoStepRequired ? "" : "warning"}`}
        >
          {definition.twoStepRequired
            ? "Two-step confirmation"
            : "Single-step — scanner safety not assured"}
        </span>
      </div>
      <dl style={gridStyle}>
        {tally.options.map((option) => (
          <Field
            key={option.optionKey}
            label={option.label}
            value={`${option.counted} counted human`}
          />
        ))}
        <Field label="Counted human confirmations" value={String(counted)} />
        <Field label="Excluded confirmations" value={String(excluded)} />
        <Field label="Machine excluded" value={String(tally.machineExcluded)} />
        <Field
          label="Unclassified excluded"
          value={String(tally.unclassifiedExcluded)}
        />
        <Field
          label="Multi-option voided"
          value={String(tally.voidedMultiOption)}
        />
        <Field
          label="Superseded choices"
          value={String(tally.supersededChoices)}
        />
        <Field
          label="Preview-only legacy"
          value={String(tally.previewedOnly)}
        />
        <Field
          label="Immutable submission receipts"
          value={String(tally.submissionReceipts)}
        />
      </dl>
      <p className="notice" style={smallStyle}>
        Only explicit human classifications enter option counts. Machine,
        unknown, multi-option, superseded, and preview-only evidence remains
        visible and excluded; a missing classifier never defaults to human.
      </p>
      <details>
        <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
          Immutable provenance
        </summary>
        <dl style={gridStyle}>
          <Field
            label="Frozen revision"
            value={definition.contentRevisionId}
            mono
          />
          <Field
            label="Revision source hash"
            value={definition.contentRevisionSourceHash}
            mono
          />
          <Field
            label="Poll contract SHA-256"
            value={definition.pollContractSha256}
            mono
          />
          <Field
            label="Closes"
            value={
              definition.closesAt
                ? new Date(definition.closesAt).toLocaleString()
                : "No closing time recorded"
            }
          />
        </dl>
      </details>
    </article>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): ReactElement {
  return (
    <div style={{ minWidth: 0 }}>
      <dt className="muted" style={smallStyle}>
        {label}
      </dt>
      <dd
        className={mono ? "mono" : undefined}
        style={valueStyle}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

const smallStyle = { fontSize: 11, lineHeight: 1.45 } as const;
const headingStyle = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 8,
} as const;
const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
  margin: "10px 0",
} as const;
const receiptStyle = {
  border: "1px solid var(--pw-border)",
  borderRadius: 8,
  padding: 10,
  marginTop: 10,
} as const;
const valueStyle = {
  margin: 0,
  overflowWrap: "anywhere",
  fontSize: 12,
} as const;
