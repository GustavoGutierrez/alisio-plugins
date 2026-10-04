/**
 * Pinned Typst release (spec 16.1, P0.5). `/thesis:setup` downloads exactly these assets and
 * verifies the SHA-256 before extracting anything. CI installs the same pins.
 */
export const typstVersion = "0.15.1";

export interface TypstPin {
  asset: string;
  sha256: string;
  /** Name of the executable inside the extracted archive. */
  executable: "typst" | "typst.exe";
}

export const typstPins: Record<string, TypstPin> = {
  "linux-x64": {
    asset: "typst-x86_64-unknown-linux-musl.tar.xz",
    sha256: "a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c",
    executable: "typst",
  },
  "linux-arm64": {
    asset: "typst-aarch64-unknown-linux-musl.tar.xz",
    sha256: "5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee",
    executable: "typst",
  },
  "darwin-x64": {
    asset: "typst-x86_64-apple-darwin.tar.xz",
    sha256: "7f9fdd9584866245de9a79e0add8f9236fae6f40a8a45e2c4771ccc14db4e0fa",
    executable: "typst",
  },
  "darwin-arm64": {
    asset: "typst-aarch64-apple-darwin.tar.xz",
    sha256: "48f62ed034aa3a7978309579ac6ca00045e2ef0da73114e8af27cfd8e74dc05a",
    executable: "typst",
  },
  "win32-x64": {
    asset: "typst-x86_64-pc-windows-msvc.zip",
    sha256: "19ce3551153c2fe7ee9fa2f95208310c8f4d3209fedb699e0333faf8913f6736",
    executable: "typst.exe",
  },
};

export const typstReleaseBase = `https://github.com/typst/typst/releases/download/v${typstVersion}/`;

/** Pin key for a Node platform/arch pair, or undefined when no pinned asset exists. */
export function pinKey(platform: string, arch: string): string | undefined {
  const key = `${platform}-${arch}`;
  return key in typstPins ? key : undefined;
}
