import { useEffect, useRef, useState } from "react";
import { Pressable, Share, Text, TextInput, View } from "react-native";
import { PostwaveClient } from "@postwave/sdk";

import { clearClient } from "@/api/client";
import { redactAuthError } from "@/api/auth";
import {
  Card,
  Field,
  inputStyle,
} from "@/components/settings/SettingsScreenPrimitives";
import { ApiConnectionSummary } from "@/components/settings/ApiConnectionSummary";
import { useToast, type ToastOptions } from "@/components/Toast";
import { useDirtyGuard } from "@/hooks/useDirtyGuard";
import { FONT } from "@/lib/fonts";
import { validateApiBaseUrl } from "@/lib/config";
import { keyboardChain } from "@/lib/keyboardChain";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";
import { pathLabel } from "@/lib/direction";

type TestState = "idle" | "testing" | "ok" | "fail";

type ApiKeyDraft = {
  apiKey: string;
  baseUrl: string;
  tenantId: string;
};

async function probeApiKeyDraft(
  draft: ApiKeyDraft,
): Promise<{ user?: string; email?: string }> {
  const probe = new PostwaveClient({
    apiKey: draft.apiKey,
    baseUrl: draft.baseUrl,
    tenantId: draft.tenantId,
    retries: 0,
  });
  return ((await probe.request("GET", "/api/v1/me")) ?? {}) as {
    user?: string;
    email?: string;
  };
}

export function apiProbeIdentity(response: {
  user?: unknown;
  email?: unknown;
}): string | null {
  if (typeof response.user === "string" && response.user.trim()) {
    return response.user.trim();
  }
  if (typeof response.email === "string" && response.email.trim()) {
    return response.email.trim();
  }
  return null;
}

/**
 * Has the user typed something into the API-connection form that is not yet
 * saved? Module scope on purpose: the component function sits against the
 * cyclomatic-complexity budget, and this is also the honest place to state the
 * rule — a null stored value and an empty input are the SAME state, so an
 * untouched form on a session-only install must never read as dirty.
 */
export function apiConnectionDirty(
  draft: { urlInput: string; keyInput: string; tenantInput: string },
  stored: {
    baseUrl: string | null;
    apiKey: string | null;
    tenantId: string | null;
  },
): boolean {
  return (
    draft.urlInput !== (stored.baseUrl ?? "") ||
    draft.keyInput !== (stored.apiKey ?? "") ||
    draft.tenantInput !== (stored.tenantId ?? "")
  );
}

/**
 * An error toast: "Couldn't <verb>." plus what the failure said. Outcomes here
 * are toasts, not Alerts (the Settings screen's contract, Toast.tsx). A
 * credential failure's detail is redacted; a share-sheet failure's is not.
 */
function failureToast(lead: string, e: unknown, redact = true): ToastOptions {
  const raw = e instanceof Error ? e.message : "";
  const detail = redact && raw ? redactAuthError(raw) : raw;
  return { kind: "error", message: `${lead} ${detail}`.trim() };
}

