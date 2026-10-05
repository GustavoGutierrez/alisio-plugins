import { describe, expect, it } from "vitest";
import { type AuditState, nextAudit, startAudit } from "../src/app/audit.js";

describe("audit handshake (AD-5)", () => {
  it("parks the first handoff and challenges once", () => {
    expect(startAudit("aaaaaaaaaa")).toEqual({ commit: "aaaaaaaaaa", challenges: 1 });
  });

  it("releases when the second envelope repeats the same commit", () => {
    const state = startAudit("aaaaaaaaaa");
    expect(nextAudit(state, "aaaaaaaaaa", 3)).toEqual({ action: "release", commit: "aaaaaaaaaa" });
  });

  it("restarts the challenge when the commit changed", () => {
    const state = startAudit("aaaaaaaaaa");
    const next = nextAudit(state, "bbbbbbbbbb", 3);
    expect(next).toEqual({
      action: "challenge",
      state: { commit: "bbbbbbbbbb", challenges: 2 },
    });
  });

  it("gives up once the round budget is spent", () => {
    let state: AuditState = startAudit("aaaaaaaaaa");
    const commits = ["bbbbbbbbbb", "cccccccccc"];
    for (const commit of commits) {
      const step = nextAudit(state, commit, 3);
      expect(step.action).toBe("challenge");
      state = (step as { state: AuditState }).state;
    }
    expect(nextAudit(state, "dddddddddd", 3)).toEqual({ action: "exhausted", challenges: 3 });
    // A repeat is still honoured at the limit.
    expect(nextAudit(state, "cccccccccc", 3).action).toBe("release");
  });
});
