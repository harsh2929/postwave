// SPDX-License-Identifier: AGPL-3.0-only
//
// Live jq transform tester (INTG-004). Posts the jq expression + a sample
// payload to POST /api/v1/inbound-webhooks/transform/preview and shows the
// transformed body — or an operator-safe error — inline, so users don't author
// jq blind. Reused by the create form and the endpoint-edit dialog. All output
// is rendered as escaped text in a <pre> (never as HTML).
"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import { previewInboundTransform } from "@/lib/inbound-webhooks-api";
import {
  canAdminInboundWebhooks,
  INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE,
  verifyFreshInboundWebhookAdmin,
} from "@/lib/inbound-webhook-authority";
import { boundPreview, prettyJsonValue } from "@/lib/json-preview";

const SAMPLE_DEFAULT = `{
  "form_response": {
    "answers": [{ "email": "person@example.com" }]
  }
}`;

export function TransformTester({
  transformJQ,
  identity,
}: {
  transformJQ: string;
  identity: MeResponse;
}) {
  const sampleId = useId();
  const [sample, setSample] = useState(SAMPLE_DEFAULT);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const testingGuard = useRef(false);
  const requestVersion = useRef(0);
  const canAdmin = canAdminInboundWebhooks(identity);

  useEffect(() => {
    requestVersion.current += 1;
    setResult(null);
    setError(null);
  }, [transformJQ]);

  useEffect(() => {
    requestVersion.current += 1;
    setResult(null);
    setError(null);
  }, [
    identity.effective_role,
    identity.role,
    identity.tenant_id,
    identity.user_id,
    identity.viewer_mode,
  ]);

  async function onTest() {
    if (testingGuard.current) return;
    if (!canAdmin) {
      setError(INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
      return;
    }
    testingGuard.current = true;
    const version = ++requestVersion.current;
    setTesting(true);
    setError(null);
    setResult(null);
    let body: unknown = {};
    if (sample.trim()) {
      try {
        body = JSON.parse(sample);
      } catch (e) {
        setError(
          `Sample payload is not valid JSON: ${e instanceof Error ? e.message : "parse error"}`,
        );
        testingGuard.current = false;
        setTesting(false);
        return;
      }
    }
    try {
      await verifyFreshInboundWebhookAdmin(identity);
      const res = await previewInboundTransform({
        transform_jq: transformJQ,
        body,
      });
      if (requestVersion.current === version) {
        setResult(boundPreview(prettyJsonValue(res.body)));
      }
    } catch (e) {
      if (requestVersion.current === version) {
        setError(apiErrorMessage(e, "Transform failed"));
      }
    } finally {
      testingGuard.current = false;
      setTesting(false);
    }
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border bg-muted/30 p-3">
      <Label htmlFor={sampleId} className="text-xs">
        Sample payload (JSON)
      </Label>
      <Textarea
        id={sampleId}
        value={sample}
        onChange={(e) => {
          requestVersion.current += 1;
          setSample(e.target.value);
          setResult(null);
          setError(null);
        }}
        rows={4}
        className="font-mono text-base sm:text-xs"
        spellCheck={false}
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void onTest()}
          disabled={!transformJQ.trim() || !canAdmin}
          loading={testing}
          className="min-h-11 w-full sm:min-h-8 sm:w-auto"
          title={
            !canAdmin
              ? INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE
              : !transformJQ.trim()
                ? "Enter a jq expression first"
                : undefined
          }
        >
          {testing ? "Testing…" : "Test transform"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Runs your jq against the sample, exactly as live events would.
        </span>
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {result !== null ? (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Result
          </div>
          <pre
            tabIndex={0}
            aria-label="Transformed sample payload"
            className="max-h-64 overflow-auto rounded bg-background p-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {result}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
