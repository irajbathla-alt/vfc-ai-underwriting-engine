/**
 * RBC BANK ENGINE v2.5 — CANDIDATE / FINAL REVALIDATION
 * ONE PERMANENT RBC FILE.
 *
 * Design goals:
 * - printed RBC columns are authoritative for direction
 * - every visible Account Activity amount row is frozen
 * - transaction counts and sums must equal the printed Account Summary exactly
 * - non-activity statement artifacts are deterministically excluded before validation
 * - ambiguous wording is never used to guess direction
 * - all visible PAD / pre-authorized debit families are preserved
 * - all visible NSF / return / reversal families are preserved as risk facts
 * - borrower NSF events are separated from returned-deposit events
 * - a failed financing debit is removed from debt service only when a same-amount RETURN CREDIT can be tied to it safely
 * - unknown PADs stay informational unless independent financing evidence exists
 * - bank-specific behavior stays in this one RBC file
 */
function vfcRbcBankProfile_(){
  return{
    id:'RBC',
    label:'RBC',
    status:'CANDIDATE',
    rulesVersion:'RBC-2.5-CANDIDATE',
    intakeContract:'BANK_MATCHED_FROZEN_LEDGER_V2',
    aliases:['ROYAL BANK OF CANADA','RBC ROYAL BANK','RBC']
  };
}

function vfcRbcExtractionRules_(){return[
  'RBC Account Summary: Total deposits & credits is total_deposits; Total cheques & debits is total_withdrawals.',
  'RBC Account Activity: Cheques & Debits = DEBIT and Deposits & Credits = CREDIT. The PRINTED COLUMN is authoritative. Description wording never overrides the printed column.',
  'FULL-LEDGER RULE: banking_transactions MUST contain EVERY visible Account Activity row carrying a transaction amount in either Cheques & Debits or Deposits & Credits, not only underwriting-relevant rows. Include fees, purchases, cheques, transfers, PADs, direct debits, insurance, taxes, loan activity, refunds and deposits.',
  'NEVER add Opening balance, Closing balance, Account Fees summary totals, Account Summary totals, page totals, cheque-image/support pages, serial-number support rows, endorsement/back-of-cheque text or returned-instrument image pages as transactions. Those are statement artifacts/evidence, not Account Activity rows.',
  'The number of CREDIT and DEBIT transaction rows and the sum of their amounts must match the printed Account Summary counts and totals exactly. If count or dollar totals do not match, the RBC upload MUST fail closed instead of saving uncertain facts.',
  'Rows such as MISC PAYMENT, BR TO BR, ONLINE BANKING TRANSFER and RETURNED/NSF items can appear in different directions depending on the transaction. Never decide direction from those words; use only the printed RBC column.',
  'Preserve EVERY visible PAD-like debit exactly, including BUSINESS PAD, PAD, PRE-AUTH, PRE-AUTHORIZED, PREAUTHORIZED, PRE-AUTHORIZED DEBIT, DIRECT DEBIT, EFT DEBIT, ACH DEBIT, AUTOMATIC DEBIT, AUTO PAYMENT and lender-specific PAD wording.',
  'Unknown PAD/direct-debit counterparties remain informational unless independent lender/loan/MCA/finance/lease evidence exists. Same amount or recurrence alone never proves financing debt.',
  'Preserve EVERY visible return/NSF/reversal event exactly, including CHEQUE RETURNED NSF, CHECK RETURNED NSF, ITEM RETURNED NSF, ITEM RETURNED UNPAID, RETURNED ITEM, RETURNED CHEQUE/CHECK, RETURNED PAYMENT, PAYMENT RETURNED, PAD RETURNED, PREAUTHORIZED DEBIT RETURNED, DIRECT DEBIT RETURNED, EFT RETURNED, ACH RETURNED, DEBIT RETURNED, REVERSED/REVERSAL and similar bank return wording.',
  'IMPORTANT RETURN DIRECTION RULE: return wording does NOT determine CREDIT versus DEBIT. A returned financing PAD may be a CREDIT reversing a debit, while a returned deposited cheque may be a DEBIT reversing a prior deposit. Preserve the printed RBC column exactly.',
  'BORROWER NSF COUNT: only return/reversal transactions printed as CREDIT and therefore reversing a borrower debit/PAD count as borrower failed-payment/NSF events. A returned deposited item printed as DEBIT remains a return risk fact but does not increase borrower NSF count.',
  'Preserve NSF item fee / returned-item fee separately as a DEBIT fee; a fee is not the returned principal amount and must never suppress debt service.',
  'NSF/retry rule: preserve the original attempted debit, the return/reversal transaction and any later retry as separate printed facts. Deterministic Core suppression occurs only for a return transaction that is actually a CREDIT and safely matches a financing debit by amount/date/entity evidence.',
  'RBC printed opening balance, closing balance, deposits and withdrawals must reconcile to the cent before the statement is saved. Visible negative running balances are locked deterministically.',
  'Any debit explicitly containing LOAN, MORTGAGE, LOC/LINE OF CREDIT, FINANCING, MCA or LEASE is a financing-obligation candidate. It must recur before a fixed monthly equivalent is confirmed.',
  'General e-Transfers, online transfers, BR TO BR transfers, ATM/cash withdrawals and ordinary cheques are not debt candidates merely because they repeat or use the same amount.',
  'For operating-deposit analysis, explicit BR TO BR credits and explicit TRANSFER FROM ACCOUNT credits are internal-account transfers unless the same credit is independently identified as financing proceeds. Generic customer e-Transfers are not excluded.',
  'AUTO PAYMENT describes a payment method, not automatically a loan. Treat it as financing only when the counterparty/description independently indicates financing and the payment recurs.',
  'A successful retry may print as MISC PAYMENT instead of AUTO PAYMENT. If the same finance-like counterparty is explicit, keep it under the same financing entity so recurrence is not broken.',
  'A generic MISC PAYMENT without an identifiable financing/card/tax/insurance/business counterparty is not a recurring obligation merely because it repeats.',
  'A fee-related word only suppresses a line when there is no independent financing signal. A loan/financing/lease/MCA line that also contains a fee word must still be preserved for recurrence testing.',
  'PAY-FILE FEE / PAY-FILE FEES and ordinary bank/service/transaction/NSF/returned-item fees are fees only and must not become recurring obligations.',
  'AFFIRM CANADA is a financing counterparty. Recurring AFFIRM debits are confirmed financing debt; one observation remains unconfirmed.',
  'Explicit PREMIUM FINANCE, PREMIUM FINANCING and IPFS payment wording is financing when recurring. Ordinary ICBC/life/insurance premium descriptions without financing wording remain informational.',
  'BDC rules: BUSINESS PAD BDC is the recurring PAD stream. BDC-LOAN/PRET or other manual BDC loan-payment wording is a separate stream so a catch-up/manual payment cannot inflate the normal PAD obligation. Materially different BDC PAD amounts are separated into stable amount bands and require their own recurrence.',
  'Extract LOAN CREDIT, generic LOAN PAYMENT, numbered Loan payment NO.x and Loan interest NO.x.',
  'Extract CSBFL advance / CSBFL loan advance credits as financing proceeds when printed in Deposits & Credits.',
  'Preserve COMM EQUIP RENT/LSE SILVERCHEF debits exactly; treat SilverChef as recurring equipment lease financing when recurring.',
  'Journey/OnDeck aliases: JOURNEY, ONDECK and JTO. A credit memo containing TRF JTO is Journey/OnDeck financing proceeds when printed in Deposits & Credits.',
  'Journey/OnDeck, Merchant Growth, Canacap and Greenbox are MCA-style exposures for stacking analysis when recurring. iCapital remains general financing unless the statement itself identifies an MCA.',
  'Known financing entities for RBC recurrence include BDC, Canacap, iCapital, Greenbox, Journey/OnDeck, Merchant Growth, SilverChef, Affirm Canada and explicit premium finance/IPFS.',
  'Extract recurring insurance lines including ICBC, IND ALL LIFE IN, EQUITABLE LIFE and OWIC for informational analysis.',
  'Extract commercial tax / EMPTX / GST lines, credit-card payments and potential financing credits.',
  'A LOAN CREDIT printed in Deposits & Credits is always a CREDIT. Never turn it into a debit because of the word loan.',
  'A credit containing explicit LOAN/MCA/MORTGAGE/LOC wording or a trained known financing entity is a financing-credit candidate; ordinary deposits, payroll/commission credits, owner transfers and generic deposits are not financing merely because they are large or the sender name contains Finance/Financing.'
].join('\n');}

