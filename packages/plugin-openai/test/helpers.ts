import type {
  Plugin,
  ProviderAuthContext,
  ProviderAuthLoopback,
  ProviderAuthLoopbackOptions,
  ProviderAuthPrompt,
  ProviderAuthStep,
  ProviderOAuthCredential,
  ProviderOAuthHandle,
  ProviderRegistration,
} from "@alisio/sdk";

export interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** Records every request and answers through `handler`; no network is ever used. */
export function fakeFetch(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const raw = init?.body;
    const body =
      typeof raw === "string" ? raw : raw instanceof URLSearchParams ? raw.toString() : "";
    const call = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { fetch: fn as typeof fetch, calls };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const sse = (events: unknown[]) =>
  new Response(
    events
      .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

export const completed = (text = "OK") => [
  { type: "response.output_text.delta", delta: text },
  {
    type: "response.completed",
    response: {
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
];

export const registrations = (plugin: Plugin) => {
  const found: ProviderRegistration[] = [];
  plugin.setup({
    providers: {
      register(value: ProviderRegistration) {
        found.push(value);
        return () => {};
      },
    },
  } as never);
  return found;
};

export const registration = (plugin: Plugin, id: string) => {
  const value = registrations(plugin).find((r) => r.id === id);
  if (!value) throw new Error(`missing registration ${id}`);
  return value;
};

/** Deterministic random source: every call returns a new, distinct byte pattern. */
export const counterBytes = () => {
  let n = 0;
  return (size: number) => {
    n += 1;
    return Uint8Array.from({ length: size }, (_, i) => (n * 31 + i) % 256);
  };
};

export interface FakeLoopback {
  options?: ProviderAuthLoopbackOptions;
  closed: boolean;
  deliver(params: Record<string, string>): void;
  fail(error: unknown): void;
}

export interface FakeCtx {
  ctx: ProviderAuthContext;
  steps: ProviderAuthStep[];
  prompts: ProviderAuthPrompt[];
  loop: FakeLoopback;
  controller: AbortController;
  answer(value: string | undefined): void;
}

/** A host-side context double. `loopback: "none"` omits it, `"busy"` rejects like a used port. */
export function fakeCtx(
  options: { loopback?: "ok" | "none" | "busy"; previousMetadata?: Record<string, string> } = {},
): FakeCtx {
  const steps: ProviderAuthStep[] = [];
  const prompts: ProviderAuthPrompt[] = [];
  const controller = new AbortController();
  let answer: (v: string | undefined) => void = () => {};
  const loop: FakeLoopback = { closed: false, deliver() {}, fail() {} };
  const ctx: ProviderAuthContext = {
    signal: controller.signal,
    show: (step) => steps.push(step),
    prompt: (request) => {
      prompts.push(request);
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
    ...(options.previousMetadata ? { previousMetadata: options.previousMetadata } : {}),
  };
  const mode = options.loopback ?? "ok";
  if (mode !== "none")
    ctx.loopback = async (opts) => {
      loop.options = opts;
      if (mode === "busy")
        throw Object.assign(new Error("port in use"), { code: "loopback_unavailable" });
      let resolve: (p: Record<string, string>) => void = () => {};
      let reject: (e: unknown) => void = () => {};
      const waiting = new Promise<Record<string, string>>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      loop.deliver = resolve;
      loop.fail = reject;
      const handle: ProviderAuthLoopback = {
        redirectUri: `http://127.0.0.1:${opts.port}${opts.path}`,
        wait: () => waiting,
        close: () => {
          loop.closed = true;
          reject(new Error("closed"));
        },
      };
      return handle;
    };
  return { ctx, steps, prompts, loop, controller, answer: (v) => answer(v) };
}

export const authUrl = (steps: ProviderAuthStep[]) => {
  const step = steps.find((s) => s.type === "auth_url");
  if (step?.type !== "auth_url") throw new Error("no auth_url step");
  return new URL(step.url);
};

export const tick = () => new Promise((r) => setTimeout(r, 0));

/** Waits until the plugin has shown its authorize URL. */
export async function untilAuthUrl(fake: FakeCtx) {
  for (let i = 0; i < 50 && !fake.steps.some((s) => s.type === "auth_url"); i++) await tick();
  return authUrl(fake.steps);
}

export const tokenBody = (n: number, extra: Record<string, unknown> = {}) => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  id_token: `id-${n}`,
  expires_in: 3600,
  token_type: "Bearer",
  scope: "openid",
  ...extra,
});

/** A minimal host OAuth handle backed by a list of access tokens. */
export function fakeHandle(tokens: string[]) {
  const calls = { get: 0, invalidate: [] as Array<string | undefined> };
  let i = 0;
  const handle: ProviderOAuthHandle = {
    async get() {
      calls.get += 1;
      const access = tokens[Math.min(i, tokens.length - 1)] as string;
      return { type: "oauth", access } satisfies ProviderOAuthCredential;
    },
    async invalidate(reason?: "sign_in_required") {
      calls.invalidate.push(reason);
      if (reason === undefined) i += 1;
    },
  };
  return { handle, calls };
}
