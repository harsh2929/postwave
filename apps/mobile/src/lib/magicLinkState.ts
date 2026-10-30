/**
 * Backward-compatible module name for the unified v1 auth-link pending-state
 * implementation. Magic-link and password-reset flows intentionally share
 * one contract and differ only by SecureStore key and TTL.
 */
export * from "./authLinkState";
