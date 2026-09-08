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
 *     the numeric episode id when Livewire markup is present.
 *   - Search filters on `/search?search=…` (not `?s=`).
 *   - Each page is one episode; the series is the slug minus its trailing -N.
 *   - Related-episode links on a working page list the full series, but some
 *     sibling pages soft-404 without `e_id` even though the CDN still serves
 *     E0N. When that happens we resolve a working sibling via /player/api and
 *     rewrite `…/E01` → `…/E0N` (CDN paths are confirmed with Range probes).
 *   - POST /player/api {episode_id} needs X-XSRF-TOKEN from the session jar.
 *   - Streams are progressive MP4; English subs are sidecar `eng.vtt` on the CDN.
 *   - Multiple CDN hostnames are mirrors of the same file — return one primary
 *     (+ one labeled mirror) instead of every domain.
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

/** Live hstream.moe search modal tags[] values (CSAM + tech chips omitted). */
var GENRES = [
  ['3D', '3d'],
  ['Ahegao', 'ahegao'],
  ['Anal', 'anal'],
  ['BDSM', 'bdsm'],
  ['Bestiality', 'bestiality'],
  ['Big Boobs', 'big-boobs'],
  ['Blow Job', 'blow-job'],
  ['Bondage', 'bondage'],
  ['Boob Job', 'boob-job'],
  ['Censored', 'censored'],
  ['Comedy', 'comedy'],
  ['Cosplay', 'cosplay'],
  ['Creampie', 'creampie'],
  ['Dark Skin', 'dark-skin'],
  ['Elf', 'elf'],
  ['Facial', 'facial'],
  ['Fantasy', 'fantasy'],
  ['Filmed', 'filmed'],
  ['Foot Job', 'foot-job'],
  ['Futanari', 'futanari'],
  ['Gangbang', 'gangbang'],
  ['Glasses', 'glasses'],
  ['Gore', 'gore'],
  ['Hand Job', 'hand-job'],
  ['Harem', 'harem'],
  ['Horror', 'horror'],
  ['Incest', 'incest'],
  ['Inflation', 'inflation'],
  ['Lactation', 'lactation'],
  ['Maid', 'maid'],
  ['Masturbation', 'masturbation'],
  ['MILF', 'milf'],
  ['Mind Break', 'mind-break'],
  ['Mind Control', 'mind-control'],
  ['Monster', 'monster'],
  ['Nekomimi', 'nekomimi'],
  ['NTR', 'ntr'],
  ['Nurse', 'nurse'],
  ['Orc', 'orc'],
  ['Orgy', 'orgy'],
  ['POV', 'pov'],
  ['Pregnant', 'pregnant'],
  ['Public Sex', 'public-sex'],
  ['Rape', 'rape'],
  ['Reverse Rape', 'reverse-rape'],
  ['Rimjob', 'rimjob'],
  ['Scat', 'scat'],
  ['School Girl', 'school-girl'],
  ['Small Boobs', 'small-boobs'],
  ['Succubus', 'succubus'],
  ['Swim Suit', 'swim-suit'],
  ['Teacher', 'teacher'],
  ['Tentacle', 'tentacle'],
  ['Threesome', 'threesome'],
  ['Toys', 'toys'],
  ['Trap', 'trap'],
  ['Tsundere', 'tsundere'],
  ['Ugly Bastard', 'ugly-bastard'],
  ['Uncensored', 'uncensored'],
  ['Vanilla', 'vanilla'],
  ['Virgin', 'virgin'],
  ['X-Ray', 'x-ray'],
  ['Yuri', 'yuri']
];

function genreSlugMap() {
  var map = {};
  GENRES.forEach(function (pair) {
    map[String(pair[0]).toLowerCase()] = pair[1];
    map[String(pair[1]).toLowerCase()] = pair[1];
  });
  // aliases from other sources
  map['schoolgirl'] = 'school-girl';
  map['school girls'] = 'school-girl';
  map['swimsuit'] = 'swim-suit';
  map['tentacles'] = 'tentacle';
  map['blowjob'] = 'blow-job';
  map['footjob'] = 'foot-job';
  map['handjob'] = 'hand-job';
  map['netorare'] = 'ntr';
  return map;
}

