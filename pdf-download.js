const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

async function downloadPdf(url, outputPath) {
  const CHROMIUM_PATH = '/usr/bin/chromium'; // Adjust if needed
  const TEMP_USER_DATA_DIR = path.join('/tmp', `puppeteer_pdf_${Date.now()}`);

  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    userDataDir: TEMP_USER_DATA_DIR,
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    console.error(`Navigating to ${url}...`);
    
    // Set a common user agent
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    if (!response) {
      throw new Error('No response received from page.goto');
    }

    // Wait a bit for potential redirects or POW solving
    await new Promise(r => setTimeout(r, 2000));

    const pdfBase64 = await page.evaluate(async (pdfUrl) => {
      const resp = await fetch(pdfUrl);
      if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
      const blob = await resp.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }, url);

    const buffer = Buffer.from(pdfBase64, 'base64');
    fs.writeFileSync(outputPath, buffer);
  } finally {
    await browser.close();
    try {
      if (fs.existsSync(TEMP_USER_DATA_DIR)) {
        fs.rmSync(TEMP_USER_DATA_DIR, { recursive: true, force: true });
      }
    } catch (e) {}
  }
}

const [,, url, outputPath] = process.argv;
if (!url || !outputPath) {
  console.error('Usage: node pdf-download.js <url> <outputPath>');
  process.exit(1);
}

downloadPdf(url, outputPath).catch(err => {
  console.error(err);
  process.exit(1);
});
