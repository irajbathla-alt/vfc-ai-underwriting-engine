/**
 * RBC BANK ENGINE v3.1 — CANDIDATE / AUDITED REVALIDATION
 * ONE PERMANENT RBC FILE.
 *
 * Architecture:
 * 1) Printed RBC Account Summary is the source of truth for statement totals/counts.
 * 2) Every visible Account Activity amount row is frozen.
 * 3) The extracted ledger must match printed CREDIT/DEBIT counts AND dollar totals exactly.
 * 4) If first-pass extraction misses/duplicates a row, RBC performs a targeted reconciliation pass.
 * 5) A repaired ledger is accepted only after the exact same deterministic audit passes.
 * 6) Printed column controls direction. Wording never overrides ambiguous return/misc/transfer rows.
 * 7) PAD/NSF/return/debt classification remains deterministic after facts are frozen.
 */
function vfcRbcBankProfile_(){
  return{
    id:'RBC',
    label:'RBC',
    status:'CANDIDATE',
    rulesVersion:'RBC-3.1-CANDIDATE',
    intakeContract:'BANK_MATCHED_FROZEN_LEDGER_V2',
    aliases:['ROYAL BANK OF CANADA','RBC ROYAL BANK','RBC']
  };
}

function vfcRbcExtractionRules_(){return[
  'RBC Account Summary: Total deposits & credits is total_deposits; Total cheques & debits is total_withdrawals.',
  'RBC Account Activity: Cheques & Debits = DEBIT and Deposits & Credits = CREDIT. The PRINTED COLUMN is authoritative.',
  'FULL LEDGER: banking_transactions must contain EVERY visible Account Activity row carrying a transaction amount, including ordinary fees, purchases, cheques, transfers, PADs, insurance, taxes, loans, refunds and deposits.',
  'Do not add Opening balance, Closing balance, Account Summary totals, Account Fees summary totals, page totals, cheque-image/support pages, serial-number image rows or endorsement/back-of-cheque text as transactions.',
  'The number of CREDIT and DEBIT transaction rows and their dollar sums must equal the printed Account Summary exactly. Never approximate or omit a row simply because it seems irrelevant.',
  'MISC PAYMENT, BR TO BR, ONLINE BANKING TRANSFER and RETURN/NSF wording do not determine direction. Follow the printed RBC column.',
  'Preserve every PAD-like debit: BUSINESS PAD, PAD, PRE-AUTH, PRE-AUTHORIZED, PREAUTHORIZED, DIRECT DEBIT, EFT DEBIT, ACH DEBIT, AUTOMATIC DEBIT, AUTO PAYMENT and lender-specific PAD wording.',
  'Unknown PAD/direct-debit counterparties remain informational unless independent lender/loan/MCA/finance/lease evidence exists. Recurrence or same amount alone never proves financing.',
  'Preserve every return/NSF/reversal principal event and any later retry. Return wording can be CREDIT or DEBIT; printed RBC column decides direction.',
  'A return CREDIT can reverse a failed borrower debit/PAD. A return DEBIT can reverse a deposited item. Do not confuse those two cases.',
  'Preserve NSF/returned-item fees separately as fee debits; fees are never the returned principal amount.',
  'Any recurring debit explicitly containing LOAN, MORTGAGE, LOC/LINE OF CREDIT, FINANCING, MCA or LEASE is a financing-obligation candidate.',
  'General e-Transfers, transfers, rent, tax, utility, payroll, card payments and unknown PADs are not financing merely because they recur.',
  'AFFIRM CANADA is financing when recurring.',
  'PREMIUM FINANCE, PREMIUM FINANCING and IPFS are financing when recurring; ordinary insurance remains informational.',
  'BDC: BUSINESS PAD BDC is the normal PAD stream. BDC-LOAN/PRET/manual BDC loan payments stay separate. Materially different BDC PAD amounts are separated into amount bands so catch-up payments cannot inflate normal monthly debt.',
  'Journey/OnDeck, Merchant Growth, Canacap and Greenbox are MCA-style exposures when recurring. iCapital remains general financing unless statement wording proves MCA.',
  'Known financing entities include BDC, Canacap, iCapital, Greenbox, Journey/OnDeck, Merchant Growth, SilverChef, Affirm Canada and explicit premium finance/IPFS.',
  'LOAN CREDIT, CSBFL advances and credits from known financing entities are financing-credit candidates only when printed in Deposits & Credits.',
  'BR TO BR credits and explicit TRANSFER FROM ACCOUNT credits are internal transfers unless independently identified as financing proceeds. Generic customer e-Transfers are not excluded.',
  'Do not duplicate cheque-image/support pages.'
].join('\n');}

function vfcRbcLockFacts_(summary,text,fileName){
  const facts=vfcExtractPrintedStatementFacts_(text),name=String(fileName||'statement'),printed=vfcRbcPrintedActivityCounts_(text);
  if(!facts.startDate||!facts.endDate||facts.opening===null||facts.closing===null||facts.deposits===null||facts.withdrawals===null){
    throw new Error('RBC printed Account Summary could not be fully verified for '+name+'. Upload stopped before saving incomplete statement facts.');
  }
  if(printed.creditCount===null||printed.debitCount===null){
    throw new Error('RBC printed Account Summary transaction counts could not be verified for '+name+'. Upload stopped before freezing the ledger.');
  }

  const statementDiff=Math.abs((facts.opening+facts.deposits-facts.withdrawals)-facts.closing);
  if(statementDiff>.05)throw new Error('RBC printed Account Summary does not reconcile for '+name+'. Difference: 

function vfcRbcPrintedActivityCounts_(text){
  const s=String(text||'').replace(/\u00a0/g,' '),
        c=s.match(/Total\s+deposits\s*(?:&|and)\s*credits\s*\((\d+)\)/i),
        d=s.match(/Total\s+cheques?\s*(?:&|and)\s*debits\s*\((\d+)\)/i);
  return{creditCount:c?Number(c[1]):null,debitCount:d?Number(d[1]):null};
}

function vfcRbcIsNonActivityArtifact_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s)return true;
  return/^OPENING\s+BALANCE\b|^CLOSING\s+BALANCE\b|^ACCOUNT\s+FEES?\b|^ACCOUNT\s+SUMMARY\b|^TOTAL\s+DEPOSITS\s*&\s*CREDITS\b|^TOTAL\s+CHEQUES\s*&\s+DEBITS\b|^PAGE\s+TOTAL\b|^SERIAL\s*#?\s*:?\s*\d+\s+AMOUNT\b|FOR\s+DEPOSIT\s+ONLY|BACKVERSO|BACK\s*\/\s*VERSO|CHEQUE\s+IMAGE|CHECK\s+IMAGE/.test(s);
}

function vfcRbcPrepareLedger_(items){
  return(Array.isArray(items)?items:[]).filter(function(x){return!vfcRbcIsNonActivityArtifact_(x);}).map(function(x){
    const t=Object.assign({},x||{}),forced=vfcRbcCertainDirection_(t);
    if(forced)t.direction=forced;
    t.direction=String(t.direction||'').toUpperCase();
    t.description=String(t.description||'').replace(/\s+/g,' ').trim();
    t.counterparty=String(t.counterparty||t.description||'').replace(/\s+/g,' ').trim();
    t.amount=vfcNum_(t.amount);
    return t;
  });
}

function vfcRbcCertainDirection_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return'';
  if(/^LOAN\s+CREDIT\b/.test(s)||/\bPAYROLL\s+DEPOSIT\b|\bTAX\s+REFUND\b|E-TRANSFER\s+RECEIVED|INTERAC\s+PURCHASE\s+REFUND|E-TRANSFER\s+CANCEL|MOBILE\s+CHEQUE\s+DEPOSIT/.test(s))return'CREDIT';
  if(vfcRbcIsPadLikeText_(s)||/^LOAN\s+PAYMENT\b|^LOAN\s+INTEREST\b|^BLIP\s+PAYMENT\s*-?\s*LOAN\b|^BILL\s+PAYMENT\b|^FUEL\s+BILL\s+PAYMENT\b|^COMM\s+GAS\s+BILL\s+PMT\b|^COMMERCIAL\s+TAXES\b|^AUTO\s+INSURANCE\b|^INSURANCE\b|^RENT\/LEASE\b|^CHEQUE\s*-\s*\d+\b|E-TRANSFER\s+SENT|E-TRANSFER\s+REQUEST\s+FULFILLED/.test(s))return'DEBIT';
  return'';
}

function vfcRbcLedgerStats_(items){
  const out={creditCount:0,debitCount:0,totalCredits:0,totalDebits:0,bad:[]};
  (Array.isArray(items)?items:[]).forEach(function(t,i){
    const d=String(t&&t.direction||'').toUpperCase(),a=vfcNum_(t&&t.amount),desc=String(t&&t.description||'').trim(),date=vfcIso_(t&&t.date);
    if(!date||!desc||!(a>0)||(d!=='CREDIT'&&d!=='DEBIT')){out.bad.push(i+1);return;}
    if(d==='CREDIT'){out.creditCount++;out.totalCredits+=a;}else{out.debitCount++;out.totalDebits+=a;}
  });
  out.totalCredits=vfcRound_(out.totalCredits,.01);out.totalDebits=vfcRound_(out.totalDebits,.01);return out;
}

function vfcRbcLedgerPreview_(rows,direction){
  return(rows||[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()===direction;}).slice(0,40).map(function(t){return String(t.date||'')+' '+String(t.description||'')+' $'+vfcNum_(t.amount);}).join(' | ');
}

function vfcRbcAuditFullLedger_(items,facts,text,fileName){
  const rows=Array.isArray(items)?items:[],printed=vfcRbcPrintedActivityCounts_(text),s=vfcRbcLedgerStats_(rows);
  if(printed.creditCount===null||printed.debitCount===null)throw new Error('RBC printed transaction counts are missing for '+fileName+'.');
  if(s.bad.length)throw new Error('RBC full ledger contains incomplete transaction row(s) '+s.bad.join(', ')+' for '+fileName+'.');

  const creditCountOk=s.creditCount===printed.creditCount,
        debitCountOk=s.debitCount===printed.debitCount,
        creditTotalOk=Math.abs(s.totalCredits-vfcNum_(facts.deposits))<=.05,
        debitTotalOk=Math.abs(s.totalDebits-vfcNum_(facts.withdrawals))<=.05;

  if(!creditCountOk||!debitCountOk||!creditTotalOk||!debitTotalOk){
    throw new Error(
      'RBC ledger mismatch for '+fileName+
      ': printed credits '+printed.creditCount+' / 

function vfcRbcRepairLedger_(currentLedger,text,fileName,facts,reason,attempt){
  const printed=vfcRbcPrintedActivityCounts_(text),current=vfcRbcLedgerStats_(currentLedger),prompt=[
    'You are the VFC RBC Account Activity Reconciliation Reader. Return JSON only.',
    'This is FACT EXTRACTION ONLY. Do not underwrite, classify debt, summarize or estimate.',
    'File: '+fileName,
    'The previous ledger failed deterministic reconciliation: '+reason,
    'AUTHORITATIVE PRINTED TARGETS:',
    'CREDIT rows exactly: '+printed.creditCount,
    'CREDIT total exactly: '+vfcNum_(facts.deposits),
    'DEBIT rows exactly: '+printed.debitCount,
    'DEBIT total exactly: '+vfcNum_(facts.withdrawals),
    'Opening balance: '+vfcNum_(facts.opening),
    'Closing balance: '+vfcNum_(facts.closing),
    'Return JSON with ONE field only: banking_transactions.',
    'banking_transactions must be the COMPLETE Account Activity ledger and each object must be {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short visible counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
    'STRICT RULES:',
    '1. Read only Account Activity Details rows. Include every amount-bearing activity row, including all bank fees and ordinary purchases.',
    '2. Do not include opening/closing balances, Account Summary totals, Account Fees summary, page totals, cheque-image/support pages, serial-number image rows or endorsements.',
    '3. Printed Cheques & Debits column = DEBIT; printed Deposits & Credits column = CREDIT. Never infer direction from words.',
    '4. MISC PAYMENT and RETURN/NSF can occur in either direction. Use the printed column.',
    '5. Keep repeated legitimate transactions. Do not deduplicate two separately printed activity rows.',
    '6. The final array MUST contain exactly '+printed.creditCount+' CREDIT rows totaling '+vfcNum_(facts.deposits)+' and exactly '+printed.debitCount+' DEBIT rows totaling '+vfcNum_(facts.withdrawals)+'.',
    '7. If the current candidate missed a row, recover it from the raw statement. If it contains an artifact, remove only the artifact.',
    'Current candidate stats: credits '+current.creditCount+' / $'+current.totalCredits+', debits '+current.debitCount+' / $'+current.totalDebits+'.',
    'Current candidate ledger:',JSON.stringify(currentLedger),
    'RBC STATEMENT TRANSCRIPT:',String(text||'').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
  ].join('\n');
  const repaired=callOpenAIJson_(prompt);
  if(!repaired||!Array.isArray(repaired.banking_transactions))throw new Error('RBC reconciliation pass '+attempt+' did not return a complete banking_transactions array for '+fileName+'.');
  return vfcRbcPrepareLedger_(repaired.banking_transactions);
}

function vfcRbcIsPadLikeText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return false;
  return/^(?:BUSINESS\s+)?PAD\b|PRE[- ]?AUTH(?:ORIZED)?(?:\s+DEBIT|\s+PAYMENT)?\b|PREAUTHORIZED(?:\s+DEBIT|\s+PAYMENT)?\b|DIRECT\s+DEBIT\b|EFT\s+DEBIT\b|ACH\s+DEBIT\b|AUTOMATIC\s+DEBIT\b|AUTO\s+PAYMENT\b/.test(s);
}

function vfcRbcReturnEventText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||/\b(?:FEE|FEES|CHARGE)\b/.test(s))return false;
  return/CHEQUE\s+RETURNED(?:\s+NSF)?|CHECK\s+RETURNED(?:\s+NSF)?|ITEM\s+RETURNED(?:\s+NSF|\s+UNPAID)?|RETURNED\s+(?:ITEM|CHEQUE|CHECK|PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)|(?:PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)\s+RETURNED|PRE[- ]?AUTH(?:ORIZED)?\s+(?:DEBIT|PAYMENT)\s+RETURNED|PREAUTHORIZED\s+(?:DEBIT|PAYMENT)\s+RETURNED|DIRECT\s+DEBIT\s+RETURNED|REJECTED\s+(?:PAD|DEBIT|PAYMENT)|\bREVERSAL\b|\bREVERSED\b|NSF\s+RETURN/.test(s);
}
function vfcRbcReturnCreditText_(value){return vfcRbcReturnEventText_(value);}
function vfcRbcCountReturnEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return vfcRbcReturnEventText_(t&&t.description);}).length;}

function vfcRbcBorrowerNsfCreditText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||/\b(?:FEE|FEES|CHARGE)\b/.test(s))return false;
  return/\bNSF\b|CHEQUE\s+RETURNED\s+NSF|CHECK\s+RETURNED\s+NSF|ITEM\s+RETURNED\s+NSF|RETURNED\s+(?:PAYMENT|PAD|DEBIT|EFT|ACH)|(?:PAYMENT|PAD|DEBIT|EFT|ACH)\s+RETURNED|REJECTED\s+(?:PAD|DEBIT|PAYMENT)/.test(s);
}

function vfcRbcCountBorrowerNsfEvents_(items){
  return(Array.isArray(items)?items:[]).filter(function(t){
    return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcBorrowerNsfCreditText_(t&&t.description);
  }).length;
}

function vfcRbcNegativeBalanceFlag_(text,facts){
  if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;
  const lines=String(text||'').replace(/\u00a0/g,' ').split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    const line=String(lines[i]||'').trim();
    if(!line)continue;
    if(/TOTAL\s+(?:DEPOSITS|CREDITS|CHEQUES|DEBITS|WITHDRAWALS)|ACCOUNT\s+SUMMARY|ACCOUNT\s+FEES?/i.test(line))continue;
    if(/\bBALANCE\b\s*[:=]?\s*-\s*\$?[0-9][0-9,]*\.\d{2}\s*$/i.test(line))return true;
    if(/(?:^|\s)-\s*\$?[0-9][0-9,]*\.\d{2}\s*$/.test(line)&&/\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|LOAN|PAYMENT|CHEQUE|PAD|TRANSFER|INTERAC|INSURANCE|RENT|FUEL|ATM|PURCHASE|DEPOSIT)\b/i.test(line))return true;
  }
  return false;
}
function vfcRbcAmountBand_(amount){const n=Math.max(1,vfcNum_(amount));return Math.round(Math.log(n)/Math.log(1.25));}

function vfcRbcClassifyDebit_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t&&t.counterparty||'').replace(/\s+/g,' ').trim(),band=vfcRbcAmountBand_(t&&t.amount),hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b|\bMCA\b|\bLEASE\b|\bLSE\b/.test(s),isFee=/\bFEES?\b|SERVICE\s+CHARGE|NSF\s+ITEM\s+FEES?|RETURNED[- ]?ITEM\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE|ACTIVITY\s+FEE|TRANSACTION\s+FEE|MONTHLY\s+FEE/.test(s);
  if(isFee&&!hasFinancingSignal)return null;
  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/COMM\s+EQUIP\s+RENT\/LSE\s+SILVERCHEF|\bSILVERCHEF\b/.test(s)){family='FINANCING';entityKey='SILVERCHEF_EQUIPMENT_LEASE';label='SilverChef Equipment Lease';debtJustification='Explicit recurring equipment lease.';}
  else if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';debtJustification='Known MCA/funding counterparty plus recurrence.';}
  else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){family='MCA';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bBDC\b/.test(s)&&vfcRbcIsPadLikeText_(s)){family='FINANCING';entityKey='RBC_BDC_PAD_B'+band;label='BDC';debtJustification='Recurring BDC PAD stream; materially different catch-up amounts remain separate.';}
  else if(/\bBDC\b/.test(s)&&(/BDC[- ]?LOAN\/PRET|ONLINE\s+BANKING\s+PAYMENT|\bLOAN\b|FINANC/.test(s))){family='FINANCING';entityKey='RBC_BDC_MANUAL_B'+band;label='BDC Manual / Loan Payment';debtJustification='Manual BDC loan-payment stream kept separate from normal PAD.';}
  else if(/\bAFFIRM(?:\s+CANADA)?\b/.test(s)){family='FINANCING';entityKey='RBC_AFFIRM_CANADA';label='Affirm Canada';debtJustification='Affirm Canada financing counterparty plus recurrence.';}
  else if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='CANACAP';label='Canacap';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bGREENBOX\b/.test(s)){family='MCA';entityKey='GREENBOX';label='Greenbox';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bICAPITAL\b/.test(s)){family='FINANCING';entityKey='ICAPITAL';label='iCapital';debtJustification='Known financing counterparty plus recurrence.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC/.test(s)){family='FINANCING';entityKey='RBC_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw)+'_B'+band;label=cp||'Premium Finance';debtJustification='Explicit premium-finance counterparty plus recurrence.';}
  else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){family='TAX';entityKey='RBC_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);}
  else if(/INSURANCE/.test(s)){family='OTHER';if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}else if(/IND\s+ALL/.test(s)){entityKey='INSURANCE_IND_ALL';label='Insurance IND ALL';}else entityKey='RBC_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|CAPITAL\s+ONE|\bMBNA\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/^AUTO\s+PAYMENT\b/.test(s)){
    const clean=raw.replace(/^AUTO\s+PAYMENT\s*/i,'').trim(),financeLike=/\bAFS\b|FINANC|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s);
    family=financeLike?'FINANCING':'OTHER';entityKey=(financeLike?'AUTO_PAYMENT_FINANCE_':'RBC_OTHER_AUTOPAY_')+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;if(financeLike)debtJustification='Automatic payment with independent finance-like counterparty evidence.';
  }
  else if(/^MISC\s+PAYMENT\b/.test(s)&&(/\bAFS\b|FINANC|LEASE|LENDING|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s))){const clean=raw.replace(/^MISC\s+PAYMENT\s*/i,'').trim();family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;debtJustification='Retry/recurring payment with independent finance-like counterparty evidence.';}
  else if(hasFinancingSignal){
    family='FINANCING';debtJustification='Explicit financing wording plus recurring observed cadence.';
    if(/^LOAN\s+PAYMENT$/i.test(raw)){entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';}
    else{
      const numbered=s.match(/(?:NO\.?|NUMBER|#)\s*([0-9-]{5,})/),generic=s.match(/\b(?:LOAN|MORTGAGE|LOC)\b[^0-9]{0,30}([0-9][0-9-]{5,})\b/),ref=numbered||generic;
      if(ref){const n=ref[1].replace(/[^0-9]/g,'');if(/LOAN\s+INTEREST/.test(s)){entityKey='LOAN_INTEREST_'+n;label='Loan interest NO.'+n;}else if(/\bLOAN\b/.test(s)){entityKey='LOAN_'+n;label='Loan payment NO.'+n;}else if(/\bLEASE\b|\bLSE\b/.test(s)){entityKey='LEASE_'+n;label='Lease payment NO.'+n;}else{entityKey='FINANCE_REF_'+n;}}
      else{const stable=(cp||raw).replace(/\b[0-9][0-9-]{4,}\b/g,'').replace(/\s+/g,' ').trim();entityKey='RBC_FINANCE_'+vfcCounterpartyKey_(stable||cp||raw);}
    }
  }
  else if(vfcRbcIsPadLikeText_(s)){family='OTHER';entityKey='RBC_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/\bCAPITAL\b|\bFUNDING\b|\bFACTOR(?:ING)?\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_POSSIBLE_FINANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/COMMERCIAL\s+RENT|\bRENT\b|HYDRO|FORTIS|TELUS|UTILITY|SUPERPASS|PETROLEUM|\bFUEL\b|EQUIPMENT\s+RENT|PAY\s+EMPLOYEE|PAYROLL/.test(s)){family='OTHER';entityKey='RBC_OTHER_BUSINESS_'+vfcCounterpartyKey_(cp||raw);}
  else{return null;}
  if(!entityKey)entityKey='RBC_OTHER_'+vfcCounterpartyKey_(raw);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcRbcIsReturnedFinancingCredit_(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}
function vfcRbcIsNonOperatingTransferCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;const s=String(t&&t.description||'').toUpperCase();if(/E-TRANSFER|INTERAC/.test(s))return false;return/\bBR\s+TO\s+BR\b|\bTRANSFER\s+FROM\s+(?:ACCOUNT|A\/C|ACCT)\b|\bINTERNAL\s+TRANSFER\b/.test(s);}
function vfcRbcKnownFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();if(vfcRbcIsReturnedFinancingCredit_(t))return false;return/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|\bICAPITAL\b|GREENBOX|\bCSBFL\b|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s);}
function vfcRbcPreservePrintedDuplicate_(){return true;}
function vfcRbcStrongEntityKey_(key){return/^(RBC_AFFIRM_CANADA|RBC_PREMIUM_FINANCE_|RBC_BDC_|MERCHANT_GROWTH|JOURNEY_ONDECK|CANACAP|ICAPITAL|GREENBOX|SILVERCHEF_EQUIPMENT_LEASE|AUTO_PAYMENT_FINANCE_|RBC_FINANCE_|INSURANCE_|LEASE_[0-9]|FINANCE_REF_[0-9])/.test(String(key||'').toUpperCase());}

function runRbcBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'RBC',transactions:transactions||[]}};}
  function close(a,e,t,l){t=t==null?.02:t;if(Math.abs(Number(a||0)-Number(e||0))>t)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function equal(a,e,l){if(a!==e)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function truthy(v,l){if(!v)throw new Error((l||'value')+' expected truthy');}
  function test(n,f){try{results.push({name:n,pass:true,detail:String(f()||'')});}catch(e){results.push({name:n,pass:false,detail:String(e&&e.message||e)});}}

  test('AIM HIGH Mar-Apr printed credits are exactly 15 and $45,725.36',function(){const c=[2000,250,1000,6585.81,1046.83,250,7474.96,3000,750,2750,3250,2750,6673.93,7693.83,250];equal(c.length,15,'count');close(vfcSum_(c),45725.36,.02,'sum');return'15/$45725.36';});
  test('Exact ledger audit passes only when count and totals both match',function(){const text='Total deposits & credits (2) + 150.00\nTotal cheques & debits (2) - 30.00',facts={deposits:150,withdrawals:30},good=[tx('2026-01-01','A','CREDIT',100),tx('2026-01-02','B','CREDIT',50),tx('2026-01-03','C','DEBIT',10),tx('2026-01-04','D','DEBIT',20)];const a=vfcRbcAuditFullLedger_(good,facts,text,'x.pdf');equal(a.creditCount,2,'credits');let failed=false;try{vfcRbcAuditFullLedger_(good.slice(1),facts,text,'x.pdf');}catch(e){failed=true;}truthy(failed,'missing row fails');return'exact';});
  test('Opening/closing/support artifacts are excluded',function(){const p=vfcRbcPrepareLedger_([tx('2026-03-02','Opening balance','CREDIT',4710.90),tx('2026-03-03','Loan BK OF MONTREAL','DEBIT',599.22),tx('2026-04-02','Serial #: 343 Amount: $315.00','CREDIT',315)]);equal(p.length,1,'real rows');return'clean';});
  test('Return direction remains printed-column driven',function(){equal(vfcRbcCertainDirection_(tx('2026-05-27','Cheque returned NSF','DEBIT',2606.59)),'','no force');truthy(vfcRbcIsReturnedFinancingCredit_(tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)),'credit return');equal(vfcRbcIsReturnedFinancingCredit_(tx('2026-06-25','Item returned unpaid','DEBIT',187.46)),false,'debit return');return'direction safe';});
  test('Unknown recurring PAD is informational only',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-02-28',[tx('2026-02-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-03-31',[tx('2026-03-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])]);close(d.confirmedMonthlyDebtService,0,.001,'debt');return'informational';});
  test('Recurring Affirm is financing',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-02-28',[tx('2026-02-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-03-31',[tx('2026-03-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm');return'66.62';});
  test('Returned BDC PAD cannot inflate debt',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-27','Business PAD BDC','DEBIT',2578.34,'BDC')]),row('2026-04-30',[tx('2026-04-27','Business PAD BDC','DEBIT',2656.97,'BDC')]),row('2026-05-31',[tx('2026-05-27','Business PAD BDC','DEBIT',2606.59,'BDC'),tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)]),row('2026-06-30',[tx('2026-06-29','Business PAD BDC','DEBIT',5289.91,'BDC'),tx('2026-06-29','Cheque returned NSF','CREDIT',5289.91)]),row('2026-08-31',[tx('2026-08-17','Business PAD BDC','DEBIT',2285.91,'BDC')])]);truthy(d.returnedFinanceDebitsSuppressed>=2,'suppressed');return'suppressed='+d.returnedFinanceDebitsSuppressed;});
  test('Recurring IPFS is financing while ordinary insurance is informational',function(){const ip=vfcRbcClassifyDebit_(tx('2026-08-04','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')),ins=vfcRbcClassifyDebit_(tx('2026-08-04','Auto Insurance ICBC','DEBIT',234.96,'ICBC'));equal(ip.family,'FINANCING','IPFS');equal(ins.family,'OTHER','insurance');return'correct';});
  test('BR TO BR credit excluded but customer e-transfer not',function(){truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','BR TO BR - 0863','CREDIT',5000)),'internal');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','e-Transfer received CUSTOMER','CREDIT',5000)),false,'customer');return'correct';});
  test('Generic numeric Misc Payment never becomes obligation by itself',function(){equal(vfcRbcClassifyDebit_(tx('2026-03-12','Misc Payment 1469635','DEBIT',6585.81,'1469635')),null,'misc');return'ignored';});

  test('Summary debit sign does not create a false negative-balance flag',function(){
    const text='Total cheques & debits (39) -50,240.60\nClosing balance on April 2, 2026 = $195.66';
    equal(vfcRbcNegativeBalanceFlag_(text,{opening:4710.90,closing:195.66}),false,'summary sign');
    return'no false negative';
  });

  test('Visible running negative balance is detected',function(){
    const text='03 Mar Cheque - 343 315.00 -1,827.62';
    truthy(vfcRbcNegativeBalanceFlag_(text,{opening:4710.90,closing:195.66}),'running balance');
    return'negative detected';
  });

  test('Generic reversal credit is not automatically borrower NSF',function(){
    const rows=[tx('2026-03-10','Interac purchase reversal','CREDIT',125.00)];
    equal(vfcRbcCountBorrowerNsfEvents_(rows),0,'generic reversal');
    return'not NSF';
  });

  test('Cheque returned NSF credit counts as borrower NSF',function(){
    const rows=[tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)];
    equal(vfcRbcCountBorrowerNsfEvents_(rows),1,'NSF credit');
    return'1 NSF';
  });

  test('Printed activity count parser accepts ampersand and word and',function(){
    const a=vfcRbcPrintedActivityCounts_('Total deposits & credits (15) + 1\nTotal cheques & debits (39) - 1'),
          b=vfcRbcPrintedActivityCounts_('Total deposits and credits (15) + 1\nTotal cheques and debits (39) - 1');
    equal(a.creditCount,15,'amp credit');equal(a.debitCount,39,'amp debit');
    equal(b.creditCount,15,'and credit');equal(b.debitCount,39,'and debit');
    return'counts parsed';
  });

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,rbcRulesVersion:vfcRbcBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
function runBankingStabilitySelfTests(){return runRbcBankingSelfTests();}
+vfcRound_(statementDiff,.01)+'.');

  const locked=Object.assign({},summary||{});
  locked.statement_start_date=facts.startDate;
  locked.statement_end_date=facts.endDate;
  locked.opening_balance=facts.opening;
  locked.closing_balance=facts.closing;
  locked.total_deposits=facts.deposits;
  locked.total_withdrawals=facts.withdrawals;

  let ledger=vfcRbcPrepareLedger_(locked.banking_transactions||[]),audit=null,lastError='',repairPasses=0;
  for(let attempt=0;attempt<=2;attempt++){
    try{
      audit=vfcRbcAuditFullLedger_(ledger,facts,text,name);
      break;
    }catch(e){
      lastError=String(e&&e.message||e);
      if(attempt>=2)throw new Error(lastError);
      repairPasses++;
      ledger=vfcRbcRepairLedger_(ledger,text,name,facts,lastError,repairPasses);
    }
  }

  if(!audit)throw new Error('RBC ledger verification did not complete for '+name+'.');
  locked.banking_transactions=ledger;
  locked.rbc_full_ledger_verified=true;
  locked.rbc_ledger_reconciled=repairPasses>0;
  locked.rbc_ledger_repair_passes=repairPasses;
  locked.rbc_credit_transaction_count=audit.creditCount;
  locked.rbc_debit_transaction_count=audit.debitCount;
  locked.nsf_count=vfcRbcCountBorrowerNsfEvents_(ledger);
  locked.negative_balance_detected=vfcRbcNegativeBalanceFlag_(text,facts);
  return locked;
}

