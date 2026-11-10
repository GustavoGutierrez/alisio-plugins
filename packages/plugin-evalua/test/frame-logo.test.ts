import { afterAll, describe, expect, it } from "vitest";
import { frameEnv, type Reply, statusWith } from "./helpers/frame-env.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("first-run logo", () => {
  let env: Awaited<ReturnType<typeof frameEnv>>;
  afterAll(() => env?.close());

  it("offers the logo picker before a profile exists and uploads it right after saving", async () => {
    env = await frameEnv("en");
    const { window, doc, requests, wait, click } = env;
    let saved = false;
    let failLogo = false;
    env.setResponder((request): Reply => {
      switch (request.action) {
        case "status":
          return { value: saved ? statusWith() : { ...statusWith(), profile: undefined } };
        case "profile.save":
          saved = true;
          return { value: { profile: {}, revision: "r2" } };
        case "profile.setLogo":
          return failLogo ? { error: "bad_image" } : { value: { logo: "", revision: "r3" } };
        default:
          return { value: null };
      }
    });
    env.connect(env.host, window.parent, "en");
    await env.loaded;
    await wait(() => !!doc.querySelector("#teacherName"));

    // The picker is there on the very first form.
    expect(doc.querySelector('[data-action="choose-logo"]')).not.toBeNull();

    const choose = (file: File) => {
      const input = doc.querySelector("#logo-input") as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    };
    (doc.querySelector("#teacherName") as HTMLInputElement).value = "Ana";
    (doc.querySelector("#institution") as HTMLInputElement).value = "Demo";

    // A file that fails the frame's own check never becomes pending.
    choose(new window.File([PNG], "logo.gif", { type: "image/gif" }));
    await wait(() => (doc.querySelector("#toast")?.textContent ?? "") !== "");
    expect(doc.querySelector(".logo-preview")).toBeNull();

    // A valid file waits in memory with a local preview, and can be removed before saving.
    choose(new window.File([PNG], "logo.png", { type: "image/png" }));
    await wait(() => !!doc.querySelector(".logo-preview"));
    expect(doc.querySelector(".logo-preview")?.getAttribute("src")).toMatch(
      /^data:image\/png;base64,/,
    );
    expect((doc.querySelector("#teacherName") as HTMLInputElement).value).toBe("Ana");
    expect(requests.some((r) => r.action === "profile.setLogo")).toBe(false);
    click('[data-action="remove-logo"]');
    await wait(() => !doc.querySelector(".logo-preview"));
    expect(requests.some((r) => r.action === "profile.removeLogo")).toBe(false);

    choose(new window.File([PNG], "logo.png", { type: "image/png" }));
    await wait(() => !!doc.querySelector(".logo-preview"));
    // The upload after saving fails: the profile stays saved and the error is shown.
    failLogo = true;
    click("#save-profile");
    await wait(() => requests.some((r) => r.action === "profile.setLogo"));
    const order = requests.map((r) => r.action).filter((a) => a.startsWith("profile."));
    expect(order).toEqual(["profile.save", "profile.setLogo"]);
    const upload = requests.find((r) => r.action === "profile.setLogo");
    expect(upload?.input).toMatchObject({
      dataBase64: Buffer.from(PNG).toString("base64"),
      mime: "image/png",
    });
    await wait(() => (doc.querySelector("#toast")?.textContent ?? "").includes("image"));
    await wait(() => requests.filter((r) => r.action === "status").length >= 3);
    expect(saved).toBe(true);
  }, 30_000);
});
