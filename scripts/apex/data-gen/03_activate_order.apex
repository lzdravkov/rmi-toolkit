// RMI Toolkit — Reference: Order Activation
// Replace ORDER_ID with the Id returned from PST.
// The generate.js CLI runs this automatically after each successful PST call.

final String ORDER_ID = '801Hu00000XXXXXXXXX'; // replace

try {
    Order o = [SELECT Id, Status FROM Order WHERE Id = :ORDER_ID LIMIT 1];
    System.debug('Pre-activation status: ' + o.Status);
    o.Status = 'Activated';
    update o;
    System.debug('ACTIVATED|' + ORDER_ID);
} catch (Exception e) {
    System.debug('ACTIVATE_FAILED|' + ORDER_ID + '|' + e.getMessage());
}
