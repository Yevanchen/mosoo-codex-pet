import { afterEach, describe, expect, test } from "bun:test";

import worker from "../src/index";

const threadId = "01KXFSWKYZN2YYS3CPKKAJHTF3";
const runId = "01KXFSWKYZN2YYS3CPKKAJHTF4";
const fileId = "01KXFSWKYZN2YYS3CPKKAJHTF5";
const originalFetch = globalThis.fetch;
const env = {
  ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } as unknown as Fetcher,
  MOSOO_AGENT_ID: "01KXFSWKYZN2YYS3CPKKAJHTF2",
  MOSOO_API_BASE: "http://mosoo.test/api/v1",
  MOSOO_API_TOKEN: "test-token",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function setFetch(mockFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = Object.assign(mockFetch, { preconnect() {} }) as typeof fetch;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("Codex pet Worker", () => {
  test("uploads the avatar and creates a thread with a file resource", async () => {
    const calls: Array<{ init: RequestInit | undefined; url: string }> = [];
    setFetch((input, init) => {
      const url = requestUrl(input);
      calls.push({ init, url });
      if (url.endsWith(`/agents/${env.MOSOO_AGENT_ID}/files`)) {
        return Promise.resolve(Response.json({ file: { id: fileId } }, { status: 201 }));
      }
      return Promise.resolve(
        Response.json(
          { run: { id: runId, status: "queued" }, thread: { id: threadId } },
          { status: 201 },
        ),
      );
    });

    const body = new FormData();
    body.set("file", new File(["avatar"], "avatar.png", { type: "image/png" }));
    const response = await worker.fetch(
      new Request("https://pet.test/api/pets", { body, method: "POST" }),
      env,
    );

    expect(response.status).toBe(202);
    const payload: unknown = await response.json();
    expect(payload).toEqual({ runId, status: "queued", threadId });
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer test-token");
    const createRequestBody = calls[1]?.init?.body;
    if (typeof createRequestBody !== "string") throw new Error("Expected a JSON request body.");
    const createBody: unknown = JSON.parse(createRequestBody);
    expect(createBody).toMatchObject({ resources: [{ file_id: fileId, type: "file" }] });
  });

  test("returns a same-origin download URL when the zip artifact is ready", async () => {
    setFetch((input) => {
      const url = requestUrl(input);
      if (url.endsWith(`/threads/${threadId}`)) {
        return Promise.resolve(Response.json({ run: { status: "completed" } }));
      }
      return Promise.resolve(
        Response.json({
          files: [
            {
              id: fileId,
              kind: "artifact",
              mimeType: "application/zip",
              name: "codex-pet.zip",
              size: 12,
            },
          ],
        }),
      );
    });

    const response = await worker.fetch(new Request(`https://pet.test/api/pets/${threadId}`), env);

    const payload: unknown = await response.json();
    expect(payload).toEqual({
      downloadUrl: `/api/pets/${threadId}/download`,
      fileName: "codex-pet.zip",
      status: "completed",
    });
  });

  test("streams the selected artifact without exposing the Mosoo token", async () => {
    setFetch((input) => {
      const url = requestUrl(input);
      if (url.endsWith(`/threads/${threadId}/files`)) {
        return Promise.resolve(
          Response.json({
            files: [
              {
                id: fileId,
                kind: "artifact",
                mimeType: "application/zip",
                name: "codex-pet.zip",
                size: 3,
              },
            ],
          }),
        );
      }
      return Promise.resolve(
        new Response("zip", { headers: { "content-type": "application/zip" } }),
      );
    });

    const response = await worker.fetch(
      new Request(`https://pet.test/api/pets/${threadId}/download`),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("authorization")).toBeFalse();
    expect(await response.text()).toBe("zip");
  });
});
