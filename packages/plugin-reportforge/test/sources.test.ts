import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkUrlShape,
  htmlToPlain,
  importPublicUrl,
  isPrivateAddress,
  sourceText,
} from "../src/sources.js";

const PAGE = `<html><head><style>.x{}</style><script>alert(1)</script></head><body><h1>Annual report</h1><p>${"Revenue grew in every region during the year. ".repeat(5)}</p></body></html>`;

let server: Server;
let port = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    } else if (path.startsWith("/redirect")) {
      res.writeHead(302, { location: decodeURIComponent(path.slice("/redirect?to=".length)) });
      res.end();
    } else if (path === "/big-declared") {
      res.writeHead(200, {
        "content-type": "text/html",
        "content-length": String(3 * 1024 * 1024),
      });
      res.end();
    } else if (path === "/big-chunked") {
      res.writeHead(200, { "content-type": "text/html" });
      const chunk = "x".repeat(64 * 1024);
      for (let i = 0; i < 40; i++) res.write(chunk);
      res.end();
    } else if (path === "/loop") {
      res.writeHead(301, { location: "/loop" });
      res.end();
    } else if (path.startsWith("/hop")) {
      res.writeHead(302, { location: `${path}x` });
      res.end();
    } else if (path === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    } else if (path === "/hang") {
      // never answers
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

/**
 * Sends the "HTTPS" request to the local plain-HTTP server and records the address the pinned
 * lookup hands to the socket, so the tests can prove which IP the connection would use.
 */
function harness(dns: Record<string, string[]>) {
  const lookups: string[] = [];
  const pinned: string[] = [];
  const lookup: Lookup = async (host) => {
    lookups.push(host);
    return (dns[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  const request = (
    url: URL,
    options: RequestOptions,
    onResponse: (res: IncomingMessage) => void,
  ) => {
    (options.lookup as (h: string, o: object, cb: (e: unknown, a: string) => void) => void)(
      url.hostname,
      {},
      (_error, address) => pinned.push(address),
    );
    return httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: url.pathname + url.search,
        method: "GET",
        headers: options.headers,
        timeout: options.timeout,
      },
      onResponse,
    );
  };
  return { lookups, pinned, options: { lookup, request, timeoutMs: 500 } };
}

const PUBLIC = "93.184.216.34";
const PUBLIC6 = "2606:2800:220:1:248:1893:25c8:1946";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "192.0.2.10",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a00:1",
    "2002:c0a8:0101::1",
    "::127.0.0.1",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    PUBLIC,
    "8.8.8.8",
    "1.1.1.1",
    PUBLIC6,
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "172.32.0.1",
  ])("allows public %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe("checkUrlShape", () => {
  it.each([
    "http://example.org/",
    "https://example.org:8443/",
    "https://user:pw@example.org/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://localhost/",
    "https://printer.local/",
    "ftp://example.org/",
  ])("rejects %s", (raw) => {
    expect(() => checkUrlShape(new URL(raw))).toThrow("unsafe_url");
  });

  it("accepts a plain public HTTPS URL", () => {
    expect(() => checkUrlShape(new URL("https://example.org/report?x=1"))).not.toThrow();
  });
});

