const PROXY_PREFIX = "/__proxy__/";
const MAX_REWRITTEN_CSS_CHARS = 2_000_000;
const MAX_URL_LENGTH = 16_384;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "Accept, Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since, Range, X-Proxy-Source, X-Requested-With",
    "access-control-max-age": "86400",
  };
}

function isPrivateOrReservedIPv4(host) {
  const parts = host.split(".");

  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }

  const octets = parts.map(Number);

  if (octets.some((value) => value < 0 || value > 255)) {
    return true;
  }

  const [a, b, c] = octets;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isPublicHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (!host || host.length > 253) return false;
  if (host.includes(":")) return false;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return !isPrivateOrReservedIPv4(host);
  }

  if (isPrivateOrReservedIPv4(host)) return false;
  if (/^\d+(?:\.\d+){0,3}$/.test(host)) return false;
  if (!host.includes(".")) return false;

  const blockedSuffixes = [
    ".localhost",
    ".local",
    ".internal",
    ".home",
    ".lan",
    ".test",
    ".invalid",
  ];

  if (
    host === "localhost" ||
    host === "metadata.google.internal" ||
    blockedSuffixes.some((suffix) => host.endsWith(suffix))
  ) {
    return false;
  }

  return true;
}

function normalizeTarget(value, base) {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
    return null;
  }

  try {
    const target = new URL(value, base);

    if (target.protocol !== "https:" && target.protocol !== "http:") {
      return null;
    }

    if (target.username || target.password || target.port) {
      return null;
    }

    if (!isPublicHostname(target.hostname)) {
      return null;
    }

    target.hash = target.hash || "";

    return target;
  } catch {
    return null;
  }
}

function proxyBasePath(target, token) {
  return `${PROXY_PREFIX}${encodeURIComponent(token)}/${target.protocol.slice(0, -1)}/${target.host}`;
}

function makeProxyUrl(target, proxyOrigin, token) {
  return `${proxyOrigin}${proxyBasePath(target, token)}${target.pathname}${target.search}${target.hash}`;
}

function parseProxyTarget(requestUrl, expectedToken) {
  const rest = requestUrl.pathname.slice(PROXY_PREFIX.length);
  const tokenEnd = rest.indexOf("/");

  if (tokenEnd <= 0) {
    return { error: "invalid_path", status: 400 };
  }

  let suppliedToken;

  try {
    suppliedToken = decodeURIComponent(rest.slice(0, tokenEnd));
  } catch {
    return { error: "invalid_token", status: 401 };
  }

  if (!expectedToken || suppliedToken !== expectedToken) {
    return { error: "invalid_token", status: 401 };
  }

  const targetPart = rest.slice(tokenEnd + 1);
  const firstSlash = targetPart.indexOf("/");

  if (firstSlash <= 0) {
    return { error: "invalid_path", status: 400 };
  }

  const scheme = targetPart.slice(0, firstSlash);
  const afterScheme = targetPart.slice(firstSlash + 1);
  const secondSlash = afterScheme.indexOf("/");
  const host = secondSlash === -1
    ? afterScheme
    : afterScheme.slice(0, secondSlash);
  const path = secondSlash === -1
    ? "/"
    : afterScheme.slice(secondSlash);

  if ((scheme !== "http" && scheme !== "https") || !host) {
    return { error: "invalid_target", status: 400 };
  }

  const target = normalizeTarget(
    `${scheme}://${host}${path}${requestUrl.search}`
  );

  return target
    ? { target }
    : { error: "blocked_target", status: 403 };
}

function cleanResponseHeaders(sourceHeaders) {
  const headers = new Headers(sourceHeaders);

  const remove = [
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
    "cross-origin-embedder-policy",
    "cross-origin-opener-policy",
    "cross-origin-resource-policy",
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "set-cookie",
    "set-cookie2",
    "etag",
    "content-md5",
    "strict-transport-security",
    "permissions-policy",
  ];

  for (const name of remove) {
    headers.delete(name);
  }

  for (const [name, value] of Object.entries(corsHeaders())) {
    headers.set(name, value);
  }

  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "same-origin");

  return headers;
}

