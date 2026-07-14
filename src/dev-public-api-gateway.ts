const upstream = "http://127.0.0.1:8787";
const port = 8790;

Bun.serve({
  fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/v1/")) {
      return Response.json(
        { error: "Only the Mosoo Public Thread API is exposed." },
        { status: 404 },
      );
    }

    const target = new URL(url.pathname + url.search, upstream);
    return fetch(target, {
      body: request.body,
      headers: request.headers,
      method: request.method,
      redirect: "manual",
    });
  },
  hostname: "127.0.0.1",
  port,
});

console.log(`Public-only Mosoo gateway listening on http://127.0.0.1:${port}`);
