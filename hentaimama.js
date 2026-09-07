/**
 * Saizen module - hentaimama.io
 *
 * Adult (nsfw) source. Contract from docs/MODULE_CONTRACT.md.
 *
 * Site notes (verified against live responses):
 *   - Search: GET /?s=<query> → cards linking to /tvshows/<slug>/
 *   - Episodes: /episodes/<slug>-episode-<n>/
 *   - Player mirrors load via POST /wp-admin/admin-ajax.php
 *     { action: get_player_contents, a: <postId>, i: <mirrorIndex> }
 *     returning an iframe to /?dt_embed=<kind>&p=<base64 path>&ep=<postId>
 *   - The embed page exposes JWPlayer `file: "https://…mp4"`.
 */

var BASE = 'https://hentaimama.io';
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

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#038;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function matchesQuery(title, query) {
  var tokens = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(function (t) {
      return t.length > 1;
    });
  if (!tokens.length) return true;
  var hay = String(title || '').toLowerCase();
  return tokens.every(function (t) {
    return hay.indexOf(t) !== -1;
  });
}

function parseSearchResults(html, query) {
  var out = [];
  var seen = {};
  var re = /href="(https:\/\/hentaimama\.io\/tvshows\/([^"\/]+)\/)"/gi;
  var match;
  while ((match = re.exec(html)) !== null) {
    var url = match[1];
    var slug = match[2];
    if (seen[slug]) continue;
    var win = html.slice(Math.max(0, match.index - 200), match.index + 400);
    var title =
      (win.match(/title="([^"]+)"/) || [])[1] ||
      (win.match(/alt="([^"]+)"/) || [])[1] ||
      slug.replace(/-/g, ' ');
    title = decodeHtml(title).trim();
    if (!matchesQuery(title, query) && !matchesQuery(slug.replace(/-/g, ' '), query)) {
      continue;
    }
    seen[slug] = true;
    var image = (win.match(/src="(https:\/\/hentaimama\.io\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i) ||
      [])[1] || '';
    out.push({ title: title, image: image, url: url });
  }
  return out;
}

async function searchResults(query) {
  var url = BASE + '/?s=' + encodeURIComponent(query || '');
  var res = await fetchv2(url, headers(BASE + '/'), 'GET', null);
  if (!res.ok) throw new Error('hentaimama search failed: HTTP ' + res.status);
  return parseSearchResults(await res.text(), query);
}

async function extractEpisodes(showUrl) {
  var res = await fetchv2(showUrl, headers(BASE + '/'), 'GET', null);
  if (!res.ok) throw new Error('hentaimama series failed: HTTP ' + res.status);
  var html = await res.text();
  var eps = [];
  var seen = {};
  var re = /href="(https:\/\/hentaimama\.io\/episodes\/([^"]+)-episode-(\d+)\/)"/gi;
  var match;
  while ((match = re.exec(html)) !== null) {
    var num = parseInt(match[3], 10);
    if (seen[num]) continue;
    seen[num] = true;
    eps.push({ url: match[1], number: num });
  }
  return eps.sort(function (a, b) {
    return a.number - b.number;
  });
}

function readPostId(html) {
  var m =
    html.match(/action:\s*['"]get_player_contents['"][\s\S]{0,120}?a:\s*['"]?(\d+)/i) ||
    html.match(/get_player_contents['"]?\s*,\s*a:\s*['"]?(\d+)/i) ||
    html.match(/['"]a['"]\s*:\s*['"]?(\d+)['"]?\s*,\s*['"]?i['"]?\s*:\s*n/i);
  return m ? m[1] : '';
}

function mirrorIndexes(html) {
  var out = [];
  var seen = {};
  var re = /id=["']option-(\d+)["']/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    if (seen[m[1]]) continue;
    seen[m[1]] = true;
    out.push(m[1]);
  }
  return out.length ? out : ['1'];
}

function unescapeJsonUrl(s) {
  return decodeHtml(String(s || '').replace(/\\\//g, '/'));
}

function pickMp4FromEmbed(html) {
  var file = (html.match(/file\s*:\s*["'](https?:[^"']+\.mp4[^"']*)["']/i) || [])[1];
  if (file) return unescapeJsonUrl(file);
  var any = (html.match(/https?:[^"'\\\s]+\\.mp4[^"'\\\s]*/i) ||
    html.match(/https?:[^"'\s]+\.mp4[^"'\s]*/i) ||
    [])[0];
  return any ? unescapeJsonUrl(any) : '';
}

async function extractStreamUrl(episodeUrl) {
  var pageRes = await fetchv2(episodeUrl, headers(BASE + '/'), 'GET', null);
  if (!pageRes.ok) throw new Error('hentaimama episode failed: HTTP ' + pageRes.status);
  var html = await pageRes.text();
  var postId = readPostId(html);
  if (!postId) throw new Error('hentaimama: player post id missing on ' + episodeUrl);

  var streams = [];
  var indexes = mirrorIndexes(html);
  for (var i = 0; i < indexes.length; i++) {
    var idx = indexes[i];
    var body =
      'action=get_player_contents&a=' +
      encodeURIComponent(postId) +
      '&i=' +
      encodeURIComponent(idx);
    var ajaxHeaders = headers(episodeUrl);
    ajaxHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    ajaxHeaders['X-Requested-With'] = 'XMLHttpRequest';
    ajaxHeaders['Origin'] = BASE;

    var ajaxRes = await fetchv2(
      BASE + '/wp-admin/admin-ajax.php',
      ajaxHeaders,
      'POST',
      body
    );
    if (!ajaxRes.ok) continue;
    var raw = await ajaxRes.text();
    var iframeHtml = '';
    try {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (var j = 0; j < parsed.length; j++) {
          if (typeof parsed[j] === 'string' && parsed[j].indexOf('iframe') >= 0) {
            iframeHtml = parsed[j];
            break;
          }
        }
      } else if (parsed && typeof parsed === 'object') {
        iframeHtml = String(parsed.embed || parsed.html || parsed[0] || '');
      }
    } catch (e) {
      iframeHtml = raw;
    }
    var embedSrc = (iframeHtml.match(/src=["']([^"']+)["']/i) || [])[1];
    if (!embedSrc) continue;
    embedSrc = absolute(decodeHtml(embedSrc));
    if (!/^https:\/\//i.test(embedSrc)) continue;

    var embedRes = await fetchv2(embedSrc, headers(episodeUrl), 'GET', null);
    if (!embedRes.ok) continue;
    var mp4 = pickMp4FromEmbed(await embedRes.text());
    if (!mp4 || !/^https:\/\//i.test(mp4)) continue;

    streams.push({
      url: mp4,
      headers: { Referer: BASE + '/', 'User-Agent': UA },
      quality: indexes.length > 1 ? 'Mirror ' + idx : 'HD',
      title: 'Hentaimama'
    });
  }

  if (!streams.length) throw new Error('hentaimama: no playable mirrors');
  return { streams: streams };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    searchResults: searchResults,
    extractEpisodes: extractEpisodes,
    extractStreamUrl: extractStreamUrl
  };
}
