// SPDX-License-Identifier: AGPL-3.0-only

const MAX_RETURN_PATH_BYTES = 2_048;
const MAX_TEMPLATE_ID_BYTES = 255;
export const CAMPAIGN_TEMPLATE_RETURN_FOCUS_PARAM = "focus_template";

function boundedPlainValue(value: string, maxBytes: number): boolean {
  return (
    value.length > 0 &&
    !/[\u0000-\u001f\u007f\\]/.test(value) &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

export function campaignTemplateCardElementID(templateId: string): string {
  return `campaign-template-card-${encodeURIComponent(templateId)}`;
}

export function validCampaignTemplateFocusToken(
  value: string | null | undefined,
): string | null {
  return value && boundedPlainValue(value, MAX_TEMPLATE_ID_BYTES)
    ? value
    : null;
}

/**
 * Accept only a bounded same-origin templates-gallery path. The caller may
 * safely use the returned value as a Next href without creating an open
 * redirect or a javascript/data URL sink.
 */
export function parseCampaignTemplateReturnPath(
  value: string | null | undefined,
): string | null {
  if (
    !value ||
    !boundedPlainValue(value, MAX_RETURN_PATH_BYTES) ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return null;
  }
  try {
    const parsed = new URL(value, "https://postwave.invalid");
    if (
      parsed.origin !== "https://postwave.invalid" ||
      parsed.pathname !== "/app/templates" ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export function buildCampaignTemplateDetailHref(
  templateId: string,
  galleryPath: string,
): string {
  const fallback = "/app/templates";
  const parsedGallery =
    parseCampaignTemplateReturnPath(galleryPath) ?? fallback;
  const galleryURL = new URL(parsedGallery, "https://postwave.invalid");
  galleryURL.searchParams.set(CAMPAIGN_TEMPLATE_RETURN_FOCUS_PARAM, templateId);
  const returnPath = `${galleryURL.pathname}${galleryURL.search}`;
  const params = new URLSearchParams({ return_to: returnPath });
  return `/app/templates/${encodeURIComponent(templateId)}?${params.toString()}`;
}
