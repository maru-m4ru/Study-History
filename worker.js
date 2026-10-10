const ALLOWED_HOSTS = [
  "example.com",
  // Add the target domains and any required CDN domains here.
  // "wikipedia.org",
  // "wikimedia.org",
];

const PROXY_PREFIX = "/__proxy__/";
const MAX_REWRITTEN_CSS_CHARS = 2_000_000;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Content-Type, Range",
    "access-control-max-age": "86400",
  };
}

function isAllowedHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (!host || host.includes(":") || /^\d+(\.\d+){0,3}$/.test(host)) {
    return false;
  }

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return false;
  }

  return ALLOWED_HOSTS.some((entry) => {
    const allowed = entry.toLowerCase().replace(/^\.+|\.+$/g, "");
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

function normalizeTarget(value, base) {
  try {
    const target = new URL(value, base);

    if (target.protocol !== "https:" && target.protocol !== "http:") {
      return null;
    }

    if (target.username || target.password || target.port) {
      return null;
    }

    if (!isAllowedHost(target.hostname)) {
      return null;
    }

    return target;
  } catch {
    return null;
  }
}

function makeProxyUrl(target, proxyOrigin) {
  return `${proxyOrigin}${PROXY_PREFIX}${target.protocol.slice(0, -1)}/${target.host}${target.pathname}${target.search}${target.hash}`;
}

function parseProxyTarget(requestUrl) {
  const rest = requestUrl.pathname.slice(PROXY_PREFIX.length);
  const firstSlash = rest.indexOf("/");

  if (firstSlash <= 0) {
    return null;
  }

  const scheme = rest.slice(0, firstSlash);
  const afterScheme = rest.slice(firstSlash + 1);
  const secondSlash = afterScheme.indexOf("/");
  const host = secondSlash === -1 ? afterScheme : afterScheme.slice(0, secondSlash);
  const path = secondSlash === -1 ? "/" : afterScheme.slice(secondSlash);

  if ((scheme !== "http" && scheme !== "https") || !host) {
    return null;
  }

  try {
    const target = new URL(`${scheme}://${host}${path}${requestUrl.search}`);

    if (target.username || target.password || target.port || !isAllowedHost(target.hostname)) {
      return null;
    }

    return target;
  } catch {
    return null;
  }
}

function makeUpstreamHeaders(request) {
  const headers = new Headers();
  const accepted = ["accept", "accept-language", "range"];

  for (const name of accepted) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  return headers;
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
  ];

  for (const name of remove) headers.delete(name);

  for (const [name, value] of Object.entries(corsHeaders())) {
    headers.set(name, value);
  }

  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  return headers;
}

function rewriteOneUrl(value, baseUrl, proxyOrigin) {
  if (!value || value.startsWith("#") || /^\s*(?:data|javascript|mailto|tel|blob):/i.test(value)) {
    return value;
  }

  const target = normalizeTarget(value.trim(), baseUrl);
  return target ? makeProxyUrl(target, proxyOrigin) : value;
}

function rewriteSrcset(value, baseUrl, proxyOrigin) {
  if (!value || /(?:^|,)\s*data:/i.test(value)) return value;

  return value.split(",").map((candidate) => {
    const trimmed = candidate.trim();
    const match = trimmed.match(/^(\S+)(\s+.*)?$/);
    if (!match) return candidate;
    return `${rewriteOneUrl(match[1], baseUrl, proxyOrigin)}${match[2] || ""}`;
  }).join(", ");
}

function rewriteCss(css, baseUrl, proxyOrigin) {
  let result = css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi, (whole, doubleQuoted, singleQuoted, bare) => {
    const raw = (doubleQuoted ?? singleQuoted ?? bare ?? "").trim();
    const rewritten = rewriteOneUrl(raw, baseUrl, proxyOrigin);

    if (doubleQuoted !== undefined) return `url("${rewritten}")`;
    if (singleQuoted !== undefined) return `url('${rewritten}')`;
    return `url(${rewritten})`;
  });

  result = result.replace(/@import\s+(?:url\()?\s*(?:"([^"]+)"|'([^']+)'|([^\s;)]+))\s*\)?/gi, (whole, doubleQuoted, singleQuoted, bare) => {
    const raw = doubleQuoted ?? singleQuoted ?? bare;
    const rewritten = rewriteOneUrl(raw, baseUrl, proxyOrigin);

    if (doubleQuoted !== undefined) return whole.replace(doubleQuoted, rewritten);
    if (singleQuoted !== undefined) return whole.replace(singleQuoted, rewritten);
    return whole.replace(bare, rewritten);
  });

  return result;
}

class AttributeUrlHandler {
  constructor(attribute, baseUrl, proxyOrigin, kind = "url") {
    this.attribute = attribute;
    this.baseUrl = baseUrl;
    this.proxyOrigin = proxyOrigin;
    this.kind = kind;
  }

