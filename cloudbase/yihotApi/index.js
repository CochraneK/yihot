// yihotApi —— YIHOT 的腾讯云开发 CloudBase 云函数版（Node.js 18+，零依赖）
// 从 yihot/server.mjs 移植：同样的 allowlist 源、条件请求、内容哈希检测、LLM 批量翻译。
// CloudBase 没有常驻进程与 SSE：刷新由请求按需触发（超过间隔才重新抓取），前端自动改用轮询。
// CORS 只放行 https://cochranek.github.io（另保留本地 8766 预览便于调试）。

const crypto = require("node:crypto");
const fs = require("node:fs");
const dns = require("node:dns");
const net = require("node:net");
const path = require("node:path");
const { promisify } = require("node:util");
const dnsLookup = promisify(dns.lookup);

const TIMEOUT_MS = Number(process.env.YIHOT_TIMEOUT_MS) || 10_000;
const MAX_BYTES = 700_000;
const MAX_REDIRECTS = 3;
const REFRESH_INTERVAL_MS = Math.max(15_000, Number(process.env.YIHOT_REFRESH_MS) || 60_000);
// 预翻译在刷新内的时间预算：函数超时 60s，留足抓取与响应余量
const TRANSLATE_BUDGET_MS = Math.max(10_000, Number(process.env.YIHOT_TRANSLATE_BUDGET_MS) || 40_000);
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) YIHOT/1.0 RSS-Reader";
// 云函数运行在腾讯云（大陆出口）。这里只放从大陆出口实测可达的公开源；
// reliefweb / news.un.org 在大陆出口被拦（202 挑战 / 404），故云端不启用，
// 它们仍保留在 GitHub Actions 烘焙与本地服务里（那些网络可达）。
const ALLOWED_SOURCE_IDS = new Set(["chinanews", "caritas", "who-news", "oxfam", "greenpeace", "sspai", "ifrc", "unocha", "care"]);
const ALLOWED_SOURCE_HOSTS = new Set(["www.chinanews.com.cn", "chinanews.com.cn", "www.caritas.org", "caritas.org", "www.who.int", "who.int", "www.oxfam.org", "oxfam.org", "www.greenpeace.org", "greenpeace.org", "sspai.com", "www.ifrc.org", "ifrc.org", "www.unocha.org", "unocha.org", "care.org", "www.care.org"]);
const TRANSLATE_DISABLED = /^(0|off|false)$/i.test(process.env.YIHOT_TRANSLATE || "");
const TRANSLATE_BASE_URL = (process.env.YIHOT_TRANSLATE_BASE_URL || "").replace(/\/+$/, "");
const TRANSLATE_MODEL = process.env.YIHOT_TRANSLATE_MODEL || "moonshot-v1-8k";
const TRANSLATE_API_KEY = process.env.YIHOT_TRANSLATE_API_KEY || "";
const ALLOWED_ORIGINS = new Set(["https://cochranek.github.io", "http://127.0.0.1:8766", "http://localhost:8766", "http://127.0.0.1:8790", "http://localhost:8790"]);

const translationCache = new Map();
const translatedXmlByHash = new Map(); // contentHash -> 已翻译 XML，避免同内容反复翻译
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
let lastTranslateStats = null;
let cache = null;
let lastRefreshError = null;
let refreshPromise = null;

function isAllowedSourceHost(hostname) {
  const value = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  return [...ALLOWED_SOURCE_HOSTS].some((host) => value === host || value.endsWith(`.${host}`));
}

function isBlockedAddress(address) {
  const value = String(address).toLowerCase();
  if (net.isIPv4(value)) {
    const [a, b] = value.split(".").map(Number);
    return a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) || a === 127 || (a === 169 && b === 254) || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224;
  }
  if (net.isIPv6(value)) return value === "::" || value === "::1" || value.startsWith("::ffff:") || value.toLowerCase().startsWith("fc") || value.toLowerCase().startsWith("fd") || value.toLowerCase().startsWith("fe80");
  return true;
}

async function assertPublicTarget(target) {
  const hostname = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local")) throw new Error("source host not allowed");
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) throw new Error("source resolves to a blocked address");
}

