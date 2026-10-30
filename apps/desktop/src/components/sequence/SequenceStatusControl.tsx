/**
 * SequenceStatusControl — accessible status menu plus destructive pause and
 * archive confirmations for the sequence canvas header.
 *
 * The controller owns RBAC, optimistic rollback, mutation serialization,
 * version propagation, and stale/unmount suppression. This file is limited to
 * focus behavior and presentation so neither concern can silently bypass the
 * other as the transition matrix evolves.
 */
import {
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useDialogStack } from "../../hooks/useDialogStack";
import { useMenuInteraction } from "../../hooks/useMenuInteraction";
import { type Sequence } from "../../lib/api-client";
import { anchoredPopoverPosition } from "../../lib/anchored-popover-position";
import { popDialog, pushDialog } from "../../lib/dialogStack";
import {
  SEQUENCE_RUNTIME_AVAILABLE,
  SEQUENCE_RUNTIME_UNAVAILABLE_REASON,
  sequenceStatusPresentation,
} from "../../lib/sequence-operational-availability";
import { Modal, ModalFooter } from "../Modal";
import {
  SEQUENCE_STATUS_OPTIONS,
  type SequenceMutationEnqueuer,
  type SequenceStatus,
  type SequenceStatusController,
  type SequenceStatusOption,
  useSequenceStatusController,
} from "./useSequenceStatusController";

interface Props {
  sequence: Sequence;
  /** Editor + admin: can change status. Viewer is read-only. */
  canMutate: boolean;
  onChange: (next: Sequence) => void;
  /** Shared canvas optimistic-concurrency version. */
  versionRef?: { current: number | null };
  /** Shared canvas mutation chain; queued work re-reads versionRef on execution. */
  enqueueMutation?: SequenceMutationEnqueuer;
  /** Default-closed until the in-repo execution runtime is qualified. */
  runtimeAvailable?: boolean;
}

function badgeClassFor(tone: SequenceStatusOption["tone"]): string {
  switch (tone) {
    case "success":
      return "badge success";
    case "warning":
      return "badge warning";
    case "danger":
      return "badge danger";
    case "neutral":
    default:
      return "badge";
  }
}

function useStatusMenuInteractions(options: {
  controller: SequenceStatusController;
  menuId: string;
  menuRef: RefObject<HTMLDivElement | null>;
  onPositionChange: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}): void {
  const { controller, menuId, menuRef, onPositionChange, triggerRef } = options;
  const { isTop } = useDialogStack(menuId);
  const closeMenu = useCallback(() => controller.closeMenu(), [controller]);

  useEffect(() => {
    if (!controller.menuOpen) return;
    pushDialog(menuId);
    return () => popDialog(menuId);
  }, [controller.menuOpen, menuId]);

  useMenuInteraction({
    isTop,
    menuRef,
    onClose: closeMenu,
    open: controller.menuOpen,
    selectedItemSelector: '[role="menuitemradio"][aria-checked="true"]',
    trigger: triggerRef.current,
  });

  useEffect(() => {
    if (!controller.menuOpen) return;
    let frame: number | null = null;
    const refreshPosition = (): void => {
      if (frame !== null) return;
      frame = -1;
      const requestedFrame = window.requestAnimationFrame(() => {
        frame = null;
        onPositionChange();
      });
      if (frame !== null) frame = requestedFrame;
    };
    refreshPosition();
    window.addEventListener("resize", refreshPosition);
    window.addEventListener("scroll", refreshPosition, true);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", refreshPosition);
      window.removeEventListener("scroll", refreshPosition, true);
    };
  }, [controller.menuOpen, onPositionChange]);
}

function moveMenuFocusHorizontally(
  event: ReactKeyboardEvent<HTMLDivElement>,
): void {
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
    return;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]',
    ),
  );
  if (items.length === 0) return;
  const currentIndex = items.indexOf(
    document.activeElement as HTMLButtonElement,
  );
  const start = currentIndex < 0 ? 0 : currentIndex;
  const targetIndex =
    (start + (event.key === "ArrowRight" ? 1 : -1) + items.length) %
    items.length;
  event.preventDefault();
  items[targetIndex]?.focus();
}

