import { query, runApex, extractDebugLines } from './org.js';

// Industry-appropriate fictional account names for IEWC's customer base
const ACCOUNT_NAME_POOL = [
  // Automotive OEMs & Tier 1 suppliers
  'Apex Automotive Systems', 'Meridian Vehicle Components', 'Ironclad Auto Parts',
  'Crestline Motor Solutions', 'Vanguard Drive Systems', 'Summit Chassis Works',
  'Redline Powertrain Inc', 'Precision Auto Assemblies', 'Strata Mobility Group',
  'Nexus Automotive Technologies',
  // Wire harness manufacturers
  'Delta Harness Solutions', 'Crossfield Wire Systems', 'Keystone Harness Co',
  'Sentinel Cable Assemblies', 'Trident Wiring Systems', 'Cascade Harness Technologies',
  'Pinnacle Wire Fabrications', 'Harbourview Harness Group', 'Fieldstone Wire Works',
  'Sovereign Cable Assemblies',
  // Aerospace & defense
  'Aerotech Wiring Solutions', 'Stratosphere Systems Inc', 'Orbital Wire Technologies',
  'Altimeter Avionics Supply', 'Zenith Aerospace Components', 'Flightpath Electrical Co',
  // Industrial / MRO distributors
  'Ironbridge Industrial Supply', 'Foundry Industrial Group', 'Millstone MRO Solutions',
  'Ridgeline Industrial Services', 'Copperhead Supply Corp', 'Stonewall Industrial Parts',
  'Lakefront Electrical Dist', 'Hillcrest Supply Chain Co', 'Broadview Industrial Inc',
  'Clearwater Parts & Supply',
  // Energy / utilities
  'GridWorks Energy Solutions', 'Voltage Distribution Inc', 'Mainline Power Supply Co',
  'Arclight Electrical Group', 'Highvolt Utility Services', 'Corelink Energy Systems',
  // OEM equipment manufacturers
  'HeavyGauge Equipment Co', 'Torque Systems Manufacturing', 'Benchmark Machine Works',
  'Ironside Equipment Corp', 'Fastline Automation Inc',
];

const RATINGS = ['Hot', 'Warm', 'Cold'];
const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum'];
const ACCOUNT_TYPES = ['Customer', 'Prospect', 'Reseller', 'Integrator'];

const INDUSTRIES = [
  'Automotive', 'Aerospace', 'Electronics', 'Energy', 'Manufacturing',
  'Transportation', 'Defense', 'Industrial',
];

const STATES_WITH_COUNTRY = [
  { state: 'MI', country: 'United States' },
  { state: 'OH', country: 'United States' },
  { state: 'IL', country: 'United States' },
  { state: 'TX', country: 'United States' },
  { state: 'CA', country: 'United States' },
  { state: 'IN', country: 'United States' },
  { state: 'WI', country: 'United States' },
  { state: 'MN', country: 'United States' },
  { state: 'PA', country: 'United States' },
  { state: 'NC', country: 'United States' },
  { state: 'Ontario', country: 'Canada' },
  { state: 'Quebec', country: 'Canada' },
  { state: 'Bavaria', country: 'Germany' },
  { state: 'Baden-Württemberg', country: 'Germany' },
];

function randFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Check whether Customer_Tier__c field exists on Account in the target org.
 */
export async function checkCustomerTierFieldExists() {
  const apex = `
Boolean exists = false;
for (Schema.SObjectField f : Schema.SObjectType.Account.fields.getMap().values()) {
  if (f.getDescribe().getName() == 'Customer_Tier__c') { exists = true; break; }
}
System.debug('TIER_FIELD_EXISTS|' + exists);
`;
  const output = runApex(apex);
  return output.includes('TIER_FIELD_EXISTS|true');
}

/**
 * Fetch existing accounts from the org. Returns [ { Id, Name } ]
 */
export function fetchExistingAccounts() {
  return query(`SELECT Id, Name, Rating FROM Account WHERE IsDeleted = false ORDER BY Name LIMIT 500`);
}

/**
 * Generate account data objects for N new accounts.
 * hasTierField: whether to include Customer_Tier__c
 */
export function buildAccountData(count, hasTierField) {
  const shuffledNames = [...ACCOUNT_NAME_POOL].sort(() => Math.random() - 0.5);
  const accounts = [];
  for (let i = 0; i < count; i++) {
    const baseName = shuffledNames[i % shuffledNames.length];
    const name = baseName + (i >= shuffledNames.length ? ` ${Math.floor(i / shuffledNames.length) + 1}` : '');
    const location = randFrom(STATES_WITH_COUNTRY);
    const acc = {
      name,
      type: randFrom(ACCOUNT_TYPES),
      rating: randFrom(RATINGS),
      industry: randFrom(INDUSTRIES),
      billingState: location.state,
      billingCountry: location.country,
      shippingState: location.state,
      shippingCountry: location.country,
      phone: `(${randInt(200, 999)}) ${randInt(200, 999)}-${randInt(1000, 9999)}`,
      annualRevenue: randInt(1, 500) * 1_000_000,
      numberOfEmployees: randInt(50, 5000),
    };
    if (hasTierField) {
      acc.customerTier = randFrom(TIERS);
    }
    accounts.push(acc);
  }
  return accounts;
}

/**
 * Insert accounts into the org via anonymous Apex.
 * Returns array of { name, id } for created accounts.
 */
export function createAccounts(accountData, hasTierField) {
  const lines = [];
  lines.push(`List<Account> accs = new List<Account>();`);

  for (const a of accountData) {
    const tier = hasTierField ? `a.Customer_Tier__c = '${a.customerTier}';` : '';
    lines.push(`{
  Account a = new Account();
  a.Name = '${a.name.replace(/'/g, "\\'")}';
  a.Type = '${a.type}';
  a.Rating = '${a.rating}';
  a.Industry = '${a.industry}';
  a.BillingState = '${a.billingState}';
  a.BillingCountry = '${a.billingCountry}';
  a.ShippingState = '${a.shippingState}';
  a.ShippingCountry = '${a.shippingCountry}';
  a.Phone = '${a.phone}';
  a.AnnualRevenue = ${a.annualRevenue};
  a.NumberOfEmployees = ${a.numberOfEmployees};
  ${tier}
  accs.add(a);
}`);
  }

  lines.push(`
// Dedup by name — skip if already exists
Set<String> names = new Set<String>();
for (Account a : accs) names.add(a.Name);
Set<String> existing = new Set<String>();
for (Account a : [SELECT Name FROM Account WHERE Name IN :names]) existing.add(a.Name);
List<Account> toInsert = new List<Account>();
for (Account a : accs) { if (!existing.contains(a.Name)) toInsert.add(a); }
insert toInsert;
for (Account a : toInsert) System.debug('CREATED_ACCOUNT|' + a.Name + '|' + a.Id);
System.debug('ACCOUNT_COUNT|' + toInsert.size());
`);

  const apex = lines.join('\n');
  const output = runApex(apex);
  const debugLines = extractDebugLines(output);

  const created = [];
  for (const line of debugLines) {
    if (line.startsWith('CREATED_ACCOUNT|')) {
      const parts = line.split('|');
      created.push({ name: parts[1], id: parts[2] });
    }
  }
  return created;
}
