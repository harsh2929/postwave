// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

export function MigrationRetryButton({ label = "Retry" }: { label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="outline"
      className="shrink-0 bg-background"
      loading={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {!pending ? <RefreshCw aria-hidden="true" /> : null}
      {pending ? "Retrying…" : label}
    </Button>
  );
}
