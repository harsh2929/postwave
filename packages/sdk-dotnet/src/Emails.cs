using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace Moosewave
{
    /// <summary>One file on a message. Set exactly one of Content (base64) or Path.</summary>
    public sealed class Attachment
    {
        [JsonPropertyName("filename")] public string Filename { get; set; } = "";
        [JsonPropertyName("content")] public string? Content { get; set; }
        [JsonPropertyName("path")] public string? Path { get; set; }
        [JsonPropertyName("content_type")] public string? ContentType { get; set; }
        [JsonPropertyName("content_id")] public string? ContentId { get; set; }
    }

    /// <summary>A per-message tag.</summary>
    public sealed class Tag
    {
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("value")] public string Value { get; set; } = "";
    }

    /// <summary>Body of a send. One of Html/Text is required.</summary>
    public sealed class SendEmailInput
    {
        [JsonPropertyName("from")] public string? From { get; set; }
        [JsonPropertyName("to")] public IList<string> To { get; set; } = new List<string>();
        [JsonPropertyName("cc")] public IList<string>? Cc { get; set; }
        [JsonPropertyName("bcc")] public IList<string>? Bcc { get; set; }
        [JsonPropertyName("reply_to")] public IList<string>? ReplyTo { get; set; }
        [JsonPropertyName("subject")] public string Subject { get; set; } = "";
        [JsonPropertyName("html")] public string? Html { get; set; }
        [JsonPropertyName("text")] public string? Text { get; set; }
        [JsonPropertyName("headers")] public IDictionary<string, string>? Headers { get; set; }
        [JsonPropertyName("tags")] public IList<Tag>? Tags { get; set; }
        [JsonPropertyName("attachments")] public IList<Attachment>? Attachments { get; set; }
        [JsonPropertyName("scheduled_at")] public string? ScheduledAt { get; set; }
    }

    /// <summary>The transactional email API.</summary>
    public sealed class Emails
    {
        private readonly PostwaveClient _client;

        internal Emails(PostwaveClient client) => _client = client;

        /// <summary>Send one transactional email.</summary>
        public Task<JsonElement> SendAsync(SendEmailInput input, CancellationToken ct = default)
            => _client.RequestAsync(HttpMethod.Post, "/api/v1/emails", input, ct);

        /// <summary>Send up to 100 distinct emails in one call.</summary>
        public Task<JsonElement> SendBatchAsync(IEnumerable<SendEmailInput> emails, CancellationToken ct = default)
            => _client.RequestAsync(HttpMethod.Post, "/api/v1/emails/batch", new Dictionary<string, object> { ["emails"] = emails }, ct);

        /// <summary>Fetch one email's status.</summary>
        public Task<JsonElement> GetAsync(string id, CancellationToken ct = default)
            => _client.RequestAsync(HttpMethod.Get, "/api/v1/emails/" + WebUtility.UrlEncode(id), null, ct);

        /// <summary>List recent transactional sends.</summary>
        public Task<JsonElement> ListAsync(int? limit = null, CancellationToken ct = default)
            => _client.RequestAsync(HttpMethod.Get, "/api/v1/emails" + (limit.HasValue ? "?limit=" + limit.Value : ""), null, ct);
    }
}
