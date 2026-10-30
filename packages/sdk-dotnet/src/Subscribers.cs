using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Moosewave
{
    /// <summary>Subscriber CRUD.</summary>
    public sealed class Subscribers
    {
        private readonly PostwaveClient _client;

        internal Subscribers(PostwaveClient client) => _client = client;

        public Task<JsonElement> ListAsync(IDictionary<string, string>? query = null, CancellationToken ct = default)
        {
            var path = new StringBuilder("/api/v1/subscribers");
            if (query != null && query.Count > 0)
            {
                bool first = true;
                foreach (var kv in query)
                {
                    path.Append(first ? '?' : '&');
                    first = false;
                    path.Append(WebUtility.UrlEncode(kv.Key)).Append('=').Append(WebUtility.UrlEncode(kv.Value));
                }
            }
            return _client.RequestAsync(HttpMethod.Get, path.ToString(), null, ct);
        }

        public Task<JsonElement> GetAsync(string id, CancellationToken ct = default)
            => _client.RequestAsync(HttpMethod.Get, "/api/v1/subscribers/" + WebUtility.UrlEncode(id), null, ct);

        public Task<JsonElement> CreateAsync(object attributes, CancellationToken ct = default)
            => _client.RequestAsync(HttpMethod.Post, "/api/v1/subscribers", attributes, ct);

        public Task<JsonElement> UpdateAsync(string id, object attributes, CancellationToken ct = default)
            => _client.RequestAsync(new HttpMethod("PATCH"), "/api/v1/subscribers/" + WebUtility.UrlEncode(id), attributes, ct);

        public Task<JsonElement> DeleteAsync(string id, CancellationToken ct = default)
            => _client.RequestAsync(HttpMethod.Delete, "/api/v1/subscribers/" + WebUtility.UrlEncode(id), null, ct);
    }
}
