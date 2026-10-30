import {
  type ReactElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  api,
  type List,
  type ListsResponse,
  type SubscriberListRef,
} from "../../lib/api-client";
import { toast } from "../Toast";

interface MembershipData {
  allLists: List[];
  error: string | null;
  loading: boolean;
  memberships: SubscriberListRef[];
  reload: () => void;
  setMemberships: React.Dispatch<React.SetStateAction<SubscriberListRef[]>>;
}

function unwrapListsPayload(payload: ListsResponse | undefined): List[] {
  if (!payload) return [];
  const data = payload.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  return payload.items ?? payload.results ?? [];
}

function membershipOrder(
  left: SubscriberListRef,
  right: SubscriberListRef,
): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function useSubscriberListMemberships(
  subscriberId: string,
  canMutate: boolean,
): MembershipData {
  const [memberships, setMemberships] = useState<SubscriberListRef[]>([]);
  const [allLists, setAllLists] = useState<List[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const result = await api.listsForSubscriber(subscriberId);
        if (cancelled) return;
        if (result.error) setError(result.error.message);
        else setMemberships([...result.data.items].sort(membershipOrder));
      } catch {
        if (!cancelled) {
          setError(
            "Couldn't load list memberships. Check your connection and retry.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadNonce, subscriberId]);

  useEffect(() => {
    let cancelled = false;
    if (!canMutate) {
      setAllLists([]);
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const result = await api.listLists();
        if (cancelled) return;
        if (result.error) setError(result.error.message);
        else setAllLists(unwrapListsPayload(result.data));
      } catch {
        if (!cancelled) {
          setError(
            "Couldn't load available lists. Check your connection and retry.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canMutate, reloadNonce, subscriberId]);

  return {
    allLists,
    error,
    loading,
    memberships,
    reload: () => setReloadNonce((current) => current + 1),
    setMemberships,
  };
}

function useMountedGeneration(): () => boolean {
  const generation = useRef(0);
  const renderGeneration = generation.current;
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  return () => generation.current === renderGeneration;
}

function MembershipChips({
  memberships,
  canMutate,
  busyIds,
  guidanceId,
  onRemove,
}: {
  memberships: SubscriberListRef[];
  canMutate: boolean;
  busyIds: ReadonlySet<string>;
  guidanceId: string;
  onRemove: (membership: SubscriberListRef) => Promise<void>;
}): ReactElement {
  if (memberships.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        Not a member of any list.
      </div>
    );
  }
  return (
    <div
      className="chip-list"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 6,
      }}
    >
      {memberships.map((membership) => (
        <span key={membership.id} className="chip-removable">
          <span>{membership.name}</span>
          {canMutate ? (
            <button
              type="button"
              aria-label={`Remove from ${membership.name}`}
              disabled={busyIds.has(membership.id)}
              aria-describedby={guidanceId}
              onClick={() => void onRemove(membership)}
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}

export function SubscriberListMembershipsSection({
  subscriberId,
  canMutate,
}: {
  subscriberId: string;
  canMutate: boolean;
}): ReactElement {
  return (
    <SubscriberListMembershipsState
      key={subscriberId}
      subscriberId={subscriberId}
      canMutate={canMutate}
    />
  );
}

function SubscriberListMembershipsState({
  subscriberId,
  canMutate,
}: {
  subscriberId: string;
  canMutate: boolean;
}): ReactElement {
  const data = useSubscriberListMemberships(subscriberId, canMutate);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [addValue, setAddValue] = useState("");
  const [mutationError, setMutationError] = useState<string | null>(null);
  const inFlightRef = useRef(new Set<string>());
  const guidanceId = useId();
  const isCurrent = useMountedGeneration();
  const memberIds = useMemo(
    () => new Set(data.memberships.map((membership) => membership.id)),
    [data.memberships],
  );
  const memberNames = useMemo(
    () =>
      new Set(
        data.memberships.map((membership) =>
          membership.name.trim().toLowerCase(),
        ),
      ),
    [data.memberships],
  );
  const addable = data.allLists.filter(
    (list) =>
      list.id != null &&
      !memberIds.has(String(list.id)) &&
      !memberNames.has(list.name.trim().toLowerCase()),
  );

  const begin = (listId: string): boolean => {
    if (inFlightRef.current.has(listId)) return false;
    inFlightRef.current.add(listId);
    setBusyIds((current) => new Set(current).add(listId));
    setMutationError(null);
    return true;
  };
  const finish = (listId: string): void => {
    inFlightRef.current.delete(listId);
    setBusyIds((current) => {
      const next = new Set(current);
      next.delete(listId);
      return next;
    });
  };
  const reportMutationFailure = (): void => {
    setMutationError(
      "Couldn't save this membership. No other list changes were undone. Retry the same list action.",
    );
  };

  const add = async (): Promise<void> => {
    const listId = addValue.trim();
    const list = addable.find((candidate) => String(candidate.id) === listId);
    if (!listId || !list || !begin(listId)) return;
    const optimistic = { id: listId, name: list.name };
    data.setMemberships((current) =>
      current.some((membership) => membership.id === listId)
        ? current
        : [...current, optimistic].sort(membershipOrder),
    );
    try {
      const result = await api.addSubscriberToList(listId, subscriberId);
      if (!isCurrent()) return;
      if (result.error) {
        data.setMemberships((current) =>
          current.filter((membership) => membership.id !== listId),
        );
        reportMutationFailure();
        toast.error(`Couldn't add to list: ${result.error.message}`);
        return;
      }
      setAddValue("");
      toast.success("Added to list");
    } catch {
      if (!isCurrent()) return;
      data.setMemberships((current) =>
        current.filter((membership) => membership.id !== listId),
      );
      reportMutationFailure();
      toast.error("Couldn't add to the list. Check your connection and retry.");
    } finally {
      if (isCurrent()) finish(listId);
    }
  };

  const remove = async (membership: SubscriberListRef): Promise<void> => {
    const listId = membership.id;
    if (!begin(listId)) return;
    data.setMemberships((current) =>
      current.filter((candidate) => candidate.id !== listId),
    );
    try {
      const result = await api.removeSubscriberFromList(listId, subscriberId);
      if (!isCurrent()) return;
      if (result.error) {
        data.setMemberships((current) =>
          current.some((candidate) => candidate.id === listId)
            ? current
            : [...current, membership].sort(membershipOrder),
        );
        reportMutationFailure();
        toast.error(`Couldn't remove from list: ${result.error.message}`);
        return;
      }
      toast.success("Removed from list");
    } catch {
      if (!isCurrent()) return;
      data.setMemberships((current) =>
        current.some((candidate) => candidate.id === listId)
          ? current
          : [...current, membership].sort(membershipOrder),
      );
      reportMutationFailure();
      toast.error(
        "Couldn't remove from the list. Check your connection and retry.",
      );
    } finally {
      if (isCurrent()) finish(listId);
    }
  };

  const selectedBusy = addValue !== "" && busyIds.has(addValue);
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="label">Lists</div>
      {data.error ? (
        <div className="notice" role="alert" style={{ fontSize: 12 }}>
          <span>{data.error}</span>
          <button type="button" className="btn btn-xs" onClick={data.reload}>
            Retry memberships
          </button>
        </div>
      ) : null}
      {mutationError ? (
        <div className="notice" role="alert" style={{ fontSize: 12 }}>
          {mutationError}
        </div>
      ) : null}
      {data.loading && data.memberships.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }} role="status">
          Loading…
        </div>
      ) : (
        <MembershipChips
          memberships={data.memberships}
          canMutate={canMutate}
          busyIds={busyIds}
          guidanceId={guidanceId}
          onRemove={remove}
        />
      )}
      <p
        id={guidanceId}
        className="muted"
        role="status"
        style={{ fontSize: 11, margin: "6px 0 0" }}
      >
        {!canMutate
          ? "Viewer role can inspect list memberships but can't add or remove them."
          : busyIds.size > 0
            ? `Saving ${busyIds.size} list membership ${busyIds.size === 1 ? "change" : "changes"}.`
            : addValue
              ? "Add links this subscriber to the selected list."
              : "Choose an available list before adding a membership."}
      </p>
      {canMutate && addable.length > 0 ? (
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}
        >
          <select
            className="input"
            style={{ maxWidth: 220 }}
            value={addValue}
            onChange={(event) => setAddValue(event.target.value)}
          >
            <option value="">Add to list…</option>
            {addable.map((list) => (
              <option key={String(list.id)} value={String(list.id)}>
                {list.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            disabled={selectedBusy}
            aria-disabled={!addValue || selectedBusy || undefined}
            aria-describedby={guidanceId}
            onClick={() => void add()}
          >
            Add
          </button>
        </div>
      ) : null}
    </div>
  );
}
