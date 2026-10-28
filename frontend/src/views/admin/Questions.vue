<template>
  <div class="question-bank">
    <div class="page-header">
      <h2>题库管理</h2>
      <p>管理题库中的题目</p>
    </div>
    
    <el-card class="gradient-card">
      <template #header>
        <div class="card-header">
          <div class="filters">
            <el-select v-model="filterType" placeholder="题型" style="width: 120px;">
              <el-option label="全部" value="" />
              <el-option label="选择题" value="choice" />
              <el-option label="填空题" value="fill" />
              <el-option label="简答题" value="shortAnswer" />
            </el-select>
            <el-select v-model="filterDifficulty" placeholder="难度" style="width: 120px; margin-left: 10px;">
              <el-option label="全部" value="" />
              <el-option label="简单" value="easy" />
              <el-option label="中等" value="medium" />
              <el-option label="困难" value="hard" />
            </el-select>
          </div>
          <el-button type="primary" @click="showAddDialog">
            <el-icon><Plus /></el-icon>
            添加题目
          </el-button>
        </div>
      </template>
      
      <el-table :data="questions" style="width: 100%" v-loading="loading">
        <el-table-column prop="type" label="题型" width="100">
          <template #default="scope">
            <el-tag>{{ getTypeText(scope.row.type) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="content" label="题目内容" show-overflow-tooltip />
        <el-table-column prop="difficulty" label="难度" width="80">
          <template #default="scope">
            <el-tag :type="getDifficultyType(scope.row.difficulty)">{{ getDifficultyText(scope.row.difficulty) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="score" label="分值" width="80" />
        <el-table-column label="操作" width="150">
          <template #default="scope">
            <el-button type="primary" link @click="editQuestion(scope.row)">编辑</el-button>
            <el-button type="danger" link @click="deleteQuestion(scope.row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
    
    <el-dialog v-model="dialogVisible" :title="isEdit ? '编辑题目' : '添加题目'" width="600px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="80px">
        <el-form-item label="题型" prop="type">
          <el-select v-model="form.type">
            <el-option label="选择题" value="choice" />
            <el-option label="填空题" value="fill" />
            <el-option label="简答题" value="shortAnswer" />
          </el-select>
        </el-form-item>
        <el-form-item label="内容" prop="content">
          <el-input v-model="form.content" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item label="答案" prop="answer">
          <el-input v-model="form.answer" />
        </el-form-item>
        <el-form-item label="分值">
          <el-input-number v-model="form.score" :min="1" :max="100" />
        </el-form-item>
        <el-form-item label="难度">
          <el-radio-group v-model="form.difficulty">
            <el-radio label="easy">简单</el-radio>
            <el-radio label="medium">中等</el-radio>
            <el-radio label="hard">困难</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/utils/api'

var loading = ref(false)
var filterType = ref('')
var filterDifficulty = ref('')
var dialogVisible = ref(false)
var isEdit = ref(false)
var formRef = ref(null)
var questions = ref([])

var form = reactive({ id: '', type: 'choice', content: '', answer: '', score: 5, difficulty: 'medium' })
var rules = {
  type: [{ required: true, message: '请选择题型', trigger: 'change' }],
  content: [{ required: true, message: '请输入内容', trigger: 'blur' }],
  answer: [{ required: true, message: '请输入答案', trigger: 'blur' }]
}

onMounted(function() {
  loadQuestions()
})

function loadQuestions() {
  loading.value = true
  api.get('/admin/questions', { type: filterType.value, difficulty: filterDifficulty.value })
    .then(function(res) {
      if (res.success) {
        questions.value = res.data.data
      }
    })
    .catch(function(error) {
      console.error('加载失败:', error)
    })
    .finally(function() {
      loading.value = false
    })
}

function showAddDialog() {
  isEdit.value = false
  form.id = ''
  form.type = 'choice'
  form.content = ''
  form.answer = ''
  form.score = 5
  form.difficulty = 'medium'
  dialogVisible.value = true
}

function editQuestion(row) {
  isEdit.value = true
  form.id = row.id
  form.type = row.type
  form.content = row.content
  form.answer = row.answer
  form.score = row.score
  form.difficulty = row.difficulty
  dialogVisible.value = true
}

function deleteQuestion(row) {
  ElMessageBox.confirm('确定删除该题目？', '提示', { type: 'warning' })
    .then(function() {
      api.delete('/admin/questions/' + row.id)
        .then(function(res) {
          if (res.success) {
            ElMessage.success('删除成功')
            loadQuestions()
          }
        })
        .catch(function(error) {
          ElMessage.error('删除失败')
        })
    })
    .catch(function() {})
}

function submitForm() {
  formRef.value.validate()
    .then(function() {
      var request
      if (isEdit.value) {
        request = api.put('/admin/questions/' + form.id, form)
      } else {
        request = api.post('/admin/questions', form)
      }
      
      request
        .then(function(res) {
          if (res.success) {
            ElMessage.success(isEdit.value ? '更新成功' : '添加成功')
            dialogVisible.value = false
            loadQuestions()
          }
        })
        .catch(function(error) {
          ElMessage.error('操作失败')
        })
    })
    .catch(function() {})
}

function getTypeText(type) {
  if (type === 'choice') return '选择题'
  if (type === 'fill') return '填空题'
  if (type === 'shortAnswer') return '简答题'
  return '未知'
}

function getDifficultyType(difficulty) {
  if (difficulty === 'easy') return 'success'
  if (difficulty === 'medium') return 'warning'
  if (difficulty === 'hard') return 'danger'
  return 'info'
}

function getDifficultyText(difficulty) {
  if (difficulty === 'easy') return '简单'
  if (difficulty === 'medium') return '中等'
  if (difficulty === 'hard') return '困难'
  return '未知'
}
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
