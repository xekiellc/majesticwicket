// fetch-cricket-news.js — MajesticWicket v2
// Runs 4x daily via GitHub Actions
// Fetches: news (NewsAPI + Claude) + stats (CricketData API) + archive

const https = require('https');
const fs    = require('fs');

const NEWS_API_KEY        = process.env.NEWS_API_KEY;
const CLAUDE_API_KEY      = process.env.CLAUDE_API_KEY;
const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY;

if (!NEWS_API_KEY || !CLAUDE_API_KEY) {
  console.error('❌ Missing NEWS_API_KEY or CLAUDE_API_KEY');
  process.exit(1);
}

const NEWS_QUERIES = [
  'IPL Indian Premier League cricket 2025',
  'Big Bash League BBL cricket',
  'Pakistan Super League PSL cricket',
  'Caribbean Premier League CPL cricket',
  'The Hundred cricket England',
  'SA20 cricket South Africa',
  'Bangladesh Premier League BPL cricket',
  'Lanka Premier League LPL cricket',
  'Major League Cricket MLC USA',
  'Women Premier League WPL cricket India',
  'Test cricket series 2025',
  'T20 World Cup cricket ICC',
  'ODI cricket ICC',
  'ICC World Test Championship',
  'The Ashes England Australia cricket',
  'cricket India vs England',
  'cricket Australia vs India',
  'cricket Pakistan vs New Zealand',
  'cricket Virat Kohli',
  'cricket Joe Root',
  'cricket Steve Smith',
  'cricket Babar Azam',
  'cricket Ben Stokes',
  'cricket Rohit Sharma',
  'cricket women international 2025',
  'cricket United States America growing',
  'cricket history culture tradition',
  'cricket transfer signing 2025',
  'cricket match results today',
  'cricket news latest',
];

const CULTURE_QUERIES = [
  'cricket history origin traditions',
  'cricket culture fans festival',
  'cricket rules explained beginners',
  'cricket greatest moments history',
  'cricket records statistics all time',
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

async function fetchQuery(query) {
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=5&apiKey=${NEWS_API_KEY}`;
  try {
    const data = await httpsGet(url);
    return (data.articles || []).filter(a =>
      a.title && a.url &&
      a.title !== '[Removed]' &&
      !a.title.toLowerCase().includes('[removed]')
    );
  } catch(e) {
    console.warn(`  ⚠ Query failed: "${query}": ${e.message}`);
    return [];
  }
}

function dedup(articles) {
  const seen = new Set();
  return articles.filter(a => {
    if (seen.has(a.url)) return false;
    seen.add(a.url); return true;
  });
}

async function claudeFilter(articles, mode = 'news') {
  if (!articles.length) return articles;
  const summaries = articles.map((a, i) =>
    `${i}. TITLE: ${a.title}\n   DESC: ${a.description || 'N/A'}\n   SOURCE: ${a.source?.name || '?'}`
  ).join('\n\n');

  const system = mode === 'culture'
    ? `You curate content for MajesticWicket.com. Select articles about cricket culture, history, traditions, player profiles, and cricket-explained content. Return ONLY a JSON array of index numbers. Maximum 20. Example: [0,2,5]`
    : `You curate content for MajesticWicket.com, a global cricket hub. Select the most newsworthy cricket articles covering match results, player news, league updates, transfers. Remove duplicates and off-topic content. Return ONLY a JSON array of index numbers. Maximum 40. Example: [0,1,3]`;

  try {
    const res = await httpsPost('api.anthropic.com', '/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system,
      messages: [{ role: 'user', content: `Select from:\n\n${summaries}` }],
    });
    const text = res.content?.[0]?.text || '[]';
    const indices = JSON.parse(text.replace(/```json|```/g, '').trim());
    return indices.map(i => articles[i]).filter(Boolean);
  } catch(e) {
    console.warn('  ⚠ Claude filter failed, using raw:', e.message);
    return articles.slice(0, mode === 'culture' ? 20 : 40);
  }
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

  console.log(`\nFetching news (${NEWS_QUERIES.length} queries)...`);
  const rawNews = dedup((await Promise.all(NEWS_QUERIES.map(fetchQuery))).flat());
  console.log(`  Raw: ${rawNews.length} articles`);

  console.log(`Fetching culture (${CULTURE_QUERIES.length} queries)...`);
  const rawCulture = dedup((await Promise.all(CULTURE_QUERIES.map(fetchQuery))).flat());
  console.log(`  Raw: ${rawCulture.length} articles`);

  if (rawNews.length < 5) {
    console.warn('⚠ Too few articles — keeping existing data');
    process.exit(0);
  }

  console.log('\nRunning Claude curation...');
  const [curatedNews, curatedCulture] = await Promise.all([
    claudeFilter(rawNews, 'news'),
    claudeFilter(rawCulture, 'culture'),
  ]);
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
