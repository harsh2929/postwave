// SPDX-License-Identifier: AGPL-3.0-only
import { connection } from "next/server";

/**
 * Forces credential-bearing routes to render against the live request so
 * middleware's one-time CSP nonce is available to Next's script renderer.
 */
export async function StrictCSPLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await connection();
  return children;
}
