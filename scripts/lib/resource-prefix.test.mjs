import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkResourcePrefixes, PREFIX_EXEMPT_PACKAGES } from "./resource-prefix.mjs";

const pkg = (name, resourceNames) => ({ name, resourceNames });

describe("checkResourcePrefixes", () => {
  it("accepts packages whose resources share one unique prefix", () => {
    const warnings = checkResourcePrefixes([
      pkg("@alisio/plugin-a", ["wf-planner", "wf-verify"]),
      pkg("@alisio/plugin-b", ["swarm-coder"]),
    ]);
    assert.deepEqual(warnings, []);
  });

  it("ignores packages without resources", () => {
    assert.deepEqual(checkResourcePrefixes([pkg("@alisio/plugin-a", [])]), []);
  });

  it("warns for each unprefixed name", () => {
    const warnings = checkResourcePrefixes([pkg("@alisio/plugin-a", ["wf-planner", "coder"])]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /plugin-a/);
    assert.match(warnings[0], /"coder"/);
  });

  it("warns when a prefix is too long or not lowercase letters", () => {
    const warnings = checkResourcePrefixes([
      pkg("@alisio/plugin-a", ["toolongprefix-x"]),
      pkg("@alisio/plugin-b", ["Up-x"]),
    ]);
    assert.equal(warnings.length, 2);
  });

  it("warns for names that deviate from the package's dominant prefix", () => {
    const warnings = checkResourcePrefixes([pkg("@alisio/plugin-a", ["wf-a", "wf-b", "xx-c"])]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /"xx-c"/);
    assert.match(warnings[0], /wf-/);
  });

  it("warns once per prefix collision across packages", () => {
    const warnings = checkResourcePrefixes([
      pkg("@alisio/plugin-a", ["wf-a"]),
      pkg("@alisio/plugin-b", ["wf-b"]),
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /wf-/);
    assert.match(warnings[0], /plugin-a/);
    assert.match(warnings[0], /plugin-b/);
  });

  it("skips exempt packages entirely", () => {
    assert.ok(PREFIX_EXEMPT_PACKAGES.has("@alisio/plugin-thesis"));
    const warnings = checkResourcePrefixes([
      pkg("@alisio/plugin-thesis", ["planner", "coder"]),
      pkg("@alisio/plugin-a", ["thes-x"]),
    ]);
    assert.deepEqual(warnings, []);
  });
});
