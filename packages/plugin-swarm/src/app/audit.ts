/**
 * Two-pass audit handshake (AD-5). The first handoff envelope is parked and the same session is
 * challenged to re-verify. A second envelope with the same commit releases it; a changed commit
 * restarts the challenge, bounded by `maxAuditRounds`.
 */
export interface AuditState {
  commit: string;
  /** Challenges issued so far for this task and role. */
  challenges: number;
}

export type AuditStep =
  | { action: "release"; commit: string }
  | { action: "challenge"; state: AuditState }
  | { action: "exhausted"; challenges: number };

export const startAudit = (commit: string): AuditState => ({ commit, challenges: 1 });

export function nextAudit(state: AuditState, commit: string, maxRounds: number): AuditStep {
  if (commit === state.commit) return { action: "release", commit };
  if (state.challenges >= maxRounds) return { action: "exhausted", challenges: state.challenges };
  return { action: "challenge", state: { commit, challenges: state.challenges + 1 } };
}
