export const SOURCE_METADATA_QUERY = `
WITH attempts AS (
  SELECT
    CASE WHEN vendor_name ILIKE '%S&S%' THEN 'ss' ELSE 'sanmar' END AS vendor,
    completed_at,
    started_at,
    status,
    COALESCE(error_count, 0) AS error_count,
    COALESCE(products_expected, 0) AS products_expected,
    COALESCE(products_upserted, 0) AS products_upserted
  FROM sync_tasks
  WHERE vendor_name ILIKE '%S&S%' OR vendor_name ILIKE '%Sanmar%'
),
latest_attempt AS (
  SELECT vendor, completed_at, started_at, status, error_count
  FROM (
    SELECT *, row_number() OVER (
      PARTITION BY vendor ORDER BY started_at DESC NULLS LAST
    ) AS rn
    FROM attempts
  ) ranked
  WHERE rn = 1
),
latest_full_success AS (
  SELECT vendor, completed_at, started_at
  FROM (
    SELECT *, row_number() OVER (
      PARTITION BY vendor ORDER BY completed_at DESC NULLS LAST
    ) AS rn
    FROM attempts
    WHERE status = 'completed'
      AND completed_at IS NOT NULL
      AND (
        (vendor = 'ss' AND products_expected > 0 AND products_upserted > 0)
        OR vendor = 'sanmar'
      )
  ) ranked
  WHERE rn = 1
)
SELECT
  latest_attempt.vendor,
  latest_attempt.started_at AS source_started_at,
  latest_full_success.completed_at AS source_sync_at,
  latest_attempt.status AS source_status,
  latest_attempt.error_count AS source_errors
FROM latest_attempt
LEFT JOIN latest_full_success USING (vendor)
ORDER BY latest_attempt.vendor`;

export const SS_STYLES_QUERY = `
WITH latest_success AS (
  SELECT completed_at
  FROM sync_tasks
  WHERE vendor_name ILIKE '%S&S%'
    AND status = 'completed'
    AND completed_at IS NOT NULL
    AND COALESCE(products_expected, 0) > 0
    AND COALESCE(products_upserted, 0) > 0
  ORDER BY completed_at DESC
  LIMIT 1
)
SELECT
  'ss:' || s."styleID" AS id,
  'ss' AS vendor,
  s."styleID"::text AS source_style_id,
  COALESCE(s."styleName", s."uniqueStyleName", s."styleID"::text) AS style_code,
  s."brandName" AS brand,
  COALESCE(s."title", s."styleName", s."uniqueStyleName") AS name,
  s."baseCategory" AS category,
  s."description" AS description,
  s."styleImage" AS image_url,
  COUNT(CASE WHEN p."piecePrice" > 0 THEN 1 END)::int AS active_variant_count,
  latest_success.completed_at AS source_sync_at
FROM ss_styles s
JOIN hs_products h
  ON h."styleID" = s."styleID"::text
 AND h.vendor = 'S&S Activewear'
 AND COALESCE(h.discontinued, false) = false
JOIN ss_products p ON p."styleID" = s."styleID"
LEFT JOIN latest_success ON true
GROUP BY s."styleID", s."brandName", s."title", s."styleName",
  s."uniqueStyleName", s."baseCategory", s."description", s."styleImage",
  latest_success.completed_at
HAVING COUNT(CASE WHEN p."piecePrice" > 0 THEN 1 END) > 0`;

