export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(req.headers.get("Origin")),
      });
    }

    // Target URL via query or base64 path
    let target;
    if (url.pathname.startsWith("/proxy")) {
      const qs = url.searchParams.get("url");
      if (qs) {
        target = qs;
      } else {
        const encoded = url.pathname.replace("/proxy/", "");
        try {
          target = decodeURIComponent(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")));
        } catch {
          return new Response("Invalid encoded URL", { status: 400 });
        }
      }
    }

    if (!target) {
      return new Response("Missing target URL", { status: 400 });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response("Invalid target URL", { status: 400 });
    }

    // WebSocket support
    if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const upstream = await fetch(targetUrl.toString(), req);
      const ws = upstream.webSocket;
      if (!ws) return new Response("WS upgrade failed", { status: 502 });

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      ws.accept(); server.accept();

      server.onmessage = msg => ws.send(msg.data);
      ws.onmessage = msg => server.send(msg.data);
      server.onclose = evt => ws.close(evt.code, evt.reason);
      ws.onclose = evt => server.close(evt.code, evt.reason);

      return new Response(null, { status: 101, webSocket: client });
    }

    // Proxy HTTP request
    const res = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: cleanHeaders(req.headers),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
    });

    const headers = new Headers(res.headers);
    if (headers.get("location")) {
      try {
        const loc = new URL(headers.get("location"), targetUrl);
        const encoded = btoa(unescape(encodeURIComponent(loc.toString())))
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        headers.set("location", `/proxy/${encoded}`);
      } catch {}
    }

    return new Response(res.body, {
      status: res.status,
      headers: {
        ...Object.fromEntries(headers),
        ...corsHeaders(req.headers.get("Origin")),
      },
    });
  },
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
    "Timing-Allow-Origin": origin || "*",
  };
}

function cleanHeaders(headers) {
  const out = new Headers();
  for (const [k, v] of headers.entries()) {
    if (!["host", "origin", "referer", "cf-connecting-ip", "x-forwarded-for"].includes(k.toLowerCase())) {
      out.set(k, v);
    }
  }
  return out;
}
