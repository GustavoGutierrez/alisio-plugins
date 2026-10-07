/** Injectable time source so the school year and timestamps are testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid clock time: ${iso}`);
  return { now: () => new Date(date.getTime()) };
}

/** Current calendar year, frozen into an exam at creation (spec 5.2). */
export function schoolYear(clock: Clock): number {
  return clock.now().getUTCFullYear();
}
