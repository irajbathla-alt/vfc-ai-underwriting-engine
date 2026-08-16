/** Coast Capital — PENDING TRAINING. Change only this file when Coast Capital is trained. */
function vfcCoastCapitalBankProfile_(){return{id:'COAST_CAPITAL',label:'Coast Capital',status:'PENDING_TRAINING',rulesVersion:'COAST-CAPITAL-UNTRAINED',aliases:['COAST CAPITAL SAVINGS','COAST CAPITAL']};}
function vfcCoastCapitalExtractionRules_(){return 'Coast Capital is not trained yet. Extract visible financing, loan, PAD, tax, insurance and credit-card transactions conservatively. Do not apply RBC-specific names or patterns.';}
function vfcCoastCapitalLockFacts_(summary,text,fileName){return vfcLockPrintedStatementFacts_(summary,text);}
function vfcCoastCapitalClassifyDebit_(t){return vfcGenericConservativeClassifyDebit_(t);}
function vfcCoastCapitalKnownFinancingCredit_(t){return false;}