  element(element) {
    const value = element.getAttribute(this.attribute);
    if (value === null) return;

    let rewritten = value;

    if (this.kind === "srcset") {
      rewritten = rewriteSrcset(value, this.baseUrl, this.proxyOrigin);
    } else if (this.kind === "style") {
      rewritten = rewriteCss(value, this.baseUrl, this.proxyOrigin);
    } else {
      rewritten = rewriteOneUrl(value, this.baseUrl, this.proxyOrigin);
    }

    if (rewritten !== value) element.setAttribute(this.attribute, rewritten);
  }
}

class HeadHandler {
  constructor(baseHref) {
    this.baseHref = baseHref.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  element(element) {
    element.prepend(`<base href="${this.baseHref}">`, { html: true });
  }
}

class MetaHandler {
  constructor(baseUrl, proxyOrigin) {
    this.baseUrl = baseUrl;
    this.proxyOrigin = proxyOrigin;
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

    const match = content.match(/url\s*=\s*(?:"([^"]*)"|'([^']*)'|(.+))$/i);
    if (!match) return;

    const original = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const rewritten = rewriteOneUrl(original, this.baseUrl, this.proxyOrigin);
    if (rewritten === original) return;

    const replacement = content.replace(original, rewritten);
    element.setAttribute("content", replacement);
  }
}

function rewriteHtml(response, target, proxyOrigin) {
  const baseHref = makeProxyUrl(target, proxyOrigin).replace(/#.*$/, "");
  const baseUrl = target.href;
  const rewriter = new HTMLRewriter()
    .on("head", new HeadHandler(baseHref))
    .on("base", {
      element(element) {
        element.remove();
      },
    })
    .on("meta[http-equiv]", new MetaHandler(baseUrl, proxyOrigin))
    .on("[href]", new AttributeUrlHandler("href", baseUrl, proxyOrigin))
    .on("[src]", new AttributeUrlHandler("src", baseUrl, proxyOrigin))
    .on("[action]", new AttributeUrlHandler("action", baseUrl, proxyOrigin))
    .on("[formaction]", new AttributeUrlHandler("formaction", baseUrl, proxyOrigin))
    .on("[data]", new AttributeUrlHandler("data", baseUrl, proxyOrigin))
    .on("[poster]", new AttributeUrlHandler("poster", baseUrl, proxyOrigin))
    .on("[srcset]", new AttributeUrlHandler("srcset", baseUrl, proxyOrigin, "srcset"))
    .on("[style]", new AttributeUrlHandler("style", baseUrl, proxyOrigin, "style"));

  return rewriter.transform(response);
}

async function handleProxyRequest(request, requestUrl) {
  const target = parseProxyTarget(requestUrl);

  if (!target) {
    return jsonResponse({
      error: "This URL is invalid or its host is not in ALLOWED_HOSTS.",
      allowedHosts: ALLOWED_HOSTS,
    }, 403);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ error: "Only GET and HEAD requests are supported in this first version." }, 405);
  }

  let upstream;

  try {
    upstream = await fetch(target.href, {
      method: request.method,
      headers: makeUpstreamHeaders(request),
      redirect: "manual",
    });
  } catch (error) {
    return jsonResponse({ error: "The upstream request failed.", detail: String(error) }, 502);
  }

  const headers = cleanResponseHeaders(upstream.headers);
  const location = upstream.headers.get("location");

  if (location && [301, 302, 303, 307, 308].includes(upstream.status)) {
    const redirected = normalizeTarget(location, target.href);
    headers.set("location", redirected ? makeProxyUrl(redirected, requestUrl.origin) : location);
    return new Response(null, { status: upstream.status, headers });
  }

  const contentType = (upstream.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("text/html") && request.method !== "HEAD") {
    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });

    return rewriteHtml(response, target, requestUrl.origin);
  }

  if (contentType.includes("text/css") && request.method !== "HEAD") {
    const declaredLength = Number(upstream.headers.get("content-length") || 0);

    if (!declaredLength || declaredLength <= MAX_REWRITTEN_CSS_CHARS) {
      const css = await upstream.text();

      if (css.length <= MAX_REWRITTEN_CSS_CHARS) {
        return new Response(rewriteCss(css, target.href, requestUrl.origin), {
          status: upstream.status,
          statusText: upstream.statusText,
          headers,
        });
      }

      return new Response(css, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }
  }

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === "/health") {
      return jsonResponse({ status: "ok", allowedHosts: ALLOWED_HOSTS });
    }

    if (!requestUrl.pathname.startsWith(PROXY_PREFIX)) {
      return jsonResponse({
        name: "TurboWarp Web Viewer Proxy",
        status: "ready",
        health: "/health",
        usage: `${PROXY_PREFIX}https/example.com/`,
      });
    }

    return handleProxyRequest(request, requestUrl);
  },
};
