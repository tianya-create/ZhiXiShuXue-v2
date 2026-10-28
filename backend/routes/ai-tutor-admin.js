const express = require('express');
const router = express.Router();
const db = require('../database/memory-db');
const { buildAdminSettingsPayload, getAdminSettingsView, validateRemoteConfig } = require('../services/ai-tutor');

function ensureAdmin(req, res, next) {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) {
      return res.status(401).json({ success: false, message: '未登录或缺少用户信息' });
    }

    const user = db.findById('users', userId);
    if (!user) {
      return res.status(401).json({ success: false, message: '用户不存在或登录状态无效' });
    }

    if (user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '仅管理员可配置 AI 助教' });
    }

    req.currentUser = user;
    next();
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

router.use(ensureAdmin);

router.get('/settings', (req, res) => {
  try {
    res.json({ success: true, data: getAdminSettingsView() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/validate', async (req, res) => {
  try {
    const incoming = req.body || {};
    const nextSettings = buildAdminSettingsPayload(db.data.settings, incoming);
    const validationText = await validateRemoteConfig({
      enabled: nextSettings.aiTutorEnabled !== false,
      provider: nextSettings.aiTutorProvider,
      endpoint: nextSettings.aiTutorApiEndpoint,
      model: nextSettings.aiTutorModel,
      apiKey: incoming.aiTutorApiKey ? String(incoming.aiTutorApiKey).trim() : ''
    });

    res.json({ success: true, data: { message: validationText || '配置校验成功' } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message || '配置校验失败' });
  }
});

router.put('/settings', (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const updates = req.body || {};
    const nextSettings = buildAdminSettingsPayload(db.data.settings, updates);

    db.data.settings = {
      ...db.data.settings,
      ...nextSettings,
      updatedAt: new Date().toISOString()
    };

    db.addLog(userId, 'UPDATE_AI_TUTOR_SETTINGS', {
      ...updates,
      aiTutorApiKey: updates.aiTutorApiKey ? '[FILTERED]' : undefined
    });

    res.json({ success: true, data: getAdminSettingsView(), message: 'AI助教配置更新成功' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
