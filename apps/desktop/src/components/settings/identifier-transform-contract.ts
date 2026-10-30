import type {
  IdentifierTransformConfig,
  IdentifierTransformPreviewResult,
} from "../../lib/api-client";

export function parseIdentifierTransformConfig(
  value: unknown,
): IdentifierTransformConfig | null {
  if (!value || typeof value !== "object") return null;
  const config = value as Record<string, unknown>;
  if (
    typeof config.email_normalize_dots !== "boolean" ||
    typeof config.email_normalize_plus !== "boolean" ||
    typeof config.phone_e164_format !== "boolean" ||
    typeof config.phone_default_region !== "string"
  ) {
    return null;
  }
  return config as unknown as IdentifierTransformConfig;
}

export function parseIdentifierTransformPreview(
  value: unknown,
): IdentifierTransformPreviewResult | null {
  if (!value || typeof value !== "object") return null;
  const preview = value as Record<string, unknown>;
  if (
    !parseIdentifierTransformConfig(preview.config) ||
    typeof preview.email_input !== "string" ||
    typeof preview.email_output !== "string" ||
    typeof preview.email_changed !== "boolean" ||
    !Array.isArray(preview.phones) ||
    !preview.phones.every(
      (phone) =>
        Boolean(phone) &&
        typeof phone === "object" &&
        typeof phone.key === "string" &&
        typeof phone.input === "string" &&
        typeof phone.output === "string" &&
        typeof phone.changed === "boolean",
    )
  ) {
    return null;
  }
  return preview as unknown as IdentifierTransformPreviewResult;
}