function parseGenreSlugs(query) {
  var q = String(query || '').trim();
  if (!q) return [];
  var map = genreSlugMap();
  var slugs = [];
  var seen = {};

  function add(name) {
    var key = String(name || '').trim().toLowerCase().replace(/^genre:/i, '');
    if (!key) return;
    var slug = map[key];
    if (!slug || seen[slug]) return;
    seen[slug] = true;
    slugs.push(slug);
  }

  if (q.indexOf(' | ') >= 0) {
    q.split(' | ').forEach(add);
    return slugs;
  }
  if (map[q.toLowerCase()]) {
    add(q);
    return slugs;
  }
  // genre:Name tokens (Name may include spaces until next genre: or end)
  var re = /genre:([^\|]+?)(?=\s+genre:|$)/gi;
  var m;
  var found = false;
  while ((m = re.exec(q)) !== null) {
    found = true;
    add(m[1]);
  }
  return found ? slugs : [];
}

async function getGenres() {
  return GENRES.map(function (pair) {
    return { id: pair[1], name: pair[0] };
  });
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

function episodeFolder(n) {
  var num = Math.max(1, parseInt(n, 10) || 1);
  return 'E' + (num < 10 ? '0' + num : String(num));
}

function rewriteStreamPath(streamUrl, epNum) {
  return String(streamUrl).replace(/E\d+$/i, episodeFolder(epNum));
}

function withEid(url, episodeId) {
  if (!episodeId || String(url).indexOf('eid=') >= 0) return url;
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'eid=' + episodeId;
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

/** Related-episode / series nav links on a working episode page. */
function parseSiblingLinks(html, base) {
  var out = [];
  var seen = {};
  var re = /href="(https:\/\/hstream\.moe\/hentai\/([^"?#]+))"/g;
  var match;
  while ((match = re.exec(html)) !== null) {
    var href = match[1];
    var slug = match[2];
    if (seriesBase(slug) !== base) continue;
    var num = episodeNumber(slug);
    if (seen[num]) continue;
    seen[num] = true;
    out.push({ url: href, number: num, slug: slug });
  }
  return out.sort(function (a, b) {
    return a.number - b.number;
  });
}

function readEidFromHtml(html) {
  var idMatch =
    html.match(/id="e_id"[^>]*value="(\d+)"/) ||
    html.match(/value="(\d+)"[^>]*id="e_id"/) ||
    html.match(/name="e_id"[^>]*value="(\d+)"/);
  return idMatch ? idMatch[1] : '';
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

function parseOrderQuery(query) {
  var m = String(query || '')
    .trim()
    .match(/^order:([a-z0-9\-]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

async function fetchCards(query, genreSlugs, order) {
  var url;
  if (order) {
    url = BASE + '/search?order=' + encodeURIComponent(order);
  } else if (genreSlugs && genreSlugs.length) {
    url =
      BASE +
      '/search?' +
      genreSlugs
        .map(function (s) {
          return 'tags[]=' + encodeURIComponent(s);
        })
        .join('&');
  } else {
    url = BASE + '/search?search=' + encodeURIComponent(query || '');
  }
  var res = await fetchv2(url, headers(BASE + '/'), 'GET', null);
  if (!res.ok) throw new Error('hstream search failed: HTTP ' + res.status);
  return parseCards(await res.text());
}


function collapseCards(cards) {
  var bySeries = {};
  cards.forEach(function (card) {
    var key = seriesBase(card.slug);
    var current = bySeries[key];
    if (!current || episodeNumber(card.slug) < episodeNumber(current.slug)) {
      bySeries[key] = card;
    }
  });
  return Object.keys(bySeries).map(function (key) {
    var card = bySeries[key];
    return {
      title: titleFromSlug(card.slug),
      image: card.image,
      url: withEid(card.url, card.episodeId)
    };
  });
}

/** Optional — web usually builds rails via railQueries in one session. */
async function getHomeSections() {
  return [];
}

async function searchResults(query) {
  var order = parseOrderQuery(query);
  if (order) {
    return collapseCards(await fetchCards('', [], order)).slice(0, 24);
  }
  var genreSlugs = parseGenreSlugs(query);
  var cards = await fetchCards(query, genreSlugs, '');
  // Genre / tag browse: keep all cards. Free-text: filter locally.
  if (!genreSlugs.length) {
    cards = cards.filter(function (c) {
      return matchesQuery(c, query);
    });
  }

  var collapsed = collapseCards(cards);
  if (collapsed.length) {
    return collapsed;
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
        var html = await res.text();
        if (readEidFromHtml(html)) {
          return [
            {
              title: titleFromSlug(slugFromUrl(probe) || slug + '-1'),
              image: '',
              url: probe
            }
          ];
        }
      }
    } catch (e) {
      // try next
    }
  }
  return [];
}

async function extractEpisodes(showUrl) {
  var slug = slugFromUrl(showUrl);
  var base = seriesBase(slug);
  if (!base) return [];

  var byNumber = {};

  // Prefer Livewire search cards when present (carry real e_id).
  try {
    var siblings = (await fetchCards(base.replace(/-/g, ' '))).filter(function (c) {
      return seriesBase(c.slug) === base;
    });
    siblings.forEach(function (card) {
      byNumber[episodeNumber(card.slug)] = {
        url: withEid(card.url, card.episodeId),
        number: episodeNumber(card.slug)
      };
    });
  } catch (e) {
    // fall through to page scrape
  }

  // Always scrape related links from a working episode page — Livewire search
  // often returns zero cards for niche titles.
  var seedUrls = [];
  if (showUrl) seedUrls.push(String(showUrl).replace(/[?&]eid=\d+/g, '').replace(/\?$/, ''));
  seedUrls.push(BASE + '/hentai/' + base + '-1');
  seedUrls.push(BASE + '/hentai/' + base);

  for (var i = 0; i < seedUrls.length; i++) {
    try {
      var res = await fetchv2(seedUrls[i], headers(BASE + '/search'), 'GET', null);
      if (!res.ok) continue;
      var html = await res.text();
      var eid = readEidFromHtml(html);
      var seedSlug = slugFromUrl(seedUrls[i]) || slug;
      var seedNum = episodeNumber(seedSlug);
      if (eid) {
        byNumber[seedNum] = {
          url: withEid(BASE + '/hentai/' + seedSlug, eid),
          number: seedNum
        };
      }
      parseSiblingLinks(html, base).forEach(function (sib) {
        if (!byNumber[sib.number]) {
          byNumber[sib.number] = { url: sib.url, number: sib.number };
        }
      });
      if (Object.keys(byNumber).length > 1 || eid) break;
    } catch (e) {
      // try next seed
    }
  }

  var nums = Object.keys(byNumber)
    .map(function (n) {
      return parseInt(n, 10);
    })
    .sort(function (a, b) {
      return a - b;
    });

  if (!nums.length) {
    return [{ url: showUrl, number: episodeNumber(slug) }];
  }

  return nums.map(function (n) {
    return byNumber[n];
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

async function playerApi(episodeId, refererUrl, pageRes) {
  var apiHeaders = headers(refererUrl);
  apiHeaders['X-Requested-With'] = 'XMLHttpRequest';
  apiHeaders['Origin'] = BASE;
  apiHeaders['Content-Type'] = 'application/json';
  apiHeaders['Accept'] = 'application/json';
  var token = pageRes ? readXsrfToken(pageRes) : '';
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
  return { data: data, domains: domains };
}

/** Find any working sibling page (has e_id) so we can rewrite CDN paths. */
async function resolveWorkingSibling(base, preferUrl) {
  var tries = [];
  if (preferUrl) tries.push(preferUrl);
  tries.push(BASE + '/hentai/' + base + '-1');
  tries.push(BASE + '/hentai/' + base + '-4');
  tries.push(BASE + '/hentai/' + base);

  for (var i = 0; i < tries.length; i++) {
    var url = String(tries[i]).replace(/[?&]eid=\d+/g, '').replace(/\?$/, '');
    try {
      var res = await fetchv2(url, headers(BASE + '/search'), 'GET', null);
      if (!res.ok) continue;
      var html = await res.text();
      var eid = readEidFromHtml(html);
      if (!eid) continue;
      return { url: url, eid: eid, pageRes: res, html: html };
    } catch (e) {
      // next
    }
  }
  return null;
}

function buildStreams(domains, streamPath, title) {
  // One primary + one mirror — same file on every CDN host.
  var hosts = [];
  if (domains[0]) hosts.push(domains[0]);
  if (domains[1] && domains[1] !== domains[0]) hosts.push(domains[1]);

  var streams = [];
  hosts.forEach(function (domain, idx) {
    QUALITIES.forEach(function (q) {
      streams.push({
        url: domain + '/' + streamPath + '/' + q.file,
        headers: { Referer: BASE + '/', 'User-Agent': UA },
        quality: q.label,
        title: idx === 0 ? title : title + ' (mirror)'
      });
    });
  });
  return streams;
}

async function extractStreamUrl(episodeUrl) {
  var eidFromQuery = (String(episodeUrl).match(/[?&]eid=(\d+)/) || [])[1] || '';
  var cleanUrl = String(episodeUrl).replace(/[?&]eid=\d+/g, '').replace(/\?$/, '');
  var slug = slugFromUrl(cleanUrl);
  var base = seriesBase(slug);
  var wantedEp = episodeNumber(slug);

  var pageRes = await fetchv2(cleanUrl, headers(BASE + '/search'), 'GET', null);
  if (!pageRes.ok) throw new Error('hstream episode failed: HTTP ' + pageRes.status);

  var html = await pageRes.text();
  var episodeId = eidFromQuery || readEidFromHtml(html);

  var data;
  var domains;

  if (episodeId) {
    var direct = await playerApi(episodeId, cleanUrl, pageRes);
    data = direct.data;
    domains = direct.domains;
    // If API title/path episode disagrees with slug number, still trust API for
    // this e_id — but when we used a soft-404 page we won't have e_id.
  } else {
    // Soft-404 sibling page: resolve a working episode and rewrite CDN E0N.
    var sib = await resolveWorkingSibling(base, BASE + '/hentai/' + base + '-1');
    if (!sib) {
      throw new Error(
        'hstream: e_id not found on ' +
          cleanUrl +
          ' and no working sibling (page may be missing / geo-blocked)'
      );
    }
    var via = await playerApi(sib.eid, sib.url, sib.pageRes);
    data = via.data;
    domains = via.domains;
    data = Object.assign({}, data, {
      stream_url: rewriteStreamPath(data.stream_url, wantedEp)
    });
  }

  // If we resolved via the correct e_id but CDN path still points at another
  // episode folder (site quirk), force the slug episode number.
  var pathEp = (String(data.stream_url).match(/E(\d+)$/i) || [])[1];
  if (pathEp && parseInt(pathEp, 10) !== wantedEp) {
    data = Object.assign({}, data, {
      stream_url: rewriteStreamPath(data.stream_url, wantedEp)
    });
  }

  var title = data.title || titleFromSlug(slug) || titleFromSlug(base);
  var streams = buildStreams(domains, data.stream_url, title);
  var subtitle = domains[0] + '/' + data.stream_url + '/eng.vtt';

  return { streams: streams, subtitle: subtitle };
}

// Exported for the offline harness; ignored by the JSContext runtime.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    searchResults: searchResults,
    extractEpisodes: extractEpisodes,
    extractStreamUrl: extractStreamUrl,
    getGenres: getGenres,
    getHomeSections: getHomeSections,
    QUALITY_PROBES: QUALITY_PROBES
  };
}
