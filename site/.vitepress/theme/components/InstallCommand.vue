<script setup lang="ts">
import { useData } from "vitepress";
import { computed, onBeforeUnmount, ref } from "vue";
import { useWidgetId } from "../paths";

const props = withDefaults(
  defineProps<{
    package: string;
    version?: string | null;
    initial?: string;
    compact?: boolean;
  }>(),
  { version: null, initial: "alisio", compact: false },
);

const { lang } = useData();
const text = computed(() =>
  lang.value === "es"
    ? { copy: "Copiar", copied: "Copiado", label: "Copiar comando de instalación" }
    : { copy: "Copy", copied: "Copied", label: "Copy install command" },
);

const MANAGERS = ["alisio", "npm", "pnpm", "bun", "yarn", "deno"] as const;
type Manager = (typeof MANAGERS)[number];

const spec = computed(() => (props.version ? `${props.package}@${props.version}` : props.package));

const commands = computed<Record<Manager, string>>(() => ({
  alisio: `alisio install npm:${spec.value}`,
  npm: `npm install ${spec.value}`,
  pnpm: `pnpm add ${spec.value}`,
  bun: `bun add ${spec.value}`,
  yarn: `yarn add ${spec.value}`,
  deno: `deno add npm:${spec.value}`,
}));

const selected = ref<Manager>(
  MANAGERS.includes(props.initial as Manager) ? (props.initial as Manager) : "alisio",
);
const copied = ref(false);
const widgetId = useWidgetId("install");
const current = computed(() => commands.value[selected.value]);
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy(): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText)
      throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(current.value);
    copied.value = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      copied.value = false;
    }, 1600);
  } catch {
    copied.value = false;
  }
}

function onKeydown(event: KeyboardEvent, index: number): void {
  const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
  if (!keys.includes(event.key)) return;
  event.preventDefault();
  let next = index;
  if (event.key === "ArrowLeft") next = (index - 1 + MANAGERS.length) % MANAGERS.length;
  if (event.key === "ArrowRight") next = (index + 1) % MANAGERS.length;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = MANAGERS.length - 1;
  selected.value = MANAGERS[next];
  const tabs = (event.currentTarget as HTMLElement).parentElement?.children;
  (tabs?.[next] as HTMLElement | undefined)?.focus();
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <div class="install" :class="{ 'install--compact': props.compact }">
    <div v-if="!props.compact" class="install__tabs" role="tablist" aria-label="Install command">
      <button
        v-for="(manager, index) in MANAGERS"
        :id="`${widgetId}-tab-${manager}`"
        :key="manager"
        type="button"
        role="tab"
        class="install__tab"
        :aria-selected="selected === manager"
        :aria-controls="`${widgetId}-panel`"
        :tabindex="selected === manager ? 0 : -1"
        @click="selected = manager"
        @keydown="onKeydown($event, index)"
      >
        {{ manager }}
      </button>
    </div>
    <div
      :id="`${widgetId}-panel`"
      class="install__row"
      role="tabpanel"
      :aria-labelledby="`${widgetId}-tab-${selected}`"
    >
      <code class="install__command">{{ current }}</code>
      <button
        type="button"
        class="install__copy"
        :aria-label="text.label"
        @click="copy"
      >
        {{ copied ? text.copied : text.copy }}
      </button>
    </div>
    <span class="visually-hidden" role="status" aria-live="polite">
      {{ copied ? text.copied : "" }}
    </span>
  </div>
</template>

<style scoped>
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.install--compact .install__row {
  padding: 6px;
}

.install--compact .install__command {
  font-size: 12px;
}

.install--compact .install__copy {
  padding: 6px 10px;
  font-size: 12px;
}
</style>
