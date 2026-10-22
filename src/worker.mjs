import {
  HTTP_PROXY_PREFIX,
  WEBSOCKET_PROXY_PREFIX,
  isAllowedUpstream,
  isBloxdHost,
  proxyUrlFor,
  upstreamFromRequestUrl,
} from "./routing.mjs";

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

async function proxyHttp(request, target) {
  const upstream = await fetch(makeUpstreamRequest(request, target));
  const contentType = upstream.headers.get("content-type") ?? "";
  const isHtml = contentType.toLowerCase().includes("text/html");
  const headers = responseHeaders(upstream, { rewrittenBody: isHtml });
  const location = upstream.headers.get("location");

  if (location) {
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
    const isWebSocketRoute = incoming.pathname.startsWith(WEBSOCKET_PROXY_PREFIX);
    const isHttpProxyRoute = incoming.pathname.startsWith(HTTP_PROXY_PREFIX);

    // Internal endpoint typos and non-HTTP schemes fail closed instead of
    // falling back to the canonical upstream.
    const target = upstreamFromRequestUrl(request.url, isWebSocketRoute ? "websocket" : "http");
    if (!target || !isBloxdHost(target.hostname)) {
      return new Response("Not found.", { status: 404 });
    }

    if (isWebSocketRoute) return proxyWebSocket(request, target);
    if (isHttpProxyRoute || !incoming.pathname.startsWith(WEBSOCKET_PROXY_PREFIX)) {
      return proxyHttp(request, target);
    }

    return new Response("Not found.", { status: 404 });
  },
};
