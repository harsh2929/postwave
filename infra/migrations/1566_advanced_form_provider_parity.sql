-- 1566_advanced_form_provider_parity.sql
-- Promote advanced form builders, WordPress form plugins, quizzes, and
-- assessment lead sources into the managed lead integration control plane.

ALTER TABLE lead_integrations
    DROP CONSTRAINT IF EXISTS lead_integrations_provider_check;

ALTER TABLE lead_integrations
    ADD CONSTRAINT lead_integrations_provider_check
    CHECK (provider IN (
        'typeform',
        'jotform',
        'google-forms',
        'microsoft-forms',
        'surveymonkey',
        'facebook-lead-ads',
        'linkedin-lead-gen',
        'google-lead-form-extensions',
        'tiktok-lead-generation',
        'snap-lead-ads',
        'reddit-lead-gen',
        'pinterest-lead-ads',
        'unbounce',
        'leadpages',
        'instapage',
        'carrd',
        'paperform',
        'formstack',
        'fillout',
        'optinmonster',
        'privy',
        'convertflow',
        'sleeknote',
        'wisepops',
        'poptin',
        'hello-bar',
        'unstack',
        'landingi',
        'kickofflabs',
        'shortstack',
        'formsite',
        'cognito-forms',
        'ninja-forms',
        'formidable-forms',
        'interact',
        'outgrow',
        'riddle',
        'qualtrics-forms',
        'feathery',
        'formaloo',
        '123formbuilder',
        'tally',
        'gravity-forms',
        'wpforms',
        'wordpress',
        'webflow',
        'wix',
        'squarespace'
    ));
