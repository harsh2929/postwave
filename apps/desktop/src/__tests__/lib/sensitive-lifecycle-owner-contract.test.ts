import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("sensitive lifecycle owner source contract", () => {
  it("identifies telemetry only from the session-provenance pair", () => {
    const app = source("App.tsx");
    const store = source("lib/store.ts");

    expect(app).toContain("const identity = me?.telemetryIdentity");
    expect(app).toMatch(
      /identifyTelemetry\([\s\S]*identity\?\.user \?\? null,[\s\S]*identity\?\.tenant \?\? null,[\s\S]*identity\?\.apiBaseUrl \?\? null/u,
    );
    expect(app).not.toMatch(/identifyTelemetry\(me\.(?:user|tenant)/u);
    expect(store).toContain("telemetryIdentity: null");
    expect(store).toMatch(
      /getAuthMe\(\)[\s\S]*canonicalSessionPrincipal\([\s\S]*res\.data\.user_id[\s\S]*res\.data\.tenant_id[\s\S]*telemetryIdentity: qualifiedSessionPrincipal/u,
    );
  });

  it("namespaces durable Helpdesk note recovery only by session provenance", () => {
    const helpdesk = source("pages/Helpdesk.tsx");

    expect(helpdesk).toMatch(
      /const noteRecoveryPrincipal = me\?\.noteRecoveryPrincipal[\s\S]*currentNoteApiBaseUrl === noteRecoveryPrincipal\.apiBaseUrl[\s\S]*sessionNoteRecoveryAuthority\([\s\S]*noteRecoveryPrincipal\.user[\s\S]*noteRecoveryPrincipal\.tenant[\s\S]*noteRecoveryPrincipal\.apiBaseUrl/u,
    );
    expect(helpdesk).not.toContain(
      "const noteRecoveryAuthority = routeIdentityScope",
    );
    expect(helpdesk).toContain("Keep note");
    expect(helpdesk).toContain("creation unavailable for API-key provenance");
  });

  it("uses an imperative, mounted-instance-safe shown-once handoff", () => {
    const lifecycle = source("hooks/useShownOnceSecretLifecycle.ts");

    expect(lifecycle).toContain("const instanceId = useId()");
    expect(lifecycle).toContain("activeRef.current = true");
    expect(lifecycle).toContain("activeRef.current = false");
    expect(lifecycle).toContain("shown-once-${id}-${instanceId}");
    expect(lifecycle).toContain('intent.disposition === "hide"');
    expect(lifecycle).not.toContain("localStorage");
    expect(lifecycle).not.toContain("prepare:");
  });

  it("owns TOTP, workspace API-key, agent-key, and SCIM plaintext through resolution", () => {
    const totp = source("components/TotpSetupModal.tsx");
    const apiKeys = source("components/settings/ApiKeysSection.tsx");
    const agentKey = source("components/ai/AgentKeyCard.tsx");
    const mcpSetup = source("components/mcp/McpConnectionSetup.tsx");
    const scim = source("pages/SCIM.tsx");

    expect(totp).toContain("useSingleFlightOperation(");
    expect(totp).toContain("recoveryLifecycle.activate()");
    expect(totp).toMatch(
      /recoveryLifecycle\.resolve\(\)[\s\S]*setRecoveryCodes\(\[\]\)[\s\S]*setOtpauth\(""\)/u,
    );
    expect(apiKeys).toContain("useDiscardOnlyDraftLifecycle({");
    expect(apiKeys).toContain('title="Discard API-key draft?"');
    expect(apiKeys).toMatch(
      /operation\.run\(async[\s\S]*plaintextLifecycle\.activate\(\)[\s\S]*setPlaintext/u,
    );
    expect(apiKeys).toMatch(
      /plaintextLifecycle\.resolve\(\)[\s\S]*setPlaintext\(null\)/u,
    );
    expect(agentKey).not.toContain("useShownOnceSecretLifecycle(");
    expect(agentKey).not.toContain("mintedPlaintext");
    expect(agentKey).toContain("useDiscardOnlyDraftLifecycle({");
    expect(mcpSetup).not.toContain("useShownOnceSecretLifecycle(");
    expect(mcpSetup).not.toContain("AgentKeyCard");
    expect(mcpSetup).toContain('apiKey=""');
    expect(mcpSetup).toContain("transfersEnabled={false}");
    expect(scim).toContain("useDiscardOnlyDraftLifecycle({");
    expect(scim).toContain('title="Discard SCIM token draft?"');
    expect(scim).toContain('title="Close without storing this token?"');
    expect(scim).toMatch(
      /tokenSecretLifecycle\.activate\(\)[\s\S]*setMinted\(m\)/u,
    );
    expect(
      `${totp}\n${apiKeys}\n${agentKey}\n${mcpSetup}\n${scim}`,
    ).not.toMatch(/console\.(?:log|info|warn|error)|sessionStorage|indexedDB/u);
  });

  it("keeps gift and podcast values single-owned, redacted, and explicitly replaceable", () => {
    const gift = source("pages/GiftSubscriptions.tsx");
    const giftWorkspace = source("components/gifts/GiftHistoryWorkspace.tsx");
    const giftTransport = source("lib/api/monetization.ts");
    const podcast = source("components/archive/PodcastTokensCard.tsx");

    expect(gift).toContain(
      "Creation, cancellation, editing, payment handoff, redemption",
    );
    expect(giftWorkspace).toContain("Identity-minimized");
    expect(giftWorkspace).toContain("Gift creation, cancellation, editing");
    expect(`${gift}\n${giftWorkspace}\n${giftTransport}`).not.toMatch(
      /useShownOnceSecretLifecycle|writeClipboardText|createGiftSubscription|cancelGiftSubscription|updateGiftSubscription|stripe_payment_url|redemption_url/u,
    );
    expect(podcast).toContain("useShownOnceSecretLifecycle(");
    expect(podcast).toContain("useSingleFlightOperation({");
    expect(podcast).toContain("function podcastTokenMetadata(");
    expect(podcast).toMatch(
      /const \{ token: _token, feed_url: _feedUrl, \.\.\.metadata \} = value/u,
    );
    expect(podcast).toContain('title="Discard the shown private feed URL?"');
    expect(podcast).toContain("activateMintedSecret()");
    expect(podcast).toContain("resolveMintedSecret()");
    expect(podcast).toContain("I stored it securely");
  });

  it("requires an active audit session to be revoked before close or replacement", () => {
    const portal = source("components/audit/AuditPortalSessionModal.tsx");

    expect(portal).toContain("useShownOnceSecretLifecycle(");
    expect(portal).toContain("useSingleFlightOperation(");
    expect(portal).toContain("onClose={guardedClose}");
    expect(portal).toContain('title="Revoke session and close?"');
    expect(portal).toContain('title="Revoke and replace this session?"');
    expect(portal).toMatch(
      /return \(\) => \{[\s\S]*liveSessionRef\.current[\s\S]*runOperation\([\s\S]*revokeAuditPortalSession/u,
    );
    expect(portal).toContain("resolveSession()");
    expect(portal).toContain("void request?.catch(() => undefined)");
  });

  it("guards conversion key drafts, operations, and one-time plaintext", () => {
    const track = source("components/track/ConversionsSection.tsx");

    expect(track).toContain("useShownOnceSecretLifecycle(");
    expect(track).toContain("useDiscardOnlyDraftLifecycle({");
    expect(track).toContain("useSingleFlightOperation({");
    expect(track).toContain('ownerId: "conversion-key-create"');
    expect(track).toContain('"Discard tracking-key draft?"');
    expect(track).toContain('title="Close without storing this key?"');
    expect(track).toContain('contentClass: secret ? "secret" : "public"');
    expect(track).toMatch(
      /operation\.run\([\s\S]*activateSecretGuard\(\)[\s\S]*setRevealed/u,
    );
  });

  it("guards private conversion-ingest issuance independently from publishable keys", () => {
    const ingest = source("components/track/ConversionIngestSecretsPanel.tsx");

    expect(ingest).toContain("useShownOnceSecretLifecycle(");
    expect(ingest).toContain("useDiscardOnlyDraftLifecycle({");
    expect(ingest).toContain("useSingleFlightOperation({");
    expect(ingest).toContain('"conversion-ingest-secret"');
    expect(ingest).toContain("protectSecret()");
    expect(ingest).toMatch(/releaseSecret\(\)[\s\S]*setRevealed\(null\)/u);
    expect(ingest).toContain('contentClass: "secret"');
    expect(ingest).not.toMatch(
      /console\.(?:log|info|warn|error)|localStorage|sessionStorage|indexedDB/u,
    );
  });

  it("guards inbound webhook drafts, operations, and signing secrets", () => {
    const inbound = source("pages/InboundWebhooks.tsx");

    expect(inbound).toContain("useShownOnceSecretLifecycle(");
    expect(inbound).toContain("useDiscardOnlyDraftLifecycle({");
    expect(inbound).toContain("useSingleFlightOperation({");
    expect(inbound).toContain('ownerId: "inbound-webhook-create"');
    expect(inbound).toContain('title="Discard inbound endpoint draft?"');
    expect(inbound).toContain('title="Close without storing this secret?"');
    expect(inbound).toContain("I&apos;ve stored it securely");
    expect(inbound).toMatch(
      /operation\.run\(async[\s\S]*secretLifecycle\.activate\(\)[\s\S]*setRevealed/u,
    );
  });

  it("aggregates outbound operations and protects child drafts plus plaintext", () => {
    const outbound = source("pages/OutboundWebhooks.tsx");
    const preset = source("components/webhooks/ReceiverPresetDialog.tsx");
    const edit = source("components/webhooks/OutboundWebhookEditDialog.tsx");

    expect(outbound).toContain("useShownOnceSecretLifecycle(");
    expect(outbound).toContain("useSingleFlightOperation({");
    expect(outbound).toContain('title="Discard the shown signing material?"');
    expect(outbound).toMatch(
      /publishMaterial[\s\S]*secretLifecycle\.activate\(\)[\s\S]*setRevealed/u,
    );
    expect(outbound).toMatch(
      /onCreated=\{\(created\) => \{[\s\S]*publishMaterial\(created, "created"\)/u,
    );
    expect(preset).toContain("useDiscardOnlyDraftLifecycle({");
    expect(preset).toContain("useSingleFlightOperation({");
    expect(preset).toContain('title="Discard webhook receiver draft?"');
    expect(preset).toContain("onClose={guardedClose}");
    expect(preset).toMatch(
      /operation\.run\(async[\s\S]*onCreated\(res\.data\)/u,
    );
    expect(edit).toContain("useBlockingLifecycleOperation(");
    expect(edit).toContain("outbound-webhook-edit-draft-");
    expect(edit).toContain('title="Discard webhook changes?"');
  });

  it("zeroizes unsaved workspace credentials on explicit discard", () => {
    const workspace = source("components/WorkspaceMenu.tsx");

    expect(workspace).toContain("useSingleFlightOperation({");
    expect(workspace).toContain("useDiscardOnlyDraftLifecycle({");
    expect(workspace).toContain('ownerId: "add-workspace"');
    expect(workspace).toContain('title="Discard workspace connection?"');
    expect(workspace).toMatch(
      /discardAndClose[\s\S]*setApiUrl\(""\)[\s\S]*setKey\(""\)/u,
    );
  });

  it("blocks first-run credential loss and zeroizes after save or discard", () => {
    const welcome = source("pages/Welcome.tsx");
    const app = source("App.tsx");

    expect(welcome).toContain("useSingleFlightOperation({");
    expect(welcome).toContain("useDiscardOnlyDraftLifecycle({");
    expect(welcome).toContain('ownerId: "welcome-api-credential"');
    expect(welcome).toMatch(
      /discardDraft[\s\S]*setUrl\(DEFAULT_API_URL\)[\s\S]*setKey\(""\)/u,
    );
    expect(welcome).toMatch(
      /operation\.run\([\s\S]*setApiConfig[\s\S]*await request[\s\S]*setKey\(""\)[\s\S]*onDone\(\)/u,
    );
    expect(welcome).toContain("Stored in the device keychain");
    expect(app).toMatch(
      /const onWelcomeDone = useCallback\(\(\) => \{[\s\S]*setBoot\("ready"\)[\s\S]*void loadMe\(\)/u,
    );
  });

  it("protects deliverability credentials and confirms every local destructive transition", () => {
    const provider = source("components/deliverability/ProviderConfigCard.tsx");

    expect(provider).toContain("useBlockingLifecycleOperation(");
    expect(provider).toContain(
      "deliverability-provider-credential-draft-${instanceId}",
    );
    expect(provider).toContain(
      'title="Discard credentials and switch provider?"',
    );
    expect(provider).toContain('title="Remove this provider?"');
    expect(provider).toContain('contentClass: "secret"');
    expect(provider).toContain("clearIfUnchangedAfterMs: 60_000");
    expect(provider).toContain("I stored it securely");
    expect(provider).toMatch(
      /zeroizeDraft[\s\S]*setDisplayName\(""\)[\s\S]*setToken\(""\)[\s\S]*setCredentialRef\(""\)/u,
    );
    expect(provider).toMatch(
      /operationRef\.current = true[\s\S]*finally \{[\s\S]*operationRef\.current = false/u,
    );
  });

  it("zeroizes BYOK drafts and blocks every key-management operation", () => {
    const byok = source("components/hipaa/BYOKKeysPanel.tsx");

    expect(byok).toContain("useBlockingLifecycleOperation(");
    expect(byok).toContain("byok-key-draft-${instanceId}");
    expect(byok).toContain('title="Discard key registration?"');
    expect(byok).toContain("discard: discardAndClose");
    expect(byok).toMatch(
      /clearSensitiveDraft[\s\S]*key_ref: ""[\s\S]*description: ""/u,
    );
    expect(byok).toMatch(
      /operationRef\.current = true[\s\S]*finally \{[\s\S]*operationRef\.current = false/u,
    );
    expect(byok).toContain("busy={operationActive}");
  });

  it("protects every native provider credential modal with one instance-safe contract", () => {
    const hook = source("hooks/useCredentialDraftLifecycle.ts");
    const providers = source(
      "pages/integrations/NativeProviderConnectModals.tsx",
    );

    expect(hook).toContain("useBlockingLifecycleOperation(");
    expect(hook).toContain('intent.disposition === "hide"');
    expect(hook).toContain("credential-draft-${ownerId}-${instanceId}");
    expect(hook).toContain("setValues({})");
    expect(hook).toMatch(
      /beginOperation[\s\S]*operationRef\.current = true[\s\S]*finishOperation[\s\S]*operationRef\.current = false/u,
    );
    expect(providers.match(/useCredentialDraftLifecycle\(\{/gu)).toHaveLength(
      7,
    );
    expect(providers).toContain("No credential field is shown");
    expect(providers).not.toContain("supportIntegrationsApi.create");
    expect(providers.match(/await runCredentialConnection\(\{/gu)).toHaveLength(
      7,
    );
    expect(providers.match(/\} = useProviderRegistry</gu)).toHaveLength(8);
    expect(providers.match(/void loadProviderRegistry\(\{/gu)).toHaveLength(1);
    expect(providers).toContain("requestRef.current = request");
    expect(providers).toContain("active = false");
    expect(providers).not.toMatch(/CommerceConnectModal|native-commerce/u);
    expect(providers).toMatch(
      /loadProviderRegistry[\s\S]*try \{[\s\S]*await request\(signal\)[\s\S]*catch \{[\s\S]*finally \{/u,
    );
    expect(providers).toContain("controller.abort()");
    expect(providers).toContain('title="Discard provider credentials?"');
    expect(providers).toMatch(
      /try \{[\s\S]*await request\(\)[\s\S]*finally \{[\s\S]*lifecycle\.finishOperation\(\)[\s\S]*setBusy\(false\)/u,
    );
    expect(`${hook}\n${providers}`).not.toMatch(
      /console\.(?:log|info|warn|error)|localStorage|sessionStorage|indexedDB/u,
    );
  });

  it("protects store credentials, including explicit provider-switch discard", () => {
    const commerce = source("components/commerce/IntegrationsTab.tsx");

    expect(commerce).toContain("useCredentialDraftLifecycle(");
    expect(commerce).toContain('ownerId: "commerce-store-connect"');
    expect(commerce).toContain('title="Discard store credentials?"');
    expect(commerce).toContain(
      'title="Discard credentials and switch provider?"',
    );
    expect(commerce).toMatch(
      /if \(lifecycle\.dirty\)[\s\S]*setProviderSwitchTarget\(nextProvider\)/u,
    );
    expect(commerce).toMatch(
      /onConfirm=\{\(\) => \{[\s\S]*setValues\(\{\}\)[\s\S]*setProviderKey\(providerSwitchTarget\)/u,
    );
    expect(commerce).toMatch(
      /try \{[\s\S]*startShopifyOAuth[\s\S]*createIntegration[\s\S]*finally \{[\s\S]*lifecycle\.finishOperation\(\)[\s\S]*setBusy\(false\)/u,
    );
    expect(commerce).toMatch(
      /try \{[\s\S]*commerceApi\.listProviders\(\)[\s\S]*catch \{/u,
    );
    expect(commerce).not.toMatch(
      /console\.(?:log|info|warn|error)|localStorage|sessionStorage|indexedDB/u,
    );
  });

  it("drains AI settings while keeping replay and golden drafts explicit", () => {
    const ai = source("components/ai/AIRegressionSettings.tsx");

    expect(ai).toContain("settingsDrainPromiseRef");
    expect(ai).toContain("prepare: persistSettings");
    expect(ai).toContain("discard: discardSettings");
    expect(ai).toContain("ai-regression-local-draft-${instanceId}");
    expect(ai).toContain("discard: discardLocalDraft");
    expect(ai).toContain('title="Discard AI regression draft?"');
    expect(ai).toContain("useBlockingLifecycleOperation(");
    expect(ai).not.toContain("queuedSettingsRef.current = null;\n    };");
    expect(ai).toMatch(
      /settingsDrainPromiseRef\.current[\s\S]*return settingsDrainPromiseRef\.current/u,
    );
  });

  it("guards every audit-sink draft and operation without journaling credentials", () => {
    const sinks = source("pages/AuditSinks.tsx");
    const primitives = source("components/audit/AuditSinkEditorPrimitives.tsx");
    const lifecycle = source("hooks/useAuditSinkDraftLifecycle.ts");

    expect(sinks).toContain("useAuditSinkDraftLifecycle({");
    expect(sinks).toContain('ownerId: "audit-sink-create"');
    expect(sinks).toContain("ownerId: `audit-sink-edit-${sink.id}`");
    expect(sinks).toContain("hasPopulatedValues(config)");
    expect(sinks).toContain("hasPopulatedValues(credentials)");
    expect(sinks).toContain('title="Discard this audit sink draft?"');
    expect(sinks).toContain('title="Discard audit sink changes?"');
    expect(sinks).toContain('title="Discard replacement credentials?"');
    expect(sinks).toContain("`audit-sink-detail-${sink.id}-${instanceId}`");
    expect(sinks).toContain("`audit-sink-delete-${sink.id}-${instanceId}`");
    expect(sinks).toMatch(
      /create = async[\s\S]*operationRef\.current = true[\s\S]*finally \{[\s\S]*operationRef\.current = false/u,
    );
    expect(sinks).toMatch(
      /save = async[\s\S]*operationRef\.current = true[\s\S]*zeroizeCredentials\(\)[\s\S]*finally \{[\s\S]*operationRef\.current = false/u,
    );
    expect(sinks).toMatch(
      /runAction = async[\s\S]*actionRef\.current = true[\s\S]*finally \{[\s\S]*actionRef\.current = false/u,
    );
    expect(sinks).toMatch(
      /destroy = async[\s\S]*operationRef\.current = true[\s\S]*finally \{[\s\S]*operationRef\.current = false/u,
    );
    expect(lifecycle).toContain("useBlockingLifecycleOperation(");
    expect(lifecycle).toContain("`${ownerId}-draft-${instanceId}`");
    expect(lifecycle).toContain('intent.disposition === "hide"');
    expect(lifecycle).not.toContain("prepare:");
    expect(primitives).toContain('title="Rotate this signing key?"');
    expect(primitives).toMatch(
      /rotateRef\.current = true[\s\S]*onOperationChange\(true\)[\s\S]*finally \{[\s\S]*rotateRef\.current = false[\s\S]*onOperationChange\(false\)/u,
    );
  });
});
