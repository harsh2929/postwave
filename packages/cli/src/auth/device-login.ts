// SPDX-License-Identifier: MIT
//
// Device-authorization (RFC 8628) login — "scan a QR, approve on a device
// you're already signed in on." The gateway's device-grant backend
// (apps/api/internal/auth/cli_device_auth.go) already mints a user_code + a
// `verification_uri_complete`, and the web app already serves a pre-filling
// approval page (/cli/auth?user_code=…); the only missing piece was a client
// that INITIATES the grant. This does: it renders the verification URL as a
// terminal QR, then polls for approval — the Apple-style "approve on a trusted
// device" handoff with zero typing on the approving device (Apple-level
// integration blueprint, strategic bet #1). Falls back to the printed URL +
// code, so it degrades gracefully where a QR can't render.

import chalk from "chalk";
import QRCode from "qrcode";

import {
  setCredentials,
  resolveBaseUrl,
  isSafeCredentialValue,
} from "../lib/config.js";

interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval?: number;
  expires_in?: number;
}

interface DeviceTokenSuccess {
  api_key?: string;
  tenant_id?: string;
  email?: string;
}

/**
 * The next poll action for a device-token error code (RFC 8628 §3.5). Pure and
 * exported so the state machine is unit-testable without a live server.
 */
export type PollAction = "pending" | "slow_down" | "denied" | "expired" | "fatal";
export function classifyPollError(code: string | undefined): PollAction {
  switch (code) {
    case "authorization_pending":
      return "pending";
    case "slow_down":
      return "slow_down";
    case "access_denied":
      return "denied";
    case "expired_token":
      return "expired";
    default:
      return "fatal";
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function deviceLogin(
  opts: { baseUrl?: string } = {},
): Promise<void> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);

  // 1. Start the grant.
  let start: DeviceStartResponse;
  try {
    const res = await fetch(
      new URL("/api/v1/auth/cli/device/start", baseUrl).toString(),
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    if (!res.ok) {
      console.log(chalk.red(`Device login failed: start returned ${res.status}.`));
      process.exitCode = 1;
      return;
    }
    start = (await res.json()) as DeviceStartResponse;
  } catch (err) {
    console.log(chalk.red(`Device login failed: ${(err as Error).message}`));
    process.exitCode = 1;
    return;
  }
  if (!start.device_code || !start.user_code || !start.verification_uri_complete) {
    console.log(chalk.red("Device login failed: incomplete response from server."));
    process.exitCode = 1;
    return;
  }

  // 2. Render the QR + the fallback URL/code.
  console.log(
    `\nScan this QR with a device where you're already signed in — or open\n` +
      `${chalk.cyan(start.verification_uri)} and enter code ${chalk.bold(start.user_code)}:\n`,
  );
  try {
    console.log(
      await QRCode.toString(start.verification_uri_complete, {
        type: "terminal",
        small: true,
      }),
    );
  } catch {
    // QR is a convenience; the URL + code below still complete the flow.
  }
  console.log(chalk.dim(start.verification_uri_complete) + "\n");
  console.log(chalk.dim("Waiting for approval…"));

  // 3. Poll for approval (RFC 8628 §3.4/3.5).
  let intervalMs = Math.max(1, start.interval ?? 5) * 1000;
  const deadline = Date.now() + Math.max(30, start.expires_in ?? 900) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let res: Response;
    try {
      res = await fetch(
        new URL("/api/v1/auth/cli/device/token", baseUrl).toString(),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device_code: start.device_code }),
        },
      );
    } catch {
      continue; // transient network blip — keep polling until the deadline
    }
    if (res.ok) {
      finishLogin((await res.json()) as DeviceTokenSuccess, baseUrl);
      return;
    }
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    switch (classifyPollError(body.error?.code)) {
      case "pending":
        continue;
      case "slow_down":
        intervalMs += 5000; // RFC 8628: increase the poll interval by 5s
        continue;
      case "denied":
        console.log(chalk.red("The sign-in request was denied."));
        process.exitCode = 1;
        return;
      case "expired":
        console.log(chalk.red("The code expired. Run `postwave login --device` again."));
        process.exitCode = 1;
        return;
      case "fatal":
        console.log(
          chalk.red(`Device login failed: ${body.error?.message ?? res.status}`),
        );
        process.exitCode = 1;
        return;
    }
  }
  console.log(chalk.red("Timed out waiting for approval. Run login again."));
  process.exitCode = 1;
}

function finishLogin(payload: DeviceTokenSuccess, baseUrl: string): void {
  const apiKey = payload.api_key;
  if (!apiKey || !isSafeCredentialValue(apiKey)) {
    console.log(chalk.red("Device login failed: no valid API key returned."));
    process.exitCode = 1;
    return;
  }
  try {
    setCredentials({
      apiKey,
      baseUrl,
      tenantId: payload.tenant_id,
      email: payload.email,
      storedAt: new Date().toISOString(),
    });
    console.log(
      chalk.green(`Logged in${payload.email ? ` as ${payload.email}` : ""}.`),
    );
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exitCode = 1;
  }
}
