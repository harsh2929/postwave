/**
 * Lifecycle-aware storefront widget summary and installation review.
 *
 * Deployment authority is deliberately fail closed: only an explicitly active
 * widget with a policy-safe reported endpoint exposes endpoint inspection and
 * installation-review controls. Installation snippets are fetched one flavor
 * at a time, bounded, validated, cached per flavor, and always rendered as
 * inert text. Copy remains unavailable unless the selected method clears its
 * known delivery blockers.
 */
import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { type ReviewWidget, reviewsApi } from "../../lib/api-client";
import { writeClipboardText } from "../../lib/clipboard";
import { fmtDateTime } from "../../lib/format-date";
import { remoteFailureFromError } from "../../lib/remote-resource";
import {
  parseReviewEmbedSnippet,
  safePublicWidgetUrl,
  widgetStatusBadgeTone,
  widgetStatusLabel,
  widgetTypeLabel,
} from "../../lib/reviews-helpers";

const FLAVORS = ["iframe", "script"] as const;
type Flavor = (typeof FLAVORS)[number];

type EmbedState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      snippet: string;
      iframeHasTitle: boolean | null;
      iframeTargetsHtml: boolean | null;
    };

interface EmbedMarkupInspection {
  valid: boolean;
  iframeHasTitle: boolean | null;
  iframeTargetsHtml: boolean | null;
}

interface ReviewInstallationDialogProps {
  open: boolean;
  widgetId: string;
  widgetName: string;
  reportedEndpoint: string;
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}

function emptyEmbedStates(): Record<Flavor, EmbedState> {
  return {
    iframe: { phase: "idle" },
    script: { phase: "idle" },
  };
}

function widgetBadgeClass(status: string | null | undefined): string {
  const tone = widgetStatusBadgeTone(status);
  return tone === "neutral" ? "badge" : `badge ${tone}`;
}

function inactiveLifecycleReason(status: string): string {
  switch (status) {
    case "draft":
      return "This widget is a draft. Reported endpoint and installation review stay hidden until it is active.";
    case "paused":
      return "This widget is paused. Reported endpoint and installation review stay hidden until it is active again.";
    case "archived":
      return "This widget is archived. Reported endpoint and installation review are no longer available here.";
    default:
      return "Moosewave cannot verify this widget's lifecycle state. Public and installation controls are hidden.";
  }
}

function invalidSnippetMessage(
  reason: "empty" | "invalid" | "too-large",
): string {
  switch (reason) {
    case "empty":
      return "The service returned no installation code for this method.";
    case "too-large":
      return "The installation code exceeded Moosewave's 32 KiB safety limit.";
    case "invalid":
    default:
      return "Moosewave could not verify the installation code returned for this method.";
  }
}

function inspectEmbedMarkup(
  flavor: Flavor,
  snippet: string,
  reportedEndpoint: string,
): EmbedMarkupInspection {
  // Do not feed installation code to DOMParser or a temporary element. Even a
  // detached parsed document can initiate subresource loads in some WebViews.
  // This lexical inspection keeps the admin surface network-silent and inert.
  const iframeOpenings = snippet.match(/<iframe\b/giu) ?? [];
  const scriptOpenings = snippet.match(/<script\b/giu) ?? [];
  if (flavor === "iframe") {
    const iframeTag = snippet.match(/<iframe\b[^>]*>/iu)?.[0] ?? "";
    const title = iframeTag.match(
      /(?:^|\s)title\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu,
    );
    const src = iframeTag.match(
      /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu,
    );
    const rawSrc = (src?.[1] ?? src?.[2] ?? src?.[3] ?? "").trim();
    let iframeTargetsHtml = false;
    try {
      const destination = new URL(rawSrc);
      const endpoint = new URL(reportedEndpoint);
      const expectedPath = `${endpoint.pathname.replace(/\/+$/u, "")}/html`;
      iframeTargetsHtml =
        (destination.protocol === "https:" ||
          destination.protocol === "http:") &&
        !destination.username &&
        !destination.password &&
        destination.origin === endpoint.origin &&
        destination.pathname === expectedPath &&
        !destination.search &&
        !destination.hash;
    } catch {
      iframeTargetsHtml = false;
    }
    return {
      valid:
        iframeOpenings.length === 1 &&
        scriptOpenings.length === 0 &&
        /<\/iframe\s*>/iu.test(snippet),
      iframeHasTitle:
        iframeOpenings.length === 1 &&
        Boolean((title?.[1] ?? title?.[2] ?? title?.[3] ?? "").trim()),
      iframeTargetsHtml,
    };
  }
  return {
    valid:
      scriptOpenings.length === 1 &&
      iframeOpenings.length === 0 &&
      /<\/script\s*>/iu.test(snippet),
    iframeHasTitle: null,
    iframeTargetsHtml: null,
  };
}

