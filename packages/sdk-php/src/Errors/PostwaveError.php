<?php
// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Moosewave\Errors;

/**
 * Base exception. Every HTTP error from the API throws a subclass.
 * Use `instanceof` to branch:
 *
 *     try { $pw->subscribers->get($id); }
 *     catch (NotFoundError $e) { ... }
 *     catch (PostwaveError $e) { ... }
 *
 * @property-read string $code Stable Moosewave API error code.
 */
class PostwaveError extends \RuntimeException
{
    private readonly string $apiCode;

    public function __construct(
        string $message,
        public readonly int $status = 0,
        string $code = 'unknown',
        public readonly ?string $requestId = null
    ) {
        $this->apiCode = $code;
        parent::__construct($message);
    }

    /**
     * RuntimeException already owns a protected integer property named
     * `code`, so PHP forbids redeclaring it as the API's public string code.
     * Preserve the documented `$error->code` surface through a read-only
     * virtual property instead.
     */
    public function __get(string $name): mixed
    {
        if ($name === 'code') {
            return $this->apiCode;
        }

        trigger_error('Undefined property: ' . static::class . "::$name", E_USER_WARNING);
        return null;
    }

    public function __isset(string $name): bool
    {
        return $name === 'code';
    }

    public function getErrorCode(): string
    {
        return $this->apiCode;
    }
}
