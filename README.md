# YIHOT 公益信息雷达

YIHOT 是面向公益组织的公开信息聚合原型。它把灾害、政策、资金和志愿者公告放入可复核队列，每条记录保留来源 URL、发布时间和主题标签。默认页面使用明确标注的演示数据；启动本地 Node 服务后会读取 `feeds.json` 中的公开 RSS/Atom 源。

## 运行

```powershell
node .\yihot\server.mjs
```

打开 `http://127.0.0.1:8790/`。`GET /api/health` 是健康检查，`GET /api/feeds` 只访问 `feeds.json` 中的 HTTPS 公共源；`GET /api/stream` 提供 SSE 实时快照。服务限制来源协议、主机、响应大小和超时，避免把它变成任意 URL 代理。刷新间隔可用 `YIHOT_REFRESH_MS` 覆盖，最小 15 秒。

英文条目可自动翻译成简体中文：`POST /api/translate` 接收 `{ "texts": [...] }` 并批量返回译文，服务端有内存缓存，未变化的内容不会重复请求上游。默认转发到本地网关 `http://127.0.0.1:8797/v1`（模型 `moonshot-v1-8k`），可用 `YIHOT_TRANSLATE_BASE_URL`、`YIHOT_TRANSLATE_MODEL`、`YIHOT_TRANSLATE_API_KEY` 覆盖为任意 OpenAI 兼容端点；设 `YIHOT_TRANSLATE=off` 可完全关闭。翻译不可用或失败时页面保留英文原文，不影响抓取与展示。注意：`/api/translate` 没有鉴权，不要把 8790 直接暴露到公网，否则 LLM 额度会被刷掉；部署到 GitHub Pages 等纯静态托管时，翻译应放在定时构建（Actions）里完成，密钥只存在于仓库 Secrets。

## 页面能力

页面的信息架构参考了公开的 AI 热点产品形态，但使用 YIHOT 原创品牌与公益场景：精选/全部动态、48 小时热点榜、每日 08:00 公益日报、主题目录、收藏、组织复核队列和来源目录。条目保留来源、发布时间、原文链接、规则提示分和推荐理由；提示分只用于排序，不代表事实认定。桌面使用侧栏，手机使用固定底部导航；搜索、主题/来源/时间/可行动筛选、明暗主题、JSON 导出、SSE 实时更新和轮询回退均在本地可用。

实时条目只接受 `feeds.json` 中的 allowlist 源，且引用链接会限制在对应源的公开域名或子域名。远端源不可用时页面明确降级为演示数据，不把空响应伪装成同步成功。

## 自检与目录

YIHOT 的规范实现全部位于本目录：`index.html`、`app.js`、`styles.css`、`feeds.json` 和 `server.mjs`。运行中的日志放在 `logs/`，不会与根目录的其他产品混在一起。

```powershell
cd .\yihot
npm run smoke
```

自检会验证健康状态、allowlist 快照、ETag/条件请求和 SSE 首屏快照。浏览器与 API 都使用 `http://127.0.0.1:8790`。

## 部署到 GitHub Pages（定时烘焙）

纯静态托管跑不了 `server.mjs`，所以用 Actions 定时烘焙：每小时抓取 + 翻译并提交 `data/feeds.json`；页面优先请求 `/api/feeds`，失败（Pages 上必然 404）自动回退读取烘焙文件，两种模式共用同一套前端。

1. 把本目录推成公开仓库：`git init && git add -A && git commit -m "init"`，然后 `gh repo create yihot --public --source . --push`。
2. Settings → Secrets and variables → Actions：添加 Secret `YIHOT_TRANSLATE_BASE_URL`（如 `https://api.moonshot.cn/v1`）和 `YIHOT_TRANSLATE_API_KEY`；模型可用 Variable `YIHOT_TRANSLATE_MODEL`（默认 `moonshot-v1-8k`）。不配 Secret 也能跑，英文条目会保留原文。
3. Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`、目录 `/`（根）。
4. Actions 页手动跑一次 `bake-feeds` 验证，之后每小时自动执行（cron `17 * * * *`）。

成本：Pages 托管和公开仓库的 Actions 都免费；翻译按 token 计费且只处理新条目（当前量每月约几元）。密钥只存在于 Secrets，`api.txt` 之类凭据永远不要提交。

想要**分钟级实时**而不是每小时烘焙：用腾讯云 CloudBase 承接后端（与 CRIS 项目同一套基建），前端自动轮询云函数、三级兜底（云函数 → 本地 /api → 烘焙数据）。完整步骤见 [cloudbase/DEPLOY.md](cloudbase/DEPLOY.md)。

## 低维护商业化

- 组织版：¥199/月，10 个公开来源、15 分钟刷新、内部复核队列和 JSON 导出。
- 联盟版：¥699/月，组织自定义来源、邮件摘要、成员权限和审计日志。
- 一次性导入服务只作为迁移选项，不把持续人工整理写进基础订阅承诺。

上线前应补齐组织账号、权限、持久化队列、邮件/飞书通知、源可用性监控和删除请求。不得把公开信息与私人身份数据拼接，不得自动向公众发布未经复核的指控或募资结论。源站条款、robots、版权和再分发许可需要逐一确认。
