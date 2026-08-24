// YIHOT static bake: fetch allowlist feeds, translate English items, and write
// data/feeds.json so the page can run on GitHub Pages without any server.
// Usage: node bake.mjs
//   YIHOT_TRANSLATE_BASE_URL / YIHOT_TRANSLATE_API_KEY / YIHOT_TRANSLATE_MODEL
//   point at any OpenAI-compatible chat endpoint; YIHOT_TRANSLATE=off skips
//   translation entirely (items then stay in their original language).
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(ROOT, "data", "feeds.json");
const TIMEOUT_MS = Number(process.env.YIHOT_TIMEOUT_MS) || 10_000;
const MAX_BYTES = 700_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) YIHOT/1.0 RSS-Reader";
const TRANSLATE_DISABLED = /^(0|off|false)$/i.test(process.env.YIHOT_TRANSLATE || "");
const TRANSLATE_BASE_URL = (process.env.YIHOT_TRANSLATE_BASE_URL || "").replace(/\/+$/, "");
const TRANSLATE_MODEL = process.env.YIHOT_TRANSLATE_MODEL || "moonshot-v1-8k";
const TRANSLATE_API_KEY = process.env.YIHOT_TRANSLATE_API_KEY || "";
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const needsTranslation = (text) => Boolean(text) && !CJK_RE.test(text) && /[A-Za-z]/.test(text);

async function fetchText(url) {
  let target = new URL(url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(target, { redirect: "manual", signal: controller.signal, headers: { "user-agent": USER_AGENT, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8", "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("redirect missing location");
        await response.body?.cancel().catch(() => {});
        target = new URL(location, target);
        if (target.protocol !== "https:") throw new Error("redirect left https");
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("source too large");
      if (!text.trim()) throw new Error(`empty source response (${response.status})`);
      return text;
    } finally { clearTimeout(timer); }
  }
  throw new Error("too many redirects");
}

function decodeXml(text) {
  return String(text || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").trim();
}

function pickField(block, tags) {
  for (const tag of tags) {
    const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (match) return decodeXml(match[1]);
  }
  return "";
}

function parseItems(xml, source) {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return blocks.slice(0, 30).map((block) => {
    const title = pickField(block, ["title"]) || "无标题公开更新";
    const summary = pickField(block, ["description", "summary", "content"]).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
    const linkAttr = block.match(/<link\b[^>]*href="([^"]+)"/i);
    const linkText = block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
    const url = decodeXml(linkAttr?.[1] || linkText?.[1] || "") || source.url;
    const published = pickField(block, ["pubDate", "published", "updated", "dc:date", "date"]) || new Date().toISOString();
    const id = `${source.id}-${crypto.createHash("sha1").update(`${url}|${title}`).digest("hex").slice(0, 16)}`;
    return { id, sourceId: source.id, title, summary, url, published, source: source.name, sourceType: "RSS/Atom" };
  }).filter((item) => item.title !== "无标题公开更新" || item.summary);
}

async function translateChunk(chunk) {
  const headers = { "content-type": "application/json" };
  if (TRANSLATE_API_KEY) headers.authorization = `Bearer ${TRANSLATE_API_KEY}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
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

async function translateItems(items) {
  if (TRANSLATE_DISABLED || !TRANSLATE_BASE_URL) { console.log(TRANSLATE_DISABLED ? "translate: disabled" : "translate: no YIHOT_TRANSLATE_BASE_URL, keeping originals"); return 0; }
  const texts = [];
  for (const item of items) { if (needsTranslation(item.title)) texts.push(item.title); if (needsTranslation(item.summary)) texts.push(item.summary); }
  const unique = [...new Set(texts)];
  const memory = new Map();
  for (let i = 0; i < unique.length; i += 20) {
    const chunk = unique.slice(i, i + 20);
    try { const translated = await translateChunk(chunk); chunk.forEach((text, index) => memory.set(text, translated[index] || text)); }
    catch (error) { console.error(`translate chunk failed: ${error.message}`); }
  }
  let count = 0;
  for (const item of items) {
    if (needsTranslation(item.title) && memory.get(item.title)) { item.title = memory.get(item.title); count += 1; }
    if (needsTranslation(item.summary) && memory.get(item.summary)) { item.summary = memory.get(item.summary); }
  }
  return count;
}

const feeds = JSON.parse(await fs.readFile(path.join(ROOT, "feeds.json"), "utf8"));
if (!Array.isArray(feeds) || !feeds.length) throw new Error("feeds.json must be a non-empty array");
const sources = [];
const items = [];
for (const feed of feeds) {
  const source = { id: String(feed.id), name: String(feed.name || feed.id), url: String(feed.url) };
  try {
    const xml = await fetchText(source.url);
    const parsed = parseItems(xml, source);
    sources.push({ ...source, status: "ok", lastSuccessAt: new Date().toISOString(), itemCount: parsed.length });
    items.push(...parsed);
    console.log(`ok      ${source.id}: ${parsed.length} items`);
  } catch (error) {
    sources.push({ ...source, status: "error", error: String(error?.message || error).slice(0, 200) });
    console.error(`error   ${source.id}: ${error.message}`);
  }
}
const translated = await translateItems(items);
const bakedAt = new Date().toISOString();
const payload = { ok: sources.some((source) => source.status === "ok"), mode: "baked-static", version: Date.parse(bakedAt), bakedAt, refreshedAt: bakedAt, lastSuccessAt: sources.map((source) => source.lastSuccessAt).filter(Boolean).sort().at(-1) || null, refreshIntervalMs: 0, sources, items, summary: { total: sources.length, ok: sources.filter((source) => source.status === "ok").length, error: sources.filter((source) => source.status === "error").length, items: items.length, translated } };
await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
await fs.writeFile(OUT_FILE, JSON.stringify(payload, null, 2));
console.log(`baked ${items.length} items (${translated} translated) -> ${path.relative(ROOT, OUT_FILE)}`);
if (!payload.ok) { console.error("all sources failed"); process.exit(1); }
