import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.mjs";
import { GATEWAY_AUTH_COOKIE, encodeSessionCookieValue } from "../src/session.mjs";

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push({ url: request.url, headers: new Headers(request.headers), method: request.method });
    return handler(request);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test("never proxies an identity provider; shows the sign-in bridge instead", async (t) => {
  const stub = stubFetch(
    () => new Response(null, { status: 302, headers: { location: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x" } }),
  );
  t.after(() => stub.restore());

  const response = await worker.fetch(
    new Request("https://gateway.example/api/login/google", { headers: { "sec-fetch-mode": "navigate" } }),
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(body, /accounts\.google\.com/);
  assert.match(body, /bloxd\.io/);

  // Only the Bloxd login start was requested; the provider was not proxied.
  assert.deepEqual(
    stub.calls.map((call) => new URL(call.url).hostname),
    ["bloxd.io"],
  );
});

test("passes a provider redirect through for non-navigation requests", async (t) => {
  const stub = stubFetch(
    () => new Response(null, { status: 302, headers: { location: "https://discord.com/oauth2/authorize?client_id=x" } }),
  );
  t.after(() => stub.restore());

  const response = await worker.fetch(
    new Request("https://gateway.example/api/login/discord", { headers: { "sec-fetch-mode": "cors", accept: "application/json" } }),
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://discord.com/oauth2/authorize?client_id=x");
});

test("bridges a provider redirect that follows a login form POST", async (t) => {
  const stub = stubFetch(
    () => new Response(null, { status: 303, headers: { location: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1" } }),
  );
  t.after(() => stub.restore());

  const response = await worker.fetch(
    new Request("https://gateway.example/api/login/microsoft", {
      method: "POST",
      headers: { "sec-fetch-mode": "navigate", "content-type": "application/x-www-form-urlencoded" },
      body: "from=game",
    }),
  );

  assert.equal(response.status, 200);
  assert.match(await response.text(), /login\.microsoftonline\.com/);
});

test("replays the linked account session upstream and hides the gateway cookie", async (t) => {
  const stub = stubFetch(() => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  t.after(() => stub.restore());

  const value = encodeSessionCookieValue("session=account-token");
  await worker.fetch(
    new Request("https://gateway.example/api/me", {
      headers: { cookie: `${GATEWAY_AUTH_COOKIE}=${value}; guest=1` },
    }),
  );

  const upstreamCookie = stub.calls[0].headers.get("cookie");
  assert.equal(upstreamCookie, "guest=1; session=account-token");
  assert.doesNotMatch(upstreamCookie, new RegExp(GATEWAY_AUTH_COOKIE));
});

test("replays the linked session on the WebSocket upgrade too", async (t) => {
  // Node cannot construct a 101 response, so a 200 with an upgrade marker is enough
  // to assert what the Worker sends upstream.
  const stub = stubFetch(() => new Response(null, { status: 200 }));
  t.after(() => stub.restore());

  const value = encodeSessionCookieValue("session=account-token");
  await worker.fetch(
    new Request("https://gateway.example/_bloxd_proxy_/ws/gs-bedwars-1.bloxd.io/socket", {
      headers: {
        upgrade: "websocket",
        origin: "https://gateway.example",
        cookie: `${GATEWAY_AUTH_COOKIE}=${value}`,
      },
    }),
  );

  assert.equal(stub.calls[0].url, "https://gs-bedwars-1.bloxd.io/socket");
  assert.equal(stub.calls[0].headers.get("cookie"), "session=account-token");
  assert.equal(stub.calls[0].headers.get("origin"), "https://bloxd.io");
});

test("gateway routes are answered locally, never forwarded to Bloxd", async (t) => {
  const stub = stubFetch(() => new Response("should not happen", { status: 500 }));
  t.after(() => stub.restore());

  const response = await worker.fetch(new Request("https://gateway.example/_bloxd_gateway_/login"));
  assert.equal(response.status, 200);
  assert.equal(stub.calls.length, 0);
});
