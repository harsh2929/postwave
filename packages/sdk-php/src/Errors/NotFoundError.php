<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Errors;

class NotFoundError extends PostwaveError
{
    public function __construct(string $message, string $code, ?string $requestId = null)
    {
        parent::__construct($message, 404, $code, $requestId);
    }
}