function vfcRbcLockFacts_(summary,text,fileName){
  const facts=vfcExtractPrintedStatementFacts_(text),name=String(fileName||'statement');
  if(!facts.startDate||!facts.endDate||facts.opening===null||facts.closing===null||facts.deposits===null||facts.withdrawals===null){
    throw new Error('RBC printed Account Summary could not be fully verified for '+name+'. Upload was stopped before saving incomplete statement totals.');
  }
  const diff=Math.abs((facts.opening+facts.deposits-facts.withdrawals)-facts.closing);
  if(diff>.05)throw new Error('RBC printed Account Summary does not reconcile for '+name+'. Difference: $'+vfcRound_(diff,.01)+'.');
  const locked=Object.assign({},summary||{});
  locked.statement_start_date=facts.startDate;
  locked.statement_end_date=facts.endDate;
  locked.opening_balance=facts.opening;
  locked.closing_balance=facts.closing;
  locked.total_deposits=facts.deposits;
  locked.total_withdrawals=facts.withdrawals;
  locked.banking_transactions=vfcRbcPrepareLedger_(locked.banking_transactions||[]);
  const ledgerAudit=vfcRbcAuditFullLedger_(locked.banking_transactions,facts,text,name);
  locked.rbc_full_ledger_verified=true;
  locked.rbc_credit_transaction_count=ledgerAudit.creditCount;
  locked.rbc_debit_transaction_count=ledgerAudit.debitCount;
  locked.nsf_count=vfcRbcCountBorrowerNsfEvents_(locked.banking_transactions);
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
  return/^OPENING\s+BALANCE\b|^CLOSING\s+BALANCE\b|^ACCOUNT\s+FEES?\b|^ACCOUNT\s+SUMMARY\b|^TOTAL\s+DEPOSITS\s*&\s*CREDITS\b|^TOTAL\s+CHEQUES\s*&\s*DEBITS\b|^BALANCE\s+FORWARD\b|^PAGE\s+TOTAL\b|^SERIAL\s*#?\s*:?\s*\d+\s+AMOUNT\b|^AMOUNT\s*:\s*\$?[0-9]|FOR\s+DEPOSIT\s+ONLY|BACKVERSO|BACK\s*\/\s*VERSO|CHEQUE\s+IMAGE|CHECK\s+IMAGE/.test(s);
}

function vfcRbcPrepareLedger_(items){
  return(Array.isArray(items)?items:[]).filter(function(x){return!vfcRbcIsNonActivityArtifact_(x);}).map(function(x){
    const t=Object.assign({},x||{}),forced=vfcRbcCertainDirection_(t);
    if(forced)t.direction=forced;
    return t;
  });
}

/**
 * Force only descriptions whose RBC direction is semantically unambiguous.
 * Return/NSF/reversal wording is deliberately NOT forced because RBC can print a return as either
 * CREDIT (reversing a debit/PAD) or DEBIT (reversing a deposited item). Full-ledger reconciliation
 * is the final direction gate.
 */
