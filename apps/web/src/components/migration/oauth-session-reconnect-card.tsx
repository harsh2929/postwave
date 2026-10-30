// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { startOAuth } from "@/lib/migration-api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { safeExternalHTTPSURL } from "@/lib/safe-navigation";
import { SOURCE_LABELS, type SourcePlatform } from "@/lib/types";
import type { SourceSessionStatus } from "@/lib/migration-source-session";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function OAuthSessionReconnectCard({
  source,
  jobId,
  sessionStatus,
  returnTo = "review",
  beforeWrite,
  authorityKey,
  markerIdentity,
}: {
  source: SourcePlatform;
  jobId: string;
  sessionStatus: SourceSessionStatus;
  returnTo?: "review" | "detail";
  beforeWrite: (signal?: AbortSignal) => Promise<void>;
  authorityKey: string;
  markerIdentity?: MeResponse;
}) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const operationRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setPending(false);
    return () => {
      operationRef.current?.abort();
      operationRef.current = null;
      pendingRef.current = false;
    };
  }, [authorityKey]);

  const reconnect = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    const controller = new AbortController();
    operationRef.current = controller;
    setPending(true);
    let markerWritten = false;
    try {
      await beforeWrite(controller.signal);
      controller.signal.throwIfAborted();
      const { authorize_url } = await startOAuth(
        source,
        jobId,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const target = safeExternalHTTPSURL(authorize_url, [
        "/migrations/oauth/callback",
        "/app/migrations/oauth/callback",
      ]);
      if (!target) {
        throw new Error("Migration provider returned an unsafe OAuth URL.");
      }
      try {
        sessionStorage.setItem(
          "postwave:oauth-pending",
          JSON.stringify({
            source,
            jobId,
            returnStep: returnTo,
            startedAt: Date.now(),
            ...(markerIdentity
              ? {
                  tenantId: markerIdentity.tenant_id,
                  userId: markerIdentity.user_id,
                  effectiveRole: effectiveAuthRole(markerIdentity),
                  viewerMode: markerIdentity.viewer_mode === true,
                }
              : {}),
          }),
        );
        markerWritten = true;
      } catch {
        // The server's tenant-bound, single-use state remains authoritative.
      }
      window.location.assign(target);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (markerWritten) {
        try {
          sessionStorage.removeItem("postwave:oauth-pending");
        } catch {
          // The server-side state remains authoritative when storage fails.
        }
      }
      toast.error(`Could not reconnect ${SOURCE_LABELS[source]}`, {
        description:
          error instanceof Error ? error.message : "Unknown OAuth error",
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
        <CardTitle>
          {sessionStatus.kind === "near"
            ? `${SOURCE_LABELS[source]} session expires soon`
            : `Reconnect ${SOURCE_LABELS[source]}`}
        </CardTitle>
        <CardDescription>{sessionStatus.message}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button onClick={() => void reconnect()} disabled={pending}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          Reconnect this migration
        </Button>
      </CardFooter>
    </Card>
  );
}
