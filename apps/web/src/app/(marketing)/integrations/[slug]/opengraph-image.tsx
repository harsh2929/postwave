// SPDX-License-Identifier: AGPL-3.0-only
//
// Per-integration OG image. One pre-rendered card per slug, generated at
// build time via generateImageMetadata.
import { ImageResponse } from "next/og";

import { INTEGRATIONS, getIntegration } from "@/lib/integrations";

export const alt = "Moosewave integration";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

interface ImageParams {
  slug: string;
}

export async function generateImageMetadata(): Promise<
  {
    id: string;
    alt: string;
    size: { width: number; height: number };
    contentType: string;
  }[]
> {
  return INTEGRATIONS.map((i) => ({
    id: i.slug,
    alt: `${i.name} integration for Moosewave`,
    size,
    contentType,
  }));
}

export default async function Image({
  params,
}: {
  params: ImageParams;
}): Promise<ImageResponse> {
  const integration = getIntegration(params.slug);
  if (!integration) {
    // Should never hit — generateImageMetadata mirrors generateStaticParams.
    throw new Error(`unknown integration slug: ${params.slug}`);
  }

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#0F0F0F",
        color: "#FDFCF8",
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        padding: "64px 72px",
        position: "relative",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontSize: 24,
          fontWeight: 600,
        }}
      >
        <div
          style={{
            width: 14,
            height: 14,
            borderRadius: 4,
            backgroundColor: "#C8102E",
            display: "flex",
          }}
        />
        <span>Moosewave / Integrations</span>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          justifyContent: "center",
        }}
      >
        <div
          style={{
            fontSize: 22,
            color: "#C8102E",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            fontWeight: 500,
            display: "flex",
          }}
        >
          {integration.category}
        </div>
        <div
          style={{
            marginTop: 14,
            fontSize: 84,
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: "-0.03em",
            display: "flex",
          }}
        >
          {integration.name}
        </div>
        <div
          style={{
            marginTop: 22,
            fontSize: 26,
            color: "#B8B8B8",
            maxWidth: 1000,
            display: "flex",
          }}
        >
          {integration.summary}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          color: "#5C5C5C",
          fontSize: 20,
        }}
      >
        <span>moosewave.com/integrations/{integration.slug}</span>
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 8,
          backgroundColor: "#C8102E",
          display: "flex",
        }}
      />
    </div>,
    { ...size },
  );
}
