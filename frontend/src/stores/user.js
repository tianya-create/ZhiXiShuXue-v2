import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '@/utils/api'

export var useUserStore = defineStore('user', function() {
  var token = ref(localStorage.getItem('token') || '')
  var userStr = localStorage.getItem('user')
  var userVal = null
  if (userStr) {
    try {
      userVal = JSON.parse(userStr)
    } catch (e) {
      userVal = null
    }
  }
  var user = ref(userVal)
  
  var isLoggedIn = computed(function() {
    return !!token.value
  })
  
  // 登录
  function login(username, password) {
    return new Promise(function(resolve) {
      api.post('/auth/login', { username: username, password: password })
        .then(function(res) {
          if (res.success) {
            token.value = res.data.token
            user.value = res.data.user
            
            localStorage.setItem('token', res.data.token)
            localStorage.setItem('user', JSON.stringify(res.data.user))
            
            resolve({ success: true })
          } else {
            resolve({ success: false, message: res.message })
          }
        })
        .catch(function(error) {
          resolve({ success: false, message: error.message || '登录失败' })
        })
    })
  }
  
  // 退出登录
  function logout() {
    return new Promise(function(resolve) {
      api.post('/auth/logout')
        .then(function() {
          resolve()
        })
        .catch(function(error) {
          console.error('退出登录失败:', error)
        })
        .finally(function() {
          token.value = ''
          user.value = null
          localStorage.removeItem('token')
          localStorage.removeItem('user')
        })
    })
  }
  
  // 检查登录状态
  function checkLogin() {
    return new Promise(function(resolve) {
      if (!token.value) {
        resolve(false)
        return
      }
      
      api.get('/auth/verify')
        .then(function(res) {
          if (res.success) {
            user.value = res.data
            localStorage.setItem('user', JSON.stringify(res.data))
            resolve(true)
          } else {
            resolve(false)
          }
        })
        .catch(function(error) {
          console.error('验证登录状态失败:', error)
          logout()
          resolve(false)
        })
    })
  }
  
  // 更新用户信息
  function updateUser(userData) {
    var newObj = {}
    if (user.value) {
      for (var key in user.value) {
        newObj[key] = user.value[key]
      }
    }
    for (var key in userData) {
      newObj[key] = userData[key]
    }
    user.value = newObj
    localStorage.setItem('user', JSON.stringify(newObj))
  }
  
  // 修改密码
  function changePassword(oldPassword, newPassword) {
    return new Promise(function(resolve) {
      var userId = ''
      if (user.value && user.value.id) {
        userId = user.value.id
      }
      
      api.post('/auth/change-password', {
        userId: userId,
        oldPassword: oldPassword,
        newPassword: newPassword
      })
        .then(function(res) {
          resolve(res)
        })
        .catch(function(error) {
          resolve({ success: false, message: error.message || '修改密码失败' })
        })
    })
  }
  
  return {
    token: token,
    user: user,
    isLoggedIn: isLoggedIn,
    login: login,
    logout: logout,
    checkLogin: checkLogin,
    updateUser: updateUser,
    changePassword: changePassword
  }
})
