"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";

import { flushQueuedMutations } from "@/lib/api";
import { readOfflineQueue } from "@/lib/offline-store";
import {
  getOnlineStatus,
  startOnlineManager,
  subscribeOnlineStatus,
  type OnlineStatus,
} from "@/lib/online-manager";

export function PwaRegistrar() {
  const pathname = usePathname();
  const isDashboard = pathname === "/app" || pathname.startsWith("/app/");
  const lastStatusRef = useRef<OnlineStatus>(getOnlineStatus());
  const registrationStartedRef = useRef(false);

  useEffect(() => {
    if ("serviceWorker" in navigator && !registrationStartedRef.current) {
      registrationStartedRef.current = true;
      // The only registration path: Serwist's automatic one is off
      // (next.config.mjs `register: false`) because it read `.waiting` off a
      // missing registration and threw into the page when a browser blocks
      // service workers. Offline support is an enhancement, so a refused or
      // empty registration is logged at debug and the page carries on.
      void navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((registration: ServiceWorkerRegistration | undefined) => {
          // A browser (or automation) that blocks service workers can
          // resolve with no registration at all.
          if (!registration) {
            console.debug(
              "[pwa] service worker registration unavailable in this browser",
            );
            return;
          }
          const sync = registration as ServiceWorkerRegistration & {
            sync?: { register: (tag: string) => Promise<void> };
          };
          // Best-effort enable navigation preload on supporting browsers.
          if (registration.navigationPreload) {
            void registration.navigationPreload.enable().catch(() => undefined);
          }
          // Update-available toast — surface only when a newer SW is
          // waiting and there's an existing controller. We do NOT call
          // skipWaiting() automatically; the user pulls the trigger.
          const announceWaiting = (sw: ServiceWorker | null) => {
            if (!sw) return;
            if (!navigator.serviceWorker.controller) return;
            toast.message("Update available", {
              description: "A new Moosewave version is ready.",
              action: {
                label: "Refresh",
                onClick: () => {
                  sw.postMessage({ type: "SKIP_WAITING" });
                },
              },
              duration: 30_000,
            });
          };
          if (registration.waiting) announceWaiting(registration.waiting);
          registration.addEventListener("updatefound", () => {
            const installing = registration.installing;
            if (!installing) return;
            installing.addEventListener("statechange", () => {
              if (installing.state === "installed") {
                announceWaiting(installing);
              }
            });
          });
          return sync.sync?.register("postwave-offline-flush");
        })
        .catch((error: unknown) => {
          console.debug("[pwa] service worker registration failed", error);
        });

      // When the new SW takes control after the user accepts the update,
      // reload exactly once so the runtime matches the new asset hashes.
      const hadController = Boolean(navigator.serviceWorker.controller);
      let didReload = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        // clientsClaim also fires controllerchange on the first install. That
        // is not an update and must not reload a visitor mid-form.
        if (!hadController || didReload) return;
        didReload = true;
        window.location.reload();
      });
    }

    // Service-worker registration is global, but authenticated health probing
    // and outbox replay belong to the dashboard only. Marketing/docs tabs must
    // not ping /api/health every 30 seconds forever.
    if (!isDashboard) return;

    async function flushAndNotify(): Promise<void> {
      const before = readOfflineQueue().length;
      if (before === 0) return;
      const result = await flushQueuedMutations();
      if (result.replayed > 0) {
        toast.success("Offline changes synced", {
          description: `${result.replayed} queued change${
            result.replayed === 1 ? "" : "s"
          } replayed.`,
        });
      }
      if (result.conflicts > 0 || result.failed > 0) {
        toast.warning("Some offline changes need attention", {
          description: `${result.conflicts} conflict${
            result.conflicts === 1 ? "" : "s"
          }, ${result.failed} failed replay${result.failed === 1 ? "" : "s"}.`,
          // Give the user a direct path to the queue while online (SHELL-019);
          // QueueTrayLauncher listens for this event and opens the tray.
          action: {
            label: "Review",
            onClick: () =>
              window.dispatchEvent(new Event("pw:open-queue-tray")),
          },
          duration: 10_000,
        });
      }
    }

    const onCameOnline = (): void => {
      void flushAndNotify();
      void navigator.serviceWorker?.ready
        .then((registration) => {
          const sync = registration as ServiceWorkerRegistration & {
            sync?: { register: (tag: string) => Promise<void> };
          };
          return sync.sync?.register("postwave-offline-flush");
        })
        .catch(() => undefined);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "POSTWAVE_FLUSH_OFFLINE_QUEUE") {
        void flushAndNotify();
      }
    };

    // Subscribe to the unified onlineManager so queue replay fires
    // only on the verified online→offline→online transition, not on
    // every flaky navigator.onLine flip.
    const stopManager = startOnlineManager();
    const checkStatus = (): void => {
      const next = getOnlineStatus();
      if (next === "online" && lastStatusRef.current !== "online") {
        onCameOnline();
      }
      lastStatusRef.current = next;
    };
    const unsubscribe = subscribeOnlineStatus(checkStatus);
    window.addEventListener("online", checkStatus);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    if (getOnlineStatus() === "online" || navigator.onLine !== false) {
      onCameOnline();
    }
    return () => {
      unsubscribe();
      stopManager();
      window.removeEventListener("online", checkStatus);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, [isDashboard]);

  return null;
}
