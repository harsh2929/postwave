-- 2002_assets_content_library_concurrency.sql
--
-- Asset-library and reusable-content writes previously used last-writer-wins
-- updates.  These positive monotonic versions bind each edit/lifecycle action
-- to the representation the operator reviewed.  Assets also gain an
-- updated_at timestamp because folder, tag, and accessibility edits are
-- meaningful library mutations even though the original table only recorded
-- upload time.

BEGIN;

ALTER TABLE public.assets
    ADD COLUMN version bigint NOT NULL DEFAULT 1,
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
    ADD CONSTRAINT assets_positive_version_2002 CHECK (version > 0);

ALTER TABLE public.asset_folders
    ADD COLUMN version bigint NOT NULL DEFAULT 1,
    ADD CONSTRAINT asset_folders_positive_version_2002 CHECK (version > 0);

ALTER TABLE public.saved_blocks
    ADD COLUMN version bigint NOT NULL DEFAULT 1,
    ADD CONSTRAINT saved_blocks_positive_version_2002 CHECK (version > 0);

ALTER TABLE public.reference_collections
    ADD COLUMN version bigint NOT NULL DEFAULT 1,
    ADD CONSTRAINT reference_collections_positive_version_2002 CHECK (version > 0);

COMMENT ON COLUMN public.assets.version IS
    'Positive monotonic revision advanced by every operator-visible asset mutation.';
COMMENT ON COLUMN public.assets.updated_at IS
    'Server-owned timestamp of the latest operator-visible asset mutation.';
COMMENT ON COLUMN public.asset_folders.version IS
    'Positive monotonic revision used by exact rename and delete preconditions.';
COMMENT ON COLUMN public.saved_blocks.version IS
    'Positive monotonic revision used by exact reusable-block update/delete preconditions.';
COMMENT ON COLUMN public.reference_collections.version IS
    'Positive monotonic revision used by exact reference-collection update/delete preconditions.';

COMMIT;