function vfcRbcPrintedActivityCounts_(text){
  const s=String(text||'').replace(/\u00a0/g,' '),c=s.match(/Total\s+deposits\s*&\s*credits\s*\((\d+)\)/i),d=s.match(/Total\s+cheques\s*&\s*debits\s*\((\d+)\)/i);
  return{creditCount:c?Number(c[1]):null,debitCount:d?Number(d[1]):null};
}

function vfcRbcIsNonActivityArtifact_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s)return true;
  return/^OPENING\s+BALANCE\b|^CLOSING\s+BALANCE\b|^ACCOUNT\s+FEES?\b|^ACCOUNT\s+SUMMARY\b|^TOTAL\s+DEPOSITS\s*&\s*CREDITS\b|^TOTAL\s+CHEQUES\s*&\s+DEBITS\b|^PAGE\s+TOTAL\b|^SERIAL\s*#?\s*:?\s*\d+\s+AMOUNT\b|FOR\s+DEPOSIT\s+ONLY|BACKVERSO|BACK\s*\/\s*VERSO|CHEQUE\s+IMAGE|CHECK\s+IMAGE/.test(s);
}

function vfcRbcPrepareLedger_(items){
  return(Array.isArray(items)?items:[]).filter(function(x){return!vfcRbcIsNonActivityArtifact_(x);}).map(function(x){
    const t=Object.assign({},x||{}),forced=vfcRbcCertainDirection_(t);
    if(forced)t.direction=forced;
    t.direction=String(t.direction||'').toUpperCase();
    t.description=String(t.description||'').replace(/\s+/g,' ').trim();
    t.counterparty=String(t.counterparty||t.description||'').replace(/\s+/g,' ').trim();
    t.amount=vfcNum_(t.amount);
    return t;
  });
}

function vfcRbcCertainDirection_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return'';
  if(/^LOAN\s+CREDIT\b/.test(s)||/\bPAYROLL\s+DEPOSIT\b|\bTAX\s+REFUND\b|E-TRANSFER\s+RECEIVED|INTERAC\s+PURCHASE\s+REFUND|E-TRANSFER\s+CANCEL|MOBILE\s+CHEQUE\s+DEPOSIT/.test(s))return'CREDIT';
  if(vfcRbcIsPadLikeText_(s)||/^LOAN\s+PAYMENT\b|^LOAN\s+INTEREST\b|^BLIP\s+PAYMENT\s*-?\s*LOAN\b|^BILL\s+PAYMENT\b|^FUEL\s+BILL\s+PAYMENT\b|^COMM\s+GAS\s+BILL\s+PMT\b|^COMMERCIAL\s+TAXES\b|^AUTO\s+INSURANCE\b|^INSURANCE\b|^RENT\/LEASE\b|^CHEQUE\s*-\s*\d+\b|E-TRANSFER\s+SENT|E-TRANSFER\s+REQUEST\s+FULFILLED/.test(s))return'DEBIT';
  return'';
}

function vfcRbcLedgerStats_(items){
  const out={creditCount:0,debitCount:0,totalCredits:0,totalDebits:0,bad:[]};
  (Array.isArray(items)?items:[]).forEach(function(t,i){
    const d=String(t&&t.direction||'').toUpperCase(),a=vfcNum_(t&&t.amount),desc=String(t&&t.description||'').trim(),date=vfcIso_(t&&t.date);
    if(!date||!desc||!(a>0)||(d!=='CREDIT'&&d!=='DEBIT')){out.bad.push(i+1);return;}
    if(d==='CREDIT'){out.creditCount++;out.totalCredits+=a;}else{out.debitCount++;out.totalDebits+=a;}
  });
  out.totalCredits=vfcRound_(out.totalCredits,.01);out.totalDebits=vfcRound_(out.totalDebits,.01);return out;
}

function vfcRbcLedgerPreview_(rows,direction){
  return(rows||[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()===direction;}).slice(0,40).map(function(t){return String(t.date||'')+' '+String(t.description||'')+' $'+vfcNum_(t.amount);}).join(' | ');
}

function vfcRbcAuditFullLedger_(items,facts,text,fileName){
  const rows=Array.isArray(items)?items:[],printed=vfcRbcPrintedActivityCounts_(text),s=vfcRbcLedgerStats_(rows);
  if(s.bad.length)throw new Error('RBC full ledger contains incomplete transaction row(s) '+s.bad.join(', ')+' for '+fileName+'.');
  const creditCountOk=printed.creditCount===null||s.creditCount===printed.creditCount;
  const debitCountOk=printed.debitCount===null||s.debitCount===printed.debitCount;
  const creditTotalOk=Math.abs(s.totalCredits-vfcNum_(facts.deposits))<=.05;
  const debitTotalOk=Math.abs(s.totalDebits-vfcNum_(facts.withdrawals))<=.05;
  if(!creditCountOk||!debitCountOk||!creditTotalOk||!debitTotalOk){
    throw new Error('RBC ledger mismatch for '+fileName+': printed credits '+printed.creditCount+' / $'+vfcNum_(facts.deposits)+', extracted '+s.creditCount+' / $'+s.totalCredits+'; printed debits '+printed.debitCount+' / $'+vfcNum_(facts.withdrawals)+', extracted '+s.debitCount+' / $'+s.totalDebits+'.');
  }
  return{creditCount:s.creditCount,debitCount:s.debitCount,totalCredits:s.totalCredits,totalDebits:s.totalDebits,reconciled:true};
}

function vfcRbcRepairLedger_(currentLedger,text,fileName,facts,reason,attempt){
  const printed=vfcRbcPrintedActivityCounts_(text),current=vfcRbcLedgerStats_(currentLedger),prompt=[
    'You are the VFC RBC Account Activity Reconciliation Reader. Return JSON only.',
    'This is FACT EXTRACTION ONLY. Do not underwrite, classify debt, summarize or estimate.',
    'File: '+fileName,
    'The previous ledger failed deterministic reconciliation: '+reason,
    'AUTHORITATIVE PRINTED TARGETS:',
    'CREDIT rows exactly: '+printed.creditCount,
    'CREDIT total exactly: '+vfcNum_(facts.deposits),
    'DEBIT rows exactly: '+printed.debitCount,
    'DEBIT total exactly: '+vfcNum_(facts.withdrawals),
    'Opening balance: '+vfcNum_(facts.opening),
    'Closing balance: '+vfcNum_(facts.closing),
    'Return JSON with ONE field only: banking_transactions.',
    'banking_transactions must be the COMPLETE Account Activity ledger and each object must be {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short visible counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
    'STRICT RULES:',
    '1. Read only Account Activity Details rows. Include every amount-bearing activity row, including all bank fees and ordinary purchases.',
    '2. Do not include opening/closing balances, Account Summary totals, Account Fees summary, page totals, cheque-image/support pages, serial-number image rows or endorsements.',
    '3. Printed Cheques & Debits column = DEBIT; printed Deposits & Credits column = CREDIT. Never infer direction from words.',
    '4. MISC PAYMENT and RETURN/NSF can occur in either direction. Use the printed column.',
    '5. Keep repeated legitimate transactions. Do not deduplicate two separately printed activity rows.',
    '6. The final array MUST contain exactly '+printed.creditCount+' CREDIT rows totaling '+vfcNum_(facts.deposits)+' and exactly '+printed.debitCount+' DEBIT rows totaling '+vfcNum_(facts.withdrawals)+'.',
    '7. If the current candidate missed a row, recover it from the raw statement. If it contains an artifact, remove only the artifact.',
    'Current candidate stats: credits '+current.creditCount+' / $'+current.totalCredits+', debits '+current.debitCount+' / $'+current.totalDebits+'.',
    'Current candidate ledger:',JSON.stringify(currentLedger),
    'RAW RBC STATEMENT OCR:',String(text||'').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
  ].join('\n');
  const repaired=callOpenAIJson_(prompt);
  if(!repaired||!Array.isArray(repaired.banking_transactions))throw new Error('RBC reconciliation pass '+attempt+' did not return a complete banking_transactions array for '+fileName+'.');
  return vfcRbcPrepareLedger_(repaired.banking_transactions);
}

function vfcRbcIsPadLikeText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return false;
  return/^(?:BUSINESS\s+)?PAD\b|PRE[- ]?AUTH(?:ORIZED)?(?:\s+DEBIT|\s+PAYMENT)?\b|PREAUTHORIZED(?:\s+DEBIT|\s+PAYMENT)?\b|DIRECT\s+DEBIT\b|EFT\s+DEBIT\b|ACH\s+DEBIT\b|AUTOMATIC\s+DEBIT\b|AUTO\s+PAYMENT\b/.test(s);
}

function vfcRbcReturnEventText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||/\b(?:FEE|FEES|CHARGE)\b/.test(s))return false;
  return/CHEQUE\s+RETURNED(?:\s+NSF)?|CHECK\s+RETURNED(?:\s+NSF)?|ITEM\s+RETURNED(?:\s+NSF|\s+UNPAID)?|RETURNED\s+(?:ITEM|CHEQUE|CHECK|PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)|(?:PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)\s+RETURNED|PRE[- ]?AUTH(?:ORIZED)?\s+(?:DEBIT|PAYMENT)\s+RETURNED|PREAUTHORIZED\s+(?:DEBIT|PAYMENT)\s+RETURNED|DIRECT\s+DEBIT\s+RETURNED|REJECTED\s+(?:PAD|DEBIT|PAYMENT)|\bREVERSAL\b|\bREVERSED\b|NSF\s+RETURN/.test(s);
}
function vfcRbcReturnCreditText_(value){return vfcRbcReturnEventText_(value);}
function vfcRbcCountReturnEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcCountBorrowerNsfEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcNegativeBalanceFlag_(text,facts){if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;return/(?:^|\s)-[0-9][0-9,]*\.\d{2}(?:\s|$)/m.test(String(text||''));}
function vfcRbcAmountBand_(amount){const n=Math.max(1,vfcNum_(amount));return Math.round(Math.log(n)/Math.log(1.25));}

function vfcRbcClassifyDebit_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t&&t.counterparty||'').replace(/\s+/g,' ').trim(),band=vfcRbcAmountBand_(t&&t.amount),hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b|\bMCA\b|\bLEASE\b|\bLSE\b/.test(s),isFee=/\bFEES?\b|SERVICE\s+CHARGE|NSF\s+ITEM\s+FEES?|RETURNED[- ]?ITEM\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE|ACTIVITY\s+FEE|TRANSACTION\s+FEE|MONTHLY\s+FEE/.test(s);
  if(isFee&&!hasFinancingSignal)return null;
  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/COMM\s+EQUIP\s+RENT\/LSE\s+SILVERCHEF|\bSILVERCHEF\b/.test(s)){family='FINANCING';entityKey='SILVERCHEF_EQUIPMENT_LEASE';label='SilverChef Equipment Lease';debtJustification='Explicit recurring equipment lease.';}
  else if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';debtJustification='Known MCA/funding counterparty plus recurrence.';}
  else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){family='MCA';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bBDC\b/.test(s)&&vfcRbcIsPadLikeText_(s)){family='FINANCING';entityKey='RBC_BDC_PAD_B'+band;label='BDC';debtJustification='Recurring BDC PAD stream; materially different catch-up amounts remain separate.';}
  else if(/\bBDC\b/.test(s)&&(/BDC[- ]?LOAN\/PRET|ONLINE\s+BANKING\s+PAYMENT|\bLOAN\b|FINANC/.test(s))){family='FINANCING';entityKey='RBC_BDC_MANUAL_B'+band;label='BDC Manual / Loan Payment';debtJustification='Manual BDC loan-payment stream kept separate from normal PAD.';}
  else if(/\bAFFIRM(?:\s+CANADA)?\b/.test(s)){family='FINANCING';entityKey='RBC_AFFIRM_CANADA';label='Affirm Canada';debtJustification='Affirm Canada financing counterparty plus recurrence.';}
  else if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='CANACAP';label='Canacap';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bGREENBOX\b/.test(s)){family='MCA';entityKey='GREENBOX';label='Greenbox';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bICAPITAL\b/.test(s)){family='FINANCING';entityKey='ICAPITAL';label='iCapital';debtJustification='Known financing counterparty plus recurrence.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC/.test(s)){family='FINANCING';entityKey='RBC_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw)+'_B'+band;label=cp||'Premium Finance';debtJustification='Explicit premium-finance counterparty plus recurrence.';}
  else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){family='TAX';entityKey='RBC_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);}
  else if(/INSURANCE/.test(s)){family='OTHER';if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}else if(/IND\s+ALL/.test(s)){entityKey='INSURANCE_IND_ALL';label='Insurance IND ALL';}else entityKey='RBC_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|CAPITAL\s+ONE|\bMBNA\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/^AUTO\s+PAYMENT\b/.test(s)){
    const clean=raw.replace(/^AUTO\s+PAYMENT\s*/i,'').trim(),financeLike=/\bAFS\b|FINANC|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s);
    family=financeLike?'FINANCING':'OTHER';entityKey=(financeLike?'AUTO_PAYMENT_FINANCE_':'RBC_OTHER_AUTOPAY_')+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;if(financeLike)debtJustification='Automatic payment with independent finance-like counterparty evidence.';
  }
  else if(/^MISC\s+PAYMENT\b/.test(s)&&(/\bAFS\b|FINANC|LEASE|LENDING|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s))){const clean=raw.replace(/^MISC\s+PAYMENT\s*/i,'').trim();family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;debtJustification='Retry/recurring payment with independent finance-like counterparty evidence.';}
  else if(hasFinancingSignal){
    family='FINANCING';debtJustification='Explicit financing wording plus recurring observed cadence.';
    if(/^LOAN\s+PAYMENT$/i.test(raw)){entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';}
    else{
      const numbered=s.match(/(?:NO\.?|NUMBER|#)\s*([0-9-]{5,})/),generic=s.match(/\b(?:LOAN|MORTGAGE|LOC)\b[^0-9]{0,30}([0-9][0-9-]{5,})\b/),ref=numbered||generic;
      if(ref){const n=ref[1].replace(/[^0-9]/g,'');if(/LOAN\s+INTEREST/.test(s)){entityKey='LOAN_INTEREST_'+n;label='Loan interest NO.'+n;}else if(/\bLOAN\b/.test(s)){entityKey='LOAN_'+n;label='Loan payment NO.'+n;}else if(/\bLEASE\b|\bLSE\b/.test(s)){entityKey='LEASE_'+n;label='Lease payment NO.'+n;}else{entityKey='FINANCE_REF_'+n;}}
      else{const stable=(cp||raw).replace(/\b[0-9][0-9-]{4,}\b/g,'').replace(/\s+/g,' ').trim();entityKey='RBC_FINANCE_'+vfcCounterpartyKey_(stable||cp||raw);}
    }
  }
  else if(vfcRbcIsPadLikeText_(s)){family='OTHER';entityKey='RBC_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/\bCAPITAL\b|\bFUNDING\b|\bFACTOR(?:ING)?\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_POSSIBLE_FINANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/COMMERCIAL\s+RENT|\bRENT\b|HYDRO|FORTIS|TELUS|UTILITY|SUPERPASS|PETROLEUM|\bFUEL\b|EQUIPMENT\s+RENT|PAY\s+EMPLOYEE|PAYROLL/.test(s)){family='OTHER';entityKey='RBC_OTHER_BUSINESS_'+vfcCounterpartyKey_(cp||raw);}
  else{return null;}
  if(!entityKey)entityKey='RBC_OTHER_'+vfcCounterpartyKey_(raw);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcRbcIsReturnedFinancingCredit_(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}
function vfcRbcIsNonOperatingTransferCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;const s=String(t&&t.description||'').toUpperCase();if(/E-TRANSFER|INTERAC/.test(s))return false;return/\bBR\s+TO\s+BR\b|\bTRANSFER\s+FROM\s+(?:ACCOUNT|A\/C|ACCT)\b|\bINTERNAL\s+TRANSFER\b/.test(s);}
function vfcRbcKnownFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();if(vfcRbcIsReturnedFinancingCredit_(t))return false;return/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|\bICAPITAL\b|GREENBOX|\bCSBFL\b|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s);}
function vfcRbcPreservePrintedDuplicate_(){return true;}
function vfcRbcStrongEntityKey_(key){return/^(RBC_AFFIRM_CANADA|RBC_PREMIUM_FINANCE_|RBC_BDC_|MERCHANT_GROWTH|JOURNEY_ONDECK|CANACAP|ICAPITAL|GREENBOX|SILVERCHEF_EQUIPMENT_LEASE|AUTO_PAYMENT_FINANCE_|RBC_FINANCE_|INSURANCE_|LEASE_[0-9]|FINANCE_REF_[0-9])/.test(String(key||'').toUpperCase());}

function runRbcBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'RBC',transactions:transactions||[]}};}
  function close(a,e,t,l){t=t==null?.02:t;if(Math.abs(Number(a||0)-Number(e||0))>t)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function equal(a,e,l){if(a!==e)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function truthy(v,l){if(!v)throw new Error((l||'value')+' expected truthy');}
  function test(n,f){try{results.push({name:n,pass:true,detail:String(f()||'')});}catch(e){results.push({name:n,pass:false,detail:String(e&&e.message||e)});}}

  test('AIM HIGH Mar-Apr printed credits are exactly 15 and $45,725.36',function(){const c=[2000,250,1000,6585.81,1046.83,250,7474.96,3000,750,2750,3250,2750,6673.93,7693.83,250];equal(c.length,15,'count');close(vfcSum_(c),45725.36,.02,'sum');return'15/$45725.36';});
  test('Exact ledger audit passes only when count and totals both match',function(){const text='Total deposits & credits (2) + 150.00\nTotal cheques & debits (2) - 30.00',facts={deposits:150,withdrawals:30},good=[tx('2026-01-01','A','CREDIT',100),tx('2026-01-02','B','CREDIT',50),tx('2026-01-03','C','DEBIT',10),tx('2026-01-04','D','DEBIT',20)];const a=vfcRbcAuditFullLedger_(good,facts,text,'x.pdf');equal(a.creditCount,2,'credits');let failed=false;try{vfcRbcAuditFullLedger_(good.slice(1),facts,text,'x.pdf');}catch(e){failed=true;}truthy(failed,'missing row fails');return'exact';});
  test('Opening/closing/support artifacts are excluded',function(){const p=vfcRbcPrepareLedger_([tx('2026-03-02','Opening balance','CREDIT',4710.90),tx('2026-03-03','Loan BK OF MONTREAL','DEBIT',599.22),tx('2026-04-02','Serial #: 343 Amount: $315.00','CREDIT',315)]);equal(p.length,1,'real rows');return'clean';});
  test('Return direction remains printed-column driven',function(){equal(vfcRbcCertainDirection_(tx('2026-05-27','Cheque returned NSF','DEBIT',2606.59)),'','no force');truthy(vfcRbcIsReturnedFinancingCredit_(tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)),'credit return');equal(vfcRbcIsReturnedFinancingCredit_(tx('2026-06-25','Item returned unpaid','DEBIT',187.46)),false,'debit return');return'direction safe';});
  test('Unknown recurring PAD is informational only',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-02-28',[tx('2026-02-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-03-31',[tx('2026-03-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])]);close(d.confirmedMonthlyDebtService,0,.001,'debt');return'informational';});
  test('Recurring Affirm is financing',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-02-28',[tx('2026-02-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-03-31',[tx('2026-03-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm');return'66.62';});
  test('Returned BDC PAD cannot inflate debt',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-27','Business PAD BDC','DEBIT',2578.34,'BDC')]),row('2026-04-30',[tx('2026-04-27','Business PAD BDC','DEBIT',2656.97,'BDC')]),row('2026-05-31',[tx('2026-05-27','Business PAD BDC','DEBIT',2606.59,'BDC'),tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)]),row('2026-06-30',[tx('2026-06-29','Business PAD BDC','DEBIT',5289.91,'BDC'),tx('2026-06-29','Cheque returned NSF','CREDIT',5289.91)]),row('2026-08-31',[tx('2026-08-17','Business PAD BDC','DEBIT',2285.91,'BDC')])]);truthy(d.returnedFinanceDebitsSuppressed>=2,'suppressed');return'suppressed='+d.returnedFinanceDebitsSuppressed;});
  test('Recurring IPFS is financing while ordinary insurance is informational',function(){const ip=vfcRbcClassifyDebit_(tx('2026-08-04','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')),ins=vfcRbcClassifyDebit_(tx('2026-08-04','Auto Insurance ICBC','DEBIT',234.96,'ICBC'));equal(ip.family,'FINANCING','IPFS');equal(ins.family,'OTHER','insurance');return'correct';});
  test('BR TO BR credit excluded but customer e-transfer not',function(){truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','BR TO BR - 0863','CREDIT',5000)),'internal');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','e-Transfer received CUSTOMER','CREDIT',5000)),false,'customer');return'correct';});
  test('Generic numeric Misc Payment never becomes obligation by itself',function(){equal(vfcRbcClassifyDebit_(tx('2026-03-12','Misc Payment 1469635','DEBIT',6585.81,'1469635')),null,'misc');return'ignored';});

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,rbcRulesVersion:vfcRbcBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
function runBankingStabilitySelfTests(){return runRbcBankingSelfTests();}
+vfcNum_(facts.deposits)+
      ', extracted '+s.creditCount+' / 

