/**
 * Sidebar — workspace selector, section nav, account row.
 *
 * Inline SVG icons (1.5px stroke, currentColor) — no icon library.
 * Each item shows its ⌘<n> shortcut on hover or when active.
 */

import {
  Suspense,
  lazy,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";

import { api } from "../lib/api-client";
import { useSidebarCallout } from "../hooks/useSidebarCallout";
import { RecoverableSuspense } from "./RecoverableSuspense";
import { SidebarCallout } from "./SidebarCallout";

const IconChev = ({ className }: { className?: string }): ReactElement => (
  <svg
    className={className}
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

const WorkspaceMenu = lazy(() =>
  import("./WorkspaceMenu").then((module) => ({
    default: module.WorkspaceMenu,
  })),
);

const SidebarDomainNavigation = lazy(() =>
  import("./SidebarDomainNavigation").then((module) => ({
    default: module.SidebarDomainNavigation,
  })),
);

export function Sidebar(): ReactElement {
  const [email, setEmail] = useState<string>("");
  const [tenant, setTenant] = useState<string>("Moosewave");
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const workspaceButtonRef = useRef<HTMLButtonElement | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await api.getMe();
      if (cancelled) return;
      if (res.data && res.data.user) setEmail(res.data.user);
      if (res.data && res.data.tenant) setTenant(res.data.tenant);
      if (!res.data?.user) {
        const keyInfo = await api.getApiKeySelfInfo();
        if (cancelled) return;
        if (keyInfo.data?.actor)
          setEmail(keyInfo.data.actor.trim() || "API key");
        else if (keyInfo.data?.tenant_id) setEmail("API key");
        if (keyInfo.data?.tenant_slug) setTenant(keyInfo.data.tenant_slug);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const callout = useSidebarCallout();

  const displayName = tenant || "Moosewave";
  const slug = email || "no account";

  return (
    <aside
      className="sidebar"
      data-tour="sidebar"
      data-collapsed={sidebarCollapsed ? "true" : "false"}
      aria-label="Application sidebar"
    >
      <div className="sidebar-workspace-wrap">
        <button
          ref={workspaceButtonRef}
          type="button"
          className="sidebar-workspace"
          aria-haspopup="menu"
          aria-controls={menuOpen ? "workspace-menu" : undefined}
          aria-expanded={menuOpen}
          aria-label={`Workspace menu for ${displayName}`}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <div className="sidebar-workspace-avatar">
            {(displayName.charAt(0) || "P").toUpperCase()}
          </div>
          <div className="sidebar-workspace-name">{displayName}</div>
          <IconChev className="sidebar-workspace-chev" />
        </button>
        {menuOpen ? (
          <Suspense fallback={null}>
            <WorkspaceMenu
              open
              anchor={workspaceButtonRef.current}
              onClose={() => setMenuOpen(false)}
              workspaceName={displayName}
              workspaceSlug={slug}
            />
          </Suspense>
        ) : null}
      </div>

      <RecoverableSuspense
        fallback={
          <nav
            className="sidebar-scroll sidebar-navigation-loading"
            aria-label="Primary"
            aria-busy="true"
          >
            <span className="visually-hidden">Loading navigation…</span>
          </nav>
        }
      >
        <SidebarDomainNavigation onCollapsedChange={setSidebarCollapsed} />
      </RecoverableSuspense>

      <SidebarCallout callout={callout} />

      <div className="sidebar-account">
        <div className="sidebar-account-dot" />
        <div className="sidebar-account-email">{email || "Not signed in"}</div>
      </div>
    </aside>
  );
}
