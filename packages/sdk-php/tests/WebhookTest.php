<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Webhook;

final class WebhookTest extends TestCase
{
    public function testVerifyAcceptsValidSignature(): void
    {
        $secret = 'owhsec_test';
        $body = '{"event":"campaign.sent"}';
        $ts = (string) time();
        $sig = hash_hmac('sha256', $ts . '.' . $body, $secret);
        $header = "t=$ts,v1=$sig";

        $this->assertTrue(Webhook::verify($header, $body, $secret, 300));
    }

    public function testVerifyRejectsTamperedBody(): void
    {
        $secret = 'owhsec_test';
        $body = '{"event":"campaign.sent"}';
        $ts = (string) time();
        $sig = hash_hmac('sha256', $ts . '.' . $body, $secret);
        $header = "t=$ts,v1=$sig";

        $this->assertFalse(Webhook::verify($header, '{"event":"tampered"}', $secret, 300));
    }

    public function testVerifyRejectsOldTimestamp(): void
    {
        $secret = 'owhsec_test';
        $body = '{}';
        $tsOld = (string) (time() - 600);
        $sig = hash_hmac('sha256', $tsOld . '.' . $body, $secret);
        $header = "t=$tsOld,v1=$sig";

        $this->assertFalse(Webhook::verify($header, $body, $secret, 300));
    }

    public function testVerifyRejectsMissingFields(): void
    {
        $this->assertFalse(Webhook::verify('t=123', 'body', 'secret', 0));
        $this->assertFalse(Webhook::verify('v1=abc', 'body', 'secret', 0));
        $this->assertFalse(Webhook::verify('', 'body', 'secret', 0));
    }

    public function testVerifyAcceptsAnyMatchingV1DuringRotation(): void
    {
        $secret = 'owhsec_test';
        $body = '{}';
        $ts = (string) time();
        $good = hash_hmac('sha256', $ts . '.' . $body, $secret);

        $this->assertTrue(Webhook::verify(
            "t=$ts,v1=" . str_repeat('0', 64) . ",v1=$good",
            $body,
            $secret,
            300
        ));
    }

    public function testVerifyRejectsAmbiguousTimestampAndNegativeTolerance(): void
    {
        $secret = 'owhsec_test';
        $body = '{}';
        $ts = (string) time();
        $good = hash_hmac('sha256', $ts . '.' . $body, $secret);

        $this->assertFalse(Webhook::verify(
            "t=$ts,t=$ts,v1=$good",
            $body,
            $secret,
            300
        ));
        $this->assertFalse(Webhook::verify("t=$ts,v1=$good", $body, $secret, -1));
    }
}
