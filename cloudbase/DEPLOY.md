# YIHOT 后端部署手册（腾讯云开发 CloudBase）

## 为什么用 CloudBase
- **实时更新**：GitHub Pages 是纯静态，跑不了抓取服务。CloudBase 云函数承接 `server.mjs` 的抓取 + 翻译逻辑，前端轮询它，页面就从"每天一次烘焙"升级为"分钟级实时"。
- **大陆可达、免费额度、无需信用卡**：与 CRIS 项目同一套基建，已验证可行。
- 前端继续用 GitHub Pages（`cochranek.github.io/yihot/`），只把后端搬过来。

## 与本地版的差异（提前知晓）
- 云函数无常驻进程：**没有 SSE 长连接**，前端自动切换为每 60 秒轮询（`app.js` 已内置，无需改代码）。
- 云函数冷启动后第一次请求要现场抓取 + 翻译，约 5–15 秒；之后实例保热，秒级响应。
- 刷新策略不变：60 秒过期才真正重新抓取（`YIHOT_REFRESH_MS`），内容没变不会重复消耗翻译额度。

## 前置条件
1. 已注册腾讯云并完成实名认证（与 CRIS 同一账号即可）。
2. 已开通云开发 CloudBase，有一个环境（可直接复用 CRIS 的环境，或新建一个）。记下**环境 ID**（形如 `cris-1gabcde1234`）。
3. 安装并登录 CLI：
   ```bash
   npm i -g @cloudbase/cli
   tcb login
   ```

## 部署步骤

### 1. 部署云函数
```bash
cd D:\2026\Money\yihot\cloudbase
ENV_ID=你的环境ID bash deploy_cloudbase.sh
```
脚本会自动把 `feeds.json` 同步进函数目录再部署。

### 2. 控制台三件事
- **超时与内存**：云函数 → `yihotApi` → 配置 → 执行超时时间 **60 秒**（默认 3 秒，抓取 + 翻译跑不完）、内存 256MB。
- **环境变量**（翻译配置，密钥只放在这里，永远不进代码）：
  - `YIHOT_TRANSLATE_BASE_URL` = `https://api.moonshot.cn/v1`
  - `YIHOT_TRANSLATE_API_KEY` = 你的 Kimi 密钥（或任意 OpenAI 兼容服务的 key）
  - `YIHOT_TRANSLATE_MODEL` = `moonshot-v1-8k`
  - 不想用翻译就设 `YIHOT_TRANSLATE` = `off`，英文条目会保留原文。
- **HTTP 触发 / 云接入**：触发管理 → 创建 HTTP 触发，路径填 `/`；或环境 → 云接入 → 新建路由 `/yihotApi` 指向函数，并在跨域白名单加入 `https://cochranek.github.io`。
  触发后域名形如 `https://<ENV_ID>-<APP_ID>.<地域>.app.tcloudbase.com/yihotApi`（以控制台显示的完整域名为准，`<APP_ID>` 必须带）。

### 3. 前端指向云函数
打开 `app.js`，把文件顶部的：
```js
const YIHOT_API_BASE = "";
```
改成控制台显示的完整域名（含函数名后缀），例如：
```js
const YIHOT_API_BASE = "https://cris-1gabcde1234-1300000000.ap-shanghai.app.tcloudbase.com/yihotApi";
```
提交推送，GitHub Pages 约 1 分钟重建。设置了 `YIHOT_API_BASE` 后，前端自动跳过 SSE、直连云函数；云函数挂了会自动回退到 `/api/feeds`（本地）再回退到 `data/feeds.json`（烘焙数据），三级兜底。

### 4. 验证
- 浏览器直接访问 `https://<你的域名>/api/health`：应返回 JSON，`ok: true`、`translate` 状态正确。
- 访问 `https://<你的域名>/api/feeds`：应返回三个源（reliefweb / un-news / un-official）的抓取结果，`summary.ok` ≥ 1。
- 打开 `https://cochranek.github.io/yihot/`：信息流应为实时抓取内容（侧栏"实时监测"区显示最近同步时间）。

## 接口（与本地 8790 对齐）
- `GET /api/health`：健康检查、各源状态、翻译配置状态
- `GET /api/feeds`：抓取快照（含各源 XML），`?force=1` 强制刷新
- `POST /api/translate`：`{"texts":[...]}` 批量翻译（服务端内存缓存，重复文本零成本）

## 费用
- CloudBase 免费额度含云函数调用次数与出网流量，yihot 每分钟级轮询的量级（单人访问每天不足千次调用）远低于免费额度。
- 翻译按 LLM token 计费，只对新内容生效（服务端缓存 + 指纹去重）；当前源每天约几十条新标题，每月几元量级。

## 安全
- CORS 白名单只放行 `https://cochranek.github.io` 与本地调试端口；改前端域名时同步修改 `index.js` 的 `ALLOWED_ORIGINS`。
- 源请求有 SSRF 防护：仅 `feeds.json` allowlist 主机、仅 HTTPS、拒绝内网地址、禁止跟随跨主机重定向。
- `api.txt` 与任何密钥文件不进入本仓库（`/api/translate` 的密钥只存在于 CloudBase 环境变量）。
