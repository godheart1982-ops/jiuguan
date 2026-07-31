export class GenerationForegroundWeb {
  async start() {
    // Web / Electron 环境下不需要前台服务
  }

  async stop() {
    // Web / Electron 环境下不需要前台服务
  }

  async requestIgnoreBatteryOptimizations() {
    return { granted: true };
  }
}
