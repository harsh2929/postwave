// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { whoami } from "@/lib/auth-api";
import { canWriteForms, FORM_READ_ONLY_MESSAGE } from "@/lib/forms-authority";
import { qk, STALE } from "@/lib/query-keys";
import { useFormsOrigin } from "@/lib/use-forms-origin";

// The header's "New form" action lives apart from the table client so the
// server page can render it eagerly while the table (the bulk of the route's
// client JavaScript) loads behind FormsListLazy.
export function FormsPageActions() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });

  if (meQuery.isPending) {
    return <Button disabled>Verifying access…</Button>;
  }
  if (!canWriteForms(meQuery.data)) {
    return (
      <p className="max-w-xs text-sm text-muted-foreground" role="note">
        {FORM_READ_ONLY_MESSAGE}
      </p>
    );
  }
  return (
    <Button asChild className="shrink-0">
      <Link href="/app/forms/new">
        <Plus className="h-4 w-4" />
        New form
      </Link>
    </Button>
  );
}

// Match the editor and embed tools after hydration, while explicit deployment
// configuration retains precedence over the current browser origin.
export function FormsHostedOrigin() {
  const origin = useFormsOrigin();
  return (
    <code className="break-all text-foreground">
      {origin}/forms/&lt;slug&gt;
    </code>
  );
}
