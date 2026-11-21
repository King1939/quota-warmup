# Quota Warmup 额度预热定时插件

为 **Antigravity App** 提供按**周一至周日任意时间**自动唤醒客户端并发送问候语（默认“你好”）以开启五小时额度窗口的原生插件。

## 系统要求

- **操作系统**：Windows 10 / Windows 11（依赖 Windows 任务计划程序、`wscript.exe` 与 PowerShell 5.1+）
- **客户端**：Antigravity App（需已登录账号；定时触发时电脑需处于开机且已登录当前 Windows 账号状态）

## 安装方式

### 方式一：通过 Antigravity CLI 安装（推荐）

```bash
agy plugin install https://github.com/King1939/datainsight
```

### 方式二：手动克隆到全局插件目录

在 PowerShell 或终端中执行：

```powershell
git clone https://github.com/King1939/datainsight.git "$env:USERPROFILE\.gemini\config\plugins\quota-warmup"
```

安装后在 Antigravity 客户端 **Customizations > Installed** 中确认 **Quota Warmup 额度预热** 已启用，或直接让助手打开 **「额度预热定时」** 侧边栏面板进行可视化配置。

## 双引擎与跨版本抗更新原理

1. **原生插件隔离部署**：插件位于 `~/.gemini/config/plugins/`，不修改客户端安装包或 `resources/app.asar`，Antigravity 客户端更新不会覆盖插件及排程数据。
2. **Windows 任务计划（OS 级自动唤醒）**：
   - 保存排程时在当前普通用户权限下同步根路径 `\` 的每周任务 `AntigravityQuotaWarmup_<DAY>_<HHMM>`。
   - 到达设定时间后由 `scripts/run_hidden.vbs` 无黑框静默运行 `scripts/wake_and_trigger.ps1`，动态定位 `Antigravity.exe`（依次读取 `data/runtime.json`、常见安装目录、卸载注册表及开始菜单快捷方式）并写入 `data/pending_trigger.json`。
   - 若客户端处于关闭状态，会自动拉起 Antigravity；若已开启，则直接复用当前实例，不重复多开。
3. **Sidecar Web UI 与兜底机制**：
   - `sidecars/scheduler/main.mjs` 基于官方 `sidecar_sdk` 与 `agentapi new-conversation` 提供侧边栏界面与 10 秒轮询调度器。
   - 若唤醒后 60 秒内 Sidecar 未消费待触发请求，唤醒脚本会自动探测 `~/.gemini/antigravity/daemon/hub_*.json` 中的健康 Language Server 并发起兜底调用。
4. **原子防重保护**：通过确定性槽位键（`YYYY-MM-DD_HH:MM`）、原子锁 `data/trigger.lock` 与 `data/state.json` 确保同一时间点仅触发一次。

## 主要配置项

- **每周排程（周一至周日）**：支持每天独立开关与多个 `HH:MM` 时间点（最多 8 个/天），内置“工作日 08:00”“每天 08:00”“全部关闭”快捷预设。
- **触发参数**：自定义发送内容（默认 `你好`）、对话标题（默认 `额度预热`）、模型选择（默认跟随客户端，或指定 `flash_lite` / `flash` / `pro` / 自定义模型 ID）。
- **开机错过时间时补触发（`runIfMissed`）**：默认关闭，防止电脑较晚开机时错峰意外开启五小时额度窗口；开启后将在开机登录时尽快补发一次。

## 卸载与清理

1. 在 Antigravity **Customizations > Installed** 中禁用或卸载插件（若为手动克隆，删除对应插件目录即可）。
2. 如需彻底清理 Windows 任务计划中的已同步任务，在 PowerShell 中运行：
   ```powershell
   Get-ScheduledTask -TaskName "AntigravityQuotaWarmup_*" -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
   ```

## License

[MIT](./LICENSE)
