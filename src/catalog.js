import { query } from './org.js';

/**
 * Fetch all ProductCatalog records from the org.
 * Returns [ { Id, Name } ]
 */
export function fetchCatalogs() {
  return query(`SELECT Id, Name FROM ProductCatalog ORDER BY Name`);
}

/**
 * Given a catalog Id, return all active products with their pricebook entries.
 * Returns [ { productId, productName, pricebookEntryId, unitPrice, psmoId } ]
 */
export function fetchProductPool(catalogId) {
  // Join through ProductCategoryProduct → ProductCategory → ProductCatalog
  const records = query(`
    SELECT
      pcp.ProductId,
      pcp.Product.Name,
      pcp.Product.IsActive
    FROM ProductCategoryProduct pcp
    WHERE pcp.ProductCategory.CatalogId = '${catalogId}'
      AND pcp.Product.IsActive = true
  `.trim().replace(/\s+/g, ' '));

  if (!records.length) return [];

  // Deduplicate product IDs (each product appears in main + subcategory)
  const seen = new Set();
  for (const r of records) seen.add(r.ProductId);

  // Batch the ID list into a SOQL IN clause
  const idList = [...seen].map(id => `'${id}'`).join(',');

  // Fetch PricebookEntry for each product (Standard Pricebook)
  const STANDARD_PRICEBOOK_ID = '01sHu0000094NbPIAU';
  const pbeRecords = query(
    `SELECT Id, Product2Id, UnitPrice FROM PricebookEntry WHERE Product2Id IN (${idList}) AND Pricebook2Id = '${STANDARD_PRICEBOOK_ID}' AND IsActive = true`
  );

  // Fetch default ProductSellingModelOption for each product
  const psmoRecords = query(
    `SELECT Id, Product2Id FROM ProductSellingModelOption WHERE Product2Id IN (${idList}) AND IsDefault = true`
  );

  const pbeByProduct = {};
  for (const p of pbeRecords) pbeByProduct[p.Product2Id] = p;

  const psmoByProduct = {};
  for (const p of psmoRecords) psmoByProduct[p.Product2Id] = p;

  const pool = [];
  for (const r of records) {
    if (seen.has(r.ProductId)) {
      const pbe = pbeByProduct[r.ProductId];
      const psmo = psmoByProduct[r.ProductId];
      if (pbe && psmo) {
        pool.push({
          productId: r.ProductId,
          productName: r.Product?.Name ?? r.ProductId,
          pricebookEntryId: pbe.Id,
          unitPrice: pbe.UnitPrice,
          psmoId: psmo.Id,
        });
        seen.delete(r.ProductId); // prevent duplicate pool entries
      }
    }
  }

  return pool;
}

/**
 * Merge product pools from multiple catalogs, deduplicating by productId.
 */
export function mergeProductPools(pools) {
  const seen = new Set();
  const merged = [];
  for (const pool of pools) {
    for (const p of pool) {
      if (!seen.has(p.productId)) {
        seen.add(p.productId);
        merged.push(p);
      }
    }
  }
  return merged;
}

/**
 * Pick N random distinct items from an array.
 */
export function pickRandom(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}
