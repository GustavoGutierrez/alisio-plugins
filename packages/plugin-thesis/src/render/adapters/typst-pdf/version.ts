export const requiredTypst = { major: 0, minor: 15, patch: 0 } as const;

export function parseTypstVersion(output: string): [number, number, number] | undefined {
  const match = /typst\s+(\d+)\.(\d+)\.(\d+)/i.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function typstVersionOk(version: [number, number, number]): boolean {
  const [major, minor, patch] = version;
  if (major !== requiredTypst.major) return major > requiredTypst.major;
  if (minor !== requiredTypst.minor) return minor > requiredTypst.minor;
  return patch >= requiredTypst.patch;
}
