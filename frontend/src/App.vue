<template>
  <!-- 固定背景 - 始终覆盖视口，页面切换时不出现空白 -->
  <div class="app-background" aria-hidden="true"></div>
  <router-view />
</template>

<script setup>
</script>

<style>
.app-background {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--surface-base);
  z-index: -1;
  pointer-events: none;
}
</style>
