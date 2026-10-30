/**
 * TopBar — page title + breadcrumb on the left, search + icons on the right.
 * Search is a click-target that opens the command palette (we don't run a
 * separate search input). Cmd-K shortcut is rendered as a kbd hint.
 *
 * The bell opens the encrypted Notification Center. Its badge comes from the
 * same durable read/archive model as the panel, so the trigger, list, and OS
 * badge policy cannot drift into separate definitions of "unread".
 */

import {
  Suspense,
  lazy,
  type ReactElement,
  type ReactNode,
  type SVGProps,
  useCallback,
  useRef,
  useState,
} from "react";

import { routeMetaForSection } from "../lib/desktop-routes";
import { useDesktopShortcut } from "../hooks/useDesktopShortcut";
import { useNotificationCenter } from "../lib/notification-center";
import { useNotificationInbox } from "../lib/notification-inbox-store";
import { setCommandOpen, useSection, useViewerModeActive } from "../lib/store";
import { LiveSubsChip } from "./dashboard/LiveSubsChip";
import type { NotificationPanelCloseReason } from "./NotificationsPanel";

interface Props {
  trailingAccessory?: ReactNode;
}

const NotificationsPanel = lazy(() =>
  import("./NotificationsPanel").then((module) => ({
    default: module.NotificationsPanel,
  })),
);

const AccountMenu = lazy(() =>
  import("./AccountMenu").then((m) => ({ default: m.AccountMenu })),
);
const DesktopUpdateBadge = lazy(() =>
  import("./DesktopUpdateBadge").then((m) => ({
    default: m.DesktopUpdateBadge,
  })),
);
const TransferCenter = lazy(() =>
  import("./TransferCenter").then((m) => ({ default: m.TransferCenter })),
);

const iconProps: SVGProps<SVGSVGElement> = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

const SearchIcon = (): ReactElement => (
  <svg {...iconProps}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

const BellIcon = (): ReactElement => (
  <svg {...iconProps} width={16} height={16}>
    <path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5 2 6H4c.5-1 2-2 2-6z" />
    <path d="M10 18a2 2 0 0 0 4 0" />
  </svg>
);

const AccountIcon = (): ReactElement => (
  <svg {...iconProps} width={16} height={16}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </svg>
);

export function TopBar({ trailingAccessory }: Props = {}): ReactElement {
  // Subscribe only to `section` — TopBar no longer re-renders on
  // conn / theme / commandOpen state changes.
  const section = useSection();
  const meta = routeMetaForSection(section);
  const commandShortcut = useDesktopShortcut("app.command-palette");
  const notificationCenter = useNotificationCenter();
  // The UNIFIED count, so the badge cannot disagree with the panel it opens.
  // The vault's own count sees only notifications this machine received, so a
  // cross-device row made the bell read 0 above a panel reading 1.
  const inbox = useNotificationInbox();
  const unreadCount =
    inbox.rows.length > 0 ? inbox.unreadCount : notificationCenter.unreadCount;
  // SUB-091: subtle "you're previewing as a viewer" indicator.
  const viewerModeActive = useViewerModeActive();

  const [notifOpen, setNotifOpen] = useState<boolean>(false);
  const [accountOpen, setAccountOpen] = useState<boolean>(false);
  const [transferOpen, setTransferOpen] = useState<boolean>(false);
  const notificationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const accountTriggerRef = useRef<HTMLButtonElement | null>(null);

  const closeNotif = useCallback(
    (reason?: NotificationPanelCloseReason): void => {
      setNotifOpen(false);
      if (reason === "escape" || reason === "button") {
        window.requestAnimationFrame(() =>
          notificationTriggerRef.current?.focus(),
        );
      }
    },
    [],
  );

  const handleToggle = (): void => {
    setNotifOpen((v) => {
      const next = !v;
      if (next) {
        // Mutually exclusive popovers — opening one closes the other.
        setAccountOpen(false);
        setTransferOpen(false);
      }
      return next;
    });
  };

  const handleAccountToggle = (): void => {
    setAccountOpen((v) => {
      const next = !v;
      // Mutually exclusive popovers.
      if (next) {
        setNotifOpen(false);
        setTransferOpen(false);
      }
      return next;
    });
  };

  const handleTransferToggle = (): void => {
    setTransferOpen((value) => {
      const next = !value;
      if (next) {
        setNotifOpen(false);
        setAccountOpen(false);
      }
      return next;
    });
  };

  return (
    <div className="topbar">
      <div className="topbar-crumb">{meta.crumb} /</div>
      <div className="topbar-title">{meta.title}</div>
      <div className="spacer" />

      <button
        type="button"
        className="topbar-search"
        onClick={() => setCommandOpen(true)}
        aria-label="Open global search and command palette"
        aria-haspopup="dialog"
        aria-keyshortcuts={commandShortcut?.ariaKeyShortcuts}
      >
        <span className="topbar-search-icon">
          <SearchIcon />
        </span>
        <span className="topbar-search-label">
          Search commands and records…
        </span>
        <span className="topbar-search-kbd">
          {commandShortcut?.label ?? "Search"}
        </span>
      </button>

      <LiveSubsChip />

      {viewerModeActive ? (
        <button
          ref={accountTriggerRef}
          type="button"
          className="topbar-viewer-badge"
          aria-label="Viewer preview active — open account menu to exit"
          onClick={handleAccountToggle}
        >
          <span className="topbar-viewer-dot" aria-hidden="true" />
          Viewer preview
        </button>
      ) : null}

      <Suspense fallback={null}>
        <TransferCenter
          open={transferOpen}
          onToggle={handleTransferToggle}
          onClose={() => setTransferOpen(false)}
        />
      </Suspense>

      <div className="topbar-notif-wrap">
        <button
          ref={notificationTriggerRef}
          type="button"
          className="topbar-iconbtn"
          aria-label={
            unreadCount === 0
              ? "Notifications, none unread"
              : `Notifications, ${unreadCount} unread`
          }
          aria-haspopup="dialog"
          aria-expanded={notifOpen}
          aria-controls={notifOpen ? "desktop-notification-center" : undefined}
          data-pw-notif-trigger
          onClick={handleToggle}
        >
          <BellIcon />
          {unreadCount > 0 ? (
            <span className="topbar-bell-count" aria-hidden="true">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          ) : null}
        </button>
        {notifOpen ? (
          <Suspense fallback={null}>
            <NotificationsPanel open onClose={closeNotif} />
          </Suspense>
        ) : null}
      </div>

      <div className="topbar-notif-wrap">
        <button
          type="button"
          className="topbar-iconbtn"
          aria-label="Account menu"
          aria-describedby="desktop-update-badge-status"
          aria-haspopup="menu"
          aria-controls={accountOpen ? "account-menu" : undefined}
          aria-expanded={accountOpen}
          data-pw-account-trigger
          onClick={handleAccountToggle}
        >
          <AccountIcon />
        </button>
        <Suspense fallback={null}>
          <DesktopUpdateBadge />
        </Suspense>
        {accountOpen ? (
          <Suspense fallback={null}>
            <AccountMenu
              trigger={accountTriggerRef.current}
              open={accountOpen}
              onClose={() => setAccountOpen(false)}
            />
          </Suspense>
        ) : null}
      </div>
      {trailingAccessory}
    </div>
  );
}
