export interface Env {
  ASSETS: Fetcher;
  MOSOO_AGENT_ID: string;
  MOSOO_API_BASE: string;
  MOSOO_API_TOKEN: string;
}

interface MosooFile {
  id: string;
  kind: "artifact" | "attachment";
  mimeType: string | null;
  name: string;
  size: number;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const TERMINAL_FAILURES = new Set(["cancelled", "expired", "failed"]);
const GENERATION_PROMPT = `Use the hatch-pet-mosoo skill to turn the one attached avatar image into a complete Codex-compatible animated pet.

Work autonomously and sequentially. Preserve the subject's identity while simplifying it into a compact mascot. Generate and validate all nine required animation rows. Put the only downloadable final artifact at outputs/codex-pet.zip. The zip must contain pet.json and spritesheet.webp; include deterministic QA reports and previews when available. Do not ask follow-up questions. If image generation credentials or dependencies are unavailable, fail with a concise, actionable reason.`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await routeApi(request, env, url.pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected server error.";
      return json({ error: message }, 500);
    }
  },
};

async function routeApi(request: Request, env: Env, pathname: string): Promise<Response> {
  assertConfigured(env);

  if (request.method === "POST" && pathname === "/api/pets") {
    return createPet(request, env);
  }

  const match = /^\/api\/pets\/([0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25})(?:\/(download))?$/.exec(
    pathname,
  );
  if (!match) {
    return json({ error: "Not found." }, 404);
  }

  const threadId = match[1];
  if (!threadId) {
    return json({ error: "Not found." }, 404);
  }
  if (request.method === "GET" && match[2] === "download") {
    return downloadPet(env, threadId);
  }
  if (request.method === "GET" && match[2] === undefined) {
    return getPetStatus(env, threadId);
  }

  return json({ error: "Method not allowed." }, 405);
}

async function createPet(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return json({ error: "Upload an image as multipart form data." }, 415);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    return json({ error: "The avatar must be 10 MB or smaller." }, 413);
  }

  const upload = await mosooFetch(env, `/agents/${encodeURIComponent(env.MOSOO_AGENT_ID)}/files`, {
    body: request.body,
    headers: { "content-type": contentType },
    method: "POST",
  });
  const uploadPayload = await readUpstreamJson(upload);
  if (!upload.ok) {
    return upstreamError(upload.status, uploadPayload, "Avatar upload failed.");
  }

  const fileId = readNestedString(uploadPayload, "file", "id");
  if (!fileId) {
    return json({ error: "Mosoo returned an invalid upload response." }, 502);
  }

  const created = await mosooFetch(
    env,
    `/agents/${encodeURIComponent(env.MOSOO_AGENT_ID)}/threads`,
    {
      body: JSON.stringify({
        client_external_ref: `codex-pet-${crypto.randomUUID()}`,
        input: {
          content: [{ text: GENERATION_PROMPT, type: "text" }],
          type: "user.message",
        },
        resources: [{ file_id: fileId, type: "file" }],
      }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": `codex-pet-${crypto.randomUUID()}`,
      },
      method: "POST",
    },
  );
  const createPayload = await readUpstreamJson(created);
  if (!created.ok) {
    return upstreamError(created.status, createPayload, "Pet generation could not start.");
  }

  const threadId = readNestedString(createPayload, "thread", "id");
  const runId = readNestedString(createPayload, "run", "id");
  const status = readNestedString(createPayload, "run", "status");
  if (!threadId || !runId || !status) {
    return json({ error: "Mosoo returned an invalid thread response." }, 502);
  }

  return json({ runId, status, threadId }, 202);
}

async function getPetStatus(env: Env, threadId: string): Promise<Response> {
  const response = await mosooFetch(env, `/threads/${encodeURIComponent(threadId)}`);
  const payload = await readUpstreamJson(response);
  if (!response.ok) {
    return upstreamError(response.status, payload, "Generation status is unavailable.");
  }

  const status = readNestedString(payload, "run", "status");
  if (!status) {
    return json({ error: "Mosoo returned an invalid run status." }, 502);
  }

  if (status === "completed") {
    const artifact = await findPetArtifact(env, threadId);
    return json({
      downloadUrl: artifact ? `/api/pets/${threadId}/download` : null,
      fileName: artifact?.name ?? null,
      status,
    });
  }

  const upstreamErrorValue = readNestedValue(payload, "run", "error");
  return json({
    error: TERMINAL_FAILURES.has(status) ? readErrorMessage(upstreamErrorValue) : null,
    status,
  });
}

async function downloadPet(env: Env, threadId: string): Promise<Response> {
  const artifact = await findPetArtifact(env, threadId);
  if (!artifact) {
    return json({ error: "The pet package is not ready yet." }, 404);
  }

  const response = await mosooFetch(
    env,
    `/files/${encodeURIComponent(artifact.id)}/content?disposition=attachment`,
  );
  if (!response.ok) {
    return upstreamError(response.status, await readUpstreamJson(response), "Pet download failed.");
  }

  const headers = new Headers({
    "cache-control": "no-store",
    "content-disposition":
      response.headers.get("content-disposition") ??
      `attachment; filename="${artifact.name.replaceAll('"', "")}"`,
    "content-type": response.headers.get("content-type") ?? "application/zip",
  });
  for (const name of ["content-length", "etag"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(response.body, { headers, status: 200 });
}

async function findPetArtifact(env: Env, threadId: string): Promise<MosooFile | null> {
  const response = await mosooFetch(env, `/threads/${encodeURIComponent(threadId)}/files`);
  const payload = await readUpstreamJson(response);
  if (!response.ok) return null;
  const files = isRecord(payload) && Array.isArray(payload["files"]) ? payload["files"] : [];
  const artifacts = files.filter(isMosooFile).filter((file) => file.kind === "artifact");
  return (
    artifacts.find((file) => file.name === "codex-pet.zip") ??
    artifacts.find((file) => file.name.toLowerCase().endsWith(".zip")) ??
    null
  );
}

function mosooFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${env.MOSOO_API_TOKEN}`);
  return fetch(`${env.MOSOO_API_BASE.replace(/\/$/, "")}${path}`, { ...init, headers });
}

function assertConfigured(env: Env): void {
  if (!env.MOSOO_API_BASE || !env.MOSOO_AGENT_ID || !env.MOSOO_API_TOKEN) {
    throw new Error("The Mosoo backend is not configured.");
  }
}

async function readUpstreamJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function upstreamError(status: number, payload: unknown, fallback: string): Response {
  const safeStatus = status >= 400 && status < 600 ? status : 502;
  return json({ error: readErrorMessage(payload) ?? fallback }, safeStatus);
}

function readErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value["message"] === "string") return value["message"];
  if (typeof value["error"] === "string") return value["error"];
  if (isRecord(value["error"]) && typeof value["error"]["message"] === "string") {
    return value["error"]["message"];
  }
  return null;
}

function readNestedString(value: unknown, parent: string, child: string): string | null {
  const nested = readNestedValue(value, parent, child);
  return typeof nested === "string" ? nested : null;
}

function readNestedValue(value: unknown, parent: string, child: string): unknown {
  if (!isRecord(value) || !isRecord(value[parent])) return null;
  return value[parent][child];
}

function isMosooFile(value: unknown): value is MosooFile {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    (value["kind"] === "artifact" || value["kind"] === "attachment") &&
    (typeof value["mimeType"] === "string" || value["mimeType"] === null) &&
    typeof value["name"] === "string" &&
    typeof value["size"] === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    headers: { "cache-control": "no-store" },
    status,
  });
}
