import {
  type FormEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  BounceEvent,
  ComplaintEvent,
  FeedbackHistory,
} from "../../lib/api/feedback";
import { feedbackApi } from "../../lib/api-client";
import { useCanAdmin, useMe, useRoleStatus } from "../../lib/store";
import { Icon } from "../Icon";
import { parseFeedbackHistory } from "./feedback-history-response-contract";

type State =
  | { kind: "idle" }
  | { kind: "loading"; email: string }
  | { kind: "error"; email: string }
  | { kind: "ready"; email: string; history: FeedbackHistory };

export function FeedbackHistoryPanel({
  active = true,
}: {
  active?: boolean;
}): ReactElement {
  const canAdmin = useCanAdmin();
  const roleStatus = useRoleStatus();
  const me = useMe();
  const identity = me ? `${me.user}\u001f${me.tenant}` : null;
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    requestRef.current += 1;
    setEmail("");
    setState({ kind: "idle" });
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, [active, identity]);

  if (roleStatus === "loading") return <FeedbackAccessSkeleton />;
  if (!canAdmin) return <FeedbackAccessBoundary />;

  const lookup = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const target = email.trim();
    if (!target || !active) return;
    const request = ++requestRef.current;
    setState({ kind: "loading", email: target });
    try {
      const result = await feedbackApi.getHistory(target);
      if (!mountedRef.current || request !== requestRef.current || !active)
        return;
      if (result.error) {
        setState({ kind: "error", email: target });
        return;
      }
      const history = parseFeedbackHistory(result.data);
      setState(
        history
          ? { kind: "ready", email: target, history }
          : { kind: "error", email: target },
      );
    } catch {
      if (mountedRef.current && request === requestRef.current && active) {
        setState({ kind: "error", email: target });
      }
    }
  };

  return (
    <section className="dhw-feedback" aria-labelledby="dhw-feedback-title">
      <header>
        <span className="dhw-feedback-icon">
          <Icon name="users" size={17} />
        </span>
        <div>
          <h3 id="dhw-feedback-title">Recipient feedback evidence</h3>
          <p>
            Admin-only lookup of provider-reported bounces and complaints for
            one address in this workspace.
          </p>
        </div>
        <span className="dhw-feedback-access">
          <Icon name="lock" size={12} /> Admin scoped
        </span>
      </header>

      <form onSubmit={(event) => void lookup(event)}>
        <label htmlFor="dhw-feedback-email">Subscriber email</label>
        <div>
          <input
            id="dhw-feedback-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="subscriber@example.com"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={254}
            aria-describedby="dhw-feedback-privacy"
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={state.kind === "loading" || email.trim().length === 0}
          >
            {state.kind === "loading" ? "Looking up…" : "Look up evidence"}
          </button>
        </div>
        <small id="dhw-feedback-privacy">
          The address is sent in the tenant-scoped admin request body, never in
          the URL. The response is not cached or stored by this screen.
        </small>
      </form>

      <FeedbackResult state={state} />
    </section>
  );
}

function FeedbackResult({ state }: { state: State }): ReactElement {
  if (state.kind === "idle") {
    return (
      <div className="dhw-feedback-empty">
        <span>
          <Icon name="mail" size={18} />
        </span>
        <div>
          <strong>No address selected</strong>
          <p>Enter one exact address to inspect its recorded feedback trail.</p>
        </div>
      </div>
    );
  }
  if (state.kind === "loading") {
    return (
      <div className="dhw-feedback-loading" role="status">
        <div className="skel" />
        <div className="skel" />
        <span className="visually-hidden">Looking up recipient feedback</span>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="dhw-feedback-error" role="alert">
        <Icon name="alert-triangle" size={16} />
        <div>
          <strong>Feedback could not be verified</strong>
          <p>
            Retry the lookup. No conclusion was drawn for{" "}
            {maskEmail(state.email)}.
          </p>
        </div>
      </div>
    );
  }
  return <ReadyView email={state.email} history={state.history} />;
}

function ReadyView({
  email,
  history,
}: {
  email: string;
  history: FeedbackHistory;
}): ReactElement {
  const { bounces, complaints } = history;
  if (bounces.length === 0 && complaints.length === 0) {
    return (
      <div className="dhw-feedback-empty is-verified" role="status">
        <span>
          <Icon name="shield-check" size={18} />
        </span>
        <div>
          <strong>No recorded feedback returned</strong>
          <p>
            No bounce or complaint is recorded for {maskEmail(email)}. This is
            not proof of inbox placement, consent, or good standing.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="dhw-feedback-results" aria-live="polite">
      <div className="dhw-feedback-result-head">
        <div>
          <span>Address</span>
          <strong>{maskEmail(email)}</strong>
        </div>
        <div>
          <span>Total events</span>
          <strong>{bounces.length + complaints.length}</strong>
        </div>
      </div>
      <EventGroup title="Bounces" events={bounces} kind="bounce" />
      <EventGroup title="Complaints" events={complaints} kind="complaint" />
    </div>
  );
}

function EventGroup({
  title,
  events,
  kind,
}: {
  title: string;
  events: BounceEvent[] | ComplaintEvent[];
  kind: "bounce" | "complaint";
}): ReactElement {
  return (
    <section className="dhw-feedback-group">
      <header>
        <h4>{title}</h4>
        <span>{events.length}</span>
      </header>
      {events.length === 0 ? (
        <p>No {title.toLowerCase()} recorded.</p>
      ) : (
        <ul>
          {events.map((event, index) => (
            <EventRow
              key={event.id ?? `${kind}-${event.received_at}-${index}`}
              event={event}
              kind={kind}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function EventRow({
  event,
  kind,
}: {
  event: BounceEvent | ComplaintEvent;
  kind: "bounce" | "complaint";
}): ReactElement {
  const label =
    kind === "bounce"
      ? (event as BounceEvent).bounce_type
      : (event as ComplaintEvent).complaint_type;
  return (
    <li>
      <span className={`dhw-feedback-kind is-${label}`}>{label}</span>
      <div>
        <strong>{event.esp || "Provider not reported"}</strong>
        {event.esp_message_id ? (
          <small>Message {compactReference(event.esp_message_id)}</small>
        ) : null}
      </div>
      <time dateTime={event.received_at}>
        {new Date(event.received_at).toLocaleString()}
      </time>
    </li>
  );
}

function FeedbackAccessSkeleton(): ReactElement {
  return (
    <section
      className="dhw-feedback"
      aria-label="Recipient feedback access"
      aria-busy="true"
    >
      <div className="dhw-feedback-loading" role="status">
        <div className="skel" />
        <div className="skel" />
        <span className="visually-hidden">Resolving feedback access</span>
      </div>
    </section>
  );
}

function FeedbackAccessBoundary(): ReactElement {
  return (
    <section
      className="dhw-feedback dhw-feedback-locked"
      aria-label="Recipient feedback access"
    >
      <span>
        <Icon name="lock" size={18} />
      </span>
      <div>
        <h3>Admin access required</h3>
        <p>
          Recipient feedback contains subscriber-level personal data and is
          protected by the server’s admin scope.
        </p>
      </div>
    </section>
  );
}

function maskEmail(value: string): string {
  const separator = value.lastIndexOf("@");
  if (separator <= 0) return "••••";
  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  return `${local.slice(0, 1)}${"•".repeat(Math.min(5, Math.max(2, local.length - 1)))}@${domain}`;
}

function compactReference(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}
