# 爱发电开放平台 API 参考（2026-10 整理）

> 来源：官方文档 guide.afdian.com 与官方公告页，2026-10-26 抓取核对。
> 域名注意：官方新旧域名并存，`afdian.com` 与 `ifdian.net` 均可调用，新文档统一用 `afdian.com`。

---

## 一、更新时间线

| 日期 | 变更 |
|---|---|
| 2025-05-14 | 新增「根据订单号查询随机自动回复」接口 |
| 2025-07-01 | Webhook 增加签名（RSA-SHA256） |
| 2025-08-14 | Open API 签名规则说明细化（user_id / params / ts / sign 四字段） |

---

## 二、通用签名规则（所有 Open API 必带）

### 请求体格式

```json
{
  "user_id": "你的创作者 user_id",
  "params": "{\"page\":1}",
  "ts": 1624339905,
  "sign": "a4acc28b81598b7e5d84ebdc3e91710c"
}
```

> 支持 form 表单或 JSON 提交，平台统一返回 JSON。
> `params` 是**字符串**，不是对象——必须先把业务参数序列化成 JSON 字符串再放入。

### 签名算法

```
sign = md5( token + "params" + params + "ts" + ts + "user_id" + user_id )
```

即 `token` 直接写值，其余按 **key 升序** 拼 `key + value`，中间无任何连接符。

官方示例：

```
user_id = abc
params  = {"a":333}
ts      = 1624339905
token   = 123     （不传输，仅参与计算）

sign = md5('123params{"a":333}ts1624339905user_idabc')
     = a4acc28b81598b7e5d84ebdc3e91710c
```

### 错误码

| ec | 含义 |
|---|---|
| 200 | 成功 |
| 400001 | params incomplete（参数缺失） |
| 400002 | time was expired（ts 超过 3600 秒延迟） |
| 400003 | params was not valid json string |
| 400004 | no valid token found |
| 400005 | sign validation failed（返回体里会带 `debug.kv_string` 方便离线核对） |

### 自检方法

调用 `POST /api/open/ping`，返回 `ec = 200` 即签名正确。

---

## 三、Open API 接口清单

所有接口路径前缀：`https://afdian.com/api/open/`

### 1. ping —— 测试签名

```
POST /api/open/ping
params: {"a": 1}   // 随便传，只为构造签名
```

返回：

```json
{ "ec": 200, "em": "pong", "data": { "uid": "xxxxxxx", "request": {...} } }
```

---

### 2. query-order —— 查订单

```
POST /api/open/query-order
params: { "page": 1 }                       // 按创建时间倒序，每页 50 条
    或  { "out_trade_no": "111,222,333" }   // 多个用英文逗号分隔
```

返回：

```json
{
  "ec": 200,
  "em": "",
  "data": {
    "list": [ { ...order 对象... } ],
    "total_count": 167,
    "total_page": 11
  }
}
```

> ⚠️ 注意层级差异：API 返回的 order 放在 `data.list[]` 里；Webhook 推送的 order 放在 `data.order` 里。

---

### 3. query-sponsor —— 查赞助者

```
POST /api/open/query-sponsor
params: { "page": 1, "per_page": 20 }   // 按建立关系时间倒序
```

> 官方文档只写了 `page`，但实测支持 `per_page`（1–100），不传默认 20。

返回字段：`total_count`、`total_page`、`list[]`，每个元素含
`sponsor_plans[]`、`current_plan`、`all_sum_amount`、`create_time`、`last_pay_time`、`user{user_id,name,avatar}`。

---

### 4. query-random-reply —— 按订单号查随机回复内容

**2025-05-14 新增。用于事后核对某笔订单实际被发出去的是哪一条卡密。**

```
POST /api/open/query-random-reply
params: { "out_trade_no": "202505141538455397541020050" }
        // 多个订单号用英文逗号分隔
```

返回：

```json
{
  "ec": 200,
  "em": "success",
  "data": {
    "list": [
      { "out_trade_no": "202505141538455397541020050", "content": "999" }
    ]
  }
}
```

---

### 5. update-plan-reply —— 写入自动回复 / 随机回复（补货、发码）

**这是「平台原生发卡」的写入接口。**

```
POST /api/open/update-plan-reply
params: {
  "plan_id": "...",              // 订阅方案用这个
  "sku_id": "...",               // 商品型号用这个
  "auto_reply": "...",           // 固定自动回复，非必填
  "auto_random_reply": "...",    // 随机回复内容，非必填
  "update_random_reply_type": "append"  // "append" 追加 / "overwrite" 覆盖
}
```

规则（官方原文）：

