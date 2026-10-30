import {
  type MDXComponents,
  useMDXComponents as getDocsMDXComponents,
} from "nextra/mdx";

const docsComponents = getDocsMDXComponents();

export function useMDXComponents(
  components: MDXComponents = {},
): MDXComponents {
  return { ...docsComponents, ...components };
}
