# 迁移指南：从 Cloudflare Workers 搬到自己的机器

> 本文档假设你将来要把系统从 Cloudflare 迁到本地机 / VPS / 其他平台。
> **现在不用做任何事**，这份文档是给未来的自己看的。

---

## 0. 结论先行

### 绑定程度评估

| 组件 | 是否 Cloudflare 专属 | 迁移工作量 |
|---|---|---|
| 加密 / 哈希 / 随机数（`crypto.subtle`） | ❌ Web 标准 | 零 |
| `Request` / `Response` | ❌ Web 标准 | 零 |
| `btoa` / `atob` / `crypto.randomUUID` | ❌ Web 标准 | 零 |
| JWT 签发验签（`lib/jwt.js`） | ❌ 纯 Web Crypto | 零 |
| 业务逻辑（`lib/license.js`、`routes/*`） | ❌ 纯 JS | 零 |
| 前端（`public/`） | ❌ 静态文件 | 零 |
| 定时任务（`scheduled`） | ⚠️ Workers Cron | 换成 crontab，约 10 行 |
| 静态资源（`env.ASSETS`） | ⚠️ Workers Assets | 换 nginx / express.static |
| **数据库（`env.DB`）** | ⚠️ **D1 的调用形状** | **写一个 80 行兼容层，业务代码零改动** |

### 关键结论

- **没有用过 KV、Durable Objects、Queues** —— 这三样才是真正难搬的，一个都没碰。
- 全部业务代码是纯 ESM + Web 标准 API。
- **真正要改的只有两处**：数据库兼容层 + 入口层（HTTP 服务器 / 定时任务）。
- 预计总工作量：**半天到一天**。

---

## 1. 迁移前的准备（随时可做，零风险）

### 1.1 导出数据库

```bash
npx wrangler d1 export afdian_keys --remote --output=./backup_$(date +%Y%m%d).sql
```

导出的是标准 SQLite 的 `CREATE TABLE` + `INSERT`，可以直接灌进本地 SQLite。

> 建议每月导一次存本地。这不只是为迁移，也是防 D1 出问题。

### 1.2 备份私钥

```bash
# 私钥存在 Cloudflare Secret 里，你自己手上没有副本
# 迁移前必须确认还能拿到它，否则所有客户端令牌都得重新签发
npx wrangler secret list
```

> ⚠️ **Secret 无法读回**，只能覆盖。当初生成时如果没存 `keys/private.pem`，迁移时就得换密钥对，等于所有客户端要重新内置公钥。
> **现在就去做**：确认 `keys/private.pem` 在本地有备份。

### 1.3 清点环境变量

| 变量 | 类型 | 迁移后放哪 |
|---|---|---|
| `LICENSE_PRIVATE_KEY` | Secret | `.env` 或 systemd Environment |
| `ADMIN_PASSWORD` | Secret | 同上 |
| `AFDIAN_TOKEN` | Secret | 同上 |
| `AFDIAN_USER_ID` | 普通变量 | 同上 |
| `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` | 普通 | 迁移后可删（改用口令登录） |
| `TOKEN_TTL_HOURS` / `SELF_UNBIND_COOLDOWN_DAYS` / `DEFAULT_MAX_DEVICES` | 普通 | 同上 |
| `AUTH_MODE` | 普通 | 改成 `password`（没有 Access 了） |

---

## 2. 唯一的结构性改动：D1 兼容层

D1 的调用形状是：

```js
await env.DB.prepare('SELECT ... WHERE a = ?').bind(a).first()
await env.DB.prepare('INSERT ...').bind(a, b).run()   // 返回 { meta: { changes, last_row_id } }
await env.DB.prepare('SELECT ...').bind(a).all()      // 返回 { results: [...] }
await env.DB.batch([stmt1, stmt2])
```

只要在本地实现同样的形状，**上层 2700 行业务代码一行不用改**。

### 推荐：Node 22+ 的 `node:sqlite`（零依赖）

