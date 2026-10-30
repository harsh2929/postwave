/** Mobile list/revoke surface; reveal-once credential issuance stays on a desk. */
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import {
  useIngestSecrets,
  useRevokeIngestSecret,
} from "@/hooks/useIngestSecrets";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  CONVERSION_INGEST_V2_CONTRACT,
  ingestSecretIsActive,
  ingestSecretRevokeCopy,
  type IngestSecret,
} from "@/lib/ingestSecrets";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function projectionPresentation(secret: IngestSecret): {
  label: string;
  tone: "success" | "warning" | "danger";
  guidance: string;
} {
  if (secret.identityProjectionStatus === "ready") {
    return {
      label: "email HMAC ready",
      tone: "success",
      guidance:
        "This exact key is ready to derive and ingest email_hmac_sha256 identities.",
    };
  }
  if (secret.identityProjectionStatus === "pending") {
    return {
      label: "email HMAC pending",
      tone: "warning",
      guidance:
        "Email-HMAC events signed by this key return 503 until projection is ready. Keep the old ready key live and refresh on web or desktop. Click-ID and external-ID-only events are unaffected.",
    };
  }
  if (secret.identityProjectionErrorCode === "secret_unavailable") {
    return {
      label: "email HMAC failed",
      tone: "danger",
      guidance:
        "This key cannot become email-HMAC ready. Keep the old ready key live, revoke this failed key, and issue a replacement on web or desktop.",
    };
  }
  return {
    label: "email HMAC failed",
    tone: "danger",
    guidance:
      "Projection failed. Keep the old ready key live, refresh on web or desktop, and contact support if it remains failed. Do not move email-HMAC traffic to this key.",
  };
}

function readRegisterPages(rawData: unknown): {
  items: IngestSecret[];
  invalid: boolean;
  duplicateIds: boolean;
  duplicateCursors: boolean;
} {
  const rawPages =
    rawData &&
    typeof rawData === "object" &&
    Array.isArray((rawData as { pages?: unknown }).pages)
      ? (rawData as { pages: unknown[] }).pages
      : null;
  const validPages =
    rawPages !== null &&
    rawPages.every(
      (page) =>
        page !== null &&
        typeof page === "object" &&
        !Array.isArray(page) &&
        Array.isArray((page as { items?: unknown }).items),
    );
  const pageItems = validPages
    ? rawPages.flatMap((page) => (page as { items: IngestSecret[] }).items)
    : [];
  const duplicateIds =
    new Set(pageItems.map((item) => item.keyId)).size !== pageItems.length;
  const pageCursors = validPages
    ? rawPages.flatMap((page) => {
        const cursor = (page as { nextCursor?: unknown }).nextCursor;
        return typeof cursor === "string" ? [cursor] : [];
      })
    : [];
  const duplicateCursors = new Set(pageCursors).size !== pageCursors.length;
  const invalid =
    rawData !== undefined && (!validPages || duplicateIds || duplicateCursors);
  return {
    items: invalid ? [] : pageItems,
    invalid,
    duplicateIds,
    duplicateCursors,
  };
}

