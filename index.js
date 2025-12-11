/**
 * Hofer-checker service
 * - Express server
 * - / -> health
 * - /check-hofer -> scraper (fetch-first then Playwright fallback)
 */
const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// basic health endpoint
app.get('/', (req, res) => {
  res.send('Hofer checker alive');
});

/**
 * /check-hofer handler
 * - uses a fetch-first strategy to be faster and avoid Playwright when possible
 * - falls back to Playwright with retries and longer timeouts if needed
 */
app.get('/check-hofer', async (req, res) => {
  try {
    const secret = process.env.SCRAPER_SECRET;
    if (secret) {
      const header = req.get('x-scraper-secret');
      if (!header || header !== secret) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    const base = 'https://hofer.at';
    const results = [];

    // fetch helper (Node 18+ has global fetch)
    async function tryFetch(url) {
      try {
        if (global.fetch) {
          const r = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
              'Accept-Language': 'de-DE,de;q=0.9'
            },
            // no explicit timeout here
          });
          if (!r || !r.ok) return null;
          return await r.text();
        } else {
          // If no global fetch (rare in Playwright image), return null so we fallback to Playwright
          return null;
        }
      } catch (e) {
        console.log('fetch error:', String(e).slice(0,200));
        return null;
      }
    }

    function extractAnchorsFromHtml(html) {
      const hrefs = [];
      try {
        const re = /<a\s+[^>]*href=(["'])(.*?)\1[^>]*>(.*?)<\/a>/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
          hrefs.push({ href: m[2], text: (m[3] || '').replace(/<[^>]*>/g, '').trim() });
        }
      } catch (e) {}
      return hrefs;
    }

    // 1) Try fetch homepage for link discovery
    let homepageHtml = await tryFetch(base);
    if (homepageHtml) console.log('fetch homepage ok length=', homepageHtml.length);
    else console.log('fetch homepage not available, will use Playwright discovery if needed');

    const pagesToCheck = new Set();

    function normalizeAndCollect(aHref) {
      if (!aHref) return;
      if (aHref.startsWith('javascript:')) return;
      const isInternal = aHref.startsWith('/') || aHref.includes('hofer.at');
      const looksLikeAngebote = aHref.toLowerCase().includes('/angebote') || /\/d\.\d{2}-\d{2}-\d{4}\.html/i.test(aHref);
      if (isInternal && looksLikeAngebote) {
        const abs = aHref.startsWith('http') ? aHref : new URL(aHref, base).toString();
        pagesToCheck.add(abs.split('#')[0].split('?')[0]);
      }
    }

    if (homepageHtml) {
      const anchors = extractAnchorsFromHtml(homepageHtml);
      for (const a of anchors) normalizeAndCollect(a.href);
    }

    // If no anchors, do Playwright discovery with retries
    let browser = null;
    if (pagesToCheck.size === 0) {
      console.log('no anchors from fetch -> running Playwright discovery');
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
          });
          const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
            viewport: { width: 1280, height: 900 }, locale: 'de-DE'
          });
          const page = await context.newPage();
          await page.setExtraHTTPHeaders({ 'accept-language': 'de-DE,de;q=0.9' });
          const navTimeout = 60000 * attempt; // 60s,120s,180s
          console.log('discovery goto', base, 'timeout', navTimeout);
          await page.goto(base, { waitUntil: 'domcontentloaded', timeout: navTimeout });
          await page.waitForTimeout(1200);
          const discoveryHtml = await page.content();
          await page.close();
          await context.close();
          await browser.close();
          browser = null;
          const anchors2 = extractAnchorsFromHtml(discoveryHtml || '');
          for (const a of anchors2) normalizeAndCollect(a.href);
          if (pagesToCheck.size > 0) break;
        } catch (err) {
          console.log('discovery attempt error', attempt, String(err).slice(0,200));
          if (browser) { try { await browser.close(); } catch(e){}; browser = null; }
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }

    // ensure main listing included
    pagesToCheck.add(`${base}/de/angebote`);
    const pagesArray = Array.from(pagesToCheck);
    console.log('pages to check:', pagesArray.length);

    // For each page: try fetch first, then Playwright fallback
    for (const url of pagesArray) {
      console.log('processing', url);
      try {
        let bodyText = await tryFetch(url);
        if (bodyText && /Aktionsartikel/i.test(bodyText)) {
          // parse number from fetched HTML
          let count = null;
          const m = bodyText.match(/(\d{1,6})\s+Aktionsartikel\s+gefunden/i);
          if (m && m[1]) count = parseInt(m[1], 10);
          if (count === null) {
            const m2 = bodyText.match(/(\d{1,6})[^0-9\n\r]{0,20}Aktionsartikel/i);
            if (m2 && m2[1]) count = parseInt(m2[1], 10);
          }
          results.push({ url, count, snippet: (bodyText.match(/.{0,80}Aktionsartikel.{0,80}/i) || [''])[0] });
          continue;
        }

        // Playwright fallback for this page (2 attempts)
        let pageResult = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            browser = await chromium.launch({
              headless: true,
              args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            const context = await browser.newContext({
              userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
              viewport: { width: 1280, height: 900 }, locale: 'de-DE'
            });
            context.setDefaultNavigationTimeout(120000);
            const p = await context.newPage();
            await p.setExtraHTTPHeaders({ 'accept-language': 'de-DE,de;q=0.9' });
            await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
            await p.waitForTimeout(900);
            const bt = await p.evaluate(() => document.body.innerText || '');
            let count = null;
            const m = bt.match(/(\d{1,6})\s+Aktionsartikel\s+gefunden/i);
            if (m && m[1]) count = parseInt(m[1], 10);
            if (count === null) {
              const m2 = bt.match(/(\d{1,6})[^0-9\n\r]{0,20}Aktionsartikel/i);
              if (m2 && m2[1]) count = parseInt(m2[1], 10);
            }
            pageResult = { url, count, snippet: (bt.match(/.{0,80}Aktionsartikel.{0,80}/i) || [''])[0] };
            await p.close();
            await context.close();
            await browser.close();
            browser = null;
            break;
          } catch (err) {
            console.log(`playwright page error ${url} attempt ${attempt}:`, String(err).slice(0,300));
            if (browser) { try { await browser.close(); } catch(e){}; browser = null; }
            await new Promise(r => setTimeout(r, 1000 * attempt));
          }
        }
        if (pageResult) results.push(pageResult);
        else results.push({ url, error: 'failed to fetch or render page' });
      } catch (outerErr) {
        console.log('outer error for', url, String(outerErr).slice(0,200));
        results.push({ url, error: String(outerErr) });
        if (browser) { try { await browser.close(); } catch(e){}; browser = null; }
      }
    } // end loop

    if (browser) { try { await browser.close(); } catch(e){}; browser = null; }

    const zeroPages = results.filter(r => r.count === 0);
    const unknownPages = results.filter(r => r.count === null && !r.error);

    return res.json({
      timestamp: new Date().toISOString(),
      totalChecked: results.length,
      zeroPages,
      unknownPages,
      all: results
    });
  } catch (err) {
    console.log('handler top-level error', String(err).slice(0,500));
    return res.status(500).json({ error: String(err) });
  }
});

// start server
app.listen(PORT, () => {
  console.log(`Hofer-checker listening on port ${PORT}`);
});
