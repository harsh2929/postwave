package com.moosewave;

/** Thrown for any non-2xx API response. Carries the HTTP status and the
 *  server's error envelope ({"error": {code, message, request_id}}). */
public class PostwaveError extends RuntimeException {
    public final int status;
    public final String code;
    public final String requestId;

    public PostwaveError(int status, String code, String message, String requestId) {
        super(message != null ? message : "postwave: http " + status);
        this.status = status;
        this.code = code;
        this.requestId = requestId;
    }
}
