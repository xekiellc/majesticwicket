// fetch-cricket-news.js — MajesticWicket v2
// Runs 4x daily via GitHub Actions
// Fetches: news (RSS + Claude) + stats (CricketData API) + archive

const https = require('https');
const http  = require('http');
const fs    = require('fs');

const CLAUDE_API_KEY      = process.env.CLAUDE_API_KEY;
const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY;

if (!CLAUDE_API_KEY) {
  console.error('❌ Missing CLAUDE_API_KEY');
  process.exit(1);
}

// ── RSS FEEDS — free, no API key, server-safe ──
const RSS_FEEDS = [
  'https://www.espncricinfo.com/rss/content/story/feeds/0.xml',
  'https://www.crictracker.com/feed/',
  'https://news.google.com/rss/search?q=cricket+IPL+2025&hl=en-IN&gl=IN&ceid=IN:en',
  'https://news.google.com/rss/search?q=cricket+PSL+2026&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=cricket+test+match+2025&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=cricket+T20+world+cup&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=cricket+Big+Bash+BBL&hl=en&gl=AU&ceid=AU:en',
  'https://news.google.com/rss/search?q=cricket+The+Hundred+2026&hl=en-GB&gl=GB&ceid=GB:en',
  'https://news.google.com/rss/search?q=cricket+SA20+South+Africa&hl=en&gl=ZA&ceid=ZA:en',
  'https://news.google.com/rss/search?q=cricket+Major+League+Cricket+MLC+USA&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=Virat+Kohli+cricket&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=Babar+Azam+cricket&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=Ben+Stokes+cricket&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=cricket+women+international+2025&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=cricket+news+latest&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=cricket+match+results&hl=en&gl=US&ceid=US:en',
];

const CULTURE_FEEDS = [
  'https://news.google.com/rss/search?q=cricket+history+culture+traditions&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=cricket+explained+beginners+rules&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=cricket+greatest+moments+records&hl=en&gl=US&ceid=US:en',
];

// ── SERIES IDs from CricketData API ──
const LEAGUE_SERIES = {
  ipl:     { name: 'IPL',         seriesId: 'd5a498c8-7596-4b93-8ab0-e0efc3345312' },
  bbl:     { name: 'BBL',         seriesId: '4e2f50ed-ed84-46fc-bdcb-ace304b0da34' },
  psl:     { name: 'PSL',         seriesId: '9aede005-627e-47d9-8cad-088c8f5585d7' },
  cpl:     { name: 'CPL',         seriesId: 'd83eabfc-d381-4ea2-aa1d-9765506bdd9d' },
  hundred: { name: 'The Hundred', seriesId: 'ac5127e7-663b-4666-83ca-38f5d6935228' },
  sa20:    { name: 'SA20',        seriesId: 'a74cee46-9c63-4f2a-bb27-96bee995a45e' },
  mlc:     { name: 'MLC',         seriesId: '5f750f13-3544-4f5e-aa4a-b5efdfbed824' },
  test:    { name: 'Tests',       seriesId: null },
  t20wc:   { name: 'T20 WC',      seriesId: null },
  ashes:   { name: 'Ashes',       seriesId: null },
  wpl:     { name: 'WPL',         seriesId: null },
  odi:     { name: 'ODI WC',      seriesId: null },
};

// ── HTTP/HTTPS fetch with redirect following ──
function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'MajesticWicket/2.0 RSS Reader' } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchUrl(res.headers.location, redirectCount + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ── Parse RSS/Atom XML into article objects ──
function parseRSS(xml, feedUrl) {
  const articles = [];
  const itemRegex = /<(item|entry)[\s>]([\s\S]*?)<\/(item|entry)>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[2];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'))
             || block.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };
    let title = get('title');
    let url = get('link') || get('guid') || get('id');
    if (!url) {
      const linkHref = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (linkHref) url = linkHref[1];
    }
    const description = get('description') || get('summary') || get('content');
    const pubDate = get('pubDate') || get('published') || get('updated') || '';
    const sourceName = feedUrl.includes('espncricinfo') ? 'ESPNcricinfo'
                     : feedUrl.includes('icc-cricket')  ? 'ICC'
                     : feedUrl.includes('crictracker')  ? 'CricTracker'
                     : feedUrl.includes('theroar')      ? 'The Roar'
                     : feedUrl.includes('google.com')   ? 'Google News'
                     : new URL(feedUrl).hostname.replace('www.', '');

    if (title && url && !title.includes('[Removed]')) {
      articles.push({
        title:       title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
        url:         url.trim(),
        description: description.replace(/<[^>]+>/g, '').substring(0, 300),
        publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        source:      { name: sourceName },
        urlToImage:  null,
      });
    }
  }
  return articles;
}