function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function readFeeds() {
  const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, "feeds.json"), "utf8"));
  if (!Array.isArray(parsed)) throw new Error("feeds.json must contain an array");
  const seen = new Set();
  return parsed.map((source) => {
    if (!source || !ALLOWED_SOURCE_IDS.has(String(source.id)) || seen.has(source.id)) throw new Error("feeds.json id is not allowlisted");
    const url = new URL(String(source.url || ""));
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !isAllowedSourceHost(hostname)) throw new Error("source host is not allowlisted");
    seen.add(source.id);
    return { id: String(source.id), name: String(source.name || source.id), url: url.href };
  });
}

async function readBody(response) {
  const reader = response.body?.getReader();
  if (!reader) {
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_BYTES) throw new Error("source too large");
    return body;
  }
  let total = 0; const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { await reader.cancel().catch(() => {}); throw new Error("source too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function fetchSource(source, previous) {
  let target = new URL(source.url);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = { "user-agent": USER_AGENT, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8", "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" };
  if (previous?.etag) headers["if-none-match"] = previous.etag;
  if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;
  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      await assertPublicTarget(target);
      const response = await fetch(target, { redirect: "manual", signal: controller.signal, headers });
      if (response.status >= 300 && response.status < 400) {
        if (redirectCount === MAX_REDIRECTS) throw new Error("too many redirects");
        const location = response.headers.get("location");
        if (!location) throw new Error("redirect missing location");
        const next = new URL(location, target);
        if (next.protocol !== "https:" || !isAllowedSourceHost(next.hostname)) throw new Error("redirect leaves allowlist");
        await response.body?.cancel().catch(() => {});
        target = next;
        continue;
      }
      const fetchedAt = new Date().toISOString();
      if (response.status === 304) {
        if (!previous?.xml) throw new Error("304 without cached source");
        return { ...source, status: "ok", xml: previous.xml, contentHash: previous.contentHash || digest(previous.xml), fetchedAt, lastSuccessAt: fetchedAt, etag: previous.etag, lastModified: previous.lastModified, notModified: true, stale: false, error: null };
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      if (!/xml|rss|atom|text|html/i.test(contentType)) throw new Error("non-text source");
      const xml = await readBody(response);
      if (!xml.trim()) throw new Error(`empty source response (${response.status})`);
      return { ...source, status: "ok", xml, contentHash: digest(xml), fetchedAt, lastSuccessAt: fetchedAt, etag: response.headers.get("etag") || null, lastModified: response.headers.get("last-modified") || null, notModified: false, stale: false, error: null };
    }
    throw new Error("source fetch failed");
  } finally { clearTimeout(timer); }
}

function sourceFingerprint(source) { return `${source.id}:${source.status}:${source.contentHash || "none"}`; }

function sourceMeta(source) {
  return { id: source.id, name: source.name, url: source.url, status: source.status, stale: Boolean(source.stale), error: source.error || null, lastAttemptAt: source.lastAttemptAt || null, lastSuccessAt: source.lastSuccessAt || null, fetchedAt: source.fetchedAt || null, notModified: Boolean(source.notModified), contentHash: source.contentHash || null, etag: source.etag || null, lastModified: source.lastModified || null };
}

function responseEtag(snapshot) { return `"yihot-${snapshot.version}-${digest(snapshot.fingerprint).slice(0, 24)}"`; }

async function refreshFeeds({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.refreshedAtMs < REFRESH_INTERVAL_MS) return cache;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const startedAt = new Date().toISOString(); const startedMs = Date.now();
    const sources = readFeeds();
    const previousById = new Map((cache?.sources || []).map((source) => [source.id, source]));
    const settled = await Promise.all(sources.map(async (source) => {
      const previous = previousById.get(source.id); const attempt = { ...source, lastAttemptAt: startedAt };
      try { return { ...(await fetchSource(source, previous)), lastAttemptAt: startedAt }; }
      catch (error) {
        return { ...attempt, status: "error", error: String(error?.message || error).slice(0, 300), fetchedAt: startedAt, lastSuccessAt: previous?.lastSuccessAt || null, etag: previous?.etag || null, lastModified: previous?.lastModified || null, contentHash: previous?.contentHash || null, xml: previous?.xml || null, stale: Boolean(previous?.xml), notModified: false };
      }
    }));
    const fingerprint = settled.map(sourceFingerprint).join("|");
    const translatedSources = await translateSettledSources(settled, startedMs + TRANSLATE_BUDGET_MS);
    const version = cache && cache.fingerprint === fingerprint ? cache.version : (cache?.version || 0) + 1;
    const refreshedAt = new Date().toISOString();
    const snapshot = { version, fingerprint, refreshedAtMs: Date.now(), refreshedAt, refreshStartedAt: startedAt, refreshFinishedAt: refreshedAt, refreshDurationMs: Date.now() - startedMs, nextRefreshAt: new Date(Date.now() + REFRESH_INTERVAL_MS).toISOString(), sources: translatedSources };
    snapshot.etag = responseEtag(snapshot); cache = snapshot; lastRefreshError = null;
    return snapshot;
  })().catch((error) => { lastRefreshError = { message: String(error?.message || error).slice(0, 300), at: new Date().toISOString() }; if (cache) return cache; throw error; }).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function snapshotForRequest(force = false) {
  if (force || !cache) return refreshFeeds({ force });
  if (Date.now() - cache.refreshedAtMs >= REFRESH_INTERVAL_MS && !refreshPromise) {
    try { return await refreshFeeds({ force: true }); } catch (error) { console.error("background feed refresh failed:", error.message); }
  }
  return cache;
}