async function copyPublicText(text: string, label: string): Promise<void> {
  const result = await writeClipboardText(text, {
    contentClass: "public",
    label,
  });
  if (result.ok) toast.success(`${label} copied`);
  else toast.error(result.message);
}

function ReviewInstallationDialog({
  open,
  widgetId,
  widgetName,
  reportedEndpoint,
  onClose,
  returnFocusRef,
}: ReviewInstallationDialogProps): ReactElement {
  const iframeMethodRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(true);
  const stateRef = useRef<Record<Flavor, EmbedState>>(emptyEmbedStates());
  const requestGenerationRef = useRef<Record<Flavor, number>>({
    iframe: 0,
    script: 0,
  });
  const inFlightRef = useRef<Record<Flavor, boolean>>({
    iframe: false,
    script: false,
  });
  const [flavor, setFlavor] = useState<Flavor>("iframe");
  const [states, setStates] =
    useState<Record<Flavor, EmbedState>>(emptyEmbedStates);
  const blockerId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const candidate of FLAVORS) {
        requestGenerationRef.current[candidate] += 1;
        inFlightRef.current[candidate] = false;
      }
    };
  }, []);

  const commitState = useCallback(
    (candidate: Flavor, next: EmbedState): void => {
      const updated = { ...stateRef.current, [candidate]: next };
      stateRef.current = updated;
      if (mountedRef.current) setStates(updated);
    },
    [],
  );

  const loadFlavor = useCallback(
    async (candidate: Flavor, retry = false): Promise<void> => {
      if (inFlightRef.current[candidate]) return;
      if (!retry && stateRef.current[candidate].phase !== "idle") return;

      inFlightRef.current[candidate] = true;
      const generation = ++requestGenerationRef.current[candidate];
      commitState(candidate, { phase: "loading" });

      try {
        const response = await reviewsApi.widgetEmbed(widgetId, candidate);
        if (
          !mountedRef.current ||
          requestGenerationRef.current[candidate] !== generation
        ) {
          return;
        }
        if (response.error) {
          commitState(candidate, {
            phase: "error",
            message: remoteFailureFromError(response.error).message,
          });
          return;
        }

        const parsed = parseReviewEmbedSnippet(response.data?.snippet);
        if (!parsed.ok) {
          commitState(candidate, {
            phase: "error",
            message: invalidSnippetMessage(parsed.reason),
          });
          return;
        }
        const inspection = inspectEmbedMarkup(
          candidate,
          parsed.snippet,
          reportedEndpoint,
        );
        if (!inspection.valid) {
          commitState(candidate, {
            phase: "error",
            message: `Moosewave did not receive a valid ${candidate} installation snippet.`,
          });
          return;
        }
        commitState(candidate, {
          phase: "ready",
          snippet: parsed.snippet,
          iframeHasTitle: inspection.iframeHasTitle,
          iframeTargetsHtml: inspection.iframeTargetsHtml,
        });
      } catch {
        if (
          mountedRef.current &&
          requestGenerationRef.current[candidate] === generation
        ) {
          commitState(candidate, {
            phase: "error",
            message: remoteFailureFromError({ kind: "network" }).message,
          });
        }
      } finally {
        if (requestGenerationRef.current[candidate] === generation) {
          inFlightRef.current[candidate] = false;
        }
      }
    },
    [commitState, reportedEndpoint, widgetId],
  );

  useEffect(() => {
    if (open) void loadFlavor(flavor);
  }, [flavor, loadFlavor, open]);

  const state = states[flavor];
  const iframeTitleBlocked =
    flavor === "iframe" &&
    state.phase === "ready" &&
    state.iframeHasTitle === false;
  const iframeTargetBlocked =
    flavor === "iframe" &&
    state.phase === "ready" &&
    state.iframeTargetsHtml === false;
  const scriptDeliveryBlocked = flavor === "script" && state.phase === "ready";
  const copyBlocked =
    iframeTitleBlocked || iframeTargetBlocked || scriptDeliveryBlocked;
  const closeDialog = useCallback((): void => {
    setFlavor("iframe");
    onClose();
  }, [onClose]);

  return (
    <Modal
      open={open}
      onClose={closeDialog}
      title={`Review installation · ${widgetName}`}
      description="Inspect bounded service-reported code for this active widget. Copy is available only for an iframe that names its content and targets rendered /html output; script delivery is not yet certified."
      size="lg"
      initialFocusRef={iframeMethodRef}
      returnFocusRef={returnFocusRef}
    >
      <div className="reviews-installation">
        <div
          className="reviews-installation-methods"
          role="group"
          aria-label="Installation method"
        >
          <button
            ref={iframeMethodRef}
            type="button"
            aria-pressed={flavor === "iframe"}
            className={`reviews-installation-method${
              flavor === "iframe" ? " is-selected" : ""
            }`}
            onClick={() => setFlavor("iframe")}
          >
            <span>
              <strong>Iframe</strong>
              <small>Review · iframe markup</small>
            </span>
          </button>
          <button
            type="button"
            aria-pressed={flavor === "script"}
            className={`reviews-installation-method${
              flavor === "script" ? " is-selected" : ""
            }`}
            onClick={() => setFlavor("script")}
          >
            <span>
              <strong>Script</strong>
              <small>Review · remote JavaScript</small>
            </span>
          </button>
        </div>

        <section
          className="reviews-installation-code"
          aria-labelledby={`${blockerId}-code-title`}
          aria-busy={state.phase === "loading"}
        >
          <h3 id={`${blockerId}-code-title`}>
            {flavor === "iframe" ? "Iframe code" : "Script code"}
          </h3>

          {state.phase === "idle" || state.phase === "loading" ? (
            <div className="reviews-installation-state" role="status">
              {state.phase === "loading"
                ? `Requesting ${flavor} installation code…`
                : `Preparing ${flavor} installation code…`}
            </div>
          ) : null}

          {state.phase === "error" ? (
            <div className="reviews-installation-error" role="alert">
              <p>{state.message}</p>
              <button
                type="button"
                className="btn"
                onClick={() => void loadFlavor(flavor, true)}
              >
                Retry {flavor}
              </button>
            </div>
          ) : null}

          {state.phase === "ready" ? (
            <>
              {iframeTitleBlocked || iframeTargetBlocked ? (
                <div
                  id={blockerId}
                  className="reviews-installation-blocker"
                  role="alert"
                >
                  <strong>Iframe copy blocked</strong>
                  <span>
                    {iframeTitleBlocked && iframeTargetBlocked
                      ? "The iframe needs a non-empty title and must target the rendered /html view. Current code clears neither requirement."
                      : iframeTitleBlocked
                        ? "The iframe has no non-empty title. Copy stays unavailable until the generated code names the embedded review content."
                        : "The iframe does not target the rendered /html view. Copy stays unavailable because the reported destination is not a human-facing widget."}
                  </span>
                </div>
              ) : null}
              {scriptDeliveryBlocked ? (
                <div
                  id={blockerId}
                  className="reviews-installation-warning"
                  role="alert"
                >
                  <strong>Storefront delivery not certified</strong>
                  <span>
                    This code executes remote JavaScript and then requests
                    widget JSON from the customer&apos;s origin context. The
                    service has no certified cross-origin delivery contract for
                    that request, so copy stays unavailable.
                  </span>
                </div>
              ) : null}
              <textarea
                className="reviews-installation-snippet"
                aria-label={`${flavor} installation code`}
                readOnly
                rows={10}
                spellCheck={false}
                value={state.snippet}
              />
              <div className="reviews-installation-copy">
                <button
                  type="button"
                  className={copyBlocked ? "btn" : "btn btn-primary"}
                  disabled={copyBlocked}
                  aria-describedby={copyBlocked ? blockerId : undefined}
                  onClick={() =>
                    void copyPublicText(
                      state.snippet,
                      `${flavor === "iframe" ? "Iframe" : "Script"} installation code`,
                    )
                  }
                >
                  {copyBlocked
                    ? `${flavor === "iframe" ? "Iframe" : "Script"} copy unavailable`
                    : `Copy ${flavor} code`}
                </button>
              </div>
            </>
          ) : null}
        </section>
      </div>

      <ModalFooter>
        <button type="button" className="btn" onClick={closeDialog}>
          Close
        </button>
      </ModalFooter>
    </Modal>
  );
}

