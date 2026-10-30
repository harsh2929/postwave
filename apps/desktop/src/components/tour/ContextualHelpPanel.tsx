import {
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type { DesktopShortcutProjection } from "../../hooks/useDesktopShortcut";
import { useDialogStack } from "../../hooks/useDialogStack";
import { writeClipboardText } from "../../lib/clipboard";
import { LEGAL_URLS } from "../../lib/config";
import {
  buildContextualSupportText,
  buildContextualSupportUrl,
  contextualHelpGuide,
  contextualSelfServiceItems,
  type ContextualHelpSnapshot,
} from "../../lib/contextual-help";
import { navigateDesktopSection } from "../../lib/desktop-router";
import { popDialog, pushDialog } from "../../lib/dialogStack";
import { routeMetaForSection } from "../../lib/desktop-routes";
import { tauriApi } from "../../lib/tauri";
import { ExternalLink } from "../ExternalLink";

interface ContextualHelpPanelProps {
  dialogId: string;
  panelRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  snapshot: ContextualHelpSnapshot;
  side: "left" | "right";
  commandShortcut: DesktopShortcutProjection | null;
  helpShortcut: DesktopShortcutProjection | null;
  onboardingShortcut: DesktopShortcutProjection | null;
  dashboardShortcut: DesktopShortcutProjection | null;
  canRestartSetup: boolean;
  onClose: (restoreFocus: boolean) => void;
  onMove: () => void;
  onStartTour: () => void;
  onReplayTour: () => void;
  onRestartSetup: () => void;
}

type PendingHelpAction = "copy" | "support" | null;

function useContextualHelpPanelBehavior({
  dialogId,
  panelRef,
  triggerRef,
  snapshot,
  onClose,
}: Pick<
  ContextualHelpPanelProps,
  "dialogId" | "panelRef" | "triggerRef" | "snapshot" | "onClose"
>) {
  const [pending, setPending] = useState<PendingHelpAction>(null);
  const [feedback, setFeedback] = useState("");
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const closeRequestedRef = useRef(false);
  const feedbackId = useId();
  const { isTop } = useDialogStack(dialogId);

  const requestClose = useCallback(
    (restoreFocus: boolean): void => {
      if (closeRequestedRef.current) return;
      closeRequestedRef.current = true;
      onClose(restoreFocus);
    },
    [onClose],
  );
  const runDeparture = (action: () => void): void => {
    if (closeRequestedRef.current) return;
    closeRequestedRef.current = true;
    action();
  };

  useEffect(() => {
    mountedRef.current = true;
    closeRequestedRef.current = false;
    pushDialog(dialogId);
    const frame = window.requestAnimationFrame(() => {
      // Focus the named dialog itself so assistive technology receives the
      // route/context summary and compact-height windows remain scrolled to
      // the beginning. Focusing the first in-body link caused the browser to
      // jump past the opening guidance before the user could read it.
      panelRef.current?.focus({ preventScroll: true });
    });
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      pendingRef.current = false;
      window.cancelAnimationFrame(frame);
      popDialog(dialogId);
    };
  }, [dialogId, panelRef]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        panelRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      requestClose(false);
    };
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        panelRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      requestClose(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== "Escape" || !isTop) return;
      event.preventDefault();
      requestClose(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isTop, panelRef, requestClose, triggerRef]);

  const run = (
    action: Exclude<PendingHelpAction, null>,
    task: () => Promise<string>,
  ): void => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    const generation = ++generationRef.current;
    setPending(action);
    setFeedback(
      action === "copy"
        ? "Copying privacy-safe support context…"
        : "Opening support with structural context…",
    );
    void Promise.resolve()
      .then(task)
      .then((message) => {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setFeedback(message);
      })
      .catch(() => {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setFeedback(
          action === "copy"
            ? "Support context could not be copied. Keep the structural error or incident code visible and try again."
            : "Support could not be opened. Use Documentation or copy the support context and try again.",
        );
      })
      .finally(() => {
        if (generation !== generationRef.current) return;
        pendingRef.current = false;
        if (mountedRef.current) setPending(null);
      });
  };

  const copyContext = (): void => {
    run("copy", async () => {
      const result = await writeClipboardText(
        buildContextualSupportText(snapshot),
        { contentClass: "personal", label: "Moosewave support context" },
      );
      if (!result.ok) throw new Error("support_context_copy_failed");
      return "Privacy-safe support context copied.";
    });
  };

  const openSupport = (): void => {
    run("support", async () => {
      const url = buildContextualSupportUrl(LEGAL_URLS.support, snapshot);
      if (!url) throw new Error("support_url_invalid");
      await tauriApi.openUrl(url);
      return "Support opened with structural task context only.";
    });
  };

  const reportDocumentationError = (): void => {
    if (!mountedRef.current) return;
    setFeedback(
      "Documentation could not be opened. Copy the support context or try again.",
    );
  };

  return {
    copyContext,
    feedback,
    feedbackId,
    openSupport,
    pending,
    reportDocumentationError,
    requestClose,
    runDeparture,
  };
}

