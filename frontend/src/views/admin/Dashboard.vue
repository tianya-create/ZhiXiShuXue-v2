<template>
  <div class="admin-dashboard">
    <div class="page-header">
      <h2>管理后台</h2>
      <p>系统数据概览</p>
    </div>
    
    <el-row :gutter="20" class="stat-cards">
      <el-col :span="6">
        <div class="stat-card" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
          <el-icon :size="32"><User /></el-icon>
          <div class="stat-value">{{ stats.userCount }}</div>
          <div class="stat-label">用户总数</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card" style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);">
          <el-icon :size="32"><Document /></el-icon>
          <div class="stat-value">{{ stats.paperCount }}</div>
          <div class="stat-label">试卷总数</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card" style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);">
          <el-icon :size="32"><Edit /></el-icon>
          <div class="stat-value">{{ stats.questionCount }}</div>
          <div class="stat-label">题目总数</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card" style="background: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);">
          <el-icon :size="32"><TrendCharts /></el-icon>
          <div class="stat-value">{{ stats.answerCount }}</div>
          <div class="stat-label">答题记录</div>
        </div>
      </el-col>
    </el-row>
    
    <el-row :gutter="20" style="margin-top: 20px;">
      <el-col :span="12">
        <el-card class="gradient-card">
          <template #header>用户分布</template>
          <div id="userChart" style="height: 300px;"></div>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card class="gradient-card">
          <template #header>最近操作日志</template>
          <el-table :data="recentLogs" max-height="300">
            <el-table-column prop="action" label="操作" />
            <el-table-column prop="timestamp" label="时间" width="180">
              <template #default="scope">
                {{ formatDate(scope.row.timestamp) }}
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, nextTick } from 'vue'
import api from '@/utils/api'
import * as echarts from 'echarts'
import dayjs from 'dayjs'

var stats = reactive({
  userCount: 0,
  teacherCount: 0,
  studentCount: 0,
  classCount: 0,
  paperCount: 0,
  questionCount: 0,
  answerCount: 0
})

var recentLogs = ref([])
var chart = null

onMounted(function() {
  loadStats()
})

function loadStats() {
  api.get('/admin/statistics/overview').then(function(res) {
    if (res.success) {
      stats.userCount = res.data.userCount || 0
      stats.teacherCount = res.data.teacherCount || 0
      stats.studentCount = res.data.studentCount || 0
      stats.classCount = res.data.classCount || 0
      stats.paperCount = res.data.paperCount || 0
      stats.questionCount = res.data.questionCount || 0
      stats.answerCount = res.data.answerCount || 0
    }
    return loadLogs()
  }).then(function() {
    return nextTick()
  }).then(function() {
    renderChart()
  }).catch(function(error) {
    console.error('加载统计失败:', error)
  })
}

function loadLogs() {
  return api.get('/admin/logs', { pageSize: 10 }).then(function(res) {
    if (res.success && res.data && res.data.data) {
      recentLogs.value = res.data.data
    }
  }).catch(function(error) {
    console.error('加载日志失败:', error)
  })
}

function renderChart() {
  var chartDom = document.getElementById('userChart')
  if (!chartDom) return
  
  if (chart) chart.dispose()
  chart = echarts.init(chartDom)
  
  chart.setOption({
    tooltip: { trigger: 'item' },
    series: [{
      name: '用户分布',
      type: 'pie',
      radius: ['40%', '70%'],
      data: [
        { value: stats.teacherCount, name: '教师', itemStyle: { color: '#409EFF' } },
        { value: stats.studentCount, name: '学生', itemStyle: { color: '#67C23A' } },
        { value: stats.userCount - stats.teacherCount - stats.studentCount, name: '管理员', itemStyle: { color: '#E6A23C' } }
      ]
    }]
  })
}

function formatDate(date) {
  return date ? dayjs(date).format('YYYY-MM-DD HH:mm:ss') : '-'
}
</script>