function healthPayload() {
  const sources = (cache?.sources || []).map(sourceMeta);
  return { ok: !lastRefreshError && (!sources.length || sources.some((source) => source.status === "ok")), service: "yihot", mode: "cloudbase-public-source", version: cache?.version || 0, serverTime: new Date().toISOString(), refreshedAt: cache?.refreshedAt || null, nextRefreshAt: cache?.nextRefreshAt || null, refreshIntervalMs: REFRESH_INTERVAL_MS, refreshInProgress: Boolean(refreshPromise), lastRefreshError, sources, summary: { total: sources.length, ok: sources.filter((source) => source.status === "ok").length, error: sources.filter((source) => source.status === "error").length, stale: sources.filter((source) => source.stale).length }, translate: TRANSLATE_DISABLED || !TRANSLATE_BASE_URL ? "off" : "on", translateStats: lastTranslateStats };
}

function feedsPayload(snapshot) {
  // 出站裁剪：缓存保留全量 XML（用于指纹/304），只把每源前 30 条、摘要截断后的内容发给前端，降低轮询流量
  return { ok: true, mode: "cloudbase-public-source", version: snapshot.version, etag: snapshot.etag, serverTime: new Date().toISOString(), fetchedAt: snapshot.refreshedAt, refreshedAt: snapshot.refreshedAt, lastAttemptAt: snapshot.refreshStartedAt, lastSuccessAt: snapshot.sources.map((source) => source.lastSuccessAt).filter(Boolean).sort().at(-1) || null, nextRefreshAt: snapshot.nextRefreshAt, refreshIntervalMs: REFRESH_INTERVAL_MS, refreshInProgress: Boolean(refreshPromise), summary: { total: snapshot.sources.length, ok: snapshot.sources.filter((source) => source.status === "ok").length, error: snapshot.sources.filter((source) => source.status === "error").length, stale: snapshot.sources.filter((source) => source.stale).length }, sources: snapshot.sources.map((source) => ({ ...source, xml: source.xml ? trimFeedXml(source.xml) : source.xml })) };
}

function truncateXmlText(value, max) {
  const text = String(value || "");
  if (text.length <= max) return text;
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) return `<![CDATA[${cdata[1].slice(0, max)}…]]>`;
  let cut = text.slice(0, max);
  const amp = cut.lastIndexOf("&");
  if (amp !== -1 && !/&#?\w+;/.test(cut.slice(amp))) cut = cut.slice(0, amp);
  if (cut.lastIndexOf("<") > cut.lastIndexOf(">")) cut = cut.slice(0, cut.lastIndexOf("<"));
  return `${cut}…`;
}

function trimFeedXml(xml, maxItems = 30, maxDesc = 400) {
  const rss = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)];
  const blocks = rss.length ? rss : [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/g)];
  let out = xml;
  if (blocks.length > maxItems) {
    const cutAt = blocks[maxItems].index;
    const closeAt = Math.max(xml.lastIndexOf("</channel>"), xml.lastIndexOf("</feed>"));
    out = closeAt > cutAt ? xml.slice(0, cutAt) + xml.slice(closeAt) : xml.slice(0, cutAt);
  }
  // content:encoded 是 WordPress 全文副本，前端不消费，直接整段移除
  out = out.replace(/<content:encoded[\s>][\s\S]*?<\/content:encoded>/g, "");
  // WHO 等 feed 的 a10:content（Atom 命名空间全文）同样不被前端消费
  out = out.replace(/<a10:content[\s>][\s\S]*?<\/a10:content>/g, "");
  return out.replace(/<(description|summary)(\s[^>]*)?>([\s\S]*?)<\/\1>/g, (match, tag, attrs, body) => `<${tag}${attrs || ""}>${truncateXmlText(body, maxDesc)}</${tag}>`);
}

