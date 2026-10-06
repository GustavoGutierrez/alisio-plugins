<template>
  <ul>
    <li v-for="item in items" v-if="item.on" :key="item.id">{{ item.id }}</li>
  </ul>
</template>
