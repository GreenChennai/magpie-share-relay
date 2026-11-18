# magpie-share-relay

把本机 Magpie 的 AI API 分享给朋友。朋友的电脑上什么都不用装，只拿一把 key 和两个地址。

本机没有公网 IP 时，插件会通过一条 SSH 反向隧道连到你的服务器，再由服务器上的 nginx 把请求转回本机 Magpie。

## 两条链接

| 用途 | 地址 |
| --- | --- |
| OpenAI 兼容 API | `https://<你的域名>/<前缀>/v1` |
| Anthropic 兼容 API | `https://<你的域名>/<前缀>` |
| Remote magpie | `https://<你的域名>/<前缀>` |

所有地址共用同一把 gateway key。

## 前置条件

- 本机 Magpie 正在运行。
- 一台有公网 IP 和域名的服务器，已配好 nginx 与 HTTPS 证书。
- 本机能通过 SSH 登录这台服务器。

## 安装

```bash
magpie plugin add github:GreenChennai/magpie-share-relay
```

安装后在 Magpie 的 Plugins 页面打开“共享”。

## 首次设置

1. 在 Magpie 的 Settings → Network and sharing 打开局域网共享。
2. 页面会生成一段公钥授权命令，复制到服务器执行。
3. 预览并应用 nginx 配置。失败会自动回滚。
4. 启动隧道，创建朋友 key，把页面给出的地址和 key 发给朋友。

Windows 上如果页面提示找不到 `ssh`，把配置里的 `ssh.bin` 设成 Git 自带 `ssh.exe` 的完整路径（例如 `D:\Git\usr\bin\ssh.exe`）。

朋友在另一个 Magpie 里接入时：

```bash
magpie provider add remote-magpie <key> url=https://<你的域名>/<前缀> id=alice-share
```

## 安全说明

- 隧道目标是局域网地址，不是 loopback；公网无 key 也能访问时，插件拒绝启动。
- 建议每个朋友一把独立 key，并设置每日限额。
- 公网 nginx 会屏蔽 `/v1/magpie/admin` 和 `/v1/magpie/usage`。
- 插件管理服务只监听 `127.0.0.1`，页面请求需要 token。
- 私钥、配置和脱敏日志在 `~/.config/magpie/share-relay/`。

## 开发

```bash
bun test
bun scripts/dev-server.mjs 3488   # 假数据预览页面，不碰 Magpie/服务器/配置
```

## License

MIT