async function fetchFeed(feedUrl) {
  try {
    const xml = await fetchUrl(feedUrl);
    const articles = parseRSS(xml, feedUrl);
    console.log(`  ✓ ${new URL(feedUrl).hostname}: ${articles.length} items`);
    return articles;
  } catch(e) {
    console.warn(`  ⚠ Feed failed (${feedUrl.substring(0, 60)}...): ${e.message}`);
    return [];
  }
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

function httpsPost(hostname, path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function dedup(articles) {
  const seen = new Set();
  return articles.filter(a => {
    const key = a.url.split('?')[0];
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// ── Claude filter — chunks large lists to stay under token limits ──
async function claudeFilterChunk(articles, mode, maxSelect) {
  if (!articles.length) return [];
  const summaries = articles.map((a, i) =>
    `${i}. TITLE: ${a.title}\n   DESC: ${(a.description || 'N/A').substring(0, 100)}\n   SOURCE: ${a.source?.name || '?'}`
  ).join('\n\n');

  const system = mode === 'culture'
    ? `You curate content for MajesticWicket.com. Select articles about cricket culture, history, traditions, player profiles, and cricket-explained content. You MUST respond with ONLY a raw JSON array of index numbers and absolutely nothing else. No explanation, no preamble, no markdown. Just the array. Maximum ${maxSelect}. Example response: [0,2,5]`
    : `You curate content for MajesticWicket.com, a global cricket hub. Select the most newsworthy cricket articles covering match results, player news, league updates, transfers. Remove duplicates and off-topic content. You MUST respond with ONLY a raw JSON array of index numbers and absolutely nothing else. No explanation, no preamble, no markdown. Just the array. Maximum ${maxSelect}. Example response: [0,1,3]`;

  try {
    const res = await httpsPost('api.anthropic.com', '/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system,
      messages: [{ role: 'user', content: `Select from:\n\n${summaries}` }],
    });
    const text = res.content?.[0]?.text || '[]';
    const match = text.match(/\[[\d,\s]+\]/);
    const indices = JSON.parse(match ? match[0] : '[]');
    return indices.map(i => articles[i]).filter(Boolean);
  } catch(e) {
    console.warn(`  ⚠ Claude chunk failed: ${e.message}`);
    return articles.slice(0, maxSelect);
  }
}

async function claudeFilter(articles, mode = 'news') {
  if (!articles.length) return articles;

  const CHUNK_SIZE = 150;  // safe token limit per call
  const finalMax   = mode === 'news' ? 40 : 20;
  const perChunk   = mode === 'news' ? 10 : 5;  // pick best N per chunk

  if (articles.length <= CHUNK_SIZE) {
    // Small enough — single call
    return claudeFilterChunk(articles, mode, finalMax);
  }

  // Chunk into groups of CHUNK_SIZE, pick top perChunk from each
  console.log(`  Chunking ${articles.length} articles into ${Math.ceil(articles.length / CHUNK_SIZE)} batches...`);
  const chunks = [];
  for (let i = 0; i < articles.length; i += CHUNK_SIZE) {
    chunks.push(articles.slice(i, i + CHUNK_SIZE));
  }

  const chunkResults = [];
  for (const chunk of chunks) {
    const selected = await claudeFilterChunk(chunk, mode, perChunk);
    chunkResults.push(...selected);
    await new Promise(r => setTimeout(r, 300)); // avoid rate limiting
  }

  console.log(`  Round 1: ${chunkResults.length} candidates — running final selection...`);

  // Final pass: pick best finalMax from all chunk winners
  const deduped = dedup(chunkResults);
  return claudeFilterChunk(deduped, mode, finalMax);
}

async function fetchLeagueStats(leagueId, seriesId) {
  if (!CRICKETDATA_API_KEY || !seriesId) return null;
  try {
    const base = `https://api.cricapi.com/v1`;
    const key  = `apikey=${CRICKETDATA_API_KEY}`;
    const [standings, batting, bowling] = await Promise.allSettled([
      httpsGet(`${base}/series_points_table?${key}&id=${seriesId}`),
      httpsGet(`${base}/series_stats?${key}&id=${seriesId}&stats_type=mostRuns`),
      httpsGet(`${base}/series_stats?${key}&id=${seriesId}&stats_type=mostWickets`),
    ]);
    return {
      standings: standings.status === 'fulfilled' ? (standings.value.data || []).slice(0, 10) : [],
      topBatters: batting.status === 'fulfilled'  ? (batting.value.data  || []).slice(0, 5)  : [],
      topBowlers: bowling.status === 'fulfilled'  ? (bowling.value.data  || []).slice(0, 5)  : [],
    };
  } catch(e) {
    console.warn(`  ⚠ Stats fetch failed for ${leagueId}: ${e.message}`);
    return null;
  }
}

async function fetchAllStats() {
  if (!CRICKETDATA_API_KEY) {
    console.log('ℹ CRICKETDATA_API_KEY not set — skipping stats');
    return {};
  }
  console.log('Fetching league stats...');
  const results = {};
  for (const [id, cfg] of Object.entries(LEAGUE_SERIES)) {
    if (!cfg.seriesId) { console.log(`  ℹ ${cfg.name}: no series ID`); continue; }
    console.log(`  Fetching ${cfg.name}...`);
    const data = await fetchLeagueStats(id, cfg.seriesId);
    if (data) results[id] = data;
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

function updateArchive(newArticles) {
  let archive = {};
  try {
    const raw = fs.readFileSync('./archive.json', 'utf8');
    archive = JSON.parse(raw);
  } catch(e) {}

  const today = new Date().toISOString().split('T')[0];
  const existing = archive[today] || [];
  const existingUrls = new Set(existing.map(a => a.url));
  const toAdd = newArticles.filter(a => !existingUrls.has(a.url));
  archive[today] = [...existing, ...toAdd];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  for (const date of Object.keys(archive)) {
    if (new Date(date) < cutoff) delete archive[date];
  }

  fs.writeFileSync('./archive.json', JSON.stringify(archive, null, 2));
  console.log(`✅ Archive updated: ${toAdd.length} new articles for ${today}`);
}

async function main() {
  console.log('🏏 MajesticWicket pipeline starting...');
  console.log('   Time:', new Date().toISOString());

  let existing = { articles: [], culture: [], videos: [], lastUpdated: null };
  try { existing = JSON.parse(fs.readFileSync('./articles.json', 'utf8')); }
  catch(e) { console.log('No existing articles.json — fresh start'); }

  console.log(`\nFetching news (${RSS_FEEDS.length} RSS feeds)...`);
  const rawNews = dedup((await Promise.all(RSS_FEEDS.map(fetchFeed))).flat());
  console.log(`  Raw: ${rawNews.length} articles`);

  console.log(`Fetching culture (${CULTURE_FEEDS.length} RSS feeds)...`);
  const rawCulture = dedup((await Promise.all(CULTURE_FEEDS.map(fetchFeed))).flat());
  console.log(`  Raw: ${rawCulture.length} articles`);

  if (rawNews.length < 5) {
    console.warn('⚠ Too few articles — keeping existing data');
    process.exit(0);
  }

  console.log('\nRunning Claude curation...');
  // Run sequentially to avoid simultaneous large payloads
  const curatedNews    = await claudeFilter(rawNews, 'news');
  const curatedCulture = await claudeFilter(rawCulture, 'culture');
  console.log(`  News: ${curatedNews.length} | Culture: ${curatedCulture.length}`);

  const statsData = await fetchAllStats();

  const articlesOut = {
    lastUpdated: new Date().toISOString(),
    articles: curatedNews,
    culture: curatedCulture,
    videos: existing.videos || [],
  };
  fs.writeFileSync('./articles.json', JSON.stringify(articlesOut, null, 2));
  console.log('✅ articles.json written');

  fs.writeFileSync('./stats.json', JSON.stringify({
    lastUpdated: new Date().toISOString(),
    ...statsData,
  }, null, 2));
  console.log('✅ stats.json written');

  updateArchive(curatedNews);

  console.log('\n🏏 Pipeline complete!');
  console.log(`   Articles: ${curatedNews.length} | Culture: ${curatedCulture.length} | Stats leagues: ${Object.keys(statsData).length}`);
}

main().catch(e => {
  console.error('❌ Pipeline error:', e);
  process.exit(1);
});
