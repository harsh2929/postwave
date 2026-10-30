using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Moosewave
{
    /// <summary>Thrown for any non-2xx API response.</summary>
    public sealed class PostwaveException : Exception
    {
        public int Status { get; }
        public string? Code { get; }
        public string? RequestId { get; }

        public PostwaveException(int status, string? code, string message, string? requestId)
            : base(message)
        {
            Status = status;
            Code = code;
            RequestId = requestId;
        }
    }

    /// <summary>
    /// Official .NET client for the Moosewave API.
    /// <code>
    /// var client = new PostwaveClient("pw_live_…");
    /// var res = await client.Emails.SendAsync(new SendEmailInput {
    ///     From = "you@you.com", To = new[] { "user@example.com" },
    ///     Subject = "Hi", Html = "&lt;b&gt;Hello&lt;/b&gt;" });
    /// </code>
    /// </summary>
    public sealed class PostwaveClient
    {
        private readonly HttpClient _http;
        private readonly string _apiKey;
        private readonly string _baseUrl;
        private readonly int _maxRetries;

        public Emails Emails { get; }
        public Subscribers Subscribers { get; }

        public PostwaveClient(string apiKey, string baseUrl = "https://api.moosewave.com", int maxRetries = 3, HttpClient? httpClient = null)
        {
            _apiKey = apiKey;
            _baseUrl = baseUrl.TrimEnd('/');
            _maxRetries = maxRetries;
            _http = httpClient ?? new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
            Emails = new Emails(this);
            Subscribers = new Subscribers(this);
        }

        internal static readonly JsonSerializerOptions JsonOpts = new JsonSerializerOptions
        {
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
        };

        internal async Task<JsonElement> RequestAsync(HttpMethod method, string path, object? body = null, CancellationToken ct = default)
        {
            string? json = body == null ? null : JsonSerializer.Serialize(body, JsonOpts);
            string? idempotencyKey =
                (method == HttpMethod.Post || method == HttpMethod.Put || method == HttpMethod.Delete || method.Method == "PATCH")
                    ? "net_" + Guid.NewGuid().ToString("N")
                    : null;

            PostwaveException? last = null;
            for (int attempt = 0; attempt <= _maxRetries; attempt++)
            {
                if (attempt > 0)
                    await Task.Delay(Backoff(attempt), ct).ConfigureAwait(false);

                using var req = new HttpRequestMessage(method, _baseUrl + path);
                req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + _apiKey);
                req.Headers.TryAddWithoutValidation("Accept", "application/json");
                req.Headers.TryAddWithoutValidation("User-Agent", "postwave-dotnet/0.1.0");
                if (idempotencyKey != null)
                    req.Headers.TryAddWithoutValidation("Idempotency-Key", idempotencyKey);
                if (json != null)
                    req.Content = new StringContent(json, Encoding.UTF8, "application/json");

                HttpResponseMessage resp;
                try
                {
                    resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
                }
                catch (HttpRequestException e)
                {
                    last = new PostwaveException(0, "transport", e.Message, null);
                    if (attempt >= _maxRetries) throw last;
                    continue;
                }

                string respBody = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                int sc = (int)resp.StatusCode;
                resp.Dispose();

                if (sc >= 200 && sc < 300)
                {
                    if (string.IsNullOrEmpty(respBody)) return default;
                    using var doc = JsonDocument.Parse(respBody);
                    return doc.RootElement.Clone();
                }

                var err = ParseError(sc, respBody);
                if (sc == (int)HttpStatusCode.TooManyRequests || (sc >= 500 && sc != 501))
                {
                    last = err;
                    continue;
                }
                throw err;
            }
            throw last ?? new PostwaveException(0, "exhausted", "exhausted retries", null);
        }

        private static PostwaveException ParseError(int status, string body)
        {
            try
            {
                using var doc = JsonDocument.Parse(body);
                if (doc.RootElement.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.Object)
                {
                    return new PostwaveException(
                        status,
                        e.TryGetProperty("code", out var c) ? c.GetString() : null,
                        e.TryGetProperty("message", out var m) ? (m.GetString() ?? "request failed") : "request failed",
                        e.TryGetProperty("request_id", out var r) ? r.GetString() : null);
                }
            }
            catch (JsonException)
            {
                // fall through to a bare status error
            }
            return new PostwaveException(status, null, "request failed", null);
        }

        private static TimeSpan Backoff(int attempt)
        {
            double ms = Math.Min(200.0 * Math.Pow(2, attempt - 1), 5000.0);
            return TimeSpan.FromMilliseconds(ms);
        }
    }
}
