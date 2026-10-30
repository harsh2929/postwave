// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  FlaskConical,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";

import {
  DataSection,
  DataSurfaceHeader,
  DataSurfaceShell,
  QueryError,
  SectionSkeleton,
} from "@/components/integrations/data-surface";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  SAMPLE_CDP_OPERATIONS,
  SAMPLE_CDP_PROPERTIES,
  formatTransformJSON,
  formatTransformValue,
  getCDPTransformOperations,
  parseTransformDraft,
  previewCDPTransforms,
  type CDPTransformOperation,
  type CDPTransformPreview,
} from "@/lib/cdp-transform-preview-api";
import { qk, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

const ARGUMENT_GUIDANCE: Record<string, string> = {
  truncate: 'args: { "max": 80 }',
  default_value: 'args: { "value": "Unknown" }',
  phone_e164: 'args: { "default_country_code": "1" }',
  regex_replace: 'args: { "pattern": "...", "replacement": "..." }',
};

function operationTemplate(type: string): CDPTransformOperation {
  switch (type) {
    case "truncate":
      return { type, field: "", args: { max: 80 } };
    case "default_value":
      return { type, field: "", args: { value: "" } };
    case "phone_e164":
      return { type, field: "", args: { default_country_code: "1" } };
    case "regex_replace":
      return { type, field: "", args: { pattern: "", replacement: "" } };
    default:
      return { type, field: "" };
  }
}

export function CDPTransformPreviewClient() {
  const queryClient = useQueryClient();
  const identityQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });
  const identity = identityQuery.data;
  const role = identity ? effectiveAuthRole(identity) : null;
  const canPreview = Boolean(
    identity && roleCanWrite(role) && identity.viewer_mode !== true,
  );
  const catalogKey = useMemo(
    () =>
      [
        "cdp-transform-operation-catalog",
        identity?.tenant_id ?? "unverified",
        role,
      ] as const,
    [identity?.tenant_id, role],
  );
  const catalogQuery = useQuery({
    queryKey: catalogKey,
    queryFn: ({ signal }) => getCDPTransformOperations({ signal }),
    staleTime: STALE.reference,
    retry: false,
    enabled: Boolean(identity),
  });
  const catalog = Array.isArray(catalogQuery.data) ? catalogQuery.data : [];
  const [propertiesText, setPropertiesText] = useState(SAMPLE_CDP_PROPERTIES);
  const [operationsText, setOperationsText] = useState(SAMPLE_CDP_OPERATIONS);
  const [propertiesError, setPropertiesError] = useState<string | null>(null);
  const [operationsError, setOperationsError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CDPTransformPreview | null>(null);
  const [previewStale, setPreviewStale] = useState(false);
  const [pending, setPending] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const revisionRef = useRef(0);
  const requestRef = useRef<Promise<void> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const operationsEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const dirty =
    propertiesText !== SAMPLE_CDP_PROPERTIES ||
    operationsText !== SAMPLE_CDP_OPERATIONS;
  useUnsavedChangesGuard(dirty || pending);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      requestRef.current = null;
    },
    [],
  );

  function markEdited() {
    revisionRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestRef.current = null;
    setPending(false);
    setPreviewError(null);
    if (preview) setPreviewStale(true);
  }

  function changeProperties(value: string) {
    setPropertiesText(value);
    setPropertiesError(null);
    markEdited();
  }

  function changeOperations(value: string) {
    setOperationsText(value);
    setOperationsError(null);
    markEdited();
  }

  function formatEditor(kind: "properties" | "operations") {
    try {
      if (kind === "properties") {
        setPropertiesText(formatTransformJSON(propertiesText, kind));
        setPropertiesError(null);
      } else {
        setOperationsText(formatTransformJSON(operationsText, kind));
        setOperationsError(null);
      }
      markEdited();
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "JSON could not be formatted.";
      if (kind === "properties") setPropertiesError(message);
      else setOperationsError(message);
    }
  }

  function appendOperation(type: string) {
    let current: unknown;
    try {
      current = JSON.parse(operationsText) as unknown;
    } catch {
      setOperationsError(
        "Fix the current operations JSON before appending another operation.",
      );
      return;
    }
    if (!Array.isArray(current)) {
      setOperationsError(
        "Operations must be a JSON array before another operation can be appended.",
      );
      return;
    }
    const next = JSON.stringify([...current, operationTemplate(type)], null, 2);
    setOperationsText(next);
    setOperationsError(null);
    markEdited();
    requestAnimationFrame(() => {
      operationsEditorRef.current?.focus();
      const length = operationsEditorRef.current?.value?.length ?? 0;
      operationsEditorRef.current?.setSelectionRange(length, length);
    });
  }

  function resetDraft() {
    revisionRef.current += 1;
    controllerRef.current?.abort();
    setPropertiesText(SAMPLE_CDP_PROPERTIES);
    setOperationsText(SAMPLE_CDP_OPERATIONS);
    setPropertiesError(null);
    setOperationsError(null);
    setPreviewError(null);
    setPreview(null);
    setPreviewStale(false);
    setPending(false);
  }

  async function runPreview() {
    if (!identity || !canPreview || pending || requestRef.current) return;
    const local = parseTransformDraft(propertiesText, operationsText, catalog);
    setPropertiesError(local.propertiesError);
    setOperationsError(local.operationsError);
    if (!local.properties || !local.operations) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    const revision = revisionRef.current;
    setPending(true);
    setPreviewError(null);
    const request = (async () => {
      try {
        const freshIdentity = await verifyFreshAdminAuthority(
          identity,
          controller.signal,
        );
        const freshCatalog = await getCDPTransformOperations({
          fresh: true,
          signal: controller.signal,
        });
        if (freshIdentity.tenant_id !== identity.tenant_id) {
          throw new Error("Workspace identity changed. No preview was sent.");
        }
        queryClient.setQueryData(catalogKey, freshCatalog);
        const reviewed = parseTransformDraft(
          propertiesText,
          operationsText,
          freshCatalog,
        );
        if (!reviewed.properties || !reviewed.operations) {
          setPropertiesError(reviewed.propertiesError);
          setOperationsError(reviewed.operationsError);
          return;
        }
        const result = await previewCDPTransforms(
          {
            properties: reviewed.properties,
            operations: reviewed.operations,
          },
          controller.signal,
        );
        if (controller.signal.aborted || revision !== revisionRef.current)
          return;
        setPreview(result);
        setPreviewStale(false);
      } catch (caught) {
        if (controller.signal.aborted || revision !== revisionRef.current)
          return;
        setPreviewError(
          caught instanceof Error
            ? caught.message
            : "The transform preview could not be completed.",
        );
      }
    })().finally(() => {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (requestRef.current === request) requestRef.current = null;
      if (revision === revisionRef.current) setPending(false);
    });
    requestRef.current = request;
    await request;
  }

  if (identityQuery.isPending || identityQuery.isError || !identity) {
    return (
      <DataSurfaceShell className="max-w-7xl">
        <DataSurfaceHeader
          icon={FlaskConical}
          eyebrow="Data platform · Non-persistent laboratory"
          title="CDP transform preview"
          description="Compose registered property operations against sample JSON and inspect the exact dry-run trace. This surface never applies a transform to a subscriber or pipeline."
        />
        {identityQuery.isPending ? (
          <SectionSkeleton rows={4} />
        ) : (
          <QueryError
            title="Workspace identity could not be verified"
            description="No transform catalog or preview data was requested without a verified workspace context."
            onRetry={() => void identityQuery.refetch()}
          />
        )}
      </DataSurfaceShell>
    );
  }

  return (
    <DataSurfaceShell className="max-w-7xl">
      <DataSurfaceHeader
        icon={FlaskConical}
        eyebrow="Data platform · Non-persistent laboratory"
        title="CDP transform preview"
        description="Compose operations from the server's registered catalog, send one bounded sample property object, and inspect every operation's exact before/after outcome. Preview is pure and does not save, apply, schedule, or activate anything."
        actions={
          <Button asChild variant="outline">
            <Link href="/app/warehouse">
              <ArrowLeft aria-hidden /> Data warehouse
            </Link>
          </Button>
        }
      />

      <Alert>
        <ShieldAlert aria-hidden />
        <AlertTitle>Treat sample JSON as transmitted data</AlertTitle>
        <AlertDescription>
          Preview input is sent to the current Moosewave API for in-memory
          processing. Avoid secrets, credentials, and unnecessary personal data;
          normal infrastructure request logging may still apply. This lab does
          not call the mounted bulk-apply endpoint.
        </AlertDescription>
      </Alert>

      {!canPreview ? (
        <Alert>
          <AlertTitle>Preview execution is admin-scoped</AlertTitle>
          <AlertDescription>
            Your effective {role} role can inspect the registered catalog and
            compose a local draft. Only an owner or admin outside viewer mode
            can transmit the preview request.
          </AlertDescription>
        </Alert>
      ) : null}

      <DataSection
        id="cdp-transform-catalog"
        title="Registered operation catalog"
        description="This list is discovered from the current server. A fresh copy is checked again immediately before every preview."
        aside={
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={catalogQuery.isFetching}
            disabled={pending}
            onClick={() => void catalogQuery.refetch()}
          >
            <RefreshCw aria-hidden /> Refresh
          </Button>
        }
      >
        {catalogQuery.isPending ? (
          <SectionSkeleton rows={2} />
        ) : catalogQuery.isError ? (
          <QueryError
            title="Transform operation catalog could not be verified"
            description="Preview remains disabled because operation names cannot be checked against the current server."
            onRetry={() => void catalogQuery.refetch()}
          />
        ) : catalog.length === 0 ? (
          <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
            The server returned a valid but empty operation catalog. No preview
            can be composed from verified operations.
          </p>
        ) : (
          <div className="space-y-3">
            <div
              className="flex flex-wrap gap-2"
              aria-label="Registered CDP transform operations"
            >
              {catalog.map((operation) => (
                <Button
                  key={operation}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  aria-label={`Append ${operation} transform operation`}
                  onClick={() => appendOperation(operation)}
                >
                  <Plus aria-hidden />{" "}
                  <span className="font-mono">{operation}</span>
                </Button>
              ))}
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              Argument-bearing operations:{" "}
              {Object.entries(ARGUMENT_GUIDANCE)
                .map(([name, guidance]) => `${name} (${guidance})`)
                .join(" · ")}
            </p>
          </div>
        )}
      </DataSection>

      <div className="grid min-w-0 gap-6 xl:grid-cols-2">
        <DataSection
          id="cdp-transform-input"
          title="1. Compose a bounded sample"
          description="Both editors are parsed and structurally validated in the browser before transport. Dotted field paths are supported."
          aside={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => (dirty ? setResetOpen(true) : resetDraft())}
            >
              <RotateCcw aria-hidden /> Reset sample
            </Button>
          }
        >
          <div className="space-y-5" aria-busy={pending || undefined}>
            <JSONEditor
              id="cdp-properties-json"
              label="Input properties (JSON object)"
              value={propertiesText}
              error={propertiesError}
              onChange={changeProperties}
              onFormat={() => formatEditor("properties")}
            />
            <JSONEditor
              id="cdp-operations-json"
              label="Operations (JSON array)"
              value={operationsText}
              error={operationsError}
              editorRef={operationsEditorRef}
              onChange={changeOperations}
              onFormat={() => formatEditor("operations")}
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">
                Server-side pure dry run · operation-level counts · no
                persistence
              </p>
              <Button
                type="button"
                loading={pending}
                disabled={
                  pending ||
                  !canPreview ||
                  catalogQuery.isError ||
                  catalog.length === 0
                }
                onClick={() => void runPreview()}
              >
                <Play aria-hidden />{" "}
                {canPreview ? "Run preview" : "Admin required"}
              </Button>
            </div>
          </div>
        </DataSection>

        <DataSection
          id="cdp-transform-output"
          title="2. Inspect exact response evidence"
          description="The decoder reconciles counters, result order, and every echoed operation against the reviewed request."
          aside={
            previewStale ? (
              <Badge variant="warning">Inputs changed</Badge>
            ) : undefined
          }
        >
          <PreviewOutput
            pending={pending}
            error={previewError}
            preview={preview}
            stale={previewStale}
            onRetry={() => void runPreview()}
          />
        </DataSection>
      </div>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset the local transform draft?"
        description="Both JSON editors and the current preview evidence will return to the documented sample. Nothing on the server is changed."
        confirmLabel="Reset draft"
        confirmationToken="RESET DRAFT"
        onConfirm={resetDraft}
      />
    </DataSurfaceShell>
  );
}

