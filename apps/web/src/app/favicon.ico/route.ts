// SPDX-License-Identifier: AGPL-3.0-only

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="#171717"/>
  <rect x="8" y="8" width="16" height="16" rx="3" fill="#f97316"/>
  <path d="M10 18h12v3H10zM10 11h12v3H10z" fill="#fff"/>
</svg>`;

export function GET(): Response {
  return new Response(FAVICON, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}
