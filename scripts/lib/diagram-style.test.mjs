import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyDiagramStyle,
  DEFAULT_BACKGROUND,
  DEFAULT_PADDING,
  MAX_PADDING,
  resolveDiagramStyle,
} from "./diagram-style.mjs";

const SVG =
  '<svg id="my-svg" width="100%" xmlns="http://www.w3.org/2000/svg" class="flowchart" style="max-width: 541px; background-color: transparent;" viewBox="0 0 541 2326" role="graphics-document document"><style>#my-svg{fill:#333;}</style><g/></svg>';

describe("resolveDiagramStyle", () => {
  it("defaults to a white background with 24px padding", () => {
    assert.deepEqual(resolveDiagramStyle({}, "t"), { background: "#ffffff", padding: 24 });
    assert.equal(DEFAULT_BACKGROUND, "#ffffff");
    assert.equal(DEFAULT_PADDING, 24);
  });

  it("accepts overrides", () => {
    assert.deepEqual(resolveDiagramStyle({ background: "transparent", padding: 0 }, "t"), {
      background: "transparent",
      padding: 0,
    });
    assert.equal(resolveDiagramStyle({ background: "#f5f5f5" }, "t").background, "#f5f5f5");
    assert.equal(
      resolveDiagramStyle({ background: "rgb(1, 2, 3)" }, "t").background,
      "rgb(1, 2, 3)",
    );
  });

  it("rejects invalid padding", () => {
    for (const padding of [-1, 1.5, "8", Number.NaN, MAX_PADDING + 1, null]) {
      assert.throws(() => resolveDiagramStyle({ padding }, "t"), /"padding".*"t"|"t".*"padding"/);
    }
  });

  it("rejects invalid or injection-shaped backgrounds", () => {
    for (const background of ["", "  ", 5, null, 'red" onload="x', "<script>", "red;}"]) {
      assert.throws(() => resolveDiagramStyle({ background }, "t"), /"background"/);
    }
  });
});

describe("applyDiagramStyle", () => {
  it("adds a white rect as first child and expands viewBox and max-width", () => {
    const out = applyDiagramStyle(SVG, { background: "#ffffff", padding: 24 });
    assert.match(out, /viewBox="-24 -24 589 2374"/);
    assert.match(out, /max-width: 589px/);
    assert.match(out, /background-color: #ffffff/);
    assert.ok(
      out.includes(
        'role="graphics-document document"><rect x="-24" y="-24" width="589" height="2374" fill="#ffffff"/><style>',
      ),
    );
  });

  it("keeps a non-zero viewBox origin consistent", () => {
    const out = applyDiagramStyle(SVG.replace("0 0 541 2326", "10 20 100 200"), {
      background: "#fff",
      padding: 5,
    });
    assert.match(out, /viewBox="5 15 110 210"/);
    assert.match(out, /<rect x="5" y="15" width="110" height="210" fill="#fff"\/>/);
  });

  it("expands a numeric width and height", () => {
    const svg = SVG.replace('width="100%"', 'width="541" height="2326"');
    const out = applyDiagramStyle(svg, { background: "#fff", padding: 24 });
    assert.match(out, /width="589" height="2374"/);
  });

  it("adds no rect for a transparent background but still pads", () => {
    const out = applyDiagramStyle(SVG, { background: "transparent", padding: 8 });
    assert.ok(!out.includes("<rect"));
    assert.match(out, /viewBox="-8 -8 557 2342"/);
  });

  it("is the identity for transparent with zero padding", () => {
    assert.equal(applyDiagramStyle(SVG, { background: "transparent", padding: 0 }), SVG);
  });

  it("throws when the SVG has no root viewBox", () => {
    assert.throws(
      () => applyDiagramStyle("<svg></svg>", { background: "#fff", padding: 1 }),
      /viewBox/,
    );
  });
});
