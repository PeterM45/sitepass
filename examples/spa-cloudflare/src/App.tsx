export function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 540, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>You're in.</h1>
      <p>
        This is a plain React SPA. It has no idea a password gate exists. The whole app, including
        this JavaScript bundle, was held back by the Cloudflare adapter until you submitted the
        password, which is the only place a password check on an SPA can actually be enforced.
      </p>
      <p>
        Look at <code>functions/_middleware.ts</code>: two lines wire up the gate. There is no
        client-side guard in this app, on purpose.
      </p>
    </main>
  )
}
