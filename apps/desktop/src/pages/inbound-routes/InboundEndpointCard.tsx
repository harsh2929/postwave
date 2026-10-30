/** Provisioning and shown-once handoff for the inbound HMAC endpoint. */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import { ConfirmModal } from "../../components/ConfirmModal";
import { InlineHelp } from "../../components/InlineHelp";
import {
  formatInboundRouteAbsolute,
  formatInboundRouteRelative,
} from "../../components/inbound/inbound-route-time";
import { toast } from "../../components/Toast";
import { useShownOnceSecretLifecycle } from "../../hooks/useShownOnceSecretLifecycle";
import type { InboundEmailEndpoint } from "../../lib/api-client";
import { getApiUrl } from "../../lib/api-client";
import {
  clipboardSuccessDetail,
  writeClipboardText,
} from "../../lib/clipboard";

interface UnprovisionedEndpointProps {
  canAdmin: boolean;
  onProvision: () => Promise<void>;
  rotating: boolean;
  statusId: string;
}

function UnprovisionedEndpoint({
  canAdmin,
  onProvision,
  rotating,
  statusId,
}: UnprovisionedEndpointProps): ReactElement {
  return (
    <section className="inbound-endpoint-card is-unprovisioned">
      <h2>Inbound endpoint not provisioned</h2>
      <p>
        Provisioning creates an envelope-encrypted signing secret. Its plaintext
        is shown once and cannot be retrieved later.
      </p>
      {canAdmin ? (
        <button
          type="button"
          className="btn btn-primary pw-discoverable-unavailable"
          aria-disabled={rotating || undefined}
          aria-describedby={statusId}
          onClick={() => {
            if (!rotating) void onProvision();
          }}
        >
          {rotating ? "Creating endpoint…" : "Create endpoint"}
        </button>
      ) : (
        <p className="muted">
          Administrator access is required to provision it.
        </p>
      )}
      <p id={statusId} className="pw-action-status" role="status">
        {rotating
          ? "Creating the endpoint. Keep Moosewave open until the shown-once secret appears."
          : "No inbound traffic can be authenticated until this endpoint is provisioned."}
      </p>
    </section>
  );
}

function EndpointHeading({
  hasSecret,
  secretReady,
}: {
  hasSecret: boolean;
  secretReady: boolean;
}): ReactElement {
  return (
    <div className="inbound-endpoint-heading">
      <div>
        <h2 id="inbound-endpoint-heading">Inbound endpoint</h2>
        <p>
          Send a stable delivery ID and sign the timestamp plus exact raw
          request bytes with HMAC-SHA256 so retries cannot run actions twice.
        </p>
      </div>
      <span
        className={`badge ${hasSecret ? "warning" : secretReady ? "success" : "warning"}`}
      >
        {hasSecret
          ? "New secret — copy now"
          : secretReady
            ? "Configured"
            : "Not configured"}
      </span>
    </div>
  );
}

