# meting-api-serverless

基于 Hono 的多平台音乐 API 代理，封装 [@meting/core](https://www.npmjs.com/package/@meting/core) 对网易云 / QQ 音乐 / 酷狗 / 百度 / 酷我提供统一接口，支持运行在 Cloudflare Workers、Vercel。

## 🚀 部署教程

本项目支持 Cloudflare Workers 和 Vercel 两种部署方式，推荐使用 Cloudflare Workers 以获得最佳性能和功能支持（QQ音乐 Cookie 自动保活）。

### 方式一：Cloudflare Workers (推荐)

#### 1. 一键部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Warma10032/Meting-API-Serverless)

点击按钮，登录 Cloudflare 账号，选择账户并点击 "Deploy" 即可完成基础部署。

#### 2. 配置环境变量

为了安全和功能完整，请在 Cloudflare Dashboard 中配置环境变量：

1. 进入 **Workers & Pages** -> 选择本项目 -> **Settings** -> **Variables**。
2. 点击 **Add variable** 添加以下变量：

| 变量名                        | 推荐值/说明                                                                         |
| :---------------------------- | :---------------------------------------------------------------------------------- |
| `METING_TOKEN`              | **强烈建议修改**。API 鉴权密钥，防止接口被滥用                                |
| `METING_COOKIE_ALLOW_HOSTS` | **推荐设置**。允许访问 vip 资源的域名白名单（如 `example.com,*.test.com`） |
| `METING_COOKIE_TENCENT`     | QQ 音乐 Cookie。用于获取 VIP资源，**支持自动保活**                            |
| `METING_COOKIE_NETEASE`     | 网易云 Cookie。用于获取 VIP资源                                                     |
| `METING_COOKIE_KUGOU`       | 酷狗 Cookie                                                                         |
| `METING_COOKIE_KUWO`        | 酷我 Cookie                                                                         |

#### 3. 配置 QQ 音乐 Cookie 保活 (可选)

如果你配置了 `METING_COOKIE_TENCENT`，建议开启自动保活功能，否则 Cookie 过期后需要手动更新。

**3.1 创建 KV 数据库**

1. 在左侧菜单点击 **Storage & Databases** -> **KV Namespace**
2. 点击 **Create**，命名随意（例如 `meting_kv`），点击 **Add**

**3.2 绑定 KV 数据库**

1. 回到 **Workers & Pages** -> 选择本项目  -> **Bindings**
2. 点击 **Add** -> **KV Namespace**
3. **Variable name** 必须填写：`METING_KV`
4. **KV Namespace** 选择你刚才创建的数据库
5. 点击 **Deploy** 保存

**3.3 添加定时任务**

1. 回到 **Workers & Pages** -> 选择本项目  -> **Settings**
2. 点击 **Trigger Events** 的 **Add**
3. 选择添加 Cron Triggers
4. 设置频率为每 4 小时一次

完成以上步骤后，Worker 会自动将 QQ 音乐 Cookie 存入 KV，并定期刷新，无需人工干预。

> 注意：
>
> 1. Cookie 失效后会自动切备用 / 降级匿名并推送企业微信，不再需要手工改 KV（详见下一节）。
> 2. 重新部署后若绑定消失，需要重新添加KV存储绑定

**3.4 Cookie 失效自动切换与提醒**

开启后，Cookie 过期不再意味着“整个歌单突然播不了”：

| 场景 | 自动处理 | 播放影响 |
| :--- | :--- | :--- |
| 续期成功 | 新 Cookie 回写 KV，若之前处于失效状态会自动切回主号 | 无 |
| 续期失败 + 有备用 Cookie | 自动切换备用池中的下一个 | VIP 曲目继续由备用账号提供 |
| 续期失败 + 没有备用 | 临时降级为匿名模式 | 普通曲目继续播放；VIP 曲目走跨平台兜底 |
| 播放时直链为空 | 立即体检（2 分钟节流），不必等定时任务 | 同上，切换后自动重试当前歌曲 |
| 你更新了 Cookie 且续期成功 | 自动切回主 Cookie | 无，并推送“已恢复”通知 |
| Cookie 没有 refresh_token（浏览器直接复制） | 用 VIP 曲目探测直链，能拿到就保持可用 | 正常播放，但无法自动续期 |
| 上游风控/网络异常（探测请求报错） | 先用匿名免费曲做健康检查，上游异常则跳过本轮判定 | 不降级、不误报告警 |

企业微信机器人配置（二选一）：

```bash
# 方式一：Cloudflare Secret（部署时生效）
wrangler secret put METING_ALERT_WEBHOOK

# 方式二：写入 KV（推荐，改地址不用重新部署）
curl -X POST "https://你的域名/admin/webhook?token=你的METING_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"}'

# 发一条测试消息，确认通道正常
curl -X POST "https://你的域名/admin/alert/test?token=你的METING_TOKEN"
```

> 公开仓库不要把 webhook 写进 `wrangler.toml`，否则 key 会随代码公开。

推送内容包含：失效时间、账号 uin（脱敏）、失效原因、已执行的动作、备用剩余数量、状态页链接（设置 `METING_URL` 后才会带上完整链接）。同类告警默认 30 分钟内只发一次，避免刷屏。

**备用 Cookie 池**

备用 Cookie 建议来自另一个 QQ 音乐账号（同一账号复制多份没有意义）。可以随时增删，不需要重新部署：

```bash
# 添加备用
curl -X POST "https://你的域名/admin/cookie/backup?token=你的METING_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cookie":"uin=...; qqmusic_key=...","label":"小号"}'

# 查看备用列表（只返回脱敏信息）
curl "https://你的域名/admin/cookie/backups?token=你的METING_TOKEN"

# 删除某个备用
curl -X DELETE "https://你的域名/admin/cookie/backup?token=你的METING_TOKEN&id=bk-xxx"
```

也可以在环境变量 `METING_COOKIE_TENCENT_BACKUPS` 中预置，多个用 `||` 分隔，首次轮换时会自动导入 KV。

**更新主 Cookie**

```bash
curl -X POST "https://你的域名/admin/cookie?token=你的METING_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cookie":"完整的 QQ 音乐 Cookie","label":"主号"}'
```

默认会先调用 QQ 音乐接口验证，验证失败返回 400 并附带原因；确认要强行写入可加 `"test": false`。

**状态面板**

浏览器打开 `https://你的域名/status` 可看到当前状态、生效来源、最近检查、失效原因、备用数量与最近事件；`/status?token=你的METING_TOKEN` 可看到更详细（仍然脱敏）的信息。程序请求 `/status` 返回 JSON，`/health` 用于探活。

---

### 方式二：Vercel 部署

1. 点击按钮一键部署：

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FWarma10032%2FMeting-API-Serverless&project-name=meting-api-serverless&repository-name=Meting-API-Serverless)
2. 部署完成后，进入 Project Settings -> Environment Variables 添加环境变量。

   | 变量名                        | 推荐值/说明                                                                         |
   | :---------------------------- | :---------------------------------------------------------------------------------- |
   | `METING_TOKEN`              | **强烈建议修改**。API 鉴权密钥，防止接口被滥用                                |
   | `METING_COOKIE_ALLOW_HOSTS` | **推荐设置**。允许访问 vip 资源的域名白名单（如 `example.com,*.test.com`） |
   | `METING_COOKIE_TENCENT`     | QQ 音乐 Cookie。用于获取 VIP资源                                                    |
   | `METING_COOKIE_NETEASE`     | 网易云 Cookie。用于获取 VIP资源                                                     |
   | `METING_COOKIE_KUGOU`       | 酷狗 Cookie                                                                         |
   | `METING_COOKIE_KUWO`        | 酷我 Cookie                                                                         |

