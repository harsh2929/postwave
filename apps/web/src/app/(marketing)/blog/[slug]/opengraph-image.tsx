// SPDX-License-Identifier: AGPL-3.0-only
//
// Per-post OG image. Pulls the post's title and reading time from frontmatter
// and renders a consistent dark card. Generated at build time via the
// `generateImageMetadata`/`generateStaticParams` pair below — the params
// match the [slug] route exactly so every post gets a pre-rendered card.
import { ImageResponse } from "next/og";

import { getBlogPost, listBlogPosts } from "@/lib/blog";

export const alt = "Moosewave blog post";
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
  const posts = await listBlogPosts();
  return posts.map((p) => ({
    id: p.slug,
    alt: p.title,
    size,
    contentType,
  }));
}

export default async function Image({
  params,
}: {
  params: ImageParams;
}): Promise<ImageResponse> {
  const post = await getBlogPost(params.slug);

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
        <span>Moosewave / Blog</span>
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
          {post.tags[0] ?? "Moosewave"}
        </div>
        <div
          style={{
            marginTop: 14,
            fontSize: 60,
            fontWeight: 700,
            lineHeight: 1.08,
            letterSpacing: "-0.025em",
            maxWidth: 1040,
            display: "flex",
          }}
        >
          {post.title}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          color: "#B8B8B8",
          fontSize: 20,
        }}
      >
        <span>{post.author}</span>
        <span>{post.readingTime}</span>
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
