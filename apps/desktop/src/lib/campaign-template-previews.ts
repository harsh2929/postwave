import type {
  CampaignTemplate,
  CampaignTemplatePreviewAsset,
} from "./api-client";
import {
  POSTWAVE_ASSETS_BASE_URL,
  REFERENCE_TEMPLATE_PREVIEW_ORIGIN,
} from "./config";

const HOSTED_PREVIEW_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function configuredBase(raw: string | null): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function trustedCampaignTemplatePreviewUrl(
  raw: string,
  assetBase = POSTWAVE_ASSETS_BASE_URL,
): string | null {
  const base = configuredBase(assetBase);
  const candidate = raw.trim();
  if (!base || !candidate || /[\u0000-\u001f\u007f]/.test(candidate)) {
    return null;
  }
  try {
    const parsed = new URL(candidate);
    if (
      parsed.origin !== base.origin ||
      parsed.protocol !== base.protocol ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const basePath = base.pathname.replace(/\/+$/, "");
    if (
      basePath &&
      basePath !== "/" &&
      parsed.pathname !== basePath &&
      !parsed.pathname.startsWith(`${basePath}/`)
    ) {
      return null;
    }
    for (const segment of parsed.pathname.split("/")) {
      if (decodeURIComponent(segment) === "..") return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function trustedReferenceTemplatePreviewUrl(
  raw: string,
  sourceProvider: string | null | undefined,
  referencePreviewOrigin = REFERENCE_TEMPLATE_PREVIEW_ORIGIN,
): string | null {
  const base = configuredBase(referencePreviewOrigin);
  const candidate = raw.trim();
  if (
    sourceProvider?.trim() !== "really_good_emails" ||
    !base ||
    base.protocol !== "https:" ||
    !candidate ||
    /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return null;
  }
  try {
    const parsed = new URL(candidate);
    if (
      parsed.origin !== base.origin ||
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !parsed.pathname.startsWith("/emails/")
    ) {
      return null;
    }
    for (const segment of parsed.pathname.split("/")) {
      if (decodeURIComponent(segment) === "..") return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function usableAsset(
  asset: CampaignTemplatePreviewAsset,
): boolean {
  return (
    (asset.status === "ready" || asset.status === "source_missing") &&
    HOSTED_PREVIEW_MIME_TYPES.has(asset.mime_type) &&
    Number.isInteger(asset.width) &&
    asset.width > 0 &&
    Number.isInteger(asset.height) &&
    asset.height > 0 &&
    Number.isInteger(asset.size_bytes) &&
    asset.size_bytes > 0
  );
}

export function campaignTemplatePreviewUrl(
  template: Pick<
    CampaignTemplate,
    "preview_assets" | "thumbnail_url" | "source_provider"
  >,
  preferredVariants: readonly CampaignTemplatePreviewAsset["variant"][] = [
    "desktop",
    "card",
    "mobile",
  ],
  assetBase = POSTWAVE_ASSETS_BASE_URL,
  referencePreviewOrigin = REFERENCE_TEMPLATE_PREVIEW_ORIGIN,
): string | null {
  const assets = Array.isArray(template.preview_assets)
    ? template.preview_assets
    : [];
  for (const variant of preferredVariants) {
    const asset = assets.find(
      (candidate) => candidate.variant === variant && usableAsset(candidate),
    );
    if (!asset) continue;
    const trusted = trustedCampaignTemplatePreviewUrl(asset.url, assetBase);
    if (trusted) return trusted;
  }

  // Compatibility for older API releases. A legacy thumbnail is eligible only
  // when it is already under the exact configured Moosewave asset base.
  if (!template.thumbnail_url) return null;
  return (
    trustedCampaignTemplatePreviewUrl(template.thumbnail_url, assetBase) ??
    trustedReferenceTemplatePreviewUrl(
      template.thumbnail_url,
      template.source_provider,
      referencePreviewOrigin,
    )
  );
}

export function campaignTemplateCardPreviewUrl(
  template: Pick<
    CampaignTemplate,
    "preview_assets" | "thumbnail_url" | "source_provider"
  >,
  assetBase = POSTWAVE_ASSETS_BASE_URL,
  referencePreviewOrigin = REFERENCE_TEMPLATE_PREVIEW_ORIGIN,
): string | null {
  return campaignTemplatePreviewUrl(
    template,
    ["card", "desktop", "mobile"],
    assetBase,
    referencePreviewOrigin,
  );
}
