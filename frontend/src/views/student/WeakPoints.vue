<template>
  <div class="weak-points">
    <div class="page-header">
      <h2>薄弱知识点</h2>
      <p>需要重点加强的知识点</p>
    </div>
    
    <el-card class="gradient-card">
      <el-table :data="weakPoints" style="width: 100%">
        <el-table-column prop="name" label="知识点" />
        <el-table-column prop="wrongCount" label="错误次数" width="100" />
        <el-table-column prop="masteryRate" label="掌握度" width="120">
          <template #default="scope">
            <el-progress :percentage="parseInt(scope.row.masteryRate)" :color="getProgressColor(scope.row.masteryRate)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="scope">
            <el-button type="primary" size="small" @click="startPractice(scope.row)">
              开始补练
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/utils/api'

var router = useRouter()
var weakPoints = ref([])

onMounted(function() {
  loadData()
})

function loadData() {
  api.get('/student/weak-points')
    .then(function(res) {
      if (res.success) {
        weakPoints.value = res.data
      }
    })
    .catch(function(error) {
      console.error('加载失败:', error)
    })
}

function getProgressColor(rate) {
  var num = parseInt(rate)
  if (num >= 80) return '#67C23A'
  if (num >= 60) return '#E6A23C'
  return '#F56C6C'
}

function startPractice(row) {
  router.push('/student/practice?kpId=' + row.id)
}
</script>
