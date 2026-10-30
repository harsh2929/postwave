// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * CustomerAgentPanel — release truth for the source-held draft foundation.
 * Desktop parity messaging-51
 * (apps/desktop/src/components/helpdesk/CustomerAgentPanel.tsx).
 *
 * The draft endpoint is a non-idempotent create and is held at the source.
 * This panel therefore does not load requester records, offer a conversation
 * picker, or manufacture a draft while the catalog reports the capability
 * as held. It presents the static catalog guardrail and the exact hold code.
 * When — and only when — the server catalog reports `customer_agent` as
 * available, the same panel exposes the conversation field and sends the
 * real POST /api/v1/service-suite/agent/draft-reply.
 */
import { useId, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import {
  catalogGuardrailText,
  CUSTOMER_AGENT_DRAFT_HOLD_CODE,
  customerAgentCapability,
  customerAgentDraftAvailable,
  draftCustomerAgentReply,
  type CustomerAgentDraftRun,
  type ServiceSuiteCatalog,
} from "@/lib/service-suite-api";

export function CustomerAgentPanel({
  catalog,
  online = true,
}: {
  /** The verified static catalog, or null while unavailable. */
  catalog: ServiceSuiteCatalog | null;
  online?: boolean;
}) {
  const holdId = useId();
  const conversationId = useId();
  const promptId = useId();
  const [conversation, setConversation] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<CustomerAgentDraftRun | null>(null);

  const available = customerAgentDraftAvailable(catalog);
  const capability = customerAgentCapability(catalog);
  const holdCode = capability?.code ?? CUSTOMER_AGENT_DRAFT_HOLD_CODE;

  async function generate() {
    if (!available || busy) return;
    setBusy(true);
    try {
      const result = await draftCustomerAgentReply(catalog, {
        conversation_id: conversation,
        prompt,
      });
      setRun(result);
      toast.success("Draft created for human review");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Draft could not be created"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="grid gap-4 rounded-lg border p-4"
      data-helpdesk-state={available ? "agent-create-ready" : "agent-create-held"}
    >
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Source-held foundation
        </p>
        <h3 className="text-base font-semibold">Customer Agent draft</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          The declared foundation is deterministic templating only. No
          provider, customer mutation, delivery, conversation grounding, or
          Agent run is executed from this panel.
        </p>
      </div>

      {available ? null : (
        <div
          role="status"
          className="rounded-md border border-warning-emphasis/40 bg-warning-subtle/30 p-3 text-sm"
        >
          <strong className="block">Draft creation unavailable</strong>
          <span>
            The non-idempotent create is held before request-body processing
            or persistence (<code>{holdCode}</code>).
          </span>
        </div>
      )}

      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div className="rounded-md border p-3">
          <dt className="text-xs text-muted-foreground">Execution mode</dt>
          <dd className="mt-1 font-medium">
            Deterministic template declaration
          </dd>
        </div>
        <div className="rounded-md border p-3">
          <dt className="text-xs text-muted-foreground">Provider executed</dt>
          <dd className="mt-1 font-medium">No</dd>
        </div>
        <div className="rounded-md border p-3">
          <dt className="text-xs text-muted-foreground">Customer mutation</dt>
          <dd className="mt-1 font-medium">Unavailable</dd>
        </div>
        <div className="rounded-md border p-3">
          <dt className="text-xs text-muted-foreground">Recorded run</dt>
          <dd className="mt-1 font-medium">
            {run ? "One draft run returned for review" : "None created by this view"}
          </dd>
        </div>
      </dl>

      <p className="text-sm text-muted-foreground">
        {catalogGuardrailText(catalog) ||
          "Static guardrail verification is unavailable. Treat all Agent capability as held."}
      </p>

      {!online ? (
        <p role="status" className="text-sm text-muted-foreground">
          Helpdesk is offline. The source hold remains in force; nothing is
          queued for later execution.
        </p>
      ) : null}

      {available ? (
        <div className="grid gap-3">
          <Label htmlFor={conversationId}>Conversation ID</Label>
          <Input
            id={conversationId}
            value={conversation}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setConversation(e.target.value)}
          />
          <Label htmlFor={promptId}>Drafting instructions (optional)</Label>
          <Textarea
            id={promptId}
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          {run?.draft ? (
            <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">
              {run.draft}
            </pre>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button
          type="button"
          size="sm"
          disabled={!available || busy || !conversation.trim()}
          aria-describedby={available ? undefined : holdId}
          title={
            available
              ? undefined
              : "No request will be sent until a replay-safe create contract is available."
          }
          onClick={generate}
        >
          {available
            ? busy
              ? "Generating…"
              : "Generate draft"
            : "Generate draft — unavailable"}
        </Button>
        {available ? null : (
          <span id={holdId} className="text-sm text-muted-foreground">
            No request will be sent until a replay-safe create contract is
            available.
          </span>
        )}
      </div>
    </div>
  );
}
