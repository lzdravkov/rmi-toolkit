#!/usr/bin/env node
import 'dotenv/config';
import * as readline from 'readline';
import { fetchCatalogs, fetchProductPool, mergeProductPools } from '../src/catalog.js';
import {
  checkCustomerTierFieldExists,
  fetchExistingAccounts,
  buildAccountData,
  createAccounts,
} from '../src/accounts.js';
import { generateOrders } from '../src/orders.js';

// ─── I/O helpers ─────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

function print(msg) {
  console.log(msg);
}

function parseYesNo(text) {
  return /^(yes|y|yep|yeah|sure|ok|okay)$/i.test(text.trim());
}

function parseNumber(text) {
  const match = text.trim().match(/^\d+$/);
  return match ? parseInt(text.trim(), 10) : null;
}

// ─── Phase 1 — Accounts ──────────────────────────────────────────────────────

async function phaseAccounts() {
  print('\n─── Phase 1: Accounts ───────────────────────────────────────────────');

  print('Querying existing accounts...');
  const existingAccounts = fetchExistingAccounts();
  print(`Found ${existingAccounts.length} existing account(s) in the org.`);

  const answer = await ask('\nCreate new accounts? (yes/no): ');
  const createNew = parseYesNo(answer);

  if (!createNew) {
    print(`Using ${existingAccounts.length} existing accounts.`);
    return existingAccounts.map(a => ({ id: a.Id, name: a.Name }));
  }

  let count = null;
  while (!count) {
    const n = await ask('How many new accounts? ');
    count = parseNumber(n);
    if (!count) print('Please enter a whole number.');
  }

  print('\nChecking for Customer_Tier__c field...');
  const hasTierField = await checkCustomerTierFieldExists();
  print(hasTierField ? '  ✓ Customer_Tier__c found — tiers will be assigned.' : '  — Customer_Tier__c not found — skipping tier assignment.');

  print(`\nGenerating ${count} account(s)...`);
  const accountData = buildAccountData(count, hasTierField);
  const created = createAccounts(accountData, hasTierField);
  print(`✓ ${created.length} account(s) created.`);
  return created;
}

// ─── Phase 2 — Catalog ───────────────────────────────────────────────────────

async function phaseCatalog() {
  print('\n─── Phase 2: Product Catalog ────────────────────────────────────────');

  print('Querying available product catalogs...');
  const catalogs = fetchCatalogs();

  if (!catalogs.length) {
    print('No product catalogs found in the org. Cannot proceed.');
    process.exit(1);
  }

  print('\nAvailable catalogs:');
  catalogs.forEach((c, i) => print(`  ${i + 1}. ${c.Name}`));

  let selectedIndexes = [];
  while (!selectedIndexes.length) {
    const input = await ask('\nSelect catalog(s) by number (e.g. 1, or 1,2 for both): ');
    const parts = input.split(',').map(s => parseInt(s.trim(), 10) - 1);
    selectedIndexes = parts.filter(n => !isNaN(n) && n >= 0 && n < catalogs.length);
    if (!selectedIndexes.length) print('Invalid selection. Please enter valid catalog number(s).');
  }

  const pools = [];
  for (const idx of selectedIndexes) {
    const catalog = catalogs[idx];
    print(`\nLoading products from "${catalog.Name}"...`);
    const pool = fetchProductPool(catalog.Id);
    print(`  → ${pool.length} product(s) loaded`);
    pools.push(pool);
  }

  const productPool = mergeProductPools(pools);
  print(`\n✓ Total product pool: ${productPool.length} product(s)`);
  return productPool;
}

// ─── Phase 3 — Orders ────────────────────────────────────────────────────────

async function phaseOrders(accounts, productPool) {
  print('\n─── Phase 3: Order Generation ───────────────────────────────────────');
  print(`Accounts: ${accounts.length} | Products available: ${productPool.length}`);
  print('Each order: 3–10 random products, 0–40% discount per line, date spread Jan 2025–today.');

  let ordersPerAccount = null;
  while (!ordersPerAccount) {
    const input = await ask('\nHow many orders per account? ');
    ordersPerAccount = parseNumber(input);
    if (!ordersPerAccount) print('Please enter a whole number.');
  }

  const total = accounts.length * ordersPerAccount;
  const confirm = await ask(`\nThis will create ${total} order(s) total. Proceed? (yes/no): `);
  if (!parseYesNo(confirm)) {
    print('Order generation cancelled.');
    return;
  }

  print('\nGenerating orders...\n');
  const { created, failed } = await generateOrders(
    accounts,
    productPool,
    ordersPerAccount,
    msg => print(msg)
  );

  print('\n─── Summary ─────────────────────────────────────────────────────────');
  print(`✓ Orders created and activated: ${created.length}`);
  if (failed.length) {
    print(`✗ Failures: ${failed.length}`);
    for (const f of failed) print(`  ${f.accountName} — ${f.error}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  print('╔══════════════════════════════════════════════════════════════════╗');
  print('║  Revenue Management Intelligence — Bulk Data Generation Toolkit  ║');
  print('╚══════════════════════════════════════════════════════════════════╝');
  print(`Target org: ${process.env.SF_TARGET_ORG || 'iewc-mfg-rca'}\n`);

  const accounts = await phaseAccounts();
  if (!accounts.length) { print('No accounts to target. Exiting.'); rl.close(); return; }

  const productPool = await phaseCatalog();
  if (!productPool.length) { print('No products in pool. Exiting.'); rl.close(); return; }

  await phaseOrders(accounts, productPool);
  rl.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  rl.close();
  process.exit(1);
});
