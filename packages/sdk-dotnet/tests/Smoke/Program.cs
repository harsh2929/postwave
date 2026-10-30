using System;
using System.Text;
using Moosewave;

internal static class Smoke
{
    private static int Main()
    {
        const string secret = "owhsec_x";
        byte[] body = Encoding.UTF8.GetBytes("{\"event\":\"email.delivered\"}");
        const long now = 1_784_764_800;
        string sig = Webhook.ComputeHeader(secret, now, body);

        if (!Webhook.VerifyAt(sig, secret, body, now, 300)) return Fail("valid signature");
        if (Webhook.VerifyAt(sig, "wrong", body, now, 300)) return Fail("wrong secret rejected");
        if (Webhook.VerifyAt("garbage", secret, body, now, 300)) return Fail("malformed header rejected");
        if (Webhook.VerifyAt(sig, secret, body, now + 301, 300)) return Fail("stale signature rejected");
        string rotating = $"t={now},v1={new string('0', 64)},v1={Webhook.Compute(secret, now.ToString(), body)}";
        if (!Webhook.VerifyAt(rotating, secret, body, now, 300)) return Fail("rotation signature");
        if (Webhook.VerifyAt($"{sig},t={now}", secret, body, now, 300)) return Fail("duplicate timestamp");

        // Construct a client + input (exercises the public surface compiles/runs).
        var client = new PostwaveClient("pw_test");
        _ = client.Emails;
        _ = new SendEmailInput { To = new[] { "a@b.com" }, Subject = "Hi", Html = "<b>x</b>" };

        Console.WriteLine(".NET SDK smoke: OK");
        return 0;
    }

    private static int Fail(string name)
    {
        Console.Error.WriteLine("FAIL: " + name);
        return 1;
    }
}
