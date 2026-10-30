import {
  createContext,
  type FormEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { api } from "../../lib/api-client";
import { useMe } from "../../lib/store";
import { Icon } from "../Icon";
import { parseCampaignOptions, type CampaignOption } from "./campaign-options";

interface Props {
  id: string;
  ariaLabel: string;
  value: string;
  onChange: (campaignId: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

interface CampaignOptionsContextValue {
  options: CampaignOption[] | null;
  loading: boolean;
  failed: boolean;
  refresh: () => void;
}

const CampaignOptionsContext =
  createContext<CampaignOptionsContextValue | null>(null);

export function CampaignOptionsProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const tenant = useMe()?.tenant ?? "unresolved";
  const [options, setOptions] = useState<CampaignOption[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const requestIdRef = useRef(0);
  const tenantRef = useRef(tenant);

  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    if (tenantRef.current !== tenant) {
      tenantRef.current = tenant;
      setOptions(null);
    }
    setLoading(true);
    setFailed(false);
    void (async () => {
      try {
        const result = await api.listCampaigns(
          { page: 1, perPage: 100 },
          { signal: controller.signal },
        );
        if (controller.signal.aborted || requestId !== requestIdRef.current)
          return;
        const parsed = result.error ? null : parseCampaignOptions(result.data);
        if (parsed) setOptions(parsed);
        else setFailed(true);
      } catch {
        if (!controller.signal.aborted && requestId === requestIdRef.current) {
          setFailed(true);
        }
      } finally {
        if (!controller.signal.aborted && requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    })();
    return () => {
      controller.abort();
      requestIdRef.current += 1;
    };
  }, [refreshToken, tenant]);

  const context = useMemo<CampaignOptionsContextValue>(
    () => ({ options, loading, failed, refresh }),
    [failed, loading, options, refresh],
  );
  return (
    <CampaignOptionsContext.Provider value={context}>
      {children}
    </CampaignOptionsContext.Provider>
  );
}

export function CampaignSelect(props: Props): ReactElement {
  const shared = useContext(CampaignOptionsContext);
  if (!shared) {
    return (
      <CampaignOptionsProvider>
        <CampaignSelectInner {...props} />
      </CampaignOptionsProvider>
    );
  }
  return <CampaignSelectInner {...props} />;
}

function CampaignSelectInner({
  id,
  ariaLabel,
  value,
  onChange,
  placeholder,
  disabled,
}: Props): ReactElement {
  const context = useContext(CampaignOptionsContext);
  const [directOpen, setDirectOpen] = useState(false);
  const [directId, setDirectId] = useState("");
  const [directError, setDirectError] = useState(false);
  if (!context) throw new Error("CampaignSelect requires campaign context");
  const { options, loading, failed, refresh } = context;
  const hasDirectSelection =
    value.length > 0 && !(options ?? []).some((option) => option.id === value);

  const submitDirect = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const normalized = directId.trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) {
      setDirectError(true);
      return;
    }
    setDirectError(false);
    setDirectOpen(false);
    onChange(normalized);
  };

  return (
    <div className="dhw-campaign-picker">
      <div className="dhw-campaign-picker-row">
        <select
          id={id}
          aria-label={ariaLabel}
          className="input"
          value={value}
          disabled={
            disabled ||
            (loading && options === null) ||
            (failed && options === null)
          }
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">
            {failed && options === null
              ? "Campaigns unavailable"
              : loading && options === null
                ? "Loading campaigns…"
                : options?.length === 0
                  ? "No campaigns found"
                  : (placeholder ?? "Select a campaign…")}
          </option>
          {hasDirectSelection ? (
            <option value={value}>Campaign {value} · direct ID</option>
          ) : null}
          {(options ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {failed ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={refresh}
            disabled={loading || disabled}
          >
            Retry
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-sm dhw-campaign-direct-trigger"
          aria-expanded={directOpen}
          onClick={() => {
            setDirectOpen((open) => !open);
            setDirectError(false);
          }}
          disabled={disabled}
        >
          Use campaign ID
          <Icon name={directOpen ? "chevron-up" : "chevron-down"} size={14} />
        </button>
      </div>

      {failed ? (
        <p className="dhw-campaign-picker-error" role="alert">
          Campaign choices could not be verified. Retry, or use a known campaign
          ID.
        </p>
      ) : options?.length === 100 ? (
        <p className="dhw-campaign-picker-hint">
          Showing the 100 newest campaigns. Use a campaign ID for older records.
        </p>
      ) : null}

      {directOpen ? (
        <form
          className="dhw-campaign-direct"
          onSubmit={submitDirect}
          noValidate
        >
          <label htmlFor={`${id}-direct`}>Campaign ID</label>
          <div>
            <input
              id={`${id}-direct`}
              className="input"
              value={directId}
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={directError || undefined}
              onChange={(event) => {
                setDirectId(event.target.value);
                setDirectError(false);
              }}
              placeholder="Paste an exact campaign ID"
              disabled={disabled}
            />
            <button type="submit" className="btn btn-sm" disabled={disabled}>
              Use ID
            </button>
          </div>
          {directError ? (
            <p className="field-error" role="alert">
              Enter 1–128 letters, numbers, underscores, or hyphens.
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