function SignedIngestContractSummary() {
  const { t } = useTheme();
  return (
    <View
      accessibilityRole="summary"
      style={{
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 10,
        padding: 10,
        gap: 5,
      }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.fg,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        Exact signed-ingest v2 contract
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        POST /api/public/conversions/ingest. Sign the exact raw JSON bytes;
        lengths are UTF-8 byte lengths.
      </Text>
      {CONVERSION_INGEST_V2_CONTRACT.map((line) => (
        <Text
          key={line}
          selectable
          {...typeCap("caption")}
          style={{
            color: t.fg,
            ...typeStyle("caption"),
            fontFamily: "monospace",
          }}
        >
          {line}
        </Text>
      ))}
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        Derive the pseudonym inside the sender. Send only
        identity.email_hmac_sha256; never send identity.email, plaintext email,
        or unsalted email_sha256 to this API.
      </Text>
    </View>
  );
}

function IngestSecretRow({
  secret,
  revokePending,
  onRevoke,
}: {
  secret: IngestSecret;
  revokePending: boolean;
  onRevoke: (secret: IngestSecret) => void;
}) {
  const { t } = useTheme();
  const projection = projectionPresentation(secret);
  const active = ingestSecretIsActive(secret);
  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingTop: 10,
        gap: 4,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {secret.label}
        </Text>
        <Pill
          label={active ? "active" : "revoked"}
          tone={active ? "success" : "neutral"}
        />
        <Pill
          label={projection.label}
          tone={projection.tone}
          accessibilityLabel={projection.guidance}
        />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color:
            secret.identityProjectionStatus === "failed"
              ? t.danger
              : t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {projection.guidance}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        Issued {secret.createdAt}
        {secret.revokedAt ? ` · revoked ${secret.revokedAt}` : ""}
        {` · email projection updated ${secret.identityProjectionUpdatedAt}`}
      </Text>
      {active ? (
        <Pressable
          onPress={() => onRevoke(secret)}
          disabled={revokePending}
          accessibilityRole="button"
          accessibilityLabel={`Revoke the signing key ${secret.label}`}
          accessibilityState={{ disabled: revokePending }}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: revokePending ? t.fgSubtle : t.danger,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {revokePending ? "Revoking…" : "Revoke key"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function IngestSecretsPanel() {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const query = useIngestSecrets();
  const revoke = useRevokeIngestSecret();

  // Below admin the query never runs. Keeping that state absent avoids implying
  // that a viewer has inspected a credential register they cannot read.
  if (query.data === undefined && !query.isError) return null;
  const register = readRegisterPages(query.data);
  const items = register.items;
  const active = items.filter(ingestSecretIsActive);

  const onRevoke = async (secret: IngestSecret) => {
    haptics.tap();
    const copy = ingestSecretRevokeCopy(secret);
    const lastLive =
      !query.hasNextPage && active.length <= 1
        ? " This is the last live signed-ingest key."
        : "";
    const ok = await confirm({
      title: copy.title,
      message: copy.body + lastLive,
      confirmLabel: copy.confirmLabel,
      destructive: true,
    });
    if (!ok) return;
    revoke.mutate(secret.keyId, {
      onSuccess: () =>
        toast({ kind: "success", message: `${secret.label} revoked.` }),
      onError: (err) =>
        toast({
          kind: "error",
          message:
            errorPresentation(err).message ||
            `Couldn't revoke ${secret.label}.`,
        }),
    });
  };

  return (
    <View style={{ gap: 8, marginTop: 16 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        Trusted server conversion ingest
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        Private HMAC credentials for authoritative server feeds. They are
        separate from publishable browser tracking keys.
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        Mobile intentionally does not issue reveal-once credentials. Issue a new
        key from the web or desktop admin, wait until it is email-HMAC ready,
        move and verify the sender while both keys are live, then return here to
        revoke the old key. Issuance is non-replayable: if its response is lost,
        list the new key IDs, revoke the unknown new key, and issue a replacement
        from web or desktop. Never retry issuance blindly.
      </Text>
      <SignedIngestContractSummary />
      {query.isError || register.invalid ? (
        <View
          accessibilityRole="alert"
          style={{
            borderColor: t.danger,
            borderWidth: 1,
            borderRadius: 10,
            padding: 10,
            gap: 6,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.danger,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
            }}
          >
            Signed-ingest key register unavailable
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {register.invalid
              ? register.duplicateIds || register.duplicateCursors
                ? "The signed-ingest key register repeated a key or cursor across pages and could not be verified."
                : "Moosewave could not verify the signing-key register."
              : errorPresentation(query.error).message ||
                "Moosewave could not verify the signing-key register."}
          </Text>
          <Pressable
            onPress={() => void query.refetch()}
            accessibilityRole="button"
            accessibilityLabel="Retry signed-ingest key register"
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accent,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              Retry
            </Text>
          </Pressable>
        </View>
      ) : null}
      {!query.isError && !register.invalid && items.length === 0 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          No server signing keys are registered.
        </Text>
      ) : null}
      {items.map((secret) => (
        <IngestSecretRow
          key={secret.keyId}
          secret={secret}
          revokePending={revoke.isPending}
          onRevoke={(item) => void onRevoke(item)}
        />
      ))}
      {!query.isError && !register.invalid && query.hasNextPage ? (
        <Pressable
          onPress={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          accessibilityRole="button"
          accessibilityLabel="Load more server signing keys"
          accessibilityState={{ disabled: query.isFetchingNextPage }}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: query.isFetchingNextPage ? t.fgSubtle : t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {query.isFetchingNextPage
              ? "Loading more…"
              : "Load more server keys"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
