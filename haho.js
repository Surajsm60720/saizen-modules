/**
 * Saizen module - haho.moe (Hentai AHO Streaming)
 *
 * Adult (nsfw) source. Contract from docs/MODULE_CONTRACT.md.
 *
 * Site notes (verified against live responses):
 *   - Search is GET /anime?q=… (form name="q" on the homepage).
 *   - Series pages are /anime/<id>; episodes are /anime/<id>/<n>.
 *   - Episode pages embed /embed?v=<token>; the embed HTML exposes
 *     <source src="https://s1.filegasm.com/…?download_token=…" title="480p|360p">.
 *   - Tokens are short-lived; resolve just before play.
 *   - Optional timeline VTT on filegasm may be chapter markers, not dialogue.
 */

var BASE = 'https://haho.moe';
var UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function headers(referer) {
  return {
    'User-Agent': UA,
    Referer: referer || BASE + '/',
    'Accept-Language': 'en-US,en;q=0.9'
  };
}

function absolute(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return BASE + (url.charAt(0) === '/' ? '' : '/') + url;
}

function seriesIdFromUrl(url) {
  var m = String(url).match(/\/anime\/([a-z0-9]+)/i);
  return m ? m[1] : '';
}

function parseSearchCards(html) {
  var out = [];
  var seen = {};
  // Cards use title="…" on the series anchor.
  var re = /href="(https:\/\/haho\.moe\/anime\/([a-z0-9]+))"/gi;
  var match;
  while ((match = re.exec(html)) !== null) {
    var url = match[1];
    var id = match[2];
    if (id === 'search' || seen[id]) continue;
    var window = html.slice(Math.max(0, match.index - 80), match.index + 350);
    var title =
      (window.match(/title="([^"]+)"/) || [])[1] ||
      (window.match(/alt="([^"]+)"/) || [])[1] ||
      '';
    if (!title) continue;
    seen[id] = true;
    var img = (window.match(/src="(https:\/\/haho\.moe\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i) ||
      [])[1] || '';
    out.push({ title: title.trim(), image: img, url: url });
  }
  return out;
}

function matchesQuery(card, query) {
  var tokens = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(function (t) {
      return t.length > 1;
    });
  if (!tokens.length) return true;
  var hay = String(card.title || '').toLowerCase();
  return tokens.every(function (t) {
    return hay.indexOf(t) !== -1;
  });
}

async function searchResults(query) {
  var url = BASE + '/anime?q=' + encodeURIComponent(query || '');
  var res = await fetchv2(url, headers(BASE + '/'), 'GET', null);
  if (!res.ok) throw new Error('haho search failed: HTTP ' + res.status);
  return parseSearchCards(await res.text()).filter(function (c) {
    return matchesQuery(c, query);
  });
}

async function extractEpisodes(showUrl) {
  var id = seriesIdFromUrl(showUrl);
  if (!id) return [];
  var res = await fetchv2(BASE + '/anime/' + id, headers(BASE + '/'), 'GET', null);
  if (!res.ok) throw new Error('haho series failed: HTTP ' + res.status);
  var html = await res.text();
  var nums = {};
  var re = new RegExp('/anime/' + id + '/(\\d+)', 'g');
  var m;
  while ((m = re.exec(html)) !== null) {
    nums[parseInt(m[1], 10)] = true;
  }
  var list = Object.keys(nums)
    .map(function (n) {
      return parseInt(n, 10);
    })
    .sort(function (a, b) {
      return a - b;
    });
  if (!list.length) {
    // Some series only expose ep 1 via /anime/<id>/1
    list = [1];
  }
  return list.map(function (n) {
    return { url: BASE + '/anime/' + id + '/' + n, number: n };
  });
}

async function extractStreamUrl(episodeUrl) {
  var clean = String(episodeUrl);
  var pageRes = await fetchv2(clean, headers(BASE + '/'), 'GET', null);
  if (!pageRes.ok) throw new Error('haho episode failed: HTTP ' + pageRes.status);
  var html = await pageRes.text();
  var iframe = (html.match(/<iframe[^>]+src="([^"]+)"/i) || [])[1];
  if (!iframe) throw new Error('haho: embed iframe missing on ' + clean);

  var embedUrl = absolute(iframe);
  var embedRes = await fetchv2(embedUrl, headers(clean), 'GET', null);
  if (!embedRes.ok) throw new Error('haho embed failed: HTTP ' + embedRes.status);
  var embedHtml = await embedRes.text();

  var streams = [];
  var sourceRe = /<source\s+([^>]+)>/gi;
  var sm;
  while ((sm = sourceRe.exec(embedHtml)) !== null) {
    var attrs = sm[1];
    var src = (attrs.match(/\bsrc="([^"]+)"/i) || [])[1];
    if (!src || !/^https:\/\//i.test(src)) continue;
    var quality = (attrs.match(/\btitle="([^"]+)"/i) || [])[1] || undefined;
    streams.push({
      url: src,
      headers: { Referer: BASE + '/', 'User-Agent': UA },
      quality: quality,
      title: quality ? 'Haho ' + quality : 'Haho'
    });
  }

  if (!streams.length) throw new Error('haho: no <source> in embed');

  // Prefer higher numeric quality first (480p before 360p).
  streams.sort(function (a, b) {
    var aq = parseInt(String(a.quality || '').replace(/\D/g, ''), 10) || 0;
    var bq = parseInt(String(b.quality || '').replace(/\D/g, ''), 10) || 0;
    return bq - aq;
  });

  var subtitle = (embedHtml.match(/https?:[^\"'\s]+\.vtt[^\"'\s]*/i) || [])[0] || undefined;
  // filegasm timeline/*.vtt is often scrubber chapters, not dialogue — still expose if present.
  return { streams: streams, subtitle: subtitle };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    searchResults: searchResults,
    extractEpisodes: extractEpisodes,
    extractStreamUrl: extractStreamUrl
  };
}
