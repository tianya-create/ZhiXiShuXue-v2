<template>
  <div class="admin-dashboard">
    <!-- 页面头部 -->
    <header class="page-header">
      <div class="header-content">
        <div class="header-text">
          <h2>管理后台</h2>
          <p>系统数据概览 · 实时掌握平台运行状态</p>
        </div>
      </div>
    </header>

    <!-- 统计卡片 -->
    <section class="stats-grid">
      <div class="stat-card is-gradient" style="background: linear-gradient(135deg, #6366F1, #8B5CF6);">
        <div class="stat-icon">
          <el-icon :size="22"><User /></el-icon>
        </div>
        <div class="stat-value">{{ stats.userCount }}</div>
        <div class="stat-label">用户总数</div>
      </div>

      <div class="stat-card">
        <div class="stat-icon" style="background: var(--info-bg); color: var(--info-color);">
          <el-icon :size="22"><Document /></el-icon>
        </div>
        <div class="stat-value">{{ stats.paperCount }}</div>
        <div class="stat-label">试卷总数</div>
      </div>

      <div class="stat-card">
        <div class="stat-icon" style="background: var(--warning-bg); color: var(--warning-color);">
          <el-icon :size="22"><Edit /></el-icon>
        </div>
        <div class="stat-value">{{ stats.questionCount }}</div>
        <div class="stat-label">题目总数</div>
      </div>

      <div class="stat-card">
        <div class="stat-icon" style="background: var(--success-bg); color: var(--success-color);">
          <el-icon :size="22"><TrendCharts /></el-icon>
        </div>
        <div class="stat-value">{{ stats.answerCount }}</div>
        <div class="stat-label">答题记录</div>
      </div>
    </section>

    <!-- 主内容区 -->
    <div class="dashboard-layout">
      <!-- 用户分布图表 -->
      <el-card class="panel-card">
        <template #header>
          <div class="section-header">
            <div>
              <div class="section-title">用户分布</div>
              <div class="section-desc">平台用户组成结构</div>
            </div>
          </div>
        </template>
        <div id="userChart" class="chart-container"></div>
      </el-card>

      <!-- 最近操作日志 -->
      <el-card class="panel-card">
        <template #header>
          <div class="section-header">
            <div>
              <div class="section-title">最近操作日志</div>
              <div class="section-desc">最新系统操作记录</div>
            </div>
          </div>
        </template>
        <el-table :data="recentLogs" max-height="320" class="log-table">
          <el-table-column prop="action" label="操作" />
          <el-table-column prop="timestamp" label="时间" width="180">
            <template #default="scope">
              {{ formatDate(scope.row.timestamp) }}
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, nextTick, onBeforeUnmount } from 'vue'
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
  window.addEventListener('resize', renderChart)
})

onBeforeUnmount(function() {
  window.removeEventListener('resize', renderChart)
  if (chart) chart.dispose()
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
      radius: ['50%', '75%'],
      label: { color: '#78716C', fontSize: 13, fontWeight: 500 },
      data: [
        { value: stats.teacherCount, name: '教师', itemStyle: { color: '#6366F1' } },
        { value: stats.studentCount, name: '学生', itemStyle: { color: '#10B981' } },
        { value: stats.userCount - stats.teacherCount - stats.studentCount, name: '管理员', itemStyle: { color: '#F59E0B' } }
      ]
    }]
  })
}

function formatDate(date) {
  return date ? dayjs(date).format('YYYY-MM-DD HH:mm') : '-'
}
</script>

<style scoped>
.admin-dashboard {
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* === 页面头部 === */
.page-header {
  background: var(--surface-overlay);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-radius: var(--radius-xl);
  padding: 32px 36px;
  border: 1px solid hsla(0, 0%, 100%, 0.9);
  box-shadow: var(--shadow-md);
  position: relative;
  overflow: hidden;
  animation: slideUp var(--duration-slow) var(--ease-spring);
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}

.page-header::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 3px;
  background: var(--brand-gradient);
}

