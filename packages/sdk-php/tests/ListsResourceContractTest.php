<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Resources\ListsResource;

/**
 * Verb/path contract tests for ListsResource.
 *
 * The gateway (apps/api/internal/lists/lists.go) mounts exactly:
 *   GET    /api/v1/lists
 *   POST   /api/v1/lists
 *   PATCH  /api/v1/lists/{id}     (NOT PUT)
 *   DELETE /api/v1/lists/{id}
 *   GET    /api/v1/lists/{id}/subscribers
 * There is deliberately NO single-list `GET /api/v1/lists/{id}`.
 *
 * The PHP transport (Client::rawRequest) is private and curl-backed, so
 * there is no injectable seam to capture the verb at runtime. These tests
 * assert the verb+path contract against the resource source — the same
 * class of check that would have caught the PUT-vs-PATCH update bug and
 * the phantom single-list get().
 */
final class ListsResourceContractTest extends TestCase
{
    private static function source(): string
    {
        return file_get_contents((new \ReflectionClass(ListsResource::class))->getFileName());
    }

    public function testUpdateUsesPatchNotPut(): void
    {
        $src = self::source();

        // Regression: update() previously used PUT, but the gateway only
        // mounts PATCH /api/v1/lists/{id}.
        $this->assertMatchesRegularExpression(
            "/request\\(\\s*'PATCH',\\s*'\\/api\\/v1\\/lists\\/'/",
            $src,
            'ListsResource::update must call PATCH /api/v1/lists/{id} (gateway mounts PATCH, not PUT)'
        );
        $this->assertDoesNotMatchRegularExpression(
            "/request\\(\\s*'PUT',\\s*'\\/api\\/v1\\/lists\\/'/",
            $src,
            'ListsResource must not call PUT on /api/v1/lists/{id}; the gateway does not mount it'
        );
    }

    public function testNoSingleListGetMethod(): void
    {
        // Regression: get() called GET /api/v1/lists/{id}, which the
        // gateway does not expose (mirrors the TS SDK which omits get()).
        $this->assertFalse(
            method_exists(ListsResource::class, 'get'),
            'ListsResource::get() must not exist — the gateway has no GET /api/v1/lists/{id}'
        );

        $this->assertDoesNotMatchRegularExpression(
            "/request\\(\\s*'GET',\\s*'\\/api\\/v1\\/lists\\/'/",
            self::source(),
            'ListsResource must not GET a single list by id; no such gateway route exists'
        );
    }

    public function testSurfaceMatchesGateway(): void
    {
        foreach (['list', 'create', 'update', 'delete', 'forSubscriber'] as $method) {
            $this->assertTrue(
                method_exists(ListsResource::class, $method),
                "ListsResource is missing $method()"
            );
        }
    }
}
