# 爱发电授权码管理系统

基于 **Cloudflare Workers + D1** 的授权码（License Key）发放与校验系统，对接[爱发电](https://afdian.com)开放平台。

买家在爱发电付款 → Webhook 自动接单 → 匹配套餐 → 生成授权码 → 私信发给买家。
客户端拿到授权码后调用验证接口，换取 **RS256 签名的离线令牌**，之后无需联网即可验签。

零构建、无框架依赖，全部跑在 Cloudflare 免费额度内。

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Cloudflare D1](https://img.shields.io/badge/DB-D1-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
![JWT RS256](https://img.shields.io/badge/JWT-RS256-000000?logo=jsonwebtokens&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![赞助](https://img.shields.io/badge/%E2%98%95_%E8%B5%9E%E5%8A%A9-%E7%88%B1%E5%8F%91%E7%94%B5-946ce6)](https://ifdian.net/a/DuncanPanic)

---

## 它解决什么问题

卖软件 / 插件 / 工具时，常见做法是手动发激活码，问题很多：

- 买家半夜下单，你得等到早上才发码
- 手动复制粘贴容易抄错，32 位 ID 抄错一个字符就永远匹配不上
- 无法限制使用设备数，一个码传遍全网
- 想给老客户续期，得手工算到期时间
- 授权码泄露后没法快速吊销

这套系统把上面这些自动化了：**付款即发码、限设备、可续期、可吊销、可离线校验**。

---

## 特性

| 能力 | 说明 |
|---|---|
| 自动发码 | 爱发电 Webhook 接单，秒级生成并私信送达买家 |
| 漏单补偿 | 每 10 分钟自动对账补发；买家也可凭订单号自助取码 |
| 多产品线隔离 | 每个软件独立前缀、独立套餐、独立密钥，互不干扰 |
| 三种期限模式 | 固定到期日 / 首次激活后 N 天 / 永久 |
| 设备绑定 | 每码限 N 台；IP 漂移检测；24 小时新增上限 |
| RS256 令牌 | 客户端只持公钥，无法伪造；令牌可离线校验 |
| 管理台 | 零构建 SPA，套餐/授权码/订单/日志全可视化 |
| 批量生成 | 单次最多 200 个，可整批吊销、导出 CSV |
| 自动清理 | 自然过期满 30 天的码自动删除，订单永久保留 |
| 额度保护 | 分级限流 + 熔断，避免免费额度被刷爆 |

---

## 架构

```
买家在爱发电付款
        │
        ▼
POST /webhook/afdian  ──► 验签（RS256，爱发电公钥）
        │                └─► 幂等抢占（同一订单只处理一次）
        ▼
   匹配本地套餐（plan_id / sku_id）
        │
        ├─ 同套餐且仍在有效期内 ──► 续期（原码加时长）
        └─ 其他情况 ────────────► 发新卡
        │
        ▼
   生成授权码（前缀 + 随机体 + Luhn 校验位）
        │
        ├─► 写入 D1
        └─► 调爱发电私信接口发送给买家

客户端（你的软件）
        │
        ▼
POST /api/v1/verify  ──► 校验 key + 设备指纹
        │                └─► 返回 RS256 JWT（24h 有效）
        ▼
   本地用公钥验签，读取 features 决定功能
```

**技术栈**

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Cloudflare Workers | 免费额度 10 万请求/天、10ms CPU/请求 |
| 数据库 | Cloudflare D1（SQLite） | 免费额度 500 万行读/天、10 万行写/天 |
| 定时任务 | Cron Triggers | 每 10 分钟：对账 + 私信重试 + 每日清理 |
| 前端 | 原生 JS，零构建 | 无 npm 依赖、无打包步骤 |
| 令牌 | RS256（RSA-2048） | C#/Java/Kotlin/Python 全部原生支持 |

---

## 快速开始

### 前置要求

- Node.js ≥ 18
- 一个 Cloudflare 账号
- 爱发电创作者账号（开通开发者功能）

### 1. 安装依赖

```bash
git clone <你的仓库地址>
cd afdian-key-system
npm install
```

### 2. 创建 D1 数据库

```bash
npx wrangler d1 create afdian_keys
```

把输出里的 `database_id` 记下来。

> **建议指定区域**：`npx wrangler d1 create afdian_keys --location apac`。
> 不指定时 Cloudflare 可能分配到美国西部，国内访问每次查询多几十毫秒。

### 3. 生成本地配置

```bash
cp wrangler.toml.example wrangler.toml
```

编辑 `wrangler.toml`，填入上一步的 `database_id`。

> `wrangler.toml` 已被 `.gitignore` 排除 —— 它包含你个人的部署信息（D1 ID / AUD / 域名），不要提交。

### 4. 初始化数据库结构

```bash
# 远程库
npx wrangler d1 execute afdian_keys --remote --file=./schema.sql

# 本地开发库（可选）
npx wrangler d1 execute afdian_keys --local --file=./schema.sql
```

### 5. 生成签发密钥

```bash
npm run genkey
```

会生成 `keys/private.pem` 和 `keys/public.pem`。
**私钥绝对不能提交或泄露**，公钥内置到客户端。

### 6. 写入 Secret

```bash
npx wrangler secret put LICENSE_PRIVATE_KEY   # 粘贴 keys/private.pem 全文
npx wrangler secret put AFDIAN_USER_ID        # 爱发电 user_id（32 位十六进制）
npx wrangler secret put AFDIAN_TOKEN          # 爱发电开发者后台的 API Token
```

如果要用口令登录管理台，再加：

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ADMIN_SESSION_SECRET  # 32 字节随机，见「安全说明」
```

> **`AFDIAN_USER_ID` 和 `AFDIAN_TOKEN` 必须走 Secret**，不要写进 `wrangler.toml`。
> 同名时 `[vars]` 会覆盖 Secret，表现为「密钥设了但线上读到空值」，而且报错不会告诉你是这个原因。

### 7. 部署

```bash
npx wrangler deploy
```

### 8.（推荐）加 Cloudflare Access

Zero Trust → Access → Applications → Add self-hosted：

- 域名：你的域名
- 路径：填 **两条** —— `admin` 和 `admin/*`
- 策略：Allow → Emails → 你自己的邮箱

拿到 **AUD Tag** 填进 `wrangler.toml` 的 `CF_ACCESS_AUD`，同时填 `CF_ACCESS_TEAM_DOMAIN`，再部署一次。

> **路径必须覆盖 `admin/*`**：只填 `admin` 时，`/admin/api/*` 有可能不在保护范围内。
> 而 `/api/v1/*`（客户端接口）和 `/webhook/afdian`（爱发电回调）**千万不要保护** —— 那些是给机器用的，没有浏览器登录流程。

### 9. 配爱发电 Webhook

爱发电开发者后台 → Webhook 地址填：

```
https://你的域名/webhook/afdian
```

保存后爱发电会推一条测试订单。它是**官方固定样本**（`plan_title="测试webhook"`、买家是平台测试号），
系统会自动识别并忽略：不入订单表、不发码、只留一条审计记录。

---

## 客户端接入

### 验证流程

```
KEY + 设备指纹  →  POST /api/v1/verify  →  RS256 JWT
                                            ↓
                                    本地验签 + 读 features
```

令牌默认 24 小时有效。建议**启动时校验一次，过期前静默续期**，不要每次操作都请求。

### 请求

```http
POST /api/v1/verify
Content-Type: application/json

{
  "key": "DEMO-A1B2-C3D4-E5F6-G7H8-I9J0-K",
  "app": "your-app-slug",
  "fingerprint": "设备唯一标识的哈希",
  "label": "用户的电脑名（可选）"
}
```

### 响应（成功）

```json
{
  "ok": true,
  "code": "OK",
  "token": "eyJhbGciOiJSUzI1NiIs...",
  "exp": 1761609600,
  "license": {
    "plan_id": "plan_xxx",
    "duration_mode": "from_activation",
    "activated_at": 1761004800,
    "expires_at": 1763596800,
    "max_devices": 1,
    "features": { "pro": true }
  }
}
```

### 令牌载荷

```json
{
  "ver": 1,
  "iss": "afdian-key",
  "sub": "lic_xxx",
  "app": "your-app-slug",
  "plan": "plan_xxx",
  "features": { "pro": true },
  "max_devices": 1,
  "fingerprint": "指纹哈希前16位",
  "duration_mode": "from_activation",
  "iat": 1761004800,
  "exp": 1763596800
}
```

令牌里**没有**完整授权码、买家 ID、邮箱等敏感信息。

### 错误码

所有错误也返回 HTTP 200，看 `ok` 字段。

| code | 含义 | 建议处理 |
|---|---|---|
| `OK` | 成功 | — |
| `INVALID_KEY` | 格式或校验位错误 | 提示用户检查输入，**不要重试打服务器** |
| `NOT_FOUND` | 授权码不存在 | 提示核对 |
| `EXPIRED` | 已过期 | 引导续费 |
| `BANNED` | 已封禁 | 显示封禁提示 |
| `REVOKED` | 已吊销 | 显示吊销提示 |
| `APP_MISMATCH` | 授权码不属于这个软件 | 检查 `app` 参数 |
| `APP_DISABLED` | 软件已停用 | 联系作者 |
| `DEVICE_LIMIT` | 设备数超限 | 引导自助解绑 |
| `DEVICE_IP_LIMIT` | 同一指纹用过太多不同网络 | 联系作者 |
| `DEVICE_ADD_LIMIT` | 24 小时内新增设备过多 | 明日再试或解绑 |
| `VERIFY_LIMIT` | 今日验证次数超限 | 明天再试 |
| `RATE_LIMIT` | 请求过频 | 退避重试 |

### 客户端验签（C# 示例）

```csharp
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

// 1. 拆分 JWT
var parts = token.Split('.');
var header = parts[0];
var payload = parts[1];
var sig = parts[2];

// 2. 用内置公钥验签
using var rsa = RSA.Create();
rsa.ImportFromPem(publicKeyPem);

var data = Encoding.ASCII.GetBytes($"{header}.{payload}");
var signature = Base64UrlDecode(sig);
bool valid = rsa.VerifyData(data, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);

if (!valid) throw new Exception("令牌签名无效");

// 3. 读 features
var json = JsonDocument.Parse(Base64UrlDecode(payload));
var features = json.RootElement.GetProperty("features");
bool isPro = features.TryGetProperty("pro", out var p) && p.GetBoolean();
```

> 验签时记得同时校验 `exp` 和 `app`，不要只看 `features`。

---

## 配置项

### `wrangler.toml` 的 `[vars]`

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUTH_MODE` | `access` | `access` / `password` / `both` / `none` |
| `CF_ACCESS_TEAM_DOMAIN` | 空 | 如 `your-team.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | 空 | Access 应用的 Audience Tag |
| `TOKEN_TTL_HOURS` | `24` | 客户端令牌有效期 |
| `SELF_UNBIND_COOLDOWN_DAYS` | `30` | 自助解绑冷却天数 |
| `WEBHOOK_ALLOW_UNSIGNED` | `0` | 老版 webhook 无签名时是否放行，**保持 0** |
| `SITE_NAME` | `Key 管理台` | 管理台显示名 |

### Secret（用 `wrangler secret put` 写入）

| 名称 | 必需 | 说明 |
|---|---|---|
| `LICENSE_PRIVATE_KEY` | ✅ | RS256 签发私钥（PKCS#8 PEM） |
| `AFDIAN_USER_ID` | ✅ | 爱发电 user_id |
| `AFDIAN_TOKEN` | ✅ | 爱发电 API Token |
| `ADMIN_PASSWORD` | 视模式 | 管理员口令 |
| `ADMIN_SESSION_SECRET` | 推荐 | 管理台会话签名密钥（与口令分离） |
| `ADMIN_API_KEY` | 可选 | 命令行调管理接口用（`X-Admin-Key` 头） |

### `AUTH_MODE` 四种取值

| 值 | 行为 | 适用场景 |
|---|---|---|
| `access` | 只认 Cloudflare Access | **正式上线推荐** |
| `password` | 只用口令 | 没配 Access |
| `both` | Access 或口令任一通过 | 过渡期留后路 |
| `none` | 完全无鉴权 | ⚠️ 仅本地调试 |

> `AUTH_MODE=none` 时任何知道地址的人都能读取全部授权码、生成新码、导出数据。
> 处于该模式时，管理台顶部会显示常驻红色警告。

---

## 授权规则

### 期限从「首次激活」才开始算

`from_activation` 模式下，买家付款后只是拿到码，**不开始倒计时**。
买家第一次在客户端验证通过的那一刻，才写入激活时间并算出到期日。

### 续期与发新卡

| 情况 | 处理 |
|---|---|
| 同套餐 · 码仍有效 · **剩余 > 30 分钟** | **续期**：原码加时长，买家无感 |
| 同套餐 · 剩余不足 30 分钟 / 已过期 | **发新卡** |
| 不同套餐（如月卡→永久版） | **发新卡**，旧卡保留到自然到期 |
| 永久卡再买同一套餐 | **买几次发几次**（每次一张新卡） |

> 剩余不足 30 分钟不续期，是为了避开临界状态下的时间计算歧义。

### 买多个月就给多个月

订单的 `month` 字段会乘进时长：3 个月的月卡 = 90 天。

### 过期清理

自然过期满 **30 天**的码自动删除（连带设备记录），但：

- 删除前把码的尾号（`••••1234`）写回订单的 `archived_key`
- `orders` 表永久保留
- **手工封禁（revoked/banned）和永久码永不自动删除**

### 设备防护

| 防护 | 规则 |
|---|---|
| 设备数上限 | 每码最多 `max_devices` 台 |
| 同指纹 IP 漂移 | 同一指纹最多出现在 **5 个不同 IP**，第 6 个拒绝 |
| 24 小时新增上限 | 24 小时内最多新增 `max_devices` 台（解绑后当天也不能重新占满） |

---

## 管理台

访问 `https://你的域名/admin`。

| 页面 | 作用 |
|---|---|
| 概览 | 授权码/设备/订单统计、额度水位、今日拦截数 |
| 授权码 | 列表、详情、续费、换发、封禁、踢设备、导出 CSV |
| 批量生成 | 一次最多 200 个，生成批次可整批吊销 |
| 软件 | 多产品线，每个独立前缀与密钥 |
| 套餐 | 期限、设备数、功能位、爱发电映射 |
| 订单 | 买家 ID、授权码、激活设备、投递状态 |
| 设置 | 私信文案、限流档位、公私钥、私信自检 |

**套餐的爱发电映射**：先点「🔄 同步爱发电方案」把商品拉下来存本地，之后建套餐时**下拉直接选**，ID 自动填好。

> 同步是快照，不是实时。爱发电新增商品后要再点一次同步。

---

## 常用命令

```bash
npm run genkey      # 生成 RS256 密钥对
npm run dev         # 本地开发
npm run deploy      # 部署
npm run db:local    # 初始化本地库
npm run db:remote   # 初始化远程库

node tests/run.mjs  # 跑测试（200+ 项）

npx wrangler tail                                                  # 实时看日志
npx wrangler d1 export afdian_keys --remote --output backup.sql     # 备份
```

---

## 安全说明

**1. 私钥只存 Cloudflare Secret**

`keys/private.pem` 仅用于 `wrangler secret put`，用完建议删除本地副本。泄露私钥 = 任何人都能伪造许可证。

**2. 管理台会话密钥与口令分离**

管理台令牌用 HMAC 签名。如果直接拿口令当密钥，任何人拿到一枚 token 就能**离线**跑字典反推口令
（不经过服务器、限流管不到、显卡每秒上亿次）。所以单独用一个 32 字节随机值：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put ADMIN_SESSION_SECRET
```

**3. 授权码熵**

20 字符 × 32 字母表 = 100 bit，用 `crypto.getRandomValues` 生成，配合限流在线枚举不可行。

**4. 令牌不含敏感信息**

载荷只有内部 ID、功能位、到期时间。令牌是签名防篡改，**不是加密** —— 别往里塞密钥。

**5. 限流分层**

| 入口 | 限制 |
|---|---|
| 验证接口 | 每 IP 每分钟 60~300 次（三档可调） |
| 输错授权码 | 每 IP 每分钟 20 次（固定，不随档位变） |
| 登录 | 每 IP 5 次失败 / 5 分钟（D1 计数，跨 isolate 有效） |
| Webhook 验签失败 | 每 IP 每分钟只记 1 条审计 |

**6. `.gitignore` 已排除**

`keys/`、`.dev.vars`、`wrangler.toml`、`data/`、`.backup/`、`.workbuddy/`、`*.pem`。
提交前建议再跑一次 `git status` 确认没有意外文件。

---

## 目录结构

```
.
├── src/
│   ├── index.js            # 入口：路由分发 + 定时任务
│   ├── routes/
│   │   ├── verify.js       # 客户端验证/状态/解绑/取码
│   │   ├── webhook.js      # 爱发电回调 + 发码
│   │   └── admin.js        # 管理台 API
│   └── lib/
│       ├── license.js      # 授权码核心逻辑
│       ├── keygen.js       # key 生成与校验位
│       ├── jwt.js          # RS256 / HS256
│       ├── afdian.js       # 爱发电 API 客户端 + 验签
│       ├── reconcile.js    # 订单对账
│       ├── quota.js        # 额度熔断
│       ├── ratelimit.js    # 分级限流
│       ├── access.js       # Cloudflare Access JWT
│       └── util.js         # 工具函数
├── public/                 # 管理台 + 取码页（零构建）
├── tests/run.mjs           # 端到端测试
├── scripts/genkey.mjs      # 生成密钥对
├── docs/                   # 设计文档、爱发电接口速查、迁移指南
├── schema.sql              # D1 表结构
├── wrangler.toml.example   # 配置模板（复制为 wrangler.toml）
└── .dev.vars.example       # 本地开发变量模板
```

---

## 常见问题

**Q：Webhook 一直收不到订单？**

1. 爱发电后台的 Webhook 地址是否填对（`https://你的域名/webhook/afdian`）
2. Secret 是否写入成功：`npx wrangler secret list`
3. 看审计日志：`GET /admin/api/logs`，`webhook_reject` 的 `detail` 会说明原因

**Q：订单收到了但没发码？**

订单 `delivery` 状态为 `unmatched` → 套餐没配映射。去「套餐」页同步爱发电方案并选上。

**Q：买家说收不到私信？**

爱发电规定**只能给赞助过你的人发私信**。如果买家是「买商品」而非「赞助方案」，可能不在赞助者列表里。
对策：让买家到取码页凭订单号自取，或把商品改成订阅型方案。

**Q：额度用超了会怎样？**

概览页额度条见红。熔断会先限制管理台，再限制客户端接口；webhook 永不拦截（避免丢单）。
额度按 UTC 0 点（北京时间 8:00）重置。

**Q：能部署到自己的服务器吗？**

代码是按 Workers + D1 写的，迁移到 Node.js + SQLite 需要替换 D1 调用层和定时任务，见 `docs/MIGRATION.md`。

---

## 支持这个项目

如果这套系统帮你省下了手工发码的时间，可以请作者喝杯咖啡 ☕

[![赞助我](https://pic1.afdiancdn.com/static/img/welcome/button-sponsorme.png)](https://ifdian.net/a/DuncanPanic)

### 在自己的网站 / 博客里嵌入赞助模块

爱发电提供两种嵌入方式。下面是本项目的赞助入口，把 `slug=` 后面的 `DuncanPanic`
换成你自己的主页后缀即可复用（主页 `https://ifdian.net/a/DuncanPanic` → 后缀 `DuncanPanic`）。

**① 赞助面板（iframe，桌面端固定 640 宽）**

```html
<iframe src="https://afdian.com/leaflet?slug=DuncanPanic"
        width="640" height="200" scrolling="no" frameborder="0"></iframe>
```

**② 赞助面板（手机端自适应，宽度 < 700px 时自动铺满）**

```html
<iframe id="afdian_leaflet" src="https://afdian.com/leaflet?slug=DuncanPanic"
        width="640" height="200" scrolling="no" frameborder="0"></iframe>
<script>
  document.getElementById('afdian_leaflet').width =
    window.innerWidth < 700 ? '100%' : '640';
</script>
```

**③ 赞助按钮（纯图片链接，任何环境都能用）**

```html
<a href="https://ifdian.net/a/DuncanPanic">
  <img src="https://pic1.afdiancdn.com/static/img/welcome/button-sponsorme.png"
       width="200" alt="赞助我">
</a>
```

> ⚠️ **GitHub 会过滤 iframe 和 script**
> 出于安全策略，GitHub 渲染 README 时会移除 `<iframe>`、`<script>`、`<style>`，
> 所以 ①② 在 GitHub 仓库页面**不会显示**，只有 ③ 的按钮有效。
>
> 面板嵌入适合放在自己的网站、博客、论坛（WordPress / Hexo / VuePress / Discourse 等）
> 或任何支持自由 HTML 的页面。iframe 高度固定 200px，内容超出会出现滚动条——
> 想完整展示方案列表就把 `height` 调大（常见 300–420）。

### 把这个入口做进你自己的授权系统

如果你是基于本项目二次开发，想让取码页 `/` 也带上赞助入口，改一个文件就够：

| 想要的效果 | 改哪里 |
|---|---|
| 底部一行文字 + 图片按钮 | `public/index.html` 底部，放 ③ 那段 `<a><img></a>` |
| 完整赞助面板 | 同一位置放 ① 或 ② 的 iframe（该页面本身支持自由 HTML） |

注意事项：

- `/` 页面是买家取码的地方，赞助入口放**页面底部**，别挡住取码按钮
- 管理台设置里的 `claim_hint` 字段后端已存、接口也返回，但**取码页目前还没渲染它**（预留位），改了看不到效果，别被骗
- 改完要 `npx wrangler deploy`，静态资源才会更新

---

## License

MIT
