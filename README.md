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
  Worker does not inspect, log, or persist cookie values.

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

## Implementation notes

The Worker removes the upstream CSP only for HTML that it transforms, because
that CSP is scoped to the real Bloxd origin and would otherwise block the
necessary bootstrap. It does **not** expose a user-supplied upstream URL or
forward arbitrary hosts. Authentication flows and third-party integrations may
change upstream; test the game anonymously first and do not enter credentials
unless you trust the Worker hostname and control its Cloudflare account.

If Bloxd changes its transport (for example, to a protocol other than
WebSocket) or blocks reverse gateways, this Worker should fail rather than
being broadened into a general-purpose proxy.