export const SS_VARIANTS_QUERY = `
WITH latest_success AS (
  SELECT completed_at
  FROM sync_tasks
  WHERE vendor_name ILIKE '%S&S%'
    AND status = 'completed'
    AND completed_at IS NOT NULL
    AND COALESCE(products_expected, 0) > 0
    AND COALESCE(products_upserted, 0) > 0
  ORDER BY completed_at DESC
  LIMIT 1
)
SELECT
  'ss:' || p."sku" AS id,
  'ss:' || p."styleID" AS style_id,
  'ss' AS vendor,
  p."sku" AS source_variant_id,
  COALESCE(s."styleName", s."uniqueStyleName", p."styleName", p."styleID"::text) AS style_code,
  p."colorName" AS color,
  p."sizeName" AS size,
  NULLIF(regexp_replace(COALESCE(p."sizeOrder", ''), '[^0-9]', '', 'g'), '')::int AS size_order,
  p."qty"::int AS inventory_qty,
  COALESCE(p."colorFrontImage", s."styleImage") AS image_url,
  false AS discontinued,
  p."piecePrice" AS piece_price,
  p."dozenPrice" AS dozen_price,
  p."casePrice" AS case_price,
  p."salePrice" AS sale_price,
  p."customerPrice" AS customer_price,
  p."piecePrice" AS resolved_cost,
  'piecePrice' AS cost_basis,
  latest_success.completed_at AS source_sync_at
FROM ss_products p
JOIN ss_styles s ON s."styleID" = p."styleID"
JOIN hs_products h
  ON h."styleID" = p."styleID"::text
 AND h.vendor = 'S&S Activewear'
 AND COALESCE(h.discontinued, false) = false
LEFT JOIN latest_success ON true
WHERE p."piecePrice" > 0`;

export const SANMAR_STYLES_QUERY = `
WITH latest_success AS (
  SELECT completed_at
  FROM sync_tasks
  WHERE vendor_name ILIKE '%Sanmar%'
    AND status = 'completed'
    AND completed_at IS NOT NULL
  ORDER BY completed_at DESC
  LIMIT 1
)
SELECT
  'sanmar:' || s."style" AS id,
  'sanmar' AS vendor,
  s."style" AS source_style_id,
  s."style" AS style_code,
  max(s."brandName") AS brand,
  max(s."productTitle") AS name,
  max(s."category") AS category,
  max(s."productDescription") AS description,
  max(COALESCE(s."productImage", s."thumbnailImage")) AS image_url,
  COUNT(s."uniqueKey")::int AS active_variant_count,
  latest_success.completed_at AS source_sync_at
FROM sanmar_styles s
LEFT JOIN latest_success ON true
WHERE NULLIF(s."piecePrice", 0) IS NOT NULL
GROUP BY s."style", latest_success.completed_at`;

export const SANMAR_VARIANTS_QUERY = `
WITH latest_success AS (
  SELECT completed_at
  FROM sync_tasks
  WHERE vendor_name ILIKE '%Sanmar%'
    AND status = 'completed'
    AND completed_at IS NOT NULL
  ORDER BY completed_at DESC
  LIMIT 1
)
SELECT
  'sanmar:' || s."uniqueKey" AS id,
  'sanmar:' || s."style" AS style_id,
  'sanmar' AS vendor,
  s."uniqueKey" AS source_variant_id,
  s."style" AS style_code,
  COALESCE(s."color", s."catalogColor") AS color,
  s."size" AS size,
  s."sizeIndex" AS size_order,
  NULL::int AS inventory_qty,
  COALESCE(s."colorProductImage", s."productImage", s."thumbnailImage", p."primaryImageUrl") AS image_url,
  COALESCE(s."discontinued", false) AS discontinued,
  s."piecePrice" AS piece_price,
  s."dozenPrice" AS dozen_price,
  s."casePrice" AS case_price,
  NULL::numeric AS sale_price,
  NULL::numeric AS customer_price,
  s."piecePrice" AS resolved_cost,
  'piecePrice' AS cost_basis,
  latest_success.completed_at AS source_sync_at
FROM sanmar_styles s
LEFT JOIN sanmar_products p ON p."partId" = s."inventoryKey"
LEFT JOIN latest_success ON true
WHERE NULLIF(s."piecePrice", 0) IS NOT NULL`;

export const INVALID_PRICE_QUERIES = {
  ss: `SELECT COUNT(*)::int AS count FROM ss_products WHERE "piecePrice" IS NULL OR "piecePrice" <= 0`,
  sanmar: `SELECT COUNT(*)::int AS count FROM sanmar_styles WHERE NULLIF("piecePrice", 0) IS NULL`,
};
