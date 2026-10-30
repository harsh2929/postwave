/**
 * lib/pushDeliveryHealth.ts — the verdict on whether pushes will actually
 * arrive on this installation. Pure, so every branch is unit-tested in node.
 *
 * THE FAILURE THIS EXISTS FOR (NATIVE#49). The Settings toggle reflected local
 * state only: a stored Expo token plus an OS permission. Neither of those
 * changes when the SERVER stops delivering. `receipts.go` deactivates a device
 * row on a `DeviceNotRegistered` receipt, and `deliveryEnabled()` is false on
 * any deployment that has not configured the Expo credentials at all — in both
 * cases the switch kept reading ON, forever, while nothing was delivered. A
 * notification feature that silently stops is worse than one that is off,
 * because the user stops checking the app.
 *
 * `POST /api/v1/mobile/push/devices/status` (apps/api/internal/mobilepush/
 * devices.go:152-176) is the authority. It answers with, per deviceResponse
 * (devices.go:78-84): `registered` — is THIS installation's possession key
 * still an active row for the acting user — and `delivery_enabled` — is the
 * server able to send at all.
 *
 * ABSENCE IS NOT ZERO. A status that has not been fetched (offline, API-key
 * install, request failed) is `unknown`, never `stopped`. Telling a user their
 * push is broken because we could not ask is its own kind of lie.
 */

export interface PushDeviceStatusFacts {
  /** Server: is this possession key an active row for the acting user? */
  registered: boolean;
  /** Server: can this deployment send push at all? */
  deliveryEnabled: boolean;
  registeredAt?: string | undefined;
}

export interface PushDeliveryInput {
  /** The device has a stored Expo token AND OS permission. */
  locallyEnabled: boolean;
  /** Null when the status is unknown — never fabricate a false. */
  facts: PushDeviceStatusFacts | null;
}

export type PushDeliveryVerdict =
  /** Local state is off and the user knows it; nothing to report. */
  | { kind: "off" }
  /** Asked and answered: pushes will arrive. */
  | { kind: "healthy" }
  /** The switch says on, the server disagrees. This is the whole point. */
  | { kind: "deregistered" }
  /** The server cannot send to anyone; not this device's fault. */
  | { kind: "server_disabled" }
  /** We could not ask. Say so plainly rather than guessing either way. */
  | { kind: "unknown" };

export function pushDeliveryVerdict(
  input: PushDeliveryInput,
): PushDeliveryVerdict {
  if (!input.locallyEnabled) return { kind: "off" };
  if (!input.facts) return { kind: "unknown" };
  // Order matters: a deployment that cannot send at all explains a
  // not-registered row, and naming the deployment problem first stops the
  // user from re-toggling a switch that will never help.
  if (!input.facts.deliveryEnabled) return { kind: "server_disabled" };
  if (!input.facts.registered) return { kind: "deregistered" };
  return { kind: "healthy" };
}

export interface PushDeliveryCopy {
  /** Empty when there is nothing worth saying. */
  message: string;
  /** Shown as the row's state word; never colour-alone. */
  state: string;
  /** True when the user can fix it by re-registering this device. */
  offerRetry: boolean;
  tone: "neutral" | "warning" | "success";
}

export function pushDeliveryCopy(
  verdict: PushDeliveryVerdict,
): PushDeliveryCopy {
  switch (verdict.kind) {
    case "off":
      return { message: "", state: "", offerRetry: false, tone: "neutral" };
    case "healthy":
      return {
        message: "",
        state: "Delivering",
        offerRetry: false,
        tone: "success",
      };
    case "deregistered":
      return {
        message:
          "The server stopped delivering to this device — usually because the notification token was retired by iOS or Android. Re-register to start receiving pushes again.",
        state: "Not delivering",
        offerRetry: true,
        tone: "warning",
      };
    case "server_disabled":
      return {
        message:
          "This Moosewave server has push delivery turned off, so nothing will arrive on any device. Ask an administrator to configure push.",
        state: "Disabled on server",
        offerRetry: false,
        tone: "warning",
      };
    default:
      return {
        message:
          "Delivery status hasn't been checked on this device yet. Pull to refresh while online to confirm pushes are still arriving.",
        state: "Not checked",
        offerRetry: false,
        tone: "neutral",
      };
  }
}
