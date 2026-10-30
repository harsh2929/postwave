<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Resources\AIComposeResource;

/**
 * Verb/path/body contract tests for AIComposeResource.
 *
 * The gateway (apps/api/internal/aicompose/handlers.go) mounts exactly:
 *   POST /api/v1/ai/compose/broadcast   (write:campaigns)
 *   POST /api/v1/ai/compose/variants    (write:campaigns)
 *
 * The PHP transport (Client::rawRequest) is private and curl-backed, so —
 * as with ListsResourceContractTest — these assert the verb+path+body
 * shaping against the resource source rather than at runtime.
 */
final class AIComposeResourceTest extends TestCase
{
    private static function source(): string
    {
        return file_get_contents((new \ReflectionClass(AIComposeResource::class))->getFileName());
    }

    public function testClientExposesAiComposeResource(): void
    {
        $client = new Client('pw_test_resource_surface');
        $this->assertInstanceOf(AIComposeResource::class, $client->aiCompose);
    }

    public function testSurfaceMatchesGateway(): void
    {
        foreach (['composeBroadcast', 'composeVariants'] as $method) {
            $this->assertTrue(
                method_exists(AIComposeResource::class, $method),
                "AIComposeResource is missing $method()"
            );
        }
    }

    public function testComposeBroadcastPostsInputToBroadcastEndpoint(): void
    {
        $this->assertMatchesRegularExpression(
            "/request\\(\\s*'POST',\\s*'\\/api\\/v1\\/ai\\/compose\\/broadcast',\\s*\\\$input\\s*\\)/",
            self::source(),
            'composeBroadcast must POST $input to /api/v1/ai/compose/broadcast'
        );
    }

    public function testComposeVariantsPostsInputToVariantsEndpoint(): void
    {
        $this->assertMatchesRegularExpression(
            "/request\\(\\s*'POST',\\s*'\\/api\\/v1\\/ai\\/compose\\/variants',\\s*\\\$input\\s*\\)/",
            self::source(),
            'composeVariants must POST $input to /api/v1/ai/compose/variants'
        );
    }
}
