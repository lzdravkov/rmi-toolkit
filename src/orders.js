import { runApex, extractDebugLines } from './org.js';
import { pickRandom } from './catalog.js';

const STANDARD_PRICEBOOK_ID = '01sHu0000094NbPIAU';
const WARN_THRESHOLD = 200;

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
 * Poll until the Quote's tax calculation is complete (not TaxCalculationInProcess).
 * PST triggers async tax calculation; conversion fails if it hasn't finished.
 */
async function waitForQuoteReady(quoteId, maxWaitMs = 30000) {
  const { query } = await import('./org.js');
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const records = query(`SELECT Id, CalculationStatus FROM Quote WHERE Id = '${quoteId}'`);
    const status = records[0]?.CalculationStatus ?? '';
    if (status !== 'TaxCalculationInProcess') return;
    await new Promise(r => setTimeout(r, 2000));
  }
}

/**
 * Step 1 — PST: Create and price a Quote with QuoteLineItems.
 * AccountId is not writable on Quote via PST — we link the account
 * via a stub Opportunity in Step 2.
 */
function buildPSTApex(quoteDate, lineItems, discounts) {
  const quoteName = `RMI-${quoteDate}-${randInt(1000, 9999)}`;
  const lines = [];
  lines.push(`
RevSalesTrxn.PricingPreferenceEnum pricingPref = RevSalesTrxn.PricingPreferenceEnum.SYSTEM;
RevSalesTrxn.ConfigurationExecutionEnum configExec = RevSalesTrxn.ConfigurationExecutionEnum.SYSTEM;

RevSalesTrxn.RecordResource quoteRecord = new RevSalesTrxn.RecordResource(Quote.getSobjectType(), 'POST');
Map<String,Object> quoteFields = new Map<String,Object>();
quoteFields.put('Name', '${quoteName}');
quoteFields.put('Pricebook2Id', '${STANDARD_PRICEBOOK_ID}');
quoteFields.put('ExpirationDate', '${quoteDate}');
quoteRecord.fieldValues = quoteFields;

List<RevSalesTrxn.RecordWithReferenceRequest> records = new List<RevSalesTrxn.RecordWithReferenceRequest>();
records.add(new RevSalesTrxn.RecordWithReferenceRequest('refQuote', quoteRecord));
`);

  lineItems.forEach((item, idx) => {
    const discountPct = discounts[idx] ?? 0;
    lines.push(`
RevSalesTrxn.RecordResource item${idx + 1} = new RevSalesTrxn.RecordResource(QuoteLineItem.getSobjectType(), 'POST');
Map<String,Object> itemFields${idx + 1} = new Map<String,Object>();
itemFields${idx + 1}.put('Product2Id', '${item.productId}');
itemFields${idx + 1}.put('PricebookEntryId', '${item.pricebookEntryId}');
itemFields${idx + 1}.put('Quantity', ${randInt(100, 5000)}.0);
itemFields${idx + 1}.put('UnitPrice', ${item.unitPrice});
itemFields${idx + 1}.put('Discount', ${discountPct});
itemFields${idx + 1}.put('QuoteId', '@{refQuote.id}');
item${idx + 1}.fieldValues = itemFields${idx + 1};
records.add(new RevSalesTrxn.RecordWithReferenceRequest('refItem${idx + 1}', item${idx + 1}));
`);
  });

  lines.push(`
RevSalesTrxn.GraphRequest graph = new RevSalesTrxn.GraphRequest('rmi_quote_${Date.now()}', records);

try {
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
} catch (Exception e) {
  System.debug('PST_FAILURE|' + e.getTypeName() + ': ' + e.getMessage());
}
`);

  return lines.join('\n');
}

/**
 * Step 2 — Link account to Quote via a stub Opportunity.
 * Also ensures a Bill-To Contact exists on the Account (required for Order activation).
 * Quote.AccountId is not directly writable; setting OpportunityId
 * on the Quote propagates the AccountId automatically.
 * Returns the Contact Id for use in Step 4.
 */
