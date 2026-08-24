import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import crypto from "node:crypto";
import { URL, fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
function boundedNumber(value, fallback, minimum) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback; }
const PORT = boundedNumber(process.env.YIHOT_PORT ?? process.env.CIVIC_RADAR_PORT, 8790, 1);
const MAX_BYTES = 700_000;
const TIMEOUT_MS = boundedNumber(process.env.YIHOT_TIMEOUT_MS ?? process.env.CIVIC_RADAR_TIMEOUT_MS, 8000, 1000);
const REFRESH_INTERVAL_MS = boundedNumber(process.env.YIHOT_REFRESH_MS ?? process.env.CIVIC_RADAR_REFRESH_MS, 60_000, 15_000);
const MAX_REDIRECTS = 3;
const ALLOWED_SOURCE_IDS = new Set(["reliefweb", "un-news", "un-official"]);
const ALLOWED_SOURCE_HOSTS = new Set(["reliefweb.int", "news.un.org", "www.un.org", "un.org"]);
const TRANSLATE_DISABLED = /^(0|off|false)$/i.test(process.env.YIHOT_TRANSLATE || "");
const TRANSLATE_BASE_URL = (process.env.YIHOT_TRANSLATE_BASE_URL || "http://127.0.0.1:8797/v1").replace(/\/+$/, "");
const TRANSLATE_MODEL = process.env.YIHOT_TRANSLATE_MODEL || "moonshot-v1-8k";
const TRANSLATE_API_KEY = process.env.YIHOT_TRANSLATE_API_KEY || "";
const translationCache = new Map();
const streamClients = new Set();

function isAllowedSourceHost(hostname) {
  const value = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  return [...ALLOWED_SOURCE_HOSTS].some((host) => value === host || value.endsWith(`.${host}`));
}

function isBlockedAddress(address) {
  const value = String(address).toLowerCase();
  if (net.isIPv4(value)) {
    const [a, b] = value.split(".").map(Number);
    return a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || a >= 224;
  }
  if (net.isIPv6(value)) return value === "::" || value === "::1" || value.startsWith("::ffff:") || value.startsWith("2001:db8") || /^f[cd]/.test(value) || /^fe[89ab]/.test(value) || value.startsWith("ff");
  return true;
}

async function assertPublicTarget(target) {
  const hostname = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local")) throw new Error("source host is not public");
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) throw new Error("source host resolves to a non-public address");
}

