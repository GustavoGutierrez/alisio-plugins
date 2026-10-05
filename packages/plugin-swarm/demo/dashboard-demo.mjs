#!/usr/bin/env node
/**
 * Serves the swarm dashboard with synthetic data so the UI can be inspected (screenshots, theme and
 * layout checks) without a running Alisio host. Build first: `pnpm build`.
 *
 *   node demo/dashboard-demo.mjs [--port-file <file>]
 *
 * It prints the dashboard link (which carries a throwaway token), then serves until interrupted.
 * Gate actions (approve, reject, answer, retry, delete) are accepted and ignored. Everything here is
 * synthetic: project names, session ids and the workspace label are not real.
 */
import { writeFileSync } from "node:fs";
import { startDashboard } from "../dist/dashboard/server.js";

const NOW = Date.now();
const iso = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

const card = (name, lane, status, audits, snippet, ageSeconds = 600) => ({
  name,
  lane,
  status,
  auditCount: audits,
  snippet,
  ageSeconds,
  merging: status === "merging",
});
const row = (role, task, state, activity, ageSeconds, sessionId) => ({
  role,
  ...(task ? { task, ageSeconds } : {}),
  state,
  activity,
  ...(sessionId ? { sessionId } : {}),
});

const sixRoles = ["specifier", "coder", "cleaner", "architect", "hardener", "qa"];
const fourRoles = ["specifier", "coder", "refactorer", "architect"];

const state = {
  schemaVersion: 1,
  generatedAt: iso(0),
  initialised: true,
  runner: "Alisio",
  budget: { total: 18400, limit: 60000, exceeded: false },
  packs: [],
  projects: [
    {
      name: "dice",
      pack: "four-pack",
      open: true,
      running: true,
      roles: fourRoles,
      columns: [...fourRoles, "done"],
      approvalAfter: "specifier",
      tasks: [
        card("coin-flip", "specifier", "waiting_approval", 1, "Waiting for approval", 300),
        card(
          "roll-dice",
          "coder",
          "working",
          2,
          "Implementing the roll behaviour slice with a failing test first",
          180,
        ),
        card("shuffle", "coder", "merging", 3, "Merging", 20),
        card("score-board", "done", "done", 2, "Done", 5400),
      ],
      queue: [
        row("specifier", "coin-flip", "idle", 3, 300, "ses-demo-01"),
        row("coder", "roll-dice", "live", 5, 180, "ses-demo-02"),
        row("refactorer", undefined, "none", 0),
        row("architect", undefined, "none", 0),
      ],
    },
    {
      name: "billing-api",
      pack: "six-pack",
      open: true,
      running: true,
      roles: sixRoles,
      columns: [...sixRoles, "done"],
      approvalAfter: "specifier",
      tasks: [
        card(
          "invoice-totals",
          "cleaner",
          "blocked",
          2,
          "The crap gate still fails after 2 bounce(s): totals.ts complexity 9",
          900,
        ),
        card(
          "tax-rules",
          "specifier",
          "clarifying",
          1,
          "Which rounding rule applies to cross-border invoices?",
          240,
        ),
      ],
      queue: [
        row("specifier", "tax-rules", "idle", 2, 240, "ses-demo-03"),
        row("coder", undefined, "idle", 1, undefined, "ses-demo-04"),
        row("cleaner", "invoice-totals", "idle", 4, 900, "ses-demo-05"),
        row("architect", undefined, "none", 0),
        row("hardener", undefined, "none", 0),
        row("qa", undefined, "none", 0),
      ],
    },
    {
      name: "notes-app",
      pack: "two-pack",
      open: true,
      running: true,
      roles: ["coder", "cleaner"],
      columns: ["coder", "cleaner", "done"],
      tasks: [],
      queue: [row("coder", undefined, "none", 0), row("cleaner", undefined, "none", 0)],
    },
  ],
  attention: [
    {
      id: "approval:dice:coin-flip",
      kind: "approval",
      project: "dice",
      task: "coin-flip",
      createdAt: iso(300),
      actions: ["documents", "approve", "reject"],
    },
    {
      id: "clarification:billing-api:tax-rules",
      kind: "clarification",
      project: "billing-api",
      task: "tax-rules",
      createdAt: iso(240),
      actions: ["answer"],
      detail: "Which rounding rule applies to cross-border invoices?",
    },
    {
      id: "gate-failed:billing-api:invoice-totals",
      kind: "gate-failed",
      project: "billing-api",
      task: "invoice-totals",
      createdAt: iso(120),
      actions: ["retry", "delete", "accept"],
      detail: "The crap gate still fails after 2 bounce(s):\n- totals.ts complexity 9",
    },
  ],
  activity: [
    ["handoff", "dice", "specifier", "coin-flip", "Handed off 3fa9c1d2e4 (audit pending)", 900],
    ["gate", "billing-api", "coder", "invoice-totals", "tests-green: passed", 700],
    ["bounce", "billing-api", "cleaner", "invoice-totals", "crap failed: bounce 1 of 2", 500],
    ["merge", "dice", "coder", "shuffle", "Merged 7be41a09cc into coder: merged", 60],
    ["approval", "dice", "specifier", "coin-flip", "Waiting for your approval", 30],
  ].map(([kind, project, role, task, message, ago]) => ({
    at: iso(ago),
    project,
    kind,
    role,
    task,
    message,
  })),
};

