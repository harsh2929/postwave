<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Resources\AudiencesResource;

/**
 * Verb/path/body contract tests for AudiencesResource (SUB-033 lookalike).
 *
 * The gateway (apps/api/internal/audiences/handlers.go) mounts exactly:
 *   POST   /api/v1/audiences/lookalike              (write:subscribers)
 *   GET    /api/v1/audiences/lookalike/{id}          (read:subscribers)
 *   GET    /api/v1/audiences/lookalike/{id}/members  (read:subscribers)
 *   DELETE /api/v1/audiences/lookalike/{id}          (write:subscribers)
 * There is deliberately NO list route (GET /api/v1/audiences/lookalike).
 *
 * The PHP transport (Client::rawRequest) is private and curl-backed, so —
 * as with ListsResourceContractTest — these assert the verb+path+body
 * shaping against the resource source rather than at runtime.
 */
final class AudiencesResourceTest extends TestCase
{
    private static function source(): string
    {
        return file_get_contents((new \ReflectionClass(AudiencesResource::class))->getFileName());
    }

    public function testClientExposesAudiencesResource(): void
    {
        $client = new Client('pw_test_resource_surface');
        $this->assertInstanceOf(AudiencesResource::class, $client->audiences);
    }

    public function testSurfaceMatchesGateway(): void
    {
        foreach (['generate', 'get', 'members', 'discard'] as $method) {
            $this->assertTrue(
                method_exists(AudiencesResource::class, $method),
                "AudiencesResource is missing $method()"
            );
        }
    }

    public function testNoListMethod(): void
    {
        // The gateway exposes no GET /api/v1/audiences/lookalike (no list route).
        $this->assertFalse(
            method_exists(AudiencesResource::class, 'list'),
            'AudiencesResource::list() must not exist — the gateway has no list route'
        );
    }

    public function testGeneratePostsToLookalike(): void
    {
        $this->assertMatchesRegularExpression(
            "/request\\(\\s*'POST',\\s*'\\/api\\/v1\\/audiences\\/lookalike',\\s*\\\$input\\s*\\)/",
            self::source(),
            'generate must POST $input to /api/v1/audiences/lookalike'
        );
    }

    public function testGetUsesEncodedIdSegment(): void
    {
        $this->assertMatchesRegularExpression(
            "/request\\(\\s*'GET',\\s*'\\/api\\/v1\\/audiences\\/lookalike\\/'\\s*\\.\\s*IntegrationsResource::pathSegment/",
            self::source(),
            'get must GET /api/v1/audiences/lookalike/{id} with an encoded id segment'
        );
    }

    public function testMembersUsesEncodedIdAndMembersSuffix(): void
    {
        $this->assertMatchesRegularExpression(
            "/IntegrationsResource::pathSegment\\([^)]*\\)\\s*\\.\\s*'\\/members'/",
            self::source(),
            'members must GET /api/v1/audiences/lookalike/{id}/members'
        );
        // page / per_page are passed as a query array.
        $this->assertStringContainsString("\$query['page']", self::source());
        $this->assertStringContainsString("\$query['per_page']", self::source());
    }

    public function testDiscardDeletesLookalike(): void
    {
        $this->assertMatchesRegularExpression(
            "/request\\(\\s*'DELETE',\\s*'\\/api\\/v1\\/audiences\\/lookalike\\/'/",
            self::source(),
            'discard must DELETE /api/v1/audiences/lookalike/{id}'
        );
    }
}