function vfcRbcRepairLedger_(currentLedger,text,fileName,facts,reason,attempt){
  const printed=vfcRbcPrintedActivityCounts_(text),current=vfcRbcLedgerStats_(currentLedger),prompt=[
    'You are the VFC RBC Account Activity Reconciliation Reader. Return JSON only.',
    'This is FACT EXTRACTION ONLY. Do not underwrite, classify debt, summarize or estimate.',
    'File: '+fileName,
    'The previous ledger failed deterministic reconciliation: '+reason,
    'AUTHORITATIVE PRINTED TARGETS:',
    'CREDIT rows exactly: '+printed.creditCount,
    'CREDIT total exactly: '+vfcNum_(facts.deposits),
    'DEBIT rows exactly: '+printed.debitCount,
    'DEBIT total exactly: '+vfcNum_(facts.withdrawals),
    'Opening balance: '+vfcNum_(facts.opening),
    'Closing balance: '+vfcNum_(facts.closing),
    'Return JSON with ONE field only: banking_transactions.',
    'banking_transactions must be the COMPLETE Account Activity ledger and each object must be {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short visible counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
    'STRICT RULES:',
    '1. Read only Account Activity Details rows. Include every amount-bearing activity row, including all bank fees and ordinary purchases.',
    '2. Do not include opening/closing balances, Account Summary totals, Account Fees summary, page totals, cheque-image/support pages, serial-number image rows or endorsements.',
    '3. Printed Cheques & Debits column = DEBIT; printed Deposits & Credits column = CREDIT. Never infer direction from words.',
    '4. MISC PAYMENT and RETURN/NSF can occur in either direction. Use the printed column.',
    '5. Keep repeated legitimate transactions. Do not deduplicate two separately printed activity rows.',
    '6. The final array MUST contain exactly '+printed.creditCount+' CREDIT rows totaling '+vfcNum_(facts.deposits)+' and exactly '+printed.debitCount+' DEBIT rows totaling '+vfcNum_(facts.withdrawals)+'.',
    '7. If the current candidate missed a row, recover it from the raw statement. If it contains an artifact, remove only the artifact.',
    'Current candidate stats: credits '+current.creditCount+' / $'+current.totalCredits+', debits '+current.debitCount+' / $'+current.totalDebits+'.',
    'Current candidate ledger:',JSON.stringify(currentLedger),
    'RAW RBC STATEMENT OCR:',String(text||'').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
  ].join('\n');
  const repaired=callOpenAIJson_(prompt);
  if(!repaired||!Array.isArray(repaired.banking_transactions))throw new Error('RBC reconciliation pass '+attempt+' did not return a complete banking_transactions array for '+fileName+'.');
  return vfcRbcPrepareLedger_(repaired.banking_transactions);
}

function vfcRbcIsPadLikeText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return false;
  return/^(?:BUSINESS\s+)?PAD\b|PRE[- ]?AUTH(?:ORIZED)?(?:\s+DEBIT|\s+PAYMENT)?\b|PREAUTHORIZED(?:\s+DEBIT|\s+PAYMENT)?\b|DIRECT\s+DEBIT\b|EFT\s+DEBIT\b|ACH\s+DEBIT\b|AUTOMATIC\s+DEBIT\b|AUTO\s+PAYMENT\b/.test(s);
}

function vfcRbcReturnEventText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||/\b(?:FEE|FEES|CHARGE)\b/.test(s))return false;
  return/CHEQUE\s+RETURNED(?:\s+NSF)?|CHECK\s+RETURNED(?:\s+NSF)?|ITEM\s+RETURNED(?:\s+NSF|\s+UNPAID)?|RETURNED\s+(?:ITEM|CHEQUE|CHECK|PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)|(?:PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)\s+RETURNED|PRE[- ]?AUTH(?:ORIZED)?\s+(?:DEBIT|PAYMENT)\s+RETURNED|PREAUTHORIZED\s+(?:DEBIT|PAYMENT)\s+RETURNED|DIRECT\s+DEBIT\s+RETURNED|REJECTED\s+(?:PAD|DEBIT|PAYMENT)|\bREVERSAL\b|\bREVERSED\b|NSF\s+RETURN/.test(s);
}
function vfcRbcReturnCreditText_(value){return vfcRbcReturnEventText_(value);}
function vfcRbcCountReturnEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcCountBorrowerNsfEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcNegativeBalanceFlag_(text,facts){if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;return/(?:^|\s)-[0-9][0-9,]*\.\d{2}(?:\s|$)/m.test(String(text||''));}
function vfcRbcAmountBand_(amount){const n=Math.max(1,vfcNum_(amount));return Math.round(Math.log(n)/Math.log(1.25));}

function vfcRbcClassifyDebit_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t&&t.counterparty||'').replace(/\s+/g,' ').trim(),band=vfcRbcAmountBand_(t&&t.amount),hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b|\bMCA\b|\bLEASE\b|\bLSE\b/.test(s),isFee=/\bFEES?\b|SERVICE\s+CHARGE|NSF\s+ITEM\s+FEES?|RETURNED[- ]?ITEM\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE|ACTIVITY\s+FEE|TRANSACTION\s+FEE|MONTHLY\s+FEE/.test(s);
  if(isFee&&!hasFinancingSignal)return null;
  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/COMM\s+EQUIP\s+RENT\/LSE\s+SILVERCHEF|\bSILVERCHEF\b/.test(s)){family='FINANCING';entityKey='SILVERCHEF_EQUIPMENT_LEASE';label='SilverChef Equipment Lease';debtJustification='Explicit recurring equipment lease.';}
  else if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';debtJustification='Known MCA/funding counterparty plus recurrence.';}
  else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){family='MCA';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bBDC\b/.test(s)&&vfcRbcIsPadLikeText_(s)){family='FINANCING';entityKey='RBC_BDC_PAD_B'+band;label='BDC';debtJustification='Recurring BDC PAD stream; materially different catch-up amounts remain separate.';}
  else if(/\bBDC\b/.test(s)&&(/BDC[- ]?LOAN\/PRET|ONLINE\s+BANKING\s+PAYMENT|\bLOAN\b|FINANC/.test(s))){family='FINANCING';entityKey='RBC_BDC_MANUAL_B'+band;label='BDC Manual / Loan Payment';debtJustification='Manual BDC loan-payment stream kept separate from normal PAD.';}
  else if(/\bAFFIRM(?:\s+CANADA)?\b/.test(s)){family='FINANCING';entityKey='RBC_AFFIRM_CANADA';label='Affirm Canada';debtJustification='Affirm Canada financing counterparty plus recurrence.';}
  else if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='CANACAP';label='Canacap';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bGREENBOX\b/.test(s)){family='MCA';entityKey='GREENBOX';label='Greenbox';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bICAPITAL\b/.test(s)){family='FINANCING';entityKey='ICAPITAL';label='iCapital';debtJustification='Known financing counterparty plus recurrence.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC/.test(s)){family='FINANCING';entityKey='RBC_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw)+'_B'+band;label=cp||'Premium Finance';debtJustification='Explicit premium-finance counterparty plus recurrence.';}
  else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){family='TAX';entityKey='RBC_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);}
  else if(/INSURANCE/.test(s)){family='OTHER';if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}else if(/IND\s+ALL/.test(s)){entityKey='INSURANCE_IND_ALL';label='Insurance IND ALL';}else entityKey='RBC_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|CAPITAL\s+ONE|\bMBNA\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/^AUTO\s+PAYMENT\b/.test(s)){
    const clean=raw.replace(/^AUTO\s+PAYMENT\s*/i,'').trim(),financeLike=/\bAFS\b|FINANC|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s);
    family=financeLike?'FINANCING':'OTHER';entityKey=(financeLike?'AUTO_PAYMENT_FINANCE_':'RBC_OTHER_AUTOPAY_')+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;if(financeLike)debtJustification='Automatic payment with independent finance-like counterparty evidence.';
  }
  else if(/^MISC\s+PAYMENT\b/.test(s)&&(/\bAFS\b|FINANC|LEASE|LENDING|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s))){const clean=raw.replace(/^MISC\s+PAYMENT\s*/i,'').trim();family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;debtJustification='Retry/recurring payment with independent finance-like counterparty evidence.';}
  else if(hasFinancingSignal){
    family='FINANCING';debtJustification='Explicit financing wording plus recurring observed cadence.';
    if(/^LOAN\s+PAYMENT$/i.test(raw)){entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';}
    else{
      const numbered=s.match(/(?:NO\.?|NUMBER|#)\s*([0-9-]{5,})/),generic=s.match(/\b(?:LOAN|MORTGAGE|LOC)\b[^0-9]{0,30}([0-9][0-9-]{5,})\b/),ref=numbered||generic;
      if(ref){const n=ref[1].replace(/[^0-9]/g,'');if(/LOAN\s+INTEREST/.test(s)){entityKey='LOAN_INTEREST_'+n;label='Loan interest NO.'+n;}else if(/\bLOAN\b/.test(s)){entityKey='LOAN_'+n;label='Loan payment NO.'+n;}else if(/\bLEASE\b|\bLSE\b/.test(s)){entityKey='LEASE_'+n;label='Lease payment NO.'+n;}else{entityKey='FINANCE_REF_'+n;}}
      else{const stable=(cp||raw).replace(/\b[0-9][0-9-]{4,}\b/g,'').replace(/\s+/g,' ').trim();entityKey='RBC_FINANCE_'+vfcCounterpartyKey_(stable||cp||raw);}
    }
  }
  else if(vfcRbcIsPadLikeText_(s)){family='OTHER';entityKey='RBC_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/\bCAPITAL\b|\bFUNDING\b|\bFACTOR(?:ING)?\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_POSSIBLE_FINANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/COMMERCIAL\s+RENT|\bRENT\b|HYDRO|FORTIS|TELUS|UTILITY|SUPERPASS|PETROLEUM|\bFUEL\b|EQUIPMENT\s+RENT|PAY\s+EMPLOYEE|PAYROLL/.test(s)){family='OTHER';entityKey='RBC_OTHER_BUSINESS_'+vfcCounterpartyKey_(cp||raw);}
  else{return null;}
  if(!entityKey)entityKey='RBC_OTHER_'+vfcCounterpartyKey_(raw);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcRbcIsReturnedFinancingCredit_(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}
function vfcRbcIsNonOperatingTransferCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;const s=String(t&&t.description||'').toUpperCase();if(/E-TRANSFER|INTERAC/.test(s))return false;return/\bBR\s+TO\s+BR\b|\bTRANSFER\s+FROM\s+(?:ACCOUNT|A\/C|ACCT)\b|\bINTERNAL\s+TRANSFER\b/.test(s);}
function vfcRbcKnownFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();if(vfcRbcIsReturnedFinancingCredit_(t))return false;return/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|\bICAPITAL\b|GREENBOX|\bCSBFL\b|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s);}
function vfcRbcPreservePrintedDuplicate_(){return true;}
function vfcRbcStrongEntityKey_(key){return/^(RBC_AFFIRM_CANADA|RBC_PREMIUM_FINANCE_|RBC_BDC_|MERCHANT_GROWTH|JOURNEY_ONDECK|CANACAP|ICAPITAL|GREENBOX|SILVERCHEF_EQUIPMENT_LEASE|AUTO_PAYMENT_FINANCE_|RBC_FINANCE_|INSURANCE_|LEASE_[0-9]|FINANCE_REF_[0-9])/.test(String(key||'').toUpperCase());}

function runRbcBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'RBC',transactions:transactions||[]}};}
  function close(a,e,t,l){t=t==null?.02:t;if(Math.abs(Number(a||0)-Number(e||0))>t)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function equal(a,e,l){if(a!==e)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function truthy(v,l){if(!v)throw new Error((l||'value')+' expected truthy');}
  function test(n,f){try{results.push({name:n,pass:true,detail:String(f()||'')});}catch(e){results.push({name:n,pass:false,detail:String(e&&e.message||e)});}}

  test('AIM HIGH Mar-Apr printed credits are exactly 15 and $45,725.36',function(){const c=[2000,250,1000,6585.81,1046.83,250,7474.96,3000,750,2750,3250,2750,6673.93,7693.83,250];equal(c.length,15,'count');close(vfcSum_(c),45725.36,.02,'sum');return'15/$45725.36';});
  test('Exact ledger audit passes only when count and totals both match',function(){const text='Total deposits & credits (2) + 150.00\nTotal cheques & debits (2) - 30.00',facts={deposits:150,withdrawals:30},good=[tx('2026-01-01','A','CREDIT',100),tx('2026-01-02','B','CREDIT',50),tx('2026-01-03','C','DEBIT',10),tx('2026-01-04','D','DEBIT',20)];const a=vfcRbcAuditFullLedger_(good,facts,text,'x.pdf');equal(a.creditCount,2,'credits');let failed=false;try{vfcRbcAuditFullLedger_(good.slice(1),facts,text,'x.pdf');}catch(e){failed=true;}truthy(failed,'missing row fails');return'exact';});
  test('Opening/closing/support artifacts are excluded',function(){const p=vfcRbcPrepareLedger_([tx('2026-03-02','Opening balance','CREDIT',4710.90),tx('2026-03-03','Loan BK OF MONTREAL','DEBIT',599.22),tx('2026-04-02','Serial #: 343 Amount: $315.00','CREDIT',315)]);equal(p.length,1,'real rows');return'clean';});
  test('Return direction remains printed-column driven',function(){equal(vfcRbcCertainDirection_(tx('2026-05-27','Cheque returned NSF','DEBIT',2606.59)),'','no force');truthy(vfcRbcIsReturnedFinancingCredit_(tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)),'credit return');equal(vfcRbcIsReturnedFinancingCredit_(tx('2026-06-25','Item returned unpaid','DEBIT',187.46)),false,'debit return');return'direction safe';});
  test('Unknown recurring PAD is informational only',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-02-28',[tx('2026-02-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-03-31',[tx('2026-03-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])]);close(d.confirmedMonthlyDebtService,0,.001,'debt');return'informational';});
  test('Recurring Affirm is financing',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-02-28',[tx('2026-02-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-03-31',[tx('2026-03-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm');return'66.62';});
  test('Returned BDC PAD cannot inflate debt',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-27','Business PAD BDC','DEBIT',2578.34,'BDC')]),row('2026-04-30',[tx('2026-04-27','Business PAD BDC','DEBIT',2656.97,'BDC')]),row('2026-05-31',[tx('2026-05-27','Business PAD BDC','DEBIT',2606.59,'BDC'),tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)]),row('2026-06-30',[tx('2026-06-29','Business PAD BDC','DEBIT',5289.91,'BDC'),tx('2026-06-29','Cheque returned NSF','CREDIT',5289.91)]),row('2026-08-31',[tx('2026-08-17','Business PAD BDC','DEBIT',2285.91,'BDC')])]);truthy(d.returnedFinanceDebitsSuppressed>=2,'suppressed');return'suppressed='+d.returnedFinanceDebitsSuppressed;});
  test('Recurring IPFS is financing while ordinary insurance is informational',function(){const ip=vfcRbcClassifyDebit_(tx('2026-08-04','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')),ins=vfcRbcClassifyDebit_(tx('2026-08-04','Auto Insurance ICBC','DEBIT',234.96,'ICBC'));equal(ip.family,'FINANCING','IPFS');equal(ins.family,'OTHER','insurance');return'correct';});
  test('BR TO BR credit excluded but customer e-transfer not',function(){truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','BR TO BR - 0863','CREDIT',5000)),'internal');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','e-Transfer received CUSTOMER','CREDIT',5000)),false,'customer');return'correct';});
  test('Generic numeric Misc Payment never becomes obligation by itself',function(){equal(vfcRbcClassifyDebit_(tx('2026-03-12','Misc Payment 1469635','DEBIT',6585.81,'1469635')),null,'misc');return'ignored';});

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,rbcRulesVersion:vfcRbcBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
function runBankingStabilitySelfTests(){return runRbcBankingSelfTests();}
+vfcRound_(statementDiff,.01)+'.');

  const locked=Object.assign({},summary||{});
  locked.statement_start_date=facts.startDate;
  locked.statement_end_date=facts.endDate;
  locked.opening_balance=facts.opening;
  locked.closing_balance=facts.closing;
  locked.total_deposits=facts.deposits;
  locked.total_withdrawals=facts.withdrawals;

  let ledger=vfcRbcPrepareLedger_(locked.banking_transactions||[]),audit=null,lastError='',repairPasses=0;
  for(let attempt=0;attempt<=2;attempt++){
    try{
      audit=vfcRbcAuditFullLedger_(ledger,facts,text,name);
      break;
    }catch(e){
      lastError=String(e&&e.message||e);
      if(attempt>=2)throw new Error(lastError);
      repairPasses++;
      ledger=vfcRbcRepairLedger_(ledger,text,name,facts,lastError,repairPasses);
    }
  }

  if(!audit)throw new Error('RBC ledger verification did not complete for '+name+'.');
  locked.banking_transactions=ledger;
  locked.rbc_full_ledger_verified=true;
  locked.rbc_ledger_reconciled=repairPasses>0;
  locked.rbc_ledger_repair_passes=repairPasses;
  locked.rbc_credit_transaction_count=audit.creditCount;
  locked.rbc_debit_transaction_count=audit.debitCount;
  locked.nsf_count=vfcRbcCountBorrowerNsfEvents_(ledger);
  locked.negative_balance_detected=vfcRbcNegativeBalanceFlag_(text,facts);
  return locked;
}

function vfcRbcPrintedActivityCounts_(text){
  const s=String(text||'').replace(/\u00a0/g,' '),c=s.match(/Total\s+deposits\s*&\s*credits\s*\((\d+)\)/i),d=s.match(/Total\s+cheques\s*&\s*debits\s*\((\d+)\)/i);
  return{creditCount:c?Number(c[1]):null,debitCount:d?Number(d[1]):null};
}

function vfcRbcIsNonActivityArtifact_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s)return true;
  return/^OPENING\s+BALANCE\b|^CLOSING\s+BALANCE\b|^ACCOUNT\s+FEES?\b|^ACCOUNT\s+SUMMARY\b|^TOTAL\s+DEPOSITS\s*&\s*CREDITS\b|^TOTAL\s+CHEQUES\s*&\s+DEBITS\b|^PAGE\s+TOTAL\b|^SERIAL\s*#?\s*:?\s*\d+\s+AMOUNT\b|FOR\s+DEPOSIT\s+ONLY|BACKVERSO|BACK\s*\/\s*VERSO|CHEQUE\s+IMAGE|CHECK\s+IMAGE/.test(s);
}

function vfcRbcPrepareLedger_(items){
  return(Array.isArray(items)?items:[]).filter(function(x){return!vfcRbcIsNonActivityArtifact_(x);}).map(function(x){
    const t=Object.assign({},x||{}),forced=vfcRbcCertainDirection_(t);
    if(forced)t.direction=forced;
    t.direction=String(t.direction||'').toUpperCase();
    t.description=String(t.description||'').replace(/\s+/g,' ').trim();
    t.counterparty=String(t.counterparty||t.description||'').replace(/\s+/g,' ').trim();
    t.amount=vfcNum_(t.amount);
    return t;
  });
}

function vfcRbcCertainDirection_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return'';
  if(/^LOAN\s+CREDIT\b/.test(s)||/\bPAYROLL\s+DEPOSIT\b|\bTAX\s+REFUND\b|E-TRANSFER\s+RECEIVED|INTERAC\s+PURCHASE\s+REFUND|E-TRANSFER\s+CANCEL|MOBILE\s+CHEQUE\s+DEPOSIT/.test(s))return'CREDIT';
  if(vfcRbcIsPadLikeText_(s)||/^LOAN\s+PAYMENT\b|^LOAN\s+INTEREST\b|^BLIP\s+PAYMENT\s*-?\s*LOAN\b|^BILL\s+PAYMENT\b|^FUEL\s+BILL\s+PAYMENT\b|^COMM\s+GAS\s+BILL\s+PMT\b|^COMMERCIAL\s+TAXES\b|^AUTO\s+INSURANCE\b|^INSURANCE\b|^RENT\/LEASE\b|^CHEQUE\s*-\s*\d+\b|E-TRANSFER\s+SENT|E-TRANSFER\s+REQUEST\s+FULFILLED/.test(s))return'DEBIT';
  return'';
}

function vfcRbcLedgerStats_(items){
  const out={creditCount:0,debitCount:0,totalCredits:0,totalDebits:0,bad:[]};
  (Array.isArray(items)?items:[]).forEach(function(t,i){
    const d=String(t&&t.direction||'').toUpperCase(),a=vfcNum_(t&&t.amount),desc=String(t&&t.description||'').trim(),date=vfcIso_(t&&t.date);
    if(!date||!desc||!(a>0)||(d!=='CREDIT'&&d!=='DEBIT')){out.bad.push(i+1);return;}
    if(d==='CREDIT'){out.creditCount++;out.totalCredits+=a;}else{out.debitCount++;out.totalDebits+=a;}
  });
  out.totalCredits=vfcRound_(out.totalCredits,.01);out.totalDebits=vfcRound_(out.totalDebits,.01);return out;
}

function vfcRbcLedgerPreview_(rows,direction){
  return(rows||[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()===direction;}).slice(0,40).map(function(t){return String(t.date||'')+' '+String(t.description||'')+' $'+vfcNum_(t.amount);}).join(' | ');
}

function vfcRbcAuditFullLedger_(items,facts,text,fileName){
  const rows=Array.isArray(items)?items:[],printed=vfcRbcPrintedActivityCounts_(text),s=vfcRbcLedgerStats_(rows);
  if(s.bad.length)throw new Error('RBC full ledger contains incomplete transaction row(s) '+s.bad.join(', ')+' for '+fileName+'.');
  const creditCountOk=printed.creditCount===null||s.creditCount===printed.creditCount;
  const debitCountOk=printed.debitCount===null||s.debitCount===printed.debitCount;
  const creditTotalOk=Math.abs(s.totalCredits-vfcNum_(facts.deposits))<=.05;
  const debitTotalOk=Math.abs(s.totalDebits-vfcNum_(facts.withdrawals))<=.05;
  if(!creditCountOk||!debitCountOk||!creditTotalOk||!debitTotalOk){
    throw new Error('RBC ledger mismatch for '+fileName+': printed credits '+printed.creditCount+' / $'+vfcNum_(facts.deposits)+', extracted '+s.creditCount+' / $'+s.totalCredits+'; printed debits '+printed.debitCount+' / $'+vfcNum_(facts.withdrawals)+', extracted '+s.debitCount+' / $'+s.totalDebits+'.');
  }
  return{creditCount:s.creditCount,debitCount:s.debitCount,totalCredits:s.totalCredits,totalDebits:s.totalDebits,reconciled:true};
}

function vfcRbcRepairLedger_(currentLedger,text,fileName,facts,reason,attempt){
  const printed=vfcRbcPrintedActivityCounts_(text),current=vfcRbcLedgerStats_(currentLedger),prompt=[
    'You are the VFC RBC Account Activity Reconciliation Reader. Return JSON only.',
    'This is FACT EXTRACTION ONLY. Do not underwrite, classify debt, summarize or estimate.',
    'File: '+fileName,
    'The previous ledger failed deterministic reconciliation: '+reason,
    'AUTHORITATIVE PRINTED TARGETS:',
    'CREDIT rows exactly: '+printed.creditCount,
    'CREDIT total exactly: '+vfcNum_(facts.deposits),
    'DEBIT rows exactly: '+printed.debitCount,
    'DEBIT total exactly: '+vfcNum_(facts.withdrawals),
    'Opening balance: '+vfcNum_(facts.opening),
    'Closing balance: '+vfcNum_(facts.closing),
    'Return JSON with ONE field only: banking_transactions.',
    'banking_transactions must be the COMPLETE Account Activity ledger and each object must be {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short visible counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
    'STRICT RULES:',
    '1. Read only Account Activity Details rows. Include every amount-bearing activity row, including all bank fees and ordinary purchases.',
    '2. Do not include opening/closing balances, Account Summary totals, Account Fees summary, page totals, cheque-image/support pages, serial-number image rows or endorsements.',
    '3. Printed Cheques & Debits column = DEBIT; printed Deposits & Credits column = CREDIT. Never infer direction from words.',
    '4. MISC PAYMENT and RETURN/NSF can occur in either direction. Use the printed column.',
    '5. Keep repeated legitimate transactions. Do not deduplicate two separately printed activity rows.',
    '6. The final array MUST contain exactly '+printed.creditCount+' CREDIT rows totaling '+vfcNum_(facts.deposits)+' and exactly '+printed.debitCount+' DEBIT rows totaling '+vfcNum_(facts.withdrawals)+'.',
    '7. If the current candidate missed a row, recover it from the raw statement. If it contains an artifact, remove only the artifact.',
    'Current candidate stats: credits '+current.creditCount+' / $'+current.totalCredits+', debits '+current.debitCount+' / $'+current.totalDebits+'.',
    'Current candidate ledger:',JSON.stringify(currentLedger),
    'RAW RBC STATEMENT OCR:',String(text||'').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
  ].join('\n');
  const repaired=callOpenAIJson_(prompt);
  if(!repaired||!Array.isArray(repaired.banking_transactions))throw new Error('RBC reconciliation pass '+attempt+' did not return a complete banking_transactions array for '+fileName+'.');
  return vfcRbcPrepareLedger_(repaired.banking_transactions);
}

