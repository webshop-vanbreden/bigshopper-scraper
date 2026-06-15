-- ============================================================
-- BigShopper Production Scraper - Supabase Schema
-- ============================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================
-- TABLE: eans
-- Core EAN data and scraping status
-- ============================================================
CREATE TABLE IF NOT EXISTS eans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  barcode VARCHAR(20) UNIQUE NOT NULL,
  product_name TEXT,
  category VARCHAR(255),
  
  -- Scraping metadata
  first_scraped TIMESTAMP,
  last_scraped TIMESTAMP,
  scrape_status VARCHAR(20) DEFAULT 'pending', -- pending, scraping, completed, failed, partial
  retry_count INT DEFAULT 0,
  
  -- Stats
  total_scrapes INT DEFAULT 0,
  total_images INT DEFAULT 0,
  unique_shops INT DEFAULT 0,
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eans_barcode ON eans(barcode);
CREATE INDEX IF NOT EXISTS idx_eans_status ON eans(scrape_status);
CREATE INDEX IF NOT EXISTS idx_eans_last_scraped ON eans(last_scraped DESC);

-- ============================================================
-- TABLE: shops
-- Store information (GTN, Hippisch, etc)
-- ============================================================
CREATE TABLE IF NOT EXISTS shops (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL UNIQUE,
  domain VARCHAR(255),
  url TEXT,
  
  -- Stats
  total_appearances INT DEFAULT 0,
  first_seen TIMESTAMP DEFAULT NOW(),
  last_seen TIMESTAMP,
  active BOOLEAN DEFAULT TRUE,
  
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shops_name ON shops(name);
CREATE INDEX IF NOT EXISTS idx_shops_domain ON shops(domain);
CREATE INDEX IF NOT EXISTS idx_shops_active ON shops(active);

-- ============================================================
-- TABLE: scrapes
-- Complete history of every scrape (AUDIT TRAIL!)
-- ============================================================
CREATE TABLE IF NOT EXISTS scrapes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ean_id UUID NOT NULL REFERENCES eans(id) ON DELETE CASCADE,
  job_id UUID, -- references scrape_jobs if part of batch
  
  -- Basic info
  product_name TEXT,
  product_url TEXT,
  source_url TEXT,
  
  -- Status
  status VARCHAR(20) DEFAULT 'pending', -- success, partial, failed
  error_message TEXT,
  
  -- Timing
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  duration_ms INT,
  
  -- Counts
  shops_found INT DEFAULT 0,
  images_found INT DEFAULT 0,
  images_downloaded INT DEFAULT 0,
  
  -- Full metadata as JSON (flexible storage)
  metadata JSONB DEFAULT '{}', -- any extra data
  
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scrapes_ean ON scrapes(ean_id);
CREATE INDEX IF NOT EXISTS idx_scrapes_job ON scrapes(job_id);
CREATE INDEX IF NOT EXISTS idx_scrapes_status ON scrapes(status);
CREATE INDEX IF NOT EXISTS idx_scrapes_created ON scrapes(created_at DESC);

-- ============================================================
-- TABLE: prices
-- PRICE HISTORY - Every price change tracked!
-- ============================================================
CREATE TABLE IF NOT EXISTS prices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scrape_id UUID NOT NULL REFERENCES scrapes(id) ON DELETE CASCADE,
  ean_id UUID NOT NULL REFERENCES eans(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id),
  
  -- Pricing
  price DECIMAL(10, 2) NOT NULL,
  original_price DECIMAL(10, 2),
  discount_percent INT,
  discount_amount DECIMAL(10, 2),
  
  -- Availability
  availability VARCHAR(100), -- "In voorraad", "Niet beschikbaar", etc
  availability_quantity INT, -- stock count if available
  
  -- Delivery
  delivery_days INT,
  delivery_text VARCHAR(255), -- "1-2 werkdagen"
  shipping_cost DECIMAL(10, 2),
  free_shipping BOOLEAN,
  
  -- Ratings
  shop_rating DECIMAL(3, 1),
  product_rating DECIMAL(3, 1),
  review_count INT,
  
  -- Link to shop
  shop_url TEXT,
  shop_link TEXT, -- direct link from BigShopper
  
  -- Metadata
  metadata JSONB DEFAULT '{}',
  
  scraped_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prices_scrape ON prices(scrape_id);
CREATE INDEX IF NOT EXISTS idx_prices_ean ON prices(ean_id);
CREATE INDEX IF NOT EXISTS idx_prices_shop ON prices(shop_id);
CREATE INDEX IF NOT EXISTS idx_prices_scraped ON prices(scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_prices_ean_shop ON prices(ean_id, shop_id);

-- ============================================================
-- TABLE: properties
-- ALL PRODUCT DATA (Specifications, Description, etc)
-- ============================================================
CREATE TABLE IF NOT EXISTS properties (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scrape_id UUID NOT NULL REFERENCES scrapes(id) ON DELETE CASCADE,
  ean_id UUID NOT NULL REFERENCES eans(id) ON DELETE CASCADE,
  
  -- Property details
  property_name VARCHAR(255),
  property_value TEXT,
  category VARCHAR(100), -- specs, description, ingredients, warnings, etc
  
  -- Optional structure
  property_group VARCHAR(100), -- for organizing properties
  
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_properties_scrape ON properties(scrape_id);
CREATE INDEX IF NOT EXISTS idx_properties_ean ON properties(ean_id);
CREATE INDEX IF NOT EXISTS idx_properties_category ON properties(category);
CREATE INDEX IF NOT EXISTS idx_properties_name ON properties(property_name);

-- ============================================================
-- TABLE: images
-- ALL IMAGES from all shop pages
-- ============================================================
CREATE TABLE IF NOT EXISTS images (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scrape_id UUID NOT NULL REFERENCES scrapes(id) ON DELETE CASCADE,
  ean_id UUID NOT NULL REFERENCES eans(id) ON DELETE CASCADE,
  shop_id UUID REFERENCES shops(id),
  
  -- Image metadata
  original_url TEXT,
  aws_key TEXT NOT NULL UNIQUE, -- s3://bucket/key
  
  -- Image details
  filename VARCHAR(255),
  file_size INT,
  mime_type VARCHAR(50),
  width INT,
  height INT,
  
  -- Classification
  is_product_image BOOLEAN DEFAULT TRUE,
  image_type VARCHAR(50), -- product, packaging, reviews, etc
  
  -- Source info
  alt_text TEXT,
  page_title TEXT, -- which page this image was from
  
  -- Download status
  download_status VARCHAR(20) DEFAULT 'pending', -- pending, downloaded, failed
  download_error TEXT,
  
  created_at TIMESTAMP DEFAULT NOW(),
  downloaded_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_images_scrape ON images(scrape_id);
CREATE INDEX IF NOT EXISTS idx_images_ean ON images(ean_id);
CREATE INDEX IF NOT EXISTS idx_images_shop ON images(shop_id);
CREATE INDEX IF NOT EXISTS idx_images_type ON images(image_type);
CREATE INDEX IF NOT EXISTS idx_images_status ON images(download_status);
CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC);

-- ============================================================
-- TABLE: scrape_jobs
-- Batch scraping jobs for scheduling
-- ============================================================
CREATE TABLE IF NOT EXISTS scrape_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  name VARCHAR(255),
  description TEXT,
  
  -- Job scope
  ean_ids UUID[] DEFAULT '{}', -- list of EAN IDs (NULL = all)
  ean_count INT DEFAULT 0,
  
  -- Execution
  status VARCHAR(20) DEFAULT 'pending', -- pending, queued, running, paused, completed, failed
  
  -- Progress
  processed_count INT DEFAULT 0,
  success_count INT DEFAULT 0,
  failed_count INT DEFAULT 0,
  
  -- Timing
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  paused_at TIMESTAMP,
  completed_at TIMESTAMP,
  
  -- Config
  parallel_workers INT DEFAULT 5,
  retry_on_failure BOOLEAN DEFAULT TRUE,
  max_retries INT DEFAULT 3,
  
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON scrape_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON scrape_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_started ON scrape_jobs(started_at DESC);

-- ============================================================
-- TABLE: job_logs
-- Detailed logging of every job
-- ============================================================
CREATE TABLE IF NOT EXISTS job_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id UUID NOT NULL REFERENCES scrape_jobs(id) ON DELETE CASCADE,
  ean_id UUID REFERENCES eans(id),
  
  status VARCHAR(20), -- success, failed, partial, skipped
  message TEXT,
  error_details JSONB,
  
  duration_ms INT,
  images_count INT,
  shops_count INT,
  
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logs_job ON job_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_logs_ean ON job_logs(ean_id);
CREATE INDEX IF NOT EXISTS idx_logs_status ON job_logs(status);
CREATE INDEX IF NOT EXISTS idx_logs_created ON job_logs(created_at DESC);

-- ============================================================
-- TABLE: price_changes
-- Track ONLY when prices change (for alerts/reports)
-- ============================================================
CREATE TABLE IF NOT EXISTS price_changes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ean_id UUID NOT NULL REFERENCES eans(id),
  shop_id UUID NOT NULL REFERENCES shops(id),
  
  old_price DECIMAL(10, 2),
  new_price DECIMAL(10, 2),
  price_change DECIMAL(10, 2),
  percent_change DECIMAL(5, 2),
  
  old_availability VARCHAR(100),
  new_availability VARCHAR(100),
  
  detected_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_changes_ean ON price_changes(ean_id);
CREATE INDEX IF NOT EXISTS idx_changes_shop ON price_changes(shop_id);
CREATE INDEX IF NOT EXISTS idx_changes_detected ON price_changes(detected_at DESC);

-- ============================================================
-- TABLE: exports
-- Track all data exports for audit
-- ============================================================
CREATE TABLE IF NOT EXISTS exports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  name VARCHAR(255),
  format VARCHAR(20), -- json, csv, excel
  
  ean_count INT,
  include_history BOOLEAN DEFAULT FALSE,
  include_images BOOLEAN DEFAULT FALSE,
  
  file_size INT,
  aws_key TEXT,
  
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_exports_created ON exports(created_at DESC);

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Update scrape when price changes
CREATE OR REPLACE FUNCTION detect_price_changes()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if price or availability changed
  IF NEW.price != OLD.price OR NEW.availability != OLD.availability THEN
    INSERT INTO price_changes (ean_id, shop_id, old_price, new_price, old_availability, new_availability)
    VALUES (NEW.ean_id, NEW.shop_id, OLD.price, NEW.price, OLD.availability, NEW.availability);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- TRIGGERS
-- ============================================================

CREATE TRIGGER trigger_eans_updated_at
BEFORE UPDATE ON eans
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- VIEWS (for easier querying)
-- ============================================================

-- Latest price per EAN per shop
CREATE OR REPLACE VIEW latest_prices AS
SELECT DISTINCT ON (p.ean_id, p.shop_id)
  p.ean_id,
  p.shop_id,
  s.name as shop_name,
  p.price,
  p.original_price,
  p.availability,
  p.delivery_days,
  p.shop_rating,
  p.scraped_at,
  e.product_name
FROM prices p
JOIN shops s ON p.shop_id = s.id
JOIN eans e ON p.ean_id = e.id
ORDER BY p.ean_id, p.shop_id, p.scraped_at DESC;

-- Best price per EAN
CREATE OR REPLACE VIEW best_prices AS
SELECT
  lp.ean_id,
  e.product_name,
  e.barcode,
  lp.shop_id,
  lp.shop_name,
  lp.price,
  lp.original_price,
  lp.availability,
  lp.delivery_days,
  lp.scraped_at
FROM latest_prices lp
JOIN eans e ON lp.ean_id = e.id
WHERE (lp.ean_id, lp.price) IN (
  SELECT ean_id, MIN(price)
  FROM latest_prices
  WHERE price IS NOT NULL AND availability LIKE '%voorraad%'
  GROUP BY ean_id
);

-- Scrape statistics per EAN
CREATE OR REPLACE VIEW scrape_stats AS
SELECT
  e.id,
  e.barcode,
  e.product_name,
  COUNT(DISTINCT s.id) as total_scrapes,
  COUNT(DISTINCT CASE WHEN s.status = 'success' THEN s.id END) as successful_scrapes,
  COUNT(DISTINCT CASE WHEN s.status = 'failed' THEN s.id END) as failed_scrapes,
  COUNT(DISTINCT i.id) as total_images,
  COUNT(DISTINCT p.shop_id) as unique_shops,
  MAX(s.created_at) as last_scraped,
  MIN(s.created_at) as first_scraped,
  AVG(s.duration_ms) as avg_scrape_duration_ms
FROM eans e
LEFT JOIN scrapes s ON e.id = s.ean_id
LEFT JOIN images i ON s.id = i.scrape_id
LEFT JOIN prices p ON s.id = p.scrape_id
GROUP BY e.id, e.barcode, e.product_name;

-- ============================================================
-- INITIAL DATA
-- ============================================================

-- Add common Dutch shops
INSERT INTO shops (name, domain, url) VALUES
  ('GTN', 'gtn.nl', 'https://www.gtn.nl'),
  ('Boerenwebwinkel', 'boerenwebwinkel.nl', 'https://www.boerenwebwinkel.nl'),
  ('Kuipers Agrishop', 'kuipersagrishop.nl', 'https://www.kuipersagrishop.nl'),
  ('BTN de Haas', 'btndehaas.nl', 'https://www.btndehaas.nl'),
  ('Amazon.nl', 'amazon.nl', 'https://www.amazon.nl'),
  ('Bol.com', 'bol.com', 'https://www.bol.com')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- PERMISSIONS (for security)
-- ============================================================

-- For your backend API user
-- GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO api_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api_user;

COMMIT;
