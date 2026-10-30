/**
 * AuthShell — split-screen chrome for SignIn / SignUp / PasswordReset
 * / PasswordResetConfirm / MagicLinkReturn / Welcome.
 *
 * Left aside: brand mark, headline, sub, optional quote, and a full-
 * bleed photographic illustration tinted to the chosen tone.
 *
 * Right main: form content (children), with optional brand row + page
 * heading prepended. Legal/support navigation is the default footer.
 *
 * Collapses to single-column on narrow viewports (< 880px); the aside
 * is hidden, the form keeps its max-width.
 */

import type { ReactElement, ReactNode } from "react";

import type {
  AuthShowcaseSlides,
  AuthShowcaseTone,
} from "../lib/auth-showcase";
import { AuthShowcase } from "./AuthShowcase";
import { LegalLinks } from "./LegalLinks";

export type AuthTone = AuthShowcaseTone;

interface AsideQuote {
  text: string;
  /** Display name (bold). */
  name: string;
  /** Role / company / context. */
  meta?: string;
}

interface AuthShellProps {
  tone?: AuthTone;
  illustration: string; // imported WebP path
  asideEyebrow?: string;
  asideHeadline?: string;
  asideSub?: string;
  asideQuote?: AsideQuote;
  /** Optional rotating product showcase. Static aside content is ignored. */
  showcaseSlides?: AuthShowcaseSlides;
  brandName?: string; // defaults to "Moosewave"
  /** Allows a specific auth step to opt into richer right-pane treatment. */
  mainVariant?: "default" | "credentials";
  /** Title rendered above the form. */
  heading: string;
  /** Sub-line under the heading. */
  headingSub?: string;
  /** The form itself (or any custom right-pane content). */
  children: ReactNode;
  /** Optional bottom row — defaults to legal and support links. */
  footer?: ReactNode;
}

/** Default footer avoids deployment-level claims while keeping help reachable. */
function DefaultAuthFooter(): ReactElement {
  return <LegalLinks />;
}

export function AuthShell({
  tone = "mint",
  illustration,
  asideEyebrow = "Moosewave",
  asideHeadline,
  asideSub,
  asideQuote,
  showcaseSlides,
  brandName = "Moosewave",
  mainVariant = "default",
  heading,
  headingSub,
  children,
  footer,
}: AuthShellProps): ReactElement {
  return (
    <div className={`auth-shell-v2`}>
      <main
        className={`auth-main${mainVariant === "credentials" ? " auth-main-credentials" : ""}`}
      >
        <div
          className={`auth-main-inner${mainVariant === "credentials" ? " auth-main-inner-credentials" : ""}`}
        >
          <div className="auth-brand-v2">
            <div className="auth-mark-v2" aria-hidden="true">
              P
            </div>
            <div className="auth-name-v2">{brandName}</div>
          </div>

          <header className="auth-heading">
            <h1 className="auth-heading-title">{heading}</h1>
            {headingSub ? (
              <p className="auth-heading-sub">{headingSub}</p>
            ) : null}
          </header>

          {children}

          {footer === undefined ? <DefaultAuthFooter /> : footer}
        </div>
      </main>

      {showcaseSlides ? (
        <AuthShowcase slides={showcaseSlides} />
      ) : (
        <aside className={`auth-aside tone-${tone}`} aria-hidden="true">
          <div
            className="auth-aside-image"
            style={{ backgroundImage: `url(${illustration})` }}
          />
          <div className="auth-aside-content">
            {asideEyebrow ? (
              <div className="auth-aside-eyebrow">{asideEyebrow}</div>
            ) : null}
            {asideHeadline ? (
              <p className="auth-aside-headline">{asideHeadline}</p>
            ) : null}
            {asideSub ? <p className="auth-aside-sub">{asideSub}</p> : null}
          </div>
          {asideQuote ? (
            <div className="auth-aside-quote">
              <div className="auth-aside-quote-text">
                &ldquo;{asideQuote.text}&rdquo;
              </div>
              <div className="auth-aside-quote-meta">
                <span className="auth-aside-quote-meta-name">
                  {asideQuote.name}
                </span>
                {asideQuote.meta ? <span>· {asideQuote.meta}</span> : null}
              </div>
            </div>
          ) : null}
        </aside>
      )}
    </div>
  );
}