function rewriteOneUrl(value, baseUrl, proxyOrigin, token) {
  if (
    !value ||
    value.startsWith("#") ||
    /^\s*(?:data|javascript|mailto|tel|blob|about):/i.test(value)
  ) {
    return value;
  }

  const target = normalizeTarget(value.trim(), baseUrl);

  return target
    ? makeProxyUrl(target, proxyOrigin, token)
    : value;
}

function rewriteSrcset(value, baseUrl, proxyOrigin, token) {
  if (!value || /(?:^|,)\s*data:/i.test(value)) {
    return value;
  }

  return value.split(",").map((candidate) => {
    const trimmed = candidate.trim();
    const match = trimmed.match(/^(\S+)(\s+.*)?$/);

    if (!match) return candidate;

    return `${rewriteOneUrl(match[1], baseUrl, proxyOrigin, token)}${match[2] || ""}`;
  }).join(", ");
}

function rewriteCss(css, baseUrl, proxyOrigin, token) {
  let result = css.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi,
    (whole, doubleQuoted, singleQuoted, bare) => {
      const raw = (doubleQuoted ?? singleQuoted ?? bare ?? "").trim();
      const rewritten = rewriteOneUrl(raw, baseUrl, proxyOrigin, token);

      if (doubleQuoted !== undefined) {
        return `url("${rewritten}")`;
      }

      if (singleQuoted !== undefined) {
        return `url('${rewritten}')`;
      }

      return `url(${rewritten})`;
    }
  );

  result = result.replace(
    /@import\s+(?:url\()?\s*(?:"([^"]+)"|'([^']+)'|([^\s;)]+))\s*\)?/gi,
    (whole, doubleQuoted, singleQuoted, bare) => {
      const raw = doubleQuoted ?? singleQuoted ?? bare;
      const rewritten = rewriteOneUrl(raw, baseUrl, proxyOrigin, token);

      if (doubleQuoted !== undefined) {
        return whole.replace(doubleQuoted, rewritten);
      }

      if (singleQuoted !== undefined) {
        return whole.replace(singleQuoted, rewritten);
      }

      return whole.replace(bare, rewritten);
    }
  );

  return result;
}

class AttributeUrlHandler {
  constructor(attribute, baseUrl, proxyOrigin, token, kind = "url") {
    this.attribute = attribute;
    this.baseUrl = baseUrl;
    this.proxyOrigin = proxyOrigin;
    this.token = token;
    this.kind = kind;
  }

  element(element) {
    const value = element.getAttribute(this.attribute);

    if (value === null) return;

    let rewritten = value;

    if (this.kind === "srcset") {
      rewritten = rewriteSrcset(
        value,
        this.baseUrl,
        this.proxyOrigin,
        this.token
      );
    } else if (this.kind === "style") {
      rewritten = rewriteCss(
        value,
        this.baseUrl,
        this.proxyOrigin,
        this.token
      );
    } else {
      rewritten = rewriteOneUrl(
        value,
        this.baseUrl,
        this.proxyOrigin,
        this.token
      );
    }

    if (rewritten !== value) {
      element.setAttribute(this.attribute, rewritten);
    }
  }
}

