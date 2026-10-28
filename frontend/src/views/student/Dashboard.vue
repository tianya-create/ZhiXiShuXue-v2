<template>
  <div class="student-dashboard">
    <div class="page-header">
      <h2>学习中心</h2>
      <p>今天是 {{ currentDate }}，继续努力学习吧！</p>
    </div>
    
    <el-row :gutter="20" class="stat-cards">
      <el-col :span="6">
        <div class="stat-card" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
          <el-icon :size="32"><Document /></el-icon>
          <div class="stat-value">{{ stats.pendingAssignments }}</div>
          <div class="stat-label">待完成作业</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card" style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);">
          <el-icon :size="32"><Edit /></el-icon>
          <div class="stat-value">{{ stats.completedAssignments }}</div>
          <div class="stat-label">已完成作业</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card" style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);">
          <el-icon :size="32"><TrendCharts /></el-icon>
          <div class="stat-value">{{ stats.avgScore }}%</div>
          <div class="stat-label">平均正确率</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card" style="background: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);">
          <el-icon :size="32"><Warning /></el-icon>
          <div class="stat-value">{{ stats.weakPoints }}</div>
          <div class="stat-label">薄弱知识点</div>
        </div>
      </el-col>
    </el-row>
    
    <el-row :gutter="20" style="margin-top: 20px;">
      <el-col :span="16">
        <el-card class="gradient-card">
          <template #header>
            <div class="card-header">
              <span>待完成作业</span>
              <el-button type="primary" text @click="goToAssignments">
                查看全部
              </el-button>
            </div>
          </template>
          <el-table :data="pendingAssignments" style="width: 100%">
            <el-table-column prop="title" label="作业名称" />
            <el-table-column prop="paperTitle" label="试卷" width="150" />
            <el-table-column prop="questionCount" label="题目数" width="80" />
            <el-table-column prop="deadline" label="截止时间" width="180">
              <template #default="scope">
                {{ formatDate(scope.row.deadline) }}
              </template>
            </el-table-column>
            <el-table-column label="操作" width="100">
              <template #default="scope">
                <el-button type="primary" size="small" @click="startAssignment(scope.row)">
                  开始答题
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
      
      <el-col :span="8">
        <el-card class="gradient-card">
          <template #header>知识掌握概览</template>
          <div id="knowledgeChart" style="height: 250px;"></div>
        </el-card>
        
        <el-card class="gradient-card" style="margin-top: 20px;">
          <template #header>快捷入口</template>
          <div class="quick-actions">
            <el-button type="primary" @click="goToKnowledge">
              知识图谱
            </el-button>
            <el-button type="warning" @click="goToWeakPoints">
              薄弱点
            </el-button>
            <el-button type="danger" @click="goToWrongQuestions">
              错题本
            </el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/utils/api'
import * as echarts from 'echarts'
import dayjs from 'dayjs'

var router = useRouter()
var currentDate = computed(function() {
  return dayjs().format('YYYY年MM月DD日 dddd')
})

var stats = reactive({
  pendingAssignments: 0,
  completedAssignments: 0,
  avgScore: 0,
  weakPoints: 0
})

var pendingAssignments = ref([])
var chart = null

onMounted(function() {
  loadData()
})

function goToAssignments() {
  router.push('/student/assignments')
}

function goToKnowledge() {
  router.push('/student/knowledge')
}

function goToWeakPoints() {
  router.push('/student/weak-points')
}

function goToWrongQuestions() {
  router.push('/student/wrong-questions')
}

function loadData() {
  api.get('/student/assignments', { status: 'pending' }).then(function(res) {
    if (res.success) {
      pendingAssignments.value = res.data.slice(0, 5)
      
      var pending = 0
      var completed = 0
      for (var i = 0; i < res.data.length; i++) {
        if (res.data[i].submitted) {
          completed++
        } else {
          pending++
        }
      }
      stats.pendingAssignments = pending
      stats.completedAssignments = completed
    }
    
    // 模拟数据
    stats.avgScore = 76
    stats.weakPoints = 3
    
    return nextTick()
  }).then(function() {
    renderChart()
  }).catch(function(error) {
    console.error('加载数据失败:', error)
  })
}

function renderChart() {
  var chartDom = document.getElementById('knowledgeChart')
  if (!chartDom) return
  
  if (chart) chart.dispose()
  chart = echarts.init(chartDom)
  
  chart.setOption({
    tooltip: { trigger: 'item' },
    series: [{
      name: '掌握情况',
      type: 'pie',
      radius: ['50%', '70%'],
      data: [
        { value: 60, name: '已掌握', itemStyle: { color: '#67C23A' } },
        { value: 25, name: '学习中', itemStyle: { color: '#E6A23C' } },
        { value: 15, name: '薄弱', itemStyle: { color: '#F56C6C' } }
      ]
    }]
  })
}

function startAssignment(row) {
  router.push('/student/assignment/' + row.id)
}

function formatDate(date) {
  return date ? dayjs(date).format('YYYY-MM-DD HH:mm') : '未设置'
}
</script>

<style scoped>
.quick-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.quick-actions .el-button {
  width: 100%;
}
</style>
