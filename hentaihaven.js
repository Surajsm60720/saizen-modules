/**
 * Saizen module - hentaihaven.com
 *
 * Adult (nsfw) source. Contract from docs/MODULE_CONTRACT.md.
 *
 * Site notes (verified against live responses):
 *   - Search: GET /?s=<query> → cards linking to /video/<slug>/
 *   - Episodes: /video/<slug>/episode-N (no trailing slash required)
 *   - Player iframe: /wp-content/plugins/player-logic/player.php?data=…&lang=en
 *   - player.php embeds meta[name=x-secure-token] ("sha512-" + ROT13/b64×3 JSON)
 *   - Decoded config has { en, iv, uri }; POST uri+api.php with
 *       action=zarat_get_data_player_ajax&a=<en>&b=<iv>
 *     returns HLS playlist (octopusmanifest.org) + optional eng sidecar under s/en.vtt
 */

var BASE = 'https://hentaihaven.com';
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
  if (url.indexOf('//') === 0) return 'https:' + url;
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

function rot13(s) {
  return String(s || '').replace(/[A-Za-z]/g, function (c) {
    var base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function b64decode(input) {
  var str = String(input || '').replace(/[^A-Za-z0-9+/=]/g, '');
  if (typeof atob === 'function') return atob(str);
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  var out = '';
  var i = 0;
  while (i < str.length) {
    var e1 = chars.indexOf(str.charAt(i++));
    var e2 = chars.indexOf(str.charAt(i++));
    var e3 = chars.indexOf(str.charAt(i++));
    var e4 = chars.indexOf(str.charAt(i++));
    var n = (e1 << 18) | (e2 << 12) | ((e3 & 63) << 6) | (e4 & 63);
    if (e3 === 64) out += String.fromCharCode((n >> 16) & 255);
    else if (e4 === 64)
      out += String.fromCharCode((n >> 16) & 255, (n >> 8) & 255);
    else out += String.fromCharCode((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }
  return out;
}

function decodeSecureToken(raw) {
  var e = String(raw || '').replace(/^sha512-/, '');
  e = rot13(e);
  e = b64decode(e);
  e = rot13(e);
  e = b64decode(e);
  e = rot13(e);
  e = b64decode(e);
  return JSON.parse(e);
}

function parseSearchResults(html, query) {
  var out = [];
  var seen = {};
  var re = /href="(https:\/\/hentaihaven\.com\/video\/([^"\/]+)\/)"/gi;
  var match;
  while ((match = re.exec(html)) !== null) {
    var url = match[1];
    var slug = match[2];
    if (seen[slug]) continue;
    var win = html.slice(Math.max(0, match.index - 200), match.index + 500);
    var title =
      (win.match(/alt="([^"]+?)(?:\s+cover)?"/i) || [])[1] ||
      (win.match(/title="([^"]+)"/) || [])[1] ||
      slug.replace(/-/g, ' ');
    title = decodeHtml(title)
      .replace(/\s+cover$/i, '')
      .trim();
    if (!matchesQuery(title, query) && !matchesQuery(slug.replace(/-/g, ' '), query)) {
      continue;
    }
    seen[slug] = true;
    var image =
      (win.match(/src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i) || [])[1] || '';
    out.push({ title: title, image: image, url: url });
  }
  return out;
}

async function searchResults(query) {
  var url = BASE + '/?s=' + encodeURIComponent(query || '');
  var res = await fetchv2(url, headers(BASE + '/'), 'GET', null);
  if (!res.ok) throw new Error('hentaihaven search failed: HTTP ' + res.status);
  return parseSearchResults(await res.text(), query);
}

async function extractEpisodes(showUrl) {
  var res = await fetchv2(showUrl, headers(BASE + '/'), 'GET', null);
  if (!res.ok) throw new Error('hentaihaven series failed: HTTP ' + res.status);
  var html = await res.text();
  var eps = [];
  var seen = {};
  var re = /href="(https:\/\/hentaihaven\.com\/video\/[^"]+\/episode-(\d+)\/?)"/gi;
  var match;
  while ((match = re.exec(html)) !== null) {
    var num = parseInt(match[2], 10);
    if (seen[num]) continue;
    seen[num] = true;
    var href = match[1];
    if (href.charAt(href.length - 1) !== '/') href += '/';
    eps.push({ url: href, number: num });
  }
  return eps.sort(function (a, b) {
    return a.number - b.number;
  });
}

