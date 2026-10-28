<template>
  <div class="weak-points">
    <div class="page-header">
      <div class="header-left">
        <h2>薄弱知识点</h2>
        <p>按掌握度排序，优先补齐最需要强化的知识点</p>
      </div>
      <el-button type="primary" :disabled="!weakPoints.length" @click="generatePracticePlan">
        一键生成专项补练计划
      </el-button>
    </div>

    <el-card v-if="newRecommendations.length" class="gradient-card recommend-card">
      <template #header>
        <div class="recommend-header">
          <div>
            <div class="recommend-title">老师批改后生成了新的补练推荐</div>
            <div class="recommend-subtitle">以下知识点来自最近一次作业结果，建议优先完成补练。</div>
          </div>
          <el-tag type="danger">新推荐 {{ newRecommendations.length }}</el-tag>
        </div>
      </template>

      <div class="recommend-list">
        <div v-for="item in newRecommendations" :key="item.id" class="recommend-item">
          <div class="recommend-main">
            <div class="recommend-name-row">
              <span class="recommend-name">{{ item.name }}</span>
              <el-tag type="warning" effect="dark">来自最近批改</el-tag>
            </div>
            <div class="recommend-meta">
              <span>错误次数 {{ item.wrongCount }}</span>
              <span>掌握度 {{ item.masteryRate }}%</span>
              <span v-if="item.lastHomeworkAt">作业时间 {{ formatDate(item.lastHomeworkAt) }}</span>
            </div>
          </div>
          <el-button type="danger" @click="startPractice(item)">立即补练</el-button>
        </div>
      </div>
    </el-card>

    <el-card class="gradient-card" v-loading="loading">
      <div class="category-list">
        <div v-for="group in groupedWeakPoints" :key="group.name" class="category-item">
          <div class="category-head" @click="toggleCategory(group.name)">
            <div>
              <div class="category-title">{{ group.name }}</div>
              <div class="category-desc">{{ group.summary }}</div>
            </div>
            <div class="category-head-right">
              <el-tag :type="group.tagType">{{ group.items.length }} 个</el-tag>
              <span class="category-toggle">{{ isCategoryExpanded(group.name) ? '收起' : '展开' }}</span>
            </div>
          </div>

          <div v-show="isCategoryExpanded(group.name)" class="category-content">
            <div v-if="group.items.length" class="kp-list">
              <div v-for="item in group.items" :key="item.id" class="kp-item">
                <div class="kp-main">
                  <div class="kp-name-cell">
                    <span>{{ item.name }}</span>
                    <el-tag v-if="item.hasNewRecommendation" type="danger" size="small">新推荐</el-tag>
                  </div>
                  <div class="kp-meta">
                    <span class="meta-item">掌握度 <b>{{ parseInt(item.masteryRate || 0, 10) }}%</b></span>
                    <span class="meta-item">近五次均分 <b>{{ item.averageScore || 0 }}</b></span>
                    <span class="meta-item">建议学习 <b>{{ item.suggestedStudyTime || 0 }}min</b></span>
                    <span class="meta-item" v-if="item.lastWrongTime">最近答错 {{ formatDate(item.lastWrongTime) }}</span>
                  </div>
                  <el-progress :percentage="parseInt(item.masteryRate || 0, 10)" :color="getProgressColor(item.masteryRate)" :stroke-width="8" />
                </div>
                <div class="kp-side">
                  <div class="status-tags">
                    <el-tag :type="getMasteryTagType(item.masteryRate)" effect="plain">
                      {{ getMasteryLabel(item.masteryRate) }}
                    </el-tag>
                    <el-tag v-if="item.hasNewRecommendation" type="danger" effect="dark">优先处理</el-tag>
                  </div>
                  <el-button :type="item.masteryRate < 60 ? 'danger' : 'primary'" size="small" @click="startPractice(item)">
                    {{ item.masteryRate < 60 ? '专项突破' : '巩固提升' }}
                  </el-button>
                </div>
              </div>
            </div>
            <el-empty v-else description="当前分类暂无薄弱知识点" />
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/utils/api'
import dayjs from 'dayjs'
import { MAJOR_CATEGORY_CONFIG, getMasteryStatus, inferMajorCategory } from '@/utils/knowledge-meta'

var router = useRouter()
var weakPoints = ref([])
var loading = ref(false)
var categoryExpandedMap = ref({})

var newRecommendations = computed(function() {
  return weakPoints.value.filter(function(item) {
    return !!item.hasNewRecommendation && Number(item.wrongCount || 0) > 0
  })
})

var groupedWeakPoints = computed(function() {
  return MAJOR_CATEGORY_CONFIG.map(function(config) {
    var items = weakPoints.value
      .filter(function(item) {
        return getCategoryName(item) === config.name
      })
      // 不需要在这里额外排序，后端已经排好序（红->黄->绿，同级按最近答错时间）

    var weakCount = items.filter(function(item) { return getMasteryStatus(item.masteryRate) === 'weak' }).length
    var summary = items.length
      ? (weakCount ? ('当前有 ' + weakCount + ' 个知识点需要优先突破。') : '当前主要是稳定性巩固。')
      : '该分类下暂时没有薄弱环节。'

    return {
      name: config.name,
      items: items,
      summary: summary,
      tagType: weakCount ? 'danger' : items.length ? 'warning' : 'success'
    }
  })
})

