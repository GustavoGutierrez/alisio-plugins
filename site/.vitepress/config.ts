import { type DefaultTheme, defineConfig } from "vitepress";
import catalog from "./data/plugins.json";

const repo = "https://github.com/GustavoGutierrez/alisio-plugins";

/** Plugins rendered in the sidebar from the committed catalog cache. */
const pluginItems = (prefix: string): DefaultTheme.SidebarItem[] =>
  catalog.plugins.map((entry) => ({
    text: entry.title,
    link: `${prefix}/plugins/${entry.slug}`,
  }));

/** Build a sidebar from a label map so both locales stay structurally identical. */
function sidebar(prefix: string, labels: Record<string, string>): DefaultTheme.SidebarItem[] {
  return [
    {
      text: labels.groupCatalog ?? "Catalog",
      items: [
        { text: labels.catalogHome ?? "Catalog home", link: `${prefix}/` },
        { text: labels.pluginIndex ?? "Plugin index", link: `${prefix}/plugins/` },
      ],
    },
    {
      text: labels.groupPlugins ?? "Plugins",
      items: pluginItems(prefix),
    },
    {
      text: labels.groupGuide ?? "Guide",
      items: [
        { text: labels.developing ?? "Developing plugins", link: `${prefix}/developing-plugins` },
      ],
    },
  ];
}

const searchTranslations = {
  en: {
    button: { buttonText: "Search", buttonAriaLabel: "Search" },
    modal: {
      displayDetails: "Display detailed list",
      resetButtonTitle: "Reset search",
      backButtonTitle: "Close search",
      noResultsText: "No results for",
      footer: {
        selectText: "to select",
        selectKeyAriaLabel: "Enter",
        navigateText: "to navigate",
        navigateUpKeyAriaLabel: "Arrow up",
        navigateDownKeyAriaLabel: "Arrow down",
        closeText: "to close",
        closeKeyAriaLabel: "Escape",
      },
    },
  },
  es: {
    button: { buttonText: "Buscar", buttonAriaLabel: "Buscar" },
    modal: {
      displayDetails: "Mostrar lista detallada",
      resetButtonTitle: "Restablecer búsqueda",
      backButtonTitle: "Cerrar búsqueda",
      noResultsText: "No hay resultados para",
      footer: {
        selectText: "seleccionar",
        selectKeyAriaLabel: "Intro",
        navigateText: "navegar",
        navigateUpKeyAriaLabel: "Flecha arriba",
        navigateDownKeyAriaLabel: "Flecha abajo",
        closeText: "cerrar",
        closeKeyAriaLabel: "Escape",
      },
    },
  },
};

const en = {
  groupCatalog: "Catalog",
  groupPlugins: "Plugins",
  groupGuide: "Guide",
  catalogHome: "Catalog home",
  pluginIndex: "Plugin index",
  developing: "Developing plugins",
};

const es = {
  groupCatalog: "Catálogo",
  groupPlugins: "Plugins",
  groupGuide: "Guía",
  catalogHome: "Inicio del catálogo",
  pluginIndex: "Índice de plugins",
  developing: "Desarrollar plugins",
};

export default defineConfig({
  base: "/alisio-plugins/",
  title: "Alisio Plugins",
  description: "The catalog of independently installable @alisio/plugin-* packages for Alisio.",
  cleanUrls: true,
  lastUpdated: true,
  head: [["link", { rel: "icon", href: "/alisio-plugins/assets/favicon.png" }]],
  sitemap: { hostname: "https://gustavogutierrez.github.io/alisio-plugins/" },
  srcExclude: ["README.md", "README.es.md"],
  themeConfig: {
    logo: "/assets/logo.png",
    socialLinks: [{ icon: "github", link: repo }],
    footer: {
      message:
        "Released under the MIT License. Maintainer: Gustavo Gutiérrez. Brand assets come from the Alisio documentation site (MIT).",
      copyright: "Copyright © Alisio contributors",
    },
    search: {
      provider: "local",
      options: {
        locales: {
          en: { translations: searchTranslations.en },
          es: { translations: searchTranslations.es },
        },
      },
    },
  },
  locales: {
    root: {
      label: "English",
      lang: "en",
      themeConfig: {
        nav: [
          { text: "Catalog", link: "/" },
          { text: "Plugins", link: "/plugins/" },
          { text: "Developing plugins", link: "/developing-plugins" },
        ],
        sidebar: sidebar("", en),
        editLink: { pattern: `${repo}/edit/main/site/:path`, text: "Edit this page on GitHub" },
        docFooter: { prev: "Previous page", next: "Next page" },
        outline: { label: "On this page" },
        lastUpdated: { text: "Last updated" },
        returnToTopLabel: "Return to top",
        sidebarMenuLabel: "Menu",
        darkModeSwitchLabel: "Appearance",
        lightModeSwitchTitle: "Switch to light theme",
        darkModeSwitchTitle: "Switch to dark theme",
        langMenuLabel: "Change language",
        notFound: {
          title: "PAGE NOT FOUND",
          quote: "The page you are looking for does not exist.",
          linkText: "Go to the catalog",
        },
      },
    },
    es: {
      label: "Español",
      lang: "es",
      link: "/es/",
      description:
        "El catálogo de paquetes @alisio/plugin-* instalables de forma independiente para Alisio.",
      themeConfig: {
        nav: [
          { text: "Catálogo", link: "/es/" },
          { text: "Plugins", link: "/es/plugins/" },
          { text: "Desarrollar plugins", link: "/es/developing-plugins" },
        ],
        sidebar: sidebar("/es", es),
        editLink: { pattern: `${repo}/edit/main/site/:path`, text: "Editar esta página en GitHub" },
        docFooter: { prev: "Página anterior", next: "Página siguiente" },
        outline: { label: "En esta página" },
        lastUpdated: { text: "Última actualización" },
        returnToTopLabel: "Volver arriba",
        sidebarMenuLabel: "Menú",
        darkModeSwitchLabel: "Apariencia",
        lightModeSwitchTitle: "Cambiar a modo claro",
        darkModeSwitchTitle: "Cambiar a modo oscuro",
        langMenuLabel: "Cambiar idioma",
        notFound: {
          title: "PÁGINA NO ENCONTRADA",
          quote: "La página que busca no existe.",
          linkText: "Ir al catálogo",
        },
      },
    },
  },
});