function buildLinkAccountApex(quoteId, accountId, quoteDate) {
  return `
try {
  // Ensure a Contact exists for this Account (required for Order activation)
  List<Contact> contacts = [SELECT Id FROM Contact WHERE AccountId = '${accountId}' LIMIT 1];
  Contact billToContact;
  if (contacts.isEmpty()) {
    billToContact = new Contact(
      FirstName = 'RMI',
      LastName = 'Contact',
      AccountId = '${accountId}'
    );
    insert billToContact;
  } else {
    billToContact = contacts[0];
  }

  Opportunity opp = new Opportunity(
    Name = 'RMI-${quoteDate}-${randInt(1000, 9999)}',
    AccountId = '${accountId}',
    StageName = 'Prospecting',
    CloseDate = Date.valueOf('${quoteDate}')
  );
  insert opp;
  Quote q = new Quote(Id = '${quoteId}', OpportunityId = opp.Id);
  update q;
  System.debug('LINK_SUCCESS|${quoteId}|' + opp.Id + '|' + billToContact.Id);
} catch (Exception e) {
  System.debug('LINK_FAILED|${quoteId}|' + e.getMessage());
}
`;
}

/**
 * Step 3 — Convert Quote to Order via the createOrderFromQuote
 * standard invocable action (REST call within Apex).
 */
function buildConvertApex(quoteId) {
  return `
try {
  String endpoint = URL.getOrgDomainUrl().toExternalForm()
    + '/services/data/v66.0/actions/standard/createOrderFromQuote';
  HttpRequest req = new HttpRequest();
  req.setEndpoint(endpoint);
  req.setMethod('POST');
  req.setHeader('Content-Type', 'application/json');
  req.setHeader('Authorization', 'Bearer ' + UserInfo.getSessionId());
  req.setBody('{"inputs":[{"quoteRecordId":"${quoteId}"}]}');
  HttpResponse res = new Http().send(req);
  if (res.getStatusCode() == 200) {
    List<Object> results = (List<Object>) JSON.deserializeUntyped(res.getBody());
    Map<String,Object> result = (Map<String,Object>) results[0];
    Boolean success = (Boolean) result.get('isSuccess');
    if (success) {
      Map<String,Object> outputs = (Map<String,Object>) result.get('outputValues');
      System.debug('CONVERT_SUCCESS|' + (String) outputs.get('orderId'));
    } else {
      System.debug('CONVERT_FAILED|${quoteId}|' + String.valueOf(result.get('errors')));
    }
  } else {
    System.debug('CONVERT_FAILED|${quoteId}|HTTP ' + res.getStatusCode() + ': ' + res.getBody());
  }
} catch (Exception e) {
  System.debug('CONVERT_FAILED|${quoteId}|' + e.getMessage());
}
`;
}

/**
 * Step 4 — Set BillToContactId, copy address from Account, then activate.
 * Orders converted from Quotes require a bill-to contact and billing address.
 */