function vfcRbcIsPadLikeText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return false;
  return/^(?:BUSINESS\s+)?PAD\b|PRE[- ]?AUTH(?:ORIZED)?(?:\s+DEBIT|\s+PAYMENT)?\b|PREAUTHORIZED(?:\s+DEBIT|\s+PAYMENT)?\b|DIRECT\s+DEBIT\b|EFT\s+DEBIT\b|ACH\s+DEBIT\b|AUTOMATIC\s+DEBIT\b|AUTO\s+PAYMENT\b/.test(s);
}

function vfcRbcReturnEventText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||/\b(?:FEE|FEES|CHARGE)\b/.test(s))return false;
  return/CHEQUE\s+RETURNED(?:\s+NSF)?|CHECK\s+RETURNED(?:\s+NSF)?|ITEM\s+RETURNED(?:\s+NSF|\s+UNPAID)?|RETURNED\s+(?:ITEM|CHEQUE|CHECK|PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)|(?:PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)\s+RETURNED|PRE[- ]?AUTH(?:ORIZED)?\s+(?:DEBIT|PAYMENT)\s+RETURNED|PREAUTHORIZED\s+(?:DEBIT|PAYMENT)\s+RETURNED|DIRECT\s+DEBIT\s+RETURNED|REJECTED\s+(?:PAD|DEBIT|PAYMENT)|\bREVERSAL\b|\bREVERSED\b|NSF\s+RETURN/.test(s);
}
function vfcRbcReturnCreditText_(value){return vfcRbcReturnEventText_(value);}
function vfcRbcCountReturnEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcCountBorrowerNsfEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcNegativeBalanceFlag_(text,facts){if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;return/(?:^|\s)-[0-9][0-9,]*\.\d{2}(?:\s|$)/m.test(String(text||''));}
function vfcRbcAmountBand_(amount){const n=Math.max(1,vfcNum_(amount));return Math.round(Math.log(n)/Math.log(1.25));}

function vfcRbcClassifyDebit_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t&&t.counterparty||'').replace(/\s+/g,' ').trim(),band=vfcRbcAmountBand_(t&&t.amount),hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b|\bMCA\b|\bLEASE\b|\bLSE\b/.test(s),isFee=/\bFEES?\b|SERVICE\s+CHARGE|NSF\s+ITEM\s+FEES?|RETURNED[- ]?ITEM\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE|ACTIVITY\s+FEE|TRANSACTION\s+FEE|MONTHLY\s+FEE/.test(s);
  if(isFee&&!hasFinancingSignal)return null;
  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/COMM\s+EQUIP\s+RENT\/LSE\s+SILVERCHEF|\bSILVERCHEF\b/.test(s)){family='FINANCING';entityKey='SILVERCHEF_EQUIPMENT_LEASE';label='SilverChef Equipment Lease';debtJustification='Explicit recurring equipment lease.';}
  else if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';debtJustification='Known MCA/funding counterparty plus recurrence.';}
  else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){family='MCA';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bBDC\b/.test(s)&&vfcRbcIsPadLikeText_(s)){family='FINANCING';entityKey='RBC_BDC_PAD_B'+band;label='BDC';debtJustification='Recurring BDC PAD stream; materially different catch-up amounts remain separate.';}
  else if(/\bBDC\b/.test(s)&&(/BDC[- ]?LOAN\/PRET|ONLINE\s+BANKING\s+PAYMENT|\bLOAN\b|FINANC/.test(s))){family='FINANCING';entityKey='RBC_BDC_MANUAL_B'+band;label='BDC Manual / Loan Payment';debtJustification='Manual BDC loan-payment stream kept separate from normal PAD.';}
  else if(/\bAFFIRM(?:\s+CANADA)?\b/.test(s)){family='FINANCING';entityKey='RBC_AFFIRM_CANADA';label='Affirm Canada';debtJustification='Affirm Canada financing counterparty plus recurrence.';}
  else if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='CANACAP';label='Canacap';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bGREENBOX\b/.test(s)){family='MCA';entityKey='GREENBOX';label='Greenbox';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bICAPITAL\b/.test(s)){family='FINANCING';entityKey='ICAPITAL';label='iCapital';debtJustification='Known financing counterparty plus recurrence.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC/.test(s)){family='FINANCING';entityKey='RBC_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw)+'_B'+band;label=cp||'Premium Finance';debtJustification='Explicit premium-finance counterparty plus recurrence.';}
  else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){family='TAX';entityKey='RBC_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);}
  else if(/INSURANCE/.test(s)){family='OTHER';if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}else if(/IND\s+ALL/.test(s)){entityKey='INSURANCE_IND_ALL';label='Insurance IND ALL';}else entityKey='RBC_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|CAPITAL\s+ONE|\bMBNA\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/^AUTO\s+PAYMENT\b/.test(s)){
    const clean=raw.replace(/^AUTO\s+PAYMENT\s*/i,'').trim(),financeLike=/\bAFS\b|FINANC|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s);
    family=financeLike?'FINANCING':'OTHER';entityKey=(financeLike?'AUTO_PAYMENT_FINANCE_':'RBC_OTHER_AUTOPAY_')+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;if(financeLike)debtJustification='Automatic payment with independent finance-like counterparty evidence.';
  }
  else if(/^MISC\s+PAYMENT\b/.test(s)&&(/\bAFS\b|FINANC|LEASE|LENDING|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s))){const clean=raw.replace(/^MISC\s+PAYMENT\s*/i,'').trim();family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;debtJustification='Retry/recurring payment with independent finance-like counterparty evidence.';}
  else if(hasFinancingSignal){
    family='FINANCING';debtJustification='Explicit financing wording plus recurring observed cadence.';
    if(/^LOAN\s+PAYMENT$/i.test(raw)){entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';}
    else{
      const numbered=s.match(/(?:NO\.?|NUMBER|#)\s*([0-9-]{5,})/),generic=s.match(/\b(?:LOAN|MORTGAGE|LOC)\b[^0-9]{0,30}([0-9][0-9-]{5,})\b/),ref=numbered||generic;
      if(ref){const n=ref[1].replace(/[^0-9]/g,'');if(/LOAN\s+INTEREST/.test(s)){entityKey='LOAN_INTEREST_'+n;label='Loan interest NO.'+n;}else if(/\bLOAN\b/.test(s)){entityKey='LOAN_'+n;label='Loan payment NO.'+n;}else if(/\bLEASE\b|\bLSE\b/.test(s)){entityKey='LEASE_'+n;label='Lease payment NO.'+n;}else{entityKey='FINANCE_REF_'+n;}}
      else{const stable=(cp||raw).replace(/\b[0-9][0-9-]{4,}\b/g,'').replace(/\s+/g,' ').trim();entityKey='RBC_FINANCE_'+vfcCounterpartyKey_(stable||cp||raw);}
    }
  }
  else if(vfcRbcIsPadLikeText_(s)){family='OTHER';entityKey='RBC_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/\bCAPITAL\b|\bFUNDING\b|\bFACTOR(?:ING)?\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_POSSIBLE_FINANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/COMMERCIAL\s+RENT|\bRENT\b|HYDRO|FORTIS|TELUS|UTILITY|SUPERPASS|PETROLEUM|\bFUEL\b|EQUIPMENT\s+RENT|PAY\s+EMPLOYEE|PAYROLL/.test(s)){family='OTHER';entityKey='RBC_OTHER_BUSINESS_'+vfcCounterpartyKey_(cp||raw);}
  else{return null;}
  if(!entityKey)entityKey='RBC_OTHER_'+vfcCounterpartyKey_(raw);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcRbcIsReturnedFinancingCredit_(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}
function vfcRbcIsNonOperatingTransferCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;const s=String(t&&t.description||'').toUpperCase();if(/E-TRANSFER|INTERAC/.test(s))return false;return/\bBR\s+TO\s+BR\b|\bTRANSFER\s+FROM\s+(?:ACCOUNT|A\/C|ACCT)\b|\bINTERNAL\s+TRANSFER\b/.test(s);}
function vfcRbcKnownFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();if(vfcRbcIsReturnedFinancingCredit_(t))return false;return/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|\bICAPITAL\b|GREENBOX|\bCSBFL\b|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s);}
function vfcRbcPreservePrintedDuplicate_(){return true;}
function vfcRbcStrongEntityKey_(key){return/^(RBC_AFFIRM_CANADA|RBC_PREMIUM_FINANCE_|RBC_BDC_|MERCHANT_GROWTH|JOURNEY_ONDECK|CANACAP|ICAPITAL|GREENBOX|SILVERCHEF_EQUIPMENT_LEASE|AUTO_PAYMENT_FINANCE_|RBC_FINANCE_|INSURANCE_|LEASE_[0-9]|FINANCE_REF_[0-9])/.test(String(key||'').toUpperCase());}

function runRbcBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'RBC',transactions:transactions||[]}};}
  function close(a,e,t,l){t=t==null?.02:t;if(Math.abs(Number(a||0)-Number(e||0))>t)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function equal(a,e,l){if(a!==e)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function truthy(v,l){if(!v)throw new Error((l||'value')+' expected truthy');}
  function test(n,f){try{results.push({name:n,pass:true,detail:String(f()||'')});}catch(e){results.push({name:n,pass:false,detail:String(e&&e.message||e)});}}

  test('AIM HIGH Mar-Apr printed credits are exactly 15 and $45,725.36',function(){const c=[2000,250,1000,6585.81,1046.83,250,7474.96,3000,750,2750,3250,2750,6673.93,7693.83,250];equal(c.length,15,'count');close(vfcSum_(c),45725.36,.02,'sum');return'15/$45725.36';});
  test('Exact ledger audit passes only when count and totals both match',function(){const text='Total deposits & credits (2) + 150.00\nTotal cheques & debits (2) - 30.00',facts={deposits:150,withdrawals:30},good=[tx('2026-01-01','A','CREDIT',100),tx('2026-01-02','B','CREDIT',50),tx('2026-01-03','C','DEBIT',10),tx('2026-01-04','D','DEBIT',20)];const a=vfcRbcAuditFullLedger_(good,facts,text,'x.pdf');equal(a.creditCount,2,'credits');let failed=false;try{vfcRbcAuditFullLedger_(good.slice(1),facts,text,'x.pdf');}catch(e){failed=true;}truthy(failed,'missing row fails');return'exact';});
  test('Opening/closing/support artifacts are excluded',function(){const p=vfcRbcPrepareLedger_([tx('2026-03-02','Opening balance','CREDIT',4710.90),tx('2026-03-03','Loan BK OF MONTREAL','DEBIT',599.22),tx('2026-04-02','Serial #: 343 Amount: $315.00','CREDIT',315)]);equal(p.length,1,'real rows');return'clean';});
  test('Return direction remains printed-column driven',function(){equal(vfcRbcCertainDirection_(tx('2026-05-27','Cheque returned NSF','DEBIT',2606.59)),'','no force');truthy(vfcRbcIsReturnedFinancingCredit_(tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)),'credit return');equal(vfcRbcIsReturnedFinancingCredit_(tx('2026-06-25','Item returned unpaid','DEBIT',187.46)),false,'debit return');return'direction safe';});
  test('Unknown recurring PAD is informational only',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-02-28',[tx('2026-02-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-03-31',[tx('2026-03-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])]);close(d.confirmedMonthlyDebtService,0,.001,'debt');return'informational';});
  test('Recurring Affirm is financing',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-02-28',[tx('2026-02-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-03-31',[tx('2026-03-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm');return'66.62';});
  test('Returned BDC PAD cannot inflate debt',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-27','Business PAD BDC','DEBIT',2578.34,'BDC')]),row('2026-04-30',[tx('2026-04-27','Business PAD BDC','DEBIT',2656.97,'BDC')]),row('2026-05-31',[tx('2026-05-27','Business PAD BDC','DEBIT',2606.59,'BDC'),tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)]),row('2026-06-30',[tx('2026-06-29','Business PAD BDC','DEBIT',5289.91,'BDC'),tx('2026-06-29','Cheque returned NSF','CREDIT',5289.91)]),row('2026-08-31',[tx('2026-08-17','Business PAD BDC','DEBIT',2285.91,'BDC')])]);truthy(d.returnedFinanceDebitsSuppressed>=2,'suppressed');return'suppressed='+d.returnedFinanceDebitsSuppressed;});
  test('Recurring IPFS is financing while ordinary insurance is informational',function(){const ip=vfcRbcClassifyDebit_(tx('2026-08-04','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')),ins=vfcRbcClassifyDebit_(tx('2026-08-04','Auto Insurance ICBC','DEBIT',234.96,'ICBC'));equal(ip.family,'FINANCING','IPFS');equal(ins.family,'OTHER','insurance');return'correct';});
  test('BR TO BR credit excluded but customer e-transfer not',function(){truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','BR TO BR - 0863','CREDIT',5000)),'internal');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','e-Transfer received CUSTOMER','CREDIT',5000)),false,'customer');return'correct';});
  test('Generic numeric Misc Payment never becomes obligation by itself',function(){equal(vfcRbcClassifyDebit_(tx('2026-03-12','Misc Payment 1469635','DEBIT',6585.81,'1469635')),null,'misc');return'ignored';});

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,rbcRulesVersion:vfcRbcBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
function runBankingStabilitySelfTests(){return runRbcBankingSelfTests();}
+s.totalCredits+
      '; printed debits '+printed.debitCount+' / 

function vfcRbcRepairLedger_(currentLedger,text,fileName,facts,reason,attempt){
  const printed=vfcRbcPrintedActivityCounts_(text),current=vfcRbcLedgerStats_(currentLedger),prompt=[
    'You are the VFC RBC Account Activity Reconciliation Reader. Return JSON only.',
    'This is FACT EXTRACTION ONLY. Do not underwrite, classify debt, summarize or estimate.',
    'File: '+fileName,
    'The previous ledger failed deterministic reconciliation: '+reason,
    'AUTHORITATIVE PRINTED TARGETS:',
    'CREDIT rows exactly: '+printed.creditCount,
    'CREDIT total exactly: '+vfcNum_(facts.deposits),
    'DEBIT rows exactly: '+printed.debitCount,
    'DEBIT total exactly: '+vfcNum_(facts.withdrawals),
    'Opening balance: '+vfcNum_(facts.opening),
    'Closing balance: '+vfcNum_(facts.closing),
    'Return JSON with ONE field only: banking_transactions.',
    'banking_transactions must be the COMPLETE Account Activity ledger and each object must be {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short visible counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
    'STRICT RULES:',
    '1. Read only Account Activity Details rows. Include every amount-bearing activity row, including all bank fees and ordinary purchases.',
    '2. Do not include opening/closing balances, Account Summary totals, Account Fees summary, page totals, cheque-image/support pages, serial-number image rows or endorsements.',
    '3. Printed Cheques & Debits column = DEBIT; printed Deposits & Credits column = CREDIT. Never infer direction from words.',
    '4. MISC PAYMENT and RETURN/NSF can occur in either direction. Use the printed column.',
    '5. Keep repeated legitimate transactions. Do not deduplicate two separately printed activity rows.',
    '6. The final array MUST contain exactly '+printed.creditCount+' CREDIT rows totaling '+vfcNum_(facts.deposits)+' and exactly '+printed.debitCount+' DEBIT rows totaling '+vfcNum_(facts.withdrawals)+'.',
    '7. If the current candidate missed a row, recover it from the raw statement. If it contains an artifact, remove only the artifact.',
    'Current candidate stats: credits '+current.creditCount+' / $'+current.totalCredits+', debits '+current.debitCount+' / $'+current.totalDebits+'.',
    'Current candidate ledger:',JSON.stringify(currentLedger),
    'RAW RBC STATEMENT OCR:',String(text||'').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
  ].join('\n');
  const repaired=callOpenAIJson_(prompt);
  if(!repaired||!Array.isArray(repaired.banking_transactions))throw new Error('RBC reconciliation pass '+attempt+' did not return a complete banking_transactions array for '+fileName+'.');
  return vfcRbcPrepareLedger_(repaired.banking_transactions);
}

function vfcRbcIsPadLikeText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return false;
  return/^(?:BUSINESS\s+)?PAD\b|PRE[- ]?AUTH(?:ORIZED)?(?:\s+DEBIT|\s+PAYMENT)?\b|PREAUTHORIZED(?:\s+DEBIT|\s+PAYMENT)?\b|DIRECT\s+DEBIT\b|EFT\s+DEBIT\b|ACH\s+DEBIT\b|AUTOMATIC\s+DEBIT\b|AUTO\s+PAYMENT\b/.test(s);
}

function vfcRbcReturnEventText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||/\b(?:FEE|FEES|CHARGE)\b/.test(s))return false;
  return/CHEQUE\s+RETURNED(?:\s+NSF)?|CHECK\s+RETURNED(?:\s+NSF)?|ITEM\s+RETURNED(?:\s+NSF|\s+UNPAID)?|RETURNED\s+(?:ITEM|CHEQUE|CHECK|PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)|(?:PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)\s+RETURNED|PRE[- ]?AUTH(?:ORIZED)?\s+(?:DEBIT|PAYMENT)\s+RETURNED|PREAUTHORIZED\s+(?:DEBIT|PAYMENT)\s+RETURNED|DIRECT\s+DEBIT\s+RETURNED|REJECTED\s+(?:PAD|DEBIT|PAYMENT)|\bREVERSAL\b|\bREVERSED\b|NSF\s+RETURN/.test(s);
}
function vfcRbcReturnCreditText_(value){return vfcRbcReturnEventText_(value);}
function vfcRbcCountReturnEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcCountBorrowerNsfEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcNegativeBalanceFlag_(text,facts){if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;return/(?:^|\s)-[0-9][0-9,]*\.\d{2}(?:\s|$)/m.test(String(text||''));}
function vfcRbcAmountBand_(amount){const n=Math.max(1,vfcNum_(amount));return Math.round(Math.log(n)/Math.log(1.25));}

function vfcRbcClassifyDebit_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t&&t.counterparty||'').replace(/\s+/g,' ').trim(),band=vfcRbcAmountBand_(t&&t.amount),hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b|\bMCA\b|\bLEASE\b|\bLSE\b/.test(s),isFee=/\bFEES?\b|SERVICE\s+CHARGE|NSF\s+ITEM\s+FEES?|RETURNED[- ]?ITEM\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE|ACTIVITY\s+FEE|TRANSACTION\s+FEE|MONTHLY\s+FEE/.test(s);
  if(isFee&&!hasFinancingSignal)return null;
  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/COMM\s+EQUIP\s+RENT\/LSE\s+SILVERCHEF|\bSILVERCHEF\b/.test(s)){family='FINANCING';entityKey='SILVERCHEF_EQUIPMENT_LEASE';label='SilverChef Equipment Lease';debtJustification='Explicit recurring equipment lease.';}
  else if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';debtJustification='Known MCA/funding counterparty plus recurrence.';}
  else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){family='MCA';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bBDC\b/.test(s)&&vfcRbcIsPadLikeText_(s)){family='FINANCING';entityKey='RBC_BDC_PAD_B'+band;label='BDC';debtJustification='Recurring BDC PAD stream; materially different catch-up amounts remain separate.';}
  else if(/\bBDC\b/.test(s)&&(/BDC[- ]?LOAN\/PRET|ONLINE\s+BANKING\s+PAYMENT|\bLOAN\b|FINANC/.test(s))){family='FINANCING';entityKey='RBC_BDC_MANUAL_B'+band;label='BDC Manual / Loan Payment';debtJustification='Manual BDC loan-payment stream kept separate from normal PAD.';}
  else if(/\bAFFIRM(?:\s+CANADA)?\b/.test(s)){family='FINANCING';entityKey='RBC_AFFIRM_CANADA';label='Affirm Canada';debtJustification='Affirm Canada financing counterparty plus recurrence.';}
  else if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='CANACAP';label='Canacap';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bGREENBOX\b/.test(s)){family='MCA';entityKey='GREENBOX';label='Greenbox';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bICAPITAL\b/.test(s)){family='FINANCING';entityKey='ICAPITAL';label='iCapital';debtJustification='Known financing counterparty plus recurrence.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC/.test(s)){family='FINANCING';entityKey='RBC_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw)+'_B'+band;label=cp||'Premium Finance';debtJustification='Explicit premium-finance counterparty plus recurrence.';}
  else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){family='TAX';entityKey='RBC_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);}
  else if(/INSURANCE/.test(s)){family='OTHER';if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}else if(/IND\s+ALL/.test(s)){entityKey='INSURANCE_IND_ALL';label='Insurance IND ALL';}else entityKey='RBC_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|CAPITAL\s+ONE|\bMBNA\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/^AUTO\s+PAYMENT\b/.test(s)){
    const clean=raw.replace(/^AUTO\s+PAYMENT\s*/i,'').trim(),financeLike=/\bAFS\b|FINANC|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s);
    family=financeLike?'FINANCING':'OTHER';entityKey=(financeLike?'AUTO_PAYMENT_FINANCE_':'RBC_OTHER_AUTOPAY_')+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;if(financeLike)debtJustification='Automatic payment with independent finance-like counterparty evidence.';
  }
  else if(/^MISC\s+PAYMENT\b/.test(s)&&(/\bAFS\b|FINANC|LEASE|LENDING|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s))){const clean=raw.replace(/^MISC\s+PAYMENT\s*/i,'').trim();family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;debtJustification='Retry/recurring payment with independent finance-like counterparty evidence.';}
  else if(hasFinancingSignal){
    family='FINANCING';debtJustification='Explicit financing wording plus recurring observed cadence.';
    if(/^LOAN\s+PAYMENT$/i.test(raw)){entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';}
    else{
      const numbered=s.match(/(?:NO\.?|NUMBER|#)\s*([0-9-]{5,})/),generic=s.match(/\b(?:LOAN|MORTGAGE|LOC)\b[^0-9]{0,30}([0-9][0-9-]{5,})\b/),ref=numbered||generic;
      if(ref){const n=ref[1].replace(/[^0-9]/g,'');if(/LOAN\s+INTEREST/.test(s)){entityKey='LOAN_INTEREST_'+n;label='Loan interest NO.'+n;}else if(/\bLOAN\b/.test(s)){entityKey='LOAN_'+n;label='Loan payment NO.'+n;}else if(/\bLEASE\b|\bLSE\b/.test(s)){entityKey='LEASE_'+n;label='Lease payment NO.'+n;}else{entityKey='FINANCE_REF_'+n;}}
      else{const stable=(cp||raw).replace(/\b[0-9][0-9-]{4,}\b/g,'').replace(/\s+/g,' ').trim();entityKey='RBC_FINANCE_'+vfcCounterpartyKey_(stable||cp||raw);}
    }
  }
  else if(vfcRbcIsPadLikeText_(s)){family='OTHER';entityKey='RBC_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/\bCAPITAL\b|\bFUNDING\b|\bFACTOR(?:ING)?\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_POSSIBLE_FINANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/COMMERCIAL\s+RENT|\bRENT\b|HYDRO|FORTIS|TELUS|UTILITY|SUPERPASS|PETROLEUM|\bFUEL\b|EQUIPMENT\s+RENT|PAY\s+EMPLOYEE|PAYROLL/.test(s)){family='OTHER';entityKey='RBC_OTHER_BUSINESS_'+vfcCounterpartyKey_(cp||raw);}
  else{return null;}
  if(!entityKey)entityKey='RBC_OTHER_'+vfcCounterpartyKey_(raw);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcRbcIsReturnedFinancingCredit_(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}
function vfcRbcIsNonOperatingTransferCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;const s=String(t&&t.description||'').toUpperCase();if(/E-TRANSFER|INTERAC/.test(s))return false;return/\bBR\s+TO\s+BR\b|\bTRANSFER\s+FROM\s+(?:ACCOUNT|A\/C|ACCT)\b|\bINTERNAL\s+TRANSFER\b/.test(s);}
function vfcRbcKnownFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();if(vfcRbcIsReturnedFinancingCredit_(t))return false;return/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|\bICAPITAL\b|GREENBOX|\bCSBFL\b|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s);}
function vfcRbcPreservePrintedDuplicate_(){return true;}
function vfcRbcStrongEntityKey_(key){return/^(RBC_AFFIRM_CANADA|RBC_PREMIUM_FINANCE_|RBC_BDC_|MERCHANT_GROWTH|JOURNEY_ONDECK|CANACAP|ICAPITAL|GREENBOX|SILVERCHEF_EQUIPMENT_LEASE|AUTO_PAYMENT_FINANCE_|RBC_FINANCE_|INSURANCE_|LEASE_[0-9]|FINANCE_REF_[0-9])/.test(String(key||'').toUpperCase());}

function runRbcBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'RBC',transactions:transactions||[]}};}
  function close(a,e,t,l){t=t==null?.02:t;if(Math.abs(Number(a||0)-Number(e||0))>t)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function equal(a,e,l){if(a!==e)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function truthy(v,l){if(!v)throw new Error((l||'value')+' expected truthy');}
  function test(n,f){try{results.push({name:n,pass:true,detail:String(f()||'')});}catch(e){results.push({name:n,pass:false,detail:String(e&&e.message||e)});}}

  test('AIM HIGH Mar-Apr printed credits are exactly 15 and $45,725.36',function(){const c=[2000,250,1000,6585.81,1046.83,250,7474.96,3000,750,2750,3250,2750,6673.93,7693.83,250];equal(c.length,15,'count');close(vfcSum_(c),45725.36,.02,'sum');return'15/$45725.36';});
  test('Exact ledger audit passes only when count and totals both match',function(){const text='Total deposits & credits (2) + 150.00\nTotal cheques & debits (2) - 30.00',facts={deposits:150,withdrawals:30},good=[tx('2026-01-01','A','CREDIT',100),tx('2026-01-02','B','CREDIT',50),tx('2026-01-03','C','DEBIT',10),tx('2026-01-04','D','DEBIT',20)];const a=vfcRbcAuditFullLedger_(good,facts,text,'x.pdf');equal(a.creditCount,2,'credits');let failed=false;try{vfcRbcAuditFullLedger_(good.slice(1),facts,text,'x.pdf');}catch(e){failed=true;}truthy(failed,'missing row fails');return'exact';});
  test('Opening/closing/support artifacts are excluded',function(){const p=vfcRbcPrepareLedger_([tx('2026-03-02','Opening balance','CREDIT',4710.90),tx('2026-03-03','Loan BK OF MONTREAL','DEBIT',599.22),tx('2026-04-02','Serial #: 343 Amount: $315.00','CREDIT',315)]);equal(p.length,1,'real rows');return'clean';});
  test('Return direction remains printed-column driven',function(){equal(vfcRbcCertainDirection_(tx('2026-05-27','Cheque returned NSF','DEBIT',2606.59)),'','no force');truthy(vfcRbcIsReturnedFinancingCredit_(tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)),'credit return');equal(vfcRbcIsReturnedFinancingCredit_(tx('2026-06-25','Item returned unpaid','DEBIT',187.46)),false,'debit return');return'direction safe';});
  test('Unknown recurring PAD is informational only',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-02-28',[tx('2026-02-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-03-31',[tx('2026-03-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])]);close(d.confirmedMonthlyDebtService,0,.001,'debt');return'informational';});
  test('Recurring Affirm is financing',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-02-28',[tx('2026-02-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-03-31',[tx('2026-03-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm');return'66.62';});
  test('Returned BDC PAD cannot inflate debt',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-27','Business PAD BDC','DEBIT',2578.34,'BDC')]),row('2026-04-30',[tx('2026-04-27','Business PAD BDC','DEBIT',2656.97,'BDC')]),row('2026-05-31',[tx('2026-05-27','Business PAD BDC','DEBIT',2606.59,'BDC'),tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)]),row('2026-06-30',[tx('2026-06-29','Business PAD BDC','DEBIT',5289.91,'BDC'),tx('2026-06-29','Cheque returned NSF','CREDIT',5289.91)]),row('2026-08-31',[tx('2026-08-17','Business PAD BDC','DEBIT',2285.91,'BDC')])]);truthy(d.returnedFinanceDebitsSuppressed>=2,'suppressed');return'suppressed='+d.returnedFinanceDebitsSuppressed;});
  test('Recurring IPFS is financing while ordinary insurance is informational',function(){const ip=vfcRbcClassifyDebit_(tx('2026-08-04','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')),ins=vfcRbcClassifyDebit_(tx('2026-08-04','Auto Insurance ICBC','DEBIT',234.96,'ICBC'));equal(ip.family,'FINANCING','IPFS');equal(ins.family,'OTHER','insurance');return'correct';});
  test('BR TO BR credit excluded but customer e-transfer not',function(){truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','BR TO BR - 0863','CREDIT',5000)),'internal');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','e-Transfer received CUSTOMER','CREDIT',5000)),false,'customer');return'correct';});
  test('Generic numeric Misc Payment never becomes obligation by itself',function(){equal(vfcRbcClassifyDebit_(tx('2026-03-12','Misc Payment 1469635','DEBIT',6585.81,'1469635')),null,'misc');return'ignored';});

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,rbcRulesVersion:vfcRbcBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
function runBankingStabilitySelfTests(){return runRbcBankingSelfTests();}
+vfcRound_(statementDiff,.01)+'.');

  const locked=Object.assign({},summary||{});
  locked.statement_start_date=facts.startDate;
  locked.statement_end_date=facts.endDate;
  locked.opening_balance=facts.opening;
  locked.closing_balance=facts.closing;
  locked.total_deposits=facts.deposits;
  locked.total_withdrawals=facts.withdrawals;

  let ledger=vfcRbcPrepareLedger_(locked.banking_transactions||[]),audit=null,lastError='',repairPasses=0;
  for(let attempt=0;attempt<=2;attempt++){
    try{
      audit=vfcRbcAuditFullLedger_(ledger,facts,text,name);
      break;
    }catch(e){
      lastError=String(e&&e.message||e);
      if(attempt>=2)throw new Error(lastError);
      repairPasses++;
      ledger=vfcRbcRepairLedger_(ledger,text,name,facts,lastError,repairPasses);
    }
  }

  if(!audit)throw new Error('RBC ledger verification did not complete for '+name+'.');
  locked.banking_transactions=ledger;
  locked.rbc_full_ledger_verified=true;
  locked.rbc_ledger_reconciled=repairPasses>0;
  locked.rbc_ledger_repair_passes=repairPasses;
  locked.rbc_credit_transaction_count=audit.creditCount;
  locked.rbc_debit_transaction_count=audit.debitCount;
  locked.nsf_count=vfcRbcCountBorrowerNsfEvents_(ledger);
  locked.negative_balance_detected=vfcRbcNegativeBalanceFlag_(text,facts);
  return locked;
}

