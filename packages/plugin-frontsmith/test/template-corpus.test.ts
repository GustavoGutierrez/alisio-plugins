import { describe, expect, it } from "vitest";
import { runRuleFixture } from "../src/application/checks/rule-fixtures.js";
import { engineValidators } from "../src/application/engines/index.js";
import type { RuleDef } from "../src/domain/rules/model.js";
import { DefaultFileAnalyzer } from "../src/infrastructure/analysis/file-analyzer.js";
import { DefaultImportGraphBuilder } from "../src/infrastructure/analysis/graph-builder.js";
import { loadAriaCatalog } from "../src/infrastructure/packs/catalog-loader.js";
import { loadShippedPacks } from "../src/infrastructure/packs/loader.js";

/**
 * Spike S-R13 pinned as a test: the lexical template scanner plus the element engines are run over
 * hand-written snippets per framework with known expected findings. A misfire here means the rule
 * must be reclassified `heuristic` until fixed (spec 24.2).
 */
const packs = await loadShippedPacks(engineValidators);
const rules = new Map<string, { rule: RuleDef; packId: string }>();
for (const pack of packs)
  for (const rule of pack.rules) rules.set(rule.id, { rule, packId: pack.packId });

interface Syntax {
  name: string;
  /** Path of the virtual file; its extension picks the template kind. */
  path: string;
  wrap(body: string): string;
  click: string;
  bind(attribute: string, value: string): string | undefined;
  spread: string | undefined;
  interpolation: string;
  icon: string;
}

const syntaxes: Syntax[] = [
  {
    name: "vue",
    path: "src/c.vue",
    wrap: (b) => `<template>\n${b}\n</template>\n`,
    click: '@click="go"',
    bind: (a, v) => `:${a}="${v}"`,
    spread: 'v-bind="attrs"',
    interpolation: "{{ label }}",
    icon: "<Icon />",
  },
  {
    name: "svelte",
    path: "src/c.svelte",
    wrap: (b) => `${b}\n`,
    click: "on:click={go}",
    bind: (a, v) => `${a}={${v}}`,
    spread: "{...rest}",
    interpolation: "{label}",
    icon: "<Icon />",
  },
  {
    name: "angular",
    path: "src/c.component.html",
    wrap: (b) => `${b}\n`,
    click: '(click)="go()"',
    bind: (a, v) => `[${a}]="${v}"`,
    spread: undefined,
    interpolation: "{{ label }}",
    icon: "<app-icon></app-icon>",
  },
  {
    name: "astro",
    path: "src/c.astro",
    wrap: (b) => `---\nconst go = 1;\n---\n${b}\n`,
    click: 'onclick="go()"',
    bind: (a, v) => `${a}={${v}}`,
    spread: "{...rest}",
    interpolation: "{label}",
    icon: "<Icon />",
  },
  {
    name: "html",
    path: "src/c.html",
    wrap: (b) => `${b}\n`,
    click: 'onclick="go()"',
    bind: () => undefined,
    spread: undefined,
    interpolation: "Label",
    icon: '<i class="icon"></i>',
  },
];

type Case = [string, string, boolean];

function concepts(s: Syntax): Case[] {
  const cases: Case[] = [
    [`<div ${s.click}>x</div>`, "FS-A11Y-002", true],
    [`<span ${s.click}>x</span>`, "FS-A11Y-002", true],
    [`<li ${s.click}>x</li>`, "FS-A11Y-002", true],
    [`<div ${s.click} role="button" tabindex="0" onkeydown="go()">x</div>`, "FS-A11Y-002", false],
    [`<div ${s.click} role="button">x</div>`, "FS-A11Y-002", false],
    [`<button ${s.click}>x</button>`, "FS-A11Y-002", false],
    ['<img src="a.png">', "FS-A11Y-001", true],
    ['<img src="a.png" alt="A">', "FS-A11Y-001", false],
    ['<img src="a.png" alt="">', "FS-A11Y-001", false],
    ['<img src="a.png" />', "FS-A11Y-001", true],
    ['<div tabindex="3">x</div>', "FS-A11Y-005", true],
    ['<div tabindex="0">x</div>', "FS-A11Y-005", false],
    ['<div tabindex="-1">x</div>', "FS-A11Y-005", false],
    ['<button aria-hidden="true">x</button>', "FS-A11Y-006", true],
    ['<a href="/a" aria-hidden="true">x</a>', "FS-A11Y-006", true],
    ['<span aria-hidden="true">x</span>', "FS-A11Y-006", false],
    ['<button aria-hidden="false">x</button>', "FS-A11Y-006", false],
    [`<a ${s.click}>go</a>`, "FS-A11Y-007", true],
    [`<a href="/x" ${s.click}>go</a>`, "FS-A11Y-007", false],
    ['<a href="/x">go</a>', "FS-A11Y-007", false],
    [`<button>${s.icon}</button>`, "FS-A11Y-008", true],
    [`<button aria-label="Close">${s.icon}</button>`, "FS-A11Y-008", false],
    ["<button>Save</button>", "FS-A11Y-008", false],
    [`<button>${s.interpolation}</button>`, "FS-A11Y-008", false],
    ['<a href="/x"><img src="a.png" alt="Home"></a>', "FS-A11Y-008", false],
    ["<input autofocus>", "FS-A11Y-011", true],
    ['<input type="text">', "FS-A11Y-011", false],
    ["<video autoplay></video>", "FS-A11Y-013", true],
    ["<video autoplay muted></video>", "FS-A11Y-013", false],
    ["<audio autoplay></audio>", "FS-A11Y-013", true],
    ["<table><tr><td>1</td></tr></table>", "FS-A11Y-014", true],
    ["<table><tr><th>H</th></tr><tr><td>1</td></tr></table>", "FS-A11Y-014", false],
    ['<table role="presentation"><tr><td>1</td></tr></table>', "FS-A11Y-014", false],
  ];
  const tabindexBound = s.bind("tabindex", "n");
  if (tabindexBound) cases.push([`<div ${tabindexBound}>x</div>`, "FS-A11Y-005", false]);
  const altBound = s.bind("alt", "t");
  const srcBound = s.bind("src", "u");
  if (altBound && srcBound) {
    cases.push([`<img ${srcBound} ${altBound}>`, "FS-A11Y-001", false]);
    cases.push([`<img ${srcBound}>`, "FS-A11Y-001", true]);
  }
  const hrefBound = s.bind("href", "u");
  if (hrefBound) cases.push([`<a ${hrefBound} ${s.click}>go</a>`, "FS-A11Y-007", false]);
  if (s.spread) cases.push([`<img src="a.png" ${s.spread}>`, "FS-A11Y-001", false]);
  return cases;
}

