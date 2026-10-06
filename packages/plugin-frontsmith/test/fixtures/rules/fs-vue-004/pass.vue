<template>
  <ul>
    <li v-for="item in visible" :key="item.id">{{ item.id }}</li>
  </ul>
</template>
