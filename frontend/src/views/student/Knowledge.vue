<template>
  <div class="knowledge-graph">
    <div class="page-header">
      <h2>知识图谱</h2>
      <p>查看您的知识点掌握情况</p>
    </div>
    
    <el-card class="gradient-card">
      <template #header>
        <span>知识点掌握状态</span>
      </template>
      
      <div class="knowledge-container">
        <div v-for="kp in knowledgePoints" :key="kp.id" class="knowledge-category">
          <h3>{{ kp.name }}</h3>
          <div class="knowledge-nodes">
            <div
              v-for="child in kp.children"
              :key="child.id"
              :class="['knowledge-node', getMasteryClass(child.masteryRate)]"
              @click="viewDetail(child)"
            >
              {{ child.name }}
              <span class="mastery-rate">{{ child.masteryRate }}%</span>
            </div>
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/utils/api'

var router = useRouter()
var knowledgePoints = ref([])

onMounted(function() {
  loadKnowledge()
})

function loadKnowledge() {
  api.get('/student/knowledge-graph')
    .then(function(res) {
      if (res.success) {
        var result = []
        for (var i = 0; i < res.data.length; i++) {
          if (!res.data[i].parentId) {
            result.push(res.data[i])
          }
        }
        knowledgePoints.value = result
      }
    })
    .catch(function(error) {
      console.error('加载失败:', error)
    })
}

function getMasteryClass(rate) {
  if (rate >= 80) return 'mastered'
  if (rate >= 60) return 'learning'
  return 'weak'
}

function viewDetail(kp) {
  router.push('/student/practice?kpId=' + kp.id)
}
</script>

<style scoped>
.knowledge-container {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.knowledge-category h3 {
  margin-bottom: 16px;
  color: var(--text-primary);
}

.knowledge-nodes {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.knowledge-node {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 20px;
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.3s;
}

.knowledge-node.mastered {
  background: linear-gradient(135deg, #67C23A, #85CE61);
  color: white;
}

.knowledge-node.learning {
  background: linear-gradient(135deg, #E6A23C, #F3D19E);
  color: white;
}

.knowledge-node.weak {
  background: linear-gradient(135deg, #F56C6C, #FAACA8);
  color: white;
}

.knowledge-node:hover {
  transform: translateY(-4px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.mastery-rate {
  font-size: 12px;
  margin-top: 4px;
  opacity: 0.9;
}
</style>
