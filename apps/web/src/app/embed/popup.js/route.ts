// SPDX-License-Identifier: AGPL-3.0-only

import { NextResponse } from "next/server";

const FORWARDED_POPUP_PARAMS = new Set([
  "delay",
  "id",
  "key",
  "popup",
  "tenant",
  "trigger",
]);
const MAX_POPUP_PARAM_VALUE_LENGTH = 256;

export function GET(request: Request) {
  const source = new URL(request.url);
  const target = new URL("/popup.js", source.origin);
  for (const [name, value] of source.searchParams) {
    if (!FORWARDED_POPUP_PARAMS.has(name)) continue;
    const clean = safePopupParam(value);
    if (clean) target.searchParams.set(name, clean);
  }
  return NextResponse.redirect(target, {
    status: 308,
    headers: {
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function safePopupParam(value: string): string {
  if (!value || value.length > MAX_POPUP_PARAM_VALUE_LENGTH) return "";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "";
  return value.trim();
}
