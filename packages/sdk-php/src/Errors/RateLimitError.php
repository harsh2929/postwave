<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Errors;

class RateLimitError extends PostwaveError
{
    public function __construct(
        string $message,
        string $code,
        public readonly ?int $retryAfterSeconds = null,
        ?string $requestId = null
    ) {
        parent::__construct($message, 429, $code, $requestId);
    }
}
