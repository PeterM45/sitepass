// Supported `sitepass init` targets and the wiring snippet printed for each.
export const TARGETS = [
  'cloudflare',
  'netlify',
  'next',
  'astro',
  'sveltekit',
  'express',
  'hono',
  'bun',
] as const
export type Target = (typeof TARGETS)[number]

export const SNIPPETS: Record<Target, string> = {
  cloudflare: `Create functions/_middleware.ts:

  import { gate } from 'sitepass/cloudflare'
  export const onRequest = gate()

Set SITEPASS_PASSWORD and SITEPASS_SECRET in your Pages project settings.
Local \`wrangler pages dev\` reads them from the .dev.vars just written.`,

  netlify: `Create netlify/edge-functions/gate.ts:

  import { gate, config } from 'sitepass/netlify'
  export default gate()
  export { config }

Set SITEPASS_PASSWORD and SITEPASS_SECRET in your Netlify site environment variables.`,

  next: `Create middleware.ts (Next 15 and earlier) or proxy.ts (Next 16+):

  import { gate } from 'sitepass/next'
  export const middleware = gate()   // Next 16+: export const proxy = gate()

  export const config = {
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
  }`,

  astro: `Create src/middleware.ts:

  import { gate } from 'sitepass/astro'
  export const onRequest = gate()

Only on-demand routes are gated. A fully static Astro site needs the Cloudflare
or Netlify adapter (or \`export const prerender = false\` with an adapter).`,

  sveltekit: `Create src/hooks.server.ts:

  import { gate } from 'sitepass/sveltekit'
  export const handle = gate()`,

  express: `In your server file, before your routes:

  import { gate } from 'sitepass/express'
  app.use(gate())`,

  hono: `On your Hono app, before your routes:

  import { gate } from 'sitepass/hono'
  app.use(gate())`,

  bun: `Wrap your fetch handler:

  import { gate } from 'sitepass/bun'
  Bun.serve({ fetch: gate(myHandler) })`,
}
