<template>
  <div class="not-found">
    <div class="content">
      <h1>404</h1>
      <p>页面未找到</p>
      <el-button type="primary" @click="$router.push('/')">返回首页</el-button>
    </div>
  </div>
</template>

<script setup>
</script>

<style scoped>
.not-found {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #E6F0FF 0%, #FFFFFF 100%);
}

.content {
  text-align: center;
}

h1 {
  font-size: 120px;
  color: #409EFF;
  margin: 0;
  line-height: 1;
}

p {
  font-size: 24px;
  color: #606266;
  margin: 20px 0 40px;
}
</style>
