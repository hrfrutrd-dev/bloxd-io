# Bloxd.io Cloudflare Worker gateway

A **host-restricted** Cloudflare Worker reverse gateway for `bloxd.io` and its
subdomains. It proxies both the game page/assets and the game WebSockets, then
injects a small same-origin transport shim so absolute Bloxd HTTP and `wss://`
URLs continue to flow through the Worker.

> Use this only on a network and with a Cloudflare account where you are
> authorized to do so, and in accordance with Bloxd.io's and Cloudflare's terms.
> It is deliberately restricted to `bloxd.io` and `*.bloxd.io`; it is **not**
> an open proxy and must not be changed into one.

## What is included

- **Page and asset forwarding** — `/anything` is fetched from
  `https://bloxd.io/anything`.
- **Subdomain-safe internal routes** — absolute resources such as
  `https://assets.bloxd.io/...` become same-origin Worker paths under
  `/_bloxd_proxy_/r/<host>/...`.
- **WebSocket forwarding** — the injected shim rewrites game sockets such as
  `wss://gs-…​.bloxd.io/...` to `/_bloxd_proxy_/ws/<host>/...`; the Worker
  forwards the Upgrade response to the original Bloxd server.
- **No arbitrary destinations** — all request paths and injected URLs are
  checked against exactly `bloxd.io` or `*.bloxd.io`, over standard HTTPS/WSS.
- **Guest-session compatibility** — upstream `Domain=bloxd.io` cookie
  attributes are converted to host-only cookies for the Worker hostname. The
  Worker does not log cookie values.
- **Sign-in without proxying the identity providers** — Google / Apple /
  Microsoft / Discord sign-in stays first party and the resulting Bloxd
  session is handed to the gateway, which replays it upstream for HTTP and
  WebSocket requests. See [Sign-in](#sign-in-google--apple--microsoft--discord).

## Deploy

### 1. Install and test

```bash
npm install
npm test
```

### 2. Authenticate and deploy

```bash
npx wrangler login
npm run deploy
```

Wrangler prints the deployed `*.workers.dev` URL. Open that URL rather than
opening `bloxd.io` directly. `workers_dev = true` is already configured in
`wrangler.toml`, so a custom domain is optional.

For a custom domain, add the Worker route in Cloudflare's dashboard after
creating the Worker. Use a dedicated hostname such as `play.example.com`;
do not attach it to a site that has unrelated cookies.

### 3. Local smoke test (optional)

```bash
npm run dev
```

Wrangler's local server binds to all interfaces (`--ip 0.0.0.0`), which is
useful for a remote development preview. Open the local Worker URL shown by
Wrangler and use the browser network panel to confirm that requests remain on
the Worker hostname:

- normal files: `/…`
- subdomain resources: `/_bloxd_proxy_/r/<bloxd-host>/…`
- game connections: `/_bloxd_proxy_/ws/<game-server>.bloxd.io/…`
- sign-in bridge (served locally, no upstream needed): `/_bloxd_gateway_/login`

## Sign-in (Google / Apple / Microsoft / Discord)

The gateway deliberately **does not proxy `accounts.google.com`, `discord.com`,
`login.microsoftonline.com` or `appleid.apple.com`**. There is a harder reason
than policy: OAuth only redirects back to the exact `redirect_uri` that Bloxd
registered — `https://bloxd.io/...` — and the session cookie Bloxd sets is
bound to `bloxd.io`. A Worker on `play.example.com` can neither receive that
callback nor read that cookie, and proxying the provider would not change
either fact.

So sign-in happens where it can actually work, and only the *result* is bridged:

1. In the game, the login buttons still work. When Bloxd answers a login click
   with a redirect to Google/Discord/Apple/Microsoft, the Worker notices it and
   serves `/_bloxd_gateway_/login` instead of silently dropping you out of the
   gateway.
2. That page opens the real provider page in a new tab (first party, untouched).
   Complete the sign-in there; you end up logged in on `bloxd.io`.
3. Hand the resulting Bloxd session to the gateway: copy the `Cookie:` request
   header for `bloxd.io` (DevTools → Network → any request → Request Headers, or
   Application → Cookies) and paste it into the page.
4. From then on the Worker replays that cookie on every upstream HTTP and
   WebSocket request, so the game runs with your account through the gateway.

While a session is linked the game page shows no sign-in chip; use
`/_bloxd_gateway_/login` to re-link or unlink at any time.

If a Bloxd window posts its session to the opener with `postMessage` (some embed
integrations do), the gateway links it automatically and no copy/paste is
needed.

### What is stored, and where

- The pasted value is validated as a plain `name=value` cookie string (header
  injection, control characters and oversized input are rejected) and stored in
  a **host-only** `_bloxd_gw_auth` cookie: `HttpOnly; Secure; SameSite=Lax`,
  `Max-Age` 30 days.
- It is only ever replayed to `bloxd.io` / `*.bloxd.io` as the upstream
  `Cookie` header. The `_bloxd_gw_auth` cookie itself is never forwarded
  upstream, and nothing is written to storage or logs.
- Unlinking (`/_bloxd_gateway_/login` → *Unlink*) deletes the cookie.

Only paste a session into a Worker you deploy and control. Anyone who can read
that cookie can act as your Bloxd account until the session expires.

## Implementation notes

The Worker removes the upstream CSP only for HTML that it transforms, because
that CSP is scoped to the real Bloxd origin and would otherwise block the
necessary bootstrap. It does **not** expose a user-supplied upstream URL or
forward arbitrary hosts. Identity-provider hosts are recognised so they can be
kept first party and are never fetched by the Worker.

Gateway routes (`/_bloxd_gateway_/*`) are answered locally and are never mapped
onto a Bloxd path. Test the game anonymously first, and only link an account
session on a Worker hostname you control.

If Bloxd changes its transport (for example, to a protocol other than
WebSocket) or blocks reverse gateways, this Worker should fail rather than
being broadened into a general-purpose proxy.
