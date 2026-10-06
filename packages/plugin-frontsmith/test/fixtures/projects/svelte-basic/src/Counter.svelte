<script lang="ts">
  export let start: number = 0;
  let count = start;
</script>

<button on:click={() => (count += 1)}>{count}</button>

<style>
  button { color: blue; }
</style>
