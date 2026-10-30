import assert from "node:assert/strict";
import test from "node:test";
import {
  GATEWAY_AUTH_COOKIE,
  decodeSessionCookieValue,
  encodeSessionCookieValue,
  isGatewayRoute,
  isProviderHost,
  isProviderUrl,
  linkedSessionFromRequest,
  sanitizeSessionCookie,
  sessionCookieHeader,
  stripGatewayCookies,
  upstreamCookieHeader,
} from "../src/session.mjs";

test("accepts a normal Bloxd cookie header", () => {
  assert.equal(sanitizeSessionCookie("session=abc123; token=xyz"), "session=abc123; token=xyz");
});

test("accepts a cookie header copied together with its name", () => {
  assert.equal(sanitizeSessionCookie("  Cookie: session=abc; token=xyz  "), "session=abc; token=xyz");
});

test("accepts values copied from a multi-line DevTools panel", () => {
  assert.equal(sanitizeSessionCookie("session=abc;\ntoken=xyz;"), "session=abc; token=xyz");
});

test("rejects header injection and malformed input", () => {
  assert.equal(sanitizeSessionCookie("session=abc\r\nX-Evil: 1"), null);
  assert.equal(sanitizeSessionCookie("session=abc; bad name=1"), null);
  assert.equal(sanitizeSessionCookie("justtext"), null);
  assert.equal(sanitizeSessionCookie(""), null);
  assert.equal(sanitizeSessionCookie(null), null);
});

test("rejects absurdly long sessions", () => {
  assert.equal(sanitizeSessionCookie(`session=${"a".repeat(5000)}`), null);
});

test("round-trips a session through the gateway cookie value", () => {
  const value = encodeSessionCookieValue("session=abc; token=xyz");
  assert.match(value, /^[A-Za-z0-9_-]+$/);
  assert.equal(decodeSessionCookieValue(value), "session=abc; token=xyz");
  assert.equal(decodeSessionCookieValue("not-base64!!"), null);
});

test("strips gateway-only cookies before forwarding upstream", () => {
  assert.equal(stripGatewayCookies(`${GATEWAY_AUTH_COOKIE}=abc; guest=1`), "guest=1");
  assert.equal(stripGatewayCookies(`${GATEWAY_AUTH_COOKIE}=abc`), "");
});

test("merges guest cookies with the linked account session", () => {
  assert.equal(upstreamCookieHeader("guest=1", "session=abc"), "guest=1; session=abc");
  assert.equal(upstreamCookieHeader(`${GATEWAY_AUTH_COOKIE}=zzz; guest=1`, null), "guest=1");
  assert.equal(upstreamCookieHeader(null, "session=abc"), "session=abc");
  assert.equal(upstreamCookieHeader(null, null), null);
  // The account session wins on duplicate names.
  assert.equal(upstreamCookieHeader("session=guest; guest=1", "session=abc"), "session=abc; guest=1");
});

test("reads the linked session out of a request cookie header", () => {
  const value = encodeSessionCookieValue("session=abc");
  assert.equal(linkedSessionFromRequest(`${GATEWAY_AUTH_COOKIE}=${value}; guest=1`), "session=abc");
  assert.equal(linkedSessionFromRequest("guest=1"), null);
});

test("session cookie is host-locked and not readable from JavaScript", () => {
  const header = sessionCookieHeader("abc", { maxAge: 60 });
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Max-Age=60/);
  assert.doesNotMatch(header, /Domain=/);
});

test("recognises gateway routes so they are never proxied upstream", () => {
  assert.equal(isGatewayRoute("/_bloxd_gateway_/login"), true);
  assert.equal(isGatewayRoute("/_bloxd_gateway_"), true);
  assert.equal(isGatewayRoute("/play/bedwars"), false);
  assert.equal(isGatewayRoute("/_bloxd_proxy_/r/bloxd.io/x"), false);
});

test("recognises identity providers that must stay first party", () => {
  assert.equal(isProviderHost("accounts.google.com"), true);
  assert.equal(isProviderHost("discord.com"), true);
  assert.equal(isProviderHost("login.microsoftonline.com"), true);
  assert.equal(isProviderHost("bloxd.io"), false);
  assert.equal(isProviderHost("accounts.google.com.evil.example"), false);
  assert.equal(isProviderUrl("https://accounts.google.com/o/oauth2/v2/auth?client_id=x"), true);
  assert.equal(isProviderUrl("http://accounts.google.com/o/oauth2/v2/auth"), false);
  assert.equal(isProviderUrl("javascript:alert(1)"), false);
});