function JSONEditor({
  id,
  label,
  value,
  error,
  editorRef,
  onChange,
  onFormat,
}: {
  id: string;
  label: string;
  value: string;
  error: string | null;
  editorRef?: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onFormat: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <Button type="button" variant="ghost" size="sm" onClick={onFormat}>
          Format JSON
        </Button>
      </div>
      <Textarea
        ref={editorRef}
        id={id}
        className="min-h-64 resize-y font-mono text-xs leading-5"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        value={value}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function PreviewOutput({
  pending,
  error,
  preview,
  stale,
  onRetry,
}: {
  pending: boolean;
  error: string | null;
  preview: CDPTransformPreview | null;
  stale: boolean;
  onRetry: () => void;
}) {
  if (pending) return <SectionSkeleton rows={5} />;
  if (error) {
    return (
      <QueryError
        title="Transform preview could not be verified"
        description={error}
        onRetry={onRetry}
      />
    );
  }
  if (!preview) {
    return (
      <div className="rounded-lg border border-dashed px-5 py-10 text-center">
        <FlaskConical
          className="mx-auto size-7 text-muted-foreground"
          aria-hidden
        />
        <p className="mt-3 text-sm font-medium">
          Ready for a non-persistent preview
        </p>
        <p className="mx-auto mt-1 max-w-md text-sm leading-5 text-muted-foreground">
          Run the sample to receive transformed properties and one reconciled
          result row for every requested operation.
        </p>
      </div>
    );
  }
  return (
    <div className={stale ? "space-y-5 opacity-65" : "space-y-5"}>
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3"
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-4 text-success" aria-hidden />
          <strong className="text-sm">
            {preview.success} operation(s) succeeded · {preview.failed} failed
          </strong>
        </div>
        <Badge variant={preview.failed === 0 ? "success" : "warning"}>
          {preview.failed === 0 ? "Preview passed" : "Review failures"}
        </Badge>
      </div>
      {stale ? (
        <Alert>
          <AlertTitle>These results belong to the previous input</AlertTitle>
          <AlertDescription>
            Run preview again before relying on this evidence.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Resulting properties
        </p>
        <pre
          tabIndex={0}
          role="region"
          aria-label="Scrollable transformed properties JSON"
          className="max-h-80 overflow-auto rounded-lg border bg-background p-3 text-xs leading-5"
        >
          <code>{JSON.stringify(preview.properties, null, 2)}</code>
        </pre>
      </div>
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Operation trace
        </p>
        <div
          tabIndex={0}
          role="region"
          aria-label="Scrollable transform operation trace"
          className="overflow-x-auto rounded-lg border"
        >
          <table className="w-full min-w-[44rem] text-left text-sm">
            <caption className="sr-only">
              Per-operation CDP transform preview results
            </caption>
            <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="p-3">
                  Operation
                </th>
                <th scope="col" className="p-3">
                  Before
                </th>
                <th scope="col" className="p-3">
                  After
                </th>
                <th scope="col" className="p-3">
                  Result
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {preview.results.map((result, index) => (
                <tr key={`${result.op.type}-${result.op.field}-${index}`}>
                  <td className="p-3 font-mono text-xs">
                    {result.op.type}({result.op.field})
                  </td>
                  <td className="max-w-52 break-all p-3 font-mono text-xs text-muted-foreground">
                    {formatTransformValue(result.oldValue)}
                  </td>
                  <td className="max-w-52 break-all p-3 font-mono text-xs">
                    {formatTransformValue(result.newValue)}
                  </td>
                  <td className="p-3">
                    {result.error ? (
                      <span className="break-words text-destructive">
                        {result.error}
                      </span>
                    ) : result.changed ? (
                      <Badge variant="success">Changed</Badge>
                    ) : (
                      <Badge variant="secondary">No change</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
