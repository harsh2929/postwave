package com.moosewave;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Official Java client for the Moosewave API (JDK 11+; no external dependencies).
 *
 * <pre>{@code
 * Moosewave client = new Moosewave("pw_live_…");
 * Map<String,Object> res = client.emails.send(Map.of(
 *     "from", "you@you.com", "to", List.of("user@example.com"),
 *     "subject", "Hi", "html", "<b>Hello</b>"));
 * }</pre>
 */
public class Moosewave {
    private final String apiKey;
    private final String baseUrl;
    private final HttpClient http;
    private final int maxRetries;

    public final Emails emails;
    public final Subscribers subscribers;

    public Moosewave(String apiKey) {
        this(apiKey, "https://api.moosewave.com", 3);
    }

    public Moosewave(String apiKey, String baseUrl, int maxRetries) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.maxRetries = maxRetries;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
        this.emails = new Emails(this);
        this.subscribers = new Subscribers(this);
    }

    /** Performs a JSON request with auth, idempotency (for writes), and
     *  retry-on-429/5xx. Returns the decoded body (Map/List/etc.) or null. */
    Object request(String method, String path, Object body) {
        String json = body == null ? null : Json.encode(body);
        String idem = List.of("POST", "PUT", "PATCH", "DELETE").contains(method)
                ? "java_" + UUID.randomUUID() : null;

        PostwaveError last = null;
        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) sleep(backoff(attempt));
            try {
                HttpRequest.Builder b = HttpRequest.newBuilder()
                        .uri(URI.create(baseUrl + path))
                        .header("Authorization", "Bearer " + apiKey)
                        .header("Accept", "application/json")
                        .header("User-Agent", "postwave-java/0.1.0")
                        .timeout(Duration.ofSeconds(30));
                if (idem != null) b.header("Idempotency-Key", idem);
                if (json != null) {
                    b.header("Content-Type", "application/json");
                    b.method(method, HttpRequest.BodyPublishers.ofString(json));
                } else {
                    b.method(method, HttpRequest.BodyPublishers.noBody());
                }
                HttpResponse<String> resp = http.send(b.build(), HttpResponse.BodyHandlers.ofString());
                int sc = resp.statusCode();
                if (sc >= 200 && sc < 300) {
                    String rb = resp.body();
                    return (rb == null || rb.isEmpty()) ? null : Json.decode(rb);
                }
                PostwaveError err = parseError(sc, resp.body());
                if (sc == 429 || (sc >= 500 && sc != 501)) { last = err; continue; }
                throw err;
            } catch (IOException | InterruptedException e) {
                last = new PostwaveError(0, "transport", e.getMessage(), null);
                if (attempt >= maxRetries) throw last;
            }
        }
        throw last != null ? last : new PostwaveError(0, "exhausted", "exhausted retries", null);
    }

    @SuppressWarnings("unchecked")
    private PostwaveError parseError(int status, String body) {
        try {
            Map<String, Object> env = Json.decodeObject(body);
            Object e = env.get("error");
            if (e instanceof Map) {
                Map<String, Object> m = (Map<String, Object>) e;
                return new PostwaveError(status, str(m.get("code")), str(m.get("message")), str(m.get("request_id")));
            }
        } catch (RuntimeException ignored) {
            // fall through to a bare status error
        }
        return new PostwaveError(status, null, "request failed", null);
    }

    private static String str(Object o) { return o == null ? null : o.toString(); }

    private static long backoff(int attempt) {
        return Math.min(200L * (long) Math.pow(2, attempt - 1), 5000L);
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