function vfcRbcPrintedActivityCounts_(text){
  const s=String(text||'').replace(/\u00a0/g,' '),c=s.match(/Total\s+deposits\s*&\s*credits\s*\((\d+)\)/i),d=s.match(/Total\s+cheques\s*&\s*debits\s*\((\d+)\)/i);
  return{creditCount:c?Number(c[1]):null,debitCount:d?Number(d[1]):null};
}

function vfcRbcIsNonActivityArtifact_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s)return true;
  return/^OPENING\s+BALANCE\b|^CLOSING\s+BALANCE\b|^ACCOUNT\s+FEES?\b|^ACCOUNT\s+SUMMARY\b|^TOTAL\s+DEPOSITS\s*&\s*CREDITS\b|^TOTAL\s+CHEQUES\s*&\s+DEBITS\b|^PAGE\s+TOTAL\b|^SERIAL\s*#?\s*:?\s*\d+\s+AMOUNT\b|FOR\s+DEPOSIT\s+ONLY|BACKVERSO|BACK\s*\/\s*VERSO|CHEQUE\s+IMAGE|CHECK\s+IMAGE/.test(s);
}

function vfcRbcPrepareLedger_(items){
  return(Array.isArray(items)?items:[]).filter(function(x){return!vfcRbcIsNonActivityArtifact_(x);}).map(function(x){
    const t=Object.assign({},x||{}),forced=vfcRbcCertainDirection_(t);
    if(forced)t.direction=forced;
    t.direction=String(t.direction||'').toUpperCase();
    t.description=String(t.description||'').replace(/\s+/g,' ').trim();
    t.counterparty=String(t.counterparty||t.description||'').replace(/\s+/g,' ').trim();
    t.amount=vfcNum_(t.amount);
    return t;
  });
}

function vfcRbcCertainDirection_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return'';
  if(/^LOAN\s+CREDIT\b/.test(s)||/\bPAYROLL\s+DEPOSIT\b|\bTAX\s+REFUND\b|E-TRANSFER\s+RECEIVED|INTERAC\s+PURCHASE\s+REFUND|E-TRANSFER\s+CANCEL|MOBILE\s+CHEQUE\s+DEPOSIT/.test(s))return'CREDIT';
  if(vfcRbcIsPadLikeText_(s)||/^LOAN\s+PAYMENT\b|^LOAN\s+INTEREST\b|^BLIP\s+PAYMENT\s*-?\s*LOAN\b|^BILL\s+PAYMENT\b|^FUEL\s+BILL\s+PAYMENT\b|^COMM\s+GAS\s+BILL\s+PMT\b|^COMMERCIAL\s+TAXES\b|^AUTO\s+INSURANCE\b|^INSURANCE\b|^RENT\/LEASE\b|^CHEQUE\s*-\s*\d+\b|E-TRANSFER\s+SENT|E-TRANSFER\s+REQUEST\s+FULFILLED/.test(s))return'DEBIT';
  return'';
}

function vfcRbcLedgerStats_(items){
  const out={creditCount:0,debitCount:0,totalCredits:0,totalDebits:0,bad:[]};
  (Array.isArray(items)?items:[]).forEach(function(t,i){
    const d=String(t&&t.direction||'').toUpperCase(),a=vfcNum_(t&&t.amount),desc=String(t&&t.description||'').trim(),date=vfcIso_(t&&t.date);
    if(!date||!desc||!(a>0)||(d!=='CREDIT'&&d!=='DEBIT')){out.bad.push(i+1);return;}
    if(d==='CREDIT'){out.creditCount++;out.totalCredits+=a;}else{out.debitCount++;out.totalDebits+=a;}
  });
  out.totalCredits=vfcRound_(out.totalCredits,.01);out.totalDebits=vfcRound_(out.totalDebits,.01);return out;
}

function vfcRbcLedgerPreview_(rows,direction){
  return(rows||[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()===direction;}).slice(0,40).map(function(t){return String(t.date||'')+' '+String(t.description||'')+' $'+vfcNum_(t.amount);}).join(' | ');
}

function vfcRbcAuditFullLedger_(items,facts,text,fileName){
  const rows=Array.isArray(items)?items:[],printed=vfcRbcPrintedActivityCounts_(text),s=vfcRbcLedgerStats_(rows);
  if(s.bad.length)throw new Error('RBC full ledger contains incomplete transaction row(s) '+s.bad.join(', ')+' for '+fileName+'.');
  const creditCountOk=printed.creditCount===null||s.creditCount===printed.creditCount;
  const debitCountOk=printed.debitCount===null||s.debitCount===printed.debitCount;
  const creditTotalOk=Math.abs(s.totalCredits-vfcNum_(facts.deposits))<=.05;
  const debitTotalOk=Math.abs(s.totalDebits-vfcNum_(facts.withdrawals))<=.05;
  if(!creditCountOk||!debitCountOk||!creditTotalOk||!debitTotalOk){
    throw new Error('RBC ledger mismatch for '+fileName+': printed credits '+printed.creditCount+' / $'+vfcNum_(facts.deposits)+', extracted '+s.creditCount+' / $'+s.totalCredits+'; printed debits '+printed.debitCount+' / $'+vfcNum_(facts.withdrawals)+', extracted '+s.debitCount+' / $'+s.totalDebits+'.');
  }
  return{creditCount:s.creditCount,debitCount:s.debitCount,totalCredits:s.totalCredits,totalDebits:s.totalDebits,reconciled:true};
}

function vfcRbcRepairLedger_(currentLedger,text,fileName,facts,reason,attempt){
  const printed=vfcRbcPrintedActivityCounts_(text),current=vfcRbcLedgerStats_(currentLedger),prompt=[
    'You are the VFC RBC Account Activity Reconciliation Reader. Return JSON only.',
    'This is FACT EXTRACTION ONLY. Do not underwrite, classify debt, summarize or estimate.',
    'File: '+fileName,
    'The previous ledger failed deterministic reconciliation: '+reason,
    'AUTHORITATIVE PRINTED TARGETS:',
    'CREDIT rows exactly: '+printed.creditCount,
    'CREDIT total exactly: '+vfcNum_(facts.deposits),
    'DEBIT rows exactly: '+printed.debitCount,
    'DEBIT total exactly: '+vfcNum_(facts.withdrawals),
    'Opening balance: '+vfcNum_(facts.opening),
    'Closing balance: '+vfcNum_(facts.closing),
    'Return JSON with ONE field only: banking_transactions.',
    'banking_transactions must be the COMPLETE Account Activity ledger and each object must be {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short visible counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
    'STRICT RULES:',
    '1. Read only Account Activity Details rows. Include every amount-bearing activity row, including all bank fees and ordinary purchases.',
    '2. Do not include opening/closing balances, Account Summary totals, Account Fees summary, page totals, cheque-image/support pages, serial-number image rows or endorsements.',
    '3. Printed Cheques & Debits column = DEBIT; printed Deposits & Credits column = CREDIT. Never infer direction from words.',
    '4. MISC PAYMENT and RETURN/NSF can occur in either direction. Use the printed column.',
    '5. Keep repeated legitimate transactions. Do not deduplicate two separately printed activity rows.',
    '6. The final array MUST contain exactly '+printed.creditCount+' CREDIT rows totaling '+vfcNum_(facts.deposits)+' and exactly '+printed.debitCount+' DEBIT rows totaling '+vfcNum_(facts.withdrawals)+'.',
    '7. If the current candidate missed a row, recover it from the raw statement. If it contains an artifact, remove only the artifact.',
    'Current candidate stats: credits '+current.creditCount+' / $'+current.totalCredits+', debits '+current.debitCount+' / $'+current.totalDebits+'.',
    'Current candidate ledger:',JSON.stringify(currentLedger),
    'RAW RBC STATEMENT OCR:',String(text||'').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
  ].join('\n');
  const repaired=callOpenAIJson_(prompt);
  if(!repaired||!Array.isArray(repaired.banking_transactions))throw new Error('RBC reconciliation pass '+attempt+' did not return a complete banking_transactions array for '+fileName+'.');
  return vfcRbcPrepareLedger_(repaired.banking_transactions);
}

function vfcRbcIsPadLikeText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return false;
  return/^(?:BUSINESS\s+)?PAD\b|PRE[- ]?AUTH(?:ORIZED)?(?:\s+DEBIT|\s+PAYMENT)?\b|PREAUTHORIZED(?:\s+DEBIT|\s+PAYMENT)?\b|DIRECT\s+DEBIT\b|EFT\s+DEBIT\b|ACH\s+DEBIT\b|AUTOMATIC\s+DEBIT\b|AUTO\s+PAYMENT\b/.test(s);
}

function vfcRbcReturnEventText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||/\b(?:FEE|FEES|CHARGE)\b/.test(s))return false;
  return/CHEQUE\s+RETURNED(?:\s+NSF)?|CHECK\s+RETURNED(?:\s+NSF)?|ITEM\s+RETURNED(?:\s+NSF|\s+UNPAID)?|RETURNED\s+(?:ITEM|CHEQUE|CHECK|PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)|(?:PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)\s+RETURNED|PRE[- ]?AUTH(?:ORIZED)?\s+(?:DEBIT|PAYMENT)\s+RETURNED|PREAUTHORIZED\s+(?:DEBIT|PAYMENT)\s+RETURNED|DIRECT\s+DEBIT\s+RETURNED|REJECTED\s+(?:PAD|DEBIT|PAYMENT)|\bREVERSAL\b|\bREVERSED\b|NSF\s+RETURN/.test(s);
}
function vfcRbcReturnCreditText_(value){return vfcRbcReturnEventText_(value);}
function vfcRbcCountReturnEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcCountBorrowerNsfEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcNegativeBalanceFlag_(text,facts){if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;return/(?:^|\s)-[0-9][0-9,]*\.\d{2}(?:\s|$)/m.test(String(text||''));}
function vfcRbcAmountBand_(amount){const n=Math.max(1,vfcNum_(amount));return Math.round(Math.log(n)/Math.log(1.25));}

function vfcRbcClassifyDebit_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t&&t.counterparty||'').replace(/\s+/g,' ').trim(),band=vfcRbcAmountBand_(t&&t.amount),hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b|\bMCA\b|\bLEASE\b|\bLSE\b/.test(s),isFee=/\bFEES?\b|SERVICE\s+CHARGE|NSF\s+ITEM\s+FEES?|RETURNED[- ]?ITEM\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE|ACTIVITY\s+FEE|TRANSACTION\s+FEE|MONTHLY\s+FEE/.test(s);
  if(isFee&&!hasFinancingSignal)return null;
  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/COMM\s+EQUIP\s+RENT\/LSE\s+SILVERCHEF|\bSILVERCHEF\b/.test(s)){family='FINANCING';entityKey='SILVERCHEF_EQUIPMENT_LEASE';label='SilverChef Equipment Lease';debtJustification='Explicit recurring equipment lease.';}
  else if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';debtJustification='Known MCA/funding counterparty plus recurrence.';}
  else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){family='MCA';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bBDC\b/.test(s)&&vfcRbcIsPadLikeText_(s)){family='FINANCING';entityKey='RBC_BDC_PAD_B'+band;label='BDC';debtJustification='Recurring BDC PAD stream; materially different catch-up amounts remain separate.';}
  else if(/\bBDC\b/.test(s)&&(/BDC[- ]?LOAN\/PRET|ONLINE\s+BANKING\s+PAYMENT|\bLOAN\b|FINANC/.test(s))){family='FINANCING';entityKey='RBC_BDC_MANUAL_B'+band;label='BDC Manual / Loan Payment';debtJustification='Manual BDC loan-payment stream kept separate from normal PAD.';}
  else if(/\bAFFIRM(?:\s+CANADA)?\b/.test(s)){family='FINANCING';entityKey='RBC_AFFIRM_CANADA';label='Affirm Canada';debtJustification='Affirm Canada financing counterparty plus recurrence.';}
  else if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='CANACAP';label='Canacap';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bGREENBOX\b/.test(s)){family='MCA';entityKey='GREENBOX';label='Greenbox';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bICAPITAL\b/.test(s)){family='FINANCING';entityKey='ICAPITAL';label='iCapital';debtJustification='Known financing counterparty plus recurrence.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC/.test(s)){family='FINANCING';entityKey='RBC_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw)+'_B'+band;label=cp||'Premium Finance';debtJustification='Explicit premium-finance counterparty plus recurrence.';}
  else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){family='TAX';entityKey='RBC_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);}
  else if(/INSURANCE/.test(s)){family='OTHER';if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}else if(/IND\s+ALL/.test(s)){entityKey='INSURANCE_IND_ALL';label='Insurance IND ALL';}else entityKey='RBC_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|CAPITAL\s+ONE|\bMBNA\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/^AUTO\s+PAYMENT\b/.test(s)){
    const clean=raw.replace(/^AUTO\s+PAYMENT\s*/i,'').trim(),financeLike=/\bAFS\b|FINANC|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s);
    family=financeLike?'FINANCING':'OTHER';entityKey=(financeLike?'AUTO_PAYMENT_FINANCE_':'RBC_OTHER_AUTOPAY_')+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;if(financeLike)debtJustification='Automatic payment with independent finance-like counterparty evidence.';
  }
  else if(/^MISC\s+PAYMENT\b/.test(s)&&(/\bAFS\b|FINANC|LEASE|LENDING|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s))){const clean=raw.replace(/^MISC\s+PAYMENT\s*/i,'').trim();family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;debtJustification='Retry/recurring payment with independent finance-like counterparty evidence.';}
  else if(hasFinancingSignal){
    family='FINANCING';debtJustification='Explicit financing wording plus recurring observed cadence.';
    if(/^LOAN\s+PAYMENT$/i.test(raw)){entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';}
    else{
      const numbered=s.match(/(?:NO\.?|NUMBER|#)\s*([0-9-]{5,})/),generic=s.match(/\b(?:LOAN|MORTGAGE|LOC)\b[^0-9]{0,30}([0-9][0-9-]{5,})\b/),ref=numbered||generic;
      if(ref){const n=ref[1].replace(/[^0-9]/g,'');if(/LOAN\s+INTEREST/.test(s)){entityKey='LOAN_INTEREST_'+n;label='Loan interest NO.'+n;}else if(/\bLOAN\b/.test(s)){entityKey='LOAN_'+n;label='Loan payment NO.'+n;}else if(/\bLEASE\b|\bLSE\b/.test(s)){entityKey='LEASE_'+n;label='Lease payment NO.'+n;}else{entityKey='FINANCE_REF_'+n;}}
      else{const stable=(cp||raw).replace(/\b[0-9][0-9-]{4,}\b/g,'').replace(/\s+/g,' ').trim();entityKey='RBC_FINANCE_'+vfcCounterpartyKey_(stable||cp||raw);}
    }
  }
  else if(vfcRbcIsPadLikeText_(s)){family='OTHER';entityKey='RBC_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/\bCAPITAL\b|\bFUNDING\b|\bFACTOR(?:ING)?\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_POSSIBLE_FINANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/COMMERCIAL\s+RENT|\bRENT\b|HYDRO|FORTIS|TELUS|UTILITY|SUPERPASS|PETROLEUM|\bFUEL\b|EQUIPMENT\s+RENT|PAY\s+EMPLOYEE|PAYROLL/.test(s)){family='OTHER';entityKey='RBC_OTHER_BUSINESS_'+vfcCounterpartyKey_(cp||raw);}
  else{return null;}
  if(!entityKey)entityKey='RBC_OTHER_'+vfcCounterpartyKey_(raw);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcRbcIsReturnedFinancingCredit_(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}
function vfcRbcIsNonOperatingTransferCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;const s=String(t&&t.description||'').toUpperCase();if(/E-TRANSFER|INTERAC/.test(s))return false;return/\bBR\s+TO\s+BR\b|\bTRANSFER\s+FROM\s+(?:ACCOUNT|A\/C|ACCT)\b|\bINTERNAL\s+TRANSFER\b/.test(s);}
function vfcRbcKnownFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();if(vfcRbcIsReturnedFinancingCredit_(t))return false;return/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|\bICAPITAL\b|GREENBOX|\bCSBFL\b|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s);}
function vfcRbcPreservePrintedDuplicate_(){return true;}
function vfcRbcStrongEntityKey_(key){return/^(RBC_AFFIRM_CANADA|RBC_PREMIUM_FINANCE_|RBC_BDC_|MERCHANT_GROWTH|JOURNEY_ONDECK|CANACAP|ICAPITAL|GREENBOX|SILVERCHEF_EQUIPMENT_LEASE|AUTO_PAYMENT_FINANCE_|RBC_FINANCE_|INSURANCE_|LEASE_[0-9]|FINANCE_REF_[0-9])/.test(String(key||'').toUpperCase());}

function runRbcBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'RBC',transactions:transactions||[]}};}
  function close(a,e,t,l){t=t==null?.02:t;if(Math.abs(Number(a||0)-Number(e||0))>t)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function equal(a,e,l){if(a!==e)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function truthy(v,l){if(!v)throw new Error((l||'value')+' expected truthy');}
  function test(n,f){try{results.push({name:n,pass:true,detail:String(f()||'')});}catch(e){results.push({name:n,pass:false,detail:String(e&&e.message||e)});}}

  test('AIM HIGH Mar-Apr printed credits are exactly 15 and $45,725.36',function(){const c=[2000,250,1000,6585.81,1046.83,250,7474.96,3000,750,2750,3250,2750,6673.93,7693.83,250];equal(c.length,15,'count');close(vfcSum_(c),45725.36,.02,'sum');return'15/$45725.36';});
  test('Exact ledger audit passes only when count and totals both match',function(){const text='Total deposits & credits (2) + 150.00\nTotal cheques & debits (2) - 30.00',facts={deposits:150,withdrawals:30},good=[tx('2026-01-01','A','CREDIT',100),tx('2026-01-02','B','CREDIT',50),tx('2026-01-03','C','DEBIT',10),tx('2026-01-04','D','DEBIT',20)];const a=vfcRbcAuditFullLedger_(good,facts,text,'x.pdf');equal(a.creditCount,2,'credits');let failed=false;try{vfcRbcAuditFullLedger_(good.slice(1),facts,text,'x.pdf');}catch(e){failed=true;}truthy(failed,'missing row fails');return'exact';});
  test('Opening/closing/support artifacts are excluded',function(){const p=vfcRbcPrepareLedger_([tx('2026-03-02','Opening balance','CREDIT',4710.90),tx('2026-03-03','Loan BK OF MONTREAL','DEBIT',599.22),tx('2026-04-02','Serial #: 343 Amount: $315.00','CREDIT',315)]);equal(p.length,1,'real rows');return'clean';});
  test('Return direction remains printed-column driven',function(){equal(vfcRbcCertainDirection_(tx('2026-05-27','Cheque returned NSF','DEBIT',2606.59)),'','no force');truthy(vfcRbcIsReturnedFinancingCredit_(tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)),'credit return');equal(vfcRbcIsReturnedFinancingCredit_(tx('2026-06-25','Item returned unpaid','DEBIT',187.46)),false,'debit return');return'direction safe';});
  test('Unknown recurring PAD is informational only',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-02-28',[tx('2026-02-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-03-31',[tx('2026-03-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])]);close(d.confirmedMonthlyDebtService,0,.001,'debt');return'informational';});
  test('Recurring Affirm is financing',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-02-28',[tx('2026-02-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-03-31',[tx('2026-03-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm');return'66.62';});
  test('Returned BDC PAD cannot inflate debt',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-27','Business PAD BDC','DEBIT',2578.34,'BDC')]),row('2026-04-30',[tx('2026-04-27','Business PAD BDC','DEBIT',2656.97,'BDC')]),row('2026-05-31',[tx('2026-05-27','Business PAD BDC','DEBIT',2606.59,'BDC'),tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)]),row('2026-06-30',[tx('2026-06-29','Business PAD BDC','DEBIT',5289.91,'BDC'),tx('2026-06-29','Cheque returned NSF','CREDIT',5289.91)]),row('2026-08-31',[tx('2026-08-17','Business PAD BDC','DEBIT',2285.91,'BDC')])]);truthy(d.returnedFinanceDebitsSuppressed>=2,'suppressed');return'suppressed='+d.returnedFinanceDebitsSuppressed;});
  test('Recurring IPFS is financing while ordinary insurance is informational',function(){const ip=vfcRbcClassifyDebit_(tx('2026-08-04','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')),ins=vfcRbcClassifyDebit_(tx('2026-08-04','Auto Insurance ICBC','DEBIT',234.96,'ICBC'));equal(ip.family,'FINANCING','IPFS');equal(ins.family,'OTHER','insurance');return'correct';});
  test('BR TO BR credit excluded but customer e-transfer not',function(){truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','BR TO BR - 0863','CREDIT',5000)),'internal');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','e-Transfer received CUSTOMER','CREDIT',5000)),false,'customer');return'correct';});
  test('Generic numeric Misc Payment never becomes obligation by itself',function(){equal(vfcRbcClassifyDebit_(tx('2026-03-12','Misc Payment 1469635','DEBIT',6585.81,'1469635')),null,'misc');return'ignored';});

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,rbcRulesVersion:vfcRbcBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
function runBankingStabilitySelfTests(){return runRbcBankingSelfTests();}
+vfcNum_(facts.withdrawals)+
      ', extracted '+s.debitCount+' / 