const documents = {
  project: "dice",
  task: "coin-flip",
  role: "specifier",
  base: "a1b2c3d4e5",
  commit: "f6a7b8c9d0",
  docs: [
    {
      path: "specs/coin-flip.feature",
      text: "Feature: Coin flip\n  Scenario: Heads\n    Given a fair coin\n    When I flip it\n    Then I see heads or tails\n",
      truncated: false,
      comments: [{ text: "Add a scenario for the edge case where the coin lands on its side." }],
    },
  ],
  diff: [
    "diff --git a/specs/coin-flip.feature b/specs/coin-flip.feature",
    "--- a/specs/coin-flip.feature",
    "+++ b/specs/coin-flip.feature",
    "@@ -1,3 +1,5 @@",
    " Feature: Coin flip",
    "-  Scenario: Flip",
    "+  Scenario: Heads",
    "+    Given a fair coin",
    "     When I flip it",
    "",
  ].join("\n"),
  diffTruncated: false,
  comments: [{ text: "Add a scenario for the edge case where the coin lands on its side." }],
  approvable: false,
};

const tailEntries = [
  {
    at: iso(120),
    kind: "prompt",
    text: "Implement the roll behaviour slice. Start with a failing test.",
  },
  {
    at: iso(90),
    kind: "reply",
    text: "Added roll.test.ts (red), then roll.ts (green). Committing.",
  },
];

const services = {
  state: async () => ({ ...state, generatedAt: new Date().toISOString() }),
  documents: async () => documents,
  agentTail: async (_workspace, _project, role) => ({
    role,
    runner: "Alisio",
    sessionId: "ses-demo-02",
    state: "live",
    tail: tailEntries,
  }),
  mission: async (_workspace, project) => `Demo mission for ${project}.\n`,
  approve: async () => undefined,
  reject: async () => undefined,
  answer: async () => undefined,
  addComment: async () => undefined,
  clearComments: async () => undefined,
  retryTask: async () => undefined,
  deleteTask: async () => undefined,
  onTeardown: () => () => undefined,
};

const handle = await startDashboard({ services, workspace: "/scratch/demo-workspace" });
console.log(handle.url);
const portFile = process.argv.indexOf("--port-file");
if (portFile > 0 && process.argv[portFile + 1])
  writeFileSync(process.argv[portFile + 1], `${handle.url}\n`);
process.on("SIGINT", () => void handle.close().then(() => process.exit(0)));
setInterval(() => undefined, 1 << 30);