async function readFeeds() {
  const parsed = JSON.parse(await fs.readFile(path.join(ROOT, "feeds.json"), "utf8"));
  if (!Array.isArray(parsed)) throw new Error("feeds.json must contain an array");
  const seen = new Set();
  return parsed.map((source) => {
    if (!source || !ALLOWED_SOURCE_IDS.has(String(source.id)) || seen.has(source.id)) throw new Error("invalid or duplicate source id");
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
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { await reader.cancel().catch(() => {}); throw new Error("source too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function httpDate(value) { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toUTCString() : new Date().toUTCString(); }
function sourceFingerprint(source) { return `${source.id}:${source.status}:${source.contentHash || ""}`; }
function sourceMeta(source) {
  return { id: source.id, name: source.name, url: source.url, status: source.status, stale: Boolean(source.stale), error: source.error || null, lastAttemptAt: source.lastAttemptAt || null, lastSuccessAt: source.lastSuccessAt || null, fetchedAt: source.fetchedAt || null, notModified: Boolean(source.notModified), contentHash: source.contentHash || null, etag: source.etag || null, lastModified: source.lastModified || null };
}

async function fetchSource(source, previous) {
  let target = new URL(source.url);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) YIHOT/1.0 RSS-Reader", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8", "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" };
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

// Optional LLM translation: the yihot server relays batches of English item
// text to an OpenAI-compatible chat endpoint (local gateway by default) and
// caches results in memory so unchanged content is never re-billed.
async function translateChunk(chunk) {
  const headers = { "content-type": "application/json" };
  if (TRANSLATE_API_KEY) headers.authorization = `Bearer ${TRANSLATE_API_KEY}`;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${TRANSLATE_BASE_URL}/chat/completions`, { method: "POST", headers, signal: controller.signal, body: JSON.stringify({ model: TRANSLATE_MODEL, temperature: 0, messages: [
      { role: "system", content: "你是新闻翻译引擎。用户会给你一个 JSON 数组，把每个元素逐条翻译成简体中文，保留专有名词与数字。只输出 JSON 数组，元素数量和顺序与输入完全一致，不要输出任何其他内容。" },
      { role: "user", content: JSON.stringify(chunk) },
    ] }) });
    if (!response.ok) throw new Error(`translate upstream HTTP ${response.status}`);
    const payload = await response.json();
    const content = String(payload?.choices?.[0]?.message?.content || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed) || parsed.length !== chunk.length) throw new Error("translate shape mismatch");
    return parsed.map((value) => String(value ?? "").trim());
  } finally { clearTimeout(timer); }
}

async function translateTexts(texts) {
  if (TRANSLATE_DISABLED) return texts;
  const pending = [...new Set(texts.filter((text) => !translationCache.has(text)))];
  for (let i = 0; i < pending.length; i += 20) {
    const chunk = pending.slice(i, i + 20);
    try { const translated = await translateChunk(chunk); chunk.forEach((text, index) => translationCache.set(text, translated[index] || text)); }
    catch (error) { console.error("YIHOT translate failed:", error.message); }
  }
  return texts.map((text) => translationCache.get(text) ?? text);
}

function readRequestBody(req, limit = 128_000) {
  return new Promise((resolve, reject) => {
    let total = 0; const chunks = [];
    req.on("data", (chunk) => { total += chunk.length; if (total > limit) { reject(new Error("request too large")); req.destroy(); return; } chunks.push(chunk); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

let cache = null;
let refreshPromise = null;
let lastRefreshError = null;

function responseEtag(snapshot) { return `"yihot-${snapshot.version}-${digest(snapshot.fingerprint).slice(0, 24)}"`; }
function streamPayload(snapshot) {
  return { type: "snapshot", version: snapshot.version, serverTime: new Date().toISOString(), refreshedAt: snapshot.refreshedAt, nextRefreshAt: snapshot.nextRefreshAt, refreshIntervalMs: REFRESH_INTERVAL_MS, changedSources: snapshot.changedSources, unchangedSources: snapshot.unchangedSources, sources: snapshot.sources.map(sourceMeta) };
}
function broadcast(snapshot) {
  // Publish every completed refresh, including unchanged source content. The
  // metadata carries the new refreshedAt/nextRefreshAt values so connected
  // clients can distinguish a healthy no-op sync from a stalled stream.
  const packet = `event: update\ndata: ${JSON.stringify(streamPayload(snapshot))}\n\n`;
  for (const client of streamClients) { try { client.write(packet); } catch { streamClients.delete(client); } }
}

async function refreshFeeds({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.refreshedAtMs < REFRESH_INTERVAL_MS) return cache;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const startedAt = new Date().toISOString(); const startedMs = Date.now();
    const sources = await readFeeds();
    const previousById = new Map((cache?.sources || []).map((source) => [source.id, source]));
    const settled = await Promise.all(sources.map(async (source) => {
      const previous = previousById.get(source.id); const attempt = { ...source, lastAttemptAt: startedAt };
      try { return { ...(await fetchSource(source, previous)), lastAttemptAt: startedAt }; }
      catch (error) {
        return { ...attempt, status: "error", error: String(error?.message || error).slice(0, 300), fetchedAt: startedAt, lastSuccessAt: previous?.lastSuccessAt || null, etag: previous?.etag || null, lastModified: previous?.lastModified || null, contentHash: previous?.contentHash || null, xml: previous?.xml || null, stale: Boolean(previous?.xml), notModified: false };
      }
    }));
    const fingerprint = settled.map(sourceFingerprint).join("|");
    const changedSources = settled.filter((source) => { const old = previousById.get(source.id); return !old || old.contentHash !== source.contentHash || old.status !== source.status; }).map((source) => source.id);
    const unchangedSources = settled.filter((source) => !changedSources.includes(source.id)).map((source) => source.id);
    const version = cache && cache.fingerprint === fingerprint ? cache.version : (cache?.version || 0) + 1;
    const refreshedAt = new Date().toISOString();
    const snapshot = { version, fingerprint, refreshedAtMs: Date.now(), refreshedAt, refreshStartedAt: startedAt, refreshFinishedAt: refreshedAt, refreshDurationMs: Date.now() - startedMs, nextRefreshAt: new Date(Date.now() + REFRESH_INTERVAL_MS).toISOString(), sources: settled, changedSources, unchangedSources };
    snapshot.etag = responseEtag(snapshot); cache = snapshot; lastRefreshError = null;
    broadcast(snapshot);
    return snapshot;
  })().catch((error) => { lastRefreshError = { message: String(error?.message || error).slice(0, 300), at: new Date().toISOString() }; if (cache) return cache; throw error; }).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function snapshotForRequest(force = false) {
  if (force || !cache) return refreshFeeds({ force });
  if (Date.now() - cache.refreshedAtMs >= REFRESH_INTERVAL_MS && !refreshPromise) refreshFeeds({ force: true }).catch((error) => console.error("background YIHOT feed refresh failed:", error.message));
  return cache;
}

function json(res, status, payload, headers = {}) {
  if (status === 304) { res.writeHead(304, headers); return res.end(); }
  const body = JSON.stringify(payload); res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }); res.end(body);
}
function healthPayload() {
  const sources = (cache?.sources || []).map(sourceMeta);
  return { ok: !lastRefreshError && (!sources.length || sources.some((source) => source.status === "ok")), service: "yihot", mode: "public-source-only", version: cache?.version || 0, serverTime: new Date().toISOString(), lastAttemptAt: cache?.refreshStartedAt || null, lastSuccessAt: sources.map((source) => source.lastSuccessAt).filter(Boolean).sort().at(-1) || null, refreshedAt: cache?.refreshedAt || null, nextRefreshAt: cache?.nextRefreshAt || null, refreshIntervalMs: REFRESH_INTERVAL_MS, refreshInProgress: Boolean(refreshPromise), lastRefreshError, sources, summary: { total: sources.length, ok: sources.filter((source) => source.status === "ok").length, error: sources.filter((source) => source.status === "error").length, stale: sources.filter((source) => source.stale).length } };
}

async function serveStatic(req, res) {
  let requested; try { requested = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { return json(res, 400, { error: "bad request" }); }
  if (requested.includes(":")) return json(res, 404, { error: "not found" });
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, ""); const parts = relative.split(/[\\/]/).filter(Boolean);
  if (parts.some((part) => part.replace(/[.\s]+$/g, "") === "api.txt" || part.replace(/[.\s]+$/g, "").startsWith(".env"))) return json(res, 404, { error: "not found" });
  const target = path.resolve(ROOT, relative); if (!target.startsWith(ROOT + path.sep)) return json(res, 403, { error: "forbidden" });
  try { const [realRoot, realTarget] = await Promise.all([fs.realpath(ROOT), fs.realpath(target)]); const relativeTarget = path.relative(realRoot, realTarget); if (relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) return json(res, 403, { error: "forbidden" }); const body = await fs.readFile(realTarget); const ext = path.extname(realTarget); const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" }; res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" }); res.end(body); } catch { json(res, 404, { error: "not found" }); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/stream") {
      await snapshotForRequest(false);
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      streamClients.add(res); res.write(`event: snapshot\ndata: ${JSON.stringify(streamPayload(cache))}\n\n`);
      const heartbeat = setInterval(() => { try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch { clearInterval(heartbeat); streamClients.delete(res); } }, 20_000);
      req.on("close", () => { clearInterval(heartbeat); streamClients.delete(res); });
      return;
    }
    if (url.pathname === "/api/health") return json(res, 200, healthPayload(), cache?.etag ? { etag: cache.etag, "x-yihot-version": String(cache.version), "x-civic-radar-version": String(cache.version) } : {});
    if (url.pathname === "/api/feeds") {
      const force = url.searchParams.get("refresh") === "1" || url.searchParams.get("force") === "1";
      const snapshot = await snapshotForRequest(force);
      const headers = { etag: snapshot.etag, "last-modified": httpDate(snapshot.refreshedAt), "x-yihot-version": String(snapshot.version), "x-civic-radar-version": String(snapshot.version) };
      const requestedAt = Date.parse(String(req.headers["if-modified-since"] || ""));
      const snapshotTime = Date.parse(snapshot.refreshedAt);
      const unchangedSince = Number.isFinite(requestedAt) && Number.isFinite(snapshotTime) && Math.floor(requestedAt / 1000) >= Math.floor(snapshotTime / 1000);
      if ((req.headers["if-none-match"] === snapshot.etag || unchangedSince) && !url.searchParams.has("refresh") && !url.searchParams.has("force")) return json(res, 304, null, headers);
      return json(res, 200, { ok: true, mode: "allowlist-public-source", version: snapshot.version, etag: snapshot.etag, serverTime: new Date().toISOString(), fetchedAt: snapshot.refreshedAt, refreshedAt: snapshot.refreshedAt, lastAttemptAt: snapshot.refreshStartedAt, lastSuccessAt: snapshot.sources.map((source) => source.lastSuccessAt).filter(Boolean).sort().at(-1) || null, nextRefreshAt: snapshot.nextRefreshAt, refreshIntervalMs: REFRESH_INTERVAL_MS, refreshInProgress: Boolean(refreshPromise), changedSources: snapshot.changedSources, unchangedSources: snapshot.unchangedSources, summary: { total: snapshot.sources.length, ok: snapshot.sources.filter((source) => source.status === "ok").length, error: snapshot.sources.filter((source) => source.status === "error").length, stale: snapshot.sources.filter((source) => source.stale).length }, sources: snapshot.sources }, headers);
    }
    if (url.pathname === "/api/translate") {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      if (TRANSLATE_DISABLED) return json(res, 503, { error: "translate disabled" });
      let texts; try { texts = JSON.parse(await readRequestBody(req))?.texts; } catch { return json(res, 400, { error: "bad request" }); }
      if (!Array.isArray(texts)) return json(res, 400, { error: "texts must be an array" });
      const cleaned = texts.slice(0, 60).map((text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 1200)).filter(Boolean);
      return json(res, 200, { translations: await translateTexts(cleaned) });
    }
    return serveStatic(req, res);
  } catch (error) { return json(res, 500, { error: "server error", detail: String(error?.message || error).slice(0, 200) }); }
});

server.listen(PORT, "127.0.0.1", () => { console.log(`YIHOT listening on http://127.0.0.1:${PORT}`); refreshFeeds({ force: true }).catch((error) => console.error("initial YIHOT feed refresh failed:", error.message)); });
const refreshTimer = setInterval(() => { refreshFeeds({ force: true }).catch((error) => console.error("scheduled YIHOT feed refresh failed:", error.message)); }, REFRESH_INTERVAL_MS);
refreshTimer.unref?.();
