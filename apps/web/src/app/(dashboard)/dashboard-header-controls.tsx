// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  HelpCircle,
  Keyboard,
  KeyRound,
  Loader2,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Shield,
  Sparkles,
  Sun,
  User,
  Users,
} from "lucide-react";
import { useTheme } from "next-themes";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  HeaderMenu,
  HeaderMenuButton,
  HeaderMenuLink,
} from "@/components/ui/header-menu";
import type { MeResponse, UserWorkspace } from "@/lib/auth-api";
import { DASHBOARD_CREATE_ROUTES } from "@/lib/dashboard-shell-routes";
import { clearQueryState } from "@/lib/query-client";
import { asRoute } from "@/lib/typed-routes";

function initialsFor(value: string | undefined, fallback = "PW"): string {
  if (!value) return fallback;
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return value.slice(0, 2).toUpperCase();
}

export function TenantSwitcher({ account }: { account: MeResponse | null }) {
  const router = useRouter();
  const switchingWorkspaceRef = useRef(false);
  const [switchingWorkspace, setSwitchingWorkspace] = useState<string | null>(
    null,
  );
  const [switchError, setSwitchError] = useState<string | null>(null);
  const name = account?.workspace_name || "Workspace";
  const slug = account?.workspace_slug || "current";
  const role = account?.role || "member";
  const initials = initialsFor(name);
  const workspaceQuery = useQuery({
    queryKey: ["auth", "workspaces", account?.user_id ?? "anon"],
    queryFn: async () => {
      const { listWorkspaces } = await import("@/lib/auth-api");
      return listWorkspaces();
    },
    enabled: Boolean(account?.user_id),
    staleTime: 60_000,
    retry: false,
  });
  const workspaces = workspaceQuery.data;
  const others = (workspaces ?? []).filter(
    (workspace: UserWorkspace) =>
      !workspace.current && workspace.id !== account?.tenant_id,
  );

  const switchTo = async (workspaceId: string) => {
    if (switchingWorkspaceRef.current) return;
    switchingWorkspaceRef.current = true;
    setSwitchError(null);
    setSwitchingWorkspace(workspaceId);
    try {
      await clearQueryState();
      router.push(
        asRoute(
          `/login?workspace=${encodeURIComponent(workspaceId)}&next=/app`,
        ),
      );
    } catch {
      switchingWorkspaceRef.current = false;
      setSwitchingWorkspace(null);
      setSwitchError(
        "We couldn’t prepare that workspace. Your current workspace is unchanged; try again.",
      );
    }
  };

  return (
    <HeaderMenu
      label="Workspace actions"
      align="start"
      panelClassName="sm:max-md:-left-11 sm:w-[min(18rem,calc(100vw-1rem))]"
      header={
        <>
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {slug} · {role}
          </div>
        </>
      }
      trigger={({ toggle, triggerRef, panelId, ariaExpanded }) => (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-1 h-11 w-11 shrink-0 gap-0 rounded-[8px_11px_8px_11px] border border-mw-ink/20 bg-mw-paper p-0 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring md:-ml-2 md:h-9 md:w-auto md:max-w-40 md:gap-2 md:px-3 lg:max-w-[min(18rem,30vw)] [@media(pointer:coarse)]:h-11"
          type="button"
          aria-label={`Current workspace: ${name}`}
          aria-controls={panelId}
          aria-expanded={ariaExpanded}
          title={name}
          ref={triggerRef}
          onClick={toggle}
        >
          <span
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-mw-blue text-[10px] font-bold text-white"
            aria-hidden
          >
            {initials}
          </span>
          <span className="hidden truncate md:inline">{name}</span>
          <ChevronDown
            className="hidden h-3.5 w-3.5 text-muted-foreground md:block"
            aria-hidden
          />
        </Button>
      )}
    >
      {workspaceQuery.isPending ? (
        <p
          role="status"
          aria-live="polite"
          className="flex min-h-11 items-center gap-2 px-2 text-sm text-muted-foreground"
        >
          <Loader2
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          Loading workspaces…
        </p>
      ) : workspaceQuery.isError ? (
        <div
          role="alert"
          className="mb-1 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive-emphasis"
        >
          <p>Other workspaces could not be loaded.</p>
          <HeaderMenuButton
            closeOnClick={false}
            busy={workspaceQuery.isFetching}
            onClick={() => void workspaceQuery.refetch()}
          >
            {workspaceQuery.isFetching ? (
              <Loader2
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : null}
            {workspaceQuery.isFetching ? "Retrying…" : "Retry"}
          </HeaderMenuButton>
        </div>
      ) : others.length > 0 ? (
        <>
          <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Switch workspace
          </div>
          {others.map((workspace: UserWorkspace) => (
            <HeaderMenuButton
              key={workspace.id}
              closeOnClick={false}
              busy={switchingWorkspace === workspace.id}
              disabled={Boolean(switchingWorkspace)}
              onClick={() => void switchTo(workspace.id)}
            >
              <span
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-bold text-muted-foreground"
                aria-hidden
              >
                {initialsFor(workspace.name)}
              </span>
              <span className="min-w-0 flex-1 truncate text-left">
                {workspace.name}
                <span className="block truncate text-xs text-muted-foreground">
                  {workspace.slug} · {workspace.role}
                </span>
              </span>
              {switchingWorkspace === workspace.id ? (
                <Loader2
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-label="Switching workspace"
                />
              ) : null}
            </HeaderMenuButton>
          ))}
          <div className="my-1 border-t" />
        </>
      ) : (
        <p className="min-h-11 px-2 py-2 text-sm text-muted-foreground">
          This is your only workspace.
        </p>
      )}
      {switchError ? (
        <p
          role="alert"
          className="mb-1 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-2 text-sm text-destructive-emphasis"
        >
          {switchError}
        </p>
      ) : null}
      <HeaderMenuLink href="/app/settings">
        <Shield className="h-4 w-4" aria-hidden />
        Workspace settings
      </HeaderMenuLink>
      <HeaderMenuLink href="/app/settings/team">
        <Users className="h-4 w-4" aria-hidden />
        Team access
      </HeaderMenuLink>
    </HeaderMenu>
  );
}

export function UserMenu({
  account,
  onLogout,
}: {
  account: MeResponse | null;
  onLogout: () => void;
}) {
  const email = account?.email || "Account";
  const initials = initialsFor(email, "ME");
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <HeaderMenu
      label="Account actions"
      align="end"
      header={
        <>
          <div className="truncate text-sm font-medium">{email}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {account?.role || "member"}
          </div>
        </>
      }
      trigger={({ toggle, triggerRef, panelId, ariaExpanded }) => (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-11 w-11 shrink-0 p-0 hover:bg-transparent md:h-9 md:w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
          aria-label={`Account menu for ${email}`}
          aria-controls={panelId}
          aria-expanded={ariaExpanded}
          title="Account"
          ref={triggerRef}
          onClick={toggle}
        >
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-[8px_11px_8px_11px] border border-mw-ink/20 bg-mw-pink text-xs font-bold text-mw-ink"
            aria-hidden
          >
            {initials}
          </span>
        </Button>
      )}
    >
      <HeaderMenuLink href="/app/settings">
        <User className="h-4 w-4" aria-hidden />
        Profile
      </HeaderMenuLink>
      <HeaderMenuLink href="/app/settings/security">
        <Shield className="h-4 w-4" aria-hidden />
        Security
      </HeaderMenuLink>
      <HeaderMenuLink href="/app/settings/api">
        <KeyRound className="h-4 w-4" aria-hidden />
        API keys
      </HeaderMenuLink>
      <div className="my-1 h-px bg-border" />
      {(() => {
        const current = (
          mounted ? (theme ?? "system") : "light"
        ) as ThemeChoice;
        const Icon = themeIcon(current);
        return (
          <HeaderMenuButton onClick={() => setTheme(nextThemeChoice(current))}>
            <Icon className="h-4 w-4" aria-hidden />
            Theme: {themeLabel(current)}
          </HeaderMenuButton>
        );
      })()}
      <HeaderMenuButton
        onClick={() => window.dispatchEvent(new Event("pw:open-shortcuts"))}
      >
        <Keyboard className="h-4 w-4" aria-hidden />
        Keyboard shortcuts
      </HeaderMenuButton>
      <HeaderMenuLink href={asRoute("/docs")}>
        <HelpCircle className="h-4 w-4" aria-hidden />
        Help &amp; docs
      </HeaderMenuLink>
      <HeaderMenuLink href={asRoute("/changelog")}>
        <Sparkles className="h-4 w-4" aria-hidden />
        What&rsquo;s new
      </HeaderMenuLink>
      <div className="my-1 h-px bg-border" />
      <HeaderMenuButton destructive onClick={onLogout}>
        <LogOut className="h-4 w-4" aria-hidden />
        Sign out
      </HeaderMenuButton>
    </HeaderMenu>
  );
}

