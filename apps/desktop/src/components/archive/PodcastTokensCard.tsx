/**
 * PodcastTokensCard — "Private podcast" admin card on the Archive page
 * (backlog #52).
 *
 * Backend surface (apps/api/internal/podcast/podcast.go):
 *   GET    /api/v1/podcast/subscribers/{email}/token  — metadata (404 when none)
 *   POST   /api/v1/podcast/subscribers/{email}/token  — mint or ROTATE;
 *          the raw token + feed_url come back ONLY on this response.
 *   DELETE /api/v1/podcast/subscribers/{email}/token  — revoke.
 *
 * Public feeds:
 *   /api/public/podcast/{tenant_slug}/feed.xml          — free episodes
 *   /api/public/podcast/{tenant_slug}/feed/{token}.xml  — entitlement-aware
 *
 * Honest-UI notes baked into the copy:
 *   - the raw token is shown once; GET only returns metadata, so the
 *     copy-feed-URL affordance is only available right after a mint.
 *   - minting again ROTATES the secret — the old feed URL stops working.
 */

import {
  type ReactElement,
  useCallback,
  useId,
  useMemo,
  useState,
} from "react";

import { useShownOnceSecretLifecycle } from "../../hooks/useShownOnceSecretLifecycle";
import {
  lifecycleOperationError,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import { ConfirmModal } from "../ConfirmModal";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";
import {
  type PodcastSubscriberToken,
  getApiUrl,
  podcastTokensApi,
} from "../../lib/api-client";
import { fmtDate } from "../../lib/format-date";
import {
  clipboardSuccessDetail,
  writeClipboardText,
} from "../../lib/clipboard";
import {
  isLikelyEmail,
  publicPodcastFeedUrl,
  readTenantSlug,
  tokenizedPodcastFeedUrl,
} from "./podcast-feed";

interface Props {
  /** True when the current role can mint / revoke. Admin-only — the
   *  #52 manifest marks the token routes admin-scope, so the caller
   *  must pass `useCanAdmin()`, not the editor-level write gate. */
  canMutate: boolean;
}

async function copy(
  text: string,
  ok: string,
  secret = false,
): Promise<boolean> {
  try {
    const result = await writeClipboardText(text, {
      contentClass: secret ? "secret" : "public",
      label: secret ? "Private podcast feed URL" : "Public podcast feed URL",
      clearIfUnchangedAfterMs: secret ? 60_000 : undefined,
    });
    if (result.ok) {
      toast.success({ message: ok, detail: clipboardSuccessDetail(result) });
      return true;
    }
    toast.error(result.message);
    return false;
  } catch {
    toast.error("The feed URL couldn't be copied.");
    return false;
  }
}

export function resolveMintedPodcastFeedUrl(
  minted: PodcastSubscriberToken | null,
  tenantSlug: string | null,
  apiUrl = getApiUrl(),
): string | null {
  if (minted?.feed_url) return minted.feed_url;
  if (!minted?.token || !tenantSlug) return null;
  return tokenizedPodcastFeedUrl(apiUrl, tenantSlug, minted.token);
}

/** Never let the normal metadata row become a second plaintext owner. */
function podcastTokenMetadata(
  value: PodcastSubscriberToken,
): PodcastSubscriberToken {
  const { token: _token, feed_url: _feedUrl, ...metadata } = value;
  return metadata;
}

type SecretReplacementAction =
  | { kind: "lookup"; email: string }
  | { kind: "rotate" }
  | { kind: "revoke" };

export function PodcastTokensCard({ canMutate }: Props): ReactElement {
  const [email, setEmail] = useState("");
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The email the current result belongs to (lookup input may have
  // been edited since).
  const [resolvedEmail, setResolvedEmail] = useState<string | null>(null);
  const [token, setToken] = useState<PodcastSubscriberToken | null>(null);
  const [notFound, setNotFound] = useState(false);
  // Raw secret from the most recent mint — kept separately because GET
  // never re-issues it.
  const [minted, setMinted] = useState<PodcastSubscriberToken | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [secretReplacement, setSecretReplacement] =
    useState<SecretReplacementAction | null>(null);
  const operation = useSingleFlightOperation({
    ownerId: "podcast-token",
    label: "Private podcast token operation",
    detail: "Wait for the private podcast token request to finish.",
  });

  const tenantSlug = useMemo(
    () =>
      readTenantSlug(
        typeof window !== "undefined" ? window.localStorage : undefined,
      ),
    [],
  );
  const publicFeed = tenantSlug
    ? publicPodcastFeedUrl(getApiUrl(), tenantSlug)
    : null;
  const mintedFeedUrl = resolveMintedPodcastFeedUrl(minted, tenantSlug);
  const mintedLifecycle = useShownOnceSecretLifecycle(
    "podcast-feed-token",
    "Private podcast feed URL",
    mintedFeedUrl !== null,
  );
  const activateMintedSecret = mintedLifecycle.activate;
  const resolveMintedSecret = mintedLifecycle.resolve;

  const clearMintedSecret = useCallback((): void => {
    resolveMintedSecret();
    setMinted(null);
  }, [resolveMintedSecret]);

  const lookup = async (requestedEmail = email.trim()): Promise<void> => {
    const e = requestedEmail.trim();
    if (!isLikelyEmail(e)) {
      setLookupErr("Enter a valid subscriber email.");
      return;
    }
    setLookupErr(null);
    const request = operation.run(() => podcastTokensApi.get(e));
    if (!request) return;
    setBusy(true);
    let res: Awaited<ReturnType<typeof podcastTokensApi.get>>;
    try {
      res = await request;
    } catch (error) {
      setLookupErr(
        lifecycleOperationError(error, "The podcast token lookup failed."),
      );
      return;
    } finally {
      setBusy(false);
    }
    setResolvedEmail(e);
    if (res.error) {
      if (res.error.status === 404) {
        setToken(null);
        setNotFound(true);
        return;
      }
      setToken(null);
      setNotFound(false);
      setLookupErr(res.error.message);
      return;
    }
    setNotFound(false);
    setToken(res.data ? podcastTokenMetadata(res.data) : null);
  };

  const requestLookup = (): void => {
    const requestedEmail = email.trim();
    if (!isLikelyEmail(requestedEmail)) {
      setLookupErr("Enter a valid subscriber email.");
      return;
    }
    if (mintedFeedUrl && resolvedEmail !== requestedEmail) {
      setSecretReplacement({ kind: "lookup", email: requestedEmail });
      return;
    }
    void lookup(requestedEmail);
  };

  const mint = async (replaceActiveSecret = false): Promise<void> => {
    if (!resolvedEmail) return;
    if (mintedFeedUrl && !replaceActiveSecret) {
      setSecretReplacement({ kind: "rotate" });
      return;
    }
    const targetEmail = resolvedEmail;
    const request = operation.run(async () => {
      const response = await podcastTokensApi.mint(targetEmail);
      if (
        !response.error &&
        response.data &&
        resolveMintedPodcastFeedUrl(response.data, tenantSlug)
      ) {
        activateMintedSecret();
        setMinted(response.data);
        setToken(podcastTokenMetadata(response.data));
      }
      return response;
    });
    if (!request) return;
    setConfirmRotate(false);
    setBusy(true);
    let res: Awaited<ReturnType<typeof podcastTokensApi.mint>>;
    try {
      res = await request;
    } catch (error) {
      toast.error(
        `Couldn't mint token: ${lifecycleOperationError(error, "The mint request failed.")}`,
      );
      return;
    } finally {
      setBusy(false);
    }
    if (res.error) {
      toast.error(`Couldn't mint token: ${res.error.message}`);
      return;
    }
    if (!res.data || !resolveMintedPodcastFeedUrl(res.data, tenantSlug)) {
      toast.error(
        "The token may have been rotated, but the one-time feed URL was missing. Revoke it before retrying.",
      );
      setToken(res.data ? podcastTokenMetadata(res.data) : null);
      return;
    }
    setNotFound(false);
    toast.success(`Token minted for ${targetEmail}`);
  };

  const revoke = async (): Promise<void> => {
    if (!resolvedEmail) return;
    const targetEmail = resolvedEmail;
    const request = operation.run(async () => {
      const revoked = await podcastTokensApi.revoke(targetEmail);
      if (revoked.error) return { revoked, refreshed: null };
      return {
        revoked,
        refreshed: await podcastTokensApi.get(targetEmail),
      };
    });
    if (!request) return;
    setBusy(true);
    let result: Awaited<typeof request>;
    try {
      result = await request;
    } catch (error) {
      toast.error(
        `Couldn't revoke token: ${lifecycleOperationError(error, "The revoke request failed.")}`,
      );
      return;
    } finally {
      setBusy(false);
    }
    if (result.revoked.error) {
      toast.error(`Couldn't revoke token: ${result.revoked.error.message}`);
      return;
    }
    setConfirmRevoke(false);
    toast.success(`Token revoked for ${targetEmail}`);
    clearMintedSecret();
    const refreshed = result.refreshed;
    setToken(refreshed?.data ? podcastTokenMetadata(refreshed.data) : null);
    if (refreshed?.error?.status === 404) setNotFound(true);
  };

  const requestRotate = (): void => {
    if (mintedFeedUrl) {
      setSecretReplacement({ kind: "rotate" });
      return;
    }
    setConfirmRotate(true);
  };

  const requestRevoke = (): void => {
    if (mintedFeedUrl) {
      setSecretReplacement({ kind: "revoke" });
      return;
    }
    setConfirmRevoke(true);
  };

  const confirmSecretReplacement = (): void => {
    const action = secretReplacement;
    if (!action || operation.active) return;
    setSecretReplacement(null);
    clearMintedSecret();
    if (action.kind === "lookup") void lookup(action.email);
    else if (action.kind === "rotate") void mint(true);
    else void revoke();
  };

  // Tokenized URL is only buildable right after a mint (raw secret is
  // shown once). Prefer the server's feed_url; fall back to building it.
  return (
    <section className="card">
      <SectionHeader
        title="Private podcast"
        description="Per-subscriber tokenized RSS feeds for premium audio episodes."
      />
      <div style={{ padding: "0 16px 16px" }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          The public feed serves free episodes only and is safe to submit to
          Apple / Spotify directories. Premium episodes are delivered through a
          per-subscriber feed URL whose token is checked on every fetch — revoke
          the token and the feed stops working on the next poll.
        </div>

        {/* Public feed URL */}
        <PodcastPublicFeedField publicFeed={publicFeed} />

        {/* Subscriber token lookup */}
        <div className="field">
          <label className="field-label" htmlFor="podcast-token-email">
            Subscriber token
          </label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              id="podcast-token-email"
              type="email"
              className="input"
              placeholder="subscriber@example.com"
              value={email}
              style={{ flex: 1 }}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  requestLookup();
                }
              }}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={requestLookup}
              disabled={busy || operation.active}
            >
              {busy ? "Working…" : "Look up"}
            </button>
          </div>
          {lookupErr ? <div className="field-error">{lookupErr}</div> : null}
        </div>

        {resolvedEmail && notFound ? (
          <div className="notice" style={{ marginBottom: 12 }}>
            <span>
              No podcast token on file for {resolvedEmail}.
              {canMutate ? " Mint one to give them a private feed URL." : ""}
            </span>
            {canMutate ? (
              <>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => void mint()}
                  disabled={busy || operation.active}
                >
                  Mint token
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        {resolvedEmail && token ? (
          <PodcastTokenResult
            token={token}
            mintedFeedUrl={mintedFeedUrl}
            canMutate={canMutate}
            busy={busy || operation.active}
            onRotate={requestRotate}
            onRevoke={requestRevoke}
            onAcknowledge={clearMintedSecret}
          />
        ) : null}
      </div>

      <PodcastTokenDialogs
        token={token}
        resolvedEmail={resolvedEmail}
        confirmRotate={confirmRotate}
        confirmRevoke={confirmRevoke}
        secretReplacement={secretReplacement}
        busy={busy || operation.active}
        onMint={() => void mint()}
        onRevoke={() => void revoke()}
        onConfirmReplacement={confirmSecretReplacement}
        onCloseRotate={() => setConfirmRotate(false)}
        onCloseRevoke={() => setConfirmRevoke(false)}
        onCloseReplacement={() => setSecretReplacement(null)}
      />
    </section>
  );
}

function PodcastPublicFeedField({
  publicFeed,
}: {
  publicFeed: string | null;
}): ReactElement {
  return (
    <div className="field">
      <label className="field-label" htmlFor="podcast-public-feed">
        Public feed (free episodes)
      </label>
      {publicFeed ? (
        <div style={{ display: "flex", gap: 6 }}>
          <input
            id="podcast-public-feed"
            readOnly
            className="input mono"
            value={publicFeed}
            style={{ flex: 1, fontSize: 11 }}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void copy(publicFeed, "Public feed URL copied")}
          >
            Copy
          </button>
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          Set your tenant slug in Settings to get the public feed URL — feeds
          are served at /api/public/podcast/&#123;tenant-slug&#125;/feed.xml.
        </div>
      )}
    </div>
  );
}

function PodcastTokenDialogs({
  token,
  resolvedEmail,
  confirmRotate,
  confirmRevoke,
  secretReplacement,
  busy,
  onMint,
  onRevoke,
  onConfirmReplacement,
  onCloseRotate,
  onCloseRevoke,
  onCloseReplacement,
}: {
  token: PodcastSubscriberToken | null;
  resolvedEmail: string | null;
  confirmRotate: boolean;
  confirmRevoke: boolean;
  secretReplacement: SecretReplacementAction | null;
  busy: boolean;
  onMint: () => void;
  onRevoke: () => void;
  onConfirmReplacement: () => void;
  onCloseRotate: () => void;
  onCloseRevoke: () => void;
  onCloseReplacement: () => void;
}): ReactElement {
  const replacementDescription =
    secretReplacement?.kind === "lookup"
      ? "Looking up a different subscriber will remove this one-time private feed URL from memory. It cannot be retrieved again."
      : secretReplacement?.kind === "rotate"
        ? "The currently shown private feed URL will be removed and its token rotated. The old URL stops working immediately."
        : "The currently shown private feed URL will be removed and its token revoked. The URL stops working immediately.";
  const replacementLabel =
    secretReplacement?.kind === "lookup"
      ? "Discard and look up"
      : secretReplacement?.kind === "rotate"
        ? "Discard and rotate"
        : "Discard and revoke";
  return (
    <>
      <ConfirmModal
        open={confirmRotate}
        title={token && !token.revoked_at ? "Rotate token?" : "Mint token?"}
        description={
          token && !token.revoked_at
            ? `The current feed URL for ${resolvedEmail ?? ""} stops working immediately; the new URL is shown once.`
            : `A private feed URL will be minted for ${resolvedEmail ?? ""} and shown once.`
        }
        confirmLabel={token && !token.revoked_at ? "Rotate" : "Mint"}
        busy={busy}
        onConfirm={onMint}
        onClose={() => (busy ? undefined : onCloseRotate())}
      />
      <ConfirmModal
        open={secretReplacement !== null}
        title="Discard the shown private feed URL?"
        description={replacementDescription}
        confirmLabel={replacementLabel}
        cancelLabel="Keep URL open"
        danger
        busy={busy}
        onConfirm={onConfirmReplacement}
        onClose={() => (busy ? undefined : onCloseReplacement())}
      />
      <ConfirmModal
        open={confirmRevoke}
        title="Revoke podcast token?"
        description={`${resolvedEmail ?? "This subscriber"}'s private feed stops working on the next fetch. You can mint a new token later.`}
        confirmLabel="Revoke"
        danger
        busy={busy}
        onConfirm={onRevoke}
        onClose={() => (busy ? undefined : onCloseRevoke())}
      />
    </>
  );
}

interface PodcastTokenResultProps {
  token: PodcastSubscriberToken;
  mintedFeedUrl: string | null;
  canMutate: boolean;
  busy: boolean;
  onRotate: () => void;
  onRevoke: () => void;
  onAcknowledge: () => void;
}

function PodcastTokenResult({
  token,
  mintedFeedUrl,
  canMutate,
  busy,
  onRotate,
  onRevoke,
  onAcknowledge,
}: PodcastTokenResultProps): ReactElement {
  const revoked = Boolean(token.revoked_at);
  const rotationGuidanceId = useId();
  return (
    <div
      style={{
        background: "var(--pw-bg-elev-2)",
        borderRadius: 6,
        padding: 12,
        marginBottom: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 13 }}>{token.subscriber_email}</strong>
        {revoked ? (
          <span className="badge danger">Revoked</span>
        ) : (
          <span className="badge success">Active</span>
        )}
      </div>
      <div className="muted tabular" style={{ fontSize: 11, marginTop: 6 }}>
        <div>Created {fmtDate(token.created_at)}</div>
        <div>
          Last used {token.last_used_at ? fmtDate(token.last_used_at) : "never"}
        </div>
        {token.revoked_at ? (
          <div>Revoked {fmtDate(token.revoked_at)}</div>
        ) : null}
      </div>

      {mintedFeedUrl ? (
        <div className="field" style={{ marginTop: 10 }}>
          <label className="field-label" htmlFor="podcast-private-feed">
            Private feed URL
          </label>
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            Shown once — the server never re-issues the raw token. Copy it now
            and send it to the subscriber.
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              id="podcast-private-feed"
              readOnly
              className="input mono"
              value={mintedFeedUrl}
              style={{ flex: 1, fontSize: 11 }}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void copy(mintedFeedUrl, "Private feed URL copied", true).then(
                  (copied) => {
                    if (copied) onAcknowledge();
                  },
                );
              }}
            >
              Copy
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onAcknowledge}
            >
              I stored it securely
            </button>
          </div>
        </div>
      ) : !revoked ? (
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          The feed URL can&apos;t be re-shown — the raw token is only returned
          when it&apos;s minted. Rotate the token to issue a fresh URL (the old
          one stops working).
        </div>
      ) : null}

      {canMutate ? (
        <div
          style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}
        >
          <button
            type="button"
            className="btn btn-sm"
            onClick={onRotate}
            disabled={busy}
            aria-describedby={rotationGuidanceId}
          >
            {revoked ? "Mint new token" : "Rotate token"}
          </button>
          {!revoked ? (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={onRevoke}
              disabled={busy}
            >
              Revoke
            </button>
          ) : null}
          <p
            id={rotationGuidanceId}
            className="muted"
            style={{ flexBasis: "100%", fontSize: 11, margin: 0 }}
          >
            {revoked ? "Minting" : "Rotating"} creates a new secret. Any
            previously issued private feed URL stops working.
          </p>
        </div>
      ) : null}
    </div>
  );
}
