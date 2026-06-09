// --- Self-contained HTML (no external assets, no client JavaScript) ---
//
// The default login and not-configured pages. Internal: this module is
// deliberately not a package export — it is bundled into core's chunk. Pure
// string rendering, no crypto, config, or request logic.

export type Brand = { title: string; subtitle: string; accent: string }

/**
 * Escape a value for interpolation into HTML. Exported for `renderLoginPage`
 * implementations, which must escape `next` (and any other request-derived
 * value) when building their page.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderDefaultLoginPage(
  brand: Brand,
  loginPath: string,
  next: string,
  error: boolean,
): string {
  // role="alert" alone is not announced on a server-rendered page (it fires
  // only on dynamic insertion), and autofocus drops a screen-reader user
  // straight into the empty field; the aria-describedby/aria-invalid pair on
  // the input is what actually surfaces the failure.
  const errorNotice = error
    ? '<p id="sitepass-error" class="error" role="alert">Incorrect password. Try again.</p>'
    : ''
  const errorAttrs = error ? ' aria-invalid="true" aria-describedby="sitepass-error"' : ''
  const inner = `<h1>${escapeHtml(brand.title)}</h1>
      <p class="subtitle">${escapeHtml(brand.subtitle)}</p>
      <form method="post" action="${escapeHtml(loginPath)}">
        <input type="hidden" name="next" value="${escapeHtml(next)}" />
        <label for="sitepass-password">Password</label>
        <input id="sitepass-password" name="password" type="password" autocomplete="current-password" autofocus required${errorAttrs} />
        ${errorNotice}
        <button type="submit">Continue</button>
      </form>`
  return documentShell(brand.title, brand.accent, inner)
}

export function renderNotConfiguredPage(brand: Brand): string {
  const inner = `<h1>Not configured</h1>
      <p class="subtitle">This site is gated by sitepass, but the password or secret is not set (the secret must be at least 16 characters), so the gate is failing closed. Set them and reload.</p>`
  return documentShell('Not configured', brand.accent, inner)
}

function documentShell(title: string, accent: string, inner: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${escapeHtml(title)}</title>
    <style>${pageStyles(accent)}</style>
  </head>
  <body>
    <main class="card">
      ${inner}
    </main>
  </body>
</html>`
}

// Color constraints (WCAG 2.1): error text ≥4.5:1 on its card in both schemes
// (#dc2626 on #fff = 4.83:1, #f87171 on #18181b = 6.40:1) and the input border
// ≥3:1 non-text contrast (#71717a = 4.83:1 light, 3.67:1 dark). color-scheme
// keeps UA-rendered surfaces (canvas, form-control internals, scrollbars) in
// step with the dark theme; 100dvh tracks mobile dynamic toolbars, with the
// 100vh declaration before it as the fallback where dvh is unsupported.
function pageStyles(accent: string): string {
  return `
    :root { --accent: ${accent}; color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 1.5rem;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      color: #18181b; background: #f4f4f5;
    }
    .card {
      width: 100%; max-width: 22rem; padding: 2rem; background: #fff; border-radius: 14px;
      box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 10px 30px rgba(0,0,0,.08);
    }
    h1 { margin: 0 0 .35rem; font-size: 1.4rem; }
    .subtitle { margin: 0 0 1.5rem; color: #6b7280; font-size: .95rem; line-height: 1.5; }
    label { display: block; font-size: .85rem; font-weight: 600; margin-bottom: .4rem; }
    input[type=password] {
      width: 100%; padding: .7rem .8rem; font-size: 1rem; color: inherit; background: #fff;
      border: 1px solid #71717a; border-radius: 8px;
    }
    input[type=password]:focus {
      outline: none; border-color: var(--accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
    }
    .error { margin: .75rem 0 0; color: #dc2626; font-size: .85rem; }
    button {
      width: 100%; margin-top: 1.25rem; padding: .7rem; font-size: 1rem; font-weight: 600;
      color: #fff; background: var(--accent); border: 0; border-radius: 8px; cursor: pointer;
    }
    button:hover { filter: brightness(.95); }
    @media (prefers-color-scheme: dark) {
      body { color: #e4e4e7; background: #09090b; }
      .card { background: #18181b; box-shadow: 0 1px 2px rgba(0,0,0,.4), 0 10px 30px rgba(0,0,0,.5); }
      .subtitle { color: #a1a1aa; }
      input[type=password] { color: #e4e4e7; background: #27272a; }
      .error { color: #f87171; }
    }`
}
