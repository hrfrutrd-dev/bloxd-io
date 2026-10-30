import {
  HTTP_PROXY_PREFIX,
  WEBSOCKET_PROXY_PREFIX,
  isAllowedUpstream,
  isBloxdHost,
  proxyUrlFor,
  upstreamFromRequestUrl,
} from "./routing.mjs";
import { isGatewayRoute, isProviderUrl, linkedSessionFromRequest, upstreamCookieHeader } from "./session.mjs";
import { handleGatewayRoute, loginPageResponse } from "./pages.mjs";

const INJECTED_BOOTSTRAP = String.raw`<script data-bloxd-worker-gateway>
(() => {
  "use strict";

  // Keep calls to Bloxd origins on this Worker. The match is intentionally the
  // same narrow allowlist used by the server; it is not an arbitrary proxy.
  const isBloxdHost = (host) => {
    const value = String(host || "").toLowerCase().replace(/\.$/, "");
    return value === "bloxd.io" || value.endsWith(".bloxd.io");
  };
  const httpPrefix = location.origin + "${HTTP_PROXY_PREFIX}";
  const wsPrefix = location.origin + "${WEBSOCKET_PROXY_PREFIX}";

  function resolve(value) {
    if (value instanceof URL) return new URL(value.href);
    return new URL(String(value), document.baseURI);
  }

  function proxyHttp(value) {
    try {
      const url = resolve(value);
      if (!/^https?:$/.test(url.protocol) || !isBloxdHost(url.hostname)) return String(value);
      if (url.origin === location.origin) return url.href;
      return httpPrefix + url.hostname + url.pathname + url.search + url.hash;
    } catch {
      return value;
    }
  }

  function proxyWebSocket(value) {
    try {
      const url = resolve(value);
      if (!/^(wss?|https?):$/.test(url.protocol) || !isBloxdHost(url.hostname)) return String(value);
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      return protocol + wsPrefix.slice(location.protocol.length) + url.hostname + url.pathname + url.search;
    } catch {
      return value;
    }
  }

  // XHR and fetch are both used by common game bundles. Relative URLs already
  // remain same-origin and do not need changing; absolute Bloxd URLs do.
  const nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function patchedFetch(input, init) {
      if (input instanceof Request) {
        const rewritten = proxyHttp(input.url);
        if (rewritten !== input.url) {
          return nativeFetch.call(this, new Request(rewritten, input), init);
        }
      }
      return nativeFetch.call(this, proxyHttp(input), init);
    };
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    return xhrOpen.call(this, method, proxyHttp(url), ...rest);
  };

  if (window.EventSource) {
    const NativeEventSource = window.EventSource;
    function GatewayEventSource(url, configuration) {
      return new NativeEventSource(proxyHttp(url), configuration);
    }
    GatewayEventSource.prototype = NativeEventSource.prototype;
    Object.setPrototypeOf(GatewayEventSource, NativeEventSource);
    window.EventSource = GatewayEventSource;
  }

  if (navigator.sendBeacon) {
    const nativeSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => nativeSendBeacon(proxyHttp(url), data);
  }

  const NativeWebSocket = window.WebSocket;
  if (NativeWebSocket) {
    function GatewayWebSocket(url, protocols) {
      const rewritten = proxyWebSocket(url);
      return protocols === undefined
        ? new NativeWebSocket(rewritten)
        : new NativeWebSocket(rewritten, protocols);
    }
    GatewayWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(GatewayWebSocket, NativeWebSocket);
    window.WebSocket = GatewayWebSocket;
  }

  // Sign-in ---------------------------------------------------------------
  //
  // The gateway never proxies Google/Apple/Microsoft/Discord. Those pages are
  // opened first party, and the resulting Bloxd session is handed over through
  // /_bloxd_gateway_/login (see the bridge page). Two conveniences live here:
  //   * a small "sign in" chip while no account session is linked, and
  //   * automatic linking when a Bloxd window posts its session to us.
  const gatewayBase = location.origin + "/_bloxd_gateway_";
  const sessionEndpoint = gatewayBase + "/session";

  async function linkSession(candidate) {
    if (typeof candidate !== "string" || !candidate) return false;
    try {
      const response = await fetch(sessionEndpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cookie: candidate }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  window.addEventListener("message", (event) => {
    try {
      const host = new URL(event.origin).hostname;
      if (event.origin === location.origin || !isBloxdHost(host)) return;
      const data = event.data;
      const candidate =
        typeof data === "string"
          ? data
          : data && typeof data === "object"
            ? data.cookie ?? data.sessionCookie ?? data.session ?? data.token ?? data.authToken ?? data.accessToken
            : null;
      linkSession(candidate).then((ok) => ok && location.reload());
    } catch {
      /* ignore malformed messages */
    }
  });

  function mountSignInChip() {
    if (window.top !== window.self) return;
    fetch(gatewayBase + "/status", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((state) => {
        if (!state || state.linked || document.getElementById("bloxd-gateway-signin")) return;

        const chip = document.createElement("a");
        chip.id = "bloxd-gateway-signin";
        chip.href = gatewayBase + "/login";
        chip.textContent = "ログイン / Sign in";
        chip.style.cssText = [
          "position:fixed", "left:12px", "bottom:12px", "z-index:2147483647",
          "padding:6px 12px", "border-radius:999px",
          "background:rgba(18,19,26,.92)", "color:#e7e9f3",
          "border:1px solid rgba(120,130,200,.55)",
          "font:600 12px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif",
          "text-decoration:none", "box-shadow:0 4px 18px rgba(0,0,0,.4)",
        ].join(";");
        document.body.appendChild(chip);
      })
      .catch(() => {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountSignInChip, { once: true });
  } else {
    mountSignInChip();
  }
})();
</script>`;