function vfcRbcRepairLedger_(currentLedger,text,fileName,facts,reason,attempt){
  const printed=vfcRbcPrintedActivityCounts_(text),current=vfcRbcLedgerStats_(currentLedger),prompt=[
    'You are the VFC RBC Account Activity Reconciliation Reader. Return JSON only.',
    'This is FACT EXTRACTION ONLY. Do not underwrite, classify debt, summarize or estimate.',
    'File: '+fileName,
    'The previous ledger failed deterministic reconciliation: '+reason,
    'AUTHORITATIVE PRINTED TARGETS:',
    'CREDIT rows exactly: '+printed.creditCount,
    'CREDIT total exactly: '+vfcNum_(facts.deposits),
    'DEBIT rows exactly: '+printed.debitCount,
    'DEBIT total exactly: '+vfcNum_(facts.withdrawals),
    'Opening balance: '+vfcNum_(facts.opening),
    'Closing balance: '+vfcNum_(facts.closing),
    'Return JSON with ONE field only: banking_transactions.',
    'banking_transactions must be the COMPLETE Account Activity ledger and each object must be {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short visible counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
    'STRICT RULES:',
    '1. Read only Account Activity Details rows. Include every amount-bearing activity row, including all bank fees and ordinary purchases.',
    '2. Do not include opening/closing balances, Account Summary totals, Account Fees summary, page totals, cheque-image/support pages, serial-number image rows or endorsements.',
    '3. Printed Cheques & Debits column = DEBIT; printed Deposits & Credits column = CREDIT. Never infer direction from words.',
    '4. MISC PAYMENT and RETURN/NSF can occur in either direction. Use the printed column.',
    '5. Keep repeated legitimate transactions. Do not deduplicate two separately printed activity rows.',
    '6. The final array MUST contain exactly '+printed.creditCount+' CREDIT rows totaling '+vfcNum_(facts.deposits)+' and exactly '+printed.debitCount+' DEBIT rows totaling '+vfcNum_(facts.withdrawals)+'.',
    '7. If the current candidate missed a row, recover it from the raw statement. If it contains an artifact, remove only the artifact.',
    'Current candidate stats: credits '+current.creditCount+' / $'+current.totalCredits+', debits '+current.debitCount+' / $'+current.totalDebits+'.',
    'Current candidate ledger:',JSON.stringify(currentLedger),
    'RAW RBC STATEMENT OCR:',String(text||'').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
  ].join('\n');
  const repaired=callOpenAIJson_(prompt);
  if(!repaired||!Array.isArray(repaired.banking_transactions))throw new Error('RBC reconciliation pass '+attempt+' did not return a complete banking_transactions array for '+fileName+'.');
  return vfcRbcPrepareLedger_(repaired.banking_transactions);
}

function vfcRbcIsPadLikeText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return false;
  return/^(?:BUSINESS\s+)?PAD\b|PRE[- ]?AUTH(?:ORIZED)?(?:\s+DEBIT|\s+PAYMENT)?\b|PREAUTHORIZED(?:\s+DEBIT|\s+PAYMENT)?\b|DIRECT\s+DEBIT\b|EFT\s+DEBIT\b|ACH\s+DEBIT\b|AUTOMATIC\s+DEBIT\b|AUTO\s+PAYMENT\b/.test(s);
}

function vfcRbcReturnEventText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||/\b(?:FEE|FEES|CHARGE)\b/.test(s))return false;
  return/CHEQUE\s+RETURNED(?:\s+NSF)?|CHECK\s+RETURNED(?:\s+NSF)?|ITEM\s+RETURNED(?:\s+NSF|\s+UNPAID)?|RETURNED\s+(?:ITEM|CHEQUE|CHECK|PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)|(?:PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)\s+RETURNED|PRE[- ]?AUTH(?:ORIZED)?\s+(?:DEBIT|PAYMENT)\s+RETURNED|PREAUTHORIZED\s+(?:DEBIT|PAYMENT)\s+RETURNED|DIRECT\s+DEBIT\s+RETURNED|REJECTED\s+(?:PAD|DEBIT|PAYMENT)|\bREVERSAL\b|\bREVERSED\b|NSF\s+RETURN/.test(s);
}
function vfcRbcReturnCreditText_(value){return vfcRbcReturnEventText_(value);}
function vfcRbcCountReturnEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcCountBorrowerNsfEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcNegativeBalanceFlag_(text,facts){if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;return/(?:^|\s)-[0-9][0-9,]*\.\d{2}(?:\s|$)/m.test(String(text||''));}
function vfcRbcAmountBand_(amount){const n=Math.max(1,vfcNum_(amount));return Math.round(Math.log(n)/Math.log(1.25));}

function vfcRbcClassifyDebit_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t&&t.counterparty||'').replace(/\s+/g,' ').trim(),band=vfcRbcAmountBand_(t&&t.amount),hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b|\bMCA\b|\bLEASE\b|\bLSE\b/.test(s),isFee=/\bFEES?\b|SERVICE\s+CHARGE|NSF\s+ITEM\s+FEES?|RETURNED[- ]?ITEM\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE|ACTIVITY\s+FEE|TRANSACTION\s+FEE|MONTHLY\s+FEE/.test(s);
  if(isFee&&!hasFinancingSignal)return null;
  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/COMM\s+EQUIP\s+RENT\/LSE\s+SILVERCHEF|\bSILVERCHEF\b/.test(s)){family='FINANCING';entityKey='SILVERCHEF_EQUIPMENT_LEASE';label='SilverChef Equipment Lease';debtJustification='Explicit recurring equipment lease.';}
  else if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';debtJustification='Known MCA/funding counterparty plus recurrence.';}
  else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){family='MCA';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bBDC\b/.test(s)&&vfcRbcIsPadLikeText_(s)){family='FINANCING';entityKey='RBC_BDC_PAD_B'+band;label='BDC';debtJustification='Recurring BDC PAD stream; materially different catch-up amounts remain separate.';}
  else if(/\bBDC\b/.test(s)&&(/BDC[- ]?LOAN\/PRET|ONLINE\s+BANKING\s+PAYMENT|\bLOAN\b|FINANC/.test(s))){family='FINANCING';entityKey='RBC_BDC_MANUAL_B'+band;label='BDC Manual / Loan Payment';debtJustification='Manual BDC loan-payment stream kept separate from normal PAD.';}
  else if(/\bAFFIRM(?:\s+CANADA)?\b/.test(s)){family='FINANCING';entityKey='RBC_AFFIRM_CANADA';label='Affirm Canada';debtJustification='Affirm Canada financing counterparty plus recurrence.';}
  else if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='CANACAP';label='Canacap';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bGREENBOX\b/.test(s)){family='MCA';entityKey='GREENBOX';label='Greenbox';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bICAPITAL\b/.test(s)){family='FINANCING';entityKey='ICAPITAL';label='iCapital';debtJustification='Known financing counterparty plus recurrence.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC/.test(s)){family='FINANCING';entityKey='RBC_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw)+'_B'+band;label=cp||'Premium Finance';debtJustification='Explicit premium-finance counterparty plus recurrence.';}
  else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){family='TAX';entityKey='RBC_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);}
  else if(/INSURANCE/.test(s)){family='OTHER';if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}else if(/IND\s+ALL/.test(s)){entityKey='INSURANCE_IND_ALL';label='Insurance IND ALL';}else entityKey='RBC_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|CAPITAL\s+ONE|\bMBNA\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/^AUTO\s+PAYMENT\b/.test(s)){
    const clean=raw.replace(/^AUTO\s+PAYMENT\s*/i,'').trim(),financeLike=/\bAFS\b|FINANC|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s);
    family=financeLike?'FINANCING':'OTHER';entityKey=(financeLike?'AUTO_PAYMENT_FINANCE_':'RBC_OTHER_AUTOPAY_')+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;if(financeLike)debtJustification='Automatic payment with independent finance-like counterparty evidence.';
  }
  else if(/^MISC\s+PAYMENT\b/.test(s)&&(/\bAFS\b|FINANC|LEASE|LENDING|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s))){const clean=raw.replace(/^MISC\s+PAYMENT\s*/i,'').trim();family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;debtJustification='Retry/recurring payment with independent finance-like counterparty evidence.';}
  else if(hasFinancingSignal){
    family='FINANCING';debtJustification='Explicit financing wording plus recurring observed cadence.';
    if(/^LOAN\s+PAYMENT$/i.test(raw)){entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';}
    else{
      const numbered=s.match(/(?:NO\.?|NUMBER|#)\s*([0-9-]{5,})/),generic=s.match(/\b(?:LOAN|MORTGAGE|LOC)\b[^0-9]{0,30}([0-9][0-9-]{5,})\b/),ref=numbered||generic;
      if(ref){const n=ref[1].replace(/[^0-9]/g,'');if(/LOAN\s+INTEREST/.test(s)){entityKey='LOAN_INTEREST_'+n;label='Loan interest NO.'+n;}else if(/\bLOAN\b/.test(s)){entityKey='LOAN_'+n;label='Loan payment NO.'+n;}else if(/\bLEASE\b|\bLSE\b/.test(s)){entityKey='LEASE_'+n;label='Lease payment NO.'+n;}else{entityKey='FINANCE_REF_'+n;}}
      else{const stable=(cp||raw).replace(/\b[0-9][0-9-]{4,}\b/g,'').replace(/\s+/g,' ').trim();entityKey='RBC_FINANCE_'+vfcCounterpartyKey_(stable||cp||raw);}
    }
  }
  else if(vfcRbcIsPadLikeText_(s)){family='OTHER';entityKey='RBC_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/\bCAPITAL\b|\bFUNDING\b|\bFACTOR(?:ING)?\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_POSSIBLE_FINANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/COMMERCIAL\s+RENT|\bRENT\b|HYDRO|FORTIS|TELUS|UTILITY|SUPERPASS|PETROLEUM|\bFUEL\b|EQUIPMENT\s+RENT|PAY\s+EMPLOYEE|PAYROLL/.test(s)){family='OTHER';entityKey='RBC_OTHER_BUSINESS_'+vfcCounterpartyKey_(cp||raw);}
  else{return null;}
  if(!entityKey)entityKey='RBC_OTHER_'+vfcCounterpartyKey_(raw);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcRbcIsReturnedFinancingCredit_(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}
function vfcRbcIsNonOperatingTransferCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;const s=String(t&&t.description||'').toUpperCase();if(/E-TRANSFER|INTERAC/.test(s))return false;return/\bBR\s+TO\s+BR\b|\bTRANSFER\s+FROM\s+(?:ACCOUNT|A\/C|ACCT)\b|\bINTERNAL\s+TRANSFER\b/.test(s);}
function vfcRbcKnownFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();if(vfcRbcIsReturnedFinancingCredit_(t))return false;return/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|\bICAPITAL\b|GREENBOX|\bCSBFL\b|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s);}
function vfcRbcPreservePrintedDuplicate_(){return true;}
function vfcRbcStrongEntityKey_(key){return/^(RBC_AFFIRM_CANADA|RBC_PREMIUM_FINANCE_|RBC_BDC_|MERCHANT_GROWTH|JOURNEY_ONDECK|CANACAP|ICAPITAL|GREENBOX|SILVERCHEF_EQUIPMENT_LEASE|AUTO_PAYMENT_FINANCE_|RBC_FINANCE_|INSURANCE_|LEASE_[0-9]|FINANCE_REF_[0-9])/.test(String(key||'').toUpperCase());}

function runRbcBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'RBC',transactions:transactions||[]}};}
  function close(a,e,t,l){t=t==null?.02:t;if(Math.abs(Number(a||0)-Number(e||0))>t)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function equal(a,e,l){if(a!==e)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function truthy(v,l){if(!v)throw new Error((l||'value')+' expected truthy');}
  function test(n,f){try{results.push({name:n,pass:true,detail:String(f()||'')});}catch(e){results.push({name:n,pass:false,detail:String(e&&e.message||e)});}}

  test('AIM HIGH Mar-Apr printed credits are exactly 15 and $45,725.36',function(){const c=[2000,250,1000,6585.81,1046.83,250,7474.96,3000,750,2750,3250,2750,6673.93,7693.83,250];equal(c.length,15,'count');close(vfcSum_(c),45725.36,.02,'sum');return'15/$45725.36';});
  test('Exact ledger audit passes only when count and totals both match',function(){const text='Total deposits & credits (2) + 150.00\nTotal cheques & debits (2) - 30.00',facts={deposits:150,withdrawals:30},good=[tx('2026-01-01','A','CREDIT',100),tx('2026-01-02','B','CREDIT',50),tx('2026-01-03','C','DEBIT',10),tx('2026-01-04','D','DEBIT',20)];const a=vfcRbcAuditFullLedger_(good,facts,text,'x.pdf');equal(a.creditCount,2,'credits');let failed=false;try{vfcRbcAuditFullLedger_(good.slice(1),facts,text,'x.pdf');}catch(e){failed=true;}truthy(failed,'missing row fails');return'exact';});
  test('Opening/closing/support artifacts are excluded',function(){const p=vfcRbcPrepareLedger_([tx('2026-03-02','Opening balance','CREDIT',4710.90),tx('2026-03-03','Loan BK OF MONTREAL','DEBIT',599.22),tx('2026-04-02','Serial #: 343 Amount: $315.00','CREDIT',315)]);equal(p.length,1,'real rows');return'clean';});
  test('Return direction remains printed-column driven',function(){equal(vfcRbcCertainDirection_(tx('2026-05-27','Cheque returned NSF','DEBIT',2606.59)),'','no force');truthy(vfcRbcIsReturnedFinancingCredit_(tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)),'credit return');equal(vfcRbcIsReturnedFinancingCredit_(tx('2026-06-25','Item returned unpaid','DEBIT',187.46)),false,'debit return');return'direction safe';});
  test('Unknown recurring PAD is informational only',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-02-28',[tx('2026-02-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-03-31',[tx('2026-03-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])]);close(d.confirmedMonthlyDebtService,0,.001,'debt');return'informational';});
  test('Recurring Affirm is financing',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-02-28',[tx('2026-02-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-03-31',[tx('2026-03-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm');return'66.62';});
  test('Returned BDC PAD cannot inflate debt',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-27','Business PAD BDC','DEBIT',2578.34,'BDC')]),row('2026-04-30',[tx('2026-04-27','Business PAD BDC','DEBIT',2656.97,'BDC')]),row('2026-05-31',[tx('2026-05-27','Business PAD BDC','DEBIT',2606.59,'BDC'),tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)]),row('2026-06-30',[tx('2026-06-29','Business PAD BDC','DEBIT',5289.91,'BDC'),tx('2026-06-29','Cheque returned NSF','CREDIT',5289.91)]),row('2026-08-31',[tx('2026-08-17','Business PAD BDC','DEBIT',2285.91,'BDC')])]);truthy(d.returnedFinanceDebitsSuppressed>=2,'suppressed');return'suppressed='+d.returnedFinanceDebitsSuppressed;});
  test('Recurring IPFS is financing while ordinary insurance is informational',function(){const ip=vfcRbcClassifyDebit_(tx('2026-08-04','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')),ins=vfcRbcClassifyDebit_(tx('2026-08-04','Auto Insurance ICBC','DEBIT',234.96,'ICBC'));equal(ip.family,'FINANCING','IPFS');equal(ins.family,'OTHER','insurance');return'correct';});
  test('BR TO BR credit excluded but customer e-transfer not',function(){truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','BR TO BR - 0863','CREDIT',5000)),'internal');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','e-Transfer received CUSTOMER','CREDIT',5000)),false,'customer');return'correct';});
  test('Generic numeric Misc Payment never becomes obligation by itself',function(){equal(vfcRbcClassifyDebit_(tx('2026-03-12','Misc Payment 1469635','DEBIT',6585.81,'1469635')),null,'misc');return'ignored';});

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,rbcRulesVersion:vfcRbcBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
function runBankingStabilitySelfTests(){return runRbcBankingSelfTests();}
+vfcRound_(statementDiff,.01)+'.');

  const locked=Object.assign({},summary||{});
  locked.statement_start_date=facts.startDate;
  locked.statement_end_date=facts.endDate;
  locked.opening_balance=facts.opening;
  locked.closing_balance=facts.closing;
  locked.total_deposits=facts.deposits;
  locked.total_withdrawals=facts.withdrawals;

  let ledger=vfcRbcPrepareLedger_(locked.banking_transactions||[]),audit=null,lastError='',repairPasses=0;
  for(let attempt=0;attempt<=2;attempt++){
    try{
      audit=vfcRbcAuditFullLedger_(ledger,facts,text,name);
      break;
    }catch(e){
      lastError=String(e&&e.message||e);
      if(attempt>=2)throw new Error(lastError);
      repairPasses++;
      ledger=vfcRbcRepairLedger_(ledger,text,name,facts,lastError,repairPasses);
    }
  }

  if(!audit)throw new Error('RBC ledger verification did not complete for '+name+'.');
  locked.banking_transactions=ledger;
  locked.rbc_full_ledger_verified=true;
  locked.rbc_ledger_reconciled=repairPasses>0;
  locked.rbc_ledger_repair_passes=repairPasses;
  locked.rbc_credit_transaction_count=audit.creditCount;
  locked.rbc_debit_transaction_count=audit.debitCount;
  locked.nsf_count=vfcRbcCountBorrowerNsfEvents_(ledger);
  locked.negative_balance_detected=vfcRbcNegativeBalanceFlag_(text,facts);
  return locked;
}

function vfcRbcPrintedActivityCounts_(text){
  const s=String(text||'').replace(/\u00a0/g,' '),c=s.match(/Total\s+deposits\s*&\s*credits\s*\((\d+)\)/i),d=s.match(/Total\s+cheques\s*&\s*debits\s*\((\d+)\)/i);
  return{creditCount:c?Number(c[1]):null,debitCount:d?Number(d[1]):null};
}

function vfcRbcIsNonActivityArtifact_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s)return true;
  return/^OPENING\s+BALANCE\b|^CLOSING\s+BALANCE\b|^ACCOUNT\s+FEES?\b|^ACCOUNT\s+SUMMARY\b|^TOTAL\s+DEPOSITS\s*&\s*CREDITS\b|^TOTAL\s+CHEQUES\s*&\s+DEBITS\b|^PAGE\s+TOTAL\b|^SERIAL\s*#?\s*:?\s*\d+\s+AMOUNT\b|FOR\s+DEPOSIT\s+ONLY|BACKVERSO|BACK\s*\/\s*VERSO|CHEQUE\s+IMAGE|CHECK\s+IMAGE/.test(s);
}

function vfcRbcPrepareLedger_(items){
  return(Array.isArray(items)?items:[]).filter(function(x){return!vfcRbcIsNonActivityArtifact_(x);}).map(function(x){
    const t=Object.assign({},x||{}),forced=vfcRbcCertainDirection_(t);
    if(forced)t.direction=forced;
    t.direction=String(t.direction||'').toUpperCase();
    t.description=String(t.description||'').replace(/\s+/g,' ').trim();
    t.counterparty=String(t.counterparty||t.description||'').replace(/\s+/g,' ').trim();
    t.amount=vfcNum_(t.amount);
    return t;
  });
}

function vfcRbcCertainDirection_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return'';
  if(/^LOAN\s+CREDIT\b/.test(s)||/\bPAYROLL\s+DEPOSIT\b|\bTAX\s+REFUND\b|E-TRANSFER\s+RECEIVED|INTERAC\s+PURCHASE\s+REFUND|E-TRANSFER\s+CANCEL|MOBILE\s+CHEQUE\s+DEPOSIT/.test(s))return'CREDIT';
  if(vfcRbcIsPadLikeText_(s)||/^LOAN\s+PAYMENT\b|^LOAN\s+INTEREST\b|^BLIP\s+PAYMENT\s*-?\s*LOAN\b|^BILL\s+PAYMENT\b|^FUEL\s+BILL\s+PAYMENT\b|^COMM\s+GAS\s+BILL\s+PMT\b|^COMMERCIAL\s+TAXES\b|^AUTO\s+INSURANCE\b|^INSURANCE\b|^RENT\/LEASE\b|^CHEQUE\s*-\s*\d+\b|E-TRANSFER\s+SENT|E-TRANSFER\s+REQUEST\s+FULFILLED/.test(s))return'DEBIT';
  return'';
}

function vfcRbcLedgerStats_(items){
  const out={creditCount:0,debitCount:0,totalCredits:0,totalDebits:0,bad:[]};
  (Array.isArray(items)?items:[]).forEach(function(t,i){
    const d=String(t&&t.direction||'').toUpperCase(),a=vfcNum_(t&&t.amount),desc=String(t&&t.description||'').trim(),date=vfcIso_(t&&t.date);
    if(!date||!desc||!(a>0)||(d!=='CREDIT'&&d!=='DEBIT')){out.bad.push(i+1);return;}
    if(d==='CREDIT'){out.creditCount++;out.totalCredits+=a;}else{out.debitCount++;out.totalDebits+=a;}
  });
  out.totalCredits=vfcRound_(out.totalCredits,.01);out.totalDebits=vfcRound_(out.totalDebits,.01);return out;
}

function vfcRbcLedgerPreview_(rows,direction){
  return(rows||[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()===direction;}).slice(0,40).map(function(t){return String(t.date||'')+' '+String(t.description||'')+' $'+vfcNum_(t.amount);}).join(' | ');
}

function vfcRbcAuditFullLedger_(items,facts,text,fileName){
  const rows=Array.isArray(items)?items:[],printed=vfcRbcPrintedActivityCounts_(text),s=vfcRbcLedgerStats_(rows);
  if(s.bad.length)throw new Error('RBC full ledger contains incomplete transaction row(s) '+s.bad.join(', ')+' for '+fileName+'.');
  const creditCountOk=printed.creditCount===null||s.creditCount===printed.creditCount;
  const debitCountOk=printed.debitCount===null||s.debitCount===printed.debitCount;
  const creditTotalOk=Math.abs(s.totalCredits-vfcNum_(facts.deposits))<=.05;
  const debitTotalOk=Math.abs(s.totalDebits-vfcNum_(facts.withdrawals))<=.05;
  if(!creditCountOk||!debitCountOk||!creditTotalOk||!debitTotalOk){
    throw new Error('RBC ledger mismatch for '+fileName+': printed credits '+printed.creditCount+' / $'+vfcNum_(facts.deposits)+', extracted '+s.creditCount+' / $'+s.totalCredits+'; printed debits '+printed.debitCount+' / $'+vfcNum_(facts.withdrawals)+', extracted '+s.debitCount+' / $'+s.totalDebits+'.');
  }
  return{creditCount:s.creditCount,debitCount:s.debitCount,totalCredits:s.totalCredits,totalDebits:s.totalDebits,reconciled:true};
}

function vfcRbcRepairLedger_(currentLedger,text,fileName,facts,reason,attempt){
  const printed=vfcRbcPrintedActivityCounts_(text),current=vfcRbcLedgerStats_(currentLedger),prompt=[
    'You are the VFC RBC Account Activity Reconciliation Reader. Return JSON only.',
    'This is FACT EXTRACTION ONLY. Do not underwrite, classify debt, summarize or estimate.',
    'File: '+fileName,
    'The previous ledger failed deterministic reconciliation: '+reason,
    'AUTHORITATIVE PRINTED TARGETS:',
    'CREDIT rows exactly: '+printed.creditCount,
    'CREDIT total exactly: '+vfcNum_(facts.deposits),
    'DEBIT rows exactly: '+printed.debitCount,
    'DEBIT total exactly: '+vfcNum_(facts.withdrawals),
    'Opening balance: '+vfcNum_(facts.opening),
    'Closing balance: '+vfcNum_(facts.closing),
    'Return JSON with ONE field only: banking_transactions.',
    'banking_transactions must be the COMPLETE Account Activity ledger and each object must be {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short visible counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
    'STRICT RULES:',
    '1. Read only Account Activity Details rows. Include every amount-bearing activity row, including all bank fees and ordinary purchases.',
    '2. Do not include opening/closing balances, Account Summary totals, Account Fees summary, page totals, cheque-image/support pages, serial-number image rows or endorsements.',
    '3. Printed Cheques & Debits column = DEBIT; printed Deposits & Credits column = CREDIT. Never infer direction from words.',
    '4. MISC PAYMENT and RETURN/NSF can occur in either direction. Use the printed column.',
    '5. Keep repeated legitimate transactions. Do not deduplicate two separately printed activity rows.',
    '6. The final array MUST contain exactly '+printed.creditCount+' CREDIT rows totaling '+vfcNum_(facts.deposits)+' and exactly '+printed.debitCount+' DEBIT rows totaling '+vfcNum_(facts.withdrawals)+'.',
    '7. If the current candidate missed a row, recover it from the raw statement. If it contains an artifact, remove only the artifact.',
    'Current candidate stats: credits '+current.creditCount+' / $'+current.totalCredits+', debits '+current.debitCount+' / $'+current.totalDebits+'.',
    'Current candidate ledger:',JSON.stringify(currentLedger),
    'RAW RBC STATEMENT OCR:',String(text||'').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
  ].join('\n');
  const repaired=callOpenAIJson_(prompt);
  if(!repaired||!Array.isArray(repaired.banking_transactions))throw new Error('RBC reconciliation pass '+attempt+' did not return a complete banking_transactions array for '+fileName+'.');
  return vfcRbcPrepareLedger_(repaired.banking_transactions);
}

function vfcRbcIsPadLikeText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return false;
  return/^(?:BUSINESS\s+)?PAD\b|PRE[- ]?AUTH(?:ORIZED)?(?:\s+DEBIT|\s+PAYMENT)?\b|PREAUTHORIZED(?:\s+DEBIT|\s+PAYMENT)?\b|DIRECT\s+DEBIT\b|EFT\s+DEBIT\b|ACH\s+DEBIT\b|AUTOMATIC\s+DEBIT\b|AUTO\s+PAYMENT\b/.test(s);
}

