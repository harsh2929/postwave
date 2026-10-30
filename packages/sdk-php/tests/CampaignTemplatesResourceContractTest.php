<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Resources\CampaignTemplatesResource;

final class CampaignTemplatesResourceContractTest extends TestCase
{
    private static function source(): string
    {
        $source = file_get_contents(
            (new \ReflectionClass(CampaignTemplatesResource::class))->getFileName()
        );
        return is_string($source) ? $source : '';
    }

    public function testClientExposesCampaignTemplateResource(): void
    {
        $client = new Client('pw_test_campaign_templates');
        $this->assertInstanceOf(
            CampaignTemplatesResource::class,
            $client->campaignTemplates
        );
    }

    public function testCoreCatalogDiscoveryLifecycleAndDesignMethodsExist(): void
    {
        foreach ([
            'list',
            'search',
            'get',
            'favorite',
            'unfavorite',
            'compare',
            'recordView',
            'recent',
            'clearRecent',
            'listCollections',
            'getCollection',
            'createCollection',
            'updateCollection',
            'replaceCollectionItems',
            'deleteCollection',
            'listSavedSearches',
            'getSavedSearch',
            'createSavedSearch',
            'updateSavedSearch',
            'deleteSavedSearch',
            'savedSearchResults',
            'create',
            'update',
            'archive',
            'restore',
            'delete',
            'listRevisions',
            'getRevision',
            'clone',
            'adapt',
            'generate',
            'createDesign',
            'listDesigns',
            'getDesign',
            'listDesignRevisions',
            'refineDesign',
            'retryDesign',
            'saveDesign',
            'createCampaignFromDesign',
            'archiveDesign',
            'createCampaign',
        ] as $method) {
            $this->assertTrue(
                method_exists(CampaignTemplatesResource::class, $method),
                "Missing CampaignTemplatesResource::$method"
            );
        }
    }

    public function testDurableRoutesReplacePermanentlyRetiredRoutes(): void
    {
        $source = self::source();
        $this->assertStringContainsString(
            "'/api/v1/campaign-template-designs'",
            $source
        );
        $this->assertStringNotContainsString(
            "campaign-templates/' . rawurlencode(\$templateId) . '/adapt",
            $source
        );
        $this->assertStringNotContainsString(
            "'/api/v1/campaign-templates/generate'",
            $source
        );
        $this->assertStringContainsString("'Idempotency-Key'", $source);
        $this->assertStringContainsString("'If-Match'", $source);
    }

    public function testDesignRecoveryListRejectsOutOfContractBoundsBeforeNetwork(): void
    {
        $client = new Client('pw_test_campaign_templates');

        foreach ([0, 51] as $limit) {
            try {
                $client->campaignTemplates->listDesigns($limit);
                $this->fail('Out-of-range design list limit must be rejected');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringContainsString(
                    'integer between 1 and 50',
                    $error->getMessage()
                );
            }
        }
        foreach ([
            ' cursor',
            'cursor ',
            "\u{00A0}cursor",
            str_repeat('x', 1025),
        ] as $cursor) {
            try {
                $client->campaignTemplates->listDesigns(null, $cursor);
                $this->fail('Malformed design list cursor must be rejected');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringContainsString(
                    'at most 1024 UTF-8 bytes',
                    $error->getMessage()
                );
            }
        }

        $source = self::source();
        $this->assertMatchesRegularExpression(
            "/function listDesigns[\\s\\S]+?'GET',[\\s\\S]+?'\\/api\\/v1\\/campaign-template-designs'/",
            $source
        );
    }

    public function testUnsafeEtagsAndReplayKeysFailBeforeNetwork(): void
    {
        $client = new Client('pw_test_campaign_templates');

        try {
            $client->campaignTemplates->update('tpl_1', [], '*');
            $this->fail('Wildcard If-Match must be rejected');
        } catch (\InvalidArgumentException $error) {
            $this->assertStringContainsString('exact strong etag', $error->getMessage());
        }

        try {
            $client->campaignTemplates->deleteCollection(
                'collection_1',
                '"campaign-template-saved-search:collection_1:v1"'
            );
            $this->fail('Cross-resource ETag must be rejected');
        } catch (\InvalidArgumentException $error) {
            $this->assertStringContainsString('exact current', $error->getMessage());
        }

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('1-255 bytes');
        $client->campaignTemplates->generate(
            ['brief' => 'Weekly digest'],
            "bad\nkey"
        );
    }
}
