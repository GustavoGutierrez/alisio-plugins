// node scripts/verify-host-integration.mjs /path/to/built/alisio

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const hostRoot = resolve(process.argv[2]);
const { startServer } = await import(
  pathToFileURL(join(hostRoot, "packages/server/dist/index.js"))
);
const root = await mkdtemp(join(tmpdir(), "scribe-host-"));
process.env.ALISIO_CONFIG_HOME = join(root, "config");
process.env.ALISIO_STATE_HOME = join(root, "state");
process.env.HERDR_ENV = "0";
const workspace = join(root, "workspace");
await mkdir(workspace);
const provider = {
  id: "fixture",
  model: "fixture-model",
  async *stream() {
    const text = JSON.stringify({
      tex: "\\documentclass{article}\n\\begin{document}Integrated test\\end{document}",
      bib: "",
      summary: "Integrated proposal",
    });
    yield { type: "text_delta", delta: text };
    yield { type: "completed", message: { role: "assistant", text, calls: [] } };
  },
};
const server = await startServer({
  port: 0,
  defaultWorkspace: workspace,
  app: {
    db: join(root, "state/sessions.sqlite"),
    noHerdr: true,
    provider,
    trustProject: true,
    allowWrite: true,
    allowProcess: true,
    plugin: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  },
});
try {
  const origin = `http://127.0.0.1:${server.port}`;
  const login = await fetch(`${origin}/?token=${encodeURIComponent(server.token)}`, {
    redirect: "manual",
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  async function request(path, body) {
    const res = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        Cookie: cookie,
        ...(body ? { "Content-Type": "application/json", Origin: origin } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.ok(res.ok, await res.clone().text());
    return res.json();
  }
  const session = await request("/api/sessions", { workspace });
  const sid = session.id ?? session.session?.id;
  assert.ok(sid, JSON.stringify(session));
  const base = `/api/sessions/${sid}/apps/alisio.scribe/studio`;
  const frame = await fetch(`${origin}${base}/frame`, { headers: { Cookie: cookie } });
  assert.equal(frame.status, 200);
  const html = await frame.text();
  assert.ok(html.includes("alisio.app.connect"));
  assert.ok(!html.includes("__ALISIO_NONCE__"));
  async function action(name, input = {}) {
    const res = await request(`${base}/actions/${name}`, {
      input,
      idempotencyKey: crypto.randomUUID(),
    });
    assert.ok(!res.result.error, JSON.stringify(res));
    return res.result.value;
  }
  const doc = await action("documents.create", {
    title: "Host integrated",
    language: "es",
    brief: "Write an introductory physics article.",
  });
  const job = await action("draft.generate", { documentId: doc.id });
  let status;
  for (let i = 0; i < 100; i++) {
    status = (await action("jobs.list")).find((j) => j.id === job.id);
    if (status.status !== "running") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(status.status, "succeeded", JSON.stringify(status));
  const drafted = await action("documents.get", { documentId: doc.id });
  assert.equal(drafted.proposals.length, 1);
  const applied = await action("proposal.apply", {
    documentId: doc.id,
    proposalId: drafted.proposals[0].id,
  });
  assert.ok(applied.revisions.at(-1).tex.includes("Integrated test"));
  const build = await action("pdf.compile", { documentId: doc.id });
  for (let i = 0; i < 200; i++) {
    status = (await action("jobs.list")).find((j) => j.id === build.id);
    if (status.status !== "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(status.status, "succeeded", JSON.stringify(status));
  const pdf = await action("pdf.get", { documentId: doc.id });
  assert.equal(Buffer.from(pdf.base64, "base64").subarray(0, 5).toString(), "%PDF-");
  console.log(
    "PASS: REAL PDF + patched host + actual plugin, authenticated embedded HTML, document creation, child agent fixture, proposal and apply.",
  );
} finally {
  await server.close();
  await rm(root, { recursive: true, force: true });
}
