/** CIBC — PENDING TRAINING. Change only this file when CIBC is trained. */
function vfcCibcBankProfile_(){return{id:'CIBC',label:'CIBC',status:'PENDING_TRAINING',rulesVersion:'CIBC-UNTRAINED',aliases:['CANADIAN IMPERIAL BANK OF COMMERCE','CIBC']};}
function vfcCibcExtractionRules_(){return 'CIBC is not trained yet. Extract visible financing, loan, PAD, tax, insurance and credit-card transactions conservatively. Do not apply RBC-specific names or patterns.';}
function vfcCibcLockFacts_(summary,text,fileName){return vfcLockPrintedStatementFacts_(summary,text);}
function vfcCibcClassifyDebit_(t){return vfcGenericConservativeClassifyDebit_(t);}
function vfcCibcKnownFinancingCredit_(t){return false;}
