<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;

final class WebhooksResourceContractTest extends TestCase
{
    public function testResourcesUseOnlyCanonicalWebhookRoutesAndDocumentReplayKeys(): void
    {
        $outbound = file_get_contents(__DIR__ . '/../src/Resources/WebhooksResource.php');
        $inbound = file_get_contents(__DIR__ . '/../src/Resources/InboundWebhooksResource.php');

        $this->assertIsString($outbound);
        $this->assertIsString($inbound);
        $this->assertStringContainsString('/api/v1/outbound-webhooks', $outbound);
        $this->assertStringNotContainsString("'/api/v1/webhooks", $outbound);
        $this->assertStringContainsString('/deliveries/', $outbound);
        $this->assertStringContainsString('Idempotency-Key', $outbound);
        $this->assertStringContainsString('/api/v1/inbound-webhooks', $inbound);
        $this->assertStringContainsString('/events/', $inbound);
        $this->assertStringContainsString('/triggers', $inbound);
        $this->assertStringContainsString('Idempotency-Key', $inbound);
    }
}
