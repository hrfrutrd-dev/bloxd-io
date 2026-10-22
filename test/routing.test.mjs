import assert from "node:assert/strict";
import test from "node:test";
import {
  HTTP_PROXY_PREFIX,
  WEBSOCKET_PROXY_PREFIX,
  isAllowedUpstream,
  isBloxdHost,
  proxyUrlFor,
  upstreamFromRequestUrl,
} from "../src/routing.mjs";

test("only accepts bloxd.io and its subdomains", () => {
  assert.equal(isBloxdHost("bloxd.io"), true);
  assert.equal(isBloxdHost("GS-BEDWARS-123.BLOXD.IO"), true);
  assert.equal(isBloxdHost("bloxd.io.evil.example"), false);
  assert.equal(isBloxdHost("evilbloxd.io"), false);
});

test("maps a normal Worker request to the canonical upstream", () => {
  const target = upstreamFromRequestUrl("https://gateway.example/play/bedwars?lobby=one");
  assert.equal(target.href, "https://bloxd.io/play/bedwars?lobby=one");
});

test("maps a host-preserving HTTP proxy route to its permitted upstream", () => {
  const target = upstreamFromRequestUrl(
    `https://gateway.example${HTTP_PROXY_PREFIX}assets.bloxd.io/bundles/game.js?v=4`,
  );
  assert.equal(target.href, "https://assets.bloxd.io/bundles/game.js?v=4");
});

test("does not accept a non-Bloxd internal proxy host", () => {
  const target = upstreamFromRequestUrl(
    `https://gateway.example${HTTP_PROXY_PREFIX}bloxd.io.evil.example/steal`,
  );
  assert.equal(target, null);
});

test("builds same-origin HTTP and WebSocket endpoints", () => {
  const http = proxyUrlFor("https://gs-survival-a.bloxd.io/socket?token=abc", "https://gateway.example");
  const websocket = proxyUrlFor(
    "wss://gs-survival-a.bloxd.io/socket?token=abc",
    "https://gateway.example",
    "websocket",
  );

  assert.equal(http, `https://gateway.example${HTTP_PROXY_PREFIX}gs-survival-a.bloxd.io/socket?token=abc`);
  assert.equal(websocket, `wss://gateway.example${WEBSOCKET_PROXY_PREFIX}gs-survival-a.bloxd.io/socket?token=abc`);
});

test("rejects unsupported protocols and explicit non-standard ports", () => {
  assert.equal(isAllowedUpstream(new URL("ftp://bloxd.io/game")), false);
  assert.equal(isAllowedUpstream(new URL("https://bloxd.io:8443/game")), false);
});