function upstreamHeaders(request, target) {
  const headers = new Headers(request.headers);

  // Cloudflare derives Host from the URL passed to fetch. Forwarding the
  // Worker's host would make virtual-host routing fail upstream.
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-host");

  // Avoid serving a compressed body with an invalid original content-length
  // after HTMLRewriter injects the bootstrap.
  headers.set("accept-encoding", "identity");

  // Bloxd only sees this Worker host, so replay the linked account session (if
  // the user signed in on the real origin and handed it over) on top of the
  // gateway's own cookies. The gateway-only cookie never leaves this Worker.
  const cookieHeader = headers.get("cookie");
  const upstreamCookie = upstreamCookieHeader(cookieHeader, linkedSessionFromRequest(cookieHeader));
  headers.delete("cookie");
  if (upstreamCookie) headers.set("cookie", upstreamCookie);

  // Browsers naturally send the Worker URL as Origin/Referer. Bloxd receives
  // the original origin instead, which keeps its normal same-origin checks
  // working without opening the Worker to another upstream.
  if (headers.has("origin")) headers.set("origin", "https://bloxd.io");
  if (headers.has("referer")) headers.set("referer", `${target.origin}/`);

  return headers;
}

function normalizedSetCookies(sourceHeaders) {
  // Cloudflare exposes getAll("Set-Cookie") while newer Fetch runtimes expose
  // getSetCookie(). Support both APIs without ever looking at cookie values.
  const getSetCookie = sourceHeaders.getSetCookie;
  const getAll = sourceHeaders.getAll;
  let cookies = [];

  if (typeof getSetCookie === "function") {
    cookies = getSetCookie.call(sourceHeaders);
  } else if (typeof getAll === "function") {
    cookies = getAll.call(sourceHeaders, "Set-Cookie");
  }

  // A response comes from the Worker hostname, so a Domain=bloxd.io cookie
  // would be rejected by browsers. A host-only cookie lets a normal guest
  // session continue through this one gateway. Cookie values are never read
  // or persisted by the Worker.
  return cookies.map((value) => value.replace(/;\s*domain\s*=\s*[^;]+/gi, ""));
}

function responseHeaders(upstream, { rewrittenBody = false } = {}) {
  const headers = new Headers(upstream.headers);
  const cookies = normalizedSetCookies(upstream.headers);

  if (cookies.length > 0) {
    headers.delete("set-cookie");
    for (const cookie of cookies) headers.append("set-cookie", cookie);
  }

  // The injected same-origin transport needs to run even when the origin has
  // a nonce-only policy. These policies were written for bloxd.io, not the
  // wrapper hostname; keeping them would prevent the bootstrap from running.
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-frame-options");
  headers.delete("cross-origin-opener-policy");
  headers.delete("cross-origin-embedder-policy");

  if (rewrittenBody) {
    headers.delete("content-length");
    headers.delete("content-encoding");
  }

  return headers;
}

function publicOrigin(request) {
  return new URL(request.url).origin;
}

function rewriteAttribute(value, origin) {
  if (!value || value.startsWith("#") || value.startsWith("data:") || value.startsWith("javascript:")) {
    return value;
  }

  try {
    const resolved = new URL(value, origin);
    if (!isAllowedUpstream(resolved)) return value;
    return proxyUrlFor(resolved, origin) ?? value;
  } catch {
    return value;
  }
}

