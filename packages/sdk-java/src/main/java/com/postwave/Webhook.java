package com.moosewave;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Canonical timestamped outbound-webhook HMAC verification. */
public final class Webhook {
    private Webhook() {}

    /** Verify with the recommended five-minute replay window. */
    public static boolean verify(String header, String secret, byte[] body) {
        return verifyAt(header, secret, body, Instant.now().getEpochSecond(), 300);
    }

    /** Deterministic verifier for tests or a custom replay tolerance. */
    public static boolean verifyAt(
            String header, String secret, byte[] body, long nowUnixSeconds, long toleranceSeconds) {
        if (header == null || header.isEmpty() || secret == null || secret.isEmpty()
                || nowUnixSeconds < 0 || toleranceSeconds < 0) return false;
        String timestamp = null;
        List<String> signatures = new ArrayList<>();
        for (String rawPart : header.split(",")) {
            String[] pair = rawPart.trim().split("=", 2);
            if (pair.length != 2) continue;
            if ("t".equals(pair[0])) {
                if (timestamp != null) return false;
                timestamp = pair[1];
            }
            if ("v1".equals(pair[0])) signatures.add(pair[1]);
        }
        if (timestamp == null || !timestamp.matches("[0-9]+") || signatures.isEmpty()) return false;
        final long signedAt;
        try {
            signedAt = Long.parseLong(timestamp);
        } catch (NumberFormatException ignored) {
            return false;
        }
        if (signedAt <= 0) return false;
        long skew = nowUnixSeconds >= signedAt
                ? nowUnixSeconds - signedAt
                : signedAt - nowUnixSeconds;
        if (toleranceSeconds > 0 && skew > toleranceSeconds) {
            return false;
        }
        String expected = compute(secret, timestamp, body);
        for (String supplied : signatures) {
            if (constantTimeEquals(supplied.toLowerCase(), expected)) return true;
        }
        return false;
    }

    /** Lowercase v1 HMAC of timestamp + "." + exact raw body. */
    public static String compute(String secret, String timestamp, byte[] body) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            mac.update((timestamp + ".").getBytes(StandardCharsets.US_ASCII));
            byte[] out = mac.doFinal(body);
            StringBuilder sb = new StringBuilder(out.length * 2);
            for (byte b : out) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException("HMAC failed", e);
        }
    }

    public static String computeHeader(String secret, long timestamp, byte[] body) {
        String text = Long.toString(timestamp);
        return "t=" + text + ",v1=" + compute(secret, text, body);
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a.length() != b.length()) return false;
        int result = 0;
        for (int i = 0; i < a.length(); i++) result |= a.charAt(i) ^ b.charAt(i);
        return result == 0;
    }
}
