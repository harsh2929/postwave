// SPDX-License-Identifier: AGPL-3.0-only
import { ImageResponse } from "next/og";

export const alt = "Moosewave security and compliance";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PILLARS = ["Residency", "Encryption", "Audit", "Compliance"];

export default async function Image(): Promise<ImageResponse> {
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
          fontSize: 26,
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
        <span>Moosewave</span>
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
            fontSize: 28,
            color: "#C8102E",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            fontWeight: 500,
            display: "flex",
          }}
        >
          Security
        </div>
        <div
          style={{
            marginTop: 16,
            fontSize: 64,
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: "-0.025em",
            maxWidth: 1040,
            display: "flex",
          }}
        >
          Honest about what we do. Honest about what we don&apos;t.
        </div>
        <div
          style={{
            marginTop: 28,
            display: "flex",
            flexWrap: "wrap",
            gap: 28,
            fontSize: 24,
            color: "#B8B8B8",
            fontWeight: 500,
          }}
        >
          {PILLARS.map((p) => (
            <div
              key={p}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span style={{ color: "#C8102E" }}>·</span>
              <span>{p}</span>
            </div>
          ))}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          color: "#5C5C5C",
          fontSize: 22,
        }}
      >
        <span>moosewave.com/security</span>
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
