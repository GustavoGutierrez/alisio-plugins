import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appHarness } from "./helpers/app-harness.js";
import { cleanup } from "./helpers/harness.js";

afterEach(cleanup);

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x20, 0, 0, 0]),
  Buffer.from("WEBPVP8 "),
  Buffer.alloc(16, 2),
]);
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("teacher profile in the app", () => {
  it("saves the profile in teacher.yaml, keeping the chat's format, and refuses unshipped languages", async () => {
    const h = await appHarness();
    await h.profile();
    const yaml = await readFile(join(h.workspace, "evalua", "teacher.yaml"), "utf8");
    expect(yaml).toContain("teacherName: Ana Perez");
    expect(yaml).toContain("language: es");
    const english = await h.call("profile.save", {
      teacherName: "Ana",
      institution: "Demo",
      subject: "Math",
      paper: "a4",
      language: "en",
    });
    expect(english.error).toBe("invalid_input");
    // The chat reads the same profile.
    const fromChat = JSON.parse((await h.chat.tool("evalua_profile", { action: "get" })).text);
    expect(fromChat.profile.teacherName).toBe("Ana Perez");
  });
});

describe("logo upload (EVL-APP-AC-9)", () => {
  it("refuses 2 MB + 1 byte, SVG, stores PNG declared as JPEG by its magic bytes, and stores WebP", async () => {
    const h = await appHarness();
    expect(
      (await h.call("profile.setLogo", { dataBase64: PNG.toString("base64"), mime: "image/png" }))
        .error,
    ).toBe("phase_mismatch");
    await h.profile();
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 + 1 - PNG.length)]);
    expect(
      (await h.call("profile.setLogo", { dataBase64: big.toString("base64"), mime: "image/png" }))
        .error,
    ).toBe("file_too_large");
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect(
      (await h.call("profile.setLogo", { dataBase64: svg.toString("base64"), mime: "image/png" }))
        .error,
    ).toBe("bad_image");
    expect(
      (await h.call("profile.setLogo", { dataBase64: "not base64!", mime: "image/png" })).error,
    ).toBe("bad_image");

    const declaredJpeg = await h.call("profile.setLogo", {
      dataBase64: PNG.toString("base64"),
      mime: "image/jpeg",
    });
    expect(declaredJpeg.value.logo).toMatch(/^data:image\/png;base64,/);
    const assets = join(h.workspace, "evalua", "assets");
    expect(await readFile(join(assets, "logo.png"))).toEqual(PNG);

    const webp = await h.call("profile.setLogo", {
      dataBase64: WEBP.toString("base64"),
      mime: "image/webp",
    });
    expect(webp.value.logo).toMatch(/^data:image\/webp;base64,/);
    expect(await exists(join(assets, "logo.webp"))).toBe(true);
    expect(await exists(join(assets, "logo.png"))).toBe(false);
    expect(await readFile(join(h.workspace, "evalua", "teacher.yaml"), "utf8")).toContain(
      "logo: assets/logo.webp",
    );
    expect((await h.call("status")).value.logo).toMatch(/^data:image\/webp;base64,/);

    await h.call("profile.removeLogo");
    const status = (await h.call("status")).value;
    expect(status.logo).toBeUndefined();
    expect(status.profile.hasLogo).toBe(false);
  });
});
