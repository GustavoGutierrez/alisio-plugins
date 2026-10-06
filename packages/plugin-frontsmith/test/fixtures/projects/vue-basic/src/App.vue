<script setup>
import { ref } from "vue";
const count = ref(0);
</script>

<template>
  <button type="button" @click="count++">Clicked {{ count }}</button>
</template>

<style lang="scss">
button { color: red; }
</style>
