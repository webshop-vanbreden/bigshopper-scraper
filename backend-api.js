#!/usr/bin/env node

/**
 * 🚀 BigShopper Production Scraper - SECURE VERSION
 * 
 * Features:
 * - JWT Authentication
 * - Password protected
 * - Rate limiting
 * - AWS bucket private with signed URLs
 * - Parallel scraping
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { chromium } = require('playwright');
const Queue = require('bull');
const cron = require('node-cron');

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD_HASH = '$2b$10$yDGt4rKOfPt5u8RVxXF2CO5Z.3fKHwKPJZ8dLbN9VnQjKqK6xaVhW'; // bcrypt hash of "adminnimda"

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'YOUR_SUPABASE_KEY';

// AWS
const AWS_REGION = process.env.AWS_REGION || 'eu-west-1';
const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY || '';
const AWS_SECRET_KEY = process.env.AWS_SECRET_KEY || '';
const S3_BUCKET = process.env.S3_BUCKET || 'bigshopper-scraper';

// Redis
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Scraper config
const PARALLEL_WORKERS = process.env.PARALLEL_WORKERS || 5;
const IMAGES_PER_PAGE = process.env.IMAGES_PER_PAGE || 10;
const SCRAPE_TIMEOUT = process.env.SCRAPE_TIMEOUT || 30000;

// ============================================================
// INITIALIZE
// ============================================================

const app = express();

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Rate limiting
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  message: 'Too many login attempts, try again later'
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: 'Too many requests, try again later'
});

// Apply rate limiting
app.use('/api/auth/login', loginLimiter);
app.use('/api/scrape', apiLimiter);

// Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// AWS S3
const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY,
    secretAccessKey: AWS_SECRET_KEY
  }
});

// Job Queue
const scrapeQueue = new Queue('scrape-jobs', REDIS_URL);

let browser = null;

// ============================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================

const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ============================================================
// INITIALIZE BROWSER
// ============================================================

async function initBrowser() {
  console.log('🚀 Initializing Playwright browser...');
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  console.log('✅ Browser ready');
}

// ============================================================
// SCRAPER FUNCTION
// ============================================================

async function scrapeEAN(ean, jobId = null) {
  const startTime = Date.now();
  const page = await browser.newPage();
  let scrapedImages = [];

  try {
    console.log(`🔍 [${ean}] Starting scrape...`);

    // Get or create EAN record
    let { data: eanRecord } = await supabase
      .from('eans')
      .select('id')
      .eq('barcode', ean)
      .single();

    if (!eanRecord) {
      const { data } = await supabase
        .from('eans')
        .insert([{ barcode: ean, scrape_status: 'scraping' }])
        .select();
      eanRecord = data[0];
    }

    const eanId = eanRecord.id;

    // Create scrape record
    const { data: scrapeRecord } = await supabase
      .from('scrapes')
      .insert([{
        ean_id: eanId,
        job_id: jobId,
        status: 'pending',
        started_at: new Date()
      }])
      .select();

    const scrapeId = scrapeRecord[0].id;

    // Level 1: Search page
    console.log(`  📌 [${ean}] Loading search page...`);
    const searchUrl = `https://bigshopper.nl/search/?q=${ean}`;
    
    try {
      await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: SCRAPE_TIMEOUT });
    } catch (e) {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: SCRAPE_TIMEOUT });
    }

    // Find product
    const productLink = await page.$('a[data-href*="/product"]');
    if (!productLink) {
      throw new Error('Product not found on BigShopper');
    }

    console.log(`  ✅ [${ean}] Product link found`);

    // Level 2: Click product
    console.log(`  📌 [${ean}] Clicking product...`);
    await productLink.click();
    await page.waitForTimeout(1500);

    // Get product name
    const productName = await page.$eval('h1', el => el.textContent.trim()).catch(() => 'Unknown');
    console.log(`  📦 [${ean}] Product: ${productName}`);

    // Level 2B: Expand shops comparison
    console.log(`  📌 [${ean}] Expanding shops...`);
    const expandBtn = await page.$('a[href*="#vergelijk"], [href*="vergelijk-aanbieders"]');

    if (expandBtn) {
      await expandBtn.click();
      await page.waitForTimeout(1500);
      console.log(`  ✅ [${ean}] Comparison expanded`);
    }

    // Level 3: Extract all data
    console.log(`  📌 [${ean}] Extracting data...`);

    const extractedData = await page.evaluate(() => {
      const buttons = document.querySelectorAll('a[href*="/go/"]');
      const shops = [];

      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        let row = btn.closest('tr, [data-shop-row], [data-shop], .shop-item, .price-option');

        const shop = {
          shopLink: btn.href,
          buttonText: btn.textContent.trim()
        };

        if (row) {
          shop.name = row.querySelector('[data-shop-name], .shop-name')?.textContent?.trim() || 'Unknown';
          shop.price = row.querySelector('[data-price], .price')?.textContent?.trim() || 'N/A';
          shop.originalPrice = row.querySelector('del, .original-price')?.textContent?.trim() || null;
          shop.availability = row.querySelector('[data-availability], .availability')?.textContent?.trim() || 'Unknown';
          shop.delivery = row.querySelector('[data-delivery], .delivery')?.textContent?.trim() || 'Unknown';
          shop.rating = row.querySelector('[data-rating], .rating')?.textContent?.trim() || 'N/A';
        }

        shops.push(shop);
      }

      // Extract product properties
      const properties = [];
      document.querySelectorAll('[data-spec], .spec, .property').forEach(el => {
        const name = el.querySelector('[data-name], .name')?.textContent?.trim();
        const value = el.querySelector('[data-value], .value')?.textContent?.trim();
        if (name && value) {
          properties.push({ name, value });
        }
      });

      // Extract all images
      const images = Array.from(document.querySelectorAll('img'))
        .filter(img => img.src && !img.src.includes('logo') && !img.src.includes('icon'))
        .map(img => ({
          src: img.src,
          alt: img.alt,
          title: img.title
        }))
        .slice(0, IMAGES_PER_PAGE);

      return { shops, properties, images };
    });

    console.log(`  ✅ [${ean}] Found ${extractedData.shops.length} shops, ${extractedData.images.length} images`);

    // Save shops to database
    for (const shop of extractedData.shops) {
      let { data: shopRecord } = await supabase
        .from('shops')
        .select('id')
        .eq('name', shop.name)
        .single();

      if (!shopRecord) {
        const { data } = await supabase
          .from('shops')
          .insert([{ name: shop.name }])
          .select();
        shopRecord = data[0];
      }

      const shopId = shopRecord.id;

      const priceMatch = shop.price.match(/[\d,]+/);
      const price = priceMatch ? parseFloat(priceMatch[0].replace(',', '.')) : null;

      await supabase.from('prices').insert([{
        scrape_id: scrapeId,
        ean_id: eanId,
        shop_id: shopId,
        price: price,
        availability: shop.availability,
        delivery_text: shop.delivery,
        shop_rating: parseFloat(shop.rating) || null,
        shop_url: shop.shopLink
      }]);
    }

    // Save properties
    for (const prop of extractedData.properties) {
      await supabase.from('properties').insert([{
        scrape_id: scrapeId,
        ean_id: eanId,
        property_name: prop.name,
        property_value: prop.value,
        category: 'specs'
      }]);
    }

    // Download images to S3 (PRIVATE)
    console.log(`  📌 [${ean}] Downloading ${extractedData.images.length} images...`);
    
    for (const img of extractedData.images) {
      try {
        const response = await page.request.get(img.src);
        const buffer = await response.body();

        const fileName = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}.jpg`;
        const s3Key = `images/${new Date().toISOString().split('T')[0]}/${ean}/${fileName}`;

        // Upload to S3 (private)
        await s3.send(new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: s3Key,
          Body: buffer,
          ContentType: 'image/jpeg',
          ACL: 'private' // PRIVATE - not public!
        }));

        // Save image record with signed URL (will be generated on demand)
        await supabase.from('images').insert([{
          scrape_id: scrapeId,
          ean_id: eanId,
          original_url: img.src,
          aws_key: s3Key,
          alt_text: img.alt,
          download_status: 'downloaded',
          downloaded_at: new Date()
        }]);

        scrapedImages.push(s3Key);
      } catch (e) {
        console.log(`    ⚠️  Failed to download image: ${e.message}`);
      }
    }

    // Mark scrape as completed
    const duration = Date.now() - startTime;
    await supabase
      .from('scrapes')
      .update({
        status: 'success',
        completed_at: new Date(),
        duration_ms: duration,
        shops_found: extractedData.shops.length,
        images_downloaded: scrapedImages.length
      })
      .eq('id', scrapeId);

    // Update EAN
    await supabase
      .from('eans')
      .update({
        product_name: productName,
        scrape_status: 'completed',
        last_scraped: new Date(),
        total_images: scrapedImages.length
      })
      .eq('id', eanId);

    console.log(`  ✅ [${ean}] Completed in ${duration}ms`);

    return {
      ean,
      success: true,
      productName,
      shops: extractedData.shops.length,
      images: scrapedImages.length,
      duration
    };

  } catch (error) {
    console.error(`  ❌ [${ean}] Error: ${error.message}`);

    return {
      ean,
      success: false,
      error: error.message,
      duration: Date.now() - startTime
    };

  } finally {
    await page.close();
  }
}

// ============================================================
// JOB QUEUE WORKER
// ============================================================

scrapeQueue.process(PARALLEL_WORKERS, async (job) => {
  const { eans, jobId } = job.data;
  const results = [];

  for (const ean of eans) {
    const result = await scrapeEAN(ean, jobId);
    results.push(result);

    job.progress((results.length / eans.length) * 100);
  }

  return results;
});

// ============================================================
// API ROUTES - PUBLIC
// ============================================================

// Health check (public)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Login (public)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Check credentials
    const isValidUsername = username === ADMIN_USERNAME;
    const isValidPassword = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);

    if (!isValidUsername || !isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT token (expires in 24 hours)
    const token = jwt.sign(
      { username: ADMIN_USERNAME, iat: Date.now() },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      token,
      expiresIn: '24h'
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================================================
// API ROUTES - PROTECTED
// ============================================================

// Start scraping (protected)
app.post('/api/scrape/start', verifyToken, async (req, res) => {
  try {
    const { eans } = req.body;

    if (!eans || !Array.isArray(eans) || eans.length === 0) {
      return res.status(400).json({ error: 'Invalid EAN list' });
    }

    // Create job record
    const { data: jobRecord } = await supabase
      .from('scrape_jobs')
      .insert([{
        name: `Scrape ${eans.length} EANs`,
        ean_count: eans.length,
        status: 'queued',
        parallel_workers: PARALLEL_WORKERS
      }])
      .select();

    const jobId = jobRecord[0].id;

    // Add to queue
    const job = await scrapeQueue.add(
      { eans, jobId },
      { attempts: 3, backoff: 'exponential', removeOnComplete: false }
    );

    res.json({ jobId, queueId: job.id, eanCount: eans.length });

  } catch (error) {
    console.error('Error starting scrape:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get job status (protected)
app.get('/api/scrape/job/:jobId', verifyToken, async (req, res) => {
  try {
    const { jobId } = req.params;

    const { data: job } = await supabase
      .from('scrape_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const { data: logs } = await supabase
      .from('job_logs')
      .select('*')
      .eq('job_id', jobId);

    res.json({
      job,
      logs,
      progress: job.ean_count > 0 ? (job.processed_count / job.ean_count) * 100 : 0
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get EAN data with signed image URLs (protected)
app.get('/api/ean/:barcode', verifyToken, async (req, res) => {
  try {
    const { barcode } = req.params;

    const { data: ean } = await supabase
      .from('eans')
      .select('*')
      .eq('barcode', barcode)
      .single();

    if (!ean) {
      return res.status(404).json({ error: 'EAN not found' });
    }

    // Get latest prices
    const { data: prices } = await supabase
      .from('prices')
      .select('*, shops(name)')
      .eq('ean_id', ean.id)
      .order('scraped_at', { ascending: false })
      .limit(100);

    // Get images with SIGNED URLs (temporary access)
    const { data: images } = await supabase
      .from('images')
      .select('*')
      .eq('ean_id', ean.id)
      .order('created_at', { ascending: false })
      .limit(50);

    // Generate signed URLs for images (valid for 1 hour)
    const signedImages = await Promise.all(
      images.map(async (img) => {
        try {
          const signedUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({
              Bucket: S3_BUCKET,
              Key: img.aws_key
            }),
            { expiresIn: 3600 } // 1 hour
          );
          return { ...img, signed_url: signedUrl };
        } catch (e) {
          return { ...img, signed_url: null };
        }
      })
    );

    // Get properties
    const { data: properties } = await supabase
      .from('properties')
      .select('*')
      .eq('ean_id', ean.id);

    res.json({
      ean,
      prices,
      images: signedImages,
      properties
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Export data (protected)
app.post('/api/export', verifyToken, async (req, res) => {
  try {
    const { format = 'json', includeHistory = false, includeImages = false } = req.body;

    const { data: eans } = await supabase.from('eans').select('*');
    const { data: prices } = await supabase.from('prices').select('*');

    const exportData = {
      timestamp: new Date(),
      eanCount: eans.length,
      eans,
      prices: includeHistory ? prices : prices.filter((p, i, arr) => i === arr.findIndex(t => t.ean_id === p.ean_id && t.shop_id === p.shop_id))
    };

    res.json(exportData);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// SCHEDULING
// ============================================================

// Daily scrape at 2 AM
cron.schedule('0 2 * * *', async () => {
  console.log('⏰ Running scheduled daily scrape...');
  
  const { data: eans } = await supabase.from('eans').select('barcode');
  const barcodes = eans.map(e => e.barcode);

  await scrapeQueue.add(
    { eans: barcodes, scheduled: true },
    { attempts: 1, removeOnComplete: false }
  );
});

// ============================================================
// START SERVER
// ============================================================

async function start() {
  try {
    await initBrowser();

    app.listen(PORT, () => {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🚀 BigShopper Scraper API (SECURE) running on port ${PORT}`);
      console.log('='.repeat(60));
      console.log(`Environment: ${NODE_ENV}`);
      console.log(`Parallel workers: ${PARALLEL_WORKERS}`);
      console.log(`\nLogin: POST /api/auth/login`);
      console.log(`  Username: admin`);
      console.log(`  Password: adminnimda\n`);
    });

  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n👋 Shutting down gracefully...');
  if (browser) await browser.close();
  process.exit(0);
});

start();

module.exports = app;
