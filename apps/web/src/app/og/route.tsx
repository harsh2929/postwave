// SPDX-License-Identifier: AGPL-3.0-only
import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

import {
  consumeOgRenderAllowance,
  ogPeerKey,
} from "@/lib/og-render-budget";
import { sanitizeOgText } from "@/lib/og-text";

export const runtime = "edge";

const WIDTH = 1200;
const HEIGHT = 630;

// Brand palette — slate-950 background + teal accent.
const BG = "#020617"; // slate-950
const FG = "#f8fafc"; // slate-50
const MUTED = "#94a3b8"; // slate-400
const TEAL = "#2dd4bf"; // teal-400

export function GET(req: NextRequest): Response {
  const { searchParams } = new URL(req.url);
  const title = sanitizeOgText(searchParams.get("title"), 120);
  const subtitle = sanitizeOgText(searchParams.get("subtitle"), 180);
  const eyebrow = sanitizeOgText(searchParams.get("eyebrow"), 48);

  if (!title) {
    return new Response("Missing required ?title parameter", { status: 400 });
  }

  const retryAfter = consumeOgRenderAllowance(ogPeerKey(req.headers));
  if (retryAfter !== null) {
    return new Response("Too many image renders", {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "Cache-Control": "no-store",
      },
    });
  }

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: BG,
        color: FG,
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        padding: "64px 72px",
        position: "relative",
      }}
    >
      {/* Subtle gradient accent in top-right */}
      <div
        style={{
          position: "absolute",
          top: -180,
          right: -180,
          width: 520,
          height: 520,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(45,212,191,0.18) 0%, rgba(45,212,191,0) 70%)",
          display: "flex",
        }}
      />

      {/* Wordmark */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontSize: 28,
          fontWeight: 600,
          letterSpacing: "-0.02em",
        }}
      >
        <div
          style={{
            width: 14,
            height: 14,
            borderRadius: 4,
            backgroundColor: TEAL,
            display: "flex",
          }}
        />
        <span>Moosewave</span>
      </div>

      {/* Body block — vertically centered */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          justifyContent: "center",
          maxWidth: 1000,
        }}
      >
        {eyebrow ? (
          <div
            style={{
              fontSize: 22,
              fontWeight: 500,
              color: TEAL,
              textTransform: "uppercase",
              letterSpacing: "0.18em",
              marginBottom: 24,
              display: "flex",
            }}
          >
            {eyebrow}
          </div>
        ) : null}

        <div
          style={{
            fontSize: title.length > 60 ? 64 : 80,
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: "-0.03em",
            color: FG,
            display: "flex",
          }}
        >
          {title}
        </div>

        {subtitle ? (
          <div
            style={{
              marginTop: 28,
              fontSize: 30,
              lineHeight: 1.35,
              color: MUTED,
              fontWeight: 400,
              letterSpacing: "-0.01em",
              display: "flex",
            }}
          >
            {subtitle}
          </div>
        ) : null}
      </div>

      {/* Teal accent bar at the bottom */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 8,
          backgroundColor: TEAL,
          display: "flex",
        }}
      />
    </div>,
    {
      width: WIDTH,
      height: HEIGHT,
      headers: {
        // The query string fully determines the pixels, so repeats belong in
        // the CDN, not in a render worker. Not `immutable`: the URL is not
        // content-hashed, so a year-long freeze would pin a stale brand into
        // every cache and crawler after a design change.
        "Cache-Control":
          "public, max-age=86400, stale-while-revalidate=604800",
      },
    },
  );
}
