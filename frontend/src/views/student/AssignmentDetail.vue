<template>
  <div class="assignment-detail">
    <div class="page-header">
      <h2>{{ viewMode ? '答题结果' : '在线答题' }}</h2>
      <p>{{ assignmentTitle }}</p>
    </div>
    
    <el-card class="gradient-card" v-loading="loading">
      <template #header>
        <div class="card-header">
          <span>题目列表</span>
          <div v-if="!viewMode">
            <el-upload
              class="upload-demo"
              action="/api/student/answers/upload"
              :headers="{ Authorization: 'Bearer ' + (localStorage ? localStorage.getItem('token') : '') }"
              :on-success="handleImageUpload"
              :on-error="handleImageUploadError"
              :auto-upload="false"
              ref="uploadRef"
              accept="image/*"
              capture="camera"
            >
              <el-button type="info" :icon="Camera">
                拍照上传
              </el-button>
            </el-upload>
            <el-button type="primary" @click="submitAnswers" :loading="submitting">
              提交答案
            </el-button>
          </div>
        </div>
      </template>
      
      <!-- 试卷信息 -->
      <div v-if="paper && paper.filePath" class="paper-info">
        <el-card shadow="hover" class="paper-card">
          <template #header>
            <div class="paper-header">
              <span>试卷：{{ paper.title }}</span>
              <el-button type="primary" size="small" @click="viewPaper(paper)">
                查看试卷
              </el-button>
            </div>
          </template>
          <div class="paper-details">
            <p><strong>文件名称：</strong>{{ paper.fileName }}</p>
            <p><strong>文件大小：</strong>{{ formatFileSize(paper.fileSize) }}</p>
            <p><strong>上传时间：</strong>{{ formatDate(paper.createdAt) }}</p>
          </div>
        </el-card>
      </div>

      <!-- 题目列表 -->
      <div v-for="(question, index) in questions" :key="question.id" class="question-item">
        <div class="question-header">
          <span class="question-number">第{{ index + 1 }}题</span>
          <el-tag>{{ getTypeText(question.type) }}</el-tag>
          <el-tag type="info">{{ question.score }}分</el-tag>
        </div>
        
        <div class="question-content">{{ question.content }}</div>
        
        <div v-if="question.type === 'choice'" class="question-options">
          <el-radio-group v-model="answers[question.id]" :disabled="viewMode">
            <el-radio
              v-for="(opt, optIndex) in question.options"
              :key="optIndex"
              :label="String.fromCharCode(65 + optIndex)"
              class="option-item"
            >
              {{ String.fromCharCode(65 + optIndex) }}. {{ opt }}
            </el-radio>
          </el-radio-group>
        </div>
        
        <div v-else-if="question.type === 'fill'" class="question-fill">
          <el-input
            v-model="answers[question.id]"
            placeholder="请输入答案"
            :disabled="viewMode"
          />
        </div>
        
        <div v-else class="question-short">
          <el-input
            v-model="answers[question.id]"
            type="textarea"
            :rows="4"
            placeholder="请输入答案"
            :disabled="viewMode"
          />
        </div>
        
        <div v-if="viewMode && hasResult(question.id)" class="answer-result">
          <div :class="['result-item', getResultCorrect(question.id) ? 'correct' : 'wrong']">
            <span>你的答案：{{ getAnswer(question.id) }}</span>
          </div>
          <div class="correct-answer">
            标准答案：{{ getCorrectAnswer(question.id) || '待教师批改' }}
          </div>
          <div class="score">得分：{{ getScore(question.id) }}/{{ question.score || 0 }}分</div>
        </div>
      </div>
      
      <el-empty v-if="questions.length === 0 && !loading && !paper" description="暂无题目" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Camera } from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import api from '@/utils/api'

var route = useRoute()
var router = useRouter()
var loading = ref(false)
var submitting = ref(false)

var assignment = ref(null)
var questions = ref([])
var answers = reactive({})
var results = reactive({})
var uploadRef = ref(null)
var imageUrls = ref([])
var paper = ref(null)

var viewMode = computed(function() {
  return route.query.view === 'result'
})

var assignmentTitle = computed(function() {
  if (!assignment.value || !assignment.value.title) {
    return '加载中...'
  }
  return assignment.value.title
})

onMounted(function() {
  loadAssignment()
})

onUnmounted(function() {
  // 清理uploadRef，避免内存泄漏
  uploadRef.value = null
})

function resetResults() {
  var keys = Object.keys(results)
  for (var i = 0; i < keys.length; i++) {
    delete results[keys[i]]
  }
}

function hasResult(questionId) {
  return results[questionId] !== undefined
}

function getResultCorrect(questionId) {
  var result = results[questionId]
  return result ? result.correct : false
}

function getAnswer(questionId) {
  var answer = answers[questionId]
  return answer || '未作答'
}

function getCorrectAnswer(questionId) {
  var result = results[questionId]
  return result ? result.correctAnswer : ''
}

function getScore(questionId) {
  var result = results[questionId]
  return result ? result.score : 0
}

function fillResults(questionList) {
  resetResults()
  for (var i = 0; i < questionList.length; i++) {
    var item = questionList[i]
    results[item.questionId] = item
    answers[item.questionId] = item.answer || ''
  }
}

