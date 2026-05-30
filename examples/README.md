# Examples

- [`spa-cloudflare`](./spa-cloudflare): a Vite + React SPA gated at the edge with the Cloudflare Pages adapter. The example that proves an SPA can sit behind one password even though it cannot gate itself.

For the other targets (Next, Astro, SvelteKit, Express, Hono, Bun, Netlify, and the reverse proxy), the wiring is two or three lines each. See the per-target snippets in the [root README](../README.md) or run `npx sitepass init` and pick your target.
