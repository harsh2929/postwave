/**
 * OutboundWebhooksSection — create, inspect and delete outbound webhooks from
 * Settings.
 *
 * Monitoring moved out. "Which endpoints are healthy, what failed in the last
 * hour, replay it, pause it, bring back the one the server auto-disabled" now
 * lives on the dedicated Webhooks screen, which is the on-call surface. What
 * stays here is the part that belongs next to the rest of workspace setup:
 * creating an endpoint, seeing at a glance whether each one is still
 * delivering, and deleting one for good.
 *
 * WHAT WAS WRONG WITH THIS FILE, AND WHAT REPLACED IT.
 *
 *  1. IT BYPASSED TANSTACK QUERY. A hand-rolled `useState` + `useEffect`
 *     refresh meant no cache, no refetch on focus, no online gating, no part in
 *     Settings' pull-to-refresh, no generation guard (two overlapping refreshes
 *     could resolve out of order and show the older list), and a `setState`
 *     that could fire after unmount. `useOutboundWebhooks()` fixes all six.
 *  2. ALERT WAS USED FOR BOTH QUESTIONS AND ANSWERS. When a successful save
 *     and an irreversible delete look identical, the delete prompt stops being
 *     read. Confirmations go through `useConfirm` (carrying the desktop's own
 *     consequence copy) and results through `toast`.
 *  3. `onTest` ASSERTED NON-NULL ON THE BODY: `res.data!` crashed Settings on a
 *     204 or an empty body — the one unchecked result contract in the file.
 *  4. FRESHNESS WAS ON THE WIRE AND NEVER RENDERED. `last_succeeded_at` /
 *     `last_failed_at` were parsed and dropped; see `lib/outboundWebhookFreshness`.
 *  5. THE PAUSED PILL WAS AMBIGUOUS — an endpoint the SERVER auto-disabled
 *     looked exactly like one a human paused. The inactive state now says it is
 *     not delivering and points at Webhooks, which owns re-enable.
 *  6. CREATE ACCEPTED ANY STRING AS A URL AND FAILED OPAQUELY OFFLINE; both now
 *     live in `OutboundWebhookForm`, with a server-sourced event catalog (the
 *     hardcoded list had drifted two entries behind `AllowedEvents`).
 *
 * Reveal-once secret: still never persisted, but no longer destroyed by a
 * navigation — see `WebhookSecretCard` and `lib/revealOnceSecret`.
 *
 *  7. IT COULD ONLY CREATE AND DESTROY. Mobile offered exactly two mutations
 *     — create and the irreversible delete — while the API has offered
 *     `PATCH /{id}` and `POST /{id}/rotate-secret` all along. So the only
 *     answer the phone had to "the receiver moved" or "the signing secret
 *     leaked" was to delete the endpoint and rebuild it, which shreds the
 *     delivery history the Webhooks screen is built on. Edit and Rotate are
 *     now here, next to Create, because both are signing/destination
 *     CONFIGURATION rather than monitoring. Pause/resume stays on the
 *     Webhooks screen, which owns the reversible stop.
 *
 * NativeWind v4 gotcha (for the controls this section renders): static
 * Pressable style objects only.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";

import { getClient } from "@/api/client";
import { updateOutboundWebhook } from "@/api/outboundWebhooks";
import {
  createOutboundWebhook,
  deleteOutboundWebhook,
  testOutboundWebhook,
  type OutboundWebhook,
} from "@/api/settings";
import { useConfirm } from "@/components/ConfirmSheet";
import { AddWebhookButton } from "@/components/settings/AddWebhookButton";
import { OutboundWebhookForm } from "@/components/settings/OutboundWebhookForm";
import { OutboundWebhookRow } from "@/components/settings/OutboundWebhookRow";
import { WebhookSecretCard } from "@/components/settings/WebhookSecretCard";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useOutboundKeyRotation } from "@/hooks/useOutboundKeyRotation";
import { useOutboundWebhooks } from "@/hooks/useOutboundWebhooks";
import { trackCommerceAction } from "@/lib/commerceTelemetry";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { resolveEventCatalog } from "@/lib/outboundWebhookForm";
import { peekSecret, stashSecret } from "@/lib/revealOnceSecret";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Desktop's own delete copy, verbatim, so both clients agree on the stakes. */
const DELETE_CONSEQUENCE =
  "This permanently tombstones the endpoint: pending deliveries are cancelled and the destination, auth and signing secrets are shredded. Pause it on the Webhooks screen instead if you need a reversible stop.";

