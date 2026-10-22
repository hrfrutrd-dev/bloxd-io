/**
 * URL utilities shared by the Worker and unit tests.
 *
 * The allowed-host check is deliberately narrow. Do not turn this into a
 * user-controlled arbitrary URL forwarder: that would create an open proxy.
 */
export const CANONICAL_ORIGIN = "https://bloxd.io";
export const HTTP_PROXY_PREFIX = "/_bloxd_proxy_/r/";
export const WEBSOCKET_PROXY_PREFIX = "/_bloxd_proxy_/ws/";

export function isBloxdHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  return host === "bloxd.io" || host.endsWith(".bloxd.io");
}

export function isAllowedUpstream(url, { websocket = false } = {}) {
  if (!(url instanceof URL) || !isBloxdHost(url.hostname)) return false;

  const allowedProtocols = websocket ? ["ws:", "wss:", "http:", "https:"] : ["http:", "https:"];
  if (!allowedProtocols.includes(url.protocol)) return false;

  // Bloxd.io is served over HTTPS/WSS. Explicit non-standard ports would turn
  // this into a port scanner even with a host allowlist.
  return url.port === "" || url.port === "443";
}

/**
 * Converts a browser-visible Worker URL to an upstream HTTPS URL.
 * Returns null for malformed/forbidden internal proxy routes.
 */
export function upstreamFromRequestUrl(requestUrl, kind = "http") {
  const incoming = new URL(requestUrl);
  const prefix = kind === "websocket" ? WEBSOCKET_PROXY_PREFIX : HTTP_PROXY_PREFIX;

  if (!incoming.pathname.startsWith(prefix)) {
    if (kind === "websocket") return null;

    const target = new URL(CANONICAL_ORIGIN);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    return target;
  }

  const encodedTarget = incoming.pathname.slice(prefix.length);
  const slashAt = encodedTarget.indexOf("/");
  const hostname = (slashAt === -1 ? encodedTarget : encodedTarget.slice(0, slashAt)).toLowerCase();
  const pathname = slashAt === -1 ? "/" : encodedTarget.slice(slashAt);

  if (!isBloxdHost(hostname)) return null;

  const target = new URL(`https://${hostname}${pathname}`);
  target.search = incoming.search;
  return target;
}

/**
 * Creates a same-origin Worker endpoint for a permitted upstream URL.
 */
export function proxyUrlFor(targetUrl, publicOrigin, kind = "http") {
  const target = targetUrl instanceof URL ? new URL(targetUrl) : new URL(targetUrl);
  if (!isAllowedUpstream(target, { websocket: kind === "websocket" })) return null;

  const endpoint = new URL(publicOrigin);
  const prefix = kind === "websocket" ? WEBSOCKET_PROXY_PREFIX : HTTP_PROXY_PREFIX;
  endpoint.pathname = `${prefix}${target.hostname}${target.pathname}`;
  endpoint.search = target.search;
  endpoint.hash = target.hash;

  if (kind === "websocket") {
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  }

  return endpoint.toString();
}

export function isProxyRoute(pathname) {
  return pathname.startsWith(HTTP_PROXY_PREFIX) || pathname.startsWith(WEBSOCKET_PROXY_PREFIX);
}