export function EndpointCard({
  endpoint,
  canAdmin,
  onRotated,
  onSecretHandled,
}: {
  endpoint: InboundEmailEndpoint | null;
  canAdmin: boolean;
  onRotated: () => Promise<boolean>;
  onSecretHandled: () => void;
}): ReactElement {
  const [showSecret, setShowSecret] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [copying, setCopying] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const rotationRef = useRef<Promise<void> | null>(null);
  const copyRef = useRef<Promise<boolean> | null>(null);
  const mountedRef = useRef(true);
  const secretHandledRef = useRef(false);
  const statusId = useId();
  const endpointOwner = endpoint?.id ?? "unprovisioned";
  const secret = endpoint?.secret ?? "";

  useShownOnceSecretLifecycle(
    `inbound-route-endpoint-${endpointOwner}`,
    "Inbound endpoint signing secret",
    Boolean(secret),
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    secretHandledRef.current = false;
    if (!secret) {
      setShowSecret(false);
      setConfirmAbandon(false);
    }
  }, [secret]);

  const apiBase = getApiUrl().replace(/\/$/, "");
  const ingestUrl = endpoint?.slug
    ? `${apiBase}/api/public/inbound-email/${endpoint.slug}`
    : `${apiBase}/api/public/inbound-email/<slug>`;
  const secretReady = Boolean(
    endpoint?.secretConfigured && !endpoint.rotationRequired,
  );

  const handleSecret = (): void => {
    if (secretHandledRef.current) return;
    secretHandledRef.current = true;
    setShowSecret(false);
    setConfirmAbandon(false);
    onSecretHandled();
  };

  const copy = async (
    value: string,
    label: string,
    secretValue = false,
  ): Promise<boolean> => {
    if (copyRef.current) return await copyRef.current;
    const request = (async (): Promise<boolean> => {
      setCopying(label);
      try {
        const result = await writeClipboardText(value, {
          contentClass: secretValue ? "secret" : "public",
          label,
          clearIfUnchangedAfterMs: secretValue ? 60_000 : undefined,
        });
        if (!mountedRef.current) return result.ok;
        if (!result.ok) {
          toast.error(`The ${label} couldn't be copied.`);
          return false;
        }
        toast.success({
          message: `Copied ${label}`,
          detail: clipboardSuccessDetail(result),
        });
        return true;
      } catch {
        if (mountedRef.current) {
          toast.error(`The ${label} couldn't be copied.`);
        }
        return false;
      } finally {
        if (mountedRef.current) setCopying(null);
      }
    })();
    copyRef.current = request;
    try {
      return await request;
    } finally {
      if (copyRef.current === request) copyRef.current = null;
    }
  };

  const runRotation = async (): Promise<void> => {
    if (rotationRef.current) {
      await rotationRef.current;
      return;
    }
    const request = (async (): Promise<void> => {
      setRotating(true);
      try {
        if ((await onRotated()) && mountedRef.current) {
          setConfirmRotate(false);
          setShowSecret(true);
        }
      } catch {
        if (mountedRef.current) {
          toast.error(
            "The endpoint request did not complete. No replacement secret is being assumed.",
          );
        }
      } finally {
        if (mountedRef.current) setRotating(false);
      }
    })();
    rotationRef.current = request;
    try {
      await request;
    } finally {
      if (rotationRef.current === request) rotationRef.current = null;
    }
  };

  if (!endpoint) {
    return (
      <UnprovisionedEndpoint
        canAdmin={canAdmin}
        onProvision={runRotation}
        rotating={rotating}
        statusId={statusId}
      />
    );
  }

  const secretDescription = secret
    ? "New plaintext reveal. Copy and store it before leaving this page."
    : endpoint.rotationRequired
      ? "Rotation required before inbound traffic can be authenticated."
      : "Configured and envelope-encrypted. The stored plaintext cannot be read back.";

  return (
    <section
      className="inbound-endpoint-card"
      aria-labelledby="inbound-endpoint-heading"
    >
      <EndpointHeading hasSecret={Boolean(secret)} secretReady={secretReady} />

      <div className="inbound-endpoint-field">
        <label htmlFor="inbound-ingest-url">
          Ingest URL
          <InlineHelp text="Paste this exact URL into the provider destination. Every request is HMAC validated against the signing secret." />
        </label>
        <div>
          <input
            id="inbound-ingest-url"
            type="text"
            readOnly
            className="mono"
            value={ingestUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            className="btn btn-sm pw-discoverable-unavailable"
            aria-disabled={copying !== null || undefined}
            aria-describedby={statusId}
            onClick={() => {
              if (!copying) void copy(ingestUrl, "ingest URL");
            }}
          >
            {copying === "ingest URL" ? "Copying…" : "Copy URL"}
          </button>
        </div>
      </div>

      <div className="inbound-endpoint-field">
        <label htmlFor="inbound-signing-secret">Signing secret</label>
        <p>{secretDescription}</p>
        <div>
          <input
            id="inbound-signing-secret"
            type={secret && !showSecret ? "password" : "text"}
            readOnly
            className="mono"
            value={
              secret ||
              (endpoint.rotationRequired
                ? "Rotation required"
                : "Stored securely — not retrievable")
            }
            onFocus={(event) => event.currentTarget.select()}
            autoComplete="off"
          />
          {secret ? (
            <>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setShowSecret((current) => !current)}
              >
                {showSecret ? "Hide secret" : "Show secret"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary pw-discoverable-unavailable"
                aria-disabled={copying !== null || undefined}
                aria-describedby={statusId}
                onClick={() => {
                  if (!copying) {
                    void copy(secret, "signing secret", true).then((copied) => {
                      if (copied && mountedRef.current) handleSecret();
                    });
                  }
                }}
              >
                {copying === "signing secret" ? "Copying…" : "Copy and clear"}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleSecret}
              >
                I&apos;ve stored it securely
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost btn-danger"
                onClick={() => setConfirmAbandon(true)}
              >
                Discard reveal
              </button>
            </>
          ) : null}
          {canAdmin ? (
            <button
              type="button"
              className="btn btn-sm btn-danger pw-discoverable-unavailable"
              aria-disabled={rotating || undefined}
              aria-describedby={statusId}
              onClick={() => {
                if (!rotating) setConfirmRotate(true);
              }}
            >
              {rotating ? "Rotating…" : "Rotate"}
            </button>
          ) : null}
        </div>
      </div>

      <p id={statusId} className="pw-action-status" role="status">
        {copying
          ? `Copying ${copying}. Other copy actions are temporarily unavailable.`
          : rotating
            ? "Rotating the signing secret. The current value remains authoritative until the server confirms replacement."
            : secret
              ? "This reveal is shown once. Secret clipboard content clears after 60 seconds when unchanged."
              : endpoint.secretRotatedAt
                ? `Encrypted at rest. Last rotated ${formatInboundRouteRelative(endpoint.secretRotatedAt)} at ${formatInboundRouteAbsolute(endpoint.secretRotatedAt)}.`
                : secretDescription}
      </p>

      <ConfirmModal
        open={confirmRotate}
        onClose={() => setConfirmRotate(false)}
        title="Rotate inbound signing secret?"
        description="The current secret stops working immediately after the server confirms rotation. The replacement is shown only once."
        confirmLabel={secret ? "Discard reveal and rotate" : "Rotate secret"}
        danger
        busy={rotating}
        onConfirm={runRotation}
      >
        <p>
          Update every provider immediately after rotation. Requests signed with
          the old value will receive <code>401 bad_signature</code>.
        </p>
        {secret ? (
          <p className="callout warning">
            The currently revealed plaintext has not been acknowledged.
            Continuing explicitly abandons it.
          </p>
        ) : null}
      </ConfirmModal>

      <ConfirmModal
        open={confirmAbandon}
        onClose={() => setConfirmAbandon(false)}
        title="Discard the one-time secret?"
        description="This plaintext cannot be retrieved after it is cleared."
        confirmLabel="Discard secret reveal"
        danger
        onConfirm={handleSecret}
      >
        <p>
          The current secret remains active. Rotate later if a replacement
          reveal is required.
        </p>
      </ConfirmModal>
    </section>
  );
}
