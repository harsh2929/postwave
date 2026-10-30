using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Moosewave
{
    /// <summary>Canonical timestamped outbound-webhook HMAC verification.</summary>
    public static class Webhook
    {
        public static bool Verify(string? header, string secret, byte[] body)
        {
            return VerifyAt(header, secret, body, DateTimeOffset.UtcNow.ToUnixTimeSeconds(), 300);
        }

        public static bool VerifyAt(
            string? header,
            string secret,
            byte[] body,
            long nowUnixSeconds,
            long toleranceSeconds)
        {
            if (string.IsNullOrEmpty(header) || string.IsNullOrEmpty(secret)
                || nowUnixSeconds < 0 || toleranceSeconds < 0) return false;
            string? timestamp = null;
            var signatures = new List<string>();
            foreach (string rawPart in header!.Split(','))
            {
                string[] pair = rawPart.Trim().Split(new[] { '=' }, 2);
                if (pair.Length != 2) continue;
                if (pair[0] == "t")
                {
                    if (timestamp != null) return false;
                    timestamp = pair[1];
                }
                if (pair[0] == "v1") signatures.Add(pair[1]);
            }
            if (
                timestamp == null ||
                signatures.Count == 0 ||
                !long.TryParse(timestamp, NumberStyles.None, CultureInfo.InvariantCulture, out long signedAt)
            ) return false;
            if (signedAt <= 0) return false;
            long skew = nowUnixSeconds >= signedAt
                ? nowUnixSeconds - signedAt
                : signedAt - nowUnixSeconds;
            if (toleranceSeconds > 0 && skew > toleranceSeconds) {
                return false;
            }
            string expected = Compute(secret, timestamp, body);
            foreach (string supplied in signatures)
            {
                if (supplied.Length != expected.Length) continue;
                if (CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(supplied.ToLowerInvariant()),
                    Encoding.ASCII.GetBytes(expected))) return true;
            }
            return false;
        }

        public static string Compute(string secret, string timestamp, byte[] body)
        {
            using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
            byte[] prefix = Encoding.ASCII.GetBytes(timestamp + ".");
            byte[] signed = new byte[prefix.Length + body.Length];
            Buffer.BlockCopy(prefix, 0, signed, 0, prefix.Length);
            Buffer.BlockCopy(body, 0, signed, prefix.Length, body.Length);
            byte[] hash = hmac.ComputeHash(signed);
            var output = new StringBuilder(hash.Length * 2);
            foreach (byte value in hash) output.Append(value.ToString("x2"));
            return output.ToString();
        }

        public static string ComputeHeader(string secret, long timestamp, byte[] body)
        {
            string text = timestamp.ToString(CultureInfo.InvariantCulture);
            return $"t={text},v1={Compute(secret, text, body)}";
        }
    }
}
