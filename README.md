<div align="center">

# YIHOT · 公益信息雷达

**公开来源聚合 · 热点排序 · 可复核来源 · RSS / Atom · SSE · 静态烘焙**

<p>
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Node.js-339933">
  <img alt="Sources" src="https://img.shields.io/badge/sources-allowlist%20RSS%20%2F%20Atom-6C63FF">
  <img alt="Updates" src="https://img.shields.io/badge/updates-SSE%20%2B%20hourly%20bake-2F80ED">
  <img alt="Status" src="https://img.shields.io/badge/status-public--source%20prototype-F2994A">
</p>

[**Run locally**](#运行) · [**GitHub Pages bake**](#部署到-github-pages定时烘焙) · [**CloudBase deployment**](cloudbase/DEPLOY.md)

</div>

YIHOT 面向公益组织聚合**公开来源**中的灾害、政策、资金与志愿者信息，把条目放入可复核队列，并保留来源 URL、发布时间和主题标签。默认页面明确区分演示数据与实时 / 烘焙数据。

> [!IMPORTANT]
> 排序分、关键词命中和自动摘要只用于信息发现与复核，不代表事实认定，也不应自动生成对机构、项目或个人的公开指控、信用判断或募资结论。

## 运行

```powershell
npm start
```

打开 `http://127.0.0.1:8790/`。`GET /api/health` 是健康检查，`GET /api/feeds` 只访问 `feeds.json` 中的 HTTPS 公共源；`GET /api/stream` 提供 SSE 实时快照。服务限制来源协议、主机、响应大小和超时，避免把它变成任意 URL 代理。刷新间隔可用 `YIHOT_REFRESH_MS` 覆盖，最小 15 秒。

英文条目可自动翻译成简体中文：`POST /api/translate` 接收 `{ "texts": [...] }` 并批量返回译文，服务端有内存缓存，未变化的内容不会重复请求上游。默认转发到本地网关 `http://127.0.0.1:8797/v1`（模型 `moonshot-v1-8k`），可用 `YIHOT_TRANSLATE_BASE_URL`、`YIHOT_TRANSLATE_MODEL`、`YIHOT_TRANSLATE_API_KEY` 覆盖为任意 OpenAI 兼容端点；设 `YIHOT_TRANSLATE=off` 可完全关闭。翻译不可用或失败时页面保留英文原文，不影响抓取与展示。注意：`/api/translate` 没有鉴权，不要把 8790 直接暴露到公网，否则 LLM 额度会被刷掉；部署到 GitHub Pages 等纯静态托管时，翻译应放在定时构建（Actions）里完成，密钥只存在于仓库 Secrets。

## 页面能力

页面的信息架构参考了公开的 AI 热点产品形态，但使用 YIHOT 原创品牌与公益场景：精选/全部动态、48 小时热点榜、每日 08:00 公益日报、主题目录、收藏、组织复核队列和来源目录。条目保留来源、发布时间、原文链接、规则提示分和推荐理由；提示分只用于排序，不代表事实认定。桌面使用侧栏，手机使用固定底部导航；搜索、主题/来源/时间/可行动筛选、明暗主题、JSON 导出、SSE 实时更新和轮询回退均在本地可用。

实时条目只接受 `feeds.json` 中的 allowlist 源，且引用链接会限制在对应源的公开域名或子域名。远端源不可用时页面明确降级为演示数据，不把空响应伪装成同步成功。

## 自检与目录

YIHOT 的规范实现全部位于本目录：`index.html`、`app.js`、`styles.css`、`feeds.json` 和 `server.mjs`。运行中的日志放在 `logs/`，不会与根目录的其他产品混在一起。

```powershell
npm run smoke
```

自检会验证健康状态、allowlist 快照、ETag/条件请求和 SSE 首屏快照。浏览器与 API 都使用 `http://127.0.0.1:8790`。

## 部署到 GitHub Pages（定时烘焙）

纯静态托管跑不了 `server.mjs`，所以用 Actions 定时烘焙：每小时抓取 + 翻译并提交 `data/feeds.json`；页面优先请求 `/api/feeds`，失败（Pages 上必然 404）自动回退读取烘焙文件，两种模式共用同一套前端。

1. Settings → Secrets and variables → Actions：按需添加 Secret `YIHOT_TRANSLATE_BASE_URL` 与 `YIHOT_TRANSLATE_API_KEY`；模型可用 Variable `YIHOT_TRANSLATE_MODEL`（默认 `moonshot-v1-8k`）。不配置翻译 Secret 时，英文条目会保留原文。
2. Settings → Pages → Source 选择 `Deploy from a branch`，使用当前默认分支 `master` 的仓库根目录 `/`。
3. Actions 页手动运行一次 `bake-feeds` 验证；当前已提交的 `.github/workflows/bake-feeds.yml` 会在每小时第 17 分钟自动执行（cron `17 * * * *`）。
4. Workflow 会运行 `node bake.mjs` 并仅提交更新后的 `data/feeds.json`。

翻译服务可能产生按 token 计费的外部成本；实际费用取决于模型、调用量与提供商。密钥只应存在于 Secrets 或受控服务端环境，`api.txt` 之类凭据不要提交到公开仓库。

想要**分钟级实时**而不是每小时烘焙：用腾讯云 CloudBase 承接后端（与 CRIS 项目同一套基建），前端自动轮询云函数、三级兜底（云函数 → 本地 /api → 烘焙数据）。完整步骤见 [cloudbase/DEPLOY.md](cloudbase/DEPLOY.md)。

## 产品化方向

若从信息雷达原型继续产品化，更值得优先补齐的是：

- 组织账号与成员权限；
- 可配置来源与刷新策略；
- 内部复核队列、审计日志与删除请求；
- 邮件 / 飞书等通知通道；
- 来源可用性监控与失败告警；
- 面向组织的导出、归档和共享能力。

公开 README 不固定承诺价格；实际计费应在成本、刷新频率、数据授权与支持边界明确后单独维护。

上线前还应逐一确认源站条款、robots、版权与再分发许可，并避免把公开信息与私人身份数据拼接。