export function WidgetCard({ widget }: { widget: ReviewWidget }): ReactElement {
  const headingId = useId();
  const installationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [installationOpen, setInstallationOpen] = useState(false);

  const name = widget.name?.trim() || "Untitled widget";
  const status = (widget.status ?? "").trim().toLowerCase();
  const active = status === "active";
  const safeUrl = active ? safePublicWidgetUrl(widget.public_url) : null;
  const widgetId = widget.id?.trim() ?? "";
  const requestScope = `${widgetId}\u0000${status}\u0000${safeUrl ?? ""}`;

  return (
    <article className="reviews-widget-card" aria-labelledby={headingId}>
      <header className="reviews-widget-card-header">
        <div>
          <span className="reviews-widget-card-eyebrow">Storefront widget</span>
          <h3 id={headingId}>{name}</h3>
        </div>
        <span className={widgetBadgeClass(widget.status)}>
          {widgetStatusLabel(widget.status)}
        </span>
      </header>

      <dl className="reviews-widget-metadata">
        <div>
          <dt>Type</dt>
          <dd>{widgetTypeLabel(widget.widget_type)}</dd>
        </div>
        <div>
          <dt>Language</dt>
          <dd>{widget.language?.trim() || "Not provided"}</dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>
            {widget.updated_at ? (
              <time dateTime={widget.updated_at}>
                {fmtDateTime(widget.updated_at)}
              </time>
            ) : (
              "Not provided"
            )}
          </dd>
        </div>
      </dl>

      {!active ? (
        <p className="reviews-widget-lifecycle-note" role="note">
          {inactiveLifecycleReason(status)}
        </p>
      ) : null}

      {active && !safeUrl ? (
        <div className="reviews-widget-url-warning" role="alert">
          <strong>Reported endpoint unavailable</strong>
          <span>
            Moosewave did not receive a policy-safe reported endpoint.
            Inspection, copy, and installation review stay hidden.
          </span>
        </div>
      ) : null}

      {safeUrl ? (
        <section
          className="reviews-widget-deployment"
          aria-labelledby={`${headingId}-deployment`}
        >
          <h4 id={`${headingId}-deployment`}>Reported public endpoint</h4>
          <code className="reviews-widget-public-url">{safeUrl}</code>
          <div className="reviews-widget-endpoint-blocker" role="alert">
            <strong>Endpoint access withheld</strong>
            <span>
              Tenant ownership and rendered output are not verified by the
              current public lookup. Do not share or install this address.
            </span>
          </div>
          <div className="reviews-widget-actions">
            {widgetId ? (
              <button
                ref={installationTriggerRef}
                type="button"
                className="btn btn-primary"
                onClick={(event) => {
                  installationTriggerRef.current = event.currentTarget;
                  setInstallationOpen(true);
                }}
              >
                Review installation
              </button>
            ) : null}
          </div>
          {!widgetId ? (
            <p className="reviews-widget-installation-unavailable" role="note">
              Installation code is unavailable because this widget has no stable
              identifier.
            </p>
          ) : null}
        </section>
      ) : null}

      {safeUrl && widgetId ? (
        <ReviewInstallationDialog
          key={requestScope}
          open={installationOpen}
          widgetId={widgetId}
          widgetName={name}
          reportedEndpoint={safeUrl}
          onClose={() => setInstallationOpen(false)}
          returnFocusRef={installationTriggerRef}
        />
      ) : null}
    </article>
  );
}
