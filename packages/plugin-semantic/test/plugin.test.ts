import { afterEach, describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import { resolveLocale } from "../src/messages.js";
import { VERSION } from "../src/version.js";
import { type Harness, harness } from "./harness.js";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.cleanup();
});
async function start(...args: Parameters<typeof harness>) {
  const h = await harness(...args);
  open.push(h);
  return h;
}

describe("plugin entry", () => {
  it("declares its manifest", () => {
    expect(plugin).toMatchObject({ id: "semantic", apiVersion: 1, version: VERSION });
    expect(plugin.categories).toEqual(["search", "storage"]);
  });

  it("loads on a host without api.semantic, registers no provider and says keyword-only (SEM-AC-01)", async () => {
    const h = await start({ semantic: "absent" });
    expect(h.embeddings).toEqual([]);
    expect(h.stores).toEqual([]);
    const status = await h.commands.get("status")?.("");
    expect(status).toMatch(/keyword search only/i);
    expect(status).toMatch(/0\.11\.7/);
    expect([...h.commands.keys()].sort()).toEqual(["help", "setup", "status"]);
  });

  it("registers the embedding and store providers without activating them", async () => {
    let activations = 0;
    const h = await start({
      semantic: {
        activate: async () => {
          activations++;
          return { status: "activated" };
        },
      },
    });
    expect(h.embeddings.map((p) => p.id)).toEqual(["semantic.e5"]);
    expect(h.stores.map((p) => p.id)).toEqual(["semantic.lance"]);
    expect(h.embeddings[0]?.dimensions()).toBe(384);
    expect(activations).toBe(0);
    const status = await h.commands.get("status")?.("");
    expect(status).toMatch(/not downloaded/i);
    expect(status).toMatch(/keyword search only/i);
  });

  it("fails setup with unknown_model for a model outside the table and registers no embedder", async () => {
    const h = await start({ options: { model: "someone/else" } });
    expect(h.embeddings).toEqual([]);
    expect(await h.commands.get("setup")?.("")).toMatch(/unknown_model/);
  });

  it("explains the minimum host in help when api.apps is missing", async () => {
    const h = await start({ apps: false });
    expect(await h.commands.get("help")?.("")).toMatch(/0\.11\.7/);
    expect(h.apps).toEqual([]);
  });

  it("words commands in the host language: options.locale, else the host process locale, else English", async () => {
    const es = await start({ semantic: "absent", options: { locale: "es" } });
    const status = (await es.commands.get("status")?.("")) ?? "";
    expect(status).toMatch(/solo con búsqueda por palabras clave/);
    expect(status).not.toMatch(/keyword search only|Notebooks|Disk use/);
    expect(await es.commands.get("help")?.("")).toMatch(/^Abre Cuaderno/);
    expect(await es.commands.get("help")?.("")).toContain("El asistente puede cometer errores");
    expect(resolveLocale(undefined, { LANG: "es_CO.UTF-8" })).toBe("es");
    expect(resolveLocale(undefined, { LC_ALL: "es", LANG: "en_US.UTF-8" })).toBe("es");
    expect(resolveLocale(undefined, { LANG: "fr_FR.UTF-8" })).toBe("en");
    expect(resolveLocale("en", { LANG: "es_ES" })).toBe("en");
    expect(resolveLocale(undefined, {})).toBe("en");
    const unknown = await start({ options: { model: "x", locale: "es" } });
    expect(await unknown.commands.get("setup")?.("")).toMatch(/unknown_model/);
    expect(await unknown.commands.get("setup")?.("")).toMatch(/^La preparación falló/);
  });

  it("disposes twice without throwing", async () => {
    const h = await start();
    await plugin.dispose?.();
    await expect(Promise.resolve(plugin.dispose?.())).resolves.toBeUndefined();
    // An activation whose app is still registered is not torn down by a context-free dispose.
    expect(h.apps).toHaveLength(1);
    await h.close();
    expect(h.commands.size).toBe(0);
    expect(h.apps).toHaveLength(0);
  });
});
