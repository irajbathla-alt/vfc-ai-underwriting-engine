/** TD — PENDING TRAINING. Change only this file when TD is trained. */
function vfcTdBankProfile_(){return{id:'TD',label:'TD',status:'PENDING_TRAINING',rulesVersion:'TD-UNTRAINED',aliases:['TD CANADA TRUST','TORONTO-DOMINION','TD BANK']};}
function vfcTdExtractionRules_(){return 'TD is not trained yet. Extract visible financing, loan, PAD, tax, insurance and credit-card transactions conservatively. Do not apply RBC-specific names or patterns.';}
function vfcTdLockFacts_(summary,text,fileName){return vfcLockPrintedStatementFacts_(summary,text);}
function vfcTdClassifyDebit_(t){return vfcGenericConservativeClassifyDebit_(t);}
function vfcTdKnownFinancingCredit_(t){return false;}
