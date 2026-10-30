/**
 * Sign-in support for the gateway.
 *
 * Why this module exists
 * ----------------------
 * Google / Apple / Microsoft / Discord only redirect back to the exact
 * `redirect_uri` that Bloxd registered (`https://bloxd.io/...`). A Worker on a
 * different hostname therefore cannot receive the OAuth callback, and the
 * session cookie Bloxd sets belongs to `bloxd.io`, not to the Worker host.
 *
 * So the gateway never touches the identity providers and never proxies them.
 * Instead the user signs in once on the real Bloxd origin (first party), and the
 * resulting Bloxd session cookie is handed to the gateway, which replays it on
 * every upstream HTTP and WebSocket request. This module contains the pure
 * parsing/validation helpers for that handoff.
 */

export const GATEWAY_ROUTE_PREFIX = "/_bloxd_gateway_";
export const GATEWAY_AUTH_COOKIE = "_bloxd_gw_auth";

/** Upper bound for a handed-over Cookie header. Bloxd sessions are tiny. */
export const MAX_SESSION_LENGTH = 4096;
export const MAX_SESSION_PAIRS = 20;

/**
 * Hosts that belong to the sign-in providers. The gateway never proxies these:
 * the browser talks to them directly so their own cookies, device checks and
 * fraud protection keep working. They are only recognised so the Worker can
 * notice "Bloxd is sending us off to Google/Discord" and answer with the login
 * bridge page instead of silently dropping the user out of the game.
 */
const PROVIDER_HOSTS = [
  "accounts.google.com",
  "accounts.youtube.com",
  "appleid.apple.com",
  "idmsa.apple.com",
  "login.microsoftonline.com",
  "login.microsoft.com",
  "login.live.com",
  "discord.com",
  "www.discord.com",
  "discordapp.com",
];

const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isCookieOctet(code) {
  // RFC 6265 cookie-octet: %x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E
  return (
    code === 0x21 ||
    (code >= 0x23 && code <= 0x2b) ||
    (code >= 0x2d && code <= 0x3a) ||
    (code >= 0x3c && code <= 0x5b) ||
    (code >= 0x5d && code <= 0x7e)
  );
}

export function isProviderHost(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/\.$/, "");
  return PROVIDER_HOSTS.includes(host);
}

export function isProviderUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(String(value));
    return url.protocol === "https:" && isProviderHost(url.hostname);
  } catch {
    return false;
  }
}

export function isGatewayRoute(pathname) {
  return String(pathname).startsWith(`${GATEWAY_ROUTE_PREFIX}/`) || pathname === GATEWAY_ROUTE_PREFIX;
}

/**
 * Normalises a pasted Cookie header into `name=value; name=value`.
 * Returns null for anything that is not a plain, header-injection-safe cookie
 * string. Values are never logged or stored anywhere except the user's own
 * browser cookie jar.
 */
export function sanitizeSessionCookie(input) {
  if (typeof input !== "string") return null;

  // Accept the whole header line as copied from DevTools or curl.
  const text = input.replace(/^\s*cookie\s*:\s*/i, "").trim();
  if (!text) return null;

  const pairs = [];
  for (const raw of text.split(/[;\r\n]+/)) {
    const part = raw.trim().replace(/^["']/, "").replace(/["']$/, "").trim();
    if (!part) continue;

    const eq = part.indexOf("=");
    if (eq <= 0) return null;

    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!COOKIE_NAME_RE.test(name)) return null;
    if (value && ![...value].every((character) => isCookieOctet(character.charCodeAt(0)))) return null;

    pairs.push(`${name}=${value}`);
  }

  if (pairs.length === 0 || pairs.length > MAX_SESSION_PAIRS) return null;

  const cookie = pairs.join("; ");
  if (cookie.length > MAX_SESSION_LENGTH) return null;
  return cookie;
}

export function encodeSessionCookieValue(cookie) {
  const normalized = sanitizeSessionCookie(cookie);
  if (!normalized) return null;
  const bytes = new TextEncoder().encode(normalized);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeSessionCookieValue(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return sanitizeSessionCookie(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** Parses a Cookie request header into name -> value pairs. */
export function parseCookieHeader(header) {
  const pairs = new Map();
  if (!header) return pairs;

  for (const raw of String(header).split(";")) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    pairs.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }

  return pairs;
}

/** Removes gateway-only cookies so they are never sent upstream. */
export function stripGatewayCookies(header) {
  if (!header) return "";
  return String(header)
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${GATEWAY_AUTH_COOKIE}=`))
    .join("; ");
}

/** The handed-over Bloxd session for this browser, or null. */
export function linkedSessionFromRequest(cookieHeader) {
  const value = parseCookieHeader(cookieHeader).get(GATEWAY_AUTH_COOKIE);
  return decodeSessionCookieValue(value);
}

/**
 * Builds the Cookie header sent to Bloxd: the gateway's own guest cookies plus
 * the linked account session. Returns null when there is nothing to send.
 */
export function upstreamCookieHeader(cookieHeader, linkedSession) {
  const guest = stripGatewayCookies(cookieHeader);
  const session = linkedSession ? sanitizeSessionCookie(linkedSession) : null;

  if (!guest) return session;
  if (!session) return guest;

  // The linked session wins on duplicate names (it is the account session).
  const merged = parseCookieHeader(guest);
  for (const [name, value] of parseCookieHeader(session)) merged.set(name, value);

  return [...merged].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function sessionCookieHeader(value, { maxAge }) {
  const parts = [
    `${GATEWAY_AUTH_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}
