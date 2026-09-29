import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import "./styles/vars.css";
import "./styles/catalog.css";
import InstallCommand from "./components/InstallCommand.vue";
import PluginBadges from "./components/PluginBadges.vue";
import PluginCard from "./components/PluginCard.vue";
import PluginCatalog from "./components/PluginCatalog.vue";
import PluginCover from "./components/PluginCover.vue";
import PluginDetail from "./components/PluginDetail.vue";
import RecentlyPublished from "./components/RecentlyPublished.vue";
import RelativeTime from "./components/RelativeTime.vue";

/**
 * Extends the VitePress default theme (same as Alisio) with catalog components.
 * Registering them globally lets the generated markdown pages use plain tags
 * such as `<PluginDetail slug="wayfinder" />`.
 */
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("InstallCommand", InstallCommand);
    app.component("PluginBadges", PluginBadges);
    app.component("PluginCard", PluginCard);
    app.component("PluginCatalog", PluginCatalog);
    app.component("PluginCover", PluginCover);
    app.component("PluginDetail", PluginDetail);
    app.component("RecentlyPublished", RecentlyPublished);
    app.component("RelativeTime", RelativeTime);
  },
} satisfies Theme;
