import type { EngineId } from "../../domain/rules/model.js";
import type { EngineParamValidators } from "../../domain/rules/pack-validate.js";
import { advisory } from "./advisory.js";
import { architecture } from "./architecture.js";
import { ariaAttribute } from "./aria-attribute.js";
import { budget } from "./budget.js";
import { classToken } from "./class-token.js";
import { componentApi } from "./component-api.js";
import { cssAtRule } from "./css-at-rule.js";
import { cssDeclaration } from "./css-declaration.js";
import { cssFileGuard } from "./css-file-guard.js";
import { cssRawValue } from "./css-raw-value.js";
import { diffGuard } from "./diff-guard.js";
import { fileMetric } from "./file-metric.js";
import { importSpecifier } from "./import-specifier.js";
import { jsxElement } from "./jsx-element.js";
import { labelAssociation } from "./label-association.js";
import { packageJson } from "./package-json.js";
import { templateElement } from "./template-element.js";
import { testLocator } from "./test-locator.js";
import { tokenFile } from "./token-file.js";
import { tokenPairContrast } from "./token-pair-contrast.js";
import type { Engine } from "./types.js";

/** The closed engine registry (AD-5): rules can only name these twenty ids. */
export const engines: Readonly<Record<EngineId, Engine>> = {
  "css-declaration": cssDeclaration,
  "css-raw-value": cssRawValue,
  "css-at-rule": cssAtRule,
  "css-file-guard": cssFileGuard,
  "jsx-element": jsxElement,
  "template-element": templateElement,
  "jsx-label-association": labelAssociation,
  "aria-attribute": ariaAttribute,
  "import-specifier": importSpecifier,
  "class-token": classToken,
  "component-api": componentApi,
  "file-metric": fileMetric,
  "test-locator": testLocator,
  "package-json": packageJson,
  "token-file": tokenFile,
  "token-pair-contrast": tokenPairContrast,
  "diff-guard": diffGuard,
  architecture,
  budget,
  advisory,
};

/** Param validators for `validatePack`, derived from the registry. */
export const engineValidators: EngineParamValidators = Object.fromEntries(
  Object.values(engines).map((engine) => [
    engine.id,
    (params: Record<string, unknown>) => engine.validateParams(params),
  ]),
);

export type { Engine, EngineContext, EngineOutcome, RawFinding } from "./types.js";
