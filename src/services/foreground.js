import { registerPlugin } from '@capacitor/core';

class GenerationForegroundWeb {
  async start() {
    // Web / Electron 环境下不需要前台服务
  }

  async stop() {
    // Web / Electron 环境下不需要前台服务
  }

  async requestIgnoreBatteryOptimizations() {
    return { granted: true };
  }

  async requestNotificationPermission() {
    return { granted: true };
  }

  async openAppSettings() {
    // Web / Electron 环境下无需打开系统设置
  }
}

const GenerationForeground = registerPlugin('GenerationForeground', {
  web: () => Promise.resolve(new GenerationForegroundWeb())
});

export async function startGenerationForeground(options = {}) {
  await GenerationForeground.start({
    title: options.title || '酒馆正在生成回复',
    text: options.text || 'AI 正在思考中，请勿关闭应用…'
  });
}

export async function updateGenerationForeground(options = {}) {
  // 服务已在运行，重新 start 会更新通知内容并刷新锁
  await startGenerationForeground(options);
}

export async function stopGenerationForeground() {
  try {
    await GenerationForeground.stop();
  } catch (e) {
    console.warn('停止前台服务失败:', e);
  }
}

export async function requestIgnoreBatteryOptimizations() {
  try {
    const result = await GenerationForeground.requestIgnoreBatteryOptimizations();
    return result.granted === true;
  } catch (e) {
    console.warn('请求忽略电池优化失败:', e);
    return false;
  }
}

export async function requestNotificationPermission() {
  try {
    const result = await GenerationForeground.requestNotificationPermission();
    return result.granted === true;
  } catch (e) {
    console.warn('请求通知权限失败:', e);
    return false;
  }
}

export async function openAppSettings() {
  try {
    await GenerationForeground.openAppSettings();
  } catch (e) {
    console.warn('打开应用设置失败:', e);
  }
}