.page-header::after {
  content: '';
  position: absolute;
  top: 0; right: 0;
  width: 300px;
  height: 100%;
  background: radial-gradient(ellipse at top right, hsla(var(--brand-hue), 84%, 68%, 0.06) 0%, transparent 70%);
  pointer-events: none;
}

.header-content {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 32px;
  position: relative;
  z-index: 1;
}

.header-text h2 {
  font-family: 'Noto Serif SC', serif;
  font-size: 26px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
  letter-spacing: 0.02em;
}

.header-text p {
  margin: 12px 0 0;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
}

/* === 统计卡片网格 === */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20px;
}

.stat-card {
  padding: 24px;
  border-radius: var(--radius-xl);
  background: var(--surface-raised);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-sm);
  transition: all var(--duration-normal) var(--ease-spring);
  position: relative;
  overflow: hidden;
  animation: cardEnter var(--duration-slow) var(--ease-spring) backwards;
}
.stat-card:nth-child(1) { animation-delay: 0.05s; }
.stat-card:nth-child(2) { animation-delay: 0.1s; }
.stat-card:nth-child(3) { animation-delay: 0.15s; }
.stat-card:nth-child(4) { animation-delay: 0.2s; }

@keyframes cardEnter {
  from { opacity: 0; transform: translateY(16px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.stat-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0;
  width: 4px;
  height: 100%;
  background: var(--brand-gradient);
  opacity: 0;
  transition: opacity var(--duration-normal);
}

.stat-card::after {
  content: '';
  position: absolute;
  top: 0; right: 0;
  width: 100px;
  height: 100px;
  background: radial-gradient(circle at top right, hsla(var(--brand-hue), 84%, 68%, 0.04) 0%, transparent 70%);
  pointer-events: none;
}

.stat-card:hover {
  transform: translateY(-6px);
  box-shadow: var(--shadow-lg);
  border-color: hsla(var(--brand-hue), 84%, 68%, 0.2);
}
.stat-card:hover::before { opacity: 1; }

.stat-card .stat-icon {
  width: 48px;
  height: 48px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--primary-50);
  color: var(--primary-500);
  margin-bottom: 18px;
  transition: all var(--duration-normal) var(--ease-spring);
}
.stat-card:hover .stat-icon { transform: scale(1.1) rotate(-5deg); }

.stat-card .stat-value {
  font-size: 36px;
  font-weight: 800;
  color: var(--text-primary);
  font-family: 'Noto Serif SC', serif;
  line-height: 1.1;
  letter-spacing: -0.02em;
}

.stat-card .stat-label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 8px;
  font-weight: 600;
}

.stat-card.is-gradient {
  background: var(--brand-gradient);
  border: none;
}
.stat-card.is-gradient .stat-icon { background: hsla(0, 0%, 100%, 0.2); color: white; }
.stat-card.is-gradient .stat-value, .stat-card.is-gradient .stat-label { color: white; }
.stat-card.is-gradient::before { opacity: 1; }

/* === 主内容布局 === */
.dashboard-layout {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  animation: slideUp var(--duration-slow) var(--ease-spring);
  animation-delay: 0.1s;
  animation-fill-mode: backwards;
}

/* === 面板卡片 === */
.panel-card {
  border-radius: var(--radius-xl) !important;
  border: 1px solid var(--border-subtle) !important;
  box-shadow: var(--shadow-sm) !important;
  transition: all var(--duration-normal) var(--ease-spring) !important;
  background: var(--surface-raised);
}
.panel-card:hover { box-shadow: var(--shadow-lg) !important; transform: translateY(-2px); }

.section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 0;
}

.section-title {
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 0.01em;
}

.section-desc {
  margin-top: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
  font-weight: 500;
}

.chart-container { height: 320px; }

/* === 响应式 === */
@media (max-width: 1200px) { .dashboard-layout { grid-template-columns: 1fr; } }
@media (max-width: 1024px) { .stats-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 768px) { .stats-grid { grid-template-columns: 1fr; } }
</style>