| 参数 | 说明 |
|---|---|
| `plan_id` / `sku_id` | **二选一**。订阅方案传 `plan_id`；商品（售卖型）传 `sku_id`。商品传 `plan_id` 会报错 |
| `auto_reply` | 非必填。**不为空**才覆盖原固定回复；不传或传空字符串**不会更新** |
| `auto_random_reply` | 非必填。**不为空**才更新随机回复 |
| `update_random_reply_type` | 要更新随机回复时**必填**，否则不生效 |

> ⚠️ **别和本系统的「套餐映射」搞混**：上面说的是你**调用爱发电开放平台接口时的传参规则**。
> 本系统内部「套餐 ↔ 爱发电商品」的映射规则相反地允许**无型号商品填 plan_id**——
> 因为这类订单不带 `sku_id`，只能靠 plan_id 匹配。详见 README「第一次使用顺序」与
> `docs/DESIGN.md` 的订单匹配一节。

`update_random_reply_type` 取值（**是字符串，不是数字 1/2**）：

- `"append"` 追加（平台会在内容前自动加一个换行符）
- `"overwrite"` 覆盖（直接替换全部内容）

> ⚠️ 官方文档写成「1、append 追加 / 2、overwrite 覆盖」，那个 1 和 2 只是列表编号，
> 实际传参是字符串。社区在用的 SDK 也用 `Literal["append", "overwrite"]` 约束。

> ⚠️ **没有删除操作。** 该字段只支持上述两个值。
> 由于 `auto_random_reply` 传空字符串等于「不更新」，**API 无法清空已有内容**。
> 若需真正清空，只能去爱发电后台手动删除。
> 变通做法：用 `overwrite` 覆盖成一行占位文本（如「库存已售罄」）。

---

### 6. send-msg —— 发送私信

```
POST /api/open/send-msg
params: {
  "recipient": "接收用户 user_id",
  "content": "私信内容"
}
```

> **限频：10 次/秒，1000 次/小时。**
> 批量补发必须排队，不能一次全发。

---

### 7. query-plan —— 查看方案详情

```
POST /api/open/query-plan
params: { "plan_id": "436af0d0e0xxxxxxxxxxxxxx25c377" }
```

返回：

```json
{
  "ec": 200,
  "em": "获取方案成功",
  "data": {
    "plan": {
      "plan_id": "...",
      "price": "5.00",
      "name": "测试售卖动画2",
      "product_type": 1,
      "desc": "",
      "reply_content": "",
      "replay_random_content": "",
      "independent": 0,
      "permanent": 0,
      "pay_month": 1,
      "skus": [
        {
          "sku_id": "...",
          "plan_id": "...",
          "name": "型款1",
          "desc": "",
          "stock": "",
          "price": "5.00",
          "reply_content": "",
          "reply_random_content": ""
        }
      ]
    }
  }
}
```

字段说明：

| 字段 | 含义 |
|---|---|
| `product_type` | 0=订阅　1=商品　2=捆绑包　3=自选包　4=售票 |
| `independent` | 0=非独立　1=独立方案 |
| `permanent` | 0=非永久　1=永久方案 |
| `pay_month` | 1=月费　3=季费　12=年费 |
| `replay_random_content` | **注意官方拼写是 replay 不是 reply**（plan 层） |
| `reply_random_content` | 正确拼写（sku 层）—— 两层字段名不一致，容易踩坑 |
| `stock` | sku 库存 |
| `skus` | 订阅型方案**没有** skus 字段 |

> 实用技巧：**可以通过 `query-plan` 读取当前的 `replay_random_content`，用来判断卡密库存还剩多少、要不要补货。**

---

## 四、Webhook

### 配置位置

爱发电后台 → 开发者 → Webhook 通知地址。必须公网可访问，建议 HTTPS。

### 推送体结构

```json
{
  "ec": 200,
  "em": "ok",
  "data": {
    "type": "order",
    "order": {
      "out_trade_no": "202106232138371083454010626",
      "custom_order_id": "Steam12345",
      "user_id": "adf397fe837481eaacee52540025c377",
      "user_private_id": "fdf981fu8f7g891euaceXXX430321c377",
      "plan_id": "a45353328af91XXX052540025c377",
      "month": 1,
      "total_amount": "5.00",
      "show_amount": "5.00",
      "status": 2,
      "remark": "",
      "redeem_id": "",
      "product_type": 0,
      "discount": "0.00",
      "sku_detail": [
        {
          "sku_id": "...",
          "count": 1,
          "name": "15000 赏金/货币 兑换码",
          "album_id": "",
          "pic": "..."
        }
      ],
      "address_person": "",
      "address_phone": "",
      "address_address": "",
      "sign": "（RSA 签名，2025-07 起提供 —— 注意在 order 内部，不是顶层）"
    }
  }
}
```

### 必须返回

```json
{"ec":200,"em":""}
```

非 200 会被平台视为投递失败并重推，**必须做幂等**（以 `out_trade_no` 为唯一键）。

