# RMI Toolkit — Revenue Management Intelligence Bulk Data Generator

A CLI toolkit that generates realistic demo transaction data for a Salesforce Revenue Cloud org. It creates accounts, places priced orders via the `PlaceSalesTransaction` (PST) Apex API, and activates them — all through an interactive prompt-based flow.

---

## Prerequisites

- Node.js 18+
- `sf` CLI authenticated to your target org

Verify your org auth before running:
```bash
sf org display --target-org <your-org-alias>
```

---

## Setup

From the `rmi-toolkit/` directory:

```bash
# 1. Install dependencies
npm install

# 2. Set your target org alias
cp .env.example .env
#    Edit .env and set SF_TARGET_ORG to your org alias
```

---

## Running the Toolkit

```bash
node bin/generate.js
```

The CLI will guide you through three phases interactively:

### Phase 1 — Accounts
You will be asked whether to create new accounts or use existing ones.
- **New accounts:** specify how many. The toolkit generates industry-appropriate names (automotive OEMs, wire harness manufacturers, aerospace suppliers, etc.) with:
  - `Type` — randomly assigned (Customer / Prospect / Reseller / Integrator)
  - `Rating` — randomly assigned (Hot / Warm / Cold)
  - `BillingState/Country` and `ShippingState/Country` — randomly assigned from a pool of US states, Canada (Ontario, Quebec), and Germany (Bavaria, Baden-Württemberg)
  - `Customer_Tier__c` — randomly assigned (Bronze / Silver / Gold / Platinum) if the field exists in the org
- **Existing accounts:** all current accounts in the org will be used as targets.

### Phase 2 — Product Catalog
Available product catalogs will be queried from the org and presented. Select one or more by number.

### Phase 3 — Order Generation
Specify how many orders per account. The toolkit will then:
- Randomly select 3–10 products per order from the chosen catalog(s)
- Assign a random discount of 0–40% per line item via the `Discount` field on `OrderItem`
- Assign a random order date between January 1, 2025 and today
- Call `PlaceSalesTransaction` (PST) to price each order
- Activate each order upon successful PST response
- Log any failures without stopping the run

A summary of created vs. failed orders is printed at the end.

---

## Governor Limit Guidance

PST is called once per order — each call is its own Apex transaction. For large runs:

| Orders | Estimated time |
|--------|---------------|
| 1–50   | 2–10 min      |
| 50–200 | 10–40 min     |
| 200+   | Toolkit warns before proceeding |

If you hit CPU timeout errors on individual orders, the failure is logged and the run continues.

---

## Reference Apex Scripts

Standalone scripts for manual debugging are in `scripts/apex/data-gen/`:

| Script | Purpose |
|--------|---------|
| `01_create_accounts.apex` | Create a sample batch of accounts manually |
| `02_create_order_pst.apex` | Place a single PST order (fill in placeholder IDs) |
| `03_activate_order.apex` | Activate a single order by ID |

Run any of them with:
```bash
sf apex run --target-org <your-org-alias> --file scripts/apex/data-gen/02_create_order_pst.apex
```