export function ContextualHelpPanel({
  dialogId,
  panelRef,
  triggerRef,
  snapshot,
  side,
  commandShortcut,
  helpShortcut,
  onboardingShortcut,
  dashboardShortcut,
  canRestartSetup,
  onClose,
  onMove,
  onStartTour,
  onReplayTour,
  onRestartSetup,
}: ContextualHelpPanelProps): ReactElement {
  const {
    copyContext,
    feedback,
    feedbackId,
    openSupport,
    pending,
    reportDocumentationError,
    requestClose,
    runDeparture,
  } = useContextualHelpPanelBehavior({
    dialogId,
    panelRef,
    triggerRef,
    snapshot,
    onClose,
  });
  const guide = contextualHelpGuide(snapshot);
  const selfService = contextualSelfServiceItems(snapshot);
  const readiness =
    snapshot.readiness === "operational"
      ? "Operational"
      : snapshot.readiness.replace("-", " ");

  return (
    <aside
      ref={panelRef}
      id="desktop-contextual-help"
      className={`tour-launcher-panel contextual-help-panel is-${side}`}
      role="dialog"
      aria-modal="false"
      tabIndex={-1}
      aria-labelledby="desktop-contextual-help-title"
      aria-describedby="desktop-contextual-help-description"
      aria-busy={pending !== null}
    >
      <header className="contextual-help-header">
        <div>
          <h2 id="desktop-contextual-help-title">Help for this screen</h2>
          <p id="desktop-contextual-help-description">
            {snapshot.destinationTitle}
            <span className="badge neutral">{readiness}</span>
          </p>
        </div>
        <div className="contextual-help-header-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-help-action
            onClick={onMove}
          >
            Move {side === "right" ? "left" : "right"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-help-action
            aria-label="Close help"
            onClick={() => requestClose(true)}
          >
            Close
          </button>
        </div>
      </header>

      <div className="contextual-help-scroll">
        <section aria-labelledby="contextual-help-self-service">
          <h3 id="contextual-help-self-service">Try these first</h3>
          <div className="contextual-help-guide">
            <strong>{guide.title}</strong>
            <p>{guide.summary}</p>
            <ol>
              {guide.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>

          {selfService
            .filter((item) => item.id !== "guide")
            .map((item) => (
              <div
                key={item.id}
                className={`notice ${item.id === "connectivity" ? "notice-warning" : ""}`}
              >
                <strong>{item.title}</strong>
                <p>{item.description}</p>
              </div>
            ))}

          <div className="contextual-help-actions">
            <ExternalLink
              href={LEGAL_URLS.support}
              className="btn btn-secondary btn-sm"
              data-help-action
              data-help-primary
              onOpenError={reportDocumentationError}
            >
              Open documentation
            </ExternalLink>
            {snapshot.recoverySection ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-help-action
                onClick={() => {
                  const section = snapshot.recoverySection;
                  if (!section) return;
                  requestClose(false);
                  navigateDesktopSection(section);
                }}
              >
                Open {routeMetaForSection(snapshot.recoverySection).title}
              </button>
            ) : null}
          </div>
        </section>

        <section aria-labelledby="contextual-help-guided">
          <h3 id="contextual-help-guided">Guided help</h3>
          <div className="contextual-help-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-help-action
              onClick={() => runDeparture(onStartTour)}
            >
              Take the tour <span>90 seconds</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-help-action
              onClick={() => runDeparture(onReplayTour)}
            >
              Restart tour
            </button>
            {canRestartSetup ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-help-action
                onClick={() => runDeparture(onRestartSetup)}
              >
                Restart setup
              </button>
            ) : null}
          </div>
        </section>

        <details className="contextual-help-shortcuts">
          <summary>Keyboard shortcuts</summary>
          <ul className="tour-launcher-shortcuts-list">
            <ShortcutRow
              shortcut={commandShortcut?.label ?? "Search"}
              label="Search across everything"
            />
            <ShortcutRow
              shortcut={helpShortcut?.label ?? "Help"}
              label="Open this help"
            />
            <ShortcutRow
              shortcut={
                dashboardShortcut
                  ? dashboardShortcut.label.replace(/1$/u, "1…0")
                  : "1…0"
              }
              label="Jump between sections"
            />
            <ShortcutRow
              shortcut={onboardingShortcut?.label ?? "Restart setup"}
              label="Re-run first-time setup"
            />
          </ul>
        </details>

        <section
          className="contextual-help-support"
          aria-labelledby="contextual-help-support-title"
        >
          <h3 id="contextual-help-support-title">Still need help?</h3>
          <p>
            Handoff includes this destination, capability, readiness, connection
            reason, and structural error/incident codes only. It excludes
            identity, record IDs, content, URLs, and credentials.
          </p>
          <div className="contextual-help-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-help-action
              disabled={pending !== null}
              aria-describedby={feedbackId}
              onClick={copyContext}
            >
              {pending === "copy" ? "Copying…" : "Copy support context"}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-help-action
              disabled={pending !== null}
              aria-describedby={feedbackId}
              onClick={openSupport}
            >
              {pending === "support" ? "Opening…" : "Contact support"}
            </button>
          </div>
          <p
            id={feedbackId}
            className="contextual-help-feedback"
            role="status"
            aria-live="polite"
          >
            {feedback}
          </p>
        </section>
      </div>
    </aside>
  );
}

function ShortcutRow({
  shortcut,
  label,
}: {
  shortcut: string;
  label: string;
}): ReactElement {
  return (
    <li>
      <span className="mono">{shortcut}</span>
      <span>{label}</span>
    </li>
  );
}
