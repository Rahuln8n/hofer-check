/**
 * Hofer / ALDI multi-country checker
 *
 * - Checks 6 countries (AT, CH, HU, DE, SI, IT)
 * - Discovers date-PLP links (like /d.08-12-2025.html) from the listing page
 * - Fetch-first, Playwright fallback
 * - Localized keyword matching to extract counts
 *
 * Configure:
 * - Optionally set SCRAPER_SECRET env var and call with header x-scraper-secret
 * - PORT from env or 3000
 */

const express = require('express');
let playwrightChromium = null;
try {
  // optional: Playwright may not be installed or available in some environments
  playwrightChromium = require('playwright').chromium;
} catch (e) {
  console.log('Playwright not available:', e.message ? e.message.split('\n')[0] : e);
}

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_req, res) => res.send('Hofer checker alive'));

// Countries config: base, listing path to discover PLPs, keywords to search for counts
const COUNTRIES = [
  { code: 'AT', base: 'https://www.hofer.at', listingPath: '/de/angebote', keywords: ['Aktionsartikel', 'Aktionsartikel gefunden', 'Aktionsartikel gefunden'] },
  { code: 'CH', base: 'https://www.aldi-suisse.ch', listingPath: '/de/aktionen-und-angebote', keywords: ['Aktionsartikel', 'Aktionsartikel gefunden'] },
  { code: 'HU', base: 'https://www.aldi.hu', listingPath: '/hu/ajanlatok', keywords: ['ajánlat', 'Ajánlat', 'ajánlatok'] },
  { code: 'DE', base: 'https://www.aldi-sued.de', listingPath: '/de/angebote', keywords: ['Angebote', 'Angebote gefunden'] },
  { code: 'SI', base: 'https://www.hofer.si', listingPath: '/sl/ponudba', keywords: ['ponudba', 'najdenih izdelkov', 'izdelkov'] },
  { code: 'IT', base: 'https://www.aldi.it', listingPath: '/it/offerte-settimanali', keywords: ['offerta', 'Prodotto in offerta', 'offerte'] }
];

/* helpers */

// simple fetch using global fetch (Node 18+)
async function tryFetchHtml(url, timeout = 20000) {
  try {
    if (typeof fetch !== 'function') return null;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept-Language': 'de-DE,de;q=0.9'
      },
      signal: controller.signal
    });
    clearTimeout(id);
    if (!r.ok) return null;
    const text = await r.text();
    return text;
  } catch (e) {
    // console.log('fetch error', url, e && e.message ? e.message : e);
    return null;
  }
}

function extractAnchorsFromHtml(html) {
  const hrefs = [];
  if (!html) return hrefs;
  try {
    const re = /<a\s+[^>]*href=(["'])(.*?)\1[^>]*>(.*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      hrefs.push({ href: m[2], text: (m[3] || '').replace(/<[^>]*>/g, '').trim() });
    }
  } catch (e) {}
  return hrefs;
}

// raw HTML scan for common date PLP pattern: /d.08-12-2025.html
function extractDatePlpLinksFromHtml(html, base) {
  const set = new Set();
  if (!html) return set;
  try {
    const re = /(?:href=)?["']?([^"'\s>]*\/d\.\d{2}-\d{2}-\d{4}\.html)["']?/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = m[1];
      if (!href) continue;
      const abs = href.startsWith('http') ? href : new URL(href, base).toString();
      set.add(abs.split('#')[0].split('?')[0]);
    }
  } catch (e) {}
  return set;
}

function normalizeAndCollect(href, base, set, listingKeywords = []) {
  if (!href) return;
  if (href.startsWith('javascript:')) return;
  const isInternal = href.startsWith('/') || href.includes(new URL(base).hostname);
  if (!isInternal) return;
  // gather if it contains date-PLP hint or listing keywords
  const looksLikePlp = /\/d\.\d{2}-\d{2}-\d{4}\.html/i.test(href) || href.toLowerCase().includes('/d.');
  const containsListingKeyword = listingKeywords.some(kw => (href || '').toLowerCase().includes(kw.toLowerCase()));
  if (looksLikePlp || containsListingKeyword || href.toLowerCase().includes('/angebote') || href.toLowerCase().includes('/offerte')) {
    const abs = href.startsWith('http') ? href : new URL(href, base).toString();
    set.add(abs.split('#')[0].split('?')[0]);
  }
}

function escapeRegex(s = '') {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// try to extract count from text using a list of localized keywords
function extractCountFromText(text, keywords = []) {
  if (!text) return null;
  // normalize whitespace
  const normalized = text.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ');
  // First try patterns: number ... keyword
  for (const kw of keywords) {
    if (!kw) continue;
    const re1 = new RegExp('(\\d{1,6})[^\\d\\n\\r]{0,30}' + escapeRegex(kw), 'i');
    const m1 = normalized.match(re1);
    if (m1 && m1[1]) return parseInt(m1[1], 10);
    // keyword ... number
    const re2 = new RegExp(escapeRegex(kw) + '[^\\d\\n\\r]{0,30}(\\d{1,6})', 'i');
    const m2 = normalized.match(re2);
    if (m2 && m2[1]) return parseInt(m2[1], 10);
  }
  // fallback: find lines containing a keyword then extract nearest number
  const lines = normalized.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    for (const kw of keywords) {
      if (lines[i].toLowerCase().includes((kw || '').toLowerCase())) {
        // search number in same line
        const mm = lines[i].match(/(\d{1,6})/);
        if (mm && mm[1]) return parseInt(mm[1], 10);
        // prev/next lines
        if (i > 0) { const mm2 = lines[i-1].match(/(\d{1,6})/); if (mm2 && mm2[1]) return parseInt(mm2[1],10); }
        if (i+1 < lines.length) { const mm3 = lines[i+1].match(/(\d{1,6})/); if (mm3 && mm3[1]) return parseInt(mm3[1],10); }
      }
    }
  }
  return null;
}

