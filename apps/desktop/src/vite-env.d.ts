/// <reference types="vite/client" />

/* Asset modules — Vite returns hashed URLs for imported binary assets. */
declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.jpg" {
  const src: string;
  export default src;
}
declare module "*.jpeg" {
  const src: string;
  export default src;
}
declare module "*.gif" {
  const src: string;
  export default src;
}
declare module "*.webp" {
  const src: string;
  export default src;
}
declare module "*.svg" {
  const src: string;
  export default src;
}
declare module "*.svg?react" {
  import type { FunctionComponent, SVGProps } from "react";
  const cmp: FunctionComponent<SVGProps<SVGSVGElement>>;
  export default cmp;
}
