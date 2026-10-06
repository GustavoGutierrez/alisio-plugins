import { isPackId, isShippedRuleId, isWorkspaceRuleId } from "../ids.js";
import { isSeverity } from "../severity.js";
import { modes } from "../state/feature-state.js";
import { isLevel } from "../state/levels.js";
import { commandNames, type FrontsmithConfig, type RawConfig, resolveConfig } from "./defaults.js";

/**
 * Diagnostic codes (spec 8.4, owner-approved): CFG-001 unknown key, CFG-002 invalid type or
 * value, CFG-003 missing or unsupported schemaVersion, CFG-004 non-loopback URL, CFG-005 invalid
 * command argv, CFG-006 path not contained.
 */
export type ConfigCode = "CFG-001" | "CFG-002" | "CFG-003" | "CFG-004" | "CFG-005" | "CFG-006";

export interface ConfigDiagnostic {
  code: ConfigCode;
  /** JSON pointer into the config document. */
  pointer: string;
  message: string;
}

export type ConfigValidation =
  | { ok: true; raw: RawConfig; config: FrontsmithConfig }
  | { ok: false; diagnostics: ConfigDiagnostic[] };

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const LOOPBACK_URL = /^http:\/\/(?:127\.0\.0\.1|localhost):([0-9]{1,5})(?:[/?#].*)?$/;
const GATE_ID = /^[a-z][a-z0-9-]{2,40}$/;
const CUSTOM_AGENT = /^(?!fs-)[a-z][a-z0-9]{1,9}-[a-z0-9-]{2,40}$/;

export function validateConfig(input: unknown): ConfigValidation {
  const diagnostics: ConfigDiagnostic[] = [];
  const add = (code: ConfigCode, pointer: string, message: string): void => {
    diagnostics.push({ code, pointer, message });
  };

  if (!isObj(input)) {
    add("CFG-002", "", "config must be a JSON object");
    return { ok: false, diagnostics };
  }

  /** Reject keys outside `allowed` (CFG-001) and return the object. */
  const closed = (value: unknown, pointer: string, allowed: readonly string[]): Obj | undefined => {
    if (!isObj(value)) {
      add("CFG-002", pointer, "must be an object");
      return undefined;
    }
    for (const key of Object.keys(value))
      if (!allowed.includes(key)) add("CFG-001", `${pointer}/${key}`, `unknown key "${key}"`);
    return value;
  };

  const text = (value: unknown, pointer: string, max = 4000): void => {
    if (typeof value !== "string" || value.length === 0 || value.length > max)
      add("CFG-002", pointer, `must be a string of 1-${max} characters`);
  };

  const integer = (value: unknown, pointer: string, min: number, max?: number): void => {
    if (
      !Number.isInteger(value) ||
      (value as number) < min ||
      (max !== undefined && (value as number) > max)
    )
      add(
        "CFG-002",
        pointer,
        `must be an integer >= ${min}${max !== undefined ? ` and <= ${max}` : ""}`,
      );
  };

  const oneOf = (value: unknown, pointer: string, options: readonly string[]): void => {
    if (typeof value !== "string" || !options.includes(value))
      add("CFG-002", pointer, `must be one of ${options.join(", ")}`);
  };

  const list = (
    value: unknown,
    pointer: string,
    item: (v: unknown, p: string) => void,
    max = 200,
  ): void => {
    if (!Array.isArray(value)) {
      add("CFG-002", pointer, "must be an array");
      return;
    }
    if (value.length > max) add("CFG-002", pointer, `must have at most ${max} items`);
    value.forEach((entry, index) => {
      item(entry, `${pointer}/${index}`);
    });
  };

  const relativePath = (value: unknown, pointer: string): void => {
    if (typeof value !== "string" || value.length === 0 || value.length > 512) {
      add("CFG-002", pointer, "must be a non-empty path string");
      return;
    }
    const unsafe =
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value) ||
      value.includes("\u0000") ||
      value.includes("\\") ||
      value.split("/").includes("..");
    if (unsafe) add("CFG-006", pointer, "must be a relative path without '..', NUL or backslashes");
  };

  const argv = (value: unknown, pointer: string, allowFiles: boolean): void => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
      add("CFG-005", pointer, "must be an argv array of 1-32 strings");
      return;
    }
    value.forEach((entry, index) => {
      const at = `${pointer}/${index}`;
      if (
        typeof entry !== "string" ||
        entry.length < 1 ||
        entry.length > 512 ||
        entry.includes("\u0000")
      ) {
        add("CFG-005", at, "must be a string of 1-512 characters without NUL");
        return;
      }
      if (entry.includes("{files}") && (!allowFiles || entry !== "{files}"))
        add("CFG-005", at, "{files} must be a whole element of a testRelated command");
    });
  };

  const loopbackUrl = (value: unknown, pointer: string): void => {
    const match = typeof value === "string" ? LOOPBACK_URL.exec(value) : null;
    if (!match || Number(match[1]) > 65535)
      add("CFG-004", pointer, "must be http://127.0.0.1:<port> or http://localhost:<port>");
  };

  const strings = (
    value: unknown,
    pointer: string,
    check: (v: string) => boolean,
    what: string,
  ): void => {
    list(value, pointer, (entry, at) => {
      if (typeof entry !== "string" || !check(entry)) add("CFG-002", at, `must be ${what}`);
    });
  };

  // schemaVersion
  if (!("schemaVersion" in input)) add("CFG-003", "/schemaVersion", "schemaVersion is required");
  else if (input.schemaVersion !== 1)
    add("CFG-003", "/schemaVersion", "only schemaVersion 1 is supported");

  const root = closed(input, "", [
    "$schema",
    "schemaVersion",
    "paths",
    "defaults",
    "commands",
    "packs",
    "rules",
    "accessibility",
    "fidelity",
    "limits",
    "models",
    "agents",
    "gates",
    "adapters",
    "dashboard",
  ]);
  if (!root) return { ok: false, diagnostics };
  if ("$schema" in root) text(root.$schema, "/$schema", 512);

  if ("paths" in root) {
    const paths = closed(root.paths, "/paths", [
      "artifacts",
      "sourceRoots",
      "themeOutput",
      "tokenFiles",
    ]);
    if (paths) {
      if ("artifacts" in paths) relativePath(paths.artifacts, "/paths/artifacts");
      if ("themeOutput" in paths) relativePath(paths.themeOutput, "/paths/themeOutput");
      if ("sourceRoots" in paths) list(paths.sourceRoots, "/paths/sourceRoots", relativePath, 20);
      if ("tokenFiles" in paths)
        list(
          paths.tokenFiles,
          "/paths/tokenFiles",
          (v, p) => {
            if (
              typeof v !== "string" ||
              v.length === 0 ||
              v.length > 512 ||
              v.startsWith("/") ||
              v.includes("\\") ||
              v.includes("\u0000") ||
              v.split("/").includes("..")
            )
              add("CFG-006", p, "must be a relative glob without '..', NUL or backslashes");
          },
          50,
        );
    }
  }

  if ("defaults" in root) {
    const defaults = closed(root.defaults, "/defaults", ["level", "mode"]);
    if (defaults) {
      if ("level" in defaults && !isLevel(defaults.level))
        add("CFG-002", "/defaults/level", "must be one of L0, L1, L2, L3");
      if ("mode" in defaults) oneOf(defaults.mode, "/defaults/mode", modes);
    }
  }

  if ("commands" in root) {
    const commands = closed(root.commands, "/commands", commandNames);
    if (commands)
      for (const name of commandNames)
        if (name in commands) argv(commands[name], `/commands/${name}`, name === "testRelated");
  }

  if ("packs" in root) {
    const packs = closed(root.packs, "/packs", ["enable", "disable", "order"]);
    if (packs)
      for (const key of ["enable", "disable", "order"] as const)
        if (key in packs) strings(packs[key], `/packs/${key}`, isPackId, "a pack id");
  }

  if ("rules" in root) {
    if (!isObj(root.rules)) add("CFG-002", "/rules", "must be an object");
    else
      for (const [id, override] of Object.entries(root.rules)) {
        const at = `/rules/${id}`;
        if (!isShippedRuleId(id) && !isWorkspaceRuleId(id)) {
          add("CFG-002", at, "key must be a rule id");
          continue;
        }
        const entry = closed(override, at, [
          "severity",
          "enabled",
          "justification",
          "files",
          "params",
        ]);
        if (!entry) continue;
        if ("severity" in entry && !isSeverity(entry.severity))
          add("CFG-002", `${at}/severity`, "must be blocker, major, minor or nit");
        if ("enabled" in entry && typeof entry.enabled !== "boolean")
          add("CFG-002", `${at}/enabled`, "must be a boolean");
        if ("justification" in entry) text(entry.justification, `${at}/justification`, 1000);
        if ("files" in entry)
          strings(entry.files, `${at}/files`, (v) => v.length > 0 && v.length <= 512, "a glob");
        if ("params" in entry && !isObj(entry.params))
          add("CFG-002", `${at}/params`, "must be an object");
      }
  }

  if ("accessibility" in root) {
    const a11y = closed(root.accessibility, "/accessibility", ["target", "operationalMargin"]);
    if (a11y) {
      if ("target" in a11y) oneOf(a11y.target, "/accessibility/target", ["AA", "AAA"]);
      if ("operationalMargin" in a11y) {
        const margin = closed(a11y.operationalMargin, "/accessibility/operationalMargin", [
          "text",
          "nonText",
        ]);
        if (margin)
          for (const key of ["text", "nonText"] as const)
            if (
              key in margin &&
              !(
                typeof margin[key] === "number" &&
                (margin[key] as number) >= 1 &&
                (margin[key] as number) <= 21
              )
            )
              add(
                "CFG-002",
                `/accessibility/operationalMargin/${key}`,
                "must be a ratio between 1 and 21",
              );
      }
    }
  }

  if ("fidelity" in root) {
    const fidelity = closed(root.fidelity, "/fidelity", [
      "baseUrl",
      "serve",
      "browser",
      "repetitions",
      "calibrationPosition",
      "maxImageBytes",
    ]);
    if (fidelity) {
      if ("baseUrl" in fidelity) loopbackUrl(fidelity.baseUrl, "/fidelity/baseUrl");
      if ("serve" in fidelity) {
        const serve = closed(fidelity.serve, "/fidelity/serve", [
          "command",
          "readyUrl",
          "timeoutMs",
        ]);
        if (serve) {
          if ("command" in serve) argv(serve.command, "/fidelity/serve/command", false);
          else add("CFG-002", "/fidelity/serve/command", "command is required");
          if ("readyUrl" in serve) loopbackUrl(serve.readyUrl, "/fidelity/serve/readyUrl");
          else add("CFG-002", "/fidelity/serve/readyUrl", "readyUrl is required");
          if ("timeoutMs" in serve)
            integer(serve.timeoutMs, "/fidelity/serve/timeoutMs", 1000, 3_600_000);
        }
      }
      if ("browser" in fidelity)
        oneOf(fidelity.browser, "/fidelity/browser", ["chromium", "firefox", "webkit"]);
      if ("repetitions" in fidelity) integer(fidelity.repetitions, "/fidelity/repetitions", 1, 50);
      if ("calibrationPosition" in fidelity) {
        const position = fidelity.calibrationPosition;
        if (typeof position !== "number" || position < 0 || position > 1)
          add("CFG-002", "/fidelity/calibrationPosition", "must be a number between 0 and 1");
      }
      if ("maxImageBytes" in fidelity)
        integer(fidelity.maxImageBytes, "/fidelity/maxImageBytes", 1);
    }
  }

  if ("limits" in root) {
    const limits = closed(root.limits, "/limits", [
      "maxBounces",
      "maxRepairRounds",
      "maxRemediations",
      "maxTaskFiles",
      "maxTaskCriteria",
      "commandTimeoutMs",
    ]);
    if (limits)
      for (const [key, min] of [
        ["maxBounces", 0],
        ["maxRepairRounds", 0],
        ["maxRemediations", 0],
        ["maxTaskFiles", 1],
        ["maxTaskCriteria", 1],
        ["commandTimeoutMs", 1000],
      ] as const)
        if (key in limits) integer(limits[key], `/limits/${key}`, min);
  }

  if ("models" in root) {
    // Selector grammar (spec 16.4) is validated by the models domain in a later phase; here only
    // the shape is closed so an `effort` key is rejected (B-05).
    const models = closed(root.models, "/models", ["tiers", "agents"]);
    if (models) {
      if ("tiers" in models) {
        const tiers = closed(models.tiers, "/models/tiers", ["reasoning", "standard", "fast"]);
        if (tiers)
          for (const key of Object.keys(tiers))
            if (["reasoning", "standard", "fast"].includes(key))
              text(tiers[key], `/models/tiers/${key}`, 200);
      }
      if ("agents" in models) {
        if (!isObj(models.agents)) add("CFG-002", "/models/agents", "must be an object");
        else
          for (const [agent, value] of Object.entries(models.agents))
            text(value, `/models/agents/${agent}`, 200);
      }
    }
  }

  if ("agents" in root) {
    const agents = closed(root.agents, "/agents", ["custom"]);
    if (agents && "custom" in agents)
      list(
        agents.custom,
        "/agents/custom",
        (entry, at) => {
          const custom = closed(entry, at, ["name", "attach", "tier"]);
          if (!custom) return;
          if (typeof custom.name !== "string" || !CUSTOM_AGENT.test(custom.name))
            add("CFG-002", `${at}/name`, "must match <prefix>-<name> and must not start with fs-");
          if (
            typeof custom.attach !== "string" ||
            !/^(review|audit|build:[a-z][a-z0-9-]{0,30})$/.test(custom.attach)
          )
            add("CFG-002", `${at}/attach`, "must be review, audit or build:<layer>");
          if ("tier" in custom) oneOf(custom.tier, `${at}/tier`, ["reasoning", "standard", "fast"]);
        },
        50,
      );
  }

  if ("gates" in root) {
    const gates = closed(root.gates, "/gates", ["custom"]);
    if (gates && "custom" in gates)
      list(
        gates.custom,
        "/gates/custom",
        (entry, at) => {
          const gate = closed(entry, at, [
            "id",
            "phase",
            "command",
            "timeoutMs",
            "report",
            "required",
            "severity",
          ]);
          if (!gate) return;
          if (typeof gate.id !== "string" || !GATE_ID.test(gate.id))
            add("CFG-002", `${at}/id`, "must match ^[a-z][a-z0-9-]{2,40}$");
          oneOf(gate.phase, `${at}/phase`, ["build", "validate"]);
          argv(gate.command, `${at}/command`, false);
          oneOf(gate.report, `${at}/report`, ["exit-code", "frontsmith-json"]);
          if ("timeoutMs" in gate) integer(gate.timeoutMs, `${at}/timeoutMs`, 1000);
          if ("required" in gate && typeof gate.required !== "boolean")
            add("CFG-002", `${at}/required`, "must be a boolean");
          if ("severity" in gate && !isSeverity(gate.severity))
            add("CFG-002", `${at}/severity`, "must be blocker, major, minor or nit");
        },
        50,
      );
  }

  if ("adapters" in root) {
    const adapters = closed(root.adapters, "/adapters", ["enable", "disable"]);
    if (adapters)
      for (const key of ["enable", "disable"] as const)
        if (key in adapters)
          strings(
            adapters[key],
            `/adapters/${key}`,
            (v) => /^[a-z][a-z0-9-]{1,30}$/.test(v),
            "an adapter id",
          );
  }

  if ("dashboard" in root) {
    const dashboard = closed(root.dashboard, "/dashboard", ["enabled"]);
    if (dashboard && "enabled" in dashboard && typeof dashboard.enabled !== "boolean")
      add("CFG-002", "/dashboard/enabled", "must be a boolean");
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  const raw = input as unknown as RawConfig;
  return { ok: true, raw, config: resolveConfig(raw) };
}
