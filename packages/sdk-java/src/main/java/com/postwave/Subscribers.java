package com.moosewave;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.StringJoiner;

/** Subscriber CRUD. */
public class Subscribers {
    private final Moosewave client;

    Subscribers(Moosewave client) { this.client = client; }

    @SuppressWarnings("unchecked")
    public Map<String, Object> list(Map<String, String> query) {
        StringBuilder path = new StringBuilder("/api/v1/subscribers");
        if (query != null && !query.isEmpty()) {
            StringJoiner sj = new StringJoiner("&");
            query.forEach((k, v) -> sj.add(enc(k) + "=" + enc(v)));
            path.append('?').append(sj);
        }
        return (Map<String, Object>) client.request("GET", path.toString(), null);
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> get(String id) {
        return (Map<String, Object>) client.request("GET", "/api/v1/subscribers/" + enc(id), null);
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> create(Map<String, Object> attributes) {
        return (Map<String, Object>) client.request("POST", "/api/v1/subscribers", attributes);
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> update(String id, Map<String, Object> attributes) {
        return (Map<String, Object>) client.request("PATCH", "/api/v1/subscribers/" + enc(id), attributes);
    }

    public void delete(String id) {
        client.request("DELETE", "/api/v1/subscribers/" + enc(id), null);
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
