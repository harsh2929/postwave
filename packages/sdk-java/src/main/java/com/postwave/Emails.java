package com.moosewave;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/** The transactional email API. Inputs are Maps with the wire keys
 *  (from/to/cc/bcc/reply_to/subject/html/text/headers/tags/attachments/scheduled_at). */
public class Emails {
    private final Moosewave client;

    Emails(Moosewave client) { this.client = client; }

    /** Send one transactional email. Returns the {id, status} result. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> send(Map<String, Object> input) {
        if (input.get("html") == null && input.get("text") == null) {
            throw new IllegalArgumentException("send requires html or text");
        }
        return (Map<String, Object>) client.request("POST", "/api/v1/emails", input);
    }

    /** Send up to 100 distinct emails in one call. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> sendBatch(List<Map<String, Object>> emails) {
        return (Map<String, Object>) client.request("POST", "/api/v1/emails/batch", Map.of("emails", emails));
    }

    /** Fetch one email's status. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> get(String id) {
        return (Map<String, Object>) client.request("GET", "/api/v1/emails/" + enc(id), null);
    }

    /** List recent transactional sends. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> list(Integer limit) {
        String path = "/api/v1/emails" + (limit != null ? "?limit=" + limit : "");
        return (Map<String, Object>) client.request("GET", path, null);
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
