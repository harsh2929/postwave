/**
 * Auth-surface illustrations — separate from the per-tab hero registry
 * so the auth chunks (signin/signup/etc.) don't pull in the entire 35-
 * image hero index just to reference 4 photos.
 *
 * Importing the WebP through Vite returns a hashed URL; auth pages
 * render the appropriate one for their state.
 */

import signin from "../assets/illustrations/auth-signin.webp";
import signup from "../assets/illustrations/auth-signup.webp";
import magicSent from "../assets/illustrations/auth-magic-sent.webp";
import magicReturn from "../assets/illustrations/auth-magic-return.webp";

export const AUTH_ASSETS = {
  signin,
  signup,
  magicSent,
  magicReturn,
} as const;