function buildClientPatch(target, proxyOrigin, token) {
  const config = JSON.stringify({
    proxyOrigin,
    prefix: PROXY_PREFIX,
    token,
    targetUrl: target.href,
  }).replace(/</g, "\\u003c");

  const patch = `
(() => {
  'use strict';

  try {
    const config = ${config};
    const tokenPath = config.prefix + encodeURIComponent(config.token) + "/";

    const toProxyUrl = (value, base = document.baseURI) => {
      try {
        const raw = value instanceof Request ? value.url : String(value);
        const url = new URL(raw, base);

        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return value;
        }

        if (
          url.origin === config.proxyOrigin &&
          url.pathname.startsWith(tokenPath)
        ) {
          return url.href;
        }

        return config.proxyOrigin +
          tokenPath +
          url.protocol.slice(0, -1) +
          "/" +
          url.host +
          url.pathname +
          url.search +
          url.hash;
      } catch {
        return value;
      }
    };

    const isProxyUrl = (value) => {
      try {
        const url = new URL(value, document.baseURI);

        return (
          url.origin === config.proxyOrigin &&
          url.pathname.startsWith(tokenPath)
        );
      } catch {
        return false;
      }
    };

    const mergeHeaders = (initial, overrides, useProxy) => {
      const headers = new Headers(initial || undefined);

      if (overrides) {
        new Headers(overrides).forEach((value, name) => {
          headers.set(name, value);
        });
      }

      if (useProxy) {
        headers.set("X-Proxy-Source", config.targetUrl);
      }

      return headers;
    };

    const originalFetch = window.fetch.bind(window);

    window.fetch = (input, init) => {
      try {
        const raw = input instanceof Request ? input.url : input;
        const url = toProxyUrl(raw);
        const useProxy = isProxyUrl(url);

        const request = input instanceof Request
          ? new Request(url, input)
          : new Request(url, init);

        const options = {
          ...(init || {}),
          headers: mergeHeaders(
            request.headers,
            init && init.headers,
            useProxy
          ),
        };

        if (useProxy) {
          options.credentials = "omit";
        }

        return originalFetch(new Request(request, options));
      } catch {
        return originalFetch(input, init);
      }
    };

    const originalXhrOpen = XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__twProxyUrl = toProxyUrl(url);

      return originalXhrOpen.call(
        this,
        method,
        this.__twProxyUrl,
        ...rest
      );
    };

    const originalXhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (isProxyUrl(this.__twProxyUrl)) {
          this.setRequestHeader(
            "X-Proxy-Source",
            config.targetUrl
          );
        }
      } catch {
      }

      return originalXhrSend.call(this, body);
    };

    if (navigator.sendBeacon) {
      const originalSendBeacon = navigator.sendBeacon.bind(navigator);

      navigator.sendBeacon = (url, data) => {
        return originalSendBeacon(toProxyUrl(url), data);
      };
    }

    const originalWindowOpen = window.open.bind(window);

    window.open = (url, ...args) => {
      return originalWindowOpen(
        url ? toProxyUrl(url) : url,
        ...args
      );
    };

    const originalPushState = history.pushState.bind(history);

    history.pushState = (...args) => {
      const result = originalPushState(...args);
      notifyParentUrl();
      return result;
    };

    const originalReplaceState = history.replaceState.bind(history);

    history.replaceState = (...args) => {
      const result = originalReplaceState(...args);
      notifyParentUrl();
      return result;
    };

    window.addEventListener("popstate", notifyParentUrl);
    window.addEventListener("hashchange", notifyParentUrl);

    window.addEventListener("message", (event) => {
      const data = event.data;

      if (!data || data.source !== "turbowarp-web-viewer-control") {
        return;
      }

      if (data.action === "reload") location.reload();
      if (data.action === "back") history.back();
      if (data.action === "forward") history.forward();
    });

    function notifyParentUrl() {
      try {
        const url = new URL(location.href);

        if (
          url.origin !== config.proxyOrigin ||
          !url.pathname.startsWith(tokenPath)
        ) {
          return;
        }

        const rest = url.pathname.slice(tokenPath.length);
        const separator = rest.indexOf("/");

        if (separator <= 0) return;

        const scheme = rest.slice(0, separator);
        const afterScheme = rest.slice(separator + 1);
        const hostSeparator = afterScheme.indexOf("/");
        const host = hostSeparator === -1
          ? afterScheme
          : afterScheme.slice(0, hostSeparator);
        const path = hostSeparator === -1
          ? "/"
          : afterScheme.slice(hostSeparator);

        if (scheme !== "http" && scheme !== "https") {
          return;
        }

        const target = new URL(
          scheme + "://" + host + path + url.search + url.hash
        );

        parent.postMessage({
          source: "turbowarp-web-viewer",
          url: target.href,
        }, "*");
      } catch {
      }
    }

    notifyParentUrl();

    if (window.Worker) {
      const OriginalWorker = window.Worker;

      window.Worker = function (url, options) {
        return new OriginalWorker(toProxyUrl(url), options);
      };

      window.Worker.prototype = OriginalWorker.prototype;
    }

    if (window.SharedWorker) {
      const OriginalSharedWorker = window.SharedWorker;

      window.SharedWorker = function (url, options) {
        return new OriginalSharedWorker(toProxyUrl(url), options);
      };

      window.SharedWorker.prototype = OriginalSharedWorker.prototype;
    }
  } catch (error) {
    console.warn(
      "TurboWarp Web Viewer compatibility patch failed",
      error
    );
  }
})();`;

  return `<script>${patch}</script>`;
}

