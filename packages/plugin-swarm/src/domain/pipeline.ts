import { PHANTOM_SENDER } from "./handoff.js";
import { type Pack, type PackRole, roleIds } from "./pack.js";

export interface Route {
  /** The single role that continues the work, absent for a terminal handoff. */
  forward: string | undefined;
  /** Merge-only copies (`non-forwarding: true`): receivers merge the commit and do no work. */
  mergeOnly: string[];
  /** The last role's handoff: broadcast merge-only to every other role; the card is Done. */
  terminal: boolean;
}

export const entryRole = (pack: Pack): string =>
  (pack.roles.find((role) => role.isolation === "master") ?? (pack.roles[0] as PackRole)).id;

export const laneOrder = (pack: Pack): string[] => [...roleIds(pack), "done"];

export const isTerminalRole = (pack: Pack, role: string): boolean => pack.roles.at(-1)?.id === role;

export const approvalRequiredAfter = (pack: Pack, role: string): boolean =>
  pack.approval?.after === role;

/** Where a handoff released by `from` goes. `from` is a role id or the phantom sender. */
export function route(pack: Pack, from: string): Route {
  if (from === PHANTOM_SENDER) return { forward: entryRole(pack), mergeOnly: [], terminal: false };
  const ids = roleIds(pack);
  const index = ids.indexOf(from);
  if (index < 0) throw new Error(`Unknown role in routing: ${from}`);
  if (isTerminalRole(pack, from)) {
    return { forward: undefined, mergeOnly: ids.filter((id) => id !== from), terminal: true };
  }
  const propagation = pack.roles[index]?.propagation ?? "forward-only";
  const earlier = ids.slice(0, index);
  const mergeOnly =
    propagation === "back-all" ? earlier : propagation === "back-one" ? earlier.slice(-1) : [];
  return { forward: ids[index + 1], mergeOnly, terminal: false };
}

export interface ReleasePlan {
  /** Recipients of the released handoff (several when a parallel stage starts). */
  to: string[];
  /** The parallel stage the releasing role belongs to: its handoffs wait for the join. */
  stage?: string[];
  terminal: boolean;
}

/** The parallel stage that contains `role`, if any. */
export const stageOf = (pack: Pack, role: string): string[] | undefined =>
  pack.parallel?.find((stage) => stage.includes(role));

/** The stage whose handoffs the role directly after it receives together (the join target). */
export function joinSource(pack: Pack, role: string): string[] | undefined {
  const ids = roleIds(pack);
  const index = ids.indexOf(role);
  return pack.parallel?.find((stage) => ids.indexOf(stage.at(-1) as string) === index - 1);
}

/**
 * Where a role's released handoff goes, aware of parallel stages (spec 4.2 and 8.4): the role
 * before a stage fans out to every stage role, and a stage role hands off to the role after the
 * stage once all stage roles are done.
 */
export function releasePlan(pack: Pack, from: string): ReleasePlan {
  const base = route(pack, from);
  if (base.terminal) return { to: base.mergeOnly, terminal: true };
  const ids = roleIds(pack);
  const stage = stageOf(pack, from);
  if (stage) {
    const after = ids[ids.indexOf(stage.at(-1) as string) + 1] as string;
    return { to: [after], stage, terminal: false };
  }
  const next = base.forward as string;
  const entering = pack.parallel?.find((candidate) => candidate[0] === next);
  return { to: entering ? [...entering] : [next], terminal: false };
}