const framework: Record<string, Case[]> = {
  vue: [
    ['<div v-html="raw"></div>', "FS-VUE-001", true],
    ["<div>{{ raw }}</div>", "FS-VUE-001", false],
    ['<li v-for="i in xs">{{ i }}</li>', "FS-VUE-003", true],
    ['<li v-for="i in xs" :key="i">{{ i }}</li>', "FS-VUE-003", false],
    ['<li v-for="i in xs" v-bind:key="i">{{ i }}</li>', "FS-VUE-003", false],
    ['<li v-for="i in xs" v-if="i" :key="i">{{ i }}</li>', "FS-VUE-004", true],
    [
      '<ul><li v-for="i in xs" :key="i"><span v-if="i">{{ i }}</span></li></ul>',
      "FS-VUE-004",
      false,
    ],
    ['<template v-if="a"><p>x</p></template>', "FS-VUE-004", false],
  ],
  svelte: [
    ["{@html raw}", "FS-SVT-001", true],
    ["<p>{raw}</p>", "FS-SVT-001", false],
    ["{#each xs as x}<p>{x}</p>{/each}", "FS-SVT-001", false],
    ['{#if a < 3}<img src="a.png">{/if}', "FS-A11Y-001", true],
    ["{#each xs as x (x.id)}<li on:click|once={go}>{x}</li>{/each}", "FS-A11Y-002", true],
    [
      '<div class:active={on} on:click={go} role="button" tabindex="0" on:keydown={go}>x</div>',
      "FS-A11Y-002",
      false,
    ],
  ],
  angular: [
    ['<p [innerHTML]="h"></p>', "FS-NG-001", true],
    ["<p>{{ h }}</p>", "FS-NG-001", false],
    ['<p [attr.title]="t">{{ h }}</p>', "FS-NG-001", false],
    ['<div *ngIf="a" (click)="go()">x</div>', "FS-A11Y-002", true],
    ['@if (a) {\n  <img src="x">\n}', "FS-A11Y-001", true],
    ['@for (i of xs; track i) {\n  <li (click)="go()">{{ i }}</li>\n}', "FS-A11Y-002", true],
    ['<input [(ngModel)]="name" autofocus>', "FS-A11Y-011", true],
    ['<button [attr.aria-hidden]="true">x</button>', "FS-A11Y-006", false],
  ],
  astro: [
    [
      '<ul>{items.map((i) => <li onclick={go}>{i}</li>)}</ul><img src="a.png">',
      "FS-A11Y-001",
      true,
    ],
    ['<Layout title="x"><img src="a.png" alt="A" /></Layout>', "FS-A11Y-001", false],
  ],
  html: [
    ['<!-- <img src="a.png"> --><p>ok</p>', "FS-A11Y-001", false],
    ['<script>const t = "<img src=a.png>";</script><p>ok</p>', "FS-A11Y-001", false],
    ['<img title="<!-- x -->" src="a.png">', "FS-A11Y-001", true],
    ['<img data-x="a > b" alt="x" src="a.png">', "FS-A11Y-001", false],
  ],
};

const analyzer = new DefaultFileAnalyzer();
const deps = { analyzer, graphBuilder: new DefaultImportGraphBuilder() };
const aria = await loadAriaCatalog();

async function findings(path: string, text: string, ruleId: string): Promise<number> {
  const entry = rules.get(ruleId);
  if (!entry) throw new Error(`unknown rule ${ruleId}`);
  const result = await runRuleFixture(
    {
      rule: entry.rule,
      packId: entry.packId,
      ext: "json",
      text: JSON.stringify({ $fixture: { files: { [path]: text } } }),
    },
    { aria, deps, today: "2026-06-01" },
  );
  return result.findings.filter((finding) => finding.ruleId === ruleId).length;
}

describe("S-R13 template corpus", () => {
  for (const syntax of syntaxes) {
    const cases = [...concepts(syntax), ...(framework[syntax.name] ?? [])];
    it(`${syntax.name}: at least thirty snippets, none misfire`, async () => {
      expect(cases.length).toBeGreaterThanOrEqual(30);
      const wrong: string[] = [];
      for (const [snippet, ruleId, expected] of cases) {
        const count = await findings(syntax.path, syntax.wrap(snippet), ruleId);
        if (count > 0 !== expected)
          wrong.push(
            `${ruleId} expected ${expected ? "a finding" : "none"} for ${JSON.stringify(snippet)} but got ${count}`,
          );
      }
      expect(wrong).toEqual([]);
    });
  }
});