function StatusTrigger({
  controller,
  menuId,
  reasonId,
  triggerRef,
  triggerId,
  unavailableReason,
}: {
  controller: SequenceStatusController;
  menuId: string;
  reasonId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  triggerId: string;
  unavailableReason: string | null;
}): ReactElement {
  const option = controller.currentOption;
  const unavailable = unavailableReason !== null;
  return (
    <button
      ref={triggerRef}
      id={triggerId}
      type="button"
      className={badgeClassFor(option.tone)}
      onClick={() => {
        if (!unavailable) controller.toggleMenu();
      }}
      onKeyDown={(event) => {
        if (
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229 ||
          unavailable
        ) {
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          controller.openMenu();
        }
      }}
      aria-disabled={unavailable || undefined}
      aria-haspopup="menu"
      aria-expanded={controller.menuOpen}
      aria-controls={controller.menuOpen ? menuId : undefined}
      aria-describedby={unavailable ? reasonId : undefined}
      aria-busy={controller.busy}
      aria-label={
        controller.busy
          ? `Updating sequence status from ${option.label}`
          : unavailable
            ? `Sequence status: ${option.label}. ${unavailableReason}`
            : `Sequence status: ${option.label}. Click to change.`
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        cursor:
          controller.canChange && !controller.busy ? "pointer" : "not-allowed",
        padding: "3px 10px",
        opacity: controller.busy ? 0.65 : 1,
      }}
    >
      <span>{option.label}</span>
      <svg
        aria-hidden="true"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          transform: controller.menuOpen ? "rotate(180deg)" : undefined,
          transition: "transform 120ms ease",
        }}
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );
}

