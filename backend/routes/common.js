const express = require('express');
const router = express.Router();
const db = require('../database/memory-db');

// 获取知识点列表（树形结构）
router.get('/knowledge-points', (req, res) => {
  try {
    const knowledgePoints = db.find('knowledgePoints');
    
    // 构建树形结构
    const tree = [];
    const map = {};
    
    knowledgePoints.forEach(kp => {
      map[kp.id] = { ...kp, children: [] };
    });
    
    knowledgePoints.forEach(kp => {
      if (kp.parentId && map[kp.parentId]) {
        map[kp.parentId].children.push(map[kp.id]);
      } else if (!kp.parentId) {
        tree.push(map[kp.id]);
      }
    });
    
    res.json({ success: true, data: tree });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取所有知识点（平铺）
router.get('/knowledge-points/flat', (req, res) => {
  try {
    const knowledgePoints = db.find('knowledgePoints');
    res.json({ success: true, data: knowledgePoints });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取班级列表
router.get('/classes', (req, res) => {
  try {
    const classes = db.find('classes');
    
    const classesWithDetails = classes.map(cls => {
      const teacher = db.findById('teachers', cls.teacherId);
      const studentCount = cls.students ? cls.students.length : 0;
      
      return {
        ...cls,
        teacherName: teacher?.name || '未指定',
        studentCount
      };
    });
    
    res.json({ success: true, data: classesWithDetails });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取教师列表
router.get('/teachers', (req, res) => {
  try {
    const teachers = db.find('teachers');
    res.json({ success: true, data: teachers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 文件上传（通用）
router.post('/upload', (req, res) => {
  try {
    // 简化的文件上传处理
    res.json({
      success: true,
      message: '文件上传功能需要配置 multer 中间件',
      data: null
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 系统信息
router.get('/system-info', (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        name: '智慧教育平台',
        version: '1.0.0',
        description: '在线教育平台 - 教师端、学生端、后台管理端'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
