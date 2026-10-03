#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
// Scriptable stand-in for `laya-serve`. Test-only; never shipped. Behavior comes from argv:
//   --mode=fast | slow-start:<ms> | never-ready | exit-at-boot | hang-sigterm | crash-after:<ms>
//        | port-collision | warmup-fail | die-on-request | wrong-host
//   --marker=<file>   (port-collision: first start fails when the marker is absent)
import { createServer } from "node:http";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  }),
);
const [mode, modeArg] = (args.mode ?? "fast").split(":");
const host = process.env.LAYA_HOST;
const port = Number(process.env.LAYA_PORT);
const token = process.env.LAYA_API_KEY;

if (host !== "127.0.0.1" && mode !== "wrong-host") {
  console.error("fake-laya: refusing to bind a non-loopback host");
  process.exit(3);
}
if (mode === "exit-at-boot") {
  console.error("fake-laya: fatal boot error");
  process.exit(2);
}
if (mode === "port-collision" && args.marker && !existsSync(args.marker)) {
  writeFileSync(args.marker, "1");
  console.error(
    "OSError: [Errno 98] error while attempting to bind on address: address already in use",
  );
  process.exit(1);
}
if (mode === "hang-sigterm") process.on("SIGTERM", () => {});
if (mode === "never-ready") setInterval(() => {}, 1000);

function authorized(req) {
  return req.headers.authorization === `Bearer ${token}`;
}

function answer(question) {
  if (question.type === "choice") {
    const labels = Object.keys(question.criteria);
    const probabilities = Object.fromEntries(
      labels.map((l, i) => [l, i === 0 ? 0.8 : 0.2 / Math.max(1, labels.length - 1)]),
    );
    return { choice: labels[0], confidence: 0.5, answer_confidence: 0.8, probabilities };
  }
  if (question.type === "noul") return { noul: 0.9, confidence: 0.9, answer_confidence: 0.9 };
  const n = question.criteria.length;
  const probabilities = Object.fromEntries(
    question.criteria.map((_, i) => [String(i), i === n - 1 ? 0.7 : 0.3 / Math.max(1, n - 1)]),
  );
  return {
    score: n - 1.3,
    legend: question.criteria,
    confidence: 0.4,
    answer_confidence: 0.7,
    probabilities,
  };
}

const server = createServer((req, res) => {
  if (!authorized(req)) {
    res.statusCode = 401;
    return res.end("{}");
  }
  if (req.method === "GET" && req.url === "/health") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ status: "ok" }));
  }
  if (req.method === "GET" && req.url === "/__env") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ keys: Object.keys(process.env).sort(), env: process.env }));
  }
  if (req.method === "POST" && req.url === "/v1/systemone") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (mode === "die-on-request") process.exit(9);
      if (mode === "warmup-fail") {
        res.statusCode = 500;
        return res.end("{}");
      }
      const parsed = JSON.parse(body);
      const answers = Object.fromEntries(
        Object.entries(parsed.questions).map(([id, q]) => [id, answer(q)]),
      );
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ answers, usage: { input_tokens: 5, output_tokens: 2 } }));
    });
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});

const listen = () => server.listen(port, host, () => {});
if (mode === "slow-start") setTimeout(listen, Number(modeArg ?? 300));
else if (mode !== "never-ready") listen();
if (mode === "crash-after") setTimeout(() => process.exit(1), Number(modeArg ?? 200));
