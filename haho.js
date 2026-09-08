/**
 * Saizen module - haho.moe (Hentai AHO Streaming)
 *
 * Adult (nsfw) source. Contract from docs/MODULE_CONTRACT.md.
 *
 * Site notes (verified against live responses):
 *   - Free-text search: POST /anime/search (JSON autocomplete) returns cover images.
 *   - Genre / catalog browse: GET /anime?q=… HTML cards have no <img> — cover is
 *     backfilled from each series page og:image / cover-image.
 *   - Series pages are /anime/<id>; episodes are /anime/<id>/<n>.
 *   - Episode pages embed /embed?v=<token>; the embed HTML exposes
 *     <source src="https://s1.filegasm.com/…?download_token=…" title="480p|360p">.
 *   - Tokens are short-lived; resolve just before play.
 *   - Optional timeline VTT on filegasm may be chapter markers, not dialogue.
 */

// saizen-adult-catalog-v2
var BASE = 'https://haho.moe';
var UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

var csrfToken = '';
var sessionPrimed = false;

function headers(referer) {
  return {
    'User-Agent': UA,
    Referer: referer || BASE + '/',
    'Accept-Language': 'en-US,en;q=0.9'
  };
}

async function ensureSession() {
  if (sessionPrimed && csrfToken) return;
  var res = await fetchv2(BASE + '/', headers(BASE + '/'), 'GET', null);
  if (!res.ok) throw new Error('haho session failed: HTTP ' + res.status);
  var html = await res.text();
  var m = html.match(/name=["']csrf-token["']\s+content=["']([^"']+)["']/i);
  csrfToken = m ? m[1] : '';
  sessionPrimed = true;
}

/** haho.moe genre: operator tags (subset of /genre index, adult-relevant). */
var GENRES = [
  ['Ahegao', 'ahegao'],
  ['Anal', 'anal'],
  ['Anal fingering', 'anal fingering'],
  ['Anal pissing', 'anal pissing'],
  ['Attempted rape', 'attempted rape'],
  ['Aunt-nephew incest', 'aunt-nephew incest'],
  ['BDSM', 'BDSM'],
  ['Bondage', 'bondage'],
  ['Brother-sister incest', 'brother-sister incest'],
  ['Bukkake', 'bukkake'],
  ['Comedy', 'comedy'],
  ['Contemporary fantasy', 'contemporary fantasy'],
  ['Cosplaying', 'cosplaying'],
  ['Creampie', 'creampie'],
  ['Dark elf', 'dark elf'],
  ['Dark fantasy', 'dark fantasy'],
  ['Dark-skinned girl', 'dark-skinned girl'],
  ['Deflowering', 'deflowering'],
  ['Elf', 'elf'],
  ['Enjoyable rape', 'enjoyable rape'],
  ['Exhibitionism', 'exhibitionism'],
  ['Fantasy', 'fantasy'],
  ['Father-daughter incest', 'father-daughter incest'],
  ['Female rapes female', 'female rapes female'],
  ['Female teacher', 'female teacher'],
  ['Femdom', 'femdom'],
  ['FFM threesome', 'FFM threesome'],
  ['Footjob', 'footjob'],
  ['Futa x female', 'futa x female'],
  ['Futa x futa', 'futa x futa'],
  ['Futa x male', 'futa x male'],
  ['Futanari', 'futanari'],
  ['Gang bang', 'gang bang'],
  ['Gang rape', 'gang rape'],
  ['Girl rapes girl', 'girl rapes girl'],
  ['Group sex', 'group sex'],
  ['Handjob', 'handjob'],
  ['Harem', 'harem'],
  ['High fantasy', 'high fantasy'],
  ['High school', 'high school'],
  ['Horror', 'horror'],
  ['Impregnation', 'impregnation'],
  ['Impregnation with larvae', 'impregnation with larvae'],
  ['Incest', 'incest'],
  ['Inter-dimensional schoolgirl', 'inter-dimensional schoolgirl'],
  ['Lactation', 'lactation'],
  ['Maid', 'maid'],
  ['Male rape victim', 'male rape victim'],
  ['Master-slave relation', 'master-slave relation'],
  ['Masturbation', 'masturbation'],
  ['Mechanical tentacle', 'mechanical tentacle'],
  ['Mermaid', 'mermaid'],
  ['Mind fuck', 'mind fuck'],
  ['MMF threesome', 'MMF threesome'],
  ['MMM threesome', 'MMM threesome'],
  ['Mother-daughter incest', 'mother-daughter incest'],
  ['Mother-son incest', 'mother-son incest'],
  ['Netorare', 'netorare'],
  ['Netori', 'netori'],
  ['Nurse', 'nurse'],
  ['Nurse office', 'nurse office'],
  ['Oral', 'oral'],
  ['Orgy', 'orgy'],
  ['Pregnant sex', 'pregnant sex'],
  ['Public sex', 'public sex'],
  ['Rape', 'rape'],
  ['Reverse harem', 'reverse harem'],
  ['Reverse trap', 'reverse trap'],
  ['Rimming', 'rimming'],
  ['Scat', 'scat'],
  ['Self-parody', 'self-parody'],
  ['Sex toys', 'sex toys'],
  ['Shibari', 'shibari'],
  ['Sister-sister incest', 'sister-sister incest'],
  ['Slavery', 'slavery'],
  ['Squirting', 'squirting'],
  ['Strap-on dildo', 'strap-on dildo'],
  ['Strapon', 'strapon'],
  ['Strappado', 'strappado'],
  ['Strappado bondage', 'strappado bondage'],
  ['Succubus', 'succubus'],
  ['Suspension bondage', 'suspension bondage'],
  ['Teacher x student', 'teacher x student'],
  ['Tentacle', 'tentacle'],
  ['Threesome', 'threesome'],
  ['Threesome with sisters', 'threesome with sisters'],
  ['Trap', 'trap'],
  ['Trapped', 'trapped'],
  ['Twincest', 'twincest'],
  ['Uncle-niece incest', 'uncle-niece incest'],
  ['Unintentional comedy', 'unintentional comedy'],
  ['Vanilla Series', 'Vanilla Series'],
  ['Voyeurism', 'voyeurism'],
  ['Water sex', 'water sex'],
  ['Whip', 'whip'],
  ['Whipping', 'whipping'],
  ['Window fuck', 'window fuck'],
  ['Yaoi', 'yaoi'],
  ['Yuri', 'yuri']
]

function genreTagMap() {
  var map = {};
  GENRES.forEach(function (pair) {
    map[String(pair[0]).toLowerCase()] = pair[1];
    map[String(pair[1]).toLowerCase()] = pair[1];
  });
  map['school girl'] = 'high school';
  map['schoolgirl'] = 'high school';
  map['school girls'] = 'high school';
  map['uncensored'] = map['uncensored'] || 'Vanilla Series';
  map['vanilla'] = 'Vanilla Series';
  map['milf'] = map['milf'] || 'female teacher';
  map['ntr'] = 'netorare';
  map['pregnant'] = 'pregnant sex';
  map['swim suit'] = map['swimsuit'] || 'swimsuit';
  map['blow job'] = map['blowjob'] || 'blowjob';
  map['foot job'] = map['footjob'] || 'footjob';
  map['hand job'] = map['handjob'] || 'handjob';
  map['mind break'] = 'mind fuck';
  map['rimjob'] = 'rimming';
  return map;
}

function parseGenreTags(query) {
  var q = String(query || '').trim();
  if (!q) return [];
  var map = genreTagMap();
  var tags = [];
  var seen = {};
  function add(name) {
    var key = String(name || '').trim().toLowerCase().replace(/^genre:/i, '');
    if (!key) return;
    var tag = map[key];
    if (!tag || seen[tag]) return;
    seen[tag] = true;
    tags.push(tag);
  }
  if (q.indexOf(' | ') >= 0) {
    q.split(' | ').forEach(add);
    return tags;
  }
  if (map[q.toLowerCase()]) {
    add(q);
    return tags;
  }
  var re = /genre:([^\|]+?)(?=\s+genre:|$)/gi;
  var m;
  var found = false;
  while ((m = re.exec(q)) !== null) {
    found = true;
    add(m[1]);
  }
  return found ? tags : [];
}

async function getGenres() {
  return GENRES.map(function (pair) {
    return { id: pair[1], name: pair[0] };
  });
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
  // Cards use title="…" on the series anchor — no <img> in the search HTML.
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
    out.push({ title: title.trim(), image: '', url: url });
  }
  return out;
}

function coverFromSeriesHtml(html) {
  return (
    (html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i) || [])[1] ||
    (html.match(/content=["']([^"']+)["']\s+property=["']og:image["']/i) || [])[1] ||
    (html.match(/class=["'][^"']*cover-image[^"']*["'][^>]*\ssrc=["']([^"']+)["']/i) ||
      [])[1] ||
    (html.match(/src=["'](https:\/\/haho\.moe\/images\/anime\/[^"']+)["']/i) || [])[1] ||
    ''
  );
}

async function backfillCovers(cards, limit) {
  var need = cards.filter(function (c) {
    return c && c.url && !c.image;
  }).slice(0, typeof limit === 'number' ? limit : 12);
  await Promise.all(
    need.map(async function (c) {
      try {
        var res = await fetchv2(c.url, headers(BASE + '/'), 'GET', null);
        if (!res.ok) return;
        var img = coverFromSeriesHtml(await res.text());
        if (img) c.image = absolute(img);
      } catch (e) {
        /* keep empty image */
      }
    })
  );
  return cards;
}

async function jsonSearch(q) {
  await ensureSession();
  var res = await fetchv2(
    BASE + '/anime/search',
    Object.assign(headers(BASE + '/anime'), {
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-TOKEN': csrfToken,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json, text/javascript, */*; q=0.01'
    }),
    'POST',
    'q=' + encodeURIComponent(q || '')
  );
  if (!res.ok) throw new Error('haho json search failed: HTTP ' + res.status);
  var raw = await res.text();
  var data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('haho json search: invalid JSON');
  }
  if (!Array.isArray(data)) return [];
  var out = [];
  var seen = {};
  data.forEach(function (item) {
    if (!item) return;
    var url = absolute(item.url || '');
    var id = seriesIdFromUrl(url);
    if (!url || !id || seen[id]) return;
    seen[id] = true;
    out.push({
      title: String(item.title || '').trim() || id,
      image: absolute(item.cover || item.image || ''),
      url: url
    });
  });
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

/** `order:view-count` or `order:view-count+tag:uncensored` */
function parseCatalogQuery(query) {
  var m = String(query || '')
    .trim()
    .match(/^order:([a-z0-9\-]+)(?:\+tag:([a-z0-9\-]+))?$/i);
  if (!m) return { order: '', tag: '' };
  return { order: m[1].toLowerCase(), tag: m[2] ? m[2].toLowerCase() : '' };
}

function parseOrderQuery(query) {
  return parseCatalogQuery(query).order;
}

async function searchResults(query) {
  var catalog = parseCatalogQuery(query);
  var genreTags = parseGenreTags(query);
  if (catalog.tag) genreTags = [catalog.tag.replace(/-/g, ' ')].concat(genreTags);
  var q = String(query || '').trim();
  var filterTitles = true;
  var useJson = false;

  if (catalog.order && !catalog.tag) {
    // Newest-ish listing (no sort API)
    q = '';
    filterTitles = false;
  } else if (genreTags.length) {
    q = genreTags
      .map(function (t) {
        return 'genre:' + t;
      })
      .join(' ');
    filterTitles = false;
  } else if (q && !/^order:/i.test(q) && !/^genre:/i.test(q)) {
    useJson = true;
  }

  if (useJson) {
    try {
      var jsonCards = await jsonSearch(q);
      if (jsonCards.length) return jsonCards.slice(0, 24);
    } catch (e) {
      // Fall through to HTML scrape.
    }
  }

  var url = BASE + '/anime?q=' + encodeURIComponent(q);
  var res = await fetchv2(url, headers(BASE + '/'), 'GET', null);
  if (!res.ok) throw new Error('haho search failed: HTTP ' + res.status);
  var cards = parseSearchCards(await res.text());
  if (filterTitles) {
    cards = cards.filter(function (c) {
      return matchesQuery(c, query);
    });
  }
  await backfillCovers(cards, 12);
  return cards;
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
    extractStreamUrl: extractStreamUrl,
    getGenres: getGenres
  };
}