// render with Playwright (if available), return page text or null
async function renderPageTextWithPlaywright(url, timeoutMs = 90000) {
  if (!playwrightChromium) return null;
  let browser = null;
  try {
    browser = await playwrightChromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ 'accept-language': 'de-DE,de;q=0.9' });
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    // small wait for JS-rendered text
    await page.waitForTimeout(600);
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    await page.close();
    await context.close();
    await browser.close();
    return text;
  } catch (e) {
    if (browser) {
      try { await browser.close(); } catch(_) {}
    }
    console.log('Playwright render error for', url, (e && e.message) ? e.message.split('\n')[0] : e);
    return null;
  }
}

/* Main handler */
app.get('/check-hofer', async (req, res) => {
  const secret = process.env.SCRAPER_SECRET;
  if (secret) {
    const header = req.get('x-scraper-secret');
    if (!header || header !== secret) return res.status(401).json({ error: 'unauthorized' });
  }

  const overall = { timestamp: new Date().toISOString(), results: {} };

  for (const c of COUNTRIES) {
    const countrySummary = { datePlpsFound: 0, plps: [], unknowns: [] };
    const listingUrl = new URL(c.listingPath || '/', c.base).toString();

    try {
      // 1) try fetch-based discovery
      const listingHtml = await tryFetchHtml(listingUrl, 25000);
      const pagesSet = new Set();

      if (listingHtml) {
        // anchors
        const anchors = extractAnchorsFromHtml(listingHtml);
        for (const a of anchors) normalizeAndCollect(a.href, c.base, pagesSet, [c.listingPath]);
        // explicit date-PLP pattern
        const rawPlps = extractDatePlpLinksFromHtml(listingHtml, c.base);
        for (const p of rawPlps) pagesSet.add(p);
      } else {
        // fallback: include listing page itself so we run at least one check
        pagesSet.add(listingUrl);
      }

      // ensure we have at least listing page
      pagesSet.add(listingUrl);

      const pagesArray = Array.from(pagesSet);

      // 2) for each discovered page try to get count
      for (const url of pagesArray) {
        try {
          // fetch-first
          let pageText = await tryFetchHtml(url, 20000);
          let foundCount = null;
          if (pageText) {
            foundCount = extractCountFromText(pageText, c.keywords);
          }

          // fallback to playwrigh if fetch couldn't extract
          if (foundCount === null) {
            const renderedText = await renderPageTextWithPlaywright(url, 90000);
            if (renderedText) {
              foundCount = extractCountFromText(renderedText, c.keywords);
              // also attempt to capture snippet
              const snippetMatch = (renderedText.match(new RegExp('.{0,80}' + escapeRegex((c.keywords[0]||'').slice(0,20)) + '.{0,80}', 'i')) || [''])[0];
              countrySummary.plps.push({ url, count: foundCount, snippet: snippetMatch || null });
            } else {
              // no render, push as unknown if fetch didn't show
              countrySummary.unknowns.push({ url, reason: 'no-render-and-no-count' });
            }
          } else {
            const snippetMatch = (pageText.match(new RegExp('.{0,80}' + escapeRegex((c.keywords[0]||'').slice(0,20)) + '.{0,80}', 'i')) || [''])[0];
            countrySummary.plps.push({ url, count: foundCount, snippet: snippetMatch || null });
          }
        } catch (e) {
          countrySummary.unknowns.push({ url, reason: String(e) });
        }
      }

      // filter only actual PLP pages (with counts or ones matching pattern)
      // count date-specific PLPs found (ones matching /d.XX-XX-XXXX.html)
      const datePlps = countrySummary.plps.filter(p => /\/d\.\d{2}-\d{2}-\d{4}\.html/i.test(p.url));
      countrySummary.datePlpsFound = datePlps.length;

      // sort plps: date PLPs first
      countrySummary.plps = [
        ...datePlps.sort((a,b) => (b.count||0)-(a.count||0)),
        ...countrySummary.plps.filter(p => !/\/d\.\d{2}-\d{2}-\d{4}\.html/i.test(p.url))
      ];

    } catch (outer) {
      countrySummary.error = String(outer);
    }

    overall.results[c.code] = countrySummary;
  } // end countries loop

  // Build minimal human-friendly output as requested
  const minimal = { timestamp: overall.timestamp, countries: {} };
  for (const [code, cs] of Object.entries(overall.results)) {
    const summary = { datePlpsFound: cs.datePlpsFound || 0, plps: [] };
    for (const p of cs.plps) {
      summary.plps.push({ url: p.url, count: p.count === null ? 'unknown' : p.count });
    }
    if (cs.unknowns && cs.unknowns.length) summary.unknowns = cs.unknowns;
    if (cs.error) summary.error = cs.error;
    minimal.countries[code] = summary;
  }

  return res.json(minimal);
});

app.listen(PORT, () => console.log(`Hofer multi-checker listening on port ${PORT}`));
