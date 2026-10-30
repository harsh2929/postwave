package com.moosewave;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Dependency-free smoke test (run after javac in CI). Exercises the pure
 *  logic that doesn't need a live server: webhook HMAC + JSON round-trip. */
public class Smoke {
    public static void main(String[] args) {
        String secret = "owhsec_x";
        byte[] body = "{\"event\":\"email.delivered\"}".getBytes(StandardCharsets.UTF_8);
        long now = 1_784_764_800L;
        String sig = Webhook.computeHeader(secret, now, body);
        check(Webhook.verifyAt(sig, secret, body, now, 300), "valid signature");
        check(!Webhook.verifyAt(sig, "wrong", body, now, 300), "wrong secret rejected");
        check(!Webhook.verifyAt("garbage", secret, body, now, 300), "malformed header rejected");
        check(!Webhook.verifyAt(sig, secret, body, now + 301, 300), "stale signature rejected");
        String rotating = "t=" + now + ",v1=" + "0".repeat(64)
                + ",v1=" + Webhook.compute(secret, Long.toString(now), body);
        check(Webhook.verifyAt(rotating, secret, body, now, 300), "rotation signature");
        check(!Webhook.verifyAt(sig + ",t=" + now, secret, body, now, 300), "duplicate timestamp");

        Map<String, Object> m = new LinkedHashMap<>();
        m.put("to", List.of("a@b.com"));
        m.put("n", 5);
        m.put("ok", true);
        m.put("nil", null);
        String json = Json.encode(m);
        check(json.contains("\"to\""), "encode object");
        check(!json.contains("nil"), "null values omitted");
        Object back = Json.decode(json);
        check(back instanceof Map, "decode object");
        check(Json.decode("[1,2,3]") instanceof List, "decode array");

        System.out.println("Java SDK smoke: OK");
    }

    private static void check(boolean cond, String name) {
        if (!cond) {
            System.err.println("FAIL: " + name);
            System.exit(1);
        }
    }
}
