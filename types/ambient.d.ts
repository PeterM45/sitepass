// Type stubs for host virtual modules and Vite's import.meta.env, so the
// adapters typecheck and emit declarations outside a host project. The real
// modules are provided by the consumer's framework build; sitepass externalizes
// these imports and never bundles them.

declare module '$env/dynamic/private' {
  export const env: Record<string, string | undefined>
}

interface ImportMetaEnv {
  readonly [key: string]: string | undefined
}

interface ImportMeta {
  // Optional: import.meta.env only exists inside a Vite build, which is exactly
  // why src/astro.ts guards every access — the type must force that guard.
  readonly env?: ImportMetaEnv
}
