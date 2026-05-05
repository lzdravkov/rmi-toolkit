#!/usr/bin/env node
// One-shot execution script — no interactive prompts.
// Parameters are set directly below.
import 'dotenv/config';
import { fetchCatalogs, fetchProductPool, mergeProductPools } from './src/catalog.js';
import { checkCustomerTierFieldExists, buildAccountData, createAccounts, fetchExistingAccounts } from './src/accounts.js';
import { generateOrders } from './src/orders.js';
import { query } from './src/org.js';

// ── Parameters ────────────────────────────────────────────────────────────────
const CREATE_NEW_ACCOUNTS  = false; // use existing accounts created today
const ACCOUNT_COUNT        = 5;
const CATALOG_NAMES        = ['Wire and Cable']; // match by name fragment
const ORDERS_MIN           = 5;
const ORDERS_MAX           = 15;
// ─────────────────────────────────────────────────────────────────────────────

function randOrderCount() {
  return Math.floor(Math.random() * (ORDERS_MAX - ORDERS_MIN + 1)) + ORDERS_MIN;
}

function print(msg) { console.log(msg); }

print('╔══════════════════════════════════════════════════════════════════╗');
print('║  Revenue Management Intelligence — Bulk Data Generation Toolkit  ║');
print('╚══════════════════════════════════════════════════════════════════╝');
print(`Target org: ${process.env.SF_TARGET_ORG || 'iewc-mfg-rca'}\n`);

// Phase 1 — Accounts
print('─── Phase 1: Accounts ───────────────────────────────────────────────');
let accounts = [];
if (CREATE_NEW_ACCOUNTS) {
  print(`Creating ${ACCOUNT_COUNT} new account(s)...`);
  const hasTierField = await checkCustomerTierFieldExists();
  print(hasTierField ? '  ✓ Customer_Tier__c found' : '  — Customer_Tier__c not found, skipping');
  const accountData = buildAccountData(ACCOUNT_COUNT, hasTierField);
  accounts = createAccounts(accountData, hasTierField);
  print(`✓ ${accounts.length} account(s) created: ${accounts.map(a => a.name).join(', ')}`);
} else {
  print('Fetching accounts created today...');
  const todayAccounts = query(`SELECT Id, Name FROM Account WHERE CreatedDate = TODAY ORDER BY Name`);
  accounts = todayAccounts.map(a => ({ id: a.Id, name: a.Name }));
  print(`✓ ${accounts.length} account(s) found: ${accounts.map(a => a.name).join(', ')}`);
}

// Phase 2 — Catalog
print('\n─── Phase 2: Product Catalog ────────────────────────────────────────');
print('Querying catalogs...');
const allCatalogs = fetchCatalogs();
print(`Found ${allCatalogs.length} catalog(s): ${allCatalogs.map(c => c.Name).join(', ')}`);

const selectedCatalogs = allCatalogs.filter(c =>
  CATALOG_NAMES.some(n => c.Name.toLowerCase().includes(n.toLowerCase()))
);

if (!selectedCatalogs.length) {
  print('ERROR: No matching catalogs found. Check CATALOG_NAMES parameter.');
  process.exit(1);
}

const pools = [];
for (const catalog of selectedCatalogs) {
  print(`Loading products from "${catalog.Name}"...`);
  const pool = fetchProductPool(catalog.Id);
  print(`  → ${pool.length} product(s) loaded`);
  pools.push(pool);
}
const productPool = mergeProductPools(pools);
print(`✓ Total product pool: ${productPool.length} product(s)`);

// Phase 3 — Orders
print('\n─── Phase 3: Order Generation ───────────────────────────────────────');
print('Each order: 3–10 random products, 0–40% discount per line, date spread Jan 2025–today.\n');

const allCreated = [];
const allFailed = [];

for (const account of accounts) {
  const orderCount = randOrderCount();
  print(`→ ${account.name}: ${orderCount} order(s)`);
  const { created, failed } = await generateOrders(
    [account],
    productPool,
    orderCount,
    msg => print(msg)
  );
  allCreated.push(...created);
  allFailed.push(...failed);
}

const created = allCreated;
const failed = allFailed;

print('\n─── Summary ─────────────────────────────────────────────────────────');
print(`✓ Orders created and activated: ${created.length}`);
if (failed.length) {
  print(`✗ Failures: ${failed.length}`);
  for (const f of failed) print(`  ${f.accountName} — ${f.error}`);
}
