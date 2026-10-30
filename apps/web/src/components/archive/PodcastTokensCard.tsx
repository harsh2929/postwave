// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * PodcastTokensCard — "Private podcast" admin card (desktop reference:
 * components/archive/PodcastTokensCard.tsx, gated in ArchivePageContent by
 * ARCHIVE_PRIVATE_PODCAST_AVAILABLE).
 *
 * Verbs: look up a subscriber's token by email, mint one, rotate (mint again),
 * revoke, and copy the public / private feed URLs.
 *
 * Honest-UI notes baked into the copy:
 *   - the raw token is shown once; GET only returns metadata, so the
 *     copy-feed-URL affordance is only available right after a mint.
 *   - minting again ROTATES the secret — the old feed URL stops working.
 *
 * Release-held: while ARCHIVE_PRIVATE_PODCAST_AVAILABLE is false the card
 * renders desktop's review-gate panel and nothing else — no controls, no
 * requests (the transport refuses too). Admin-only when open: the token
 * routes are admin scope on the server.
 */
import { useCallback, useId, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import {
  ARCHIVE_PRIVATE_PODCAST_AVAILABLE,
  ARCHIVE_PRIVATE_PODCAST_UNAVAILABLE_REASON,
} from "@/lib/archive-operational-availability";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { copyToClipboard } from "@/lib/clipboard";
import {
  getPodcastSubscriberToken,
  isLikelyEmail,
  mintPodcastSubscriberToken,
  podcastTokenMetadata,
  publicPodcastFeedUrl,
  resolveMintedPodcastFeedUrl,
  revokePodcastSubscriberToken,
  type PodcastSubscriberToken,
} from "@/lib/podcast-tokens-api";

/** The token routes are admin scope (podcast.MountAdminRoutes). */
export function canManagePrivatePodcast(me: MeResponse): boolean {
  const role = effectiveAuthRole(me);
  return me.viewer_mode !== true && (role === "owner" || role === "admin");
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

async function copyFeedUrl(text: string, ok: string): Promise<boolean> {
  const result = await copyToClipboard(text);
  if (result === "copied") {
    toast.success(ok);
    return true;
  }
  toast.error(
    result === "unavailable"
      ? "Clipboard unavailable here — select the feed URL and copy manually."
      : "The feed URL couldn't be copied. Select it and copy manually.",
  );
  return false;
}

type SecretReplacementAction =
  | { kind: "lookup"; email: string }
  | { kind: "rotate" }
  | { kind: "revoke" };

/** Desktop's ReviewGatePanel kind="private-feeds", verbatim. */
function PrivatePodcastReviewGate() {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="flex gap-4 rounded-xl border border-warning/30 bg-warning/5 p-4"
    >
      <ShieldAlert
        aria-hidden
        className="mt-1 size-5 shrink-0 text-warning-emphasis"
      />
      <div className="min-w-0 space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Release safety
          </span>
          <Badge variant="warning">Review gated</Badge>
        </div>
        <h3 id={titleId} className="text-base font-semibold">
          Private feed access is held back.
        </h3>
        <p role="note" className="text-muted-foreground">
          {ARCHIVE_PRIVATE_PODCAST_UNAVAILABLE_REASON}
        </p>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>Issued tokens must never be recoverable after reveal.</li>
          <li>Revocation and expiry need complete audit evidence.</li>
          <li>Feed URLs must be protected from logs and referrers.</li>
        </ul>
        <p className="text-xs text-muted-foreground">
          No reader content or credentials are changed from this workspace
          while the review gate is active.
        </p>
      </div>
    </section>
  );
}

export function PodcastTokensCard({ me }: { me: MeResponse }) {
  const privateFeedsAvailable =
    canManagePrivatePodcast(me) && ARCHIVE_PRIVATE_PODCAST_AVAILABLE;
  if (!privateFeedsAvailable) return <PrivatePodcastReviewGate />;
  return <PodcastTokensWorkspace tenantSlug={me.workspace_slug || null} />;
}

function PodcastTokensWorkspace({ tenantSlug }: { tenantSlug: string | null }) {
  const ids = useId();
  const inFlight = useRef(false);
  const [email, setEmail] = useState("");
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The email the current result belongs to (the input may have been edited).
  const [resolvedEmail, setResolvedEmail] = useState<string | null>(null);
  const [token, setToken] = useState<PodcastSubscriberToken | null>(null);
  const [notFound, setNotFound] = useState(false);
  // Raw secret from the most recent mint — kept separately because GET never
  // re-issues it.
  const [minted, setMinted] = useState<PodcastSubscriberToken | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [secretReplacement, setSecretReplacement] =
    useState<SecretReplacementAction | null>(null);

  const publicFeed = tenantSlug ? publicPodcastFeedUrl(tenantSlug) : null;
  const mintedFeedUrl = resolveMintedPodcastFeedUrl(minted, tenantSlug);

  const clearMintedSecret = useCallback((): void => {
    setMinted(null);
  }, []);

  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setBusy(true);
    try {
      return await work();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const lookup = async (requestedEmail = email.trim()): Promise<void> => {
    const target = requestedEmail.trim();
    if (!isLikelyEmail(target)) {
      setLookupErr("Enter a valid subscriber email.");
      return;
    }
    setLookupErr(null);
    await run(async () => {
      let result: PodcastSubscriberToken | null;
      try {
        result = await getPodcastSubscriberToken(target);
      } catch (error) {
        setLookupErr(
          apiErrorMessage(error, "The podcast token lookup failed."),
        );
        return;
      }
      setResolvedEmail(target);
      if (result === null) {
        setToken(null);
        setNotFound(true);
        return;
      }
      setNotFound(false);
      setToken(podcastTokenMetadata(result));
    });
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
    setConfirmRotate(false);
    await run(async () => {
      let result: PodcastSubscriberToken;
      try {
        result = await mintPodcastSubscriberToken(targetEmail);
      } catch (error) {
        toast.error(
          `Couldn't mint token: ${apiErrorMessage(error, "The mint request failed.")}`,
        );
        return;
      }
      setToken(podcastTokenMetadata(result));
      if (!resolveMintedPodcastFeedUrl(result, tenantSlug)) {
        toast.error(
          "The token may have been rotated, but the one-time feed URL was missing. Revoke it before retrying.",
        );
        return;
      }
      setMinted(result);
      setNotFound(false);
      toast.success(`Token minted for ${targetEmail}`);
    });
  };

  const revoke = async (): Promise<void> => {
    if (!resolvedEmail) return;
    const targetEmail = resolvedEmail;
    await run(async () => {
      try {
        await revokePodcastSubscriberToken(targetEmail);
      } catch (error) {
        toast.error(
          `Couldn't revoke token: ${apiErrorMessage(error, "The revoke request failed.")}`,
        );
        return;
      }
      setConfirmRevoke(false);
      toast.success(`Token revoked for ${targetEmail}`);
      clearMintedSecret();
      // Re-read so the shown state is the server's, not an inference.
      try {
        const refreshed = await getPodcastSubscriberToken(targetEmail);
        setToken(refreshed ? podcastTokenMetadata(refreshed) : null);
        if (refreshed === null) setNotFound(true);
      } catch (error) {
        setToken(null);
        setLookupErr(
          apiErrorMessage(
            error,
            "The token was revoked, but its current state could not be re-read.",
          ),
        );
      }
    });
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
    if (!action || busy) return;
    setSecretReplacement(null);
    clearMintedSecret();
    if (action.kind === "lookup") void lookup(action.email);
    else if (action.kind === "rotate") void mint(true);
    else void revoke();
  };

  const active = token !== null && !token.revoked_at;
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
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        The public feed serves free episodes only and is safe to submit to
        Apple / Spotify directories. Premium episodes are delivered through a
        per-subscriber feed URL whose token is checked on every fetch — revoke
        the token and the feed stops working on the next poll.
      </p>

      <div className="space-y-1.5">
        <Label htmlFor={`${ids}-public-feed`}>Public feed (free episodes)</Label>
        {publicFeed ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={`${ids}-public-feed`}
              readOnly
              className="font-mono text-xs"
              value={publicFeed}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              type="button"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              onClick={() =>
                void copyFeedUrl(publicFeed, "Public feed URL copied")
              }
            >
              Copy public feed URL
            </Button>
          </div>
        ) : (
          <p
            id={`${ids}-public-feed`}
            className="text-xs text-muted-foreground"
          >
            Set your workspace slug in Settings to get the public feed URL —
            feeds are served at /api/public/podcast/&#123;tenant-slug&#125;/feed.xml.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${ids}-email`}>Subscriber token</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={`${ids}-email`}
            type="email"
            autoComplete="off"
            placeholder="subscriber@example.com"
            value={email}
            aria-invalid={lookupErr ? true : undefined}
            aria-describedby={lookupErr ? `${ids}-email-error` : undefined}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                requestLookup();
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            loading={busy}
            onClick={requestLookup}
          >
            Look up
          </Button>
        </div>
        {lookupErr ? (
          <p
            id={`${ids}-email-error`}
            role="alert"
            className="text-xs text-destructive"
          >
            {lookupErr}
          </p>
        ) : null}
      </div>

      {resolvedEmail && notFound ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/20 p-3 text-sm"
        >
          <span>
            No podcast token on file for {resolvedEmail}. Mint one to give them
            a private feed URL.
          </span>
          <Button
            type="button"
            className="min-h-11 sm:min-h-9"
            disabled={busy}
            onClick={() => void mint()}
          >
            Mint token
          </Button>
        </div>
      ) : null}

      {resolvedEmail && token ? (
        <div className="space-y-3 rounded-md border bg-muted/20 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="break-all text-sm">
              {token.subscriber_email}
            </strong>
            {active ? (
              <Badge variant="success">Active</Badge>
            ) : (
              <Badge variant="destructive">Revoked</Badge>
            )}
          </div>
          <dl className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
            <div>
              <dt className="inline">Created </dt>
              <dd className="inline tabular-nums">
                {formatTimestamp(token.created_at)}
              </dd>
            </div>
            <div>
              <dt className="inline">Last used </dt>
              <dd className="inline tabular-nums">
                {formatTimestamp(token.last_used_at)}
              </dd>
            </div>
            {token.revoked_at ? (
              <div>
                <dt className="inline">Revoked </dt>
                <dd className="inline tabular-nums">
                  {formatTimestamp(token.revoked_at)}
                </dd>
              </div>
            ) : null}
          </dl>

          {mintedFeedUrl ? (
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-private-feed`}>Private feed URL</Label>
              <p className="text-xs text-muted-foreground">
                Shown once — the server never re-issues the raw token. Copy it
                now and send it to the subscriber.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id={`${ids}-private-feed`}
                  readOnly
                  className="font-mono text-xs"
                  value={mintedFeedUrl}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 sm:min-h-9"
                  onClick={() => {
                    void copyFeedUrl(
                      mintedFeedUrl,
                      "Private feed URL copied",
                    ).then((copied) => {
                      if (copied) clearMintedSecret();
                    });
                  }}
                >
                  Copy private feed URL
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 sm:min-h-9"
                  onClick={clearMintedSecret}
                >
                  I stored it securely
                </Button>
              </div>
            </div>
          ) : active ? (
            <p className="text-xs text-muted-foreground">
              The feed URL can&apos;t be re-shown — the raw token is only
              returned when it&apos;s minted. Rotate the token to issue a fresh
              URL (the old one stops working).
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              disabled={busy}
              aria-describedby={`${ids}-rotation-guidance`}
              onClick={requestRotate}
            >
              {active ? "Rotate token" : "Mint new token"}
            </Button>
            {active ? (
              <Button
                type="button"
                variant="destructive"
                className="min-h-11 sm:min-h-9"
                disabled={busy}
                onClick={requestRevoke}
              >
                Revoke
              </Button>
            ) : null}
            <p
              id={`${ids}-rotation-guidance`}
              className="basis-full text-xs text-muted-foreground"
            >
              {active ? "Rotating" : "Minting"} creates a new secret. Any
              previously issued private feed URL stops working.
            </p>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmRotate(false);
        }}
        title={active ? "Rotate token?" : "Mint token?"}
        description={
          active
            ? `The current feed URL for ${resolvedEmail ?? ""} stops working immediately; the new URL is shown once.`
            : `A private feed URL will be minted for ${resolvedEmail ?? ""} and shown once.`
        }
        confirmLabel={active ? "Rotate" : "Mint"}
        onConfirm={() => mint()}
      />
      <ConfirmDialog
        open={secretReplacement !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setSecretReplacement(null);
        }}
        title="Discard the shown private feed URL?"
        description={replacementDescription}
        confirmLabel={replacementLabel}
        cancelLabel="Keep URL open"
        confirmVariant="destructive"
        onConfirm={confirmSecretReplacement}
      />
      <ConfirmDialog
        open={confirmRevoke}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmRevoke(false);
        }}
        title="Revoke podcast token?"
        description={`${resolvedEmail ?? "This subscriber"}'s private feed stops working on the next fetch. You can mint a new token later.`}
        confirmLabel="Revoke"
        confirmVariant="destructive"
        onConfirm={() => revoke()}
      />
    </div>
  );
}
