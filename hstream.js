/**
 * Saizen module - hstream.moe
 *
 * Adult (nsfw) source, English-subbed. Implements the three-function contract
 * from docs/MODULE_CONTRACT.md:
 *
 *   searchResults(query)        -> SearchResult[]
 *   extractEpisodes(showUrl)    -> Episode[]
 *   extractStreamUrl(episodeUrl)-> { streams, subtitle? }
 *
 * Site notes (verified against live responses):
 *   - Search cards are Livewire-rendered: <div wire:key="episode-<e_id>"> wraps
 *     <a href="https://hstream.moe/hentai/<slug>">. The card therefore carries
 *     the numeric episode id, so the episode page fetch is only needed for the
 *     CSRF cookie.
 *   - Search filters on `/search?search=…` (not `?s=`). The latter returns an
 *     unfiltered homepage-like card list and local filtering then fails for
 *     titles that are not on that first page.
 *   - Each page is one episode; the series is the slug minus its trailing -N.
 *   - POST /player/api {episode_id} returns the stream descriptor, but Laravel
 *     rejects it with 419 unless X-XSRF-TOKEN carries the url-decoded
 *     XSRF-TOKEN cookie from a prior GET on the same session.
 *   - Streams are progressive MP4, not HLS.
 */

var BASE = 'https://hstream.moe';
var UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * Only 720p is confirmed to exist on the CDN. The player offers 1080/1081/
 * 2160/2161 as well, but the filename builder for those was not readable, so
 * they stay off until the harness probes them. QUALITY_PROBES is what the
 * harness HEAD-tests; move any that come back 200/206 into QUALITIES.
 */
var QUALITIES = [{ label: '720p', file: 'x264.720p.mp4' }];

var QUALITY_PROBES = [
  'x264.1080p.mp4',
  'x264.2160p.mp4',
  'x265.1080p.mp4',
  'x265.2160p.mp4',
  'x264.1081p.mp4',
  'x264.2161p.mp4'
];

function headers(referer) {
  return {
    'User-Agent': UA,
    Referer: referer || BASE + '/',
    'Accept-Language': 'en-US,en;q=0.9'
  };
}

function seriesBase(slug) {
  return String(slug).replace(/-(\d+)$/, '');
}

function episodeNumber(slug) {
  var m = String(slug).match(/-(\d+)$/);
  return m ? parseInt(m[1], 10) : 1;
}