```js
// local/db.mjs
import { DatabaseSync } from 'node:sqlite';

export function openD1(path = './data/afdian.db') {
  const db = new DatabaseSync(path);

  const prepare = (sql) => {
    const stmt = db.prepare(sql);
    const wrap = (args) => ({
      // D1 返回 { meta: { changes, last_row_id } }，这里补齐形状
      run: async () => {
        const r = stmt.run(...args);
        return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
      },
      first: async () => stmt.get(...args) ?? null,
      all: async () => ({ results: stmt.all(...args) }),   // D1 包一层 results
    });
    return {
      bind: (...a) => wrap(a),
      run: () => wrap([]).run(),
      first: () => wrap([]).first(),
      all: () => wrap([]).all(),
    };
  };

  return {
    prepare,
    // D1 的 batch 是事务语义，出错整体回滚
    batch: async (list) => {
      const out = [];
      db.exec('BEGIN');
      try {
        for (const s of list) out.push(await s.run());
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return out;
    },
  };
}
```

> **这段代码不是凭空写的**：`tests/run.mjs` 里已经有一个等价的实现，跑通了 87 项测试。
> 迁移时直接把测试里的 `makeEnv()` 搬过来用即可。

### 备选：Node 18/20 用 `better-sqlite3`

API 几乎一样（`prepare/get/all/run`），只是 `run()` 返回 `{ changes, lastInsertRowid }` 而不是 `{ meta }`。上面那段 `wrap()` 逻辑可以原样复用。

代价：需要本地编译（Windows 上要装 Visual Studio Build Tools），不如 `node:sqlite` 省事。

### 注意事项

- 建表用现成的 `schema.sql`，原样执行：`db.exec(readFileSync('schema.sql', 'utf8'))`
- 所有 SQL 都是标准 SQLite 语法，没有 D1 特有函数，通过
- 时间戳都是 INTEGER，时区逻辑在 JS 里，不受数据库影响

---

## 3. 入口层：`fetch` / `scheduled` → Node HTTP

Workers 的入口是：

```js
export default {
  async fetch(request, env, ctx) { ... },
  async scheduled(event, env, ctx) { ... },
}
```

本地需要把 Node 的 `req/res` 转成 Web `Request/Response`。

```js
// local/server.mjs
import http from 'node:http';
import app from '../src/index.js';     // 直接复用 Workers 入口

const env = { ...process.env, DB: openD1() };

// ctx.waitUntil 的本地实现：收集 Promise，避免未处理
function makeCtx() {
  const pending = [];
  return {
    waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})),
    passThroughOnException: () => {},
    _drain: () => Promise.all(pending),
  };
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const url = `http://${req.headers.host}${req.url}`;
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  });

  const ctx = makeCtx();
  const response = await app.fetch(request, env, ctx);
  await ctx._drain();

  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(Number(process.env.PORT || 8787), '127.0.0.1');
