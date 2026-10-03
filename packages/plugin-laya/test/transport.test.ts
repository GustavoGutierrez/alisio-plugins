import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LayaProtocolError, LayaTimeoutError, LayaUnavailableError } from "../src/errors.js";
import { createHttpTransport } from "../src/transport/http.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let handler: Handler;
let seen: Array<{ method?: string; url?: string; auth?: string; body: string }>;
let port: number;

beforeEach(async () => {
  seen = [];
  handler = (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answers: {} }));
  };
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const wire = { state: "s", questions: {} };
const ctx = () => ({ signal: AbortSignal.timeout(2000) });
const make = (extra = {}) => createHttpTransport({ port, token: "tok-123", ...extra });

describe("createHttpTransport", () => {
  it("sends the bearer token and the JSON body to loopback", async () => {
    const result = await make().infer(wire, ctx());
    expect(result).toEqual({ answers: {} });
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "/v1/systemone",
      auth: "Bearer tok-123",
    });
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual(wire);
  });

  it("refuses a non-loopback host", () => {
    expect(() => createHttpTransport({ port, token: "t", host: "0.0.0.0" })).toThrow();
    expect(() => createHttpTransport({ port, token: "t", host: "example.com" })).toThrow();
  });

  it("does not follow redirects", async () => {
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "http://127.0.0.1:1/elsewhere");
      res.end();
    };
    await expect(make().infer(wire, ctx())).rejects.toBeInstanceOf(LayaProtocolError);
    expect(seen).toHaveLength(1);
  });

  it.each([
    [401, LayaUnavailableError],
    [403, LayaUnavailableError],
    [500, LayaUnavailableError],
    [502, LayaUnavailableError],
    [503, LayaUnavailableError],
    [413, LayaProtocolError],
    [422, LayaProtocolError],
  ])("maps HTTP %i to the right typed error", async (status, errorClass) => {
    handler = (_req, res) => {
      res.statusCode = status;
      if (status === 503) res.setHeader("retry-after", "2");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ detail: "server text that must not leak" }));
    };
    const promise = make().infer(wire, ctx());
    await expect(promise).rejects.toBeInstanceOf(errorClass);
    await promise.catch((error: Error) => {
      expect(error.message).not.toContain("server text");
    });
  });

  it("maps 503 to overloaded", async () => {
    handler = (_req, res) => {
      res.statusCode = 503;
      res.end("{}");
    };
    await expect(make().infer(wire, ctx())).rejects.toMatchObject({ code: "overloaded" });
  });

  it("rejects non-JSON content types, invalid JSON and empty bodies", async () => {
    handler = (_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<html>");
    };
    await expect(make().infer(wire, ctx())).rejects.toBeInstanceOf(LayaProtocolError);
    handler = (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end("{not json");
    };
    await expect(make().infer(wire, ctx())).rejects.toBeInstanceOf(LayaProtocolError);
    handler = (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end("");
    };
    await expect(make().infer(wire, ctx())).rejects.toBeInstanceOf(LayaProtocolError);
  });

  it("rejects an oversized body (declared and streamed)", async () => {
    handler = (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ pad: "x".repeat(5000) }));
    };
    await expect(make({ maxBodyBytes: 1000 }).infer(wire, ctx())).rejects.toBeInstanceOf(
      LayaProtocolError,
    );
    handler = (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.write('{"pad":"');
      res.write("x".repeat(5000));
      res.end('"}');
    };
    await expect(make({ maxBodyBytes: 1000 }).infer(wire, ctx())).rejects.toBeInstanceOf(
      LayaProtocolError,
    );
  });

  it("times out when the caller signal aborts during a slow response", async () => {
    handler = () => {
      /* never answers */
    };
    await expect(make().infer(wire, { signal: AbortSignal.timeout(80) })).rejects.toBeInstanceOf(
      LayaTimeoutError,
    );
  });

  it("times out on a slow body after headers", async () => {
    handler = (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.write('{"answers":');
    };
    await expect(make().infer(wire, { signal: AbortSignal.timeout(120) })).rejects.toBeInstanceOf(
      LayaTimeoutError,
    );
  });

  it("maps a caller abort to a timeout error", async () => {
    handler = () => {};
    const controller = new AbortController();
    const promise = make().infer(wire, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(promise).rejects.toBeInstanceOf(LayaTimeoutError);
  });

  it("flags connection failures so the caller can re-probe", async () => {
    handler = (req) => {
      req.socket.destroy();
    };
    await expect(make().infer(wire, ctx())).rejects.toMatchObject({
      code: "failed",
      connection: true,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(make().infer(wire, ctx())).rejects.toMatchObject({ connection: true });
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  describe("probe", () => {
    it("reports up on 200 with the bearer, down on refusal, auth on 401", async () => {
      handler = (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));
      };
      expect(await make().probe()).toBe("up");
      expect(seen[0]).toMatchObject({ method: "GET", url: "/health", auth: "Bearer tok-123" });
      handler = (_req, res) => {
        res.statusCode = 401;
        res.end();
      };
      expect(await make().probe()).toBe("auth");
      handler = (_req, res) => {
        res.statusCode = 500;
        res.end();
      };
      expect(await make().probe()).toBe("down");
      expect(await createHttpTransport({ port: 1, token: "t" }).probe()).toBe("down");
    });

    it("honors an abort signal", async () => {
      handler = () => {};
      await expect(make().probe(AbortSignal.timeout(60))).resolves.toBe("down");
    });
  });
});
