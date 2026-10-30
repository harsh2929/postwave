# `@postwave/email-react`

A small JSX → MJML compiler for email components. Moosewave's lighter
equivalent of `react-email`, designed so an LLM agent (Claude Code,
Cursor, etc.) can write email in the React it already knows and have it
render to email-safe HTML — without the agent needing to learn MJML.

MIT licensed. Layer 2 of the Moosewave open-core architecture (see
`LICENSE-BOUNDARY.md`).

## Install

```bash
npm install @postwave/email-react react react-dom
# or
pnpm add @postwave/email-react react react-dom
```

You also need a TypeScript runtime if you want to render `.tsx` files
directly via the CLI:

```bash
npm i -D tsx
```

## Primitives

| Component   | MJML output                              |
| ----------- | ---------------------------------------- |
| `Email`     | `<mjml><mj-head/><mj-body/></mjml>` root |
| `Section`   | `<mj-section>`                           |
| `Column`    | `<mj-column>`                            |
| `Text`      | `<mj-text>`                              |
| `Heading`   | `<mj-text>` with heading defaults        |
| `Button`    | `<mj-button>`                            |
| `Image`     | `<mj-image>`                             |
| `Divider`   | `<mj-divider>`                           |
| `Spacer`    | `<mj-spacer>`                            |
| `Link`      | inline `<a>` styled for email            |
| `SocialRow` | `<mj-social>` + one element per item     |
| `Footer`    | A common unsubscribe footer block        |

All primitives accept the underlying MJML attributes via camelCase or
kebab-case props. For example, `Section` accepts `backgroundColor` and
emits `background-color="…"`.

## Render API

```ts
import { renderToHtml, renderToMjml, Email, Section, Column, Text } from "@postwave/email-react";

const tree = (
  <Email preview="A preview line">
    <Section>
      <Column>
        <Text>Hello world.</Text>
      </Column>
    </Section>
  </Email>
);

// Just the MJML source:
const mjml: string = renderToMjml(tree);

// Compiled email-safe HTML + warnings:
const { html, errors } = await renderToHtml(tree, {
  validationLevel: "soft",
  minify: false,
});
```

`renderToHtml` asynchronously returns `{ html, mjml, errors }` where `errors`
is the array of non-fatal warnings emitted by the underlying MJML compiler.

## CLI

The package ships a `postwave-email-render` binary:

```bash
# Default: compile to HTML on stdout
postwave-email-render ./Welcome.tsx

# Or just emit the intermediate MJML
postwave-email-render ./Welcome.tsx --out mjml
```

The component file must default-export either a React element or a
zero-arg function returning one.

For `.tsx` files you typically run via `tsx`:

```bash
npx tsx node_modules/.bin/postwave-email-render ./Welcome.tsx
```

## MCP integration status

`mcp_distribution_release_held`

The separate Moosewave MCP repository surface permits unsupported private source
evaluation, but its public distribution and setup guidance are release-held.
This package does not provide an MCP host, client connection, working-key
setup, preview/send workflow, or callable tool/prompt contract.
Rendering components locally does not establish that a generated result can be
passed to an agent or deployed runtime. Future MCP guidance requires a newly
qualified immutable MCP distribution and verified installed-artifact/runtime
contract.

## Why a new package?

- **Smaller surface area than `react-email`.** We only need the dozen
  primitives that map cleanly to MJML, not a full set of mail-client
  hacks.
- **Owns the JSX → MJML lowering.** Agents are already great at JSX.
  MJML, less so. We want the model to write the easy thing and have
  the package do the boring transform.
- **MIT, no Moosewave-specific runtime dependency.** Drop into any
  project that needs MJML.
