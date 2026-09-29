import type { Source } from "./validation.js";
export type Clock = {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};
export const clock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new Error("source unavailable"));
        },
        { once: true },
      );
    }),
};
let crossrefBusy = false,
  arxivNext = 0;
const origins = {
  openalex: "https://api.openalex.org",
  crossref: "https://api.crossref.org",
  arxiv: "https://export.arxiv.org",
} as const;
export async function request(
  source: Source,
  path: string,
  fetcher: typeof fetch,
  outer: AbortSignal,
  c: Clock = clock,
): Promise<string> {
  const release = source === "crossref" ? await lock(outer) : undefined;
  try {
    if (source === "arxiv") {
      const wait = Math.max(0, arxivNext - c.now());
      if (wait) await c.sleep(wait, outer);
      arxivNext = c.now() + 3000;
    }
    const signal = AbortSignal.any([outer, AbortSignal.timeout(8000)]);
    let r: Response;
    try {
      r = await fetcher(origins[source] + path, {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: source === "arxiv" ? "application/atom+xml" : "application/json",
          "user-agent": "alisio-literature-research/0.1",
        },
        signal,
      });
    } catch {
      throw new Error("source unavailable");
    }
    if (r.status >= 300 && r.status < 400) throw new Error("source returned redirect");
    if (r.status === 429) throw new Error("source rate limited");
    if (!r.ok) throw new Error("source unavailable");
    if (r.redirected) throw new Error("source returned redirect");
    return bounded(r);
  } finally {
    release?.();
  }
}
async function lock(signal: AbortSignal) {
  if (crossrefBusy) throw new Error("source rate limited");
  crossrefBusy = true;
  signal.throwIfAborted();
  return () => {
    crossrefBusy = false;
  };
}
async function bounded(r: Response) {
  const reader = r.body?.getReader();
  if (!reader) return "";
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const n = await reader.read();
    if (n.done) break;
    bytes += n.value.byteLength;
    if (bytes > 512 * 1024) throw new Error("response exceeded limit");
    chunks.push(n.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
export function resetRateLimits() {
  crossrefBusy = false;
  arxivNext = 0;
}
