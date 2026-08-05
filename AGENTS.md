# 酒馆项目说明与长期授权

自用项目（不上架）。以下为对本目录的长期授权，Agent 无需逐次确认即可执行：

- **常规项目操作**：编辑/新建/删除项目内代码文件、运行测试（`npm test`）、lint、web/Android 资源构建、打包 APK（`npm run build:android`）。
- **Git 操作**：本地 `git add` / `commit` / `checkout` / `branch` / `push` 到本仓库远程（github.com/godheart1982-ops/jiuguan，private）。每个阶段完成并验证通过后可顺手提交；推送在功能告一段落时进行。
- **版本号惯例**：打包后必须检查 README 两行版本号与 `android/app/build.gradle` 一致（升版脚本只升 versionName，versionCode 需手动对齐），并保持 README 的 UTF-8 BOM。

仍需要先确认的（不可逆或超出项目目录的操作）：

- 删除 `data/` 目录下的用户数据（聊天记录、角色卡、配置）。
- 推送/发布到本仓库以外的任何远程或第三方平台。

## 常用命令

- 测试：`npm test`（node --test）
- Lint：`npm run lint`（eslint flat config，零告警要求）
- Web 构建：`npm run build:web`
- APK：`npm run build:android`（产物在 `android/app/build/outputs/apk/debug/`）
