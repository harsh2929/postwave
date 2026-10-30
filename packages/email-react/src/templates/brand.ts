// SPDX-License-Identifier: MIT
//
// Shared brand props applied across every starter template. Centralised
// here so a tenant can establish a brand once and pass the same object
// to every template type.

export interface BrandProps {
  /** Product / company name shown in headers + footers. */
  name: string;
  /** Primary brand color (hex). Used for CTA buttons + accent text. */
  brandColor?: string;
  /** Absolute URL to the brand logo (PNG/SVG). Renders inside a 600px-wide hero. */
  logoUrl?: string;
  /** Postal address. Required by CAN-SPAM/CASL; rendered in footer. */
  address?: string;
  /** Absolute URL to the company website. */
  websiteUrl?: string;
  /** Customer-support email shown in the footer. */
  supportEmail?: string;
}

/**
 * Sensible defaults so a template renders without configuration
 * (useful for previews + tests). Real sends always pass concrete values.
 */
export const defaultBrand: Required<BrandProps> = {
  name: "Acme",
  brandColor: "#5b21b6",
  logoUrl: "",
  address: "123 Main St, San Francisco, CA 94102",
  websiteUrl: "https://example.com",
  supportEmail: "support@example.com",
};

/**
 * mergeBrand fills in defaults for any unset brand fields. Callers can
 * pass a partial object and still get a usable template.
 */
export function mergeBrand(p: BrandProps): Required<BrandProps> {
  return {
    name: p.name,
    brandColor: p.brandColor || defaultBrand.brandColor,
    logoUrl: p.logoUrl || defaultBrand.logoUrl,
    address: p.address || defaultBrand.address,
    websiteUrl: p.websiteUrl || defaultBrand.websiteUrl,
    supportEmail: p.supportEmail || defaultBrand.supportEmail,
  };
}
