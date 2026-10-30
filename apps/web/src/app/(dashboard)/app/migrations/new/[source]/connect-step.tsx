// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, FileUp } from "lucide-react";
import { toast } from "sonner";

import {
  connectWithApiKey,
  startOAuth,
  uploadMigrationFile,
} from "@/lib/migration-api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { activeCampaignApiUrlError } from "@/lib/activecampaign-api-url";
import { customerIOWorkspaceIDError } from "@/lib/customerio-workspace-id";
import {
  detectEmailColumn,
  extractHeaderLine,
  parseCsvHeaderRow,
  validateCsvColumns,
} from "@/lib/migration-csv-mapping";
import { isMockModeEnabled } from "@/lib/mock-mode";
import { safeExternalHTTPSURL } from "@/lib/safe-navigation";
import { SOURCE_LABELS, type SourcePlatform } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select } from "@/components/ui/select";

const MAX_MIGRATION_UPLOAD_BYTES = 200 * 1024 * 1024;
// The column picker is a native select, so keep its DOM bounded against a
// comma-bomb header while still accommodating the product's normal 1,000-field
// tenant ceiling plus system columns and generously-sized custom deployments.
const MAX_MIGRATION_CSV_COLUMNS = 2_000;
const MAX_CSV_HEADER_CHIPS = 24;

export function migrationFileSelectionError(
  source: SourcePlatform,
  file: Pick<File, "name" | "size">,
): string | null {
  if (file.size === 0) return "Choose a file that isn't empty.";
  if (file.size > MAX_MIGRATION_UPLOAD_BYTES) {
    return "Migration uploads must be 200 MB or smaller.";
  }

  const filename = file.name.trim().toLowerCase();
  const accepted =
    source === "substack"
      ? filename.endsWith(".csv") || filename.endsWith(".zip")
      : filename.endsWith(".csv");
  if (accepted) return null;
  return source === "substack"
    ? "Choose an official Substack ZIP or a CSV file."
    : "Choose a CSV file.";
}

export function ConnectStep({
  source,
  authMethod,
  onConnected,
  identity,
  authorityKey,
  beforeWrite,
  desktopReturn = false,
}: {
  source: SourcePlatform;
  authMethod: "oauth2" | "api_key" | "csv_upload";
  onConnected: (jobId: string) => void;
  identity: MeResponse;
  authorityKey: string;
  beforeWrite: (signal?: AbortSignal) => Promise<void>;
  desktopReturn?: boolean;
}) {
  if (authMethod === "oauth2") {
    return (
      <OAuthConnect
        key={authorityKey}
        source={source}
        onConnected={onConnected}
        identity={identity}
        beforeWrite={beforeWrite}
        desktopReturn={desktopReturn}
      />
    );
  }
  if (authMethod === "api_key") {
    return (
      <ApiKeyConnect
        key={authorityKey}
        source={source}
        onConnected={onConnected}
        beforeWrite={beforeWrite}
      />
    );
  }
  return (
    <CsvConnect
      key={authorityKey}
      source={source}
      onConnected={onConnected}
      authorityKey={authorityKey}
      beforeWrite={beforeWrite}
    />
  );
}

