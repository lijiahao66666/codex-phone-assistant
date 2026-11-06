# 架构

## 数据流

```text
手机 H5
  │ HTTPS / WebSocket
  ▼
远程中转服务
  │ WSS /connector
  ▼
桌面后台进程（src/runtime.mjs）
  ├─ 配对与本机面板（src/pairing）
  ├─ WebSocket 传输与流控（src/transport）
  ├─ 任务和历史投影（src/desktop）
  └─ 媒体与上传（src/media）
          │
          ▼
Codex Desktop 本地 IPC
```

## 模块

| 目录 | 职责 |
| --- | --- |
| `src/common` | 跨平台绝对路径、目录边界和键值比较 |
| `src/desktop` | IPC 协议、会话恢复、任务索引、历史分页和状态投影 |
| `src/pairing` | 主机注册、配对码、设备管理、本机管理面板和凭据保护 |
| `src/transport` | WebSocket 连接、消息调度、流控和快照分块 |
| `src/media` | 媒体引用解析、内容校验、分块上传和临时文件 |
| `public` | 本机配对面板及远程 H5 的静态资源 |
| `macos` | Swift 窗口、菜单栏、WKWebView 和媒体辅助程序 |
| `windows` | WinForms、WebView2、托盘行为和安装器 |

## 连接流程

1. 桌面端启动 `src/runtime.mjs`，读取或创建配对凭据。
2. 桌面端连接 `HUB_ORIGIN/connector`，手机访问同一 H5 服务。
3. 手机输入配对码或扫码；桌面端显示确认请求。
4. 配对成功后，手机请求任务列表，桌面端读取 Codex 本地索引和历史。
5. 手机发送控制请求时，桌面端重新确认任务 owner，再通过本地 IPC 转发。
6. 状态变化通过订阅推送；断线或版本不连续会清空缓存并重新同步。

## 关键约束

- 写入操作必须携带当前 owner 和任务版本，不使用缓存状态直接执行。
- 历史读取必须限制在 Codex sessions 目录内。
- 手机端不能指定任意本地 socket、HTTP 地址或文件路径。
- 本机管理面板只监听 loopback，不代理给远程设备。