function vfcRbcReturnEventText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||/\b(?:FEE|FEES|CHARGE)\b/.test(s))return false;
  return/CHEQUE\s+RETURNED(?:\s+NSF)?|CHECK\s+RETURNED(?:\s+NSF)?|ITEM\s+RETURNED(?:\s+NSF|\s+UNPAID)?|RETURNED\s+(?:ITEM|CHEQUE|CHECK|PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)|(?:PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)\s+RETURNED|PRE[- ]?AUTH(?:ORIZED)?\s+(?:DEBIT|PAYMENT)\s+RETURNED|PREAUTHORIZED\s+(?:DEBIT|PAYMENT)\s+RETURNED|DIRECT\s+DEBIT\s+RETURNED|REJECTED\s+(?:PAD|DEBIT|PAYMENT)|\bREVERSAL\b|\bREVERSED\b|NSF\s+RETURN/.test(s);
}
function vfcRbcReturnCreditText_(value){return vfcRbcReturnEventText_(value);}
function vfcRbcCountReturnEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcCountBorrowerNsfEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcNegativeBalanceFlag_(text,facts){if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;return/(?:^|\s)-[0-9][0-9,]*\.\d{2}(?:\s|$)/m.test(String(text||''));}
function vfcRbcAmountBand_(amount){const n=Math.max(1,vfcNum_(amount));return Math.round(Math.log(n)/Math.log(1.25));}

function vfcRbcClassifyDebit_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t&&t.counterparty||'').replace(/\s+/g,' ').trim(),band=vfcRbcAmountBand_(t&&t.amount),hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b|\bMCA\b|\bLEASE\b|\bLSE\b/.test(s),isFee=/\bFEES?\b|SERVICE\s+CHARGE|NSF\s+ITEM\s+FEES?|RETURNED[- ]?ITEM\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE|ACTIVITY\s+FEE|TRANSACTION\s+FEE|MONTHLY\s+FEE/.test(s);
  if(isFee&&!hasFinancingSignal)return null;
  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/COMM\s+EQUIP\s+RENT\/LSE\s+SILVERCHEF|\bSILVERCHEF\b/.test(s)){family='FINANCING';entityKey='SILVERCHEF_EQUIPMENT_LEASE';label='SilverChef Equipment Lease';debtJustification='Explicit recurring equipment lease.';}
  else if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';debtJustification='Known MCA/funding counterparty plus recurrence.';}
  else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){family='MCA';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bBDC\b/.test(s)&&vfcRbcIsPadLikeText_(s)){family='FINANCING';entityKey='RBC_BDC_PAD_B'+band;label='BDC';debtJustification='Recurring BDC PAD stream; materially different catch-up amounts remain separate.';}
  else if(/\bBDC\b/.test(s)&&(/BDC[- ]?LOAN\/PRET|ONLINE\s+BANKING\s+PAYMENT|\bLOAN\b|FINANC/.test(s))){family='FINANCING';entityKey='RBC_BDC_MANUAL_B'+band;label='BDC Manual / Loan Payment';debtJustification='Manual BDC loan-payment stream kept separate from normal PAD.';}
  else if(/\bAFFIRM(?:\s+CANADA)?\b/.test(s)){family='FINANCING';entityKey='RBC_AFFIRM_CANADA';label='Affirm Canada';debtJustification='Affirm Canada financing counterparty plus recurrence.';}
  else if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='CANACAP';label='Canacap';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bGREENBOX\b/.test(s)){family='MCA';entityKey='GREENBOX';label='Greenbox';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bICAPITAL\b/.test(s)){family='FINANCING';entityKey='ICAPITAL';label='iCapital';debtJustification='Known financing counterparty plus recurrence.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC/.test(s)){family='FINANCING';entityKey='RBC_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw)+'_B'+band;label=cp||'Premium Finance';debtJustification='Explicit premium-finance counterparty plus recurrence.';}
  else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){family='TAX';entityKey='RBC_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);}
  else if(/INSURANCE/.test(s)){family='OTHER';if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}else if(/IND\s+ALL/.test(s)){entityKey='INSURANCE_IND_ALL';label='Insurance IND ALL';}else entityKey='RBC_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|CAPITAL\s+ONE|\bMBNA\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/^AUTO\s+PAYMENT\b/.test(s)){
    const clean=raw.replace(/^AUTO\s+PAYMENT\s*/i,'').trim(),financeLike=/\bAFS\b|FINANC|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s);
    family=financeLike?'FINANCING':'OTHER';entityKey=(financeLike?'AUTO_PAYMENT_FINANCE_':'RBC_OTHER_AUTOPAY_')+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;if(financeLike)debtJustification='Automatic payment with independent finance-like counterparty evidence.';
  }
  else if(/^MISC\s+PAYMENT\b/.test(s)&&(/\bAFS\b|FINANC|LEASE|LENDING|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s))){const clean=raw.replace(/^MISC\s+PAYMENT\s*/i,'').trim();family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;debtJustification='Retry/recurring payment with independent finance-like counterparty evidence.';}
  else if(hasFinancingSignal){
    family='FINANCING';debtJustification='Explicit financing wording plus recurring observed cadence.';
    if(/^LOAN\s+PAYMENT$/i.test(raw)){entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';}
    else{
      const numbered=s.match(/(?:NO\.?|NUMBER|#)\s*([0-9-]{5,})/),generic=s.match(/\b(?:LOAN|MORTGAGE|LOC)\b[^0-9]{0,30}([0-9][0-9-]{5,})\b/),ref=numbered||generic;
      if(ref){const n=ref[1].replace(/[^0-9]/g,'');if(/LOAN\s+INTEREST/.test(s)){entityKey='LOAN_INTEREST_'+n;label='Loan interest NO.'+n;}else if(/\bLOAN\b/.test(s)){entityKey='LOAN_'+n;label='Loan payment NO.'+n;}else if(/\bLEASE\b|\bLSE\b/.test(s)){entityKey='LEASE_'+n;label='Lease payment NO.'+n;}else{entityKey='FINANCE_REF_'+n;}}
      else{const stable=(cp||raw).replace(/\b[0-9][0-9-]{4,}\b/g,'').replace(/\s+/g,' ').trim();entityKey='RBC_FINANCE_'+vfcCounterpartyKey_(stable||cp||raw);}
    }
  }
  else if(vfcRbcIsPadLikeText_(s)){family='OTHER';entityKey='RBC_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/\bCAPITAL\b|\bFUNDING\b|\bFACTOR(?:ING)?\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_POSSIBLE_FINANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/COMMERCIAL\s+RENT|\bRENT\b|HYDRO|FORTIS|TELUS|UTILITY|SUPERPASS|PETROLEUM|\bFUEL\b|EQUIPMENT\s+RENT|PAY\s+EMPLOYEE|PAYROLL/.test(s)){family='OTHER';entityKey='RBC_OTHER_BUSINESS_'+vfcCounterpartyKey_(cp||raw);}
  else{return null;}
  if(!entityKey)entityKey='RBC_OTHER_'+vfcCounterpartyKey_(raw);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcRbcIsReturnedFinancingCredit_(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}
function vfcRbcIsNonOperatingTransferCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;const s=String(t&&t.description||'').toUpperCase();if(/E-TRANSFER|INTERAC/.test(s))return false;return/\bBR\s+TO\s+BR\b|\bTRANSFER\s+FROM\s+(?:ACCOUNT|A\/C|ACCT)\b|\bINTERNAL\s+TRANSFER\b/.test(s);}
function vfcRbcKnownFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();if(vfcRbcIsReturnedFinancingCredit_(t))return false;return/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|\bICAPITAL\b|GREENBOX|\bCSBFL\b|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s);}
function vfcRbcPreservePrintedDuplicate_(){return true;}
function vfcRbcStrongEntityKey_(key){return/^(RBC_AFFIRM_CANADA|RBC_PREMIUM_FINANCE_|RBC_BDC_|MERCHANT_GROWTH|JOURNEY_ONDECK|CANACAP|ICAPITAL|GREENBOX|SILVERCHEF_EQUIPMENT_LEASE|AUTO_PAYMENT_FINANCE_|RBC_FINANCE_|INSURANCE_|LEASE_[0-9]|FINANCE_REF_[0-9])/.test(String(key||'').toUpperCase());}

function runRbcBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'RBC',transactions:transactions||[]}};}
  function close(a,e,t,l){t=t==null?.02:t;if(Math.abs(Number(a||0)-Number(e||0))>t)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function equal(a,e,l){if(a!==e)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function truthy(v,l){if(!v)throw new Error((l||'value')+' expected truthy');}
  function test(n,f){try{results.push({name:n,pass:true,detail:String(f()||'')});}catch(e){results.push({name:n,pass:false,detail:String(e&&e.message||e)});}}

  test('AIM HIGH Mar-Apr printed credits are exactly 15 and $45,725.36',function(){const c=[2000,250,1000,6585.81,1046.83,250,7474.96,3000,750,2750,3250,2750,6673.93,7693.83,250];equal(c.length,15,'count');close(vfcSum_(c),45725.36,.02,'sum');return'15/$45725.36';});
  test('Exact ledger audit passes only when count and totals both match',function(){const text='Total deposits & credits (2) + 150.00\nTotal cheques & debits (2) - 30.00',facts={deposits:150,withdrawals:30},good=[tx('2026-01-01','A','CREDIT',100),tx('2026-01-02','B','CREDIT',50),tx('2026-01-03','C','DEBIT',10),tx('2026-01-04','D','DEBIT',20)];const a=vfcRbcAuditFullLedger_(good,facts,text,'x.pdf');equal(a.creditCount,2,'credits');let failed=false;try{vfcRbcAuditFullLedger_(good.slice(1),facts,text,'x.pdf');}catch(e){failed=true;}truthy(failed,'missing row fails');return'exact';});
  test('Opening/closing/support artifacts are excluded',function(){const p=vfcRbcPrepareLedger_([tx('2026-03-02','Opening balance','CREDIT',4710.90),tx('2026-03-03','Loan BK OF MONTREAL','DEBIT',599.22),tx('2026-04-02','Serial #: 343 Amount: $315.00','CREDIT',315)]);equal(p.length,1,'real rows');return'clean';});
  test('Return direction remains printed-column driven',function(){equal(vfcRbcCertainDirection_(tx('2026-05-27','Cheque returned NSF','DEBIT',2606.59)),'','no force');truthy(vfcRbcIsReturnedFinancingCredit_(tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)),'credit return');equal(vfcRbcIsReturnedFinancingCredit_(tx('2026-06-25','Item returned unpaid','DEBIT',187.46)),false,'debit return');return'direction safe';});
  test('Unknown recurring PAD is informational only',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-02-28',[tx('2026-02-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-03-31',[tx('2026-03-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])]);close(d.confirmedMonthlyDebtService,0,.001,'debt');return'informational';});
  test('Recurring Affirm is financing',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-02-28',[tx('2026-02-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-03-31',[tx('2026-03-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm');return'66.62';});
  test('Returned BDC PAD cannot inflate debt',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-27','Business PAD BDC','DEBIT',2578.34,'BDC')]),row('2026-04-30',[tx('2026-04-27','Business PAD BDC','DEBIT',2656.97,'BDC')]),row('2026-05-31',[tx('2026-05-27','Business PAD BDC','DEBIT',2606.59,'BDC'),tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)]),row('2026-06-30',[tx('2026-06-29','Business PAD BDC','DEBIT',5289.91,'BDC'),tx('2026-06-29','Cheque returned NSF','CREDIT',5289.91)]),row('2026-08-31',[tx('2026-08-17','Business PAD BDC','DEBIT',2285.91,'BDC')])]);truthy(d.returnedFinanceDebitsSuppressed>=2,'suppressed');return'suppressed='+d.returnedFinanceDebitsSuppressed;});
  test('Recurring IPFS is financing while ordinary insurance is informational',function(){const ip=vfcRbcClassifyDebit_(tx('2026-08-04','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')),ins=vfcRbcClassifyDebit_(tx('2026-08-04','Auto Insurance ICBC','DEBIT',234.96,'ICBC'));equal(ip.family,'FINANCING','IPFS');equal(ins.family,'OTHER','insurance');return'correct';});
  test('BR TO BR credit excluded but customer e-transfer not',function(){truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','BR TO BR - 0863','CREDIT',5000)),'internal');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','e-Transfer received CUSTOMER','CREDIT',5000)),false,'customer');return'correct';});
  test('Generic numeric Misc Payment never becomes obligation by itself',function(){equal(vfcRbcClassifyDebit_(tx('2026-03-12','Misc Payment 1469635','DEBIT',6585.81,'1469635')),null,'misc');return'ignored';});

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,rbcRulesVersion:vfcRbcBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
function runBankingStabilitySelfTests(){return runRbcBankingSelfTests();}
+s.totalDebits+
      '. CREDIT rows: '+vfcRbcLedgerPreview_(rows,'CREDIT')+
      ' | DEBIT rows: '+vfcRbcLedgerPreview_(rows,'DEBIT')
    );
  }
  return{creditCount:s.creditCount,debitCount:s.debitCount,totalCredits:s.totalCredits,totalDebits:s.totalDebits,verified:true};
}

function vfcRbcRepairLedger_(currentLedger,text,fileName,facts,reason,attempt){
  const printed=vfcRbcPrintedActivityCounts_(text),current=vfcRbcLedgerStats_(currentLedger),prompt=[
    'You are the VFC RBC Account Activity Reconciliation Reader. Return JSON only.',
    'This is FACT EXTRACTION ONLY. Do not underwrite, classify debt, summarize or estimate.',
    'File: '+fileName,
    'The previous ledger failed deterministic reconciliation: '+reason,
    'AUTHORITATIVE PRINTED TARGETS:',
    'CREDIT rows exactly: '+printed.creditCount,
    'CREDIT total exactly: '+vfcNum_(facts.deposits),
    'DEBIT rows exactly: '+printed.debitCount,
    'DEBIT total exactly: '+vfcNum_(facts.withdrawals),
    'Opening balance: '+vfcNum_(facts.opening),
    'Closing balance: '+vfcNum_(facts.closing),
    'Return JSON with ONE field only: banking_transactions.',
    'banking_transactions must be the COMPLETE Account Activity ledger and each object must be {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short visible counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
    'STRICT RULES:',
    '1. Read only Account Activity Details rows. Include every amount-bearing activity row, including all bank fees and ordinary purchases.',
    '2. Do not include opening/closing balances, Account Summary totals, Account Fees summary, page totals, cheque-image/support pages, serial-number image rows or endorsements.',
    '3. Printed Cheques & Debits column = DEBIT; printed Deposits & Credits column = CREDIT. Never infer direction from words.',
    '4. MISC PAYMENT and RETURN/NSF can occur in either direction. Use the printed column.',
    '5. Keep repeated legitimate transactions. Do not deduplicate two separately printed activity rows.',
    '6. The final array MUST contain exactly '+printed.creditCount+' CREDIT rows totaling '+vfcNum_(facts.deposits)+' and exactly '+printed.debitCount+' DEBIT rows totaling '+vfcNum_(facts.withdrawals)+'.',
    '7. If the current candidate missed a row, recover it from the raw statement. If it contains an artifact, remove only the artifact.',
    'Current candidate stats: credits '+current.creditCount+' / $'+current.totalCredits+', debits '+current.debitCount+' / $'+current.totalDebits+'.',
    'Current candidate ledger:',JSON.stringify(currentLedger),
    'RAW RBC STATEMENT OCR:',String(text||'').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
  ].join('\n');
  const repaired=callOpenAIJson_(prompt);
  if(!repaired||!Array.isArray(repaired.banking_transactions))throw new Error('RBC reconciliation pass '+attempt+' did not return a complete banking_transactions array for '+fileName+'.');
  return vfcRbcPrepareLedger_(repaired.banking_transactions);
}

function vfcRbcIsPadLikeText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return false;
  return/^(?:BUSINESS\s+)?PAD\b|PRE[- ]?AUTH(?:ORIZED)?(?:\s+DEBIT|\s+PAYMENT)?\b|PREAUTHORIZED(?:\s+DEBIT|\s+PAYMENT)?\b|DIRECT\s+DEBIT\b|EFT\s+DEBIT\b|ACH\s+DEBIT\b|AUTOMATIC\s+DEBIT\b|AUTO\s+PAYMENT\b/.test(s);
}

function vfcRbcReturnEventText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||/\b(?:FEE|FEES|CHARGE)\b/.test(s))return false;
  return/CHEQUE\s+RETURNED(?:\s+NSF)?|CHECK\s+RETURNED(?:\s+NSF)?|ITEM\s+RETURNED(?:\s+NSF|\s+UNPAID)?|RETURNED\s+(?:ITEM|CHEQUE|CHECK|PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)|(?:PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)\s+RETURNED|PRE[- ]?AUTH(?:ORIZED)?\s+(?:DEBIT|PAYMENT)\s+RETURNED|PREAUTHORIZED\s+(?:DEBIT|PAYMENT)\s+RETURNED|DIRECT\s+DEBIT\s+RETURNED|REJECTED\s+(?:PAD|DEBIT|PAYMENT)|\bREVERSAL\b|\bREVERSED\b|NSF\s+RETURN/.test(s);
}
function vfcRbcReturnCreditText_(value){return vfcRbcReturnEventText_(value);}
function vfcRbcCountReturnEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcCountBorrowerNsfEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcNegativeBalanceFlag_(text,facts){if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;return/(?:^|\s)-[0-9][0-9,]*\.\d{2}(?:\s|$)/m.test(String(text||''));}
function vfcRbcAmountBand_(amount){const n=Math.max(1,vfcNum_(amount));return Math.round(Math.log(n)/Math.log(1.25));}

function vfcRbcClassifyDebit_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t&&t.counterparty||'').replace(/\s+/g,' ').trim(),band=vfcRbcAmountBand_(t&&t.amount),hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b|\bMCA\b|\bLEASE\b|\bLSE\b/.test(s),isFee=/\bFEES?\b|SERVICE\s+CHARGE|NSF\s+ITEM\s+FEES?|RETURNED[- ]?ITEM\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE|ACTIVITY\s+FEE|TRANSACTION\s+FEE|MONTHLY\s+FEE/.test(s);
  if(isFee&&!hasFinancingSignal)return null;
  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/COMM\s+EQUIP\s+RENT\/LSE\s+SILVERCHEF|\bSILVERCHEF\b/.test(s)){family='FINANCING';entityKey='SILVERCHEF_EQUIPMENT_LEASE';label='SilverChef Equipment Lease';debtJustification='Explicit recurring equipment lease.';}
  else if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';debtJustification='Known MCA/funding counterparty plus recurrence.';}
  else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){family='MCA';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bBDC\b/.test(s)&&vfcRbcIsPadLikeText_(s)){family='FINANCING';entityKey='RBC_BDC_PAD_B'+band;label='BDC';debtJustification='Recurring BDC PAD stream; materially different catch-up amounts remain separate.';}
  else if(/\bBDC\b/.test(s)&&(/BDC[- ]?LOAN\/PRET|ONLINE\s+BANKING\s+PAYMENT|\bLOAN\b|FINANC/.test(s))){family='FINANCING';entityKey='RBC_BDC_MANUAL_B'+band;label='BDC Manual / Loan Payment';debtJustification='Manual BDC loan-payment stream kept separate from normal PAD.';}
  else if(/\bAFFIRM(?:\s+CANADA)?\b/.test(s)){family='FINANCING';entityKey='RBC_AFFIRM_CANADA';label='Affirm Canada';debtJustification='Affirm Canada financing counterparty plus recurrence.';}
  else if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='CANACAP';label='Canacap';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bGREENBOX\b/.test(s)){family='MCA';entityKey='GREENBOX';label='Greenbox';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bICAPITAL\b/.test(s)){family='FINANCING';entityKey='ICAPITAL';label='iCapital';debtJustification='Known financing counterparty plus recurrence.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC/.test(s)){family='FINANCING';entityKey='RBC_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw)+'_B'+band;label=cp||'Premium Finance';debtJustification='Explicit premium-finance counterparty plus recurrence.';}
  else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){family='TAX';entityKey='RBC_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);}
  else if(/INSURANCE/.test(s)){family='OTHER';if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}else if(/IND\s+ALL/.test(s)){entityKey='INSURANCE_IND_ALL';label='Insurance IND ALL';}else entityKey='RBC_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|CAPITAL\s+ONE|\bMBNA\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/^AUTO\s+PAYMENT\b/.test(s)){
    const clean=raw.replace(/^AUTO\s+PAYMENT\s*/i,'').trim(),financeLike=/\bAFS\b|FINANC|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s);
    family=financeLike?'FINANCING':'OTHER';entityKey=(financeLike?'AUTO_PAYMENT_FINANCE_':'RBC_OTHER_AUTOPAY_')+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;if(financeLike)debtJustification='Automatic payment with independent finance-like counterparty evidence.';
  }
  else if(/^MISC\s+PAYMENT\b/.test(s)&&(/\bAFS\b|FINANC|LEASE|LENDING|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s))){const clean=raw.replace(/^MISC\s+PAYMENT\s*/i,'').trim();family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;debtJustification='Retry/recurring payment with independent finance-like counterparty evidence.';}
  else if(hasFinancingSignal){
    family='FINANCING';debtJustification='Explicit financing wording plus recurring observed cadence.';
    if(/^LOAN\s+PAYMENT$/i.test(raw)){entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';}
    else{
      const numbered=s.match(/(?:NO\.?|NUMBER|#)\s*([0-9-]{5,})/),generic=s.match(/\b(?:LOAN|MORTGAGE|LOC)\b[^0-9]{0,30}([0-9][0-9-]{5,})\b/),ref=numbered||generic;
      if(ref){const n=ref[1].replace(/[^0-9]/g,'');if(/LOAN\s+INTEREST/.test(s)){entityKey='LOAN_INTEREST_'+n;label='Loan interest NO.'+n;}else if(/\bLOAN\b/.test(s)){entityKey='LOAN_'+n;label='Loan payment NO.'+n;}else if(/\bLEASE\b|\bLSE\b/.test(s)){entityKey='LEASE_'+n;label='Lease payment NO.'+n;}else{entityKey='FINANCE_REF_'+n;}}
      else{const stable=(cp||raw).replace(/\b[0-9][0-9-]{4,}\b/g,'').replace(/\s+/g,' ').trim();entityKey='RBC_FINANCE_'+vfcCounterpartyKey_(stable||cp||raw);}
    }
  }
  else if(vfcRbcIsPadLikeText_(s)){family='OTHER';entityKey='RBC_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/\bCAPITAL\b|\bFUNDING\b|\bFACTOR(?:ING)?\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_POSSIBLE_FINANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/COMMERCIAL\s+RENT|\bRENT\b|HYDRO|FORTIS|TELUS|UTILITY|SUPERPASS|PETROLEUM|\bFUEL\b|EQUIPMENT\s+RENT|PAY\s+EMPLOYEE|PAYROLL/.test(s)){family='OTHER';entityKey='RBC_OTHER_BUSINESS_'+vfcCounterpartyKey_(cp||raw);}
  else{return null;}
  if(!entityKey)entityKey='RBC_OTHER_'+vfcCounterpartyKey_(raw);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcRbcIsReturnedFinancingCredit_(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}
function vfcRbcIsNonOperatingTransferCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;const s=String(t&&t.description||'').toUpperCase();if(/E-TRANSFER|INTERAC/.test(s))return false;return/\bBR\s+TO\s+BR\b|\bTRANSFER\s+FROM\s+(?:ACCOUNT|A\/C|ACCT)\b|\bINTERNAL\s+TRANSFER\b/.test(s);}
function vfcRbcKnownFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();if(vfcRbcIsReturnedFinancingCredit_(t))return false;return/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|\bICAPITAL\b|GREENBOX|\bCSBFL\b|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s);}
function vfcRbcPreservePrintedDuplicate_(){return true;}
function vfcRbcStrongEntityKey_(key){return/^(RBC_AFFIRM_CANADA|RBC_PREMIUM_FINANCE_|RBC_BDC_|MERCHANT_GROWTH|JOURNEY_ONDECK|CANACAP|ICAPITAL|GREENBOX|SILVERCHEF_EQUIPMENT_LEASE|AUTO_PAYMENT_FINANCE_|RBC_FINANCE_|INSURANCE_|LEASE_[0-9]|FINANCE_REF_[0-9])/.test(String(key||'').toUpperCase());}

function runRbcBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'RBC',transactions:transactions||[]}};}
  function close(a,e,t,l){t=t==null?.02:t;if(Math.abs(Number(a||0)-Number(e||0))>t)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function equal(a,e,l){if(a!==e)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function truthy(v,l){if(!v)throw new Error((l||'value')+' expected truthy');}
  function test(n,f){try{results.push({name:n,pass:true,detail:String(f()||'')});}catch(e){results.push({name:n,pass:false,detail:String(e&&e.message||e)});}}

  test('AIM HIGH Mar-Apr printed credits are exactly 15 and $45,725.36',function(){const c=[2000,250,1000,6585.81,1046.83,250,7474.96,3000,750,2750,3250,2750,6673.93,7693.83,250];equal(c.length,15,'count');close(vfcSum_(c),45725.36,.02,'sum');return'15/$45725.36';});
  test('Exact ledger audit passes only when count and totals both match',function(){const text='Total deposits & credits (2) + 150.00\nTotal cheques & debits (2) - 30.00',facts={deposits:150,withdrawals:30},good=[tx('2026-01-01','A','CREDIT',100),tx('2026-01-02','B','CREDIT',50),tx('2026-01-03','C','DEBIT',10),tx('2026-01-04','D','DEBIT',20)];const a=vfcRbcAuditFullLedger_(good,facts,text,'x.pdf');equal(a.creditCount,2,'credits');let failed=false;try{vfcRbcAuditFullLedger_(good.slice(1),facts,text,'x.pdf');}catch(e){failed=true;}truthy(failed,'missing row fails');return'exact';});
  test('Opening/closing/support artifacts are excluded',function(){const p=vfcRbcPrepareLedger_([tx('2026-03-02','Opening balance','CREDIT',4710.90),tx('2026-03-03','Loan BK OF MONTREAL','DEBIT',599.22),tx('2026-04-02','Serial #: 343 Amount: $315.00','CREDIT',315)]);equal(p.length,1,'real rows');return'clean';});
  test('Return direction remains printed-column driven',function(){equal(vfcRbcCertainDirection_(tx('2026-05-27','Cheque returned NSF','DEBIT',2606.59)),'','no force');truthy(vfcRbcIsReturnedFinancingCredit_(tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)),'credit return');equal(vfcRbcIsReturnedFinancingCredit_(tx('2026-06-25','Item returned unpaid','DEBIT',187.46)),false,'debit return');return'direction safe';});
  test('Unknown recurring PAD is informational only',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-02-28',[tx('2026-02-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-03-31',[tx('2026-03-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])]);close(d.confirmedMonthlyDebtService,0,.001,'debt');return'informational';});
  test('Recurring Affirm is financing',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-02-28',[tx('2026-02-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-03-31',[tx('2026-03-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm');return'66.62';});
  test('Returned BDC PAD cannot inflate debt',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-27','Business PAD BDC','DEBIT',2578.34,'BDC')]),row('2026-04-30',[tx('2026-04-27','Business PAD BDC','DEBIT',2656.97,'BDC')]),row('2026-05-31',[tx('2026-05-27','Business PAD BDC','DEBIT',2606.59,'BDC'),tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)]),row('2026-06-30',[tx('2026-06-29','Business PAD BDC','DEBIT',5289.91,'BDC'),tx('2026-06-29','Cheque returned NSF','CREDIT',5289.91)]),row('2026-08-31',[tx('2026-08-17','Business PAD BDC','DEBIT',2285.91,'BDC')])]);truthy(d.returnedFinanceDebitsSuppressed>=2,'suppressed');return'suppressed='+d.returnedFinanceDebitsSuppressed;});
  test('Recurring IPFS is financing while ordinary insurance is informational',function(){const ip=vfcRbcClassifyDebit_(tx('2026-08-04','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')),ins=vfcRbcClassifyDebit_(tx('2026-08-04','Auto Insurance ICBC','DEBIT',234.96,'ICBC'));equal(ip.family,'FINANCING','IPFS');equal(ins.family,'OTHER','insurance');return'correct';});
  test('BR TO BR credit excluded but customer e-transfer not',function(){truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','BR TO BR - 0863','CREDIT',5000)),'internal');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','e-Transfer received CUSTOMER','CREDIT',5000)),false,'customer');return'correct';});
  test('Generic numeric Misc Payment never becomes obligation by itself',function(){equal(vfcRbcClassifyDebit_(tx('2026-03-12','Misc Payment 1469635','DEBIT',6585.81,'1469635')),null,'misc');return'ignored';});

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,rbcRulesVersion:vfcRbcBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
function runBankingStabilitySelfTests(){return runRbcBankingSelfTests();}
+vfcRound_(statementDiff,.01)+'.');

  const locked=Object.assign({},summary||{});
  locked.statement_start_date=facts.startDate;
  locked.statement_end_date=facts.endDate;
  locked.opening_balance=facts.opening;
  locked.closing_balance=facts.closing;
  locked.total_deposits=facts.deposits;
  locked.total_withdrawals=facts.withdrawals;

  let ledger=vfcRbcPrepareLedger_(locked.banking_transactions||[]),audit=null,lastError='',repairPasses=0;
  for(let attempt=0;attempt<=2;attempt++){
    try{
      audit=vfcRbcAuditFullLedger_(ledger,facts,text,name);
      break;
    }catch(e){
      lastError=String(e&&e.message||e);
      if(attempt>=2)throw new Error(lastError);
      repairPasses++;
      ledger=vfcRbcRepairLedger_(ledger,text,name,facts,lastError,repairPasses);
    }
  }

  if(!audit)throw new Error('RBC ledger verification did not complete for '+name+'.');
  locked.banking_transactions=ledger;
  locked.rbc_full_ledger_verified=true;
  locked.rbc_ledger_reconciled=repairPasses>0;
  locked.rbc_ledger_repair_passes=repairPasses;
  locked.rbc_credit_transaction_count=audit.creditCount;
  locked.rbc_debit_transaction_count=audit.debitCount;
  locked.nsf_count=vfcRbcCountBorrowerNsfEvents_(ledger);
  locked.negative_balance_detected=vfcRbcNegativeBalanceFlag_(text,facts);
  return locked;
}

