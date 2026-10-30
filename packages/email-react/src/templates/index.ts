// SPDX-License-Identifier: MIT
//
// @postwave/email-react/templates — production-ready starter templates
// for the most common email types. Each template is a pure React
// component that compiles to MJML via renderToMjml; customize props
// like brand color, logo URL, recipient name, and CTA URL at the call
// site without forking the template.
//
// Templates are organised by category:
//   - lifecycle:   welcome, double_optin, verify, password_reset
//   - commerce:    order_confirmation, shipping_update, abandoned_cart, receipt
//   - engagement:  newsletter, weekly_digest, product_announcement, reengagement
//   - operations:  invoice, trial_ending, payment_failed
//
// All templates take a single Props object so they're TypeScript-safe
// and codegen-friendly. They share the BrandProps base for color/logo
// theming.

export * from "./brand.js";
export * from "./lifecycle/welcome.js";
export * from "./lifecycle/double-optin.js";
export * from "./lifecycle/verify-email.js";
export * from "./lifecycle/password-reset.js";
export * from "./commerce/order-confirmation.js";
export * from "./commerce/shipping-update.js";
export * from "./commerce/abandoned-cart.js";
export * from "./commerce/receipt.js";
export * from "./engagement/newsletter.js";
export * from "./engagement/weekly-digest.js";
export * from "./engagement/product-announcement.js";
export * from "./engagement/reengagement.js";
export * from "./operations/invoice.js";
export * from "./operations/trial-ending.js";
export * from "./operations/payment-failed.js";
