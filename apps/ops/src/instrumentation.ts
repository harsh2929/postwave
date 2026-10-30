// SPDX-License-Identifier: AGPL-3.0-only

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { loadOpsRuntimeConfig } = await import("./lib/opsConfig");
  // Production starts only when all internal origins are explicit, HTTPS,
  // and allowlisted. Throwing here stops the server before it can serve a
  // misleading empty/unreachable operations board.
  loadOpsRuntimeConfig();
}
