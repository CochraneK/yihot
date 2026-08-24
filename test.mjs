import assert from "node:assert/strict";

const base = process.env.YIHOT_URL || "http://127.0.0.1:8790";

async function get(path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, cache: "no-store" });
  return response;
}

const healthResponse = await get("/api/health");
assert.equal(healthResponse.status, 200, "health endpoint should respond 200");
const health = await healthResponse.json();
assert.equal(health.service, "yihot");
assert.equal(health.mode, "public-source-only");
assert.ok(Array.isArray(health.sources));

const feedsResponse = await get("/api/feeds");
assert.equal(feedsResponse.status, 200, "feeds endpoint should respond 200");
assert.ok(feedsResponse.headers.get("etag"), "feeds should expose an ETag");
assert.ok(feedsResponse.headers.get("last-modified"), "feeds should expose Last-Modified");
const feeds = await feedsResponse.json();
assert.equal(feeds.ok, true);
assert.ok(Array.isArray(feeds.sources));
assert.ok(feeds.nextRefreshAt);

const conditional = await get("/api/feeds", { headers: { "if-none-match": feedsResponse.headers.get("etag") } });
assert.equal(conditional.status, 304, "matching ETag should produce 304");

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5000);
try {
  const streamResponse = await get("/api/stream", { signal: controller.signal, headers: { accept: "text/event-stream" } });
  assert.equal(streamResponse.status, 200, "SSE endpoint should respond 200");
  assert.match(streamResponse.headers.get("content-type") || "", /text\/event-stream/);
  const reader = streamResponse.body.getReader();
  let text = "";
  while (!text.includes("event: snapshot") && text.length < 20_000) {
    const { done, value } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString("utf8");
  }
  assert.match(text, /event: snapshot/);
  assert.match(text, /"type":"snapshot"/);
  await reader.cancel();
} finally {
  clearTimeout(timeout);
  controller.abort();
}

console.log(`YIHOT smoke test: PASS (${feeds.sources.length} sources, version ${feeds.version})`);
