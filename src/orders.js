import { runApex, extractDebugLines } from './org.js';
import { pickRandom } from './catalog.js';

const STANDARD_PRICEBOOK_ID = '01sHu0000094NbPIAU';

const WARN_THRESHOLD = 200;

/**
 * Generate a random date string (YYYY-MM-DD) between Jan 1 2025 and today.
 */
function randomOrderDate() {
  const start = new Date('2025-01-01').getTime();
  const end = Date.now();
  const ts = start + Math.random() * (end - start);
  return new Date(ts).toISOString().slice(0, 10);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Build Apex code that calls PlaceSalesTransaction for a single order.
 *
 * lineItems: [ { productId, pricebookEntryId, unitPrice } ]
 * discounts: [ 0–40 (percent) ] — one per line item
 */
function buildPSTApex(accountId, effectiveDate, lineItems, discounts) {
  const lines = [];
  lines.push(`
RevSalesTrxn.PricingPreferenceEnum pricingPref = RevSalesTrxn.PricingPreferenceEnum.SYSTEM;
RevSalesTrxn.ConfigurationExecutionEnum configExec = RevSalesTrxn.ConfigurationExecutionEnum.SYSTEM;

RevSalesTrxn.RecordResource orderRecord = new RevSalesTrxn.RecordResource(Order.getSobjectType(), 'POST');
Map<String,Object> orderFields = new Map<String,Object>();
orderFields.put('AccountId', '${accountId}');
orderFields.put('Pricebook2Id', '${STANDARD_PRICEBOOK_ID}');
orderFields.put('EffectiveDate', '${effectiveDate}');
orderFields.put('Status', 'Draft');
orderRecord.fieldValues = orderFields;

List<RevSalesTrxn.RecordWithReferenceRequest> records = new List<RevSalesTrxn.RecordWithReferenceRequest>();
records.add(new RevSalesTrxn.RecordWithReferenceRequest('refOrder', orderRecord));
`);

  lineItems.forEach((item, idx) => {
    const ref = `refItem${idx + 1}`;
    const discountPct = discounts[idx] ?? 0;
    lines.push(`
RevSalesTrxn.RecordResource item${idx + 1} = new RevSalesTrxn.RecordResource(OrderItem.getSobjectType(), 'POST');
Map<String,Object> itemFields${idx + 1} = new Map<String,Object>();
itemFields${idx + 1}.put('Product2Id', '${item.productId}');
itemFields${idx + 1}.put('PricebookEntryId', '${item.pricebookEntryId}');
itemFields${idx + 1}.put('Quantity', ${randInt(100, 5000)}.0);
itemFields${idx + 1}.put('UnitPrice', ${item.unitPrice});
itemFields${idx + 1}.put('ListPrice', ${item.unitPrice});
itemFields${idx + 1}.put('Discount', ${discountPct});
itemFields${idx + 1}.put('OrderId', '@{refOrder.id}');
item${idx + 1}.fieldValues = itemFields${idx + 1};
records.add(new RevSalesTrxn.RecordWithReferenceRequest('${ref}', item${idx + 1}));
`);
  });

  lines.push(`
RevSalesTrxn.GraphRequest graph = new RevSalesTrxn.GraphRequest('rmi_order_${Date.now()}', records);

RevSalesTrxn.PlaceSalesTransactionResponse resp =
  RevSalesTrxn.PlaceSalesTransactionExecutor.execute(
    graph, pricingPref, configExec,
    new RevSalesTrxn.ConfigurationOptionsInput(),
    null
  );

if (resp != null && resp.isSuccess) {
  System.debug('PST_SUCCESS|' + resp.salesTransactionId);
} else {
  String errMsg = (resp != null && resp.errorResponse != null) ? String.valueOf(resp.errorResponse) : 'null response';
  System.debug('PST_FAILURE|' + errMsg);
}
`);

  return lines.join('\n');
}

/**
 * Build Apex to activate a single order by ID.
 */
function buildActivationApex(orderId) {
  return `
try {
  Order o = [SELECT Id, Status FROM Order WHERE Id = '${orderId}' LIMIT 1];
  o.Status = 'Activated';
  update o;
  System.debug('ACTIVATED|${orderId}');
} catch (Exception e) {
  System.debug('ACTIVATE_FAILED|${orderId}|' + e.getMessage());
}
`;
}

/**
 * Main order generation loop.
 *
 * accounts: [ { id, name } ]
 * productPool: [ { productId, pricebookEntryId, unitPrice } ]
 * ordersPerAccount: number
 * onProgress: (msg) => void  — called with status updates
 *
 * Returns { created: [ orderId ], failed: [ { accountId, error } ] }
 */
export async function generateOrders(accounts, productPool, ordersPerAccount, onProgress) {
  const totalOrders = accounts.length * ordersPerAccount;

  if (totalOrders > WARN_THRESHOLD) {
    onProgress(`⚠️  Warning: ${totalOrders} total orders (${accounts.length} accounts × ${ordersPerAccount} orders). This will take a while. Proceeding...`);
  }

  const created = [];
  const failed = [];
  let orderNum = 0;

  for (const account of accounts) {
    for (let i = 0; i < ordersPerAccount; i++) {
      orderNum++;
      const lineCount = randInt(3, 10);
      const lineItems = pickRandom(productPool, lineCount);
      const discounts = lineItems.map(() => randInt(0, 40));
      const effectiveDate = randomOrderDate();

      onProgress(`[${orderNum}/${totalOrders}] Creating order for "${account.name}" — ${lineItems.length} line items, date ${effectiveDate}`);

      try {
        const apex = buildPSTApex(account.id, effectiveDate, lineItems, discounts);
        const output = runApex(apex);
        const debugLines = extractDebugLines(output);

        let orderId = null;
        let pstFailed = false;
        let pstError = '';

        for (const line of debugLines) {
          if (line.startsWith('PST_SUCCESS|')) {
            orderId = line.split('|')[1];
          } else if (line.startsWith('PST_FAILURE|')) {
            pstFailed = true;
            pstError = line.split('|').slice(1).join('|');
          }
        }

        if (pstFailed || !orderId) {
          failed.push({ accountName: account.name, error: pstError || 'PST returned no order ID' });
          onProgress(`  ✗ PST failed: ${pstError}`);
          continue;
        }

        // Activate the order
        const activateApex = buildActivationApex(orderId);
        const activateOutput = runApex(activateApex);
        const activateLines = extractDebugLines(activateOutput);

        let activateFailed = false;
        for (const line of activateLines) {
          if (line.startsWith('ACTIVATE_FAILED|')) {
            activateFailed = true;
            const errMsg = line.split('|').slice(2).join('|');
            onProgress(`  ✗ Activation failed for ${orderId}: ${errMsg}`);
            failed.push({ accountName: account.name, error: `Activation: ${errMsg}` });
          }
        }

        if (!activateFailed) {
          created.push(orderId);
          onProgress(`  ✓ Order ${orderId} created and activated`);
        }
      } catch (err) {
        failed.push({ accountName: account.name, error: err.message });
        onProgress(`  ✗ Exception: ${err.message}`);
      }
    }
  }

  return { created, failed };
}
