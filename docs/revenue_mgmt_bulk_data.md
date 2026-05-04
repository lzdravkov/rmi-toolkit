# Revenue Management Intelligence — Bulk Data Generation Toolkit

## Purpose

This toolkit generates realistic, analytics-ready transaction data for the `iewc-mfg-rca` Salesforce Revenue Cloud demo org. It uses a Claude AI agent to guide the operator through a multi-step consultation flow, then executes Apex scripts via `sf` CLI to create accounts, place priced orders via the `PlaceSalesTransaction` (PST) Apex API, and activate those orders.

The output is a populated org with rich historical order data (Jan 2025 → present) suitable for analytics dashboards, Agentforce demos, and Revenue Cloud reporting.

---

## Toolkit Structure

```
rmi-toolkit/
├── bin/
│   └── generate.js              # CLI entry point — starts the conversation loop
├── src/
│   ├── agent.js                 # Claude API multi-turn conversation manager
│   ├── org.js                   # sf CLI wrapper: SOQL queries + Apex execution
│   ├── accounts.js              # Account generation: names, tiers, ratings, variance
│   ├── catalog.js               # Product catalog discovery and pool building
│   └── orders.js                # Order generation, PST execution, activation
├── scripts/
│   └── apex/
│       └── data-gen/
│           ├── 01_create_accounts.apex     # Idempotent account creation
│           ├── 02_create_order_pst.apex    # Single order via PST (called per order)
│           └── 03_activate_order.apex      # Order activation post-PST
├── docs/
│   └── revenue_mgmt_bulk_data.md           # This document
├── package.json
├── .env.example                 # ANTHROPIC_API_KEY placeholder
└── README.md
```

---

## How It Works

The toolkit runs as an interactive CLI. Claude acts as the conversation layer, asking the operator questions before any data is written to the org.

### Step 1 — Account Consultation

Claude asks:
- Should we create new accounts, or target existing accounts in the org?
- If new: how many accounts should we create?

The account creation script (`01_create_accounts.apex`) will:
- Generate varied fictional account names appropriate for IEWC's customer base (automotive OEMs, wire harness manufacturers, industrial distributors, aerospace suppliers, etc.)
- Randomly assign `Type` (Customer / Prospect / Reseller / Integrator)
- Randomly assign `Rating` (Hot / Warm / Cold)
- Populate `BillingState`, `BillingCountry`, `ShippingState`, `ShippingCountry` — location pool spans US states (MI, OH, IL, TX, CA, IN, WI, MN, PA, NC) plus Canada (Ontario, Quebec) and Germany (Bavaria, Baden-Württemberg)
- Check at runtime whether `Customer_Tier__c` exists on the Account object; if it does, randomly assign Bronze / Silver / Gold / Platinum
- Use account name as a dedup key — safe to re-run

### Step 2 — Catalog Selection

Claude queries the org for available `ProductCatalog` records and presents the list. The operator picks one or both:
- **Wire and Cable Catalog** (`0ZSHu000000Vl7XOAS`) — 103 products
- **Wire Management Catalog** (`0ZSHu000000Vl7cOAC`) — 98 products

Once selected, the toolkit queries all active `Product2` records + their `PricebookEntry` prices from the chosen catalog(s) to build the in-memory product pool for order generation.

### Step 3 — Order Generation

Claude asks:
- How many orders per account?

For each account × order count, the toolkit:
1. Randomly selects 3–10 products from the catalog pool
2. Assigns a random order date between **January 1, 2025** and **today** (spread across the range for analytics realism)
3. Assigns a random discount per line item between 0–40% (applied as an adjustment on the order item)
4. Constructs and executes the PST Apex API to create and price the order
5. On PST success, runs the activation script to set the order to `Activated`
6. Logs failures without stopping the run — failed orders are reported in the summary

---

## PST Implementation Notes

The `PlaceSalesTransaction` (PST) Apex API (`RevSalesTrxn.PlaceSalesTransactionExecutor.execute`) creates and prices records in a single atomic call. This toolkit uses `Order` / `OrderItem` object types (not Quote), which are the correct target for Revenue Cloud order analytics.

**PST call signature used:**
```apex
RevSalesTrxn.PlaceSalesTransactionResponse resp =
    RevSalesTrxn.PlaceSalesTransactionExecutor.execute(
        graph,
        RevSalesTrxn.PricingPreferenceEnum.SYSTEM,
        RevSalesTrxn.ConfigurationExecutionEnum.SYSTEM,
        new RevSalesTrxn.ConfigurationOptionsInput(),
        null, null, null, null
    );
```

**Graph structure per order:**
- `Order` (POST): `AccountId`, `Pricebook2Id`, `EffectiveDate` (randomized), `Status = Draft`
- `OrderItem` × N (POST): `Product2Id`, `PricebookEntryId`, `Quantity`, `UnitPrice`, `OrderId = @{refOrder.id}`, `AdjustmentAmount` (discount)

**Post-PST activation:**
```apex
Order o = [SELECT Id, Status FROM Order WHERE Id = :orderId LIMIT 1];
o.Status = 'Activated';
update o;
```

---

## Governor Limit Considerations

PST is a synchronous Apex call — each order is one execution. Salesforce anonymous Apex limits apply:
- **Heap size:** 6 MB (synchronous) — not a concern for single-order calls
- **CPU time:** 10,000 ms (synchronous) — PST with 10 line items is typically 1,000–3,000 ms
- **DML statements:** 150 per transaction — each PST call is its own transaction (no stacking concern)
- **SOQL queries:** 100 per transaction — PST internally uses several; line items add more

**Recommendation:** The toolkit calls PST once per order (not batched). For large runs (e.g., 20 accounts × 15 orders = 300 PST calls), execution time will be significant (~10–30 minutes). The toolkit warns before proceeding if total order count exceeds 200 and proceeds unless the operator cancels.

---

## Key Record IDs (iewc-mfg-rca)

| Record | ID |
|---|---|
| Org alias | `iewc-mfg-rca` |
| Standard Price Book | `01sHu0000094NbPIAU` |
| Wire and Cable ProductCatalog | `0ZSHu000000Vl7XOAS` |
| Wire Management ProductCatalog | `0ZSHu000000Vl7cOAC` |
| One-Time ProductSellingModel | `0jPHu000000yBREMA2` |
| UOM (Foot) | `0hEHu000000hvziMAA` |

---

## Prerequisites

- Node.js 18+
- `sf` CLI authenticated to `iewc-mfg-rca`
- `ANTHROPIC_API_KEY` set in `.env`
- `@anthropic-ai/sdk` npm package

---

## Running the Toolkit

```bash
cd rmi-toolkit
npm install
cp .env.example .env         # add your ANTHROPIC_API_KEY
node bin/generate.js
```

The CLI will walk you through the consultation flow interactively.

---

## Open Design Decisions

| Decision | Status | Notes |
|---|---|---|
| PST object type | **Order/OrderItem** | Using Order (not Quote) for analytics-relevant records |
| Order date spread | **Jan 2025 → today** | Randomized per order for realistic dashboard data |
| Orders per account | Uniform or range | Determined at runtime by operator input |
| Account variance | Industry-appropriate names | Automotive OEMs, aerospace, industrial — matches IEWC customer base |
| Discount application | Per-line `AdjustmentAmount` | 0–40% random per line item |
| Existing account targeting | Supported | Operator can skip account creation and target existing accounts by query |
| Max order warning | 200 total orders | Warn + proceed; operator can cancel |