class HeadHandler {
  constructor(baseHref, clientPatch) {
    this.prefix = `<base href="${baseHref.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">${clientPatch}`;
  }

  element(element) {
    element.prepend(this.prefix, { html: true });
  }
}

class MetaHandler {
  constructor(baseUrl, proxyOrigin, token) {
    this.baseUrl = baseUrl;
    this.proxyOrigin = proxyOrigin;
    this.token = token;
  }

  element(element) {
    const httpEquiv = (element.getAttribute("http-equiv") || "").toLowerCase();

    if (httpEquiv === "content-security-policy") {
      element.remove();
      return;
    }

    if (httpEquiv !== "refresh") return;

    const content = element.getAttribute("content");

    if (!content) return;

    const match = content.match(
      /url\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(.+))$/i
    );

    if (!match) return;

    const original = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const rewritten = rewriteOneUrl(
      original,
      this.baseUrl,
      this.proxyOrigin,
      this.token
    );

    if (rewritten === original) return;

    element.setAttribute(
      "content",
      content.replace(original, rewritten)
    );
  }
}

function rewriteHtml(response, target, proxyOrigin, token) {
  const baseHref = makeProxyUrl(target, proxyOrigin, token).replace(/#.*$/, "");
  const clientPatch = buildClientPatch(target, proxyOrigin, token);

  const rewriter = new HTMLRewriter()
    .on("head", new HeadHandler(baseHref, clientPatch))
    .on("base", {
      element(element) {
        element.remove();
      },
    })
    .on(
      "meta[http-equiv]",
      new MetaHandler(target.href, proxyOrigin, token)
    )
    .on(
      "[href]",
      new AttributeUrlHandler("href", target.href, proxyOrigin, token)
    )
    .on(
      "[src]",
      new AttributeUrlHandler("src", target.href, proxyOrigin, token)
    )
    .on(
      "[action]",
      new AttributeUrlHandler("action", target.href, proxyOrigin, token)
    )
    .on(
      "[formaction]",
      new AttributeUrlHandler("formaction", target.href, proxyOrigin, token)
    )
    .on(
      "[data]",
      new AttributeUrlHandler("data", target.href, proxyOrigin, token)
    )
    .on(
      "[poster]",
      new AttributeUrlHandler("poster", target.href, proxyOrigin, token)
    )
    .on(
      "[srcset]",
      new AttributeUrlHandler(
        "srcset",
        target.href,
        proxyOrigin,
        token,
        "srcset"
      )
    )
    .on(
      "[style]",
      new AttributeUrlHandler(
        "style",
        target.href,
        proxyOrigin,
        token,
        "style"
      )
    );

  return rewriter.transform(response);
}

function makeUpstreamHeaders(request, target) {
  const headers = new Headers();

  const accepted = [
    "accept",
    "accept-language",
    "authorization",
    "cache-control",
    "content-type",
    "if-match",
    "if-modified-since",
    "if-none-match",
    "if-unmodified-since",
    "pragma",
    "range",
    "x-requested-with",
  ];

  for (const name of accepted) {
    const value = request.headers.get(name);

    if (value) {
      headers.set(name, value);
    }
  }

  const sourceHeader = request.headers.get("x-proxy-source");
  const sourcePage = sourceHeader
    ? normalizeTarget(sourceHeader)
    : null;

  if (sourcePage) {
    headers.set("referer", sourcePage.href.split("#")[0]);

    if (request.headers.has("origin")) {
      headers.set("origin", sourcePage.origin);
    }
  } else if (request.headers.has("origin")) {
    headers.set("origin", target.origin);
  }

  return headers;
}

async function handleProxyRequest(request, requestUrl, env) {
  const token = env.PROXY_TOKEN;

  if (!token || token.length < 24) {
    return jsonResponse({
      error: "Proxy is not configured. Set a strong PROXY_TOKEN secret.",
    }, 503);
  }

  const parsed = parseProxyTarget(requestUrl, token);

  if (parsed.error) {
    return jsonResponse(
      { error: parsed.error },
      parsed.status
    );
  }

  const target = parsed.target;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (!ALLOWED_METHODS.has(request.method)) {
    return jsonResponse({
      error: "This HTTP method is not supported.",
    }, 405, {
      allow: [...ALLOWED_METHODS].join(", "),
    });
  }

  let upstream;

  try {
    upstream = await fetch(target.href, {
      method: request.method,
      headers: makeUpstreamHeaders(request, target),
      body: ["GET", "HEAD"].includes(request.method)
        ? null
        : request.body,
      redirect: "manual",
    });
  } catch {
    return jsonResponse({
      error: "The upstream request failed or the destination could not be reached.",
    }, 502);
  }

  const headers = cleanResponseHeaders(upstream.headers);
  const location = upstream.headers.get("location");

  if (location && [301, 302, 303, 307, 308].includes(upstream.status)) {
    const redirected = normalizeTarget(location, target.href);

    if (!redirected) {
      return jsonResponse({
        error: "The upstream redirected to an unsupported or blocked destination.",
      }, 502);
    }

    headers.set(
      "location",
      makeProxyUrl(redirected, requestUrl.origin, token)
    );

    return new Response(null, {
      status: upstream.status,
      headers,
    });
  }

  const contentType = (
    upstream.headers.get("content-type") || ""
  ).toLowerCase();

  if (
    contentType.includes("text/html") &&
    request.method !== "HEAD"
  ) {
    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });

    return rewriteHtml(
      response,
      target,
      requestUrl.origin,
      token
    );
  }

  if (
    contentType.includes("text/css") &&
    request.method !== "HEAD"
  ) {
    const declaredLength = Number(
      upstream.headers.get("content-length") || 0
    );

    if (
      declaredLength > 0 &&
      declaredLength <= MAX_REWRITTEN_CSS_CHARS
    ) {
      const css = await upstream.text();

      if (css.length <= MAX_REWRITTEN_CSS_CHARS) {
        return new Response(
          rewriteCss(css, target.href, requestUrl.origin, token),
          {
            status: upstream.status,
            statusText: upstream.statusText,
            headers,
          }
        );
      }

      return new Response(css, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }
  }

  return new Response(
    request.method === "HEAD" ? null : upstream.body,
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    }
  );
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === "/health") {
      return jsonResponse({
        status: "ok",
        tokenConfigured: Boolean(
          env.PROXY_TOKEN && env.PROXY_TOKEN.length >= 24
        ),
      });
    }

    if (!requestUrl.pathname.startsWith(PROXY_PREFIX)) {
      return jsonResponse({
        name: "TurboWarp Web Viewer Proxy",
        version: "0.2.0",
        status: "ready",
        health: "/health",
        authentication: "shared token",
        usage: `${PROXY_PREFIX}<token>/https/example.com/`,
      });
    }

    return handleProxyRequest(request, requestUrl, env);
  },
};
