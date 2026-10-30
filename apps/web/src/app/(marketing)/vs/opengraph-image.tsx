// SPDX-License-Identifier: AGPL-3.0-only
import { ImageResponse } from "next/og";

export const alt =
  "Compare Moosewave to Mailchimp, Substack, Beehiiv, ConvertKit, MailerLite, and Sendy.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const COMPETITORS = [
  "Mailchimp",
  "Substack",
  "Beehiiv",
  "ConvertKit",
  "MailerLite",
  "Sendy",
];

export default async function Image(): Promise<ImageResponse> {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#020617",
        color: "#f8fafc",
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        padding: "64px 72px",
        position: "relative",
      }}
    >
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
            backgroundColor: "#2dd4bf",
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
          maxWidth: 1040,
        }}
      >
        <div
          style={{
            fontSize: 80,
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: "-0.03em",
            color: "#f8fafc",
            display: "flex",
          }}
        >
          Compare Moosewave.
        </div>
        <div
          style={{
            marginTop: 28,
            display: "flex",
            flexWrap: "wrap",
            gap: 20,
            fontSize: 26,
            color: "#cbd5e1",
            fontWeight: 500,
          }}
        >
          {COMPETITORS.map((c) => (
            <div
              key={c}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 18px",
                border: "1px solid #1e293b",
                borderRadius: 999,
                backgroundColor: "rgba(15,23,42,0.6)",
              }}
            >
              <span style={{ color: "#2dd4bf" }}>vs</span>
              <span>{c}</span>
            </div>
          ))}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          color: "#475569",
          fontSize: 22,
        }}
      >
        <span>moosewave.com/vs</span>
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 8,
          backgroundColor: "#2dd4bf",
          display: "flex",
        }}
      />
    </div>,
    { ...size },
  );
}