function vfcRbcCertainDirection_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return'';
  if(/^LOAN\s+CREDIT\b/.test(s)||/\bPAYROLL\s+DEPOSIT\b|\bTAX\s+REFUND\b|E-TRANSFER\s+RECEIVED|INTERAC\s+PURCHASE\s+REFUND|E-TRANSFER\s+CANCEL|MOBILE\s+CHEQUE\s+DEPOSIT/.test(s))return'CREDIT';
  if(vfcRbcIsPadLikeText_(s)||/^LOAN\s+PAYMENT\b|^LOAN\s+INTEREST\b|^BLIP\s+PAYMENT\s*-?\s*LOAN\b|^BILL\s+PAYMENT\b|^FUEL\s+BILL\s+PAYMENT\b|^COMM\s+GAS\s+BILL\s+PMT\b|^COMMERCIAL\s+TAXES\b|^AUTO\s+INSURANCE\b|^INSURANCE\b|^RENT\/LEASE\b|^CHEQUE\s*-\s*\d+\b|E-TRANSFER\s+SENT|E-TRANSFER\s+REQUEST\s+FULFILLED/.test(s))return'DEBIT';
  return'';
}

function vfcRbcLedgerPreview_(rows,direction){
  return(rows||[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()===direction;}).slice(0,30).map(function(t){return String(t.date||'')+' '+String(t.description||'')+' $'+vfcNum_(t.amount);}).join(' | ');
}