onMounted(function() {
  loadData()
})

function loadData() {
  loading.value = true
  api.get('/student/weak-points')
    .then(function(res) {
      if (res.success) {
        // 后端已经过滤并排序好了，只保留掌握度 < 80 的（即红和黄）
        weakPoints.value = (res.data || []).filter(function(p) { return p.masteryRate < 80 })
        ensureExpandedState()
      }
    })
    .catch(function(error) {
      console.error('加载失败:', error)
    })
    .finally(function() {
      loading.value = false
    })
}

function getMasteryLabel(rate) {
  if (rate < 60) return '急需突破'
  if (rate < 80) return '待巩固'
  return '已掌握'
}

function getMasteryTagType(rate) {
  if (rate < 60) return 'danger'
  if (rate < 80) return 'warning'
  return 'success'
}

function generatePracticePlan() {
  const topN = 3;
  const targetKPs = weakPoints.value.slice(0, topN);
  if (!targetKPs.length) return;

  ElMessageBox.confirm(
    `系统已为你锁定前 ${targetKPs.length} 个最薄弱知识点：\n${targetKPs.map(k => k.name).join('、')}\n是否立即生成专项提分补练计划？`,
    '一键生成计划',
    {
      confirmButtonText: '立即生成',
      cancelButtonText: '取消',
      type: 'info',
    }
  ).then(() => {
    // 模拟生成计划，实际可调用后端接口
    ElMessage.success('提分计划生成成功！正在为你准备习题...');
    setTimeout(() => {
      router.push({ path: '/student/practice', query: { kpId: targetKPs[0].id, plan: 'true' } });
    }, 1000);
  });
}

function getCategoryName(item) {
  return inferMajorCategory(item, '数与式')
}

function ensureExpandedState() {
  var nextMap = Object.assign({}, categoryExpandedMap.value)
  var hasExpanded = false
  groupedWeakPoints.value.forEach(function(group) {
    if (typeof nextMap[group.name] !== 'boolean') nextMap[group.name] = false
    if (nextMap[group.name]) hasExpanded = true
  })
  if (!hasExpanded) {
    var firstWithData = groupedWeakPoints.value.find(function(group) { return group.items.length })
    if (firstWithData) nextMap[firstWithData.name] = true
  }
  categoryExpandedMap.value = nextMap
}

function toggleCategory(name) {
  categoryExpandedMap.value[name] = !categoryExpandedMap.value[name]
}

function isCategoryExpanded(name) {
  return !!categoryExpandedMap.value[name]
}

function getProgressColor(rate) {
  var status = getMasteryStatus(rate)
  if (status === 'mastered') return '#67C23A'
  if (status === 'learning') return '#E6A23C'
  return '#F56C6C'
}

function startPractice(row) {
  router.push({ path: '/student/practice', query: { kpId: row.id } })
}

function formatDate(date) {
  return date ? dayjs(date).format('YYYY-MM-DD HH:mm') : '-'
}
</script>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.header-left h2 {
  margin: 0;
  font-size: 24px;
  color: #111827;
}

.header-left p {
  margin: 4px 0 0;
  color: #6b7280;
  font-size: 14px;
}

.recommend-card {
  margin-bottom: 20px;
}

.recommend-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.recommend-title {
  font-size: 16px;
  font-weight: 700;
}

.recommend-subtitle {
  margin-top: 4px;
  color: #6b7280;
  font-size: 13px;
}

.recommend-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.recommend-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border-radius: 12px;
  background: linear-gradient(135deg, #fff1f0, #fff7e6);
}

.recommend-main {
  flex: 1;
}

.recommend-name-row,
.kp-name-cell,
.status-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.recommend-name {
  font-size: 15px;
  font-weight: 700;
}

.recommend-meta.kp-meta {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 8px;
  color: #6b7280;
  font-size: 13px;
  margin-bottom: 12px;
}

.meta-item b {
  color: #111827;
}

.category-list,
.kp-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.category-item {
  border-radius: 14px;
  border: 1px solid #e5edf8;
  background: linear-gradient(135deg, #ffffff, #f8fbff);
  padding: 14px;
}

.category-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
}

.category-title {
  font-size: 16px;
  font-weight: 700;
  color: #111827;
}

.category-desc {
  margin-top: 6px;
  font-size: 13px;
  color: #6b7280;
}

.category-head-right {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.category-toggle {
  font-size: 12px;
  color: #6b7280;
  font-weight: 700;
}

.category-content {
  margin-top: 12px;
}

.kp-item {
  border-radius: 12px;
  border: 1px solid #e5edf8;
  background: #ffffff;
  padding: 12px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.kp-main {
  flex: 1;
  min-width: 0;
}

.kp-meta {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 6px;
  margin-bottom: 8px;
  color: #6b7280;
  font-size: 13px;
}

.kp-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
</style>
