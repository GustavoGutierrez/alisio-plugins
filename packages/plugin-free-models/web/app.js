// Free models guide frame: renders the cataloged services (data embedded by the plugin) and a
// modal with the steps to get a free key. No network: links are shown as copyable text.
const STRINGS = {
  en: {
    title: "Free models",
    intro:
      "Kilo Code works right away, with no account and no key. To use another service, pick it in the free-models connection; services that need a free key show the steps here.",
    noKey: "No key needed",
    needsKey: "Free key needed",
    isDefault: "Default",
    limits: "Free limits",
    notes: "Notes",
    models: "Free models",
    howTo: "How to get the free key",
    stepsTitle: (name) => `Get a free ${name} key`,
    close: "Close",
    linkLabel: "Key page (copy it into your browser):",
    copy: "Copy link",
    copied: "Copied",
    hint: "Then paste the key in the Key field of the free-models connection, with this service selected.",
    unavailable: "This page is unavailable. Reload the workspace to try again.",
  },
  es: {
    title: "Modelos gratis",
    intro:
      "Kilo Code funciona de inmediato, sin cuenta ni clave. Para usar otro servicio, elígelo en la conexión free-models; los servicios que necesitan una clave gratuita muestran aquí los pasos.",
    noKey: "Sin clave",
    needsKey: "Requiere clave gratuita",
    isDefault: "Predeterminado",
    limits: "Límites gratuitos",
    notes: "Notas",
    models: "Modelos gratis",
    howTo: "Cómo obtener la clave gratuita",
    stepsTitle: (name) => `Obtén una clave gratuita de ${name}`,
    close: "Cerrar",
    linkLabel: "Página de la clave (cópiala en tu navegador):",
    copy: "Copiar enlace",
    copied: "Copiado",
    hint: "Después pega la clave en el campo Clave de la conexión free-models, con este servicio seleccionado.",
    unavailable:
      "Esta página no está disponible. Recarga el espacio de trabajo para intentarlo de nuevo.",
  },
};

const pickLocale = (value) =>
  typeof value === "string" && /^es\b|^es[-_]/i.test(value) ? "es" : "en";

function readData() {
  try {
    const parsed = JSON.parse(document.getElementById("free-models-data").textContent || "{}");
    return parsed && Array.isArray(parsed.en) && Array.isArray(parsed.es) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const data = readData();
let locale = pickLocale(navigator.language);
let opener;
let current;

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children || []) node.append(child);
  return node;
}

function line(label, value) {
  return el("p", {}, [el("strong", { text: `${label}: ` }), document.createTextNode(value)]);
}

function render() {
  const t = STRINGS[locale];
  document.documentElement.lang = locale;
  document.getElementById("title").textContent = t.title;
  const cards = document.getElementById("cards");
  cards.replaceChildren();
  if (!data) {
    document.getElementById("intro").textContent = t.unavailable;
    return;
  }
  document.getElementById("intro").textContent = t.intro;
  for (const service of data[locale]) {
    const badges = el("div", { class: "badges" }, [
      el("span", {
        class: service.needsKey ? "badge key" : "badge",
        text: service.needsKey ? t.needsKey : t.noKey,
      }),
      ...(service.isDefault ? [el("span", { class: "badge", text: t.isDefault })] : []),
    ]);
    const children = [
      el("h2", { text: service.name }),
      badges,
      line(t.limits, service.limits),
      ...(service.notes ? [line(t.notes, service.notes)] : []),
      line(t.models, service.models.join(", ")),
    ];
    if (service.needsKey) {
      const button = el("button", { type: "button", "data-service": service.id, text: t.howTo });
      button.addEventListener("click", () => openSteps(service.id, button));
      children.push(button);
    }
    cards.append(el("li", { class: "card" }, [el("article", {}, children)]));
  }
  // An open modal stays open in the new language; its opener is the re-rendered card button.
  if (current) {
    fillSteps(current);
    opener = cards.querySelector(`button[data-service="${current}"]`) || opener;
  }
}

function fillSteps(id) {
  const t = STRINGS[locale];
  const service = data?.[locale].find((s) => s.id === id);
  if (!service) return;
  document.getElementById("steps-title").textContent = t.stepsTitle(service.name);
  const close = document.getElementById("steps-close");
  close.textContent = t.close;
  document
    .getElementById("steps-list")
    .replaceChildren(...service.steps.map((step) => el("li", { text: step })));
  document.getElementById("steps-link-label").textContent = t.linkLabel;
  document.getElementById("steps-link").value = service.keyUrl;
  document.getElementById("steps-copy").textContent = t.copy;
  document.getElementById("steps-hint").textContent = t.hint;
}

function openSteps(id, button) {
  const dialog = document.getElementById("steps");
  opener = button;
  current = id;
  fillSteps(id);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  document.getElementById("steps-close").focus();
}

function closeSteps() {
  const dialog = document.getElementById("steps");
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else {
    dialog.removeAttribute("open");
    restoreFocus();
  }
}

function restoreFocus() {
  current = undefined;
  if (opener && document.contains(opener)) opener.focus();
  opener = undefined;
}

async function copyLink() {
  const input = document.getElementById("steps-link");
  const button = document.getElementById("steps-copy");
  let copied = false;
  try {
    await navigator.clipboard.writeText(input.value);
    copied = true;
  } catch {
    input.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
  }
  if (copied) button.textContent = STRINGS[locale].copied;
}

document.getElementById("steps-close").addEventListener("click", closeSteps);
document.getElementById("steps-copy").addEventListener("click", copyLink);
// Native <dialog>: Esc fires `cancel` then `close`; restore focus to the opener either way.
document.getElementById("steps").addEventListener("close", restoreFocus);
document.getElementById("steps").addEventListener("keydown", (event) => {
  // Only the fallback (no showModal) needs this; the native modal handles Esc itself.
  if (event.key === "Escape" && typeof event.currentTarget.showModal !== "function") closeSteps();
});

let hostPort;
window.addEventListener("message", (event) => {
  if (
    hostPort ||
    event.source !== window.parent ||
    event.data?.type !== "alisio.app.connect" ||
    !event.ports?.[0]
  )
    return;
  hostPort = event.ports[0];
  locale = pickLocale(event.data.locale);
  render();
  hostPort.onmessage = ({ data: message }) => {
    if (message?.type === "locale") {
      locale = pickLocale(message.locale);
      render();
    }
  };
  hostPort.start();
});

render();
