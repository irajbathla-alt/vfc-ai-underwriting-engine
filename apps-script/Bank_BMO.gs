/** BMO — PENDING TRAINING. Change only this file when BMO is trained. */
function vfcBmoBankProfile_(){return{id:'BMO',label:'BMO',status:'PENDING_TRAINING',rulesVersion:'BMO-UNTRAINED',aliases:['BANK OF MONTREAL','BMO']};}
function vfcBmoClassifyDebit_(t){return vfcGenericConservativeClassifyDebit_(t);}
function vfcBmoKnownFinancingCredit_(t){return false;}

/** Temporary compatibility for the current UI. */
function uploadStatementBatchBMO(companyName,files){return uploadStatementBatchByBank('BMO',companyName,files);}