function slugFromUrl(url) {
  var m = String(url).match(/\/hentai\/([^/?#]+)/);
  return m ? m[1] : '';
}

function titleFromSlug(slug) {
  return seriesBase(slug)
    .split('-')
    .filter(Boolean)
    .map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

function absolute(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return BASE + (url.charAt(0) === '/' ? '' : '/') + url;
}

/**
 * Search is Livewire-backed and has been observed returning the full card list
 * regardless of ?s=, so every card is parsed and filtered locally. That stays
 * correct whether or not the server actually narrows the result set.
 */
function parseCards(html) {
  var out = [];
  var re = /wire:key="episode-(\d+)"([\s\S]*?)(?=wire:key="episode-\d+"|$)/g;
  var match;

  while ((match = re.exec(html)) !== null) {
    var chunk = match[2];
    var hrefMatch = chunk.match(/href="(https:\/\/hstream\.moe\/hentai\/[^"]+)"/);
    if (!hrefMatch) continue;

    var href = hrefMatch[1];
    var slug = slugFromUrl(href);
    if (!slug) continue;

    // Card markup for title/poster was not inspectable, so read whatever the
    // <img> exposes and fall back to the slug.
    var srcMatch = chunk.match(/<img[^>]+src="([^"]+)"/);
    var altMatch = chunk.match(/<img[^>]+alt="([^"]+)"/);

    out.push({
      episodeId: match[1],
      slug: slug,
      url: href,
      image: absolute(srcMatch ? srcMatch[1] : ''),
      title: (altMatch && altMatch[1].trim()) || titleFromSlug(slug)
    });
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

  var hay = (card.slug + ' ' + card.title).toLowerCase();
  return tokens.every(function (t) {
    return hay.indexOf(t) !== -1;
  });
}

async function fetchCards(query) {
  // Site filters on `search=`, not `s=` (the latter returns an unfiltered card list).
  var url = BASE + '/search?search=' + encodeURIComponent(query || '');
  var res = await fetchv2(url, headers(BASE + '/'), 'GET', null);
  if (!res.ok) throw new Error('hstream search failed: HTTP ' + res.status);
  return parseCards(await res.text());
}

async function searchResults(query) {
  var cards = (await fetchCards(query)).filter(function (c) {
    return matchesQuery(c, query);
  });

  // Collapse per-episode cards into one entry per series, keeping the lowest
  // episode as the entry point.
  var bySeries = {};
  cards.forEach(function (card) {
    var key = seriesBase(card.slug);
    var current = bySeries[key];
    if (!current || episodeNumber(card.slug) < episodeNumber(current.slug)) {
      bySeries[key] = card;
    }
  });

  var keys = Object.keys(bySeries);
  if (keys.length) {
    return keys.map(function (key) {
      var card = bySeries[key];
      return {
        title: titleFromSlug(card.slug),
        image: card.image,
        // Carry Livewire episode id so extractStreamUrl can skip brittle HTML parsing.
        url: card.url + (card.url.indexOf('?') >= 0 ? '&' : '?') + 'eid=' + card.episodeId
      };
    });
  }

  // Fallback: many adult titles are reachable as /hentai/<slug>-1 even when the
  // Livewire search page is flaky or the query tokens don't match card text.
  var slug = String(query || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return [];

  var candidates = [BASE + '/hentai/' + slug + '-1', BASE + '/hentai/' + slug];
  for (var i = 0; i < candidates.length; i++) {
    var probe = candidates[i];
    try {
      var res = await fetchv2(probe, headers(BASE + '/'), 'GET', null);
      if (res.ok) {
        return [
          {
            title: titleFromSlug(slugFromUrl(probe) || slug + '-1'),
            image: '',
            url: probe
          }
        ];
      }
    } catch (e) {
      // try next
    }
  }
  return [];
}

async function extractEpisodes(showUrl) {
  var base = seriesBase(slugFromUrl(showUrl));
  if (!base) return [];

  var siblings = (await fetchCards(base.replace(/-/g, ' '))).filter(function (c) {
    return seriesBase(c.slug) === base;
  });

  if (!siblings.length) {
    // Search came back empty; the requested page is still a valid episode.
    return [{ url: showUrl, number: episodeNumber(slugFromUrl(showUrl)) }];
  }

  return siblings
    .map(function (card) {
      var url = card.url;
      if (card.episodeId && url.indexOf('eid=') < 0) {
        url = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'eid=' + card.episodeId;
      }
      return { url: url, number: episodeNumber(card.slug) };
    })
    .sort(function (a, b) {
      return a.number - b.number;
    });
}

/**
 * Swift joins repeated Set-Cookie headers into one comma-separated string, so
 * the token is matched without crossing a cookie boundary.
 * Native ModuleRuntime synthesizes set-cookie from the session cookie jar
 * because iOS strips Set-Cookie from HTTPURLResponse.allHeaderFields.
 */
function readXsrfToken(res) {
  var raw = res.headers.get('set-cookie') || '';
  var m = raw.match(/XSRF-TOKEN=([^;,\s]+)/);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch (e) {
    return m[1];
  }
}

async function extractStreamUrl(episodeUrl) {
  var eidFromQuery = (String(episodeUrl).match(/[?&]eid=(\d+)/) || [])[1] || '';
  var cleanUrl = String(episodeUrl).replace(/[?&]eid=\d+/g, '').replace(/\?$/, '');

  // Warm Laravel session + XSRF-TOKEN cookie (native bridge injects X-XSRF-TOKEN on POST).
  var pageRes = await fetchv2(cleanUrl, headers(BASE + '/search'), 'GET', null);
  if (!pageRes.ok) throw new Error('hstream episode failed: HTTP ' + pageRes.status);

  var html = await pageRes.text();
  var idMatch =
    html.match(/id="e_id"[^>]*value="(\d+)"/) ||
    html.match(/value="(\d+)"[^>]*id="e_id"/) ||
    html.match(/name="e_id"[^>]*value="(\d+)"/) ||
    html.match(/episode[_-]?id["'\s:=]+(\d+)/i);

  var episodeId = eidFromQuery || (idMatch ? idMatch[1] : '');
  if (!episodeId) {
    throw new Error(
      'hstream: e_id not found on ' +
        cleanUrl +
        ' (page may be missing / geo-blocked; try Overflow)'
    );
  }

  var apiHeaders = headers(cleanUrl);
  apiHeaders['X-Requested-With'] = 'XMLHttpRequest';
  apiHeaders['Origin'] = BASE;
  apiHeaders['Content-Type'] = 'application/json';
  apiHeaders['Accept'] = 'application/json';
  // Prefer JS-visible token when present; native ModuleRuntime also sets from jar.
  var token = readXsrfToken(pageRes);
  if (token) apiHeaders['X-XSRF-TOKEN'] = token;

  var apiRes = await fetchv2(
    BASE + '/player/api',
    apiHeaders,
    'POST',
    JSON.stringify({ episode_id: parseInt(episodeId, 10) })
  );

  if (apiRes.status === 419) {
    throw new Error('hstream: CSRF rejected (419) — X-XSRF-TOKEN mismatch');
  }
  if (!apiRes.ok) throw new Error('hstream player/api failed: HTTP ' + apiRes.status);

  var data = await apiRes.json();
  var domains = (data.stream_domains || []).concat(data.asia_stream_domains || []);
  if (!domains.length || !data.stream_url) {
    throw new Error('hstream: player/api returned no stream domains');
  }

  var streams = [];
  domains.forEach(function (domain) {
    QUALITIES.forEach(function (q) {
      streams.push({
        url: domain + '/' + data.stream_url + '/' + q.file,
        headers: { Referer: BASE + '/', 'User-Agent': UA },
        quality: q.label,
        title: data.title || titleFromSlug(slugFromUrl(cleanUrl))
      });
    });
  });

  return {
    streams: streams,
    subtitle: domains[0] + '/' + data.stream_url + '/eng.vtt'
  };
}

// Exported for the offline harness; ignored by the JSContext runtime.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    searchResults: searchResults,
    extractEpisodes: extractEpisodes,
    extractStreamUrl: extractStreamUrl,
    QUALITY_PROBES: QUALITY_PROBES
  };
}
