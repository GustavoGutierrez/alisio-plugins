/**
 * Resource-prefix convention check (advisory only).
 *
 * RULE. Every agent and skill a package ships carries a short resource prefix:
 * 2 to 5 lowercase letters followed by `-` (for example `wf-planner`). All
 * resource names within one package share the same prefix, and no two
 * packages use the same prefix. A package's prefix is the most frequent valid
 * prefix among its resource names (ties resolve alphabetically), so no extra
 * manifest field is needed.
 *
 * This produces WARNING strings only; callers must never fail on them.
 */

/**
 * Packages exempt from the convention (owner decision: thesis is exempt).
 * Their names are neither checked nor counted in prefix-collision detection.
 */
export const PREFIX_EXEMPT_PACKAGES = new Set(["@alisio/plugin-thesis"]);

const PREFIX_PATTERN = /^([a-z]{2,5})-/;

/**
 * @param {{ name: string, resourceNames: string[] }[]} packages
 * @param {Set<string>} [exempt]
 * @returns {string[]} one warning per offending name and per prefix collision
 */
export function checkResourcePrefixes(packages, exempt = PREFIX_EXEMPT_PACKAGES) {
  const warnings = [];
  const owners = new Map();
  for (const { name, resourceNames } of packages) {
    if (exempt.has(name) || resourceNames.length === 0) continue;
    const counts = new Map();
    for (const resource of resourceNames) {
      const prefix = PREFIX_PATTERN.exec(resource)?.[1];
      if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    const dominant = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0];
    for (const resource of resourceNames) {
      const prefix = PREFIX_PATTERN.exec(resource)?.[1];
      if (!prefix)
        warnings.push(
          `${name}: resource "${resource}" has no resource prefix (expected 2-5 lowercase letters followed by "-")`,
        );
      else if (prefix !== dominant)
        warnings.push(
          `${name}: resource "${resource}" does not use the package prefix "${dominant}-"`,
        );
    }
    if (dominant) owners.set(dominant, [...(owners.get(dominant) ?? []), name]);
  }
  for (const [prefix, names] of owners)
    if (names.length > 1)
      warnings.push(
        `resource prefix "${prefix}-" is shared by ${names.join(", ")}; it must be unique`,
      );
  return warnings;
}