console.log('listening on', process.env.PORT || 8787);
```

> 监听 `127.0.0.1` 而不是 `0.0.0.0`：前面会有 nginx 或隧道来转发，不直接暴露。

### 定时任务替换

Workers 的 `[triggers] crons = ["*/10 * * * *"]` 换成 Linux crontab：

```cron
*/10 * * * * curl -s -X POST http://127.0.0.1:8787/internal/cron -H "x-cron-key: 你的随机串" > /dev/null
```

然后在 `src/index.js` 里加一个只允许本机调用的路由：

```js
if (path === '/internal/cron') {
  if (request.headers.get('x-cron-key') !== env.CRON_KEY) return new Response('', { status: 403 });
  return app.scheduled({ cron: 'manual' }, env, ctx).then(() => new Response('ok'));
}
```

> 这段是**迁移时才加**的，现在不用动代码。

---

## 4. 静态资源

`env.ASSETS.fetch(request)` 是 Workers Assets 专有接口。本地两种做法：

**做法 A：nginx 直接托管（推荐）**

```nginx
server {
  listen 8443 ssl;
  server_name key.你的域名.com;

  root /srv/afdian/public;
  index index.html;

  # 前端页面
  location / {
    try_files $uri $uri/ /index.html;   # SPA 回退
  }

  # 接口转发到 Node
  location /api/     { proxy_pass http://127.0.0.1:8787; }
  location /webhook/ { proxy_pass http://127.0.0.1:8787; }
  location /admin/   { proxy_pass http://127.0.0.1:8787; }
}
```

**做法 B：在 Node 里自己返文件**

把 `env.ASSETS.fetch` 换成读文件 —— 需要在 `src/index.js` 里加一层判断，**这是唯一需要碰业务代码的地方**（约 15 行）。

建议用 A，不改代码。

---

## 5. 部署路线 A：Cloudflare Tunnel（推荐）

**适合**：家庭宽带、没有公网 IP、不想开端口、不想折腾 DDNS。

### 优点

- 不需要公网 IP
- 不需要开任何端口（运营商封 80/443 也无所谓）
- 不需要 DDNS
- 免费，自带 HTTPS 和抗攻击
- 域名可以继续用 `key.example.com`，买家完全无感

### 步骤

```bash
# 1. 在本地机装 cloudflared（Windows/macOS/Linux 都有安装包）

# 2. 登录（会打开浏览器授权）
cloudflared tunnel login

# 3. 创建隧道，记下返回的 Tunnel ID
cloudflared tunnel create afdian-key

# 4. 把域名指到隧道
cloudflared tunnel route dns afdian-key key.example.com

# 5. 写配置
# ~/.cloudflared/config.yml
```

```yaml
tunnel: afdian-key
credentials-file: /home/you/.cloudflared/<TunnelID>.json
ingress:
  - hostname: key.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

```bash
# 6. 跑起来
cloudflared tunnel run afdian-key
```

### 装成开机自启

```bash
sudo cloudflared service install
```

### 注意

- 流量仍经 Cloudflare，但**不占用 Worker 请求额度**（你跑在自己机器上）
- 如果哪天要彻底不用 Cloudflare，回到路线 B

---

## 6. 部署路线 B：公网 IP + DDNS

**适合**：有公网 IP、愿意折腾、要彻底脱离 Cloudflare。

### 先确认三件事

| 检查 | 怎么看 | 拿不到怎么办 |
|---|---|---|
| **有公网 IPv4** | 路由器 WAN 口 IP == `curl ifconfig.me` 返回的 IP | 打运营商客服申请，或改用 IPv6 |
| **端口没被封** | 外部访问 `http://你的IP:8443` 能否连通 | 换高端口试（8443 / 9443 / 2053） |
| **上行带宽够** | 家宽上行通常 30~100 Mbps | 用户多了会卡，只能换宽带 |

> 国内家宽普遍封 80 和 443，这不是配置问题，是运营商策略。**直接用高位端口，别浪费时间。**

### DDNS 方案

| 方式 | 说明 |
|---|---|
| 路由器自带 DDNS | 华硕/群晖等固件内置，最省事 |
| Cloudflare API 动态更新 | 写个脚本定时把 A 记录改成当前 IP，TTL 设 60 秒 |
| `ddclient` / `ddns-go` | 通用工具，支持多家服务商 |

**关键**：把 DNS 的 TTL 调到最低（60 秒），否则 IP 变了要等缓存过期，期间打不开。

### 证书

用 Let's Encrypt 免费证书：

```bash
certbot certonly --standalone -d key.你的域名.com
```

证书 90 天过期，配个 cron 自动续期。

### 风险提示

- **断电/重启**：装个监控或自动重启
- **硬盘坏**：定期把 `data/afdian.db` 备份到别处（cron + 压缩 + 异地）
- **DDoS**：家宽没有防护，被打就只能等它停

---

## 7. 跨平台（Windows / Linux / macOS）

同一套代码三平台通用。**代码里所有路径都用 `path.join`，没有硬编码分隔符**，也没有任何平台分支。差异只在「谁来守护这个进程」。

### 7.1 环境对照

| 项 | Windows | Linux | macOS |
|---|---|---|---|
| Node 安装 | 官网 msi / `winget install OpenJS.NodeJS` | `apt install nodejs` 或 nvm | `brew install node` 或 nvm |
| 最低版本 | **22 以上**（`node:sqlite` 依赖） | 同 | 同 |
| 开机自启 | 任务计划程序 / NSSM | systemd | launchd |
| 定时任务 | 任务计划程序 | `crontab` | `crontab` |
| cloudflared | msi 安装包 / 单文件 exe | `.deb` 或单文件二进制 | `brew install cloudflared` |
| 防火墙 | Windows Defender | ufw / firewalld | 系统设置 → 网络 |
| 文件权限 | 无需处理 | `chmod 600` | 同 Linux |

### 7.2 开机自启

**Linux（systemd）** — `/etc/systemd/system/afdian-key.service`

```ini
[Unit]
Description=Afdian Key System
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/srv/afdian
ExecStart=/usr/bin/node scripts/dev-local.mjs
Restart=always
RestartSec=5
# 优雅退出：留时间把 waitUntil 里的私信发完
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now afdian-key
sudo journalctl -u afdian-key -f
```

**macOS（launchd）** — `~/Library/LaunchAgents/com.afdian.key.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.afdian.key</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/srv/afdian/scripts/dev-local.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>/srv/afdian</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/afdian-key.log</string>
  <key>StandardErrorPath</key><string>/tmp/afdian-key.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.afdian.key.plist
launchctl list | grep afdian
```

**Windows（NSSM，推荐）**

NSSM 能把 node 包装成真正的 Windows 服务，崩溃自动重启：

```
nssm install AfdianKey "C:\Program Files\nodejs\node.exe" "C:\afdian\scripts\dev-local.mjs"
nssm set AfdianKey AppDirectory "C:\afdian"
nssm set AfdianKey Start SERVICE_AUTO_START
nssm start AfdianKey
```

不想装 NSSM 就用「任务计划程序」新建任务：触发器选「启动时」，操作填 `node.exe` 加脚本路径，勾选「不管用户是否登录都运行」。

### 7.3 定时任务

**Linux / macOS** — `crontab -e`

```cron
*/10 * * * * curl -s -X POST http://127.0.0.1:8787/internal/cron -H "x-cron-key: 你的随机串" > /dev/null 2>&1
```

**Windows** — 任务计划程序新建任务，触发器「每天」，重复间隔 10 分钟，操作填：

```
curl.exe -s -X POST http://127.0.0.1:8787/internal/cron -H "x-cron-key: 你的随机串"
```

> Windows 10 以后自带 `curl.exe`，不用另装。

### 7.4 跨平台踩坑清单

| 坑 | 表现 | 解法 |
|---|---|---|
| **换行符 CRLF / LF** | Windows 写的配置文件到 Linux 上解析失败（行尾正则匹配不到） | 读配置用 `indexOf('=')` 切分，**别用 `^key=value$` 正则**。本项目已按此实现，且实测踩过这个坑 |
| **`node:sqlite` 是实验性 API** | 启动打印 `ExperimentalWarning` | 设 `NODE_NO_WARNINGS=1`，或启动加 `--no-warnings` |
| **路径分隔符** | 手写 `'data/db.sqlite'` 在 Windows 也能用，但拼绝对路径会出错 | 一律 `path.join()`，本项目已全部遵守 |
| **文件权限** | Linux/macOS 下 `.env`、私钥可能被其他用户读到 | `chmod 600 .env keys/private.pem` |
| **SQLite 放同步盘** | iCloud / OneDrive / 网络盘上 SQLite 会锁表损坏 | 数据库必须放**本地盘** |
| **端口占用** | 启动报 `EADDRINUSE` | Linux `ss -lptn`；macOS `lsof -i:8787`；Windows `netstat -ano` |
| **时区** | 服务器时区不同导致「今天」判断错位 | 代码固定按 UTC+8 计算，不依赖系统时区 |

### 7.5 通用性验证情况

| 环境 | 状态 |
|---|---|
| Node 22 / Windows 11 | ✅ 已实测，41 项 HTTP 端到端全通过 |
| Node 22 / Linux | 逻辑一致（无平台分支），未实机验证 |
| Node 22 / macOS | 同上 |

**换平台不需要改任何业务代码**，只需要换一份开机自启配置。

---

## 8. 数据迁移命令

### 从 D1 导出

```bash
# 完整导出（建表语句 + 数据），导入空库时用这个
npx wrangler d1 export afdian_keys --remote --output=./backup.sql

# 只导数据，导入已有空表的库时用这个
npx wrangler d1 export afdian_keys --remote --no-schema --output=./data-only.sql
```

> `--output` 是必填参数。加 `--skip-confirmation` 可跳过交互确认，适合写进脚本。

### 导入本地 SQLite

**情况一：新库（推荐）** —— 用完整导出，一步到位

```bash
sqlite3 ./data/afdian.db < ./backup.sql
```

**情况二：已经跑过 `schema.sql` 建好表了** —— 必须用 `--no-schema` 的导出，否则会报 `table already exists`

```bash
sqlite3 ./data/afdian.db < ./data-only.sql
```

> 两种别混用，这是最常见的翻车点。

### 校验条数是否一致

```bash
sqlite3 ./data/afdian.db "SELECT 'licenses', COUNT(*) FROM licenses UNION ALL SELECT 'orders', COUNT(*) FROM orders UNION ALL SELECT 'devices', COUNT(*) FROM devices;"
```

和线上对比：

```bash
npx wrangler d1 execute afdian_keys --remote --command "SELECT COUNT(*) FROM licenses"
```

### 定期冷备份（迁移后建议每天都跑）

```bash
# 每天凌晨 3 点备份，保留 30 天
0 3 * * * sqlite3 /srv/afdian/data/afdian.db ".backup /backup/afdian-$(date +\%F).db" && find /backup -name "afdian-*.db" -mtime +30 -delete
```

> 用 `.backup` 命令而不是直接 `cp`：SQLite 在写入过程中直接复制文件可能得到损坏的副本。

---

## 9. 迁移后检查清单

| 检查项 | 怎么验 |
|---|---|
| 买家查询页能打开 | 浏览器访问 `https://域名/` |
| 管理台能登录 | 访问 `/admin`，用口令登录（`AUTH_MODE=password`） |
| 验证接口正常 | 拿一个真 key 调 `/api/v1/verify` |
| 公钥没变 | 对比 `/api/v1/pubkey` 和迁移前，**必须一致** |
| 旧令牌仍有效 | 迁移前签发的令牌，客户端应还能用（私钥没换） |
| webhook 能收 | 在爱发电后台点一次「测试」，看审计日志 |
| 定时任务在跑 | 等 10 分钟，看 `msg_queue` 的 pending 有没有被消费 |
| 备份任务 | 手动跑一次 cron 备份，确认文件生成 |

> **最容易出问题的是「公钥必须一致」**。如果私钥丢了重新生成，所有客户端都会验签失败，必须发新版本软件。

---

## 10. 不要做的三件事

| 别做 | 为什么 |
|---|---|
| 把数据库放在网络盘 / 同步盘 | SQLite 在网络文件系统上会锁表损坏 |
| 直接监听 `0.0.0.0:80` 暴露到公网 | 没有反向代理就丢了 HTTPS 和缓冲，容易被扫 |
| 用 `nodemon` 之类自动重启跑生产 | 重启会导致 `ctx.waitUntil` 的私信任务丢失，用 systemd/pm2 且设置优雅退出 |

---

## 11. 一句话总结

> **这套系统本来就不该被平台绑死。** 当初没用 KV、没用 Durable Objects、没用 Queues，就是为了今天能随时搬走。

真要搬的时候，改两个文件（数据库兼容层 + HTTP 入口），其余原样运行。