### 验签（2025-07-01 起）

> ⚠️ **最容易踩的坑：`sign` 在 `data.order` 里面，不是请求体顶层。**
> 社区在用的 SDK 把 `sign` 定义为 `Order` 模型的字段，路径就是 `body.data.order.sign`。
> 取错位置会导致验签永远失败、所有推送被拒，表面上「webhook 通了但从不发码」。

签名串为 order 中四个字段顺序拼接：

```
sign_str = out_trade_no + user_id + plan_id + total_amount
```

用平台公钥做 **RSASSA-PKCS1-v1_5 + SHA-256** 验签（即 PKCS#1 v1.5 填充）。

`sign` 是标准 base64（不是 base64url），解码后直接喂给 RSA 验签。

平台公钥（官方公开，可覆盖）：

```
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwwdaCg1Bt+UKZKs0R54y
lYnuANma49IpgoOwNmk3a0rhg/PQuhUJ0EOZSowIC44l0K3+fqGns3Ygi4AfmEfS
4EKbdk1ahSxu7Zkp2rHMt+R9GarQFQkwSS/5x1dYiHNVMiR8oIXDgjmvxuNes2Cr
8fw9dEF0xNBKdkKgG2qAawcN1nZrdyaKWtPVT9m2Hl0ddOO9thZmVLFOb9NVzgYf
jEgI+KWX6aY19Ka/ghv/L4t1IXmz9pctablN5S0CRWpJW3Cn0k6zSXgjVdKm4uN7
jRlgSRaf/Ind46vMCm3N2sgwxu/g3bnooW+db0iLo13zzuvyn727Q3UDQ0MmZcEW
MQIDAQAB
-----END PUBLIC KEY-----
```

> 2025-07 之前的旧推送不带 `sign`。遇到无签名的推送应回查订单 API 确认，而不是直接信任。

### 推送保证

官方明确：**不保证及时送达，异常时会重复请求**。因此必须结合订单 API 主动对账，不能只依赖 Webhook。

---

## 五、OAuth2 关联授权

用于「用爱发电账号登录你的平台」，可拿到用户 `user_id`。

### 前置

需私信官方申请，提供：应用名称、应用用途、可信域名、clientSecret。官方下发 `client_id` / `client_secret`。

### 流程（authorization_code 模式）

**第 1 步：跳转授权页**

```
https://afdian.com/oauth2/authorize
  ?response_type=code
  &scope=basic
  &client_id=yourclientid
  &redirect_uri=<urlencoded 回调地址>
  &state=<自定义防 CSRF 值>
```

**第 2 步：用户同意后** 重定向到 `redirect_uri`，携带 `code` 和 `state`。用户拒绝则不重定向。

**第 3 步：用 code 换 access_token**

```
POST https://afdian.com/api/oauth2/access_token
Content-Type: application/x-www-form-urlencoded
```

| 参数 | 值 |
|---|---|
| `grant_type` | `authorization_code`（固定） |
| `client_id` | 分配的 client_id |
| `client_secret` | 分配的密钥 |
| `code` | 上一步拿到的 code |
| `redirect_uri` | 与授权时**完全一致**（不需手动 encode） |

返回：

```json
{
  "ec": 200,
  "em": "ok",
  "data": {
    "user_id": "网站的用户ID",
    "user_private_id": "同 openapi 的 user_private_id",
    "name": "昵称",
    "avatar": "头像"
  }
}
```

> 必须**服务端**调用，且走 HTTPS。`client_secret` 绝不能出现在客户端。

---

## 六、付款页 URL 参数

在商品下单页 URL 后追加参数，可实现自动化：

| 参数 | 作用 |
|---|---|
| `remark` | 预填留言 |
| `month` | 选择发电月数 |
| `custom_order_id` | 自定义订单号（**会出现在 webhook 的 `custom_order_id` 字段**） |
| `custom_price` | 自选金额 |

示例：

```
https://afdian.com/order/create?plan_id=xxx&product_type=0&month=3&remark=hello
```

> `custom_order_id` 很有用：可以把自己的用户标识塞进去，webhook 回来时直接拿到，无需依赖 OAuth2。

---

## 七、网页嵌入

`slug` 取个人主页地址 `/a/` 后面那段。例如主页 `https://ifdian.net/a/DuncanPanic`，
slug 就是 `DuncanPanic`。

**① 赞助面板（iframe，桌面固定 640 宽）**

```html
<iframe src="https://afdian.com/leaflet?slug=DuncanPanic"
  width="640" scrolling="no" height="200" frameborder="0"></iframe>
```

**② 赞助面板（手机端自适应，宽度 < 700px 时铺满）**

```html
<iframe id="afdian_leaflet" src="https://afdian.com/leaflet?slug=DuncanPanic"
  width="640" scrolling="no" height="200" frameborder="0"></iframe>
<script>
  document.getElementById('afdian_leaflet').width =
    window.innerWidth < 700 ? '100%' : '640';
</script>
```

