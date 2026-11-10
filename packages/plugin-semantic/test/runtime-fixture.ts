import { createHash } from "node:crypto";
import { RUNTIME_PACKAGES, type RuntimePackage } from "../src/engine/runtime.js";
import { makeTgz, type TarEntry } from "./tar-fixture.js";

const integrity = (data: Buffer) => `sha512-${createHash("sha512").update(data).digest("base64")}`;

/** Fake onnxruntime tarballs using the real `select` rules, served under fake HTTPS URLs. */
export function fakeRuntime(extra: TarEntry[] = []) {
  const node = makeTgz([
    {
      name: "package/package.json",
      data: Buffer.from('{"name":"onnxruntime-node","main":"dist/index.js"}'),
    },
    {
      name: "package/dist/index.js",
      data: Buffer.from("module.exports = { fake: true, common: require('onnxruntime-common') };"),
    },
    { name: "package/dist/index.js.map", data: Buffer.from("{}") },
    { name: "package/script/install.js", data: Buffer.from("// never extracted") },
    { name: "package/bin/napi-v6/linux/x64/onnxruntime_binding.node", data: Buffer.alloc(2000, 1) },
    { name: "package/bin/napi-v6/linux/x64/libonnxruntime.so.1", data: Buffer.alloc(3000, 2) },
    {
      name: "package/bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so",
      data: Buffer.alloc(100, 3),
    },
    { name: "package/bin/napi-v6/win32/x64/onnxruntime_binding.node", data: Buffer.alloc(2000, 4) },
    ...extra,
  ]);
  const common = makeTgz([
    {
      name: "package/package.json",
      data: Buffer.from('{"name":"onnxruntime-common","main":"dist/cjs/index.js"}'),
    },
    { name: "package/dist/cjs/package.json", data: Buffer.from('{"type":"commonjs"}') },
    { name: "package/dist/cjs/index.js", data: Buffer.from("module.exports = { common: true };") },
    { name: "package/dist/esm/index.js", data: Buffer.from("export {}") },
  ]);
  const [realNode, realCommon] = RUNTIME_PACKAGES as [RuntimePackage, RuntimePackage];
  const packages: RuntimePackage[] = [
    {
      ...realNode,
      url: "https://example.test/ort-node.tgz",
      bytes: node.length,
      integrity: integrity(node),
    },
    {
      ...realCommon,
      url: "https://example.test/ort-common.tgz",
      bytes: common.length,
      integrity: integrity(common),
    },
  ];
  return { packages, served: { "ort-node.tgz": node, "ort-common.tgz": common } };
}