async function translateChunk(chunk) {
  const headers = { "content-type": "application/json" };
  if (TRANSLATE_API_KEY) headers.authorization = `Bearer ${TRANSLATE_API_KEY}`;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${TRANSLATE_BASE_URL}/chat/completions`, { method: "POST", headers, signal: controller.signal, body: JSON.stringify({ model: TRANSLATE_MODEL, temperature: 0, messages: [
      { role: "system", content: "你是新闻翻译引擎。用户会给你多行文本（每行一条）。把每一行翻译成简体中文，保留专有名词与数字。输出必须也是每行一条，与输入逐行对应、行数一致；不要编号、不要引号包裹、不要输出任何其他内容。" },
      { role: "user", content: chunk.join("\n") },
    ] }) });
    if (!response.ok) throw new Error(`translate upstream HTTP ${response.status}`);
    const payload = await response.json();
    const content = String(payload?.choices?.[0]?.message?.content || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    // 容错解析：优先按行切分；若行数不符再尝试 JSON 数组（含中文引号修复）
    let lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length !== chunk.length) {
      try {
        const parsed = JSON.parse(content.replace(/[\u201C\u201D]/g, "\""));
        if (Array.isArray(parsed) && parsed.length === chunk.length) lines = parsed.map((value) => String(value ?? "").trim());
      } catch { /* keep line-based attempt below */ }
    }
    if (lines.length !== chunk.length) throw new Error(`translate shape mismatch (${lines.length}/${chunk.length})`);
    // 去掉模型偶尔加的列表前缀（如 “1. ” / “- ”），但保留以数字开头的正常译文（如 “2026年…”）
    return lines.map((value) => String(value).replace(/^(?:\d+\s*[.、)）:：]|[-*•])\s*/, "").trim());
  } finally { clearTimeout(timer); }
}

async function translateTexts(texts) {
  if (TRANSLATE_DISABLED || !TRANSLATE_BASE_URL) return texts;
  const pending = [...new Set(texts.filter((text) => !translationCache.has(text)))];
  const SEND_MAX = 900;
  for (let i = 0; i < pending.length; i += 10) {
    const chunkFull = pending.slice(i, i + 10);
    const chunkSend = chunkFull.map((text) => (text.length > SEND_MAX ? text.slice(0, SEND_MAX) : text));
    try { const translated = await translateChunk(chunkSend); chunkFull.forEach((full, index) => translationCache.set(full, translated[index] || full)); }
    catch (error) { console.error("YIHOT translate failed:", error.message); }
  }
  return texts.map((text) => translationCache.get(text) ?? text);
}

// ── 服务端预翻译：抓取时把英文条目的标题/摘要译成中文，前端直接展示 ──
// 只动 item/entry 块；频道级标题不动。译文以 CDATA 回写，翻译结果按内容哈希缓存，
// 未译完的源不缓存、下个刷新周期续翻（translationCache 按句缓存，重试只翻剩余英文）。
function extractXmlText(body) {
  let text = String(body || "").trim();
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) text = cdata[1];
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
  text = text.replace(/&#(\d+);/g, (match, code) => { try { return String.fromCodePoint(Number(code)); } catch { return " "; } });
  return text.replace(/\s+/g, " ").trim();
}
function needsTranslation(text) { return Boolean(text) && !CJK_RE.test(text) && /[A-Za-z]/.test(text); }
function translateItemBlock(block, zhMap) {
  return block.replace(/<(title|description|summary)(\s[^>]*)?>([\s\S]*?)<\/\1>/g, (match, tag, attrs, body) => {
    const zh = zhMap.get(extractXmlText(body));
    if (!zh) return match;
    const safe = String(zh).replace(/\]\]>/g, "]]]]><![CDATA[>");
    return `<${tag}${attrs || ""}><![CDATA[${safe}]]></${tag}>`;
  });
}
async function translateSettledSources(settled, deadlineMs) {
  if (TRANSLATE_DISABLED || !TRANSLATE_BASE_URL) return settled;
  const stats = { sources: 0, cacheHits: 0, pendingTexts: 0, translatedTexts: 0, remaining: 0, deadlineHit: false, error: null, at: new Date().toISOString() };
  const work = [];
  const out = settled.map((source) => {
    if (source.status !== "ok" || !source.xml) return source;
    stats.sources += 1;
    if (translatedXmlByHash.has(source.contentHash)) { stats.cacheHits += 1; return { ...source, xml: translatedXmlByHash.get(source.contentHash) }; }
    const itemBlocks = [...source.xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)];
    const blocks = itemBlocks.length ? itemBlocks : [...source.xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/g)];
    const texts = [];
    for (const block of blocks) for (const field of block[0].matchAll(/<(title|description|summary)(\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
      const text = extractXmlText(field[3]);
      if (needsTranslation(text)) texts.push(text);
    }
    if (!texts.length) { translatedXmlByHash.set(source.contentHash, source.xml); return source; }
    const next = { ...source };
    work.push({ source: next, texts });
    return next;
  });
  const pending = [...new Set(work.flatMap(({ texts }) => texts).filter((text) => !translationCache.has(text)))];
  stats.pendingTexts = pending.length;
  // 每批 10 条、单条截断到 400 字符：前端摘要本就只展示 ~400 字符，截短可显著加快翻译；
  // moonshot-v1-8k 较慢（约 13s/批），每轮最多 3 批并发，在预算内尽量多翻，未译完的下轮续翻
  const SEND_MAX = 400;
  const CHUNK = 10;
  const CONCURRENCY = 3;
  for (let i = 0; i < pending.length; i += CHUNK * CONCURRENCY) {
    if (deadlineMs - Date.now() <= 15_000) { stats.deadlineHit = true; break; }
    const batch = [];
    for (let j = i; j < Math.min(i + CHUNK * CONCURRENCY, pending.length); j += CHUNK) batch.push(pending.slice(j, j + CHUNK));
    const results = await Promise.all(batch.map(async (chunkFull) => {
      if (deadlineMs - Date.now() <= 15_000) return 0;
      const chunkSend = chunkFull.map((text) => (text.length > SEND_MAX ? text.slice(0, SEND_MAX) : text));
      try {
        const translated = await translateChunk(chunkSend);
        chunkFull.forEach((full, index) => translationCache.set(full, translated[index] || full));
        return chunkFull.length;
      } catch (error) { if (!stats.error) stats.error = String(error?.message || error).slice(0, 160); console.error("YIHOT pre-translate failed:", error.message); return 0; }
    }));
    stats.translatedTexts += results.reduce((a, b) => a + b, 0);
  }
  for (const { source, texts } of work) {
    const zhMap = new Map();
    for (const text of texts) { const zh = translationCache.get(text); if (zh && zh !== text) zhMap.set(text, zh); }
    const complete = texts.every((text) => translationCache.has(text));
    if (!complete) stats.remaining += texts.filter((text) => !translationCache.has(text)).length;
    const translatedXml = source.xml.replace(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/g, (block) => translateItemBlock(block, zhMap));
    source.xml = translatedXml;
    if (complete) translatedXmlByHash.set(source.contentHash, translatedXml);
  }
  stats.cacheTexts = translationCache.size; stats.cacheXml = translatedXmlByHash.size;
  lastTranslateStats = stats;
  return out;
}

function corsOrigin(event) {
  const headers = event.headers || event.multiValueHeaders || {};
  const origin = String(headers.origin || headers.Origin || "");
  return ALLOWED_ORIGINS.has(origin) ? origin : "https://cochranek.github.io";
}

function corsHeaders(origin) {
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600", Vary: "Origin" };
}

function respond(status, body, origin, extra = {}) {
  return { statusCode: status, headers: Object.assign(corsHeaders(origin), { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, extra), body: JSON.stringify(body) };
}

exports.main = async (event) => {
  const method = String(event.httpMethod || event.method || "GET").toUpperCase();
  const origin = corsOrigin(event);
  if (method === "OPTIONS") return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  const requestPath = String(event.path || (event.requestContext && event.requestContext.path) || "/").split("?")[0];
  try {
    if (requestPath.endsWith("/api/probe") && method === "GET") {
      // 固定候选列表诊断（不接受任意 URL）：从云出口看哪些公开源可达
      const PROBE_URLS = [
        "https://www.chinadevelopmentbrief.org.cn/feed",
        "http://www.gongyishibao.com/rss.xml",
        "https://www.naradafoundation.org/feed",
        "https://www.cn.undp.org/content/cpm/zh/home/rss/pressreleases.rss",
        "https://www.care.org/feed/",
        "https://www.unicef.org/rss.xml",
        "https://www.thenewhumanitarian.org/rss.xml",
        "https://www.iied.org/rss.xml",
        "https://ssir.org/feed",
        "https://feeds.bbci.co.uk/news/world/rss.xml",
        "https://feeds.bbci.co.uk/news/health/rss.xml",
        "https://feeds.bbci.co.uk/news/science-environment/rss.xml",
        "https://www.theguardian.com/society/rss",
        "https://www.theguardian.com/environment/rss",
        "https://www.theguardian.com/world/rss",
        "https://feeds.reuters.com/reuters/businessNews",
        "https://feeds.reuters.com/reuters/healthNews",
        "https://feeds.ap.org/rss/topnews",
        "https://philanthropynewsdigest.org/feed",
        "https://www.devex.com/news/feed",
        "https://www.globalgiving.org/rss.xml",
        "https://www.usaid.gov/feed/news",
        "https://www.gov.uk/world/rss.xml",
        "https://tophub.today/c/WLvVMEdbG3",
        "https://www.huxiu.com/rss/0.xml",
        "https://36kr.com/feed",
        "https://feeds.feedburner.com/zhihu/daily",
      ];
      const results = await Promise.all(PROBE_URLS.map(async (u) => {
        const t0 = Date.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          const res = await fetch(new URL(u), { redirect: "manual", signal: controller.signal, headers: { "user-agent": USER_AGENT, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8", "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" } });
          clearTimeout(timer);
          let size = 0; const chunks = [];
          try {
            const reader = res.body?.getReader();
            if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size <= 60000) chunks.push(Buffer.from(value)); if (size > 400000) break; }
          } catch {}
          const head = Buffer.concat(chunks).toString("utf8");
          const dates = [...head.matchAll(/<(?:pubDate|published|updated|dc:date)[^>]*>([^<]+)</g)].map((m) => m[1].trim());
          let newest = null;
          for (const d of dates) { const ts = Date.parse(d); if (Number.isFinite(ts) && (newest === null || ts > newest)) newest = ts; }
          return { u, status: res.status, ms: Date.now() - t0, size, ct: res.headers.get("content-type"), loc: res.headers.get("location") || undefined, newest: newest ? new Date(newest).toISOString() : null, items: (head.match(/<item[\s>]/g) || []).length || (head.match(/<entry[\s>]/g) || []).length };
        } catch (error) {
          return { u, error: String(error?.message || error).slice(0, 120), ms: Date.now() - t0 };
        }
      }));
      return respond(200, { results }, origin);
    }
    if (requestPath.endsWith("/api/health") && method === "GET") {
      if (!cache) await snapshotForRequest(false);
      return respond(200, healthPayload(), origin);
    }
    if (requestPath.endsWith("/api/feeds") && method === "GET") {
      const force = /[?&](refresh|force)=1/.test(String(event.path || ""));
      const snapshot = await snapshotForRequest(force);
      return respond(200, feedsPayload(snapshot), origin, { etag: snapshot.etag });
    }
    if (requestPath.endsWith("/api/translate") && method === "POST") {
      if (TRANSLATE_DISABLED || !TRANSLATE_BASE_URL) return respond(503, { error: "translate disabled" }, origin);
      const raw = event.isBase64Encoded ? Buffer.from(String(event.body || ""), "base64").toString("utf8") : String(event.body || "");
      let texts; try { texts = JSON.parse(raw)?.texts; } catch { return respond(400, { error: "bad request" }, origin); }
      if (!Array.isArray(texts)) return respond(400, { error: "texts must be an array" }, origin);
      const cleaned = texts.slice(0, 60).map((text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 1200)).filter(Boolean);
      return respond(200, { translations: await translateTexts(cleaned) }, origin);
    }
    return respond(404, { error: "not found", service: "yihot" }, origin);
  } catch (error) {
    return respond(500, { error: String(error?.message || error).slice(0, 200) }, origin);
  }
};