> 注意：Vercel 部署不支持 QQ 音乐 Cookie 的自动保活功能。

## 🛠️ 使用指南

### API 接口

基础路径：`https://你的域名/api`

**请求参数**

| 参数       | 必填 | 说明                                                                                                  |
| ---------- | ---- | ----------------------------------------------------------------------------------------------------- |
| `server` | 是   | 平台：`netease` (网易云) / `tencent` (QQ) / `kugou` (酷狗) / `baidu` (百度) / `kuwo` (酷我) |
| `type`   | 是   | 类型：`search` / `song` / `album` / `artist` / `playlist` / `lrc` / `url` / `pic`     |
| `id`     | 是   | 资源 ID (如歌曲 ID、歌单 ID)                                                                          |

**示例**

- 获取网易云歌曲详情：`https://你的域名/api?server=netease&type=song&id=186016`

### 前端接入 (MetingJS)

如果你使用 [MetingJS](https://github.com/metowolf/MetingJS)，只需设置 `meting_api` 即可：

```html
<meting-js
    server="netease"
    type="playlist"
    id="60198"
    meting_api="https://你的域名/api?server=:server&type=:type&id=:id">
</meting-js>
```

## ⚙️ 环境变量清单

在 `wrangler.toml` 中留占位，正式值请用 `wrangler secret put <NAME>` 或 Cloudflare Dashboard 的环境变量/Secret 管理。

| 变量名                        | 默认值    | 说明                                                                                   |
| ----------------------------- | --------- | -------------------------------------------------------------------------------------- |
| `HTTP_PREFIX`               |           | 路由前缀（可选，留空表示根路径）                                                       |
| `METING_URL`                |           | 对外可访问的基地址，用于生成回调链接（默认使用请求的 origin+路由前缀）                 |
| `METING_TOKEN`              | `token` | HMAC 鉴权密钥，默认 `token`，强烈建议更改并设置为 Secret                             |
| `METING_ADMIN_TOKEN`        | `METING_TOKEN` | 管理接口专用 token（可选，设置后管理接口只认它）                                 |
| `METING_COOKIE_ALLOW_HOSTS` |           | 允许访问平台 Cookie 的 referrer host 白名单（逗号分隔，留空表示不限制，支持 * 通配符） |
| `METING_COOKIE_NETEASE`     |           | 网易云 Cookie（可选）                                                                  |
| `METING_COOKIE_TENCENT`     |           | QQ 音乐 Cookie（可选）                                                                 |
| `METING_COOKIE_KUGOU`       |           | 酷狗 Cookie（可选）                                                                    |
| `METING_COOKIE_BAIDU`       |           | 百度 Cookie（可选）                                                                    |
| `METING_COOKIE_KUWO`        |           | 酷我 Cookie（可选）                                                                    |
| `METING_COOKIE`             |           | 通用 Cookie 兜底，平台专用值为空时使用（可选）                                         |
| `METING_COOKIE_TENCENT_BACKUPS` |       | 备用 QQ 音乐 Cookie，多个用 `\|\|` 或换行分隔，首次使用时导入 KV                        |
| `METING_ALERT_WEBHOOK`      |           | 企业微信机器人 Webhook；也可通过 `POST /admin/webhook` 写入 KV                          |
| `METING_WECOM_WEBHOOK`      |           | 同上，兼容旧命名                                                                        |
| `METING_ANONYMOUS_FALLBACK` | `1`     | 主 Cookie 失效且无备用时是否降级匿名继续播放（`0` 关闭）                               |
| `METING_FALLBACK_SERVERS`   | `netease` | 直链跨平台兜底平台，逗号分隔；留空关闭                                                 |
| `METING_SAME_SERVER_RETRY`  | `1`  | 直链为空时先在同平台换版本（同一首歌不同 mid 的授权状态不同，`0` 关闭）                   |
| `METING_FALLBACK_STRICT_ARTIST` | `0`  | `1` 表示兜底必须歌手也匹配（更准，但可能找不到而不兜底）                               |
| `METING_HEALTH_PROBE_MIDS`  |         | VIP 探测曲目 mid 列表（逗号分隔），默认用《告白气球》《晴天》《七里香》                   |
| `METING_HEALTH_BASELINE_MIDS` |         | 上游健康基线曲目（匿名可播的免费曲），判定 Cookie 失效前先确认上游没抽风                 |

## 🔌 管理接口

除 `/status`、`/health` 外均需要 `token`（`METING_ADMIN_TOKEN` 或 `METING_TOKEN`），支持 `?token=xxx` 或 `Authorization: Bearer xxx`。

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/health` | 探活，返回 Cookie 状态摘要 |
| GET | `/status` | 状态面板（浏览器 HTML / 程序 JSON） |
| POST | `/admin/cookie` | 更新主 Cookie，默认先验证 |
| POST | `/admin/cookie/backup` | 添加备用 Cookie |
| DELETE | `/admin/cookie/backup?id=` | 删除备用 Cookie |
| GET | `/admin/cookie/backups` | 备用列表（脱敏） |
| POST | `/admin/cookie/rotate` | 强制切到下一个备用 |
| POST | `/admin/cookie/check` | 立即续期/体检一次 |
| POST | `/admin/cookie/reset` | 清除失效标记，重新以主 Cookie 为准 |
| GET/POST | `/admin/webhook` | 查看/设置企业微信 Webhook |
| POST | `/admin/alert/test` | 发一条测试消息 |

`/api` 返回头会附带：

- `x-cookie-state`：`ok` / `degraded` / `anonymous` / `invalid` / `unconfigured`
- `x-cookie-source`：`primary` / `backup:xxx` / `anonymous`
- `x-fallback-source`、`x-fallback-match`：跨平台兜底时标记来源与匹配精度

## ⚠️ 能力边界

- 匿名模式和跨平台兜底都拿不到 QQ 音乐 VIP 原唱的直链（版权限制），只能尽量找同名可播版本；想要稳定播放 VIP 曲目，仍需一个有效的 Cookie 或备用账号。
- 备用 Cookie 应来自不同账号，同一账号复制多份没有意义。
- Vercel 没有 Cron 且无 KV：状态只存在实例内存中，重启即丢失，失效只能靠运行期检测，也无法持久化备用池。想要完整能力请用 Cloudflare Workers + KV。

## 未登录（无 Cookie）能播什么

实测结论（2026-10 复测）：

| 场景 | 结果 |
| :--- | :--- |
| QQ 音乐 320k | 拿不到直链（`result=104003`），必须有效 Cookie |
| QQ 音乐 128k | 免费曲目可以，返回完整 mp3 |
| 周杰伦 / 陈奕迅等 VIP 曲目 | 原版本 mid 无直链，但同一首歌的其它版本（`002f6kjO3yqwfd` 等）存在可匿名播放的授权 |
| 网易云 | 匿名可搜可播，返回完整 mp3，是最稳的兜底平台 |
| 酷狗 / 酷我 | 匿名直链基本拿不到 |

所以「没登录能不能播」的答案取决于三点：**码率**（只有 128k）、**曲目授权**（VIP 原版不行）、**上游频控**（QQ 音乐连续请求会返回 `code=2001`，需退避）。本项目为此做了三层兜底：同平台换版本 → 跨平台找同名 → 匿名降级，只要任意一层命中就继续播放。

> 想要 VIP 曲目原版 320k，仍然必须有有效 Cookie——这是版权限制，不是代码问题。

## 📝 开发与调试

1. 安装依赖：`npm install`
2. 本地启动：`npx wrangler dev`
3. 访问测试：`http://localhost:8787/demo`
4. 单元测试：`npm test`（覆盖失效切换、匿名降级、恢复、告警节流、兜底匹配、管理接口）

## 鉴权计算

`auth = HMAC-SHA1(METING_TOKEN, server + type + id)`

示例（Node.js）：

```js
import { createHmac } from 'crypto'

const auth = ({ server, type, id, secret = 'token' }) =>
  createHmac('sha1', secret).update(`${server}${type}${id}`).digest('hex')
```

## 缓存策略

- 缓存容量：1000 条
- TTL：`url` 10 分钟，其余 1 小时
- 未命中时响应头附带 `x-cache: miss`

## Demo 页面

`/demo` 使用 Meting + APlayer，可通过 query 参数调整：
`server` / `type` / `id`，并通过 `api` 属性反向调用 `/api`。