describe("importPublicUrl", () => {
  it("imports a public HTML page as plain text, connecting to the validated address", async () => {
    const h = harness({ "example.org": [PUBLIC6, PUBLIC] });
    const source = await importPublicUrl("https://example.org/page", h.options);
    expect(source).toMatchObject({
      kind: "url",
      mime: "text/html",
      url: "https://example.org/page",
    });
    expect(source.text).toContain("Annual report");
    expect(source.text).not.toContain("alert(1)");
    expect(h.pinned).toEqual([PUBLIC]);
  });

  it("refuses non-HTTPS before any DNS lookup", async () => {
    const h = harness({ "example.org": [PUBLIC] });
    await expect(importPublicUrl("http://example.org/page", h.options)).rejects.toThrow(
      "unsafe_url",
    );
    expect(h.lookups).toEqual([]);
  });

  it.each([
    ["an IPv4 private address", ["10.0.0.5"]],
    ["loopback", ["127.0.0.1"]],
    ["cloud metadata", ["169.254.169.254"]],
    ["an IPv6 loopback", ["::1"]],
    ["an IPv6 unique-local address", ["fd00::1"]],
    ["an IPv4-mapped private address", ["::ffff:192.168.0.1"]],
    ["a mix of public and private addresses", [PUBLIC, "10.0.0.5"]],
    ["no address", []],
  ])("blocks a host that resolves to %s, without connecting", async (_label, addresses) => {
    const h = harness({ "evil.example": addresses });
    await expect(importPublicUrl("https://evil.example/page", h.options)).rejects.toThrow(
      "private_address_blocked",
    );
    expect(h.pinned).toEqual([]);
  });

  it("re-validates a redirect and blocks one to a private host", async () => {
    const h = harness({ "example.org": [PUBLIC], "intranet.example": ["192.168.1.10"] });
    const to = encodeURIComponent("https://intranet.example/page");
    await expect(
      importPublicUrl(`https://example.org/redirect?to=${to}`, h.options),
    ).rejects.toThrow("private_address_blocked");
    expect(h.lookups).toEqual(["example.org", "intranet.example"]);
    expect(h.pinned).toEqual([PUBLIC]);
  });

  it("blocks a redirect to plain HTTP or an IP literal", async () => {
    const h = harness({ "example.org": [PUBLIC] });
    for (const target of ["http://example.org/page", "https://169.254.169.254/latest"]) {
      await expect(
        importPublicUrl(`https://example.org/redirect?to=${encodeURIComponent(target)}`, h.options),
      ).rejects.toThrow("unsafe_url");
    }
  });

  it("follows a public redirect", async () => {
    const h = harness({ "example.org": [PUBLIC], "www.example.org": ["93.184.216.35"] });
    const to = encodeURIComponent("https://www.example.org/page");
    const source = await importPublicUrl(`https://example.org/redirect?to=${to}`, h.options);
    expect(source.url).toBe("https://www.example.org/page");
    expect(h.pinned).toEqual([PUBLIC, "93.184.216.35"]);
  });

  it("resists DNS rebinding: one lookup per hop, the socket uses the validated IP", async () => {
    let calls = 0;
    const h = harness({});
    const rebinding = {
      ...h.options,
      lookup: async () => {
        calls++;
        // First answer is public; any later lookup would point at the loopback interface.
        return [{ address: calls === 1 ? PUBLIC : "127.0.0.1", family: 4 }];
      },
    };
    await importPublicUrl("https://rebind.example/page", rebinding);
    expect(calls).toBe(1);
    expect(h.pinned).toEqual([PUBLIC]);
  });

  it("rejects an oversized page by its declared length and while streaming", async () => {
    const h = harness({ "example.org": [PUBLIC] });
    await expect(importPublicUrl("https://example.org/big-declared", h.options)).rejects.toThrow(
      "url_too_large",
    );
    await expect(importPublicUrl("https://example.org/big-chunked", h.options)).rejects.toThrow(
      "url_too_large",
    );
  });

  it("rejects non-HTML content, HTTP errors and timeouts", async () => {
    const h = harness({ "example.org": [PUBLIC] });
    await expect(importPublicUrl("https://example.org/json", h.options)).rejects.toThrow(
      "url_not_html",
    );
    await expect(importPublicUrl("https://example.org/missing", h.options)).rejects.toThrow(
      "remote_http_404",
    );
    await expect(importPublicUrl("https://example.org/hang", h.options)).rejects.toThrow(
      "url_timeout",
    );
  });

  it("stops redirect loops and long redirect chains", async () => {
    const h = harness({ "example.org": [PUBLIC] });
    await expect(importPublicUrl("https://example.org/loop", h.options)).rejects.toThrow(
      "redirect_loop",
    );
    await expect(importPublicUrl("https://example.org/hop", h.options)).rejects.toThrow(
      "too_many_redirects",
    );
  });
});

describe("local text sources", () => {
  it("accepts text types and converts HTML to plain text", () => {
    const html = sourceText("page.html", "text/html", Buffer.from(PAGE).toString("base64"));
    expect(html.text).toContain("Annual report");
    expect(html.text).not.toContain("<script>");
    expect(sourceText("d.csv", "text/csv", Buffer.from("a,b\n1,2").toString("base64")).kind).toBe(
      "csv",
    );
  });

  it("rejects other types and oversized files", () => {
    expect(() => sourceText("x.exe", "application/octet-stream", "AAAA")).toThrow(
      "unsupported_file_type",
    );
    expect(() => sourceText("x.txt", "text/plain", "A".repeat(12 * 1024 * 1024))).toThrow(
      "source_too_large",
    );
  });

  it("strips markup and decodes entities once", () => {
    expect(htmlToPlain("<p>a &amp;lt; b</p>")).toBe("a &lt; b");
  });
});