function OAuthConnect({
  source,
  onConnected,
  identity,
  beforeWrite,
  desktopReturn,
}: {
  source: SourcePlatform;
  onConnected: (jobId: string) => void;
  identity: MeResponse;
  beforeWrite: (signal?: AbortSignal) => Promise<void>;
  desktopReturn: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const pendingRef = useRef(false);
  const operationRef = useRef<AbortController | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(
    () => () => {
      operationRef.current?.abort();
      operationRef.current = null;
      pendingRef.current = false;
    },
    [],
  );

  useEffect(() => {
    if (connectionError) errorRef.current?.focus();
  }, [connectionError]);

  const handleStart = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    const controller = new AbortController();
    operationRef.current = controller;
    setPending(true);
    setConnectionError("");
    let markerWritten = false;
    try {
      await beforeWrite(controller.signal);
      controller.signal.throwIfAborted();
      const { authorize_url } = await startOAuth(
        source,
        undefined,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const mockMode = isMockModeEnabled();
      const target = mockMode
        ? null
        : safeExternalHTTPSURL(authorize_url, [
            "/migrations/oauth/callback",
            "/app/migrations/oauth/callback",
          ]);
      if (!mockMode && !target) {
        throw new Error("Migration provider returned an unsafe OAuth URL.");
      }
      try {
        sessionStorage.setItem(
          "postwave:oauth-pending",
          JSON.stringify({
            source,
            desktopReturn,
            startedAt: Date.now(),
            tenantId: identity.tenant_id,
            userId: identity.user_id,
            effectiveRole: effectiveAuthRole(identity),
            viewerMode: identity.viewer_mode === true,
          }),
        );
        markerWritten = true;
      } catch {
        // Backend state validation still protects the callback when local
        // sessionStorage is unavailable.
      }
      toast.success("OAuth started", {
        description: `Redirecting to ${SOURCE_LABELS[source]}...`,
      });
      if (mockMode) {
        onConnected("mock_state");
      } else {
        window.location.assign(target!);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      if (markerWritten) {
        try {
          sessionStorage.removeItem("postwave:oauth-pending");
        } catch {
          // The server-side state remains authoritative when storage fails.
        }
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      setConnectionError(message);
      toast.error("Could not start OAuth", {
        description: message,
      });
      pendingRef.current = false;
      setPending(false);
    } finally {
      if (operationRef.current === controller && !controller.signal.aborted) {
        operationRef.current = null;
      }
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect to {SOURCE_LABELS[source]}</CardTitle>
        <CardDescription>
          You&apos;ll be redirected to {SOURCE_LABELS[source]} to authorize
          source access. We never write back to your old platform.
          {desktopReturn
            ? " After approval, return to the desktop app; it will detect this tenant-scoped job automatically."
            : ""}
        </CardDescription>
      </CardHeader>
      {connectionError ? (
        <CardContent>
          <p
            ref={errorRef}
            id="migration-oauth-connection-error"
            role="alert"
            tabIndex={-1}
            className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm text-foreground outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {connectionError}
          </p>
        </CardContent>
      ) : null}
      <CardFooter>
        <Button
          type="button"
          className="w-full sm:w-auto"
          onClick={handleStart}
          loading={pending}
          aria-describedby={
            connectionError ? "migration-oauth-connection-error" : undefined
          }
        >
          {pending
            ? "Opening connection…"
            : `Continue with ${SOURCE_LABELS[source]}`}
        </Button>
      </CardFooter>
    </Card>
  );
}

function ApiKeyConnect({
  source,
  onConnected,
  beforeWrite,
}: {
  source: SourcePlatform;
  onConnected: (jobId: string) => void;
  beforeWrite: (signal?: AbortSignal) => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [customerIORegion, setCustomerIORegion] = useState<"us" | "eu">("us");
  const [pending, setPending] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const pendingRef = useRef(false);
  const operationRef = useRef<AbortController | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const activeCampaignUrlError =
    source === "activecampaign" ? activeCampaignApiUrlError(accountId) : null;
  const customerIOWorkspaceError =
    source === "customerio" ? customerIOWorkspaceIDError(accountId) : null;
  const hubSpotHubIDValidationError =
    source === "hubspot" ? hubSpotHubIDError(accountId) : null;
  const canSubmit = apiKeyConnectCanSubmit(source, apiKey, accountId);
  const credentialLabel =
    source === "hubspot"
      ? "HubSpot Service Key or existing access token"
      : source === "activecampaign"
        ? "API token"
        : source === "mailerlite"
          ? "MailerLite API token"
          : source === "klaviyo"
            ? "Klaviyo private API key"
            : source === "customerio"
              ? "Customer.io App API key"
              : "API key";

  useEffect(() => {
    if (connectionError) errorRef.current?.focus();
  }, [connectionError]);

  useEffect(
    () => () => {
      operationRef.current?.abort();
      operationRef.current = null;
      pendingRef.current = false;
    },
    [],
  );

  const clearConnectionError = () => {
    if (connectionError) setConnectionError("");
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || pendingRef.current) return;
    const intent = {
      source,
      apiKey: apiKey.trim(),
      accountId: accountId.trim() || undefined,
      extra: source === "customerio" ? { region: customerIORegion } : undefined,
    } as const;
    pendingRef.current = true;
    const controller = new AbortController();
    operationRef.current = controller;
    setPending(true);
    setConnectionError("");
    try {
      await beforeWrite(controller.signal);
      controller.signal.throwIfAborted();
      const res = await connectWithApiKey(
        intent.source,
        intent.apiKey,
        intent.accountId,
        intent.extra,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      toast.success(
        source === "hubspot"
          ? "HubSpot credential saved"
          : source === "activecampaign"
            ? "API token saved"
            : source === "mailerlite"
              ? "MailerLite API token saved"
              : "API key saved",
      );
      onConnected(res.job_id);
    } catch (err) {
      if (controller.signal.aborted) return;
      const message =
        err instanceof Error ? err.message : "Unknown connection error";
      setConnectionError(message);
      toast.error("Could not connect source", {
        description: message,
      });
    } finally {
      if (operationRef.current === controller) {
        operationRef.current = null;
        pendingRef.current = false;
        if (!controller.signal.aborted) setPending(false);
      }
    }
  };

  return (
    <Card>
      <form onSubmit={handleSubmit} aria-busy={pending}>
        <CardHeader>
          <CardTitle>Connect to {SOURCE_LABELS[source]}</CardTitle>
          <CardDescription>{apiKeyConnectDescription(source)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="api-key">{credentialLabel}</Label>
          <Input
            id="api-key"
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={
              source === "convertkit"
                ? "ck_..."
                : source === "activecampaign"
                  ? "ActiveCampaign API token"
                  : source === "mailerlite"
                    ? "MailerLite API token"
                    : source === "hubspot"
                      ? "HubSpot Service Key or existing access token"
                      : source === "klaviyo"
                        ? "pk_..."
                        : source === "customerio"
                          ? "Customer.io App API key"
                          : "key..."
            }
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              clearConnectionError();
            }}
            required
          />
          {source === "activecampaign" && (
            <div className="space-y-2 pt-2">
              <Label htmlFor="account-id">Account API URL</Label>
              <Input
                id="account-id"
                type="text"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="https://youraccount.api-us1.com/api/3"
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  clearConnectionError();
                }}
                aria-invalid={Boolean(
                  accountId.trim() && activeCampaignUrlError,
                )}
                aria-describedby="activecampaign-api-url-help"
                required
              />
              <p
                id="activecampaign-api-url-help"
                className={
                  accountId.trim() && activeCampaignUrlError
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                {accountId.trim() && activeCampaignUrlError
                  ? activeCampaignUrlError
                  : "Use the exact HTTPS account URL shown in Settings - Developer. Built-in ActiveCampaign hosts work by default; other provider-issued hosts must be authorized by this Moosewave deployment. Moosewave binds the job to the account returned by ActiveCampaign."}
              </p>
            </div>
          )}
          {source === "hubspot" && (
            <div className="space-y-2 pt-2">
              <Label htmlFor="account-id">Hub ID (optional)</Label>
              <Input
                id="account-id"
                autoComplete="off"
                inputMode="numeric"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={64}
                placeholder="12345678"
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  clearConnectionError();
                }}
                aria-invalid={Boolean(
                  accountId.trim() && hubSpotHubIDValidationError,
                )}
                aria-describedby="hubspot-hub-id-help"
              />
              <p
                id="hubspot-hub-id-help"
                className={
                  accountId.trim() && hubSpotHubIDValidationError
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                {accountId.trim() && hubSpotHubIDValidationError ? (
                  hubSpotHubIDValidationError
                ) : (
                  <>
                    Create a key in HubSpot under Development → Keys → Service keys.
                    You need Super admin or Developer tools permission. Existing
                    private app tokens also work. Required reads: <code>crm.objects.contacts.read</code>,{" "}
                    <code>crm.schemas.contacts.read</code>,{" "}
                    <code>crm.lists.read</code>,{" "}
                    <code>subscriptions-definition-read</code>, and{" "}
                    <code>subscriptions-status-read</code>, plus access to
                    2026-03 account details and private-app daily usage.
                    Enterprise batch subscription scopes are not required.
                    Moosewave imports exact per-type and wide email preferences
                    plus conservative current-primary-email eligibility. Enabled
                    requires all active definitions <code>SUBSCRIBED</code> with
                    no wide/scoped opt-out, hard-bounce, quarantine,
                    invalid-address, marketing-contact, double-opt-in, or
                    legacy-opt-out restriction. This is not exact HubSpot
                    sendability parity. HubSpot stays the CRM system of record.
                  </>
                )}
              </p>
            </div>
          )}
          {source === "beehiiv" && (
            <div className="space-y-2 pt-2">
              <Label htmlFor="account-id">
                Publication ID (optional for a single-publication workspace)
              </Label>
              <Input
                id="account-id"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="pub_..."
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  clearConnectionError();
                }}
              />
              <p className="text-xs text-muted-foreground">
                If this API key can access multiple publications, enter the
                intended <code>pub_...</code> ID. The current flow does not
                provide a publication chooser and will fail closed when this
                selection is ambiguous.
              </p>
            </div>
          )}
          {source === "klaviyo" && (
            <div className="space-y-2 pt-2">
              <Label htmlFor="account-id">Account ID (optional)</Label>
              <Input
                id="account-id"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="Klaviyo account ID"
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  clearConnectionError();
                }}
              />
              <p className="text-xs text-muted-foreground">
                Leave this blank to use the account returned by Klaviyo. If
                supplied, it must match that authenticated account; reconnect
                and cutover remain bound to the same account.
              </p>
            </div>
          )}
          {source === "customerio" && (
            <div className="grid gap-3 pt-2 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="account-id">
                  Workspace ID (optional for one workspace)
                </Label>
                <Input
                  id="account-id"
                  autoComplete="off"
                  inputMode="numeric"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={64}
                  placeholder="Customer.io workspace ID"
                  value={accountId}
                  onChange={(e) => {
                    setAccountId(e.target.value);
                    clearConnectionError();
                  }}
                  aria-invalid={Boolean(
                    accountId.trim() && customerIOWorkspaceError,
                  )}
                  aria-describedby="customerio-workspace-id-help"
                />
                <p
                  id="customerio-workspace-id-help"
                  className={
                    accountId.trim() && customerIOWorkspaceError
                      ? "text-xs text-destructive"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {accountId.trim() && customerIOWorkspaceError
                    ? customerIOWorkspaceError
                    : "Required when the App API key exposes multiple workspaces. Moosewave fails closed instead of selecting by list order and binds reconnect, delta, shadow, and rollback evidence to the exact workspace."}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="customerio-region">App API region</Label>
                <Select
                  id="customerio-region"
                  value={customerIORegion}
                  onChange={(event) => {
                    setCustomerIORegion(event.target.value as "us" | "eu");
                    clearConnectionError();
                  }}
                >
                  <option value="us">United States (api.customer.io)</option>
                  <option value="eu">
                    European Union (api-eu.customer.io)
                  </option>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Region is part of the immutable workspace binding; reconnect
                  cannot switch an existing migration between US and EU.
                </p>
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            The migration service validates the {credentialLabel} before
            discovery starts.
          </p>
          {connectionError ? (
            <p
              ref={errorRef}
              id="migration-api-connection-error"
              role="alert"
              tabIndex={-1}
              className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm text-foreground outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {connectionError}
            </p>
          ) : null}
        </CardContent>
        <CardFooter>
          <Button
            type="submit"
            className="w-full sm:w-auto"
            disabled={!canSubmit}
            loading={pending}
            aria-describedby={
              connectionError ? "migration-api-connection-error" : undefined
            }
          >
            {pending ? "Validating credentials…" : "Connect"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export function apiKeyConnectCanSubmit(
  source: SourcePlatform,
  apiKey: string,
  accountId: string,
): boolean {
  if (!apiKey.trim()) return false;
  if (source === "activecampaign") {
    return activeCampaignApiUrlError(accountId) === null;
  }
  if (source === "customerio") {
    return customerIOWorkspaceIDError(accountId) === null;
  }
  if (source === "hubspot") {
    return hubSpotHubIDError(accountId) === null;
  }
  return true;
}

export function hubSpotHubIDError(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  return /^\d{1,64}$/u.test(normalized)
    ? null
    : "Hub ID must contain 1 to 64 digits.";
}

function apiKeyConnectDescription(source: SourcePlatform): string {
  if (source === "activecampaign") {
    return "Paste the trusted account API URL and token from ActiveCampaign Developer settings. Use a dedicated migration user; the validated provider account is bound to this job through reconnect and cutover.";
  }
  if (source === "hubspot") {
    return "Paste a HubSpot Service Key or existing private app token with contact, property-schema, list, subscription-definition, subscription-status, account-details, and API-usage read access.";
  }
  if (source === "klaviyo") {
    return "Paste a Klaviyo private API key with read access to accounts, profiles, lists, segments, flows, campaigns, templates, and forms. The key is validated and encrypted; Klaviyo flows are preserved for rebuild review, not activated as Moosewave runtime automations.";
  }
  if (source === "customerio") {
    return "Paste a dedicated Customer.io App API key, not a Track API site key. Moosewave validates the selected US/EU workspace and imports email-addressable profiles by immutable cio_id. Email enablement is conservative: global subscribed, resolved email-channel subscribed/default, and the applicable topic subscribed/default must all allow it; ESP suppressions still block. Sender-specific SMS/WhatsApp /v1/optouts remain separate non-email evidence. Segment, automation, channel-runtime, and ecosystem gaps stay explicit, and no Customer.io automation is activated automatically.";
  }
  if (source === "mailerlite") {
    return "Paste a dedicated token from MailerLite → Integrations → MailerLite API. Moosewave preserves suppression state, custom-field definitions and values, group memberships, and draft/ready campaign rebuild records; saved segments and automations remain rebuild-review evidence, and rendered campaign HTML is not exposed by MailerLite's documented read API. Freeze the source before commit and revoke the token after verification.";
  }
  return `Paste a ${SOURCE_LABELS[source]} API key. Read-only scope is sufficient.`;
}

export { activeCampaignApiUrlError };

function CsvConnect({
  source,
  onConnected,
  authorityKey,
  beforeWrite,
}: {
  source: SourcePlatform;
  onConnected: (jobId: string) => void;
  authorityKey: string;
  beforeWrite: (signal?: AbortSignal) => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState("");
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<number>(0);
  const [dragging, setDragging] = useState(false);
  // Confirm-columns step (MIGR-023): once a CSV is chosen we read its header
  // row in the browser so the user can see the detected columns and pick the
  // email column before anything is uploaded.
  const [headers, setHeaders] = useState<string[] | null>(null);
  const [emailColumn, setEmailColumn] = useState<number>(-1);
  const [parsing, setParsing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadBusyRef = useRef(false);
  const uploadControllerRef = useRef<AbortController | null>(null);
  const fileErrorRef = useRef<HTMLParagraphElement>(null);
  // Monotonic id for the current file selection — see chooseFile.
  const selectionRef = useRef(0);

  useEffect(() => {
    if (fileError) fileErrorRef.current?.focus();
  }, [fileError]);

  useEffect(
    () => () => {
      selectionRef.current += 1;
      uploadControllerRef.current?.abort();
      uploadControllerRef.current = null;
      uploadBusyRef.current = false;
    },
    [],
  );

  const isCsvFile = (f: File) => /\.csv$/iu.test(f.name.trim());

  const resetConfirm = () => {
    setHeaders(null);
    setEmailColumn(-1);
  };

  const chooseFile = async (next: File | null) => {
    if (uploadBusyRef.current) return;
    // Each selection claims a token. The header parse below is async, so
    // picking a second file before the first finishes would otherwise let the
    // slower parse land last — pairing one file's headers (and the email
    // column index validated against them) with a different file's upload.
    const token = ++selectionRef.current;
    setFileError("");
    resetConfirm();
    // A newer non-CSV/empty/invalid selection must also cancel the visible
    // parsing state. The older parse's `finally` intentionally cannot do that
    // after its token becomes stale.
    setParsing(false);
    if (!next) {
      setFile(null);
      return;
    }
    const selectionError = migrationFileSelectionError(source, next);
    if (selectionError) {
      setFile(null);
      setFileError(selectionError);
      return;
    }
    setFile(next);
    // Only CSVs have a readable header row; a Substack ZIP goes straight to
    // upload without a column-confirm step.
    if (isCsvFile(next)) {
      setParsing(true);
      try {
        // Read only the first slice — enough for the header line — so a large
        // export never has to be fully loaded into memory here.
        const slice = await next.slice(0, 64 * 1024).text();
        if (token !== selectionRef.current) return;
        const parsed = parseCsvHeaderRow(extractHeaderLine(slice));
        if (parsed.length === 0) {
          setFile(null);
          setFileError("No columns were detected in this CSV file.");
          return;
        }
        if (parsed.length > MAX_MIGRATION_CSV_COLUMNS) {
          setFile(null);
          setFileError(
            `This CSV has ${parsed.length.toLocaleString()} columns. Reduce it to ${MAX_MIGRATION_CSV_COLUMNS.toLocaleString()} columns or fewer before uploading.`,
          );
          return;
        }
        setHeaders(parsed);
        setEmailColumn(detectEmailColumn(parsed));
      } catch {
        if (token === selectionRef.current) {
          setFile(null);
          resetConfirm();
          setFileError(
            "We couldn't read this CSV's columns. Export it again or choose a different file.",
          );
        }
      } finally {
        if (token === selectionRef.current) setParsing(false);
      }
    }
  };

  const handleUseFile = async () => {
    if (!file || uploadBusyRef.current) return;
    const intent = {
      source,
      file,
      headers: headers ? [...headers] : null,
      emailColumn,
    } as const;
    const selectionError = migrationFileSelectionError(
      intent.source,
      intent.file,
    );
    if (selectionError) {
      setFileError(selectionError);
      return;
    }
    if (intent.headers) {
      const validation = validateCsvColumns(intent.headers, intent.emailColumn);
      if (!validation.ok) {
        setFileError(validation.error ?? "Choose the email column first.");
        return;
      }
    }
    uploadBusyRef.current = true;
    const controller = new AbortController();
    uploadControllerRef.current = controller;
    setPending(true);
    setProgress(0);
    setFileError("");
    try {
      await beforeWrite(controller.signal);
      controller.signal.throwIfAborted();
      const res = await uploadMigrationFile(
        intent.source,
        intent.file,
        (p) => {
          if (controller.signal.aborted) return;
          setProgress(
            Math.round((p.uploadedBytes / Math.max(1, p.totalBytes)) * 100),
          );
        },
        {
          signal: controller.signal,
          scopeKey: authorityKey,
        },
      );
      controller.signal.throwIfAborted();
      toast.success("File accepted");
      onConnected(res.job_id);
    } catch (err) {
      if (controller.signal.aborted) return;
      const message =
        err instanceof Error
          ? err.message
          : "Upload storage is not configured for this environment.";
      setFileError(message);
      toast.error(
        source === "substack"
          ? "Substack export upload unavailable"
          : "CSV upload unavailable",
        {
          description: message,
        },
      );
    } finally {
      if (uploadControllerRef.current === controller) {
        uploadControllerRef.current = null;
        uploadBusyRef.current = false;
        if (!controller.signal.aborted) {
          setPending(false);
          setProgress(0);
        }
      }
    }
  };

  // ── Confirm-columns view ────────────────────────────────────────────────
  if (headers && file) {
    const validation = validateCsvColumns(headers, emailColumn);
    const previewIndexes = Array.from(
      { length: Math.min(headers.length, MAX_CSV_HEADER_CHIPS) },
      (_, index) => index,
    );
    if (
      emailColumn >= MAX_CSV_HEADER_CHIPS &&
      !previewIndexes.includes(emailColumn)
    ) {
      previewIndexes.push(emailColumn);
    }
    return (
      <Card>
        <CardHeader>
          <CardTitle>Confirm columns</CardTitle>
          <CardDescription>
            We detected {headers.length} column
            {headers.length === 1 ? "" : "s"} in{" "}
            <span className="font-medium [overflow-wrap:anywhere]">
              {file.name}
            </span>
            . Pick the column that holds each subscriber&apos;s email address
            before we import.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="csv-email-column">Email column</Label>
            <Select
              id="csv-email-column"
              value={emailColumn}
              onChange={(e) => setEmailColumn(Number(e.target.value))}
              aria-invalid={!validation.ok}
              aria-describedby="csv-email-column-help"
            >
              <option value={-1}>Select the email column…</option>
              {headers.map((h, i) => (
                <option key={`${h}-${i}`} value={i}>
                  {h || `Column ${i + 1} (unnamed)`}
                </option>
              ))}
            </Select>
            {!validation.ok ? (
              <p
                id="csv-email-column-help"
                role="alert"
                className="text-sm text-destructive"
              >
                {validation.error}
              </p>
            ) : (
              <p
                id="csv-email-column-help"
                className="text-xs text-muted-foreground"
              >
                Remaining columns are preserved as subscriber attributes.
              </p>
            )}
          </div>
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">
              Detected columns
            </p>
            <div className="flex flex-wrap gap-1.5">
              {previewIndexes.map((i) => (
                <span
                  key={`chip-${headers[i]}-${i}`}
                  className={
                    i === emailColumn
                      ? "max-w-full rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary [overflow-wrap:anywhere]"
                      : "max-w-full rounded-full border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]"
                  }
                >
                  {headers[i] || `Column ${i + 1}`}
                  {i === emailColumn ? " · email" : ""}
                </span>
              ))}
            </div>
            {headers.length > previewIndexes.length ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {(headers.length - previewIndexes.length).toLocaleString()} more
                columns are available in the email column picker.
              </p>
            ) : null}
          </div>
          {fileError ? (
            <p
              ref={fileErrorRef}
              role="alert"
              tabIndex={-1}
              className="text-sm text-destructive outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {fileError}
            </p>
          ) : null}
          {pending && progress > 0 ? (
            <div>
              <Progress value={progress} aria-label="Migration file upload" />
              <p className="mt-1 text-xs text-muted-foreground">
                Uploading {progress}%
              </p>
            </div>
          ) : null}
        </CardContent>
        <CardFooter className="flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Button
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={() => {
              setFile(null);
              resetConfirm();
              setFileError("");
            }}
            disabled={pending}
          >
            <ArrowLeft className="h-4 w-4" /> Choose a different file
          </Button>
          <Button
            className="w-full sm:w-auto"
            onClick={handleUseFile}
            disabled={!validation.ok}
            loading={pending}
          >
            {pending ? "Uploading…" : "Continue"}
            {!pending ? <ArrowRight className="h-4 w-4" /> : null}
          </Button>
        </CardFooter>
      </Card>
    );
  }

  // ── Choose-file view ────────────────────────────────────────────────────
  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload {SOURCE_LABELS[source]} export</CardTitle>
        <CardDescription>
          {source === "substack"
            ? "Upload the untouched official Substack ZIP (preferred) or one All columns subscriber CSV. We find the subscriber list and email-sent post archive; signup dates stay provenance, active rows stay unconfirmed, and live Stripe/Apple billing is a separate provider handoff."
            : "Drop a CSV with at minimum an `email` column, or click to choose one."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          role="button"
          tabIndex={pending ? -1 : 0}
          aria-label="Choose or drop a file to upload"
          aria-describedby={fileError ? "migration-file-error" : undefined}
          aria-disabled={pending}
          aria-busy={parsing || pending}
          onClick={() => {
            if (!pending) inputRef.current?.click();
          }}
          onKeyDown={(e) => {
            if (!pending && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!pending) void chooseFile(e.dataTransfer.files?.[0] ?? null);
          }}
          className={
            "min-h-44 cursor-pointer rounded-xl border-2 border-dashed p-6 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:p-8 " +
            (dragging ? "border-primary bg-accent/60" : "hover:bg-accent/50")
          }
        >
          <FileUp className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-2 text-sm">
            {parsing ? (
              "Reading columns…"
            ) : file ? (
              <span className="[overflow-wrap:anywhere]">{file.name}</span>
            ) : (
              "Drop a file here or click to choose"
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            CSV{source === "substack" ? " or ZIP" : ""}, up to 200 MB
          </p>
          {fileError ? (
            <p
              ref={fileErrorRef}
              id="migration-file-error"
              role="alert"
              tabIndex={-1}
              className="mt-2 text-sm text-destructive outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {fileError}
            </p>
          ) : null}
          {pending && progress > 0 ? (
            <div className="mt-4">
              <Progress value={progress} aria-label="Migration file upload" />
              <p className="mt-1 text-xs text-muted-foreground">
                Uploading {progress}%
              </p>
            </div>
          ) : null}
          <input
            ref={inputRef}
            type="file"
            accept={source === "substack" ? ".zip,.csv" : ".csv"}
            className="hidden"
            disabled={pending}
            onClick={(event) => event.stopPropagation()}
            onChange={(e) => {
              const selected = e.target.files?.[0] ?? null;
              // Clearing the native value lets users re-select the same file
              // after fixing an export without needing a different filename.
              e.target.value = "";
              void chooseFile(selected);
            }}
          />
        </div>
      </CardContent>
      <CardFooter>
        <Button
          className="w-full sm:w-auto"
          onClick={handleUseFile}
          disabled={!file || parsing}
          loading={pending}
        >
          {pending ? "Uploading…" : "Use this file"}
        </Button>
      </CardFooter>
    </Card>
  );
}
