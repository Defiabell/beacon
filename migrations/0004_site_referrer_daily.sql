-- Daily pageloads per site, split by the referring host (Cloudflare Web
-- Analytics' refererHost dimension, see src/collect/rum.ts).
--
-- Separate from site_daily on purpose: that table is one row per (site, day)
-- and is what the dashboard totals; this one is one row per referrer and is
-- what src/surfaces.ts classifies ("did an AI answer engine send anyone to
-- this site this day?"). Only external referrers are stored — a pageload whose
-- referrer is the same host is in-site navigation, not an arrival.
--
-- `referrer` is the label src/surfaces.ts's referrerLabel produces: the
-- lower-cased referring host, plus a path prefix for the few hosts whose AI
-- product lives under a path of a general site (bing.com/copilotsearch).
CREATE TABLE site_referrer_daily (
  site TEXT NOT NULL,
  date TEXT NOT NULL,
  referrer TEXT NOT NULL,
  pageviews INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site, date, referrer)
);
