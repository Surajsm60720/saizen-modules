/**
 * Offline harness for Saizen modules.
 *
 * Stands in for ModuleRuntime: exposes the same `fetchv2(url, headers, method,
 * body)` bridge and the same response shape (ok / status / headers.get / text /
 * json), keeps one cookie jar for the run the way a resolve session's private
 * HTTPCookieStorage does, and enforces the HTTPS-only gate.
 *
 *   node modules/harness.mjs <module.js> [query]
 *   node modules/harness.mjs modules/hstream.js furachi
 *
 * Runs searchResults -> extractEpisodes -> extractStreamUrl, then probes the
 * unconfirmed quality filenames and reports which ones the CDN actually serves.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const [, , modulePath, queryArg] = process.argv;

if (!modulePath) {
  console.error('usage: node modules/harness.mjs <module.js> [query]');
  process.exit(1);
}

const query = queryArg || 'furachi';
const cookies = new Map();

function storeCookies(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function cookieHeader() {
  return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function bridgeFetch(url, headers = {}, method = 'GET', body = null) {
  if (!/^https:\/\//i.test(url)) {
    throw new Error(`runtime gate: module fetch must be https:// (got ${url})`);
  }

  const sendHeaders = { ...headers };
  const jar = cookieHeader();
  if (jar) sendHeaders.Cookie = jar;

  const init = { method, headers: sendHeaders, redirect: 'follow' };
  if (body != null && method.toUpperCase() !== 'GET') init.body = body;

  const res = await fetch(url, init);
  storeCookies(res);

  const text = await res.text();
  const lower = new Map();
  for (const [k, v] of res.headers) lower.set(k.toLowerCase(), v);

  // Swift's allHeaderFields collapses repeated Set-Cookie into one comma-joined
  // value. Node's Headers iterator emits one entry per cookie, so the loop above
  // keeps only the last and a module looking for an earlier cookie sees nothing.
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (setCookies.length) lower.set('set-cookie', setCookies.join(', '));

  console.log(`  [fetch] ${method} ${url} -> ${res.status} (${text.length}b)`);

  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    url: res.url,
    headers: { get: (name) => lower.get(String(name).toLowerCase()) ?? null },
    text: async () => text,
    json: async () => JSON.parse(text)
  };
}

function loadModule(path) {
  const source = readFileSync(resolvePath(path), 'utf8');
  const sandbox = {
    console,
    module: { exports: {} },
    fetch: (input, opts = {}) =>
      bridgeFetch(input, opts.headers ?? {}, opts.method ?? 'GET', opts.body ?? null),
    fetchv2: bridgeFetch,
    URL,
    encodeURIComponent,
    decodeURIComponent,
    JSON,
    Promise,
    Object,
    Array,
    String,
    Number,
    Math,
    RegExp,
    Error,
    parseInt,
    parseFloat
  };
  sandbox.exports = sandbox.module.exports;
  createContext(sandbox);
  runInContext(source, sandbox, { filename: path });
  return sandbox.module.exports;
}

/** Range-GET each candidate so a HEAD-hostile CDN still answers honestly. */
async function probeQualities(streamUrl, probes) {
  const base = streamUrl.slice(0, streamUrl.lastIndexOf('/'));
  const out = [];

  for (const file of probes) {
    const url = `${base}/${file}`;
    try {
      const res = await fetch(url, {
        headers: { Range: 'bytes=0-1', Referer: 'https://hstream.moe/' }
      });
      out.push({ file, status: res.status, ok: res.status === 200 || res.status === 206 });
    } catch (err) {
      out.push({ file, status: `ERR ${err.message}`, ok: false });
    }
  }

  return out;
}

async function main() {
  const mod = loadModule(modulePath);
  console.log(`\n=== searchResults(${JSON.stringify(query)}) ===`);
  const results = await mod.searchResults(query);
  console.log(`  ${results.length} series`);
  console.table(results.slice(0, 5));
  if (!results.length) throw new Error('no search results - parser or endpoint changed');

  const show = results[0];
  console.log(`\n=== extractEpisodes(${show.url}) ===`);
  const episodes = await mod.extractEpisodes(show.url);
  console.log(`  ${episodes.length} episodes`);
  console.table(episodes.slice(0, 10));
  if (!episodes.length) throw new Error('no episodes');

  const episodeUrl = episodes[0].url ?? episodes[0].href;
  console.log(`\n=== extractStreamUrl(${episodeUrl}) ===`);
  const payload = await mod.extractStreamUrl(episodeUrl);
  console.log(`  ${payload.streams.length} streams, subtitle: ${payload.subtitle ?? 'none'}`);
  console.table(payload.streams.slice(0, 6).map((s) => ({ quality: s.quality, url: s.url })));

  const first = payload.streams[0];
  console.log('\n=== playability check (confirmed quality) ===');
  const head = await fetch(first.url, { headers: { ...first.headers, Range: 'bytes=0-1' } });
  console.log(`  ${head.status} ${head.headers.get('content-type')} len=${head.headers.get('content-length')}`);

  if (mod.QUALITY_PROBES?.length) {
    console.log('\n=== probing unconfirmed quality filenames ===');
    console.table(await probeQualities(first.url, mod.QUALITY_PROBES));
    console.log('Move any ok:true entry into QUALITIES in the module.');
  }

  console.log('\nPASS');
}

main().catch((err) => {
  console.error(`\nFAIL: ${err.message}`);
  process.exit(1);
});
