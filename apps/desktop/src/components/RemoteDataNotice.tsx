import { type ReactElement } from "react";

import {
  hasVerifiedRemoteData,
  type RemoteResource,
} from "../lib/remote-resource";

export function RemoteDataNotice<T>({
  resource,
  label,
  onRetry,
}: {
  resource: RemoteResource<T>;
  label: string;
  onRetry: () => void;
}): ReactElement | null {
  const hasData = hasVerifiedRemoteData(resource);

  if (resource.transport === "loading" && hasData) {
    return (
      <div
        className="notice"
        role="status"
        aria-live="polite"
        data-remote-state="refreshing"
        style={{ marginBottom: 12 }}
      >
        <span>Refreshing {label}… The last verified data remains visible.</span>
      </div>
    );
  }

  if (resource.transport !== "error" || !resource.failure) return null;

  const diagnostics = [resource.failure.code, resource.failure.requestId]
    .filter(Boolean)
    .join(" · ");
  const heading =
    resource.access === "denied"
      ? `Access denied for ${label}`
      : hasData
        ? `Showing last verified ${label}`
        : `Couldn’t verify ${label}`;

  return (
    <div
      className="notice"
      role="alert"
      data-remote-state={
        resource.access === "denied"
          ? "permission-denied"
          : hasData
            ? "stale-error"
            : "initial-error"
      }
      style={{ marginBottom: 12 }}
    >
      <span>
        <strong>{heading}.</strong> {resource.failure.message}
        {diagnostics ? (
          <span className="muted"> Reference: {diagnostics}.</span>
        ) : null}
      </span>
      <span className="spacer" />
      <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