**③ 赞助按钮**

```html
<a href="https://ifdian.net/a/DuncanPanic">
  <img src="https://pic1.afdiancdn.com/static/img/welcome/button-sponsorme.png" width="200">
</a>
```

**注意**：

- iframe 高度固定 200px，内容超出会出现滚动条；要完整展示方案列表，把 `height` 调大（常见 300–420）
- **GitHub 渲染 README 时会移除 `<iframe>` / `<script>` / `<style>`**，所以 ①② 只适合自有站点、博客、论坛；
  GitHub README 里只有 ③ 的图片按钮有效
- 官方示例用 `document.body.clientWidth` 判断宽度，等价于 `window.innerWidth`；
  元素 id 必须唯一，同一页放多个面板时分别起名（如 `afdian_leaflet_2`）

---

## 八、订单对象字段说明

| 字段 | 含义 |
|---|---|
| `out_trade_no` | 订单号（**幂等键**） |
| `custom_order_id` | 下单时通过 URL 传入的自定义订单号 |
| `user_id` | 下单用户 ID（32 位 hex） |
| `user_private_id` | 用户唯一 ID，类似微信 unionid |
| `plan_id` | 方案 ID；自选方案时为空 |
| `month` | 赞助月份 |
| `total_amount` | 真实付款金额（用了兑换码则为 0.00） |
| `show_amount` | 显示金额（折扣前） |
| `status` | **2 = 交易成功**（目前只会推送此类型） |
| `remark` | 订单留言 |
| `redeem_id` | 兑换码 ID |
| `product_type` | 0=常规方案　1=售卖方案 |
| `discount` | 折扣 |
| `sku_detail` | 售卖型商品的型号数组 |
| `address_person/phone/address` | 收货信息（需要地址的商品才有） |

---

## 九、官方文档没写、但社区实测存在的

这些点官方文档要么没提，要么写得含糊，但社区在用的 SDK 和实际接口都能验证。

| 项 | 实际情况 | 为什么重要 |
|---|---|---|
| **webhook 的 `sign` 位置** | 在 `data.order.sign`，**不是顶层** | 取错位置 = 验签永远失败 = 从不发码。这是最致命的坑 |
| **`update_random_reply_type` 的值** | 字符串 `"append"` / `"overwrite"`，不是数字 1/2 | 官方写「1、append」只是列表编号。传数字会不生效 |
| **`query-sponsor` 的 `per_page`** | 支持 1–100，不传默认 20 | 官方只写了 `page` |
| **`query-order` 返回含 `create_time`** | 有（秒级时间戳），但 webhook 推送里**可能没有** | 想做时间游标翻页只能用 API 返回，不能用 webhook 数据 |
| **`Order.plan_title`** | webhook 里可能不存在 | 别依赖它做业务判断 |
| **`sku_detail[].stock` / `post_id`** | 存在 | 可用来判断商品库存 |

### 非官方接口：查询创作者全部方案

```
GET https://afdian.com/api/creator/get-plans?user_id=<创作者ID>
```

- **不需要 token、不需要签名**
- 只能拿到**已上架的公开方案**
- 返回 `plan_id`、`name`、`price`、`product_type`、`status` 等
- ⚠️ 这是网页前端在用的接口，**不在开放平台文档内，字段可能随前端改版变化**

> 用途：可以做一个「从爱发电拉取我的方案列表」按钮，避免手工复制 `plan_id`（那串 32 位 ID 很容易抄错）。
> 但要有降级方案——它哪天变了，手工填还得能用。

---

## 十、关键限制汇总（踩坑清单）

1. **随机回复无删除接口** —— `update_random_reply_type` 只有 "append" / "overwrite"，且空字符串不生效，清空必须去后台手动操作。
2. **私信限频 10/s、1000/h** —— 批量补发必须排队。
3. **`ts` 允许延迟 3600 秒** —— 超过报 400002，服务器时钟要准。
4. **`params` 必须是 JSON 字符串**，不是对象；序列化后的字面量要参与签名，顺序不能变。
5. **`plan_id` 与 `sku_id` 二选一** —— 商品传 `plan_id` 会报错。
6. **Webhook 不保证送达、会重复推送** —— 必须幂等 + 主动对账。
7. **API 与 Webhook 的 order 层级不同** —— `data.list[]` vs `data.order`。
8. **`query-plan` 里两层字段拼写不一致** —— plan 层是 `replay_random_content`（官方笔误），sku 层是 `reply_random_content`。
9. **订阅型方案没有 `skus` 字段** —— 解析时要判空。
10. **订阅方案才有 `pay_month`**，售卖型商品靠 `sku_detail` 区分型号。
