// SPDX-License-Identifier: AGPL-3.0-only
//
// Browser Web Push opt-in. The PWA service worker now has push +
// notificationclick handlers (src/app/sw.ts); this card drives the
// PushManager.subscribe flow (src/lib/web-push.ts).
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  currentPermission,
  fetchWebPushConfig,
  isSubscribed,
  sendTestPush,
  subscribeToWebPush,
  unsubscribeFromWebPush,
  webPushSupport,
  type WebPushSupport,
} from "@/lib/web-push";

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error(message)),
      timeoutMs,
    );
    operation.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function WebPushCard() {
  const [support, setSupport] = useState<WebPushSupport | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [subscriptionError, setSubscriptionError] = useState(false);
  const [configError, setConfigError] = useState(false);
  const [probing, setProbing] = useState(false);
  const [action, setAction] = useState<"enable" | "test" | "disable" | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [permission, setPermission] =
    useState<NotificationPermission>("default");
  const actionRef = useRef<typeof action>(null);
  const probeGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);

  const runProbes = useCallback(
    async (which: { subscription: boolean; config: boolean }) => {
      if (webPushSupport() !== "supported") return;
      const generation = ++probeGenerationRef.current;
      setProbing(true);
      if (which.subscription) setSubscriptionError(false);
      if (which.config) setConfigError(false);

      const subscriptionProbe = which.subscription
        ? withTimeout(
            isSubscribed(),
            5_000,
            "Browser notification status timed out.",
          )
        : Promise.resolve(false);
      const configProbe = which.config
        ? withTimeout(
            fetchWebPushConfig(),
            5_000,
            "Browser notification configuration timed out.",
          )
        : Promise.resolve(null);
      const [subscriptionResult, configResult] = await Promise.allSettled([
        subscriptionProbe,
        configProbe,
      ]);
      if (!mountedRef.current || generation !== probeGenerationRef.current)
        return;
      if (which.subscription) {
        if (subscriptionResult.status === "fulfilled") {
          setSubscribed(subscriptionResult.value);
        } else {
          setSubscriptionError(true);
        }
      }
      if (which.config) {
        if (configResult.status === "fulfilled" && configResult.value) {
          setConfigured(configResult.value.enabled);
        } else {
          setConfigError(true);
        }
      }
      setProbing(false);
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    const detectedSupport = webPushSupport();
    setSupport(detectedSupport);
    if (detectedSupport !== "supported") {
      return () => {
        mountedRef.current = false;
      };
    }
    setPermission(currentPermission());
    // `navigator.serviceWorker.ready` can remain pending forever when a
    // browser or enterprise policy blocks workers. Bound the probe so this
    // card never strands the whole tab in a permanent loading state.
    void runProbes({ subscription: true, config: true });
    return () => {
      mountedRef.current = false;
      probeGenerationRef.current += 1;
    };
  }, [runProbes]);

  useEffect(() => {
    if (actionError) errorRef.current?.focus();
  }, [actionError]);

  function beginAction(next: NonNullable<typeof action>): boolean {
    if (actionRef.current) return false;
    actionRef.current = next;
    setAction(next);
    setActionError(null);
    return true;
  }

  function finishAction(): void {
    actionRef.current = null;
    setAction(null);
  }

  function reportError(error: unknown, fallback: string): void {
    const message = error instanceof Error ? error.message : fallback;
    setActionError(message);
    toast.error(message);
  }

  async function onTest() {
    if (!beginAction("test")) return;
    try {
      const delivered = await sendTestPush();
      toast.success(
        delivered > 0
          ? `Test sent to ${delivered} device${delivered === 1 ? "" : "s"}.`
          : "No active devices to notify yet.",
      );
    } catch (e) {
      reportError(e, "Could not send test.");
    } finally {
      finishAction();
    }
  }

  async function onEnable() {
    if (!beginAction("enable")) return;
    try {
      const res = await subscribeToWebPush();
      setPermission(currentPermission());
      if (res.status === "subscribed") {
        setSubscribed(true);
        toast.success("Browser notifications enabled.");
      } else if (res.status === "error") {
        setSubscribed(false);
        reportError(
          new Error(
            res.message || "The server could not register this browser.",
          ),
          "The server could not register this browser.",
        );
      } else if (res.status === "denied") {
        reportError(
          new Error("Notification permission was denied."),
          "Notification permission was denied.",
        );
      } else if (res.status === "no-vapid-key") {
        reportError(
          new Error("Web Push isn't configured yet (missing VAPID key)."),
          "Web Push isn't configured yet.",
        );
      } else {
        reportError(
          new Error("Browser notifications aren't supported here."),
          "Browser notifications aren't supported here.",
        );
      }
    } catch (e) {
      reportError(e, "Could not enable push.");
    } finally {
      finishAction();
    }
  }

  async function onDisable() {
    if (!beginAction("disable")) return;
    try {
      await unsubscribeFromWebPush();
      setSubscribed(false);
      toast.success("Browser notifications disabled.");
    } catch (e) {
      reportError(e, "Could not disable push.");
    } finally {
      finishAction();
    }
  }

  const busy = action !== null;

  return (
    <Card aria-busy={probing || busy || undefined}>
      <CardHeader>
        <CardTitle>Browser notifications</CardTitle>
        <CardDescription>
          Get a push notification in this browser when something needs your
          attention — even when Moosewave isn&apos;t open.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {support === null ||
        (probing && configured === null && subscribed === null) ? (
          <div
            role="status"
            className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
          >
            Checking this browser&apos;s notification status…
          </div>
        ) : null}
        {support === "unsupported" && (
          <p className="text-sm text-muted-foreground">
            This browser doesn&apos;t support Web Push.
          </p>
        )}
        {support === "supported" && configError ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
          >
            <p className="font-medium text-destructive-emphasis">
              Deployment configuration could not be verified.
            </p>
            <p className="mt-1 text-muted-foreground">
              This is a probe failure, not evidence that Web Push is
              unconfigured.
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-3"
              disabled={probing}
              onClick={() =>
                void runProbes({ subscription: false, config: true })
              }
            >
              {probing ? "Retrying…" : "Retry configuration check"}
            </Button>
          </div>
        ) : null}
        {support === "supported" && subscriptionError ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
          >
            <p className="font-medium text-destructive-emphasis">
              This browser&apos;s subscription status could not be verified.
            </p>
            <p className="mt-1 text-muted-foreground">
              No subscribed or unsubscribed state has been assumed.
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-3"
              disabled={probing}
              onClick={() =>
                void runProbes({ subscription: true, config: false })
              }
            >
              {probing ? "Retrying…" : "Retry browser check"}
            </Button>
          </div>
        ) : null}
        {support === "supported" && !configError && configured === false && (
          // SETC-050: give admins a next step instead of a dead-end message.
          <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">
              Web Push isn&apos;t configured for this deployment.
            </p>
            <p className="mt-1">
              An admin needs to set a VAPID key pair (
              <code className="break-all text-xs">
                WEB_PUSH_VAPID_PUBLIC_KEY
              </code>{" "}
              /{" "}
              <code className="break-all text-xs">
                WEB_PUSH_VAPID_PRIVATE_KEY
              </code>
              ) on the API server, then reload this page. Until then, email
              notifications below still work.
            </p>
          </div>
        )}
        {support === "supported" &&
          configured &&
          !subscriptionError &&
          subscribed !== null && (
            <>
              {permission === "denied" ? (
                <p className="text-sm text-destructive">
                  Notifications are blocked for this site. Re-enable them in
                  your browser settings to turn this on.
                </p>
              ) : subscribed ? (
                <div className="flex min-w-0 flex-col items-start gap-3 rounded-md border bg-muted/30 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span>Browser notifications are on for this device.</span>
                  <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-1 sm:flex-none"
                      loading={action === "test"}
                      disabled={busy}
                      onClick={() => void onTest()}
                    >
                      {action === "test" ? "Sending…" : "Send test"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="flex-1 sm:flex-none"
                      loading={action === "disable"}
                      disabled={busy}
                      onClick={() => void onDisable()}
                    >
                      {action === "disable" ? "Turning off…" : "Turn off"}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  loading={action === "enable"}
                  disabled={busy}
                  onClick={() => void onEnable()}
                >
                  {action === "enable"
                    ? "Enabling…"
                    : "Enable browser notifications"}
                </Button>
              )}
            </>
          )}
        {actionError ? (
          <div
            ref={errorRef}
            role="alert"
            tabIndex={-1}
            className="break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
          >
            {actionError}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