class HtmlUrlRewriter {
  constructor(origin) {
    this.origin = origin;
  }

  element(element) {
    for (const attribute of ["src", "href", "action", "poster", "data"]) {
      const value = element.getAttribute(attribute);
      const rewritten = rewriteAttribute(value, this.origin);
      if (rewritten !== value) element.setAttribute(attribute, rewritten);
    }

    // A base URL on an alternate Bloxd subdomain must also use an endpoint
    // where relative resources retain their upstream host and path.
    if (element.tagName === "base") {
      const href = element.getAttribute("href");
      const rewritten = rewriteAttribute(href, this.origin);
      if (rewritten !== href) element.setAttribute("href", rewritten);
    }
  }
}

class BootstrapInjector {
  element(element) {
    element.prepend(INJECTED_BOOTSTRAP, { html: true });
  }
}

function rewriteLocation(location, requestOrigin, target) {
  try {
    const resolved = new URL(location, target);
    if (!isAllowedUpstream(resolved)) return location;
    return proxyUrlFor(resolved, requestOrigin) ?? location;
  } catch {
    return location;
  }
}

function makeUpstreamRequest(request, target) {
  const init = {
    method: request.method,
    headers: upstreamHeaders(request, target),
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  return new Request(target.toString(), init);
}

async function proxyWebSocket(request, target) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade.", { status: 426 });
  }

  // Cloudflare Workers forwards a WebSocket when fetch receives the upgrade
  // request and returns the upstream 101 response unchanged.
  const response = await fetch(makeUpstreamRequest(request, target));
  return response;
}

function isBrowserNavigation(request) {
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/**
 * Bloxd starts Google/Discord/Apple/Microsoft sign-in by redirecting to the
 * provider. That redirect can only ever come back to the real bloxd.io origin,
 * and the gateway must not proxy the providers. So instead of dropping the user
 * out of the gateway, answer with the sign-in bridge page, which opens the
 * provider first party and explains how to hand the resulting session over.
 */
function providerLoginBridge(request, location, target) {
  let resolved;
  try {
    resolved = new URL(location, target);
  } catch {
    return null;
  }
  if (!isBrowserNavigation(request) || !isProviderUrl(resolved)) return null;

  return loginPageResponse({
    linked: Boolean(linkedSessionFromRequest(request.headers.get("cookie"))),
    providerUrl: resolved.toString(),
  });
}

async function proxyHttp(request, target) {
  const upstream = await fetch(makeUpstreamRequest(request, target));
  const contentType = upstream.headers.get("content-type") ?? "";
  const isHtml = contentType.toLowerCase().includes("text/html");
  const headers = responseHeaders(upstream, { rewrittenBody: isHtml });
  const location = upstream.headers.get("location");

  if (location) {
    const bridge = providerLoginBridge(request, location, target);
    if (bridge) return bridge;
    headers.set("location", rewriteLocation(location, publicOrigin(request), target));
  }

  const response = new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });

  if (!isHtml) return response;

  return new HTMLRewriter()
    .on("head", new BootstrapInjector())
    .on("*", new HtmlUrlRewriter(publicOrigin(request)))
    .transform(response);
}

export default {
  async fetch(request) {
    const incoming = new URL(request.url);

    // Sign-in bridge endpoints live on the Worker host and are never forwarded
    // upstream (that would turn them into Bloxd routes).
    if (isGatewayRoute(incoming.pathname)) return handleGatewayRoute(request);

    const isWebSocketRoute = incoming.pathname.startsWith(WEBSOCKET_PROXY_PREFIX);
    const isHttpProxyRoute = incoming.pathname.startsWith(HTTP_PROXY_PREFIX);

    // Internal endpoint typos and non-HTTP schemes fail closed instead of
    // falling back to the canonical upstream.
    const target = upstreamFromRequestUrl(request.url, isWebSocketRoute ? "websocket" : "http");
    if (!target || !isBloxdHost(target.hostname)) {
      return new Response("Not found.", { status: 404 });
    }

    try {
      if (isWebSocketRoute) return await proxyWebSocket(request, target);
      if (isHttpProxyRoute || !incoming.pathname.startsWith(WEBSOCKET_PROXY_PREFIX)) {
        return await proxyHttp(request, target);
      }
    } catch (error) {
      // A failed upstream fetch used to surface as an opaque Worker exception.
      // Answer explicitly instead, so a blocked/down Bloxd is obvious.
      return new Response(`Gateway could not reach ${target.hostname}.`, {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    return new Response("Not found.", { status: 404 });
  },
};
