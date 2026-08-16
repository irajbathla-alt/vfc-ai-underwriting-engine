/** CIBC — PENDING TRAINING. Change only this file when CIBC is trained. */
function vfcCibcBankProfile_(){return{id:'CIBC',label:'CIBC',status:'PENDING_TRAINING',rulesVersion:'CIBC-UNTRAINED',aliases:['CANADIAN IMPERIAL BANK OF COMMERCE','CIBC']};}
function vfcCibcClassifyDebit_(t){return vfcGenericConservativeClassifyDebit_(t);}
function vfcCibcKnownFinancingCredit_(t){return false;}