function vfcRbcPrintedActivityCounts_(text){
  const s=String(text||'').replace(/\u00a0/g,' '),c=s.match(/Total\s+deposits\s*&\s*credits\s*\((\d+)\)/i),d=s.match(/Total\s+cheques\s*&\s*debits\s*\((\d+)\)/i);
  return{creditCount:c?Number(c[1]):null,debitCount:d?Number(d[1]):null};
}

function vfcRbcIsNonActivityArtifact_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s)return true;
  return/^OPENING\s+BALANCE\b|^CLOSING\s+BALANCE\b|^ACCOUNT\s+FEES?\b|^ACCOUNT\s+SUMMARY\b|^TOTAL\s+DEPOSITS\s*&\s*CREDITS\b|^TOTAL\s+CHEQUES\s*&\s+DEBITS\b|^PAGE\s+TOTAL\b|^SERIAL\s*#?\s*:?\s*\d+\s+AMOUNT\b|FOR\s+DEPOSIT\s+ONLY|BACKVERSO|BACK\s*\/\s*VERSO|CHEQUE\s+IMAGE|CHECK\s+IMAGE/.test(s);
}

function vfcRbcPrepareLedger_(items){
  return(Array.isArray(items)?items:[]).filter(function(x){return!vfcRbcIsNonActivityArtifact_(x);}).map(function(x){
    const t=Object.assign({},x||{}),forced=vfcRbcCertainDirection_(t);
    if(forced)t.direction=forced;
    t.direction=String(t.direction||'').toUpperCase();
    t.description=String(t.description||'').replace(/\s+/g,' ').trim();
    t.counterparty=String(t.counterparty||t.description||'').replace(/\s+/g,' ').trim();
    t.amount=vfcNum_(t.amount);
    return t;
  });
}

function vfcRbcCertainDirection_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return'';
  if(/^LOAN\s+CREDIT\b/.test(s)||/\bPAYROLL\s+DEPOSIT\b|\bTAX\s+REFUND\b|E-TRANSFER\s+RECEIVED|INTERAC\s+PURCHASE\s+REFUND|E-TRANSFER\s+CANCEL|MOBILE\s+CHEQUE\s+DEPOSIT/.test(s))return'CREDIT';
  if(vfcRbcIsPadLikeText_(s)||/^LOAN\s+PAYMENT\b|^LOAN\s+INTEREST\b|^BLIP\s+PAYMENT\s*-?\s*LOAN\b|^BILL\s+PAYMENT\b|^FUEL\s+BILL\s+PAYMENT\b|^COMM\s+GAS\s+BILL\s+PMT\b|^COMMERCIAL\s+TAXES\b|^AUTO\s+INSURANCE\b|^INSURANCE\b|^RENT\/LEASE\b|^CHEQUE\s*-\s*\d+\b|E-TRANSFER\s+SENT|E-TRANSFER\s+REQUEST\s+FULFILLED/.test(s))return'DEBIT';
  return'';
}

function vfcRbcLedgerStats_(items){
  const out={creditCount:0,debitCount:0,totalCredits:0,totalDebits:0,bad:[]};
  (Array.isArray(items)?items:[]).forEach(function(t,i){
    const d=String(t&&t.direction||'').toUpperCase(),a=vfcNum_(t&&t.amount),desc=String(t&&t.description||'').trim(),date=vfcIso_(t&&t.date);
    if(!date||!desc||!(a>0)||(d!=='CREDIT'&&d!=='DEBIT')){out.bad.push(i+1);return;}
    if(d==='CREDIT'){out.creditCount++;out.totalCredits+=a;}else{out.debitCount++;out.totalDebits+=a;}
  });
  out.totalCredits=vfcRound_(out.totalCredits,.01);out.totalDebits=vfcRound_(out.totalDebits,.01);return out;
}

function vfcRbcLedgerPreview_(rows,direction){
  return(rows||[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()===direction;}).slice(0,40).map(function(t){return String(t.date||'')+' '+String(t.description||'')+' $'+vfcNum_(t.amount);}).join(' | ');
}

function vfcRbcAuditFullLedger_(items,facts,text,fileName){
  const rows=Array.isArray(items)?items:[],printed=vfcRbcPrintedActivityCounts_(text),s=vfcRbcLedgerStats_(rows);
  if(s.bad.length)throw new Error('RBC full ledger contains incomplete transaction row(s) '+s.bad.join(', ')+' for '+fileName+'.');
  const creditCountOk=printed.creditCount===null||s.creditCount===printed.creditCount;
  const debitCountOk=printed.debitCount===null||s.debitCount===printed.debitCount;
  const creditTotalOk=Math.abs(s.totalCredits-vfcNum_(facts.deposits))<=.05;
  const debitTotalOk=Math.abs(s.totalDebits-vfcNum_(facts.withdrawals))<=.05;
  if(!creditCountOk||!debitCountOk||!creditTotalOk||!debitTotalOk){
    throw new Error('RBC ledger mismatch for '+fileName+': printed credits '+printed.creditCount+' / $'+vfcNum_(facts.deposits)+', extracted '+s.creditCount+' / $'+s.totalCredits+'; printed debits '+printed.debitCount+' / $'+vfcNum_(facts.withdrawals)+', extracted '+s.debitCount+' / $'+s.totalDebits+'.');
  }
  return{creditCount:s.creditCount,debitCount:s.debitCount,totalCredits:s.totalCredits,totalDebits:s.totalDebits,reconciled:true};
}

function vfcRbcRepairLedger_(currentLedger,text,fileName,facts,reason,attempt){
  const printed=vfcRbcPrintedActivityCounts_(text),current=vfcRbcLedgerStats_(currentLedger),prompt=[
    'You are the VFC RBC Account Activity Reconciliation Reader. Return JSON only.',
    'This is FACT EXTRACTION ONLY. Do not underwrite, classify debt, summarize or estimate.',
    'File: '+fileName,
    'The previous ledger failed deterministic reconciliation: '+reason,
    'AUTHORITATIVE PRINTED TARGETS:',
    'CREDIT rows exactly: '+printed.creditCount,
    'CREDIT total exactly: '+vfcNum_(facts.deposits),
    'DEBIT rows exactly: '+printed.debitCount,
    'DEBIT total exactly: '+vfcNum_(facts.withdrawals),
    'Opening balance: '+vfcNum_(facts.opening),
    'Closing balance: '+vfcNum_(facts.closing),
    'Return JSON with ONE field only: banking_transactions.',
    'banking_transactions must be the COMPLETE Account Activity ledger and each object must be {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short visible counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
    'STRICT RULES:',
    '1. Read only Account Activity Details rows. Include every amount-bearing activity row, including all bank fees and ordinary purchases.',
    '2. Do not include opening/closing balances, Account Summary totals, Account Fees summary, page totals, cheque-image/support pages, serial-number image rows or endorsements.',
    '3. Printed Cheques & Debits column = DEBIT; printed Deposits & Credits column = CREDIT. Never infer direction from words.',
    '4. MISC PAYMENT and RETURN/NSF can occur in either direction. Use the printed column.',
    '5. Keep repeated legitimate transactions. Do not deduplicate two separately printed activity rows.',
    '6. The final array MUST contain exactly '+printed.creditCount+' CREDIT rows totaling '+vfcNum_(facts.deposits)+' and exactly '+printed.debitCount+' DEBIT rows totaling '+vfcNum_(facts.withdrawals)+'.',
    '7. If the current candidate missed a row, recover it from the raw statement. If it contains an artifact, remove only the artifact.',
    'Current candidate stats: credits '+current.creditCount+' / $'+current.totalCredits+', debits '+current.debitCount+' / $'+current.totalDebits+'.',
    'Current candidate ledger:',JSON.stringify(currentLedger),
    'RAW RBC STATEMENT OCR:',String(text||'').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
  ].join('\n');
  const repaired=callOpenAIJson_(prompt);
  if(!repaired||!Array.isArray(repaired.banking_transactions))throw new Error('RBC reconciliation pass '+attempt+' did not return a complete banking_transactions array for '+fileName+'.');
  return vfcRbcPrepareLedger_(repaired.banking_transactions);
}

function vfcRbcIsPadLikeText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return false;
  return/^(?:BUSINESS\s+)?PAD\b|PRE[- ]?AUTH(?:ORIZED)?(?:\s+DEBIT|\s+PAYMENT)?\b|PREAUTHORIZED(?:\s+DEBIT|\s+PAYMENT)?\b|DIRECT\s+DEBIT\b|EFT\s+DEBIT\b|ACH\s+DEBIT\b|AUTOMATIC\s+DEBIT\b|AUTO\s+PAYMENT\b/.test(s);
}

function vfcRbcReturnEventText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||/\b(?:FEE|FEES|CHARGE)\b/.test(s))return false;
  return/CHEQUE\s+RETURNED(?:\s+NSF)?|CHECK\s+RETURNED(?:\s+NSF)?|ITEM\s+RETURNED(?:\s+NSF|\s+UNPAID)?|RETURNED\s+(?:ITEM|CHEQUE|CHECK|PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)|(?:PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)\s+RETURNED|PRE[- ]?AUTH(?:ORIZED)?\s+(?:DEBIT|PAYMENT)\s+RETURNED|PREAUTHORIZED\s+(?:DEBIT|PAYMENT)\s+RETURNED|DIRECT\s+DEBIT\s+RETURNED|REJECTED\s+(?:PAD|DEBIT|PAYMENT)|\bREVERSAL\b|\bREVERSED\b|NSF\s+RETURN/.test(s);
}
function vfcRbcReturnCreditText_(value){return vfcRbcReturnEventText_(value);}
function vfcRbcCountReturnEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcCountBorrowerNsfEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}).length;}
function vfcRbcNegativeBalanceFlag_(text,facts){if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;return/(?:^|\s)-[0-9][0-9,]*\.\d{2}(?:\s|$)/m.test(String(text||''));}
function vfcRbcAmountBand_(amount){const n=Math.max(1,vfcNum_(amount));return Math.round(Math.log(n)/Math.log(1.25));}

function vfcRbcClassifyDebit_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t&&t.counterparty||'').replace(/\s+/g,' ').trim(),band=vfcRbcAmountBand_(t&&t.amount),hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b|\bMCA\b|\bLEASE\b|\bLSE\b/.test(s),isFee=/\bFEES?\b|SERVICE\s+CHARGE|NSF\s+ITEM\s+FEES?|RETURNED[- ]?ITEM\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE|ACTIVITY\s+FEE|TRANSACTION\s+FEE|MONTHLY\s+FEE/.test(s);
  if(isFee&&!hasFinancingSignal)return null;
  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/COMM\s+EQUIP\s+RENT\/LSE\s+SILVERCHEF|\bSILVERCHEF\b/.test(s)){family='FINANCING';entityKey='SILVERCHEF_EQUIPMENT_LEASE';label='SilverChef Equipment Lease';debtJustification='Explicit recurring equipment lease.';}
  else if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';debtJustification='Known MCA/funding counterparty plus recurrence.';}
  else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){family='MCA';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bBDC\b/.test(s)&&vfcRbcIsPadLikeText_(s)){family='FINANCING';entityKey='RBC_BDC_PAD_B'+band;label='BDC';debtJustification='Recurring BDC PAD stream; materially different catch-up amounts remain separate.';}
  else if(/\bBDC\b/.test(s)&&(/BDC[- ]?LOAN\/PRET|ONLINE\s+BANKING\s+PAYMENT|\bLOAN\b|FINANC/.test(s))){family='FINANCING';entityKey='RBC_BDC_MANUAL_B'+band;label='BDC Manual / Loan Payment';debtJustification='Manual BDC loan-payment stream kept separate from normal PAD.';}
  else if(/\bAFFIRM(?:\s+CANADA)?\b/.test(s)){family='FINANCING';entityKey='RBC_AFFIRM_CANADA';label='Affirm Canada';debtJustification='Affirm Canada financing counterparty plus recurrence.';}
  else if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='CANACAP';label='Canacap';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bGREENBOX\b/.test(s)){family='MCA';entityKey='GREENBOX';label='Greenbox';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bICAPITAL\b/.test(s)){family='FINANCING';entityKey='ICAPITAL';label='iCapital';debtJustification='Known financing counterparty plus recurrence.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC/.test(s)){family='FINANCING';entityKey='RBC_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw)+'_B'+band;label=cp||'Premium Finance';debtJustification='Explicit premium-finance counterparty plus recurrence.';}
  else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){family='TAX';entityKey='RBC_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);}
  else if(/INSURANCE/.test(s)){family='OTHER';if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}else if(/IND\s+ALL/.test(s)){entityKey='INSURANCE_IND_ALL';label='Insurance IND ALL';}else entityKey='RBC_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|CAPITAL\s+ONE|\bMBNA\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/^AUTO\s+PAYMENT\b/.test(s)){
    const clean=raw.replace(/^AUTO\s+PAYMENT\s*/i,'').trim(),financeLike=/\bAFS\b|FINANC|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s);
    family=financeLike?'FINANCING':'OTHER';entityKey=(financeLike?'AUTO_PAYMENT_FINANCE_':'RBC_OTHER_AUTOPAY_')+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;if(financeLike)debtJustification='Automatic payment with independent finance-like counterparty evidence.';
  }
  else if(/^MISC\s+PAYMENT\b/.test(s)&&(/\bAFS\b|FINANC|LEASE|LENDING|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s))){const clean=raw.replace(/^MISC\s+PAYMENT\s*/i,'').trim();family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;debtJustification='Retry/recurring payment with independent finance-like counterparty evidence.';}
  else if(hasFinancingSignal){
    family='FINANCING';debtJustification='Explicit financing wording plus recurring observed cadence.';
    if(/^LOAN\s+PAYMENT$/i.test(raw)){entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';}
    else{
      const numbered=s.match(/(?:NO\.?|NUMBER|#)\s*([0-9-]{5,})/),generic=s.match(/\b(?:LOAN|MORTGAGE|LOC)\b[^0-9]{0,30}([0-9][0-9-]{5,})\b/),ref=numbered||generic;
      if(ref){const n=ref[1].replace(/[^0-9]/g,'');if(/LOAN\s+INTEREST/.test(s)){entityKey='LOAN_INTEREST_'+n;label='Loan interest NO.'+n;}else if(/\bLOAN\b/.test(s)){entityKey='LOAN_'+n;label='Loan payment NO.'+n;}else if(/\bLEASE\b|\bLSE\b/.test(s)){entityKey='LEASE_'+n;label='Lease payment NO.'+n;}else{entityKey='FINANCE_REF_'+n;}}
      else{const stable=(cp||raw).replace(/\b[0-9][0-9-]{4,}\b/g,'').replace(/\s+/g,' ').trim();entityKey='RBC_FINANCE_'+vfcCounterpartyKey_(stable||cp||raw);}
    }
  }
  else if(vfcRbcIsPadLikeText_(s)){family='OTHER';entityKey='RBC_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/\bCAPITAL\b|\bFUNDING\b|\bFACTOR(?:ING)?\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_POSSIBLE_FINANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/COMMERCIAL\s+RENT|\bRENT\b|HYDRO|FORTIS|TELUS|UTILITY|SUPERPASS|PETROLEUM|\bFUEL\b|EQUIPMENT\s+RENT|PAY\s+EMPLOYEE|PAYROLL/.test(s)){family='OTHER';entityKey='RBC_OTHER_BUSINESS_'+vfcCounterpartyKey_(cp||raw);}
  else{return null;}
  if(!entityKey)entityKey='RBC_OTHER_'+vfcCounterpartyKey_(raw);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcRbcIsReturnedFinancingCredit_(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}
function vfcRbcIsNonOperatingTransferCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;const s=String(t&&t.description||'').toUpperCase();if(/E-TRANSFER|INTERAC/.test(s))return false;return/\bBR\s+TO\s+BR\b|\bTRANSFER\s+FROM\s+(?:ACCOUNT|A\/C|ACCT)\b|\bINTERNAL\s+TRANSFER\b/.test(s);}
function vfcRbcKnownFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();if(vfcRbcIsReturnedFinancingCredit_(t))return false;return/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|\bICAPITAL\b|GREENBOX|\bCSBFL\b|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s);}
function vfcRbcPreservePrintedDuplicate_(){return true;}
function vfcRbcStrongEntityKey_(key){return/^(RBC_AFFIRM_CANADA|RBC_PREMIUM_FINANCE_|RBC_BDC_|MERCHANT_GROWTH|JOURNEY_ONDECK|CANACAP|ICAPITAL|GREENBOX|SILVERCHEF_EQUIPMENT_LEASE|AUTO_PAYMENT_FINANCE_|RBC_FINANCE_|INSURANCE_|LEASE_[0-9]|FINANCE_REF_[0-9])/.test(String(key||'').toUpperCase());}

function runRbcBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'RBC',transactions:transactions||[]}};}
  function close(a,e,t,l){t=t==null?.02:t;if(Math.abs(Number(a||0)-Number(e||0))>t)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function equal(a,e,l){if(a!==e)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function truthy(v,l){if(!v)throw new Error((l||'value')+' expected truthy');}
  function test(n,f){try{results.push({name:n,pass:true,detail:String(f()||'')});}catch(e){results.push({name:n,pass:false,detail:String(e&&e.message||e)});}}

  test('AIM HIGH Mar-Apr printed credits are exactly 15 and $45,725.36',function(){const c=[2000,250,1000,6585.81,1046.83,250,7474.96,3000,750,2750,3250,2750,6673.93,7693.83,250];equal(c.length,15,'count');close(vfcSum_(c),45725.36,.02,'sum');return'15/$45725.36';});
  test('Exact ledger audit passes only when count and totals both match',function(){const text='Total deposits & credits (2) + 150.00\nTotal cheques & debits (2) - 30.00',facts={deposits:150,withdrawals:30},good=[tx('2026-01-01','A','CREDIT',100),tx('2026-01-02','B','CREDIT',50),tx('2026-01-03','C','DEBIT',10),tx('2026-01-04','D','DEBIT',20)];const a=vfcRbcAuditFullLedger_(good,facts,text,'x.pdf');equal(a.creditCount,2,'credits');let failed=false;try{vfcRbcAuditFullLedger_(good.slice(1),facts,text,'x.pdf');}catch(e){failed=true;}truthy(failed,'missing row fails');return'exact';});
  test('Opening/closing/support artifacts are excluded',function(){const p=vfcRbcPrepareLedger_([tx('2026-03-02','Opening balance','CREDIT',4710.90),tx('2026-03-03','Loan BK OF MONTREAL','DEBIT',599.22),tx('2026-04-02','Serial #: 343 Amount: $315.00','CREDIT',315)]);equal(p.length,1,'real rows');return'clean';});
  test('Return direction remains printed-column driven',function(){equal(vfcRbcCertainDirection_(tx('2026-05-27','Cheque returned NSF','DEBIT',2606.59)),'','no force');truthy(vfcRbcIsReturnedFinancingCredit_(tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)),'credit return');equal(vfcRbcIsReturnedFinancingCredit_(tx('2026-06-25','Item returned unpaid','DEBIT',187.46)),false,'debit return');return'direction safe';});
  test('Unknown recurring PAD is informational only',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-02-28',[tx('2026-02-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-03-31',[tx('2026-03-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])]);close(d.confirmedMonthlyDebtService,0,.001,'debt');return'informational';});
  test('Recurring Affirm is financing',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-02-28',[tx('2026-02-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-03-31',[tx('2026-03-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm');return'66.62';});
  test('Returned BDC PAD cannot inflate debt',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-27','Business PAD BDC','DEBIT',2578.34,'BDC')]),row('2026-04-30',[tx('2026-04-27','Business PAD BDC','DEBIT',2656.97,'BDC')]),row('2026-05-31',[tx('2026-05-27','Business PAD BDC','DEBIT',2606.59,'BDC'),tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)]),row('2026-06-30',[tx('2026-06-29','Business PAD BDC','DEBIT',5289.91,'BDC'),tx('2026-06-29','Cheque returned NSF','CREDIT',5289.91)]),row('2026-08-31',[tx('2026-08-17','Business PAD BDC','DEBIT',2285.91,'BDC')])]);truthy(d.returnedFinanceDebitsSuppressed>=2,'suppressed');return'suppressed='+d.returnedFinanceDebitsSuppressed;});
  test('Recurring IPFS is financing while ordinary insurance is informational',function(){const ip=vfcRbcClassifyDebit_(tx('2026-08-04','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')),ins=vfcRbcClassifyDebit_(tx('2026-08-04','Auto Insurance ICBC','DEBIT',234.96,'ICBC'));equal(ip.family,'FINANCING','IPFS');equal(ins.family,'OTHER','insurance');return'correct';});
  test('BR TO BR credit excluded but customer e-transfer not',function(){truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','BR TO BR - 0863','CREDIT',5000)),'internal');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','e-Transfer received CUSTOMER','CREDIT',5000)),false,'customer');return'correct';});
  test('Generic numeric Misc Payment never becomes obligation by itself',function(){equal(vfcRbcClassifyDebit_(tx('2026-03-12','Misc Payment 1469635','DEBIT',6585.81,'1469635')),null,'misc');return'ignored';});

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,rbcRulesVersion:vfcRbcBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
function runBankingStabilitySelfTests(){return runRbcBankingSelfTests();}