function buildActivationApex(orderId, contactId) {
  return `
try {
  Order o = [SELECT Id, Status, AccountId,
               BillingStreet, BillingCity, BillingState, BillingCountry, BillingPostalCode,
               ShippingStreet, ShippingCity, ShippingState, ShippingCountry, ShippingPostalCode
             FROM Order WHERE Id = '${orderId}' LIMIT 1];
  if (o.AccountId != null && (o.BillingState == null || o.BillingState == ''
      || o.ShippingState == null || o.ShippingState == '')) {
    Account acc = [SELECT BillingStreet, BillingCity, BillingState, BillingCountry, BillingPostalCode,
                          ShippingStreet, ShippingCity, ShippingState, ShippingCountry, ShippingPostalCode
                   FROM Account WHERE Id = :o.AccountId LIMIT 1];
    if (o.BillingState == null || o.BillingState == '') {
      o.BillingStreet     = acc.BillingStreet;
      o.BillingCity       = acc.BillingCity;
      o.BillingState      = acc.BillingState;
      o.BillingCountry    = acc.BillingCountry;
      o.BillingPostalCode = acc.BillingPostalCode;
    }
    if (o.ShippingState == null || o.ShippingState == '') {
      // Fall back to billing address values if account shipping is also blank
      o.ShippingStreet     = acc.ShippingStreet != null ? acc.ShippingStreet : acc.BillingStreet;
      o.ShippingCity       = acc.ShippingCity != null ? acc.ShippingCity : acc.BillingCity;
      o.ShippingState      = acc.ShippingState != null ? acc.ShippingState : acc.BillingState;
      o.ShippingCountry    = acc.ShippingCountry != null ? acc.ShippingCountry : acc.BillingCountry;
      o.ShippingPostalCode = acc.ShippingPostalCode != null ? acc.ShippingPostalCode : acc.BillingPostalCode;
    }
  }
  o.BillToContactId = '${contactId}';
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
 * Flow per transaction: PST (Quote) → link Account → createOrderFromQuote → Activate Order
 */
export async function generateOrders(accounts, productPool, ordersPerAccount, onProgress) {
  const totalOrders = accounts.length * ordersPerAccount;

  if (totalOrders > WARN_THRESHOLD) {
    onProgress(`⚠️  Warning: ${totalOrders} total orders. This will take a while. Proceeding...`);
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
      const quoteDate = randomOrderDate();

      onProgress(`[${orderNum}/${totalOrders}] "${account.name}" — ${lineItems.length} line items, date ${quoteDate}`);

      try {
        // Step 1 — Create priced Quote via PST
        const pstOutput = runApex(buildPSTApex(quoteDate, lineItems, discounts));
        const pstLines = extractDebugLines(pstOutput);

        let quoteId = null;
        let pstError = '';
        for (const line of pstLines) {
          if (line.startsWith('PST_SUCCESS|')) quoteId = line.split('|')[1];
          else if (line.startsWith('PST_FAILURE|')) pstError = line.split('|').slice(1).join('|');
        }
        if (!quoteId) {
          failed.push({ accountName: account.name, error: pstError || 'PST returned no Quote ID' });
          onProgress(`  ✗ PST failed: ${pstError}`);
          continue;
        }
        onProgress(`  → Quote ${quoteId} created`);

        // Wait for PST tax calculation to complete before conversion
        await waitForQuoteReady(quoteId);

        // Step 2 — Link Account via stub Opportunity, ensure Bill-To Contact exists
        const linkOutput = runApex(buildLinkAccountApex(quoteId, account.id, quoteDate));
        const linkLines = extractDebugLines(linkOutput);
        let linkError = '';
        let contactId = null;
        for (const line of linkLines) {
          if (line.startsWith('LINK_SUCCESS|')) contactId = line.split('|')[3];
          else if (line.startsWith('LINK_FAILED|')) linkError = line.split('|').slice(2).join('|');
        }
        if (!contactId) {
          failed.push({ accountName: account.name, error: linkError || 'Account link failed' });
          onProgress(`  ✗ Account link failed: ${linkError}`);
          continue;
        }

        // Step 3 — Convert Quote to Order
        const convertOutput = runApex(buildConvertApex(quoteId));
        const convertLines = extractDebugLines(convertOutput);
        let orderId = null;
        let convertError = '';
        for (const line of convertLines) {
          if (line.startsWith('CONVERT_SUCCESS|')) orderId = line.split('|')[1];
          else if (line.startsWith('CONVERT_FAILED|')) convertError = line.split('|').slice(2).join('|');
        }
        if (!orderId) {
          failed.push({ accountName: account.name, error: convertError || 'Conversion returned no Order ID' });
          onProgress(`  ✗ Conversion failed: ${convertError}`);
          continue;
        }
        onProgress(`  → Order ${orderId} created from Quote`);

        // Step 4 — Activate the Order
        const activateOutput = runApex(buildActivationApex(orderId, contactId));
        const activateLines = extractDebugLines(activateOutput);
        let activateFailed = false;
        for (const line of activateLines) {
          if (line.startsWith('ACTIVATE_FAILED|')) {
            activateFailed = true;
            onProgress(`  ✗ Activation failed: ${line.split('|').slice(2).join('|')}`);
            failed.push({ accountName: account.name, error: `Activation: ${line.split('|').slice(2).join('|')}` });
          }
        }
        if (!activateFailed) {
          created.push(orderId);
          onProgress(`  ✓ Order ${orderId} activated (from Quote ${quoteId})`);
        }

      } catch (err) {
        failed.push({ accountName: account.name, error: err.message });
        onProgress(`  ✗ Exception: ${err.message}`);
      }
    }
  }

  return { created, failed };
}
