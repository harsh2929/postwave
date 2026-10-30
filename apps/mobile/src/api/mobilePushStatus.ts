/**
 * api/mobilePushStatus.ts — "is this installation still being delivered to?"
 *
 * `POST /api/v1/mobile/push/devices/status` (routed at
 * apps/api/internal/mobilepush/devices.go:60, handler DeviceStatus at :152).
 * The body is the installation's possession key and nothing else; the handler
 * resolves the acting user from the session and answers only about THIS row —
 * it never lists other devices and never returns token material.
 *
 * SESSION-ONLY BY CONSTRUCTION. main.go wraps the device group in
 * RequireAuthMethod(session), so an API-key install gets 401 no matter what
 * scopes the key holds. The caller must not ask on that path; a 401 rendered as
 * "push is broken" would be a lie about a feature the install cannot have.
 *
 * A device that has never registered has no possession key at all, which is not
 * an error either — it is `null`, and the caller renders "not checked" rather
 * than inventing a negative.
 */
import { getClient } from "@/api/sdkClient";
import { readPushDeviceKey } from "@/lib/push";
import type { PushDeviceStatusFacts } from "@/lib/pushDeliveryHealth";

export async function fetchPushDeviceStatus(): Promise<PushDeviceStatusFacts | null> {
  const deviceKey = await readPushDeviceKey();
  if (!deviceKey) return null;
  const { client } = getClient();
  const response = await client.mobilePush.status({ device_key: deviceKey });
  return {
    registered: Boolean(response.registered),
    deliveryEnabled: Boolean(response.delivery_enabled),
    ...(response.registered_at
      ? { registeredAt: response.registered_at }
      : {}),
  };
}
