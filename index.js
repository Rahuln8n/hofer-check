// simple Express + Playwright scraper
const express = require('express');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3000;
const app = express();

// Basic health endpoint
app.get('/', (req, res) => res.send('Hofer checker alive'));

// /check-hofer runs the scraping and returns JSON
app.get('/check-hofer', async (req, res) => {
  const secret = process.env.SCRAPER_SECRET; // optional secret to protect endpoint
  if (secret) {
    const header = req.get('x-scraper-secret');
    if (!header || header !== secret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const base = 'https://hofer.at';
  const results = [];

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      viewport: { width: 1280, height: 900 }
    });

    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });

    try {
      const offers = await page.$(`text=/Angebote/i`);
      if (offers) {
        await offers.hover().catch(()=>{});
        await offers.click({timeout:5000}).catch(()=>{});
      } else {
        await page.goto(base + '/de/angebote', { waitUntil: 'domcontentloaded' });
      }
    } catch(e){}

    await page.waitForTimeout(1200);
    const anchors = await page.$$eval('a[href]', els => els.map(a => ({ href: a.getAttribute('href'), text: a.innerText || '' })));

    const hrefSet = new Set();
    for (const a of anchors) {
      if (!a.href) continue;
      const href = a.href;
      const isInternal = href.startsWith('/') || href.includes('hofer.at');
      const looksLikeAngebote = href.toLowerCase().includes('/angebote') || /\/d\.\d{2}-\d{2}-\d{4}\.html/i.test(href);
      if (isInternal && looksLikeAngebote) {
        const abs = href.startsWith('http') ? href : new URL(href, base).toString();
        hrefSet.add(abs.split('#')[0].split('?')[0]);
      }
    }

    if (hrefSet.size === 0) {
      await page.goto(base + '/de/angebote', { waitUntil: 'domcontentloaded' });
      const anchors2 = await page.$$eval('a[href]', els => els.map(a => ({ href: a.getAttribute('href'), text: a.innerText || '' })));
      for (const a of anchors2) {
        if (!a.href) continue;
        const href = a.href;
        const isInternal = href.startsWith('/') || href.includes('hofer.at');
        const looksLikeAngebote = href.toLowerCase().includes('/angebote') || /\/d\.\d{2}-\d{2}-\d{4}\.html/i.test(href);
        if (isInternal && looksLikeAngebote) {
          const abs = href.startsWith('http') ? href : new URL(href, base).toString();
          hrefSet.add(abs.split('#')[0].split('?')[0]);
        }
      }
    }

    const pagesToCheck = Array.from(hrefSet);
    if (!pagesToCheck.includes(`${base}/de/angebote`)) pagesToCheck.unshift(`${base}/de/angebote`);

    for (const url of pagesToCheck) {
      try {
        const p = await context.newPage();
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await p.waitForTimeout(1200);
        const bodyText = await p.evaluate(() => document.body.innerText || '');

        let count = null;
        const m = bodyText.match(/(\d{1,6})\s+Aktionsartikel\s+gefunden/i);
        if (m && m[1]) count = parseInt(m[1], 10);
        if (count === null) {
          const m2 = bodyText.match(/(\d{1,6})[^0-9\n\r]{0,20}Aktionsartikel/i);
          if (m2 && m2[1]) count = parseInt(m2[1], 10);
        }

        results.push({
          url,
          count,
          snippet: (bodyText.match(/.{0,80}Aktionsartikel.{0,80}/i) || [''])[0]
        });

        await p.close();
      } catch (err) {
        results.push({ url, error: String(err) });
      }
    }

    await browser.close();

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
    if (browser) await browser.close().catch(()=>{});
    return res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Hofer-checker listening on port ${PORT}`);
});
