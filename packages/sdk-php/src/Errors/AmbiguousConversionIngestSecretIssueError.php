<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Errors;

/** A reveal-once issuance may have committed although its response was lost. */
final class AmbiguousConversionIngestSecretIssueError extends PostwaveError
{
    public const RECOVERY = 'list signing-key metadata, identify any newly issued key ID, '
        . 'revoke it, then issue a replacement; never retry issuance blindly';

    public function __construct()
    {
        parent::__construct(
            'Conversion signing-key issuance is ambiguous; ' . self::RECOVERY . '.',
            0,
            'ambiguous_conversion_ingest_secret_issue'
        );
    }
}