function pickPlayerUrl(html) {
  var m = html.match(
    /https:\/\/hentaihaven\.com\/wp-content\/plugins\/player-logic\/player\.php\?data=[^"'&\s]+(?:&amp;|&)lang=\w+/i
  );
  return m ? decodeHtml(m[0]) : '';
}

function pickSecureToken(html) {
  var m = html.match(/name=["']x-secure-token["']\s+content=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

async function extractStreamUrl(episodeUrl) {
  var pageRes = await fetchv2(episodeUrl, headers(BASE + '/'), 'GET', null);
  if (!pageRes.ok) throw new Error('hentaihaven episode failed: HTTP ' + pageRes.status);
  var pageHtml = await pageRes.text();
  var playerUrl = pickPlayerUrl(pageHtml);
  if (!playerUrl) throw new Error('hentaihaven: player.php link missing');

  var playerRes = await fetchv2(playerUrl, headers(episodeUrl), 'GET', null);
  if (!playerRes.ok) throw new Error('hentaihaven player failed: HTTP ' + playerRes.status);
  var playerHtml = await playerRes.text();
  var token = pickSecureToken(playerHtml);
  if (!token) throw new Error('hentaihaven: x-secure-token missing');

  var cfg = decodeSecureToken(token);
  if (!cfg || !cfg.en || !cfg.iv || !cfg.uri) {
    throw new Error('hentaihaven: decoded player config incomplete');
  }

  var apiUrl = absolute(cfg.uri) + (String(cfg.uri).slice(-1) === '/' ? '' : '/') + 'api.php';
  if (!/^https:\/\//i.test(apiUrl)) throw new Error('hentaihaven: bad api url');

  var body =
    'action=zarat_get_data_player_ajax&a=' +
    encodeURIComponent(cfg.en) +
    '&b=' +
    encodeURIComponent(cfg.iv);
  var apiHeaders = headers(playerUrl);
  apiHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
  apiHeaders['Origin'] = BASE;
  apiHeaders['X-Requested-With'] = 'XMLHttpRequest';

  var apiRes = await fetchv2(apiUrl, apiHeaders, 'POST', body);
  if (!apiRes.ok) throw new Error('hentaihaven api failed: HTTP ' + apiRes.status);
  var payload = await apiRes.json();
  if (!payload || !payload.status || !payload.data || !payload.data.sources) {
    throw new Error('hentaihaven: empty player sources');
  }

  var streams = [];
  var sources = payload.data.sources;
  for (var i = 0; i < sources.length; i++) {
    var src = absolute(sources[i] && sources[i].src);
    if (!src || !/^https:\/\//i.test(src)) continue;
    var label = (sources[i] && (sources[i].label || sources[i].type)) || 'HLS';
    var streamHeaders = { Referer: BASE + '/', 'User-Agent': UA };
    // When hot_domains is set, CDN expects these; harmless when unused.
    if (payload.authorization && payload.authorization.token) {
      streamHeaders['X-Video-Token'] = String(payload.authorization.token);
      if (payload.authorization.expiration != null) {
        streamHeaders['X-Video-Expiration'] = String(payload.authorization.expiration);
      }
      if (payload.authorization.ip) {
        streamHeaders['X-Video-Ip'] = String(payload.authorization.ip);
      }
    }
    streams.push({
      url: src,
      headers: streamHeaders,
      quality: label,
      title: 'HentaiHaven'
    });
  }

  if (!streams.length) throw new Error('hentaihaven: no playable sources');

  var subtitle = '';
  var first = streams[0].url;
  if (/\.m3u8/i.test(first)) {
    subtitle = first.replace(/\/[^\/?#]+(?:\?.*)?$/, '/s/en.vtt');
  }

  var out = { streams: streams };
  if (subtitle) out.subtitle = subtitle;
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    searchResults: searchResults,
    extractEpisodes: extractEpisodes,
    extractStreamUrl: extractStreamUrl
  };
}
