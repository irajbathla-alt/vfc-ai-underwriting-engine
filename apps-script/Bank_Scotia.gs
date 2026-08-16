/** Scotiabank — PENDING TRAINING. Change only this file when Scotia is trained. */
function vfcScotiaBankProfile_(){return{id:'SCOTIA',label:'Scotia',status:'PENDING_TRAINING',rulesVersion:'SCOTIA-UNTRAINED',aliases:['SCOTIABANK','BANK OF NOVA SCOTIA','SCOTIA']};}
function vfcScotiaExtractionRules_(){return 'Scotiabank is not trained yet. Extract visible financing, loan, PAD, tax, insurance and credit-card transactions conservatively. Do not apply RBC-specific names or patterns.';}
function vfcScotiaLockFacts_(summary,text,fileName){return vfcLockPrintedStatementFacts_(summary,text);}
function vfcScotiaClassifyDebit_(t){return vfcGenericConservativeClassifyDebit_(t);}
function vfcScotiaKnownFinancingCredit_(t){return false;}
