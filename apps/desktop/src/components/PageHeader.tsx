/**
 * PageHeader — unified tab header.
 *
 * Replaces the per-tab ad-hoc `.page-header` markup. Hierarchy:
 *   • optional eyebrow (uppercase, muted)
 *   • title (with optional <NewBadge force /> next to it)
 *   • subtitle (muted, <= 72ch)
 *   • action buttons (right-aligned, primary on the right)
 *   • optional `meta` slot below the title for chips/range pickers
 *
 * Most tabs already have inputs/range chips. This component is opt-in;
 * pages migrate when convenient. Existing `.page-header` styles still
 * work; the two coexist.
 */

import { type ReactElement, type ReactNode, useId } from "react";

interface Action {
  label: string;
  onClick: () => void;
  variant?: "primary" | "ghost" | "danger";
  icon?: ReactNode;
  disabled?: boolean;
  /**
   * Supplemental action guidance. It is rendered as an accessible
   * description; when the action is unavailable, the reason stays visibly
   * present instead of being trapped in a native title tooltip.
   */
  title?: string;
}

interface Props {
  eyebrow?: string;
  title: string;
  titleBadge?: ReactNode;
  subtitle?: string;
  actions?: Action[];
  /** Chips, range pickers, or arbitrary content under the title. */
  meta?: ReactNode;
}

function actionClass(v: Action["variant"]): string {
  if (v === "primary") return "btn btn-primary";
  if (v === "danger") return "btn btn-danger";
  if (v === "ghost") return "btn btn-ghost";
  return "btn";
}

export function PageHeader({
  eyebrow,
  title,
  titleBadge,
  subtitle,
  actions,
  meta,
}: Props): ReactElement {
  const actionDescriptionRootId = useId();
  return (
    <header className="page-header-v2">
      <div className="page-header-v2-text">
        {eyebrow ? (
          <div className="page-header-v2-eyebrow">{eyebrow}</div>
        ) : null}
        <h1 className="page-header-v2-title">
          <span>{title}</span>
          {titleBadge}
        </h1>
        {subtitle ? (
          <div className="page-header-v2-subtitle">{subtitle}</div>
        ) : null}
        {meta ? <div className="page-header-v2-meta">{meta}</div> : null}
      </div>
      {actions && actions.length > 0 ? (
        <div className="page-header-v2-actions">
          {actions.map((action, index) => {
            const descriptionId = action.title
              ? `${actionDescriptionRootId}-action-${index}`
              : undefined;
            return (
              <span key={index} className="page-header-v2-action">
                <button
                  type="button"
                  className={`${actionClass(action.variant)}${action.disabled ? " pw-discoverable-unavailable" : ""}`}
                  onClick={(event) => {
                    if (action.disabled) {
                      event.preventDefault();
                      return;
                    }
                    action.onClick();
                  }}
                  aria-disabled={action.disabled || undefined}
                  aria-describedby={descriptionId}
                >
                  {action.icon}
                  {action.label}
                </button>
                {action.title ? (
                  <span
                    id={descriptionId}
                    className={
                      action.disabled
                        ? "page-header-v2-action-reason"
                        : "visually-hidden"
                    }
                  >
                    {action.title}
                  </span>
                ) : null}
              </span>
            );
          })}
        </div>
      ) : null}
    </header>
  );
}
