// fetch-cricket-news.js — MajesticWicket v3
// Runs 4x daily via GitHub Actions
// Fetches: news (RSS + Claude) + stats (CricketData API — calculated from match results)

const https = require('https');
const http  = require('http');
const fs    = require('fs');

const CLAUDE_API_KEY      = process.env.CLAUDE_API_KEY;
const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY;

if (!CLAUDE_API_KEY) {
  console.error('❌ Missing CLAUDE_API_KEY');
  process.exit(1);
}

const RSS_FEEDS = [
  'https://www.espncricinfo.com/rss/content/story/feeds/0.xml',
  'https://www.crictracker.com/feed/',
  'https://news.google.com/rss/search?q=cricket+IPL+2026&hl=en-IN&gl=IN&ceid=IN:en',
  'https://news.google.com/rss/search?q=cricket+PSL+2026&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=cricket+test+match+2026&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=cricket+T20+world+cup+2026&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=cricket+Big+Bash+BBL&hl=en&gl=AU&ceid=AU:en',
  'https://news.google.com/rss/search?q=cricket+The+Hundred+2026&hl=en-GB&gl=GB&ceid=GB:en',
  'https://news.google.com/rss/search?q=cricket+SA20+South+Africa&hl=en&gl=ZA&ceid=ZA:en',
  'https://news.google.com/rss/search?q=cricket+Major+League+Cricket+MLC+USA&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=Virat+Kohli+cricket&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=Babar+Azam+cricket&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=Ben+Stokes+cricket&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=cricket+women+international+2026&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=cricket+news+today&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=cricket+match+results+today&hl=en&gl=US&ceid=US:en',
];

const CULTURE_FEEDS = [
  'https://news.google.com/rss/search?q=cricket+history+culture+traditions&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=cricket+explained+beginners+rules&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=cricket+greatest+moments+records&hl=en&gl=US&ceid=US:en',
];

// Series IDs — used for series_info standings calculation
const LEAGUE_SERIES = {
  ipl:     { name: 'IPL 2026',        seriesId: '87c62aac-bc3c-4738-ab93-19da0690488f' },
  psl:     { name: 'PSL 2026',        seriesId: '9aede005-627e-47d9-8cad-088c8f5585d7' },
  bbl:     { name: 'BBL 2025-26',     seriesId: '4e2f50ed-ed84-46fc-bdcb-ace304b0da34' },
  cpl:     { name: 'CPL 2025',        seriesId: 'd83eabfc-d381-4ea2-aa1d-9765506bdd9d' },
  hundred: { name: 'The Hundred 2025',seriesId: 'ac5127e7-663b-4666-83ca-38f5d6935228' },
  sa20:    { name: 'SA20 2025-26',    seriesId: 'a74cee46-9c63-4f2a-bb27-96bee995a45e' },
  mlc:     { name: 'MLC 2025',        seriesId: '5f750f13-3544-4f5e-aa4a-b5efdfbed824' },
};

// ── HTTP/HTTPS helpers ──────────────────────────────────────────────────────

function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'MajesticWicket/3.0 RSS Reader' } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchUrl(res.headers.location, redirectCount + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
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

// ── RSS parsing ─────────────────────────────────────────────────────────────

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
    const rawDesc = get('description') || get('summary') || get('content');
    const description = rawDesc
      .replace(/<a[^>]*>[\s\S]*?<\/a>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim()
      .substring(0, 300);

    const pubDate = get('pubDate') || get('published') || get('updated') || '';
    const sourceName = feedUrl.includes('espncricinfo') ? 'ESPNcricinfo'
                     : feedUrl.includes('crictracker')  ? 'CricTracker'
                     : feedUrl.includes('google.com')   ? 'Google News'
                     : new URL(feedUrl).hostname.replace('www.', '');

    if (title && url && !title.includes('[Removed]')) {
      articles.push({
        title:       title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"'),
        url:         url.trim(),
        description,
        publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        source:      { name: sourceName },
        urlToImage:  null,
      });
    }
  }
  return articles;
}

