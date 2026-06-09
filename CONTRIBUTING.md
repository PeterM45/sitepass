# Contributing

Thanks for helping out. This is a small, deliberately simple package, and the goal is to keep it that way.

## Development

```sh
bun install
bun run build      # tsup: ESM + CJS + .d.ts for every package entry (the CLI bin is ESM-only, no declarations)
bun run test       # vitest
bun run typecheck  # tsc --noEmit
bun run check      # biome (lint + format check)
bun run format     # biome with --write
```

The runtime package has zero dependencies. The framework packages are dev-only (for typechecking the adapters) and are declared as optional peer dependencies for consumers.

## Guardrails

These are not negotiable. They are the whole point of the project.

1. **No client-side gate, ever.** Do not add a React, Angular, or Vue component that hides content in the browser and presents it as protection. A check that runs in the browser is obfuscation, not security: the page and its JavaScript are already on the visitor's machine. SPA users are pointed at the edge adapters.
2. **The core uses Web Crypto only.** No `node:` imports, no byte buffers, no Node-only globals in `src/core.ts` or in the edge adapters. They must run unchanged on the edge runtime and on Cloudflare Workers. The CLI and the reverse proxy run in Node and may use Node APIs; that is the only exception.
3. **Get the crypto right.** The signing scheme, the constant-time comparison, the fail-closed default, and the open-redirect guard are specified and tested. Do not swap in a different scheme. The tests in `test/core.test.ts` exist to prove these hold.
4. **The password and secret never reach the client.** Not in shipped code, not in examples, not in committed env files. `.env.example` holds empty placeholders only.

## Code-quality bar

Write code a stranger can read top to bottom without a map.

- Default to the plain version. Reach for a plain function before an abstraction, a layer, or an options object. No factories that build factories, no plugin systems, no config knobs for values that only ever have one setting.
- Small, named, single-purpose functions. If a function needs scrolling to read, split it.
- Zero runtime dependencies. Use the platform: Web Crypto, `URL`, `URLSearchParams`, `TextEncoder`.
- Comments explain why, not what. The security-critical lines get a short comment. Obvious code gets none.
- Strict, readable types. The shared contract lives in `src/core.ts`. Resist clever conditional or mapped types.
- Keep it flat. Shallow folders, no barrel files, no dead code.
- Match each framework's documented idioms rather than imposing a house pattern on top of every framework.

If a file feels over-built, it is. Delete until it is obvious.

## The adapter contract

Every adapter does the same three steps:

1. **Normalize.** Build a `GateRequest` from the host's request: method, pathname, search string, the gate cookie value, the `x-sitepass-bypass` header, and the raw body only when it is a POST to the login path.
2. **Handle.** `await gate.handle(request)`.
3. **Translate.** Map the `GateResult`: `pass` continues to the app (`next()` or the wrapped handler), `redirect` becomes a 302 with `Location` and `Set-Cookie`, `html` becomes a response with the given status, body, and headers.

For hosts that speak web `Request`/`Response` this is already written: `src/web.ts` (internal, not a package export) does normalize + translate with a capped login-body read, so those adapters reduce to reading their environment and calling `(await gateWebRequest(g, request, maxBodyBytes)) ?? next()` (the `await` matters — a pending Promise is never nullish). The Node-side consumers (Express, the proxy) share the capped body readers in `src/node-body.ts`. New adapters should reuse these instead of re-implementing the plumbing — and add a `describeAdapterConformance` driver in `test/adapters.test.ts`, which buys the full conformance suite (login, cookie pass, body cap, logout, bypass) for ~10 lines.

Each adapter reads `SITEPASS_PASSWORD`, `SITEPASS_SECRET`, and `SITEPASS_BYPASS_TOKEN` from its own environment and passes them into `createGate`. The core never reads environment variables. When adding an adapter, pull the framework's current middleware docs first and match how that framework writes middleware.
