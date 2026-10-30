// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import Link from "next/link";

import { MoosewaveWordmark } from "@/components/brand/moosewave-mark";
import { cn } from "@/lib/utils";

function BrandLink({ inverse = false }: { inverse?: boolean }) {
  return (
    <Link
      href="/"
      aria-label="Moosewave home"
      className={cn(
        "group inline-flex w-fit items-center rounded-lg outline-none transition-transform hover:-rotate-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        inverse && "focus-visible:ring-offset-pw-ink",
      )}
    >
      <MoosewaveWordmark
        style={
          inverse
            ? ({
                color: "var(--mw-paper)",
                "--mw-logo-cutout": "var(--mw-ink)",
              } as React.CSSProperties)
            : undefined
        }
      />
    </Link>
  );
}

function ProductSignal() {
  const rows = [
    { label: "Migration", value: "Dry-run verified", tone: "bg-success" },
    { label: "Inbox Reality", value: "Placement visible", tone: "bg-info" },
    { label: "Voice profile", value: "Ready to create", tone: "bg-gold" },
  ];

  return (
    <div
      aria-hidden="true"
      className="mw-cut-paper overflow-hidden border"
      style={{
        borderColor: "rgb(255 255 255 / 0.15)",
        background: "rgb(255 255 255 / 0.055)",
        boxShadow: "6px 7px 0 rgb(0 0 0 / 0.32)",
      }}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-pw-ember-400" />
          <span className="size-2 rounded-full bg-pw-gold/80" />
          <span className="size-2 rounded-full bg-white/20" />
        </div>
        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/40">
          Workspace signal
        </span>
      </div>
      <div className="space-y-2 p-3">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-4 border px-3.5 py-3"
            style={{
              borderColor: "rgb(255 255 255 / 0.09)",
              borderRadius: "12px 18px 14px 16px",
              background: "rgb(0 0 0 / 0.15)",
            }}
          >
            <span className="flex min-w-0 items-center gap-2.5 text-sm text-white/70">
              <span
                className={cn("size-1.5 shrink-0 rounded-full", row.tone)}
              />
              <span className="truncate">{row.label}</span>
            </span>
            <span className="shrink-0 text-xs font-medium text-white/90">
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * AuthShell — the single owner of the auth-page outer layout (AUTH-008).
 *
 * Consolidates the wrapper + centered card column + "Moosewave" wordmark that
 * was copy-pasted across login/signup/forgot/reset/verify/magic/totp, and
 * folds in the accessibility affordances that had diverged: a skip link and a
 * <main> landmark (AUTH-007) on every page, not just login. Per-page primary
 * titles render as an <h1> via CardTitle `as="h1"` inside `children`
 * (AUTH-006).
 *
 * The `#auth-main` id + skip href are intentionally literal (not interpolated)
 * so the public-release UX contract test can assert the landmark exists.
 */
export function AuthShell({
  children,
  footer,
  skipLabel = "sign in",
  className,
}: {
  children: React.ReactNode;
  /** Optional inline footer (rendered inside a centered <p>). */
  footer?: React.ReactNode;
  /** Trailing label for the skip link ("Skip to <skipLabel>"). */
  skipLabel?: string;
  className?: string;
}) {
  return (
    <>
      <a
        href="#auth-main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-foreground focus:px-3 focus:py-2 focus:text-sm focus:text-background"
      >
        Skip to {skipLabel}
      </a>
      <div
        className={cn(
          "relative min-h-screen min-h-[100svh] overflow-hidden outline-none lg:grid lg:grid-cols-2",
          className,
        )}
        style={{ background: "var(--mw-paper)" }}
      >
        <aside
          className="relative hidden min-h-[100svh] overflow-hidden lg:flex lg:flex-col"
          style={{ background: "var(--mw-ink)", color: "var(--mw-paper)" }}
        >
          <div
            aria-hidden="true"
            className="absolute rounded-full"
            style={{
              top: "-11rem",
              left: "-10rem",
              width: "32rem",
              height: "32rem",
              background: "rgb(200 16 46 / 0.2)",
              filter: "blur(110px)",
            }}
          />
          <div
            aria-hidden="true"
            className="absolute rounded-full"
            style={{
              right: "-10rem",
              bottom: "-13rem",
              width: "30rem",
              height: "30rem",
              background: "rgb(242 178 51 / 0.1)",
              filter: "blur(120px)",
            }}
          />
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(circle, white 1px, transparent 1px) center / 24px 24px",
              opacity: 0.055,
            }}
          />

          <div className="relative z-10 flex min-h-[100svh] flex-col px-10 py-9 xl:px-14 xl:py-11">
            <BrandLink inverse />

            <div className="my-auto max-w-lg py-12">
              <div className="mb-5 flex items-center gap-2 font-hand text-xl text-mw-yellow">
                <span className="h-px w-7 bg-mw-yellow" />
                One deliberate workspace
              </div>
              <p
                className="font-display font-normal uppercase tracking-tight"
                style={{
                  color: "var(--mw-paper)",
                  fontSize: "clamp(3.4rem, 5.8vw, 6.5rem)",
                  lineHeight: 0.9,
                  maxWidth: "10ch",
                }}
              >
                Create in your voice. Send with proof.
              </p>
              <p className="mt-6 max-w-md text-base leading-7 text-white/60">
                Bring audience migration, publishing, and deliverability into
                one calm, accountable workflow.
              </p>
              <div className="mt-9 max-w-md">
                <ProductSignal />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/10 pt-5 text-[11px] text-white/50">
              <span>Passkeys</span>
              <span className="size-1 rounded-full bg-white/20" aria-hidden />
              <span>Two-factor authentication</span>
              <span className="size-1 rounded-full bg-white/20" aria-hidden />
              <span>Scoped access</span>
            </div>
          </div>
        </aside>

        <main
          id="auth-main"
          tabIndex={-1}
          className="relative flex min-h-[100svh] items-center justify-center px-5 py-8 outline-none sm:px-8 sm:py-12 lg:px-12 xl:px-20"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(circle at 70% 10%, rgb(200 16 46 / 0.055), transparent 30%), radial-gradient(circle at 15% 90%, rgb(242 178 51 / 0.08), transparent 28%)",
            }}
          />
          <div className="relative z-10 w-full max-w-lg">
            <div className="mb-8 flex justify-center lg:hidden">
              <BrandLink />
            </div>

            <div className="pw-auth-content pw-page-transition">{children}</div>

            {footer ? (
              <p className="mt-6 text-center text-sm text-muted-foreground">
                {footer}
              </p>
            ) : null}

            <nav
              aria-label="Authentication footer"
              className="mt-5 flex items-center justify-center gap-4 text-[11px] text-muted-foreground/80"
            >
              <Link
                href="/legal/privacy"
                className="rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Privacy
              </Link>
              <span aria-hidden className="size-0.5 rounded-full bg-border" />
              <Link
                href="/legal/terms"
                className="rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Terms
              </Link>
              <span aria-hidden className="size-0.5 rounded-full bg-border" />
              <Link
                href="/security"
                className="rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Security
              </Link>
            </nav>
          </div>
        </main>
      </div>
    </>
  );
}