function filterFresh(articles, maxAgeDays) {
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const fresh = articles.filter(a => {
    try { return new Date(a.publishedAt).getTime() > cutoff; }
    catch(_) { return true; }
  });
  console.log(`  Freshness filter: ${articles.length} → ${fresh.length} articles (last ${maxAgeDays} days)`);
  return fresh;
}

async function fetchFeed(feedUrl) {
  try {
    const xml = await fetchUrl(feedUrl);
    const articles = parseRSS(xml, feedUrl);
    console.log(`  ✓ ${new URL(feedUrl).hostname}: ${articles.length} items`);
    return articles;
  } catch(e) {
    console.warn(`  ⚠ Feed failed (${feedUrl.substring(0,60)}...): ${e.message}`);
    return [];
  }
}

function dedup(articles) {
  const seen = new Set();
  return articles.filter(a => {
    const key = a.url.split('?')[0];
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// ── Claude curation ─────────────────────────────────────────────────────────

async function claudeFilterChunk(articles, mode, maxSelect) {
  if (!articles.length) return [];
  const summaries = articles.map((a, i) =>
    `${i}. TITLE: ${a.title}\n   DESC: ${(a.description||'N/A').substring(0,100)}\n   SOURCE: ${a.source?.name||'?'}`
  ).join('\n\n');

  const system = mode === 'culture'
    ? `You curate content for MajesticWicket.com. Select articles about cricket culture, history, traditions, player profiles, and cricket-explained content. Respond with ONLY a JSON array of integer index numbers. No words, no explanation, no markdown fences. Just the raw array. Maximum ${maxSelect}. Example: [0,2,5]`
    : `You curate content for MajesticWicket.com, a global cricket hub. Select the most newsworthy cricket articles covering match results, player news, league updates, transfers. Remove duplicates and off-topic content. Respond with ONLY a JSON array of integer index numbers. No words, no explanation, no markdown fences. Just the raw array. Maximum ${maxSelect}. Example: [0,1,3]`;

  try {
    const res = await httpsPost('api.anthropic.com', '/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: `Select best articles from this list:\n\n${summaries}` }],
    });
    const text = (res.content?.[0]?.text || '').trim();
    console.log(`    Claude response (first 80 chars): ${text.substring(0,80)}`);
    try {
      const indices = JSON.parse(text);
      if (Array.isArray(indices)) return indices.map(i => articles[i]).filter(Boolean);
    } catch(_) {}
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const indices = JSON.parse(match[0]);
      if (Array.isArray(indices)) return indices.map(i => articles[i]).filter(Boolean);
    }
    console.warn(`    ⚠ Could not parse Claude response — using first ${maxSelect} raw`);
    return articles.slice(0, maxSelect);
  } catch(e) {
    console.warn(`  ⚠ Claude chunk failed: ${e.message}`);
    return articles.slice(0, maxSelect);
  }
}

async function claudeFilter(articles, mode = 'news') {
  if (!articles.length) return articles;
  const CHUNK_SIZE = 150;
  const finalMax   = mode === 'news' ? 40 : 20;
  const perChunk   = mode === 'news' ? 10 : 5;

  if (articles.length <= CHUNK_SIZE) {
    return claudeFilterChunk(articles, mode, finalMax);
  }

  console.log(`  Chunking ${articles.length} articles into ${Math.ceil(articles.length/CHUNK_SIZE)} batches...`);
  const chunks = [];
  for (let i = 0; i < articles.length; i += CHUNK_SIZE) {
    chunks.push(articles.slice(i, i + CHUNK_SIZE));
  }
  const chunkResults = [];
  for (const chunk of chunks) {
    const selected = await claudeFilterChunk(chunk, mode, perChunk);
    chunkResults.push(...selected);
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log(`  Round 1: ${chunkResults.length} candidates — running final selection...`);
  return claudeFilterChunk(dedup(chunkResults), mode, finalMax);
}

// ── Standings calculator ────────────────────────────────────────────────────
// Derives a points table from raw match results returned by series_info

function calculateStandings(matchList) {
  const teams = {};

  const getTeam = (name) => {
    if (!teams[name]) {
      teams[name] = { team: name, played: 0, won: 0, lost: 0, nr: 0, points: 0 };
    }
    return teams[name];
  };

  for (const match of matchList) {
    const status = match.status || '';
    const matchTeams = match.teams || [];
    if (matchTeams.length !== 2) continue;
    if (!match.matchEnded) continue;

    const [t1, t2] = matchTeams;
    const s = status.toLowerCase();

    // No result / abandoned / rain
    if (s.includes('no result') || s.includes('abandoned') || s.includes('cancel') || s.includes('technical failure')) {
      getTeam(t1).played++; getTeam(t1).nr++; getTeam(t1).points++;
      getTeam(t2).played++; getTeam(t2).nr++; getTeam(t2).points++;
      continue;
    }

    // Playoff matches — skip for points table (Qualifier, Eliminator, Final, Semi)
    const name = (match.name || '').toLowerCase();
    if (name.includes('qualifier') || name.includes('eliminator') || name.includes('final') || name.includes('semi')) {
      continue;
    }

    // Determine winner — status typically says "Team X won by..."
    let winner = null;
    for (const t of matchTeams) {
      if (s.startsWith(t.toLowerCase()) && s.includes('won')) {
        winner = t;
        break;
      }
    }
    // Fallback: check if either team name appears before "won"
    if (!winner) {
      for (const t of matchTeams) {
        if (s.includes(t.toLowerCase() + ' won')) {
          winner = t;
          break;
        }
      }
    }

    if (winner) {
      const loser = matchTeams.find(t => t !== winner);
      getTeam(winner).played++; getTeam(winner).won++; getTeam(winner).points += 2;
      getTeam(loser).played++;  getTeam(loser).lost++;
    } else {
      // Can't determine winner — treat as NR
      getTeam(t1).played++; getTeam(t1).nr++; getTeam(t1).points++;
      getTeam(t2).played++; getTeam(t2).nr++; getTeam(t2).points++;
    }
  }

  // Sort by points desc, then wins desc
  return Object.values(teams)
    .sort((a, b) => b.points - a.points || b.won - a.won)
    .map(t => ({
      team:   t.team,
      played: t.played,
      won:    t.won,
      lost:   t.lost,
      nr:     t.nr,
      points: t.points,
    }));
}

// ── Stats fetching ──────────────────────────────────────────────────────────

async function fetchSeriesStandings(leagueKey, leagueCfg) {
  if (!CRICKETDATA_API_KEY || !leagueCfg.seriesId) return null;
  try {
    const url = `https://api.cricapi.com/v1/series_info?apikey=${CRICKETDATA_API_KEY}&id=${leagueCfg.seriesId}`;
    const res  = await httpsGet(url);

    if (res.status !== 'success' || !res.data) {
      console.log(`    ${leagueKey}: API status=${res.status} reason=${res.reason||'unknown'}`);
      return null;
    }

    const matchList  = res.data.matchList || [];
    const seriesInfo = res.data.info      || {};
    const standings  = calculateStandings(matchList);

    console.log(`    ${leagueKey}: ${matchList.length} matches → ${standings.length} teams in standings`);

    return {
      seriesName: seriesInfo.name || leagueCfg.name,
      startDate:  seriesInfo.startdate || '',
      endDate:    seriesInfo.enddate   || '',
      standings,
      topBatters: [],  // not available on current plan — future upgrade
      topBowlers: [],
    };
  } catch(e) {
    console.warn(`  ⚠ Stats fetch failed for ${leagueKey}: ${e.message}`);
    return null;
  }
}

async function fetchRecentMatches() {
  if (!CRICKETDATA_API_KEY) return [];
  try {
    const url = `https://api.cricapi.com/v1/currentMatches?apikey=${CRICKETDATA_API_KEY}&offset=0`;
    const res  = await httpsGet(url);
    if (res.status !== 'success') return [];
    console.log(`  currentMatches: ${(res.data||[]).length} matches fetched`);
    return res.data || [];
  } catch(e) {
    console.warn(`  ⚠ currentMatches failed: ${e.message}`);
    return [];
  }
}

async function fetchAllStats() {
  if (!CRICKETDATA_API_KEY) {
    console.log('ℹ CRICKETDATA_API_KEY not set — skipping stats');
    return { standings: {}, recentMatches: [] };
  }

  console.log('Fetching recent matches...');
  const recentMatches = await fetchRecentMatches();
  await new Promise(r => setTimeout(r, 500));

  console.log('Fetching series standings...');
  const standings = {};
  for (const [id, cfg] of Object.entries(LEAGUE_SERIES)) {
    console.log(`  Fetching ${cfg.name}...`);
    const data = await fetchSeriesStandings(id, cfg);
    if (data) {
      standings[id] = data;
      console.log(`  ✓ ${cfg.name}: ${data.standings.length} teams`);
    }
    await new Promise(r => setTimeout(r, 600));
  }

  return { standings, recentMatches };
}

// ── Archive ─────────────────────────────────────────────────────────────────

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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🏏 MajesticWicket pipeline starting...');
  console.log('   Time:', new Date().toISOString());

  let existing = { articles: [], culture: [], videos: [], lastUpdated: null };
  try { existing = JSON.parse(fs.readFileSync('./articles.json', 'utf8')); }
  catch(e) { console.log('No existing articles.json — fresh start'); }

  console.log(`\nFetching news (${RSS_FEEDS.length} RSS feeds)...`);
  const rawNewsAll = dedup((await Promise.all(RSS_FEEDS.map(fetchFeed))).flat());
  const rawNews    = filterFresh(rawNewsAll, 7);
  console.log(`  Raw after filter: ${rawNews.length} articles`);

  console.log(`Fetching culture (${CULTURE_FEEDS.length} RSS feeds)...`);
  const rawCultureAll = dedup((await Promise.all(CULTURE_FEEDS.map(fetchFeed))).flat());
  const rawCulture    = filterFresh(rawCultureAll, 30);
  console.log(`  Raw after filter: ${rawCulture.length} articles`);

  if (rawNews.length < 5) {
    console.warn('⚠ Too few articles — keeping existing data');
    process.exit(0);
  }

  console.log('\nRunning Claude curation...');
  const curatedNews    = await claudeFilter(rawNews, 'news');
  const curatedCulture = await claudeFilter(rawCulture, 'culture');
  console.log(`  News: ${curatedNews.length} | Culture: ${curatedCulture.length}`);

  const { standings, recentMatches } = await fetchAllStats();

  const articlesOut = {
    lastUpdated: new Date().toISOString(),
    articles:    curatedNews,
    culture:     curatedCulture,
    videos:      existing.videos || [],
  };
  fs.writeFileSync('./articles.json', JSON.stringify(articlesOut, null, 2));
  console.log('✅ articles.json written');

  fs.writeFileSync('./stats.json', JSON.stringify({
    lastUpdated: new Date().toISOString(),
    recentMatches,
    ...standings,
  }, null, 2));
  console.log('✅ stats.json written');

  updateArchive(curatedNews);

  console.log('\n🏏 Pipeline complete!');
  console.log(`   Articles: ${curatedNews.length} | Culture: ${curatedCulture.length} | Leagues with standings: ${Object.keys(standings).length}`);
}

main().catch(e => {
  console.error('❌ Pipeline error:', e);
  process.exit(1);
});