function loadAssignment() {
  var assignmentId = route.params.id
  if (!assignmentId) return
  
  loading.value = true
  
  api.get('/student/assignments/' + assignmentId + '/questions').then(function(res) {
    if (res.success) {
      assignment.value = res.data.assignment
      questions.value = res.data.questions || []
      
      // 检查是否有试卷
      if (res.data.assignment && res.data.assignment.paperId) {
        // 直接构建试卷信息，不需要通过API获取
        // 尝试不同的文件格式
        var paperId = res.data.assignment.paperId;
        var possibleExtensions = ['.pdf', '.png', '.jpg', '.jpeg'];
        
        // 构建可能的文件路径
        var filePath = '/uploads/papers/' + paperId + possibleExtensions[0];
        
        paper.value = {
          id: paperId,
          title: res.data.assignment.paperTitle || '试卷',
          filePath: filePath,
          fileName: res.data.assignment.paperTitle + possibleExtensions[0],
          fileSize: 1024 * 1024, // 模拟文件大小
          createdAt: new Date().toISOString() // 模拟上传时间
        }
      }
      
      if (viewMode.value) {
        loadResults()
      }
    }
  }).catch(function() {
    ElMessage.error('加载作业失败')
  }).finally(function() {
    loading.value = false
  })
}

function loadResults() {
  var cachedAnswerId = sessionStorage.getItem('latest-answer-' + route.params.id)
  var request = cachedAnswerId
    ? Promise.resolve({ success: true, data: { answerId: cachedAnswerId } })
    : api.get('/student/assignments/' + route.params.id + '/latest-answer')

  request.then(function(resultRes) {
    if (!resultRes.success || !resultRes.data || !resultRes.data.answerId) {
      throw new Error('no answer id')
    }
    var answerId = resultRes.data.answerId
    sessionStorage.setItem('latest-answer-' + route.params.id, answerId)
    return api.get('/student/answers/' + answerId)
  }).then(function(res) {
    if (res.success) {
      fillResults(res.data.questions || [])
    }
  }).catch(function() {
    ElMessage.warning('暂无答题结果')
  })
}



function formatFileSize(size) {
  if (!size) return '0 B'
  var units = ['B', 'KB', 'MB', 'GB']
  var index = Math.floor(Math.log(size) / Math.log(1024))
  return (size / Math.pow(1024, index)).toFixed(2) + ' ' + units[index]
}

function formatDate(date) {
  return date ? dayjs(date).format('YYYY-MM-DD HH:mm') : '-'
}

function getFilePreviewUrl(filePath) {
  if (!filePath) return ''
  if (/^https?:\/\//i.test(filePath)) return filePath

  var origin = window.location.origin
  if (origin.indexOf(':5000') !== -1) {
    origin = origin.replace(':5000', ':5001')
  }

  return origin + filePath
}

function viewPaper(paper) {
  if (!paper || !paper.filePath) return
  // 直接访问后端文件路径，与教师端一致
  var url = getFilePreviewUrl(paper.filePath)
  window.open(url, '_blank')
}

function getTypeText(type) {
  var map = { choice: '选择题', fill: '填空题', shortAnswer: '简答题' }
  return map[type] || '未知'
}

function handleImageUpload(response) {
  if (response.success && response.data && response.data.filePath) {
    imageUrls.value.push(response.data.filePath)
    ElMessage.success('图片上传成功')
  } else {
    ElMessage.error('图片上传失败')
  }
}

function handleImageUploadError() {
  ElMessage.error('图片上传失败，请重试')
}

function submitAnswers() {
  var answeredCount = 0
  var answerKeys = Object.keys(answers)
  for (var i = 0; i < answerKeys.length; i++) {
    if (answers[answerKeys[i]]) {
      answeredCount++
    }
  }
  
  if (answeredCount === 0 && imageUrls.value.length === 0) {
    ElMessage.warning('请至少回答一道题目或上传一张图片')
    return
  }
  
  ElMessageBox.confirm('确定提交答案吗？已答' + answeredCount + '/' + questions.value.length + '题，上传了' + imageUrls.value.length + '张图片', '提示').then(function() {
    submitting.value = true
    
    api.post('/student/assignments/' + route.params.id + '/submit', {
      answers: answers,
      images: imageUrls.value
    }).then(function(res) {
      if (res.success) {
        ElMessage.success('提交成功')
        if (res.data && res.data.answerId) {
          sessionStorage.setItem('latest-answer-' + route.params.id, res.data.answerId)
        }
        router.replace('/student/assignment/' + route.params.id + '?view=result')
        loadResults()
      }
    }).catch(function() {
      ElMessage.error('提交失败')
    }).finally(function() {
      submitting.value = false
    })
  }).catch(function() {})
}
</script>

<style scoped>
.question-item {
  margin-bottom: 24px;
  padding: 20px;
  background: #f5f7fa;
  border-radius: 8px;
}

.question-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.question-number {
  font-size: 16px;
  font-weight: bold;
}

.question-content {
  margin-bottom: 16px;
  line-height: 1.6;
}

.question-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.option-item {
  display: flex;
  padding: 12px;
  background: white;
  border-radius: 4px;
}

.answer-result {
  margin-top: 16px;
  padding: 16px;
  background: white;
  border-radius: 8px;
}

.result-item {
  padding: 8px;
  border-radius: 4px;
}

.result-item.correct {
  background: #f0f9ff;
  color: #67C23A;
}

.result-item.wrong {
  background: #fef0f0;
  color: #F56C6C;
}

.correct-answer {
  margin-top: 8px;
  color: #67C23A;
}

.score {
  margin-top: 8px;
  font-weight: bold;
}

.paper-info {
  margin-bottom: 20px;
}

.paper-card {
  margin-bottom: 20px;
}

.paper-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.paper-details {
  margin-top: 12px;
  color: #606266;
}

.paper-details p {
  margin-bottom: 8px;
}
</style>
