import {
  GATEWAY_AUTH_COOKIE,
  GATEWAY_ROUTE_PREFIX,
  encodeSessionCookieValue,
  isProviderUrl,
  linkedSessionFromRequest,
  sanitizeSessionCookie,
  sessionCookieHeader,
} from "./session.mjs";

const LOGIN_PATH = `${GATEWAY_ROUTE_PREFIX}/login`;
const LOGOUT_PATH = `${GATEWAY_ROUTE_PREFIX}/logout`;
const STATUS_PATH = `${GATEWAY_ROUTE_PREFIX}/status`;
const SESSION_PATH = `${GATEWAY_ROUTE_PREFIX}/session`;

const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
  "img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeProviderUrl(value) {
  if (!value) return null;
  return isProviderUrl(value) ? String(value) : null;
}

/**
 * Small, dependency-free page used for both the "sign in" bridge and the
 * interception of Bloxd's redirect towards Google/Discord/Apple/Microsoft.
 */
export function renderLoginPage({ linked = false, providerUrl = null, error = null, notice = null } = {}) {
  const provider = safeProviderUrl(providerUrl);
  const providerJson = provider ? JSON.stringify(provider).replace(/</g, "\\u003c") : "null";

  const statusBlock = linked
    ? `<p class="status ok" role="status">接続済み — このブラウザはアカウントセッションで Bloxd に接続しています。<br /><span class="en">Connected: requests are sent with your Bloxd account session.</span></p>
       <div class="actions">
         <a class="button" href="/">ゲームに戻る / Back to the game</a>
         <form method="post" action="${escapeHtml(LOGOUT_PATH)}">
           <button class="button ghost" type="submit">接続解除 / Unlink</button>
         </form>
       </div>`
    : "";

  const errorBlock = error ? `<p class="status error" role="alert">${escapeHtml(error)}</p>` : "";
  const noticeBlock = notice ? `<p class="status ok" role="status">${escapeHtml(notice)}</p>` : "";

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ログイン / Sign in — Bloxd gateway</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 32px 20px;
    background: #12131a; color: #e7e9f3;
    font: 15px/1.65 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 6px; }
  h2 { font-size: 15px; margin: 28px 0 8px; color: #b7bce0; }
  p { margin: 0 0 12px; }
  .lead { color: #a6abc8; }
  .en { color: #7f85a8; font-size: 13px; }
  ol { padding-left: 20px; margin: 0 0 12px; }
  li { margin-bottom: 8px; }
  code, kbd { background: #1c1f2b; border: 1px solid #2b3045; border-radius: 5px; padding: 1px 6px; font-size: 13px; }
  .status { border-radius: 10px; padding: 12px 14px; margin: 18px 0; border: 1px solid #2b3045; background: #1a1d29; }
  .status.ok { border-color: #2f6b4f; background: #14251d; }
  .status.error { border-color: #7c3b3b; background: #2a1616; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 8px; }
  textarea {
    width: 100%; min-height: 96px; padding: 10px 12px; resize: vertical;
    background: #0e1016; color: #e7e9f3; border: 1px solid #2b3045; border-radius: 10px;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .button {
    display: inline-block; padding: 10px 16px; border-radius: 10px; border: 1px solid #3c4468;
    background: #232842; color: #e7e9f3; font: inherit; text-decoration: none; cursor: pointer;
  }
  .button:hover { background: #2c3252; }
  .button.primary { background: #4a5bd8; border-color: #5f70f0; }
  .button.primary:hover { background: #576ae4; }
  .button.ghost { background: transparent; }
  form { margin: 0; }
  .note { margin-top: 28px; color: #7f85a8; font-size: 12.5px; border-top: 1px solid #23263a; padding-top: 14px; }
</style>
</head>
<body>
<main>
  <h1>Bloxd にログイン / Sign in to Bloxd</h1>
  <p class="lead">
    このゲートウェイは別ドメインで動いているため、Google・Discord などのログイン画面から戻ってくる先は
    本物の <code>bloxd.io</code> のままです（OAuth はドメインを跨げません）。<br />
    <span class="en">The OAuth callback always lands on the real bloxd.io origin, so sign in there once and hand the resulting session to this gateway.</span>
  </p>

  ${statusBlock}
  ${errorBlock}
  ${noticeBlock}

  <h2>1. 本物の Bloxd でログイン / Sign in on bloxd.io</h2>
  <p>
    Google / Apple / Microsoft / Discord のログインはプロキシせず、本物のサイトでそのまま行います。
    <span class="en">Providers are never proxied; they run first party.</span>
  </p>
  <p id="provider-line" hidden>
    新しいタブでログイン画面を開きました。完了したらこのタブに戻ってください。
    <span class="en">The provider page was opened in a new tab.</span>
  </p>
  <div class="actions">
    <a class="button" id="signin-link" href="https://bloxd.io/" target="_blank" rel="noopener noreferrer">bloxd.io を開く / Open bloxd.io</a>
  </div>

  <h2>2. セッションをコピー / Copy the session cookie</h2>
  <ol>
    <li>ログイン済みの <code>bloxd.io</code> タブで <kbd>F12</kbd> を押し、DevTools を開きます。</li>
    <li><strong>Application</strong> → <strong>Cookies</strong> → <code>https://bloxd.io</code> を選びます。<br />
      <span class="en">Or open Network → any request → Request Headers → copy the whole <code>Cookie:</code> value.</span></li>
    <li>ゲームのセッション用クッキー（例: <code>session</code>, <code>token</code>, <code>__Secure-…</code>）をまとめてコピーします。</li>
  </ol>

  <h2>3. ここに貼り付けて接続 / Paste and link</h2>
  <form method="post" action="${escapeHtml(LOGIN_PATH)}">
    <textarea name="cookie" spellcheck="false" autocomplete="off" placeholder="session=…; token=…" aria-label="Bloxd cookie"></textarea>
    <div class="actions">
      <button class="button primary" type="submit">接続する / Link session</button>
      ${linked ? `<span class="en">現在の接続は貼り付け直すと置き換わります。</span>` : ""}
    </div>
  </form>

  <p class="note">
    貼り付けた値はこのブラウザの <code>${escapeHtml(GATEWAY_AUTH_COOKIE)}</code> クッキー（HttpOnly / Secure /
    SameSite=Lax）にだけ保存され、<code>*.bloxd.io</code> 宛のリクエストに付与されます。ゲートウェイが他のホストへ
    転送することはありません。<br />
    <span class="en">The value is kept only in this browser's HttpOnly cookie and is replayed only to *.bloxd.io. Unlink any time with the button above.</span>
  </p>
</main>
<script>
(() => {
  "use strict";
  const providerUrl = ${providerJson};
  if (providerUrl) {
    const line = document.getElementById("provider-line");
    if (line) line.hidden = false;
    const link = document.getElementById("signin-link");
    if (link) link.href = providerUrl;
    // Open the real provider page; the gateway never proxies it. The opener is
    // kept on purpose: if Bloxd's callback page hands the session back with
    // postMessage, the listener below links it without any copy/paste.
    window.open(providerUrl, "bloxd-signin");
  }

  // If a Bloxd page (for example an embed integration) posts its session to the
  // opener, link it automatically instead of asking for a copy/paste.
  window.addEventListener("message", async (event) => {
    try {
      if (!/(^|\\.)bloxd\\.io$/.test(new URL(event.origin).hostname)) return;
      const data = event.data;
      const candidate =
        typeof data === "string"
          ? data
          : data && typeof data === "object"
            ? data.cookie ?? data.sessionCookie ?? data.session ?? data.token ?? data.authToken ?? data.accessToken
            : null;
      if (typeof candidate !== "string" || !candidate) return;
      const response = await fetch(${JSON.stringify(SESSION_PATH)}, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cookie: candidate }),
      });
      if (response.ok) location.reload();
    } catch {
      /* ignore malformed messages */
    }
  });
})();
</script>
</body>
</html>`;
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": PAGE_CSP,
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
    },
  });
}

export function loginPageResponse(options) {
  return htmlResponse(renderLoginPage(options));
}

export function redirectResponse(location, headers = {}) {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...headers } });
}

function originOf(request) {
  return new URL(request.url).origin;
}

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Handles /_bloxd_gateway_/* . Returns null for paths this module does not own.
 */
export async function handleGatewayRoute(request) {
  const url = new URL(request.url);
  const { pathname } = url;
  const linked = Boolean(linkedSessionFromRequest(request.headers.get("cookie")));

  if (pathname === `${GATEWAY_ROUTE_PREFIX}` || pathname === `${GATEWAY_ROUTE_PREFIX}/`) {
    return redirectResponse(`${GATEWAY_ROUTE_PREFIX}/login`);
  }

  if (pathname === LOGIN_PATH && request.method === "GET") {
    const provider = url.searchParams.get("provider");
    const linkedNow = linked || url.searchParams.get("linked") === "1";
    return loginPageResponse({
      linked: linkedNow,
      providerUrl: safeProviderUrl(provider),
      error: url.searchParams.get("error"),
      notice: url.searchParams.get("notice"),
    });
  }

  if (pathname === LOGIN_PATH && request.method === "POST") {
    const contentType = request.headers.get("content-type") ?? "";
    let raw = null;

    if (contentType.includes("application/json")) {
      const body = await readJson(request);
      raw = body?.cookie ?? null;
    } else {
      const form = await request.formData().catch(() => null);
      const value = form?.get("cookie");
      raw = typeof value === "string" ? value : null;
    }

    const cookie = sanitizeSessionCookie(raw);
    const wantsJson = contentType.includes("application/json");

    if (!cookie) {
      if (wantsJson) {
        return Response.json({ ok: false, error: "invalid_cookie" }, { status: 400, headers: { "cache-control": "no-store" } });
      }
      return redirectResponse(
        `${GATEWAY_ROUTE_PREFIX}/login?error=${encodeURIComponent(
          "クッキーの形式が正しくありません / That does not look like a Cookie header.",
        )}`,
      );
    }

    const value = encodeSessionCookieValue(cookie);
    const setCookie = sessionCookieHeader(value, { maxAge: 60 * 60 * 24 * 30 });

    if (wantsJson) {
      return Response.json({ ok: true }, { status: 200, headers: { "cache-control": "no-store", "set-cookie": setCookie } });
    }

    return redirectResponse(`${originOf(request)}${GATEWAY_ROUTE_PREFIX}/login?linked=1`, { "set-cookie": setCookie });
  }

  if (pathname === SESSION_PATH && request.method === "POST") {
    const body = await readJson(request);
    const cookie = sanitizeSessionCookie(body?.cookie);
    if (!cookie) {
      return Response.json({ ok: false, error: "invalid_cookie" }, { status: 400, headers: { "cache-control": "no-store" } });
    }
    return Response.json(
      { ok: true },
      {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "set-cookie": sessionCookieHeader(encodeSessionCookieValue(cookie), { maxAge: 60 * 60 * 24 * 30 }),
        },
      },
    );
  }

  if (pathname === LOGOUT_PATH && request.method === "POST") {
    return redirectResponse(`${originOf(request)}${GATEWAY_ROUTE_PREFIX}/login?notice=${encodeURIComponent(
      "接続を解除しました / Session unlinked.",
    )}`, { "set-cookie": sessionCookieHeader("", { maxAge: 0 }) });
  }

  if (pathname === STATUS_PATH && request.method === "GET") {
    return Response.json(
      { linked },
      { status: 200, headers: { "cache-control": "no-store", "access-control-allow-origin": originOf(request) } },
    );
  }

  return new Response("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
}
