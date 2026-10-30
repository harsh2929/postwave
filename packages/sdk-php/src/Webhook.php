<?php
// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Moosewave;

/**
 * Webhook signature verifier. Mirrors the algorithm documented in
 * docs-site/content/webhooks/signing.mdx (and the Go canonical
 * implementation in apps/api/internal/outbound_webhooks/signers.go).
 *
 * HMAC-SHA256 is the only algorithm verified here; ECDSA / Ed25519
 * verification requires the openssl extension and is left to a
 * future iteration. For most customers HMAC is enough.
 */
final class Webhook
{
    /**
     * Verify the X-Postwave-Signature header against body + secret.
     * Returns true on a valid signature within the tolerance window.
     *
     * Format: "t=<unix_seconds>,v1=<hex_hmac_sha256>".
     *
     * @param int $toleranceSeconds  Reject if |now - t| exceeds this. Default 5min.
     */
    public static function verify(
        string $header,
        string $body,
        string $secret,
        int $toleranceSeconds = 300
    ): bool {
        if ($toleranceSeconds < 0) {
            return false;
        }
        $ts = null;
        $signatures = [];
        foreach (explode(',', $header) as $part) {
            $part = trim($part);
            if (str_starts_with($part, 't=')) {
                if ($ts !== null) {
                    return false;
                }
                $ts = substr($part, 2);
            } elseif (str_starts_with($part, 'v1=')) {
                $signatures[] = substr($part, 3);
            }
        }
        if ($ts === null || !ctype_digit($ts) || $signatures === []) {
            return false;
        }
        $tsInt = (int) $ts;
        if ($tsInt === 0) {
            return false;
        }
        if ($toleranceSeconds > 0 && abs(time() - $tsInt) > $toleranceSeconds) {
            return false;
        }
        $want = hash_hmac('sha256', $ts . '.' . $body, $secret);
        foreach ($signatures as $signature) {
            if (strlen($signature) === 64 && ctype_xdigit($signature) &&
                hash_equals($want, strtolower($signature))) {
                return true;
            }
        }
        return false;
    }
}