export function ApiConnectionSection() {
  const { t } = useTheme();
  const { toast } = useToast();
  const baseUrl = useAuthStore((s) => s.baseUrl);
  const tenantId = useAuthStore((s) => s.tenantId);
  const apiKey = useAuthStore((s) => s.apiKey);
  const mode = useAuthStore((s) => s.mode);
  const session = useAuthStore((s) => s.session);
  const signIn = useAuthStore((s) => s.signIn);

  const [urlInput, setUrlInput] = useState<string>(baseUrl ?? "");
  const [keyInput, setKeyInput] = useState<string>(apiKey ?? "");
  const [tenantInput, setTenantInput] = useState<string>(tenantId ?? "");
  const [showKey, setShowKey] = useState<boolean>(false);
  // Return-key chain: URL → tenant slug → API key → save. Three fields
  // that are always filled in this order, and were three separate
  // keyboard dismissals before (LOVE#44).
  const tenantRef = useRef<TextInput>(null);
  const keyRef = useRef<TextInput>(null);
  const [testState, setTestState] = useState<TestState>("idle");
  const [testMsg, setTestMsg] = useState<string>("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [showApiKeyForm, setShowApiKeyForm] = useState<boolean>(
    mode !== "session",
  );

  useEffect(() => {
    setUrlInput(baseUrl ?? "");
    setKeyInput(apiKey ?? "");
    setTenantInput(tenantId ?? "");
  }, [baseUrl, tenantId, apiKey]);

  // Nothing used to stop a stray tap on the back chevron from discarding a
  // half-typed API key — a credential the user may have had to fetch from
  // another device. The screen's back handler reads this registry.
  useDirtyGuard(
    "api-connection",
    "API connection",
    apiConnectionDirty(
      { urlInput, keyInput, tenantInput },
      { baseUrl, apiKey, tenantId },
    ),
  );

  function readApiKeyDraft(): ApiKeyDraft | null {
    const validBaseUrl = validateApiBaseUrl(urlInput);
    const key = keyInput.trim();
    const tenant = tenantInput.trim();
    if (!validBaseUrl.ok) {
      toast({ kind: "error", message: validBaseUrl.message });
      return null;
    }
    if (!key) {
      toast({ kind: "error", message: "Paste the workspace API key." });
      return null;
    }
    if (!tenant) {
      toast({ kind: "error", message: "Enter the workspace slug." });
      return null;
    }
    return { apiKey: key, baseUrl: validBaseUrl.url, tenantId: tenant };
  }

  async function persist(draft: ApiKeyDraft): Promise<boolean> {
    try {
      await signIn({
        apiKey: draft.apiKey,
        baseUrl: draft.baseUrl,
        tenantId: draft.tenantId,
      });
      clearClient();
      return true;
    } catch (e) {
      toast(failureToast("Couldn't save the API connection.", e));
      return false;
    }
  }

  async function onTest() {
    if (saveBusy || testState === "testing") return;
    setTestState("testing");
    setTestMsg("");
    const draft = readApiKeyDraft();
    if (!draft) {
      setTestState("idle");
      return;
    }
    try {
      const res = await probeApiKeyDraft(draft);
      const saved = await persist(draft);
      if (!saved) {
        setTestState("fail");
        setTestMsg("Verified, but couldn't save credentials.");
        return;
      }
      setTestState("ok");
      const identity = apiProbeIdentity(res);
      setTestMsg(identity ? `OK · ${identity}` : "OK · credentials valid");
    } catch (e) {
      setTestState("fail");
      setTestMsg(
        e instanceof Error ? redactAuthError(e.message) : "Unknown error",
      );
    }
  }

  async function onSave() {
    if (saveBusy || testState === "testing") return;
    const draft = readApiKeyDraft();
    if (!draft) return;
    setSaveBusy(true);
    try {
      try {
        await probeApiKeyDraft(draft);
      } catch (e) {
        toast(failureToast("Couldn't verify credentials.", e));
        return;
      }
      const saved = await persist(draft);
      if (saved) {
        setTestState("idle");
        setTestMsg("");
        toast({ kind: "success", message: "API connection updated." });
      }
    } finally {
      setSaveBusy(false);
    }
  }

  function onShareConnection() {
    const tenant = tenantId ?? session?.tenantId ?? "";
    const parts = [
      baseUrl ? `URL: ${baseUrl}` : "",
      tenant ? `Tenant: ${tenant}` : "",
    ].filter(Boolean);
    if (parts.length === 0) return;
    void Share.share(
      { message: parts.join("\n"), title: "Moosewave connection" },
      { dialogTitle: "Moosewave API connection" },
    ).catch((e: unknown) => {
      toast(failureToast("Couldn't share the connection details.", e, false));
    });
  }

  const dotColor =
    testState === "ok"
      ? t.success
      : testState === "fail"
        ? t.danger
        : t.fgSubtle;

  if (mode === "session" && !showApiKeyForm) {
    return (
      <ApiConnectionSummary
        baseUrl={baseUrl}
        tenantLabel={tenantId ?? session?.tenantId ?? ""}
        onUseApiKey={() => setShowApiKeyForm(true)}
        onShare={onShareConnection}
      />
    );
  }

  return (
    <Card>
      <Field
        label="API URL"
        hint="Base URL of the Moosewave gateway this app talks to. Leave the default unless you self-host."
      >
        <TextInput
          // Inputs scale with the OS text size but their height does not — cap it.
          {...typeCap("body")}
          value={urlInput}
          onChangeText={setUrlInput}
          accessibilityLabel="API URL"
          accessibilityHint="Base URL of the Moosewave gateway. Leave the default unless you self-host."
          placeholder="https://api.moosewave.com"
          placeholderTextColor={t.fgSubtle}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          {...keyboardChain({ next: tenantRef })}
          style={inputStyle(t)}
        />
      </Field>
      <Field
        label="Tenant slug"
        hint="Your workspace's short name — the part after /app/ in a Moosewave web address."
      >
        <TextInput
          // Inputs scale with the OS text size but their height does not — cap it.
          {...typeCap("body")}
          ref={tenantRef}
          value={tenantInput}
          onChangeText={setTenantInput}
          accessibilityLabel="Tenant slug"
          accessibilityHint="Your workspace's short name, the part after slash app in a Moosewave web address."
          placeholder="acme"
          placeholderTextColor={t.fgSubtle}
          autoCapitalize="none"
          autoCorrect={false}
          {...keyboardChain({ next: keyRef })}
          style={inputStyle(t)}
        />
      </Field>
      <Field
        label="API key"
        hint={`Workspace bearer token (pw_…). An admin generates it under ${pathLabel(
          ["Workspace", "API keys"],
        )}. Never share it.`}
      >
        <TextInput
          // Inputs scale with the OS text size but their height does not — cap it.
          {...typeCap("body")}
          ref={keyRef}
          value={keyInput}
          onChangeText={setKeyInput}
          accessibilityLabel="API key"
          accessibilityHint="Workspace bearer token starting p w underscore. Generated by an admin under Workspace, API keys."
          placeholder="pw_…"
          placeholderTextColor={t.fgSubtle}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={!showKey}
          {...keyboardChain({ onSubmit: () => void onSave() })}
          style={inputStyle(t)}
        />
        <Pressable
          onPress={() => setShowKey((s) => !s)}
          hitSlop={8}
          accessibilityRole="button"
          style={{ marginTop: 6 }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.accent,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {showKey ? "Hide key" : "Show key"}
          </Text>
        </Pressable>
      </Field>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 8,
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: dotColor,
            }}
          />
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {testState === "testing"
              ? "Testing…"
              : testState === "ok"
                ? testMsg
                : testState === "fail"
                  ? `Failed: ${testMsg}`
                  : "Not tested"}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable
            onPress={() => void onTest()}
            disabled={testState === "testing" || saveBusy}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: t.surface,
              opacity: testState === "testing" || saveBusy ? 0.6 : 1,
            }}
            accessibilityRole="button"
            accessibilityLabel="Test API connection"
          >
            <Text
              // Toolbar-style button sharing a row with Save: dense.
              {...typeCap("control")}
              style={{
                color: t.fg,
                ...typeStyle("control"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              Test
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void onSave()}
            disabled={saveBusy || testState === "testing"}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 10,
              backgroundColor: t.accent,
              opacity: saveBusy || testState === "testing" ? 0.6 : 1,
            }}
            accessibilityRole="button"
            accessibilityLabel="Save API connection"
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accentFg,
                ...typeStyle("control"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              {saveBusy ? "Saving…" : "Save"}
            </Text>
          </Pressable>
        </View>
      </View>
      {mode === "session" ? (
        <Pressable
          onPress={() => setShowApiKeyForm(false)}
          accessibilityRole="button"
          style={{ marginTop: 12, alignSelf: "flex-start" }}
          hitSlop={6}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.accent,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            Hide — keep using the session cookie
          </Text>
        </Pressable>
      ) : null}
    </Card>
  );
}
