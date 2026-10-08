import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CardEndpoint,
  createCardRequestHandler,
  DEFAULT_CARD_CACHE_CONTROL,
} from "../src/integrations/http-renderer.js";
import { renderCard } from "../src/renderer.js";
import type { RenderedImage } from "../src/renderers/index.js";

const STUB: RenderedImage = {
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
  mimeType: "image/png",
  width: 8,
  height: 4,
  scale: 1,
};

const MINIMAL_SOCIAL = {
  family: "social" as const,
  templateId: "illustrated-greeting",
  content: { title: "Endpoint" },
};

const endpoint: CardEndpoint = {
  async handle({ url }) {
    switch (url.pathname) {
      case "/card.png":
        return { status: "ok", rendered: STUB };
      case "/custom.png":
        return { status: "ok", rendered: STUB, cacheControl: "private, max-age=300" };
      case "/real.png":
        return { status: "ok", rendered: await renderCard(MINIMAL_SOCIAL, { scale: 0.05 }) };
      case "/forbidden":
        return { status: "forbidden" };
      case "/missing":
        return { status: "not-found" };
      case "/bad":
        return { status: "bad-request", message: "id is required" };
      case "/boom.png":
        throw new Error("render exploded");
      default:
        return { status: "not-found" };
    }
  },
};

interface TestResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

let server: Server;
let base: string;

function request(
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${base}${path}`,
      { method: options.method ?? "GET", headers: options.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function expectedEtag(bytes: Uint8Array): string {
  return `W/"${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}"`;
}

beforeAll(async () => {
  server = createServer(createCardRequestHandler(endpoint));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

describe("card HTTP handler", () => {
  it("answers 200 with content type, ETag, private cache and body", async () => {
    const response = await request("/card.png");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-length"]).toBe(String(STUB.bytes.byteLength));
    expect(response.headers.etag).toBe(expectedEtag(STUB.bytes));
    expect(response.headers["cache-control"]).toBe(DEFAULT_CARD_CACHE_CONTROL);
    expect(response.headers["cache-control"]).not.toContain("public");
    expect(response.body.equals(Buffer.from(STUB.bytes))).toBe(true);
  });

  it("honours an endpoint-provided cache policy", async () => {
    const response = await request("/custom.png");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, max-age=300");
  });

  it("answers 304 when If-None-Match matches the ETag", async () => {
    const first = await request("/card.png");
    const etag = first.headers.etag as string;
    const second = await request("/card.png", { headers: { "if-none-match": etag } });
    expect(second.status).toBe(304);
    expect(second.headers.etag).toBe(etag);
    expect(second.body.byteLength).toBe(0);
  });

  it("answers HEAD with headers only", async () => {
    const response = await request("/card.png", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-length"]).toBe(String(STUB.bytes.byteLength));
    expect(response.headers.etag).toBe(expectedEtag(STUB.bytes));
    expect(response.body.byteLength).toBe(0);
  });

  it("serves a real renderCard output", async () => {
    const response = await request("/real.png");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    expect(response.headers.etag).toBe(expectedEtag(new Uint8Array(response.body)));
  });

  it("maps forbidden, not-found and bad-request", async () => {
    const forbidden = await request("/forbidden");
    expect(forbidden.status).toBe(403);

    const missing = await request("/missing");
    expect(missing.status).toBe(404);

    const bad = await request("/bad");
    expect(bad.status).toBe(400);
    expect(bad.headers["content-type"]).toContain("text/plain");
    expect(bad.body.toString("utf8")).toBe("id is required");
  });

  it("rejects methods other than GET and HEAD with 405", async () => {
    const response = await request("/card.png", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET, HEAD");
  });

  it("falls back to 500 when the endpoint fails", async () => {
    const response = await request("/boom.png");
    expect(response.status).toBe(500);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body.toString("utf8")).toBe("Internal Server Error");
  });
});
