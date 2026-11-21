---
name: quota-warmup
description: 配置、查询或管理「额度预热定时（quota-warmup）」插件的每周排程与执行日志。当用户想设置周一至周日任意时间的自动唤醒发送“你好”、打开额度预热定时侧边栏面板、修改发送消息/模型，或排查预热任务执行状态时激活本技能。
---

# 额度预热定时（Quota Warmup）使用与管理指南

本插件通过 **Windows 任务计划 + 原生 Sidecar UI** 双引擎，在用户设定的每周时间自动唤醒 Antigravity 并发送“你好”以开启五小时额度窗口。

> **路径说明**：插件根目录 `<pluginRoot>` 为当前 `SKILL.md` 向上两级目录（通常为 `%USERPROFILE%\.gemini\config\plugins\<dir>\`，默认 `<dir>` 为 `quota-warmup`；如通过 CLI/GitHub 安装，请以实际安装目录名 `<dir>` 为准）。

## 1. 打开侧边栏可视化面板

若插件与 `scheduler` Sidecar 处于启用并运行状态，直接在回复中向用户提供以下入口链接即可在侧边栏打开配置界面（将 `<dir>` 替换为实际插件安装目录名，默认 `quota-warmup`）：

```markdown
[额度预热定时](sidecar://<dir>/scheduler/)
```

> 若 Sidecar 尚未运行，先检查 `%USERPROFILE%\.gemini\antigravity\sidecar_data\<dir>\scheduler\logs\sidecar.log`，并提示用户前往 `[Quota Warmup 额度预热](customization://<dir>)` 确认插件与 Sidecar 已启用，不要输出未运行 Sidecar 的 `sidecar://` 链接。

## 2. 通过命令行脚本查询或修改排程

管理工具路径：`<pluginRoot>\scripts\manage_schedule.mjs`（先由当前 `SKILL.md` 路径向上推导 `<pluginRoot>`，或检查 `%USERPROFILE%\.gemini\config\plugins\<dir>\scripts\manage_schedule.mjs`）。

### 查看当前排程、系统任务同步状态与最近 10 条记录

```powershell
$pluginRoot = "$env:USERPROFILE\.gemini\config\plugins\quota-warmup"
node "$pluginRoot\scripts\manage_schedule.mjs" status
```

### 修改排程并自动同步 Windows 任务计划

传入 JSON（只需包含要更新的字段，会与现有 `data\schedule.json` 合并校验后写入并执行 `sync_tasks.ps1`）：

```powershell
$pluginRoot = "$env:USERPROFILE\.gemini\config\plugins\quota-warmup"
node "$pluginRoot\scripts\manage_schedule.mjs" set --json "{\"enabled\":true,\"message\":\"你好\",\"days\":{\"mon\":{\"enabled\":true,\"times\":[\"08:00\"]},\"tue\":{\"enabled\":true,\"times\":[\"08:00\"]},\"wed\":{\"enabled\":true,\"times\":[\"08:00\"]},\"thu\":{\"enabled\":true,\"times\":[\"08:00\"]},\"fri\":{\"enabled\":true,\"times\":[\"08:00\"]}}}"
```

支持的字段：
- `enabled` (`boolean`)：总开关
- `message` (`string`, 1~500 字符)：发送的问候语（默认 `"你好"`）
- `title` (`string`, <=100 字符)：新建对话标题（默认 `"额度预热"`）
- `model` (`string`)：`""`（跟随客户端）、`"flash_lite"`、`"flash"`、`"pro"` 或具体模型 ID
- `runIfMissed` (`boolean`)：计算机晚开机错过时间时是否补触发（默认 `false`）
- `days`：键为 `mon`、`tue`、`wed`、`thu`、`fri`、`sat`、`sun`，每项为 `{ "enabled": boolean, "times": ["HH:MM", ...] }`（24 小时制，每天最多 8 个）

### 仅重新同步 Windows 任务计划

```powershell
node "$pluginRoot\scripts\manage_schedule.mjs" sync
```

### 查看完整执行历史（最多 50 条）

```powershell
node "$pluginRoot\scripts\manage_schedule.mjs" history
```

## 3. 排障与日志文件

- 排程配置：`<pluginRoot>\data\schedule.json`
- 同步与去重状态：`<pluginRoot>\data\state.json`
- 执行历史：`<pluginRoot>\data\history.json`
- OS 唤醒脚本日志：`<pluginRoot>\data\wake.log`
- Sidecar 运行日志：`%USERPROFILE%\.gemini\antigravity\sidecar_data\<dir>\scheduler\logs\sidecar.log`
- Windows 计划任务名称前缀：`AntigravityQuotaWarmup_`（位于任务计划程序根路径 `\`）
