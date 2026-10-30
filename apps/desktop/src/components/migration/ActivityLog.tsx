/**
 * ActivityLog — scrolling feed of human-readable lines emitted as the
 * orchestrator works. Auto-scrolls to the latest entry; capped at the
 * last 200 lines so a long-running migration never grows the DOM.
 */

import { type ReactElement, useEffect, useRef, useState } from "react";

export interface ActivityEntry {
  /** Stable id for React keys. Caller controls — usually a monotonic counter. */
  id: string | number;
  /** ISO-8601 timestamp shown next to the line. */
  at: string;
  message: string;
}

interface Props {
  events: ActivityEntry[];
  /** Optional max height; default 160px keeps the panel compact. */
  maxHeight?: number;
}

export function ActivityLog({ events, maxHeight = 160 }: Props): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const announcementTimerRef = useRef<number | null>(null);
  const pendingAnnouncementRef = useRef("");
  const [following, setFollowing] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (following && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [events.length, following]);

  useEffect(() => {
    const latest = events.at(-1);
    if (!latest) return;
    pendingAnnouncementRef.current = latest.message;
    if (announcementTimerRef.current !== null) return;
    announcementTimerRef.current = window.setTimeout(() => {
      announcementTimerRef.current = null;
      setAnnouncement(pendingAnnouncementRef.current);
    }, 800);
  }, [events]);

  useEffect(
    () => () => {
      if (announcementTimerRef.current !== null) {
        window.clearTimeout(announcementTimerRef.current);
      }
    },
    [],
  );

  const recent = events.length > 200 ? events.slice(-200) : events;

  return (
    <div className="migration-activity-shell">
      <div
        ref={ref}
        className="activity-log"
        role="log"
        aria-label="Migration activity"
        aria-live="off"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard readers must be able to pause and inspect the scrollable log
        tabIndex={0}
        style={{ maxHeight }}
        onScroll={(event) => {
          const node = event.currentTarget;
          const distanceFromBottom =
            node.scrollHeight - node.scrollTop - node.clientHeight;
          setFollowing(distanceFromBottom <= 24);
        }}
      >
        {recent.length === 0 ? (
          <div className="migration-activity-empty">
            Waiting for the first batch…
          </div>
        ) : (
          recent.map((entry) => (
            <div key={entry.id} className="migration-activity-entry">
              <span className="migration-activity-time tabular">
                {fmtTime(entry.at)}
              </span>
              <span>{entry.message}</span>
            </div>
          ))
        )}
      </div>
      {!following && recent.length > 0 ? (
        <button
          type="button"
          className="btn btn-sm migration-activity-follow"
          onClick={() => {
            if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
            setFollowing(true);
          }}
        >
          Jump to latest activity
        </button>
      ) : null}
      <span
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
        aria-relevant="text"
        data-migration-activity-announcement
      >
        {announcement}
      </span>
    </div>
  );
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}
