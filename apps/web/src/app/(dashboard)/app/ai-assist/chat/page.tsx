// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// /app/ai-assist/chat — the Moosewave AI chat workspace (desktop PostwaveAI
// "Chat" mode). Nested under /app/ai-assist so it inherits that section's
// place in navigation; the panel itself owns every chat verb.

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { PostwaveAIChatPanel } from "@/components/ai/PostwaveAIChatPanel";
import { PageShell } from "@/components/dashboard/page-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";

export default function PostwaveAIChatPage() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const me = meQuery.data ?? null;

  return (
    <PageShell className="max-w-6xl">
      <div className="space-y-1">
        <Link
          href="/app/ai-assist"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          AI assist
        </Link>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Moosewave AI chat
        </h1>
        <p className="text-sm text-muted-foreground">
          Ask for drafts, subject lines, plans, and summaries grounded in your
          voice profile and the workspace resources you attach.
        </p>
      </div>
      {meQuery.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking your workspace access…
        </p>
      ) : meQuery.isError || !me ? (
        <Alert variant="destructive">
          <AlertTitle>Workspace access could not be verified</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>No prompt was sent. Retry once your session is restored.</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void meQuery.refetch()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <PostwaveAIChatPanel
          key={`${me.user_id}:${me.tenant_id}:${effectiveAuthRole(me)}:${me.viewer_mode === true}`}
          identity={me}
        />
      )}
    </PageShell>
  );
}