/**
 * COMMERCE#58. Module-level so the two outcomes read as one decision and the
 * component body stays inside its source budget. `webhook_test` reports the
 * DELIVERY result, not the request result — a 200 from the API carrying a 500
 * from the customer's endpoint is a failed test, and that distinction is the
 * only reason the button exists.
 */
const webhookManaged = () => trackCommerceAction("webhook_manage", "success");
const webhookManageFailed = () =>
  trackCommerceAction("webhook_manage", "failure");

function statusOf(err: unknown): number {
  return typeof err === "object" && err !== null && "status" in err
    ? Number((err as { status: unknown }).status) || 0
    : 0;
}

export function OutboundWebhooksSection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  const confirm = useConfirm();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<OutboundWebhook | null>(null);
  const [secretRevision, setSecretRevision] = useState(0);
  // Seeded FROM the stash, not from this render: the card's whole point is
  // that it survives leaving the app to open a password manager. A plain
  // `null` here would have re-broken exactly the bug the stash was built for.
  const [secretForId, setSecretForId] = useState<string | null>(
    () => peekSecret()?.id ?? null,
  );
  const [testingId, setTestingId] = useState<string | null>(null);

  const webhooks = useOutboundWebhooks();

  const revealRotated = useCallback((webhookId: string) => {
    setSecretForId(webhookId);
    setSecretRevision((n) => n + 1);
  }, []);

  // The event catalog the server actually accepts. Cached for the session —
  // `AllowedEvents` changes on deploys, not on refreshes.
  const catalogQuery = useQuery({
    queryKey: ["outbound-webhook-events", gate.tenantId],
    enabled:
      gate.enabled && Boolean(gate.tenantId) && (adding || editing !== null),
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<unknown> => {
      const { client } = getClient();
      return client.request<unknown>(
        "GET",
        "/api/v1/outbound-webhooks/playground/events",
      );
    },
  });
  const catalog = resolveEventCatalog(catalogQuery.data);

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["outbound-webhooks", gate.tenantId] });
  }, [gate.tenantId, qc]);

  const rotation = useOutboundKeyRotation({
    onSecretRevealed: revealRotated,
    onRotated: invalidate,
  });

  const create = useMutation({
    mutationFn: async (draft: {
      url: string;
      description: string;
      events: string[];
    }) => {
      const res = await createOutboundWebhook(draft);
      if (res.error || !res.data) {
        throw new Error(res.error?.message ?? "Couldn't create the webhook.");
      }
      return res.data;
    },
    onSuccess: (data) => {
      setAdding(false);
      // Stash BEFORE anything else can unmount this tree — the secret is
      // returned exactly once and the component no longer owns it.
      stashSecret(data.webhook.id, data.signing_secret);
      setSecretForId(data.webhook.id);
      setSecretRevision((n) => n + 1);
      invalidate();
      toast({ kind: "success", message: "Webhook created. Save the secret." });
    },
    onError: (err: Error) => {
      toast({ kind: "error", message: err.message });
    },
  });

  const update = useMutation({
    mutationFn: async (input: {
      id: string;
      url: string;
      description: string;
      events: string[];
    }) => {
      const { id, ...patch } = input;
      await updateOutboundWebhook(id, patch);
    },
    onSuccess: () => {
      setEditing(null);
      invalidate();
      toast({ kind: "success", message: "Webhook updated." });
    },
    onError: (err: Error) => {
      // The server's 400/409 messages name the repair (redacted destination,
      // unusable URL, unreachable receiver auth) — never flatten them.
      toast({ kind: "error", message: err.message });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await deleteOutboundWebhook(id);
      if (res.error) throw new Error(res.error.message);
    },
    onSuccess: () => {
      invalidate();
      toast({ kind: "success", message: "Webhook deleted." });
    },
    onError: (err: Error) => {
      toast({ kind: "error", message: err.message });
    },
  });

  const onDelete = useCallback(
    async (w: OutboundWebhook) => {
      const ok = await confirm({
        title: "Delete this webhook?",
        message: DELETE_CONSEQUENCE,
        confirmLabel: "Delete",
        destructive: true,
        confirmPhrase: "DELETE",
      });
      if (!ok) return;
      await remove.mutateAsync(w.id).then(webhookManaged, webhookManageFailed);
    },
    [confirm, remove],
  );

  const onTest = useCallback(
    async (id: string) => {
      setTestingId(id);
      const res = await testOutboundWebhook(id);
      setTestingId(null);
      if (res.error) {
        toast({ kind: "error", message: res.error.message });
        return;
      }
      const r = res.data;
      if (!r) {
        // A 204 or an empty body used to crash the screen here.
        toast({
          kind: "info",
          message: "The server accepted the test but returned no result.",
        });
        return;
      }
      const failed = r.status_code >= 400 || Boolean(r.error);
      trackCommerceAction("webhook_test", failed ? "failure" : "success");
      toast({
        kind: failed ? "error" : "success",
        message: `Test fired · status ${r.status_code} · ${
          r.signed ? "signed" : "unsigned"
        }${r.error ? ` · ${r.error}` : ""}`,
      });
    },
    [toast],
  );

  const status = statusOf(webhooks.error);
  if (status === 404 || status === 501) {
    return (
      <Notice
        title="Outbound webhooks unavailable"
        body="This Moosewave deployment hasn't enabled the outbound-webhooks API yet. Configure webhooks from the desktop app once the gateway is upgraded."
      />
    );
  }

  // Array.isArray, not `?? []`. The nullish guard admits any TRUTHY non-array
  // -- a paged `{items: []}` envelope, or the HTML an SPA fallback serves for
  // an absent upstream -- straight into the iteration below.
  const items = Array.isArray(webhooks.data) ? webhooks.data : [];

  return (
    <View style={{ gap: 10 }}>
      {webhooks.isError ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.danger,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {errorPresentation(webhooks.error, { online }).message}
        </Text>
      ) : null}

      {webhooks.isLoading ? <SkeletonList rows={2} /> : null}

      {!webhooks.isLoading && !webhooks.isError && items.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          No webhooks configured. Tap “Add webhook” to send events to an
          external service.
        </Text>
      ) : null}

      {items.map((w) =>
        editing?.id === w.id ? (
          <OutboundWebhookForm
            key={w.id}
            catalog={catalog}
            creating={update.isPending}
            online={online}
            initial={{
              url: w.url,
              description: w.description ?? "",
              events: w.events,
            }}
            submitLabel="Save"
            pendingLabel="Saving…"
            offlineReason="Needs a connection — changing a live destination can't be queued for later."
            onCancel={() => setEditing(null)}
            onCreate={(draft) => update.mutate({ id: w.id, ...draft })}
          />
        ) : (
          <OutboundWebhookRow
            key={w.id}
            webhook={w}
            testing={testingId === w.id}
            deleting={remove.isPending}
            rotating={rotation.rotatingId === w.id}
            onTest={() => void onTest(w.id)}
            onDelete={() => void onDelete(w)}
            onEdit={() => {
              setAdding(false);
              setEditing(w);
            }}
            onRotate={() => void rotation.rotate(w)}
          />
        ),
      )}

      {/* The stash holds ONE secret process-wide, so the card is scoped twice
          over: `expectedId` refuses to render another entity's value, and the
          membership test keeps a secret minted on a different surface (an
          inbound rotation) from surfacing in this list. */}
      {secretForId && items.some((w) => w.id === secretForId) ? (
        <WebhookSecretCard
          revision={secretRevision}
          expectedId={secretForId}
          onDismiss={() => {
            setSecretForId(null);
            setSecretRevision((n) => n + 1);
          }}
        />
      ) : null}

      {adding ? (
        <OutboundWebhookForm
          catalog={catalog}
          creating={create.isPending}
          online={online}
          onCancel={() => setAdding(false)}
          onCreate={(draft) => create.mutate(draft)}
        />
      ) : (
        <AddWebhookButton
          onPress={() => {
            // Only ever ONE form open: both share the `outbound-webhook-form`
            // dirty-guard key, and two live registrations under one key make
            // the unsaved-changes prompt fire for the wrong form.
            setEditing(null);
            setAdding(true);
          }}
        />
      )}
    </View>
  );
}


function Notice({ title, body }: { title: string; body: string }) {
  const { t } = useTheme();
  const card = {
    backgroundColor: t.surface,
    borderColor: t.borderSubtle,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
  } as const;
  return (
    <View style={card}>
      <Text
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          fontFamily: FONT.semibold,
        }}
        {...typeCap("callout")}
      >
        {title}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginTop: 4,
          fontFamily: FONT.regular,
        }}
      >
        {body}
      </Text>
    </View>
  );
}
