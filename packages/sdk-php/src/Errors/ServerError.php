<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Errors;

class ServerError extends PostwaveError
{
    public function __construct(
        string $message,
        string $code,
        int $status,
        ?string $requestId = null
    ) {
        parent::__construct($message, $status, $code, $requestId);
    }
}