function StatusMenu({
  activeStatus,
  controller,
  menuId,
  menuRef,
  onActiveStatusChange,
  triggerRef,
  triggerId,
}: {
  activeStatus: SequenceStatus;
  controller: SequenceStatusController;
  menuId: string;
  menuRef: RefObject<HTMLDivElement | null>;
  onActiveStatusChange: (status: SequenceStatus) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  triggerId: string;
}): ReactElement | null {
  if (!controller.menuOpen) return null;
  const anchor = triggerRef.current?.getBoundingClientRect() ?? {
    bottom: 8,
    left: 8,
    right: 8,
    top: 8,
  };
  const position = anchoredPopoverPosition(
    anchor,
    window.innerWidth,
    window.innerHeight,
    { preferredWidth: 280, minimumHeight: 160 },
  );
  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget as Node | null;
    if (
      next &&
      (menuRef.current?.contains(next) || triggerRef.current?.contains(next))
    ) {
      return;
    }
    window.requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (!menu) return;
      const active = document.activeElement;
      if (
        (active && menu.contains(active)) ||
        (active && triggerRef.current?.contains(active))
      ) {
        return;
      }
      controller.closeMenu();
    });
  };
  return createPortal(
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      tabIndex={-1}
      aria-labelledby={triggerId}
      onBlurCapture={handleBlur}
      onKeyDown={moveMenuFocusHorizontally}
      style={{
        ...position,
        zIndex: "var(--pw-layer-popover, 400)",
        background: "var(--pw-bg-elev)",
        border: "1px solid var(--pw-border)",
        borderRadius: "var(--pw-radius-md)",
        boxShadow:
          "0 8px 24px color-mix(in srgb, var(--pw-shadow-color) 18%, transparent)",
        padding: 4,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        overflowY: "auto",
      }}
    >
      {SEQUENCE_STATUS_OPTIONS.map((option) => {
        const selected = option.value === controller.current;
        return (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            tabIndex={activeStatus === option.value ? 0 : -1}
            aria-checked={selected}
            onFocus={() => onActiveStatusChange(option.value)}
            onClick={() => {
              triggerRef.current?.focus();
              controller.pickStatus(option.value);
            }}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 2,
              padding: "8px 10px",
              background: selected ? "var(--pw-bg-elev-2)" : "transparent",
              border: "1px solid transparent",
              borderRadius: "var(--pw-radius-sm)",
              textAlign: "left",
              cursor: "pointer",
              color: "var(--pw-fg)",
              fontSize: 13,
            }}
            onMouseEnter={(event) => {
              if (!selected) {
                event.currentTarget.style.background = "var(--pw-bg-elev-2)";
              }
            }}
            onMouseLeave={(event) => {
              if (!selected)
                event.currentTarget.style.background = "transparent";
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontWeight: 600,
              }}
            >
              <span className={badgeClassFor(option.tone)}>{option.label}</span>
              {selected ? (
                <span className="muted" style={{ fontSize: 11 }}>
                  · current
                </span>
              ) : null}
            </span>
            <span className="muted" style={{ fontSize: 11, lineHeight: 1.4 }}>
              {option.helper}
            </span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

function PauseConfirmation({
  controller,
}: {
  controller: SequenceStatusController;
}): ReactElement {
  const runs = controller.activeRuns;
  return (
    <Modal
      open={controller.confirmKind === "pause"}
      onClose={controller.cancelConfirm}
      title="Pause this sequence?"
      description="Subscribers currently in the flow will hold at their current step until you resume the sequence."
    >
      <div
        style={{
          background: "var(--pw-bg-elev-2)",
          border: "1px solid var(--pw-border-soft)",
          borderRadius: "var(--pw-radius-sm)",
          padding: "10px 12px",
          fontSize: 12,
          lineHeight: 1.5,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div style={{ fontWeight: 600 }}>
          {runs.toLocaleString()} active run{runs === 1 ? "" : "s"} will be held
        </div>
        <div className="muted">
          These subscribers will hold at their current step. No emails will send
          and no delays will tick until you resume. New triggers won't enroll
          anyone while paused.
        </div>
      </div>
      <ModalFooter>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn"
          onClick={controller.cancelConfirm}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={controller.confirmPause}
        >
          Pause sequence
        </button>
      </ModalFooter>
    </Modal>
  );
}

function ArchiveConfirmation({
  controller,
}: {
  controller: SequenceStatusController;
}): ReactElement {
  const matchDescriptionId = useId();
  const mismatch =
    controller.archiveTyped.length > 0 && !controller.archiveTypedMatches;
  return (
    <Modal
      open={controller.confirmKind === "archive"}
      onClose={controller.cancelConfirm}
      title="Archive this sequence?"
      description="Archiving hides the sequence from active listings and prevents new triggers from enrolling subscribers. Existing runs are stopped."
    >
      <div className="field">
        <label className="field-label" htmlFor="seq-archive-confirm">
          Type the sequence name to confirm
        </label>
        <input
          id="seq-archive-confirm"
          type="text"
          className="input"
          value={controller.archiveTyped}
          onChange={(event) => controller.setArchiveTyped(event.target.value)}
          placeholder={controller.confirmationName}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={mismatch}
        />
        <div
          id={matchDescriptionId}
          className="muted"
          style={{ fontSize: 11, marginTop: 4 }}
          aria-live="polite"
        >
          Match required:{" "}
          <span style={{ fontWeight: 600 }}>{controller.confirmationName}</span>
        </div>
      </div>
      <ModalFooter>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn"
          onClick={controller.cancelConfirm}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            if (controller.archiveTypedMatches) controller.confirmArchive();
          }}
          aria-disabled={!controller.archiveTypedMatches || undefined}
          aria-describedby={matchDescriptionId}
        >
          Archive sequence
        </button>
      </ModalFooter>
    </Modal>
  );
}

export function SequenceStatusControl(props: Props): ReactElement {
  const runtimeAvailable = props.runtimeAvailable ?? SEQUENCE_RUNTIME_AVAILABLE;
  const controller = useSequenceStatusController({
    ...props,
    canMutate: props.canMutate && runtimeAvailable,
  });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const triggerId = useId();
  const reasonId = useId();
  const [, setPositionRevision] = useState(0);
  const [activeStatus, setActiveStatus] = useState<SequenceStatus>(
    controller.current,
  );
  const unavailableReason = !runtimeAvailable
    ? SEQUENCE_RUNTIME_UNAVAILABLE_REASON
    : controller.busy
      ? "A sequence status update is already in progress."
      : !props.canMutate
        ? "Editor access is required to change sequence status."
        : props.sequence.id == null
          ? "Save this sequence before changing its status."
          : !Number.isSafeInteger(props.versionRef?.current) ||
              (props.versionRef?.current ?? 0) < 1
            ? "Reload this sequence to confirm its current version before changing status."
          : null;

  useEffect(() => {
    if (controller.menuOpen) setActiveStatus(controller.current);
  }, [controller.current, controller.menuOpen]);

  useEffect(() => {
    if (
      unavailableReason &&
      controller.menuOpen &&
      menuRef.current?.contains(document.activeElement)
    ) {
      triggerRef.current?.focus();
    }
  }, [controller.menuOpen, unavailableReason]);

  const refreshPosition = useCallback(
    () => setPositionRevision((revision) => revision + 1),
    [],
  );

  useStatusMenuInteractions({
    controller,
    menuId,
    menuRef,
    onPositionChange: refreshPosition,
    triggerRef,
  });
  if (!runtimeAvailable) {
    const presentation = sequenceStatusPresentation(props.sequence.status);
    const toneClass =
      presentation.tone === "danger"
        ? " danger"
        : presentation.tone === "warning"
          ? " warning"
          : "";
    return (
      <span
        className={`badge${toneClass}`}
        aria-label={`${presentation.label}. ${SEQUENCE_RUNTIME_UNAVAILABLE_REASON}`}
        title={SEQUENCE_RUNTIME_UNAVAILABLE_REASON}
      >
        {presentation.label}
      </span>
    );
  }
  return (
    <div style={{ display: "inline-flex" }}>
      <StatusTrigger
        controller={controller}
        menuId={menuId}
        reasonId={reasonId}
        triggerRef={triggerRef}
        triggerId={triggerId}
        unavailableReason={unavailableReason}
      />
      {unavailableReason ? (
        <span id={reasonId} className="visually-hidden">
          {unavailableReason}
        </span>
      ) : null}
      <StatusMenu
        activeStatus={activeStatus}
        controller={controller}
        menuId={menuId}
        menuRef={menuRef}
        onActiveStatusChange={setActiveStatus}
        triggerRef={triggerRef}
        triggerId={triggerId}
      />
      <PauseConfirmation controller={controller} />
      <ArchiveConfirmation controller={controller} />
    </div>
  );
}