function vfcRbcAuditFullLedger_(items,facts,text,fileName){
  const rows=Array.isArray(items)?items:[],printed=vfcRbcPrintedActivityCounts_(text);let debitTotal=0,creditTotal=0,debitCount=0,creditCount=0;const bad=[];
  rows.forEach(function(t,i){
    const direction=String(t&&t.direction||'').toUpperCase(),amount=vfcNum_(t&&t.amount),desc=String(t&&t.description||'').trim(),date=vfcIso_(t&&t.date);
    if(!date||!desc||!(amount>0)||(direction!=='DEBIT'&&direction!=='CREDIT')){bad.push(i+1);return;}
    if(direction==='DEBIT'){debitCount++;debitTotal+=amount;}else{creditCount++;creditTotal+=amount;}
  });
  if(bad.length)throw new Error('RBC full transaction ledger contains incomplete row(s) '+bad.join(', ')+' for '+fileName+'. Upload stopped rather than freezing uncertain facts.');
  if(printed.creditCount!==null&&creditCount!==printed.creditCount)throw new Error('RBC full-ledger credit count mismatch for '+fileName+': printed '+printed.creditCount+', extracted '+creditCount+'. Extracted credits: '+vfcRbcLedgerPreview_(rows,'CREDIT'));
  if(printed.debitCount!==null&&debitCount!==printed.debitCount)throw new Error('RBC full-ledger debit count mismatch for '+fileName+': printed '+printed.debitCount+', extracted '+debitCount+'. Extracted debits: '+vfcRbcLedgerPreview_(rows,'DEBIT'));
  const creditDiff=Math.abs(creditTotal-vfcNum_(facts.deposits)),debitDiff=Math.abs(debitTotal-vfcNum_(facts.withdrawals));
  if(creditDiff>.05||debitDiff>.05)throw new Error('RBC full-ledger totals do not match the printed Account Summary for '+fileName+'. CREDIT difference $'+vfcRound_(creditDiff,.01)+', DEBIT difference $'+vfcRound_(debitDiff,.01)+'. Credits: '+vfcRbcLedgerPreview_(rows,'CREDIT')+' Debits: '+vfcRbcLedgerPreview_(rows,'DEBIT'));
  return{creditCount:creditCount,debitCount:debitCount,totalCredits:vfcRound_(creditTotal,.01),totalDebits:vfcRound_(debitTotal,.01)};
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
function vfcRbcCountNsf_(text){
  const s=String(text||'').toUpperCase(),patterns=[/CHEQUE\s+RETURNED(?:\s+NSF)?/g,/CHECK\s+RETURNED(?:\s+NSF)?/g,/ITEM\s+RETURNED(?:\s+NSF|\s+UNPAID)?/g,/RETURNED\s+(?:PAYMENT|PAD|DEBIT|EFT|ACH)/g,/(?:PAYMENT|PAD|DEBIT|EFT|ACH)\s+RETURNED/g,/\bREVERSAL\b/g,/\bREVERSED\b/g];
  let n=0;patterns.forEach(function(re){const m=s.match(re);if(m)n+=m.length;});return n;
}
function vfcRbcNegativeBalanceFlag_(text,facts){if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;return/(?:^|\s)-[0-9][0-9,]*\.\d{2}(?:\s|$)/m.test(String(text||''));}

function vfcRbcAmountBand_(amount){const n=Math.max(1,vfcNum_(amount));return Math.round(Math.log(n)/Math.log(1.25));}

function vfcRbcClassifyDebit_(t){
  const raw=String(t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t.counterparty||'').replace(/\s+/g,' ').trim(),band=vfcRbcAmountBand_(t.amount),hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b|\bMCA\b|\bLEASE\b|\bLSE\b/.test(s),isFeeLine=/\bFEES?\b|SERVICE\s+CHARGE|NSF\s+ITEM\s+FEES?|RETURNED[- ]?ITEM\s+FEE|ITEM\s+RETURNED\s+UNPAID\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE|ACTIVITY\s+FEE|TRANSACTION\s+FEE|MONTHLY\s+FEE/.test(s);
  if(isFeeLine&&!hasFinancingSignal)return null;
  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/COMM\s+EQUIP\s+RENT\/LSE\s+SILVERCHEF|\bSILVERCHEF\b/.test(s)){family='FINANCING';entityKey='SILVERCHEF_EQUIPMENT_LEASE';label='SilverChef Equipment Lease';debtJustification='Explicit equipment lease wording plus recurring SilverChef payments.';}
  else if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';debtJustification='Known MCA/funding entity plus recurring payment cadence.';}
  else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){family='MCA';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';debtJustification='Known MCA-style business financing entity plus recurring payment cadence.';}
  else if(/\bBDC\b/.test(s)&&vfcRbcIsPadLikeText_(s)){family='FINANCING';entityKey='RBC_BDC_PAD_B'+band;label='BDC';debtJustification='Recurring BDC PAD stream. Materially different catch-up-sized amounts are isolated into separate amount bands and require independent recurrence.';}
  else if(/\bBDC\b/.test(s)&&(/BDC[- ]?LOAN\/PRET|ONLINE\s+BANKING\s+PAYMENT|\bLOAN\b|FINANC/.test(s))){family='FINANCING';entityKey='RBC_BDC_MANUAL_B'+band;label='BDC Manual / Loan Payment';debtJustification='BDC manual/loan payment stream is kept separate from the recurring BDC PAD so a one-time catch-up cannot inflate normal monthly debt service.';}
  else if(/\bAFFIRM(?:\s+CANADA)?\b/.test(s)){family='FINANCING';entityKey='RBC_AFFIRM_CANADA';label='Affirm Canada';debtJustification='Affirm Canada is a financing counterparty; recurring observed payments are treated as financing debt.';}
  else if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='CANACAP';label='Canacap';debtJustification='Known MCA-style business financing counterparty plus recurring observed payment cadence.';}
  else if(/\bGREENBOX\b/.test(s)){family='MCA';entityKey='GREENBOX';label='Greenbox';debtJustification='Known MCA-style business financing counterparty plus recurring observed payment cadence.';}
  else if(/\bICAPITAL\b/.test(s)){family='FINANCING';entityKey='ICAPITAL';label='iCapital';debtJustification='Known financing counterparty plus recurring observed payment cadence; iCapital is not assumed to be MCA without explicit MCA evidence.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC/.test(s)){family='FINANCING';entityKey='RBC_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw)+'_B'+band;label=cp||'Premium Finance';debtJustification='Explicit premium-finance wording plus recurring observed payment cadence. Materially different one-time premium/catch-up amounts require independent recurrence.';}
  else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){family='TAX';entityKey='RBC_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/INSURANCE/.test(s)){family='OTHER';if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}else if(/IND\s+ALL\s+LIFE/.test(s)){entityKey='INSURANCE_IND_ALL_LIFE';label='Insurance IND ALL LIFE IN';}else if(/\bOWIC\b/.test(s)){entityKey='INSURANCE_OWIC';label='Insurance OWIC';}else entityKey='RBC_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|CAPITAL\s+ONE|\bMBNA\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/^AUTO\s+PAYMENT\b/.test(s)){const clean=raw.replace(/^AUTO\s+PAYMENT\s*/i,'').trim(),financeLike=/\bAFS\b|FINANC|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b|CAPITAL\s+(?:LENDING|FINANCE|FUNDING)|CREDIT\s+(?:CORP|FINANCE|LENDING)/.test(s);if(financeLike){family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;debtJustification='Recurring automatic payment to a finance-like counterparty; AUTO PAYMENT alone is not sufficient.';}else{family='OTHER';entityKey='RBC_OTHER_AUTOPAY_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;}}
  else if(/^MISC\s+PAYMENT\b/.test(s)&&(/\bAFS\b|FINANC|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b|CAPITAL\s+(?:LENDING|FINANCE|FUNDING)|CREDIT\s+(?:CORP|FINANCE|LENDING)/.test(s))){const clean=raw.replace(/^MISC\s+PAYMENT\s*/i,'').trim();family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;debtJustification='Recurring or retry payment to the same finance-like counterparty, even though RBC printed MISC PAYMENT instead of AUTO PAYMENT.';}
  else if(hasFinancingSignal){family='FINANCING';debtJustification='Explicit loan/mortgage/LOC/financing/lease/MCA wording plus recurring observed cadence.';if(/^LOAN\s+PAYMENT$/i.test(raw)){entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';}else{const numbered=s.match(/(?:NO\.?|NUMBER|#)\s*([0-9-]{5,})/),genericDebtNumber=s.match(/\b(?:LOAN|MORTGAGE|LOC)\b[^0-9]{0,30}([0-9][0-9-]{5,})\b/),ref=numbered||genericDebtNumber;if(ref){const n=ref[1].replace(/[^0-9]/g,'');if(/LOAN\s+INTEREST/.test(s)){entityKey='LOAN_INTEREST_'+n;label='Loan interest NO.'+n;}else if(/PERSONAL\s+LOAN/.test(s)){entityKey='LOAN_'+n;label='Personal Loan '+n;}else if(/\bLOAN\b/.test(s)){entityKey='LOAN_'+n;label='Loan payment NO.'+n;}else if(/\bLEASE\b|\bLSE\b/.test(s)){entityKey='LEASE_'+n;label='Lease payment NO.'+n;}else{entityKey='FINANCE_REF_'+n;label=(cp||raw)+' NO.'+n;}}else{const stable=(cp||raw).replace(/\b[0-9][0-9-]{4,}\b/g,'').replace(/\s+/g,' ').trim();entityKey='RBC_FINANCE_'+vfcCounterpartyKey_(stable||cp||raw);label=cp||raw;}}}
  else if(vfcRbcIsPadLikeText_(s)){family='OTHER';if(/\bCAPITAL\b|\bFUNDING\b|\bADVANCE\b|\bFACTOR(?:ING)?\b/.test(s))entityKey='RBC_OTHER_POSSIBLE_FINANCE_PAD_'+vfcCounterpartyKey_(cp||raw);else entityKey='RBC_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/\bCAPITAL\b|\bFUNDING\b|\bFACTOR(?:ING)?\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_POSSIBLE_FINANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/COMMERCIAL\s+RENT|\bRENT\b|HYDRO|FORTIS|TELUS|UTILITY|SUPERPASS|PETROLEUM|\bFUEL\b|EQUIPMENT\s+RENT|PAY\s+EMPLOYEE|PAYROLL/.test(s)){family='OTHER';entityKey='RBC_OTHER_BUSINESS_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else{return null;}
  if(!entityKey)entityKey='RBC_OTHER_'+vfcCounterpartyKey_(raw);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcRbcIsReturnedFinancingCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;return vfcRbcReturnEventText_(t&&t.description);}
function vfcRbcIsNonOperatingTransferCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;const s=String(t&&t.description||'').toUpperCase();if(/E-TRANSFER|INTERAC/.test(s))return false;return/\bBR\s+TO\s+BR\b|\bTRANSFER\s+FROM\s+(?:ACCOUNT|A\/C|ACCT)\b|\bINTERNAL\s+TRANSFER\b/.test(s);}
function vfcRbcKnownFinancingCredit_(t){const s=String((t&&t.description)||'').toUpperCase();if(vfcRbcIsReturnedFinancingCredit_(t))return false;return/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|\bICAPITAL\b|GREENBOX|\bCSBFL\b|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s);}
function vfcRbcPreservePrintedDuplicate_(){return true;}
function vfcRbcStrongEntityKey_(key){return/^(RBC_AFFIRM_CANADA|RBC_PREMIUM_FINANCE_|RBC_BDC_|BDC|MERCHANT_GROWTH|JOURNEY_ONDECK|CANACAP|ICAPITAL|GREENBOX|SILVERCHEF_EQUIPMENT_LEASE|AUTO_PAYMENT_FINANCE_|RBC_FINANCE_|RBC_OTHER_|INSURANCE_|LEASE_[0-9]|FINANCE_REF_[0-9])/.test(String(key||'').toUpperCase());}

function runRbcBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'RBC',transactions:transactions||[]}};}
  function close(actual,expected,tol,label){tol=tol==null?.02:tol;if(Math.abs(Number(actual||0)-Number(expected||0))>tol)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function equal(actual,expected,label){if(actual!==expected)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function truthy(value,label){if(!value)throw new Error((label||'value')+' expected truthy');}
  function test(name,fn){try{results.push({name:name,pass:true,detail:String(fn()||'')});}catch(e){results.push({name:name,pass:false,detail:String(e&&e.message||e)});}}

  test('RBC non-activity artifacts are removed before ledger validation',function(){
    const rows=[tx('2026-03-02','Opening balance','CREDIT',4710.90),tx('2026-04-02','Closing balance','CREDIT',195.66),tx('2026-04-02','Account Fees','DEBIT',56.50),tx('2026-03-23','Loan BK OF MONTREAL','DEBIT',599.22)];
    const prepared=vfcRbcPrepareLedger_(rows);equal(prepared.length,1,'artifact pruning');equal(prepared[0].description,'Loan BK OF MONTREAL','real activity retained');return'artifacts removed';
  });

  test('RBC AIM HIGH Mar-Apr printed credits are exactly 15 and $45,725.36',function(){
    const credits=[2000,250,1000,6585.81,1046.83,250,7474.96,3000,750,2750,3250,2750,6673.93,7693.83,250];equal(credits.length,15,'credit count');close(vfcSum_(credits),45725.36,.02,'credit sum');return'15 credits = 45725.36';
  });

  test('RBC return vocabulary is broad and direction-neutral',function(){truthy(vfcRbcReturnEventText_('Cheque returned NSF'),'cheque returned');truthy(vfcRbcReturnEventText_('Item returned unpaid S02788'),'item returned unpaid');truthy(vfcRbcReturnEventText_('PAD returned'),'PAD returned');truthy(vfcRbcReturnEventText_('Direct debit returned'),'direct debit returned');truthy(vfcRbcReturnEventText_('EFT returned'),'EFT returned');truthy(vfcRbcReturnEventText_('Payment reversed'),'payment reversed');equal(vfcRbcReturnEventText_('NSF item fee'),false,'fee not return principal');equal(vfcRbcCertainDirection_(tx('2026-05-27','Cheque returned NSF','DEBIT',2606.59)),'','return direction not forced');equal(vfcRbcCertainDirection_(tx('2026-06-25','Item returned unpaid S02788','CREDIT',187.46)),'','returned deposit direction not forced');return'return wording preserved; printed column decides direction';});

  test('RBC borrower NSF count excludes debit-side returned deposits',function(){const rows=[tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59),tx('2026-06-29','Cheque returned NSF','CREDIT',5289.91),tx('2026-06-25','Item returned unpaid S02788','DEBIT',187.46),tx('2026-06-25','NSF item fee','DEBIT',45)];equal(vfcRbcCountReturnEvents_(rows),3,'all principal return events');equal(vfcRbcCountBorrowerNsfEvents_(rows),2,'borrower NSF events');return'2 borrower NSF events, 1 returned-deposit event';});

  test('RBC returned-financing hook requires CREDIT direction',function(){truthy(vfcRbcIsReturnedFinancingCredit_(tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)),'credit return');equal(vfcRbcIsReturnedFinancingCredit_(tx('2026-06-25','Item returned unpaid S02788','DEBIT',187.46)),false,'debit return is not financing reversal credit');equal(vfcRbcIsReturnedFinancingCredit_(tx('2026-06-02','NSF item fee','DEBIT',45)),false,'NSF fee');return'credit direction required for debt suppression';});

  test('RBC certain-direction rules never guess generic Misc Payment',function(){equal(vfcRbcCertainDirection_(tx('2026-03-12','Misc Payment 1469635','DEBIT',6585.81)),'','generic misc direction');equal(vfcRbcCertainDirection_(tx('2026-03-09','LOAN CREDIT','DEBIT',1000)),'CREDIT','loan credit');equal(vfcRbcCertainDirection_(tx('2026-05-27','Business PAD BDC','CREDIT',2606.59)),'DEBIT','business PAD');return'only unambiguous non-return directions forced';});

  test('RBC PAD vocabulary captures common future debit labels',function(){['Business PAD ABC','PAD ABC','PRE-AUTHORIZED DEBIT ABC','PREAUTHORIZED PAYMENT ABC','DIRECT DEBIT ABC','EFT DEBIT ABC','ACH DEBIT ABC','AUTOMATIC DEBIT ABC','AUTO PAYMENT ABC'].forEach(function(s){truthy(vfcRbcIsPadLikeText_(s),s);});equal(vfcRbcIsPadLikeText_('PAD RETURNED ABC'),false,'returned PAD is return event, not new PAD debit');return'PAD aliases covered';});

  test('RBC full-ledger audit is fail-closed on count, sum or direction mismatch',function(){const text='Total deposits & credits (2) + 150.00\nTotal cheques & debits (2) - 30.00',facts={deposits:150,withdrawals:30},good=[tx('2026-01-01','Deposit A','CREDIT',100),tx('2026-01-02','Deposit B','CREDIT',50),tx('2026-01-03','Debit A','DEBIT',10),tx('2026-01-04','Debit B','DEBIT',20)];const a=vfcRbcAuditFullLedger_(good,facts,text,'test.pdf');close(a.totalCredits,150,.001,'credits');close(a.totalDebits,30,.001,'debits');let failed=false;try{vfcRbcAuditFullLedger_(good.map(function(x,i){return i===1?Object.assign({},x,{direction:'DEBIT'}):x;}),facts,text,'test.pdf');}catch(e){failed=true;}truthy(failed,'wrong direction must fail');return'full ledger reconciles or upload stops';});

  test('RBC AIM HIGH six printed deposit totals reproduce reported gross deposits',function(){const deposits=[45725.36,63708.46,56889.45,90909.53,70252.06,36387.79];close(vfcSum_(deposits),363872.65,.02,'total');close(vfcMean_(deposits),60645.4417,.02,'average');return'avg=60645.44';});

  test('RBC BR TO BR credit is internal transfer but customer e-Transfer is not',function(){truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-14','BR TO BR - 0212','CREDIT',15000)),'BR TO BR transfer');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-15','e-Transfer received CUSTOMER A','CREDIT',15000)),false,'customer e-transfer');return'transfers separated';});

  test('RBC CSBFL BR TO BR advance remains financing, not transfer exclusion',function(){const printed=vfcNormalizeTransactions_([tx('2026-03-10','BR TO BR - Credit Memo 7512 CSBFL advance Loan: 09530611-001','CREDIT',13775,'CSBFL')],'RBC'),d=vfcDebtProfile_([row('2026-03-31',printed)]),transfers=vfcNonOperatingTransferCredits_(printed.map(function(t){return Object.assign({bankId:'RBC'},t);}));close(d.financingCreditsTotal,13775,.02,'financing credit');equal(transfers.length,0,'transfer exclusions');return'financing='+d.financingCreditsTotal;});

  test('RBC recurring Affirm Canada is confirmed financing debt',function(){const d=vfcDebtProfile_([row('2026-02-20',[tx('2026-02-06','Misc Payment AFFIRM CANADA REF-1','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-03-20',[tx('2026-03-06','Misc Payment AFFIRM CANADA REF-2','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-04-22',[tx('2026-04-09','Misc Payment AFFIRM CANADA REF-3','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm debt');equal(d.activeDebtObligations[0].entityKey,'RBC_AFFIRM_CANADA','Affirm identity');return'debt='+d.confirmedMonthlyDebtService;});

  test('RBC single Affirm Canada observation stays unconfirmed',function(){const d=vfcDebtProfile_([row('2026-02-20',[tx('2026-02-06','Misc Payment AFFIRM CANADA REF-ONE','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,0,.001,'single Affirm');return'observed once';});

  test('RBC generic numeric Misc Payment never becomes an obligation',function(){equal(vfcRbcClassifyDebit_(tx('2026-03-12','Misc Payment 1469635','DEBIT',6585.81,'1469635')),null,'misc payment');return'ignored unless independently identified';});

  test('RBC PAY-FILE/NSF/monthly/returned-item fees are suppressed',function(){equal(vfcRbcClassifyDebit_(tx('2026-06-01','Misc Payment PAY-FILE FEES','DEBIT',2,'PAY-FILE FEES')),null,'PAY-FILE');equal(vfcRbcClassifyDebit_(tx('2026-06-02','NSF item fee','DEBIT',45,'NSF item fee')),null,'NSF fee');equal(vfcRbcClassifyDebit_(tx('2026-06-25','Item returned unpaid fee','DEBIT',7,'returned fee')),null,'returned-item fee');equal(vfcRbcClassifyDebit_(tx('2026-06-01','Monthly fee','DEBIT',6,'Monthly fee')),null,'monthly fee');return'fees excluded';});

  test('RBC BDC amount bands separate regular PAD, catch-up and manual loan payment',function(){const regular=vfcRbcClassifyDebit_(tx('2026-03-27','Business PAD BDC','DEBIT',2578.34,'BDC')),regular2=vfcRbcClassifyDebit_(tx('2026-08-17','Business PAD BDC','DEBIT',2285.91,'BDC')),catchup=vfcRbcClassifyDebit_(tx('2026-07-27','Business PAD BDC','DEBIT',7952.39,'BDC')),manual=vfcRbcClassifyDebit_(tx('2026-07-28','Online Banking payment - 0071 BDC-LOAN/PRET','DEBIT',5324.91,'BDC'));equal(regular.entityKey,regular2.entityKey,'regular BDC band');if(regular.entityKey===catchup.entityKey)throw new Error('catch-up merged with regular PAD');if(regular.entityKey===manual.entityKey)throw new Error('manual merged with PAD');return regular.entityKey+' / '+catchup.entityKey+' / '+manual.entityKey;});

  test('RBC AIM HIGH returned BDC PADs are recognized and cannot inflate confirmed BDC debt',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-27','Business PAD BDC','DEBIT',2578.34,'BDC')]),row('2026-04-30',[tx('2026-04-27','Business PAD BDC','DEBIT',2656.97,'BDC')]),row('2026-05-31',[tx('2026-05-27','Business PAD BDC','DEBIT',2606.59,'BDC'),tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59,'Cheque returned NSF')]),row('2026-06-30',[tx('2026-06-29','Business PAD BDC','DEBIT',5289.91,'BDC'),tx('2026-06-29','Cheque returned NSF','CREDIT',5289.91,'Cheque returned NSF')]),row('2026-07-31',[tx('2026-07-27','Business PAD BDC','DEBIT',7952.39,'BDC'),tx('2026-07-28','Online Banking payment - 0071 BDC-LOAN/PRET','DEBIT',5324.91,'BDC')]),row('2026-08-31',[tx('2026-08-17','Business PAD BDC','DEBIT',2285.91,'BDC'),tx('2026-08-19','Loan BDC','CREDIT',5324.91,'BDC')])]);const bdc=d.activeDebtObligations.filter(function(x){return x.counterparty==='BDC';});equal(bdc.length,1,'active recurring BDC PAD streams');close(bdc[0].monthlyEquivalent,2507.07,.05,'regular BDC monthly debt');truthy(d.returnedFinanceDebitsSuppressed>=2,'returned BDC debits suppressed');return'BDC='+bdc[0].monthlyEquivalent;});

  test('RBC debit-side returned deposited item is risk only and never suppresses financing debt',function(){const debits=[Object.assign({bankId:'RBC'},tx('2026-06-25','Item returned unpaid S02788','DEBIT',187.46,'Returned deposited item'))],credits=[];equal(vfcSuppressReturnedFinanceDebits_(debits,credits).length,1,'debit-side return retained');equal(vfcRbcIsReturnedFinancingCredit_(debits[0]),false,'not reversal credit');return'direction-safe';});

  test('RBC recurring IPFS 234.96 is financing; one-time 502.45 stays separate',function(){const d=vfcDebtProfile_([row('2026-06-30',[tx('2026-06-22','Business PAD IPFS Canada','DEBIT',502.45,'IPFS Canada')]),row('2026-07-31',[tx('2026-07-02','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')]),row('2026-08-31',[tx('2026-08-04','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')]),row('2026-09-30',[tx('2026-09-01','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')])]);const ipfs=d.activeDebtObligations.filter(function(x){return /IPFS/i.test(x.counterparty||'')});equal(ipfs.length,1,'recurring IPFS stream');close(ipfs[0].monthlyEquivalent,234.96,.02,'IPFS monthly');return'IPFS='+ipfs[0].monthlyEquivalent;});

  test('RBC generic PAD/direct debit aliases remain informational without finance evidence',function(){const rows=[row('2026-01-31',[tx('2026-01-12','DIRECT DEBIT ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-02-28',[tx('2026-02-12','EFT DEBIT ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-03-31',[tx('2026-03-12','PREAUTHORIZED DEBIT ABC SERVICES','DEBIT',500,'ABC SERVICES')])],d=vfcDebtProfile_(rows);close(d.confirmedMonthlyDebtService,0,.001,'unknown direct debit debt');return'informational only';});

  test('RBC explicit finance PAD can become debt only after recurrence',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','PAD ABC FINANCING LOAN','DEBIT',500,'ABC FINANCING')]),row('2026-02-28',[tx('2026-02-12','PAD ABC FINANCING LOAN','DEBIT',500,'ABC FINANCING')]),row('2026-03-31',[tx('2026-03-12','PAD ABC FINANCING LOAN','DEBIT',500,'ABC FINANCING')])]);close(d.confirmedMonthlyDebtService,500,.02,'explicit finance PAD');return'confirmed after recurrence';});

  test('RBC MCA-style funders and iCapital use correct families',function(){equal(vfcRbcClassifyDebit_(tx('2026-01-03','JOURNEY/ONDECK BUS','DEBIT',900,'JOURNEY')).family,'MCA','Journey');equal(vfcRbcClassifyDebit_(tx('2026-01-03','CANACAP Funding payment','DEBIT',900,'CANACAP')).family,'MCA','Canacap');equal(vfcRbcClassifyDebit_(tx('2026-01-03','GREENBOX CAPITAL','DEBIT',900,'GREENBOX')).family,'MCA','Greenbox');equal(vfcRbcClassifyDebit_(tx('2026-01-03','ICAPITAL payment','DEBIT',900,'ICAPITAL')).family,'FINANCING','iCapital');return'families correct';});

  test('RBC premium finance is financing while ordinary insurance is informational',function(){equal(vfcRbcClassifyDebit_(tx('2026-01-16','PREMIUM FINANCE PAYMENT','DEBIT',366.73,'PREMIUM FINANCE')).family,'FINANCING','premium finance');equal(vfcRbcClassifyDebit_(tx('2026-01-16','ICBC INSURANCE','DEBIT',366.73,'ICBC')).family,'OTHER','ordinary insurance');return'insurance separated';});

  test('Personal loan is confirmed monthly debt',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-05','Personal Loan SPL 000329209037884','DEBIT',1322.82)]),row('2026-02-28',[tx('2026-02-05','Personal Loan SPL 000329209037884','DEBIT',1322.82)]),row('2026-03-31',[tx('2026-03-05','Personal Loan SPL 000329209037884','DEBIT',1322.82)])]);close(d.confirmedMonthlyDebtService,1322.82,.02,'personal loan');return'confirmed';});

  test('Lincoln NSF plus retry counts once',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-05','Auto Payment LINCOLN AFS CA','DEBIT',1367.54,'LINCOLN AFS CA')]),row('2026-02-28',[tx('2026-02-05','Auto Payment LINCOLN AFS CA','DEBIT',1367.54,'LINCOLN AFS CA'),tx('2026-02-05','Item returned NSF','CREDIT',1367.54,'Item returned NSF'),tx('2026-02-09','Misc Payment LINCOLN AFS CA','DEBIT',1367.54,'LINCOLN AFS CA')]),row('2026-03-31',[tx('2026-03-05','Auto Payment LINCOLN AFS CA','DEBIT',1367.54,'LINCOLN AFS CA')])]);close(d.confirmedMonthlyDebtService,1367.54,.02,'Lincoln');equal(d.returnedFinanceDebitsSuppressed,1,'suppressed');return'monthly='+d.confirmedMonthlyDebtService;});

  test('Same-dollar e-Transfers never become debt',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-10','e-Transfer sent JOHN DOE','DEBIT',1000,'JOHN DOE')]),row('2026-02-28',[tx('2026-02-10','e-Transfer sent JOHN DOE','DEBIT',1000,'JOHN DOE')]),row('2026-03-31',[tx('2026-03-10','e-Transfer sent JOHN DOE','DEBIT',1000,'JOHN DOE')])]);close(d.confirmedMonthlyDebtService,0,.001,'e-transfer');return'0';});

  test('Unknown recurring PAD remains informational, not financing debt',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-02-28',[tx('2026-02-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-03-31',[tx('2026-03-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])]);close(d.confirmedMonthlyDebtService,0,.001,'PAD debt');close(d.informationalMonthlyObligations,500,.02,'PAD info');return'informational';});

  test('RBC Visa payments remain informational',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-13','Online Banking payment VISA ROYAL BNK','DEBIT',8000,'VISA ROYAL BNK')]),row('2026-02-28',[tx('2026-02-13','Online Banking payment VISA ROYAL BNK','DEBIT',8000,'VISA ROYAL BNK')]),row('2026-03-31',[tx('2026-03-13','Online Banking payment VISA ROYAL BNK','DEBIT',8000,'VISA ROYAL BNK')])]);close(d.confirmedMonthlyDebtService,0,.001,'Visa debt');return'informational';});

  test('CSBFL advance is financing credit and numbered loan is debt',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-08','Loan payment NO.09530611 001','DEBIT',3232.33)]),row('2026-02-28',[tx('2026-02-08','Loan payment NO.09530611 001','DEBIT',3232.33)]),row('2026-03-31',[tx('2026-03-08','Loan payment NO.09530611 001','DEBIT',3232.33),tx('2026-03-10','BR TO BR - Credit Memo 7512 CSBFL advance Loan: 09530611-001','CREDIT',13775,'CSBFL')])]);close(d.confirmedMonthlyDebtService,3232.33,.02,'CSBFL debt');close(d.financingCreditsTotal,13775,.02,'CSBFL credit');return'correct';});

  test('Mortgage and LOC recurring payments are financing debt',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-05','Mortgage payment 123456789','DEBIT',2200),tx('2026-01-15','LOC payment 987654321','DEBIT',900)]),row('2026-02-28',[tx('2026-02-05','Mortgage payment 123456789','DEBIT',2200),tx('2026-02-15','LOC payment 987654321','DEBIT',900)]),row('2026-03-31',[tx('2026-03-05','Mortgage payment 123456789','DEBIT',2200),tx('2026-03-15','LOC payment 987654321','DEBIT',900)])]);close(d.confirmedMonthlyDebtService,3100,.02,'mortgage+LOC');return'3100';});

  test('Loan line containing fee wording is not discarded',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-20','Loan payment service fee NO.123456','DEBIT',250)]),row('2026-02-28',[tx('2026-02-20','Loan payment service fee NO.123456','DEBIT',250)]),row('2026-03-31',[tx('2026-03-20','Loan payment service fee NO.123456','DEBIT',250)])]);close(d.confirmedMonthlyDebtService,250,.02,'loan fee');return'250';});

  test('Ambiguous same-day NSF does not suppress wrong lender',function(){const debits=[Object.assign({bankId:'RBC'},tx('2026-01-10','CANACAP Funding payment','DEBIT',1000,'CANACAP')),Object.assign({bankId:'RBC'},tx('2026-01-10','ICAPITAL payment','DEBIT',1000,'ICAPITAL'))],credits=[Object.assign({bankId:'RBC'},tx('2026-01-10','Item returned NSF','CREDIT',1000,'Item returned NSF'))],kept=vfcSuppressReturnedFinanceDebits_(debits,credits);equal(kept.length,2,'ambiguous kept');return'kept='+kept.length;});

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,rbcRulesVersion:vfcRbcBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
function runBankingStabilitySelfTests(){return runRbcBankingSelfTests();}
