/**
 * Calibration (spec 11.4, FID 15.8): tolerances come from measured repeatability and known
 * mutations, never from a wish for green. Pure math over metrics the application computed.
 */

/** The deterministic mutation list the probe injects per critical element (spec 11.4). */
export const CALIBRATION_MUTATIONS = [
  "translate-x-2",
  "translate-y-2",
  "translate-x-4",
  "translate-y-4",
  "translate-x-8",
  "translate-y-8",
  "font-weight-plus-200",
  "color-shift-16",
  "hide-icons",
  "replace-text",
] as const;
export type MutationId = (typeof CALIBRATION_MUTATIONS)[number];

/** The 2 px translations are acceptable by default; the contract may relabel (spec 11.4). */
export const DEFAULT_ACCEPTABLE: readonly MutationId[] = ["translate-x-2", "translate-y-2"];

export const MAX_CHANNEL_TOLERANCE = 8;

export type ChannelTolerance =
  | { ok: true; tolerance: number }
  | { ok: false; code: "CAL-002"; message: string };

/** The largest channel difference seen on unchanged captures, capped at 8 (higher is an unstable environment). */
export function channelToleranceFrom(maxDiffs: readonly number[]): ChannelTolerance {
  const tolerance = Math.max(0, ...maxDiffs);
  if (tolerance > MAX_CHANNEL_TOLERANCE)
    return {
      ok: false,
      code: "CAL-002",
      message: `CAL-002 unstable environment: unchanged captures differ by up to ${tolerance} per channel (maximum ${MAX_CHANNEL_TOLERANCE}). Stabilise the environment; raising the tolerance is not a fix.`,
    };
  return { ok: true, tolerance };
}

export interface RegionSample {
  dR: number;
  qK: number;
  k: number;
}

export interface CaseCalibrationInput {
  channelTolerance: number;
  /** Unchanged captures compared with the baseline. */
  repetitions: Array<{ regions: Record<string, RegionSample> }>;
  mutations: Array<{ id: string; defect: boolean; regions: Record<string, RegionSample> }>;
}

export interface RegionCalibration {
  k: number;
  u_d: number;
  u_q: number;
  v_d: number | null;
  v_q: number | null;
  limit_d: number | null;
  limit_q: number | null;
  status: "OK" | "UNSEPARABLE";
}

export interface CalibrationFile {
  schemaVersion: 1;
  id: string;
  browser: string;
  browserVersion: string;
  createdAt: string;
  cases: Record<string, { channelTolerance: number; regions: Record<string, RegionCalibration> }>;
  inputsSha256: string;
}

export interface ValidatorQuality {
  sensitivity: number | null;
  falsePositiveRate: number | null;
  tp: number;
  fn: number;
  fp: number;
  tn: number;
}

/** Label mutations: the contract's acceptable list wins over the default. */
export function labelMutations(
  acceptable: readonly string[] = DEFAULT_ACCEPTABLE,
): Array<{ id: MutationId; defect: boolean }> {
  return CALIBRATION_MUTATIONS.map((id) => ({ id, defect: !acceptable.includes(id) }));
}

function regionOf(
  samples: readonly RegionSample[],
  defects: readonly RegionSample[],
  position: number,
): RegionCalibration {
  const k = samples[0]?.k ?? defects[0]?.k ?? 16;
  const u_d = Math.max(0, ...samples.map((s) => s.dR));
  const u_q = Math.max(0, ...samples.map((s) => s.qK));
  // A mutation that left the region untouched says nothing about it (a no-op such as hiding icons
  // that do not exist): only defects that changed pixels inside the region set the bound `v`.
  const seen = defects.filter((s) => s.dR > 0 || s.qK > 0);
  if (seen.length === 0)
    return {
      k,
      u_d,
      u_q,
      v_d: null,
      v_q: null,
      limit_d: null,
      limit_q: null,
      status: "UNSEPARABLE",
    };
  const v_d = Math.min(...seen.map((s) => s.dR));
  const v_q = Math.min(...seen.map((s) => s.qK));
  // u < v is the only useful separation: a limit between them is chosen by `position` (default 0.5).
  if (!(u_d < v_d) || !(u_q < v_q))
    return { k, u_d, u_q, v_d, v_q, limit_d: null, limit_q: null, status: "UNSEPARABLE" };
  return {
    k,
    u_d,
    u_q,
    v_d,
    v_q,
    limit_d: u_d + (v_d - u_d) * position,
    limit_q: u_q + (v_q - u_q) * position,
    status: "OK",
  };
}

/**
 * Per region: `u` is the worst noise on unchanged captures, `v` the smallest metric of a mutation
 * labelled as a defect; the limit sits `position` of the way from `u` to `v`. When `u >= v` the
 * region is UNSEPARABLE and its visual checks stay REVIEW until the environment is stabilised.
 */
export function calibrateCase(
  input: CaseCalibrationInput,
  position: number,
): { channelTolerance: number; regions: Record<string, RegionCalibration> } {
  const regionIds = new Set<string>();
  for (const sample of [
    ...input.repetitions.map((r) => r.regions),
    ...input.mutations.map((m) => m.regions),
  ])
    for (const id of Object.keys(sample)) regionIds.add(id);
  const regions: Record<string, RegionCalibration> = {};
  for (const id of [...regionIds].sort()) {
    const noise = input.repetitions
      .map((r) => r.regions[id])
      .filter((s): s is RegionSample => s !== undefined);
    const defects = input.mutations
      .filter((m) => m.defect)
      .map((m) => m.regions[id])
      .filter((s): s is RegionSample => s !== undefined);
    regions[id] = regionOf(noise, defects, position);
  }
  return { channelTolerance: input.channelTolerance, regions };
}

/** The validator's own quality over the labelled set (FID 15.8): sensitivity and false positive rate. */
export function validatorQuality(
  input: CaseCalibrationInput,
  calibrated: Record<string, RegionCalibration>,
): ValidatorQuality {
  const flagged = (regions: Record<string, RegionSample>): boolean =>
    Object.entries(regions).some(([id, sample]) => {
      const limit = calibrated[id];
      if (!limit || limit.limit_d === null || limit.limit_q === null)
        return sample.dR > 0 || sample.qK > 0;
      return sample.dR > limit.limit_d || sample.qK > limit.limit_q;
    });
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let tn = 0;
  for (const mutation of input.mutations) {
    const hit = flagged(mutation.regions);
    if (mutation.defect && hit) tp += 1;
    else if (mutation.defect) fn += 1;
    else if (hit) fp += 1;
    else tn += 1;
  }
  for (const repetition of input.repetitions) {
    if (flagged(repetition.regions)) fp += 1;
    else tn += 1;
  }
  return {
    sensitivity: tp + fn === 0 ? null : tp / (tp + fn),
    falsePositiveRate: fp + tn === 0 ? null : fp / (fp + tn),
    tp,
    fn,
    fp,
    tn,
  };
}
