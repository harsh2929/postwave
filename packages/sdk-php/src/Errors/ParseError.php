<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Errors;

/** The API returned a body that could not be parsed as JSON. */
class ParseError extends PostwaveError
{
    public function __construct(
        string $message = 'API returned invalid JSON. Please refresh and try again.',
        int $status = 0,
        ?string $requestId = null
    ) {
        parent::__construct($message, $status, 'invalid_json', $requestId);
    }
}
