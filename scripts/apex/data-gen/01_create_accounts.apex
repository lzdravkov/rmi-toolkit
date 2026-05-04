// RMI Toolkit — Reference: Account Creation
// This is a parameterized template. The generate.js CLI builds accounts dynamically.
// This script is a hand-runnable reference for creating a single batch of demo accounts.
// Idempotent: skips accounts whose Name already exists.

List<Account> accs = new List<Account>{
    new Account(Name='Apex Automotive Systems',    Rating='Hot',  Industry='Automotive',    BillingState='MI', AnnualRevenue=85000000,  NumberOfEmployees=420),
    new Account(Name='Delta Harness Solutions',    Rating='Warm', Industry='Manufacturing', BillingState='OH', AnnualRevenue=42000000,  NumberOfEmployees=180),
    new Account(Name='Aerotech Wiring Solutions',  Rating='Hot',  Industry='Aerospace',     BillingState='CA', AnnualRevenue=210000000, NumberOfEmployees=900),
    new Account(Name='GridWorks Energy Solutions', Rating='Cold', Industry='Energy',        BillingState='TX', AnnualRevenue=67000000,  NumberOfEmployees=310),
    new Account(Name='Ironbridge Industrial Supply',Rating='Warm',Industry='Industrial',    BillingState='IL', AnnualRevenue=31000000,  NumberOfEmployees=140)
};

// Check Customer_Tier__c existence at runtime
Boolean hasTierField = false;
for (Schema.SObjectField f : Schema.SObjectType.Account.fields.getMap().values()) {
    if (f.getDescribe().getName() == 'Customer_Tier__c') { hasTierField = true; break; }
}

String[] tiers = new String[]{'Bronze','Silver','Gold','Platinum'};
if (hasTierField) {
    for (Integer i = 0; i < accs.size(); i++) {
        accs[i].put('Customer_Tier__c', tiers[Math.mod(i, tiers.size())]);
    }
}

Set<String> names = new Set<String>();
for (Account a : accs) names.add(a.Name);
Set<String> existing = new Set<String>();
for (Account a : [SELECT Name FROM Account WHERE Name IN :names]) existing.add(a.Name);

List<Account> toInsert = new List<Account>();
for (Account a : accs) { if (!existing.contains(a.Name)) toInsert.add(a); }

if (toInsert.isEmpty()) {
    System.debug('All accounts already exist — nothing to insert.');
} else {
    insert toInsert;
    for (Account a : toInsert) System.debug('CREATED_ACCOUNT|' + a.Name + '|' + a.Id);
    System.debug('ACCOUNT_COUNT|' + toInsert.size());
}
