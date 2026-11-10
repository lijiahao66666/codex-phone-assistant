# 运行中转服务

中转服务的入口是 `src/relay/cli.mjs`，通过同一仓库的配对注册表和 H5 资源运行。

需要 Node.js 22.17 或更高版本。在仓库根目录安装依赖后启动：

```sh
npm ci
HUB_ORIGIN=https://codex.example.com \
HUB_DATABASE=/absolute/path/relay.sqlite \
PORT=8788 \
npm run start:relay
```

进程只监听 `127.0.0.1`，输出 `RELAY_LISTEN=http://127.0.0.1:8788`。对外的 HTTPS 反向代理需将请求和 WebSocket 转发至该地址，保留原始 Host；`HUB_ORIGIN` 必须与浏览器地址一致。浏览器直接访问 HTTP 地址无法使用带 Secure 属性的配对 Cookie。

`HUB_DATABASE` 默认是当前工作目录下的 `data/relay.sqlite`。该文件保存电脑身份和配对状态，更新服务时应继续使用原文件。新建文件使用仅当前用户可读写的权限。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HUB_ORIGIN` | 必填 | 浏览器使用的 HTTPS 根地址 |
| `PORT` | `8788` | 本机 HTTP 监听端口 |
| `HUB_DATABASE` | `data/relay.sqlite` | 配对数据库路径 |
| `HUB_TRUSTED_PROXY` | `0` | 为 `1` 时从本机代理提供的 `X-Real-IP` 读取客户端 IP；代理需覆盖此请求头 |
| `HUB_IMAGE_UPLOAD` | `0` | 为 `1` 时开放附件上传路由 |
| `HUB_IMAGE_PREVIEW` | `0` | 为 `1` 时开放媒体预览路由 |

布尔变量只接受 `0` 或 `1`。按 Ctrl+C 或发送 SIGTERM 可关闭服务。中转路由已包含新聊天、历史恢复、模型列表和模型切换；实际可用性仍取决于电脑端连接器提供对应能力。本地协议测试不代表公网部署或 iPhone 已验收。稳定版发布前还要核对正式域名和静态资源版本，并检查 systemd 入口、数据库备份与反向代理配置。

定向验证：

```sh
node --test test/relay-server.test.mjs
```