export function CreateMenu() {
  return (
    <div className="shrink-0">
      <HeaderMenu
        label="Create"
        align="end"
        trigger={({ toggle, triggerRef, panelId, ariaExpanded }) => (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 w-11 shrink-0 gap-0 p-0 focus-visible:ring-2 focus-visible:ring-ring md:h-9 md:w-auto md:gap-1.5 md:px-3 [@media(pointer:coarse)]:h-11"
            aria-label="Create"
            aria-controls={panelId}
            aria-expanded={ariaExpanded}
            ref={triggerRef}
            onClick={toggle}
          >
            <Plus className="h-4 w-4" aria-hidden />
            <span className="hidden md:inline">Create</span>
          </Button>
        )}
      >
        {DASHBOARD_CREATE_ROUTES.map((route) => (
          <HeaderMenuLink key={route.href} href={route.href as Route}>
            <Plus className="h-4 w-4 text-muted-foreground" aria-hidden />
            {route.label}
          </HeaderMenuLink>
        ))}
      </HeaderMenu>
    </div>
  );
}

const THEME_ORDER = ["light", "dark", "system"] as const;
type ThemeChoice = (typeof THEME_ORDER)[number];

function nextThemeChoice(current: string | undefined): ThemeChoice {
  const index = THEME_ORDER.indexOf((current ?? "light") as ThemeChoice);
  return THEME_ORDER[
    (index < 0 ? 0 : index + 1) % THEME_ORDER.length
  ] as ThemeChoice;
}

function themeIcon(current: ThemeChoice) {
  return current === "dark" ? Moon : current === "system" ? Monitor : Sun;
}

function themeLabel(current: ThemeChoice) {
  return current === "dark"
    ? "Dark"
    : current === "system"
      ? "System"
      : "Light";
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = (mounted ? (theme ?? "system") : "light") as ThemeChoice;
  const next = nextThemeChoice(current);
  const Icon = themeIcon(current);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={`Theme: ${themeLabel(current)}. Switch to ${themeLabel(next)}.`}
      title={`Theme: ${themeLabel(current)}`}
      onClick={() => setTheme(next)}
    >
      <Icon className="h-4 w-4" />
      <span className="sr-only">Toggle theme (light, dark, system)</span>
    </Button>
  );
}
