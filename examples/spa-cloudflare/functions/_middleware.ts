import { gate } from 'sitepass/cloudflare'

// This runs on every request before Cloudflare serves a static file, so it gates
// the whole SPA, including index.html and the JS bundle. The browser never
// receives the app until a valid session cookie is present.
export const onRequest = gate()
