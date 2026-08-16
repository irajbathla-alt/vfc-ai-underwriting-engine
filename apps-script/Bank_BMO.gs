/** BMO — PENDING TRAINING. Change only this file when BMO is trained. */
function vfcBmoBankProfile_(){return{id:'BMO',label:'BMO',status:'PENDING_TRAINING',rulesVersion:'BMO-UNTRAINED',aliases:['BANK OF MONTREAL','BMO']};}
function vfcBmoExtractionRules_(){return 'BMO is not trained yet. Extract visible financing, loan, pre-authorized payment, tax, insurance and credit-card transactions conservatively. Do not apply RBC-specific names or patterns.';}
function vfcBmoLockFacts_(summary,text,fileName){return vfcLockPrintedStatementFacts_(summary,text);}
function vfcBmoClassifyDebit_(t){return vfcGenericConservativeClassifyDebit_(t);}
function vfcBmoKnownFinancingCredit_(t){return false;}
