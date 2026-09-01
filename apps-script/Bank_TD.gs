/** TD v1.2 — CANDIDATE / REVALIDATION REQUIRED. */
function vfcTdBankProfile_(){return{id:'TD',label:'TD',status:'CANDIDATE',rulesVersion:'TD-1.2-CANDIDATE',aliases:['TD CANADA TRUST','THE TORONTO-DOMINION BANK','TORONTO-DOMINION','TD BANK','TD CANADA TRUST BUSINESS']};}

function vfcTdExtractionRules_(){return [
  'TD statement direction is controlled only by the printed CHEQUE/DEBIT versus DEPOSIT/CREDIT columns.',
  'IMPORTANT TD FORMAT RULE: the Credits and Debits boxes printed at the bottom of each activity page are PAGE SUBTOTALS, not whole-statement totals. For a multi-page TD statement, total_deposits is the sum of every printed page Credits amount and total_withdrawals is the sum of every printed page Debits amount. Never use only the first or last page subtotal as the statement total.',
  'The TD lock step independently sums the printed Credits and Debits page subtotal boxes. Do not apply RBC/generic balance-lock assumptions to TD continuation pages because each TD page repeats BALANCE FORWARD.',
  'Preserve every visible transaction required for recurrence and risk analysis, including standalone LOAN debits, LN PYMT, LN PYT INT, LN PYT PRI, RBC LOAN PYMT LOAN, BDC BUS, JOURNEY/ONDECK BUS, tax/government lines, insurance, transfers, NSF/return lines, deposits and financing credits.',
  'TD loan abbreviations are financing signals: standalone LOAN, LN PYMT, LN PYT INT, LN PYT PRI, LOAN PYMT, LOAN PAYMENT, and explicit LOAN/MORTGAGE/LOC/LINE OF CREDIT/MCA/LEASE/FINANCING wording.',
  'A numbered TD loan reference such as *602099601 or 900017902 is a strong debt identity. Repeated payments with the same reference are the same obligation even if wording varies between LN PYMT, LN PYT PRI or LN PYT INT. Principal and interest lines sharing the same reference are components of the same loan obligation and their monthly cash outflow is combined by the shared Banking Core.',
  'A standalone debit printed simply as LOAN is an explicit financing candidate. It is not a confirmed monthly obligation unless recurrence is observed. Same or near-identical amount plus recurrence can confirm that specific standalone-loan stream.',
  'LN PYMT-C is a returned/reversed loan-payment CREDIT, not revenue. LN RTN FEE is a fee/risk event. Preserve both exactly; TD return-netting can be applied deterministically during revalidation without changing the printed facts.',
  'NSF PAID FEE, NSF RETURN FEE, LN RTN FEE, OVERDRAFT INTEREST and PAYMENT COVERAGE FEE are risk/fee events, not financing debt service by themselves.',
  'BDC BUS is a financing-obligation candidate. JOURNEY/ONDECK BUS is a financing/MCA candidate. They must recur before a fixed monthly equivalent is confirmed.',
  'RBC LOAN PYMT LOAN is a payment to an RBC loan and is a financing-obligation candidate even though it appears on a TD statement.',
  'EMPTX, GST-B, GST-P, TXBAL, TAX PYT and similar government remittances are TAX/informational, not financing debt.',
  'ICBC INS and other insurance descriptions are informational, not financing debt.',
  'TFR-FR C/C, TFR-TO C/C, E-TRANSFER, SEND E-TFR, GC ... TRANSFER and ordinary cheques are not debt merely because they recur or use the same amount.',
  'Same or near-identical dollar amount by itself NEVER proves debt.',
  'MONTHLY PLAN FEE, BUS LINE FEE and ordinary service/transaction fees are not debt obligations.',
  'A financing CREDIT must be printed in the DEPOSIT/CREDIT column and contain explicit financing wording or a known financing entity. Ordinary deposits and transfers are not financing merely because they are large.',
  'Preserve cheque-image pages only as supporting images; do not duplicate a cheque transaction already listed in the statement activity.'
].join('\n');}

/**
 * TD has its own statement layout. Do NOT call the generic printed-fact lock here:
 * continuation pages repeat BALANCE FORWARD and can be mistaken for the statement opening balance.
 * We preserve OpenAI's first-page statement metadata, then deterministically override only facts
 * that TD exposes in a stable printed structure: first BALANCE FORWARD and page Credits/Debits totals.
 */
function vfcTdLockFacts_(summary,text,fileName){
  const locked=Object.assign({},summary||{}),opening=vfcTdOpeningBalance_(text),totals=vfcTdPageTotals_(text);
  if(opening!==null)locked.opening_balance=opening;
  if(totals.pageCount>0){
    locked.total_deposits=totals.totalDeposits;
    locked.total_withdrawals=totals.totalWithdrawals;
    locked.td_page_subtotal_count=totals.pageCount;
  }
  return locked;
}

/** First BALANCE FORWARD in TD activity is the statement opening balance. */
function vfcTdOpeningBalance_(text){
  const s=String(text||'').replace(/\u00a0/g,' '),m=s.match(/\bBALANCE\s+FORWARD(?:\s+[A-Z]{3}\s*\d{1,2}|\s+[A-Z]{3}\d{1,2})?\s+\$?([0-9][0-9,]*\.\d{2})(OD)?\b/i);
  if(!m)return null;const n=Number(String(m[1]).replace(/,/g,''));if(!Number.isFinite(n))return null;return m[2]? -n:n;
}

/**
 * TD footer parser. Credits and Debits are parsed independently because Google Drive OCR can
 * alter column/line spacing. A valid statement page contributes one Credits subtotal and one
 * Debits subtotal. We only override AI totals when both sides have the same non-zero page count.
 */
function vfcTdPageTotals_(text){
  const s=String(text||'').replace(/\u00a0/g,' '),credits=[],debits=[];
  let m,re=/\bCredits\s+\d+\s+\$?([0-9][0-9,]*\.\d{2})\b/gi;
  while((m=re.exec(s))!==null)credits.push(Number(String(m[1]).replace(/,/g,''))||0);
  re=/\bDebits\s+\d+\s+\$?([0-9][0-9,]*\.\d{2})\b/gi;
  while((m=re.exec(s))!==null)debits.push(Number(String(m[1]).replace(/,/g,''))||0);
  if(!credits.length||credits.length!==debits.length)return{pageCount:0,totalDeposits:0,totalWithdrawals:0,creditCount:credits.length,debitCount:debits.length};
  const totalDeposits=credits.reduce(function(a,b){return a+b;},0),totalWithdrawals=debits.reduce(function(a,b){return a+b;},0);
  return{pageCount:credits.length,totalDeposits:vfcRound_(totalDeposits,.01),totalWithdrawals:vfcRound_(totalWithdrawals,.01),creditCount:credits.length,debitCount:debits.length};
}

function vfcTdClassifyDebit_(t){
  const raw=String(t.description||'').replace(/\s+/g,' ').trim();
  const s=raw.toUpperCase();
  const cp=String(t.counterparty||'').replace(/\s+/g,' ').trim();
  const fee=/NSF\s+(?:PAID|RETURN)\s+FEE|LN\s+RTN\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE\s+FEE|MONTHLY\s+PLAN\s+FEE|BUS\s+LINE\s+FEE|SERVICE\s+CHARGE|TRANSACTION\s+FEE/.test(s);
  if(fee)return null;

  let family='',entityKey='',label=cp||raw,debtJustification='';

  if(/JOURNEY|ONDECK/.test(s)){
    family='MCA';entityKey='TD_JOURNEY_ONDECK';label='Journey / OnDeck';
    debtJustification='Known financing/MCA entity on a TD statement plus recurring observed payment cadence.';
  }
  else if(/\bBDC\b/.test(s)){
    family='FINANCING';entityKey='TD_BDC';label='BDC';
    debtJustification='Known business lender on a TD statement plus recurring observed payment cadence.';
  }
  else if(/RBC\s+LOAN\s+PYMT\s+LOAN/.test(s)){
    family='FINANCING';entityKey='TD_RBC_LOAN_PAYMENT';label='RBC Loan Payment';
    debtJustification='Explicit RBC loan-payment wording on the TD statement plus recurring observed cadence.';
  }
  else if(/\bEMPTX\b|\bGST[- ]?[BP]?\b|\bTXBAL\b|TAX\s+PYT|\bCRA\b|\bCCRA\b|\bHST\b/.test(s)){
    family='TAX';entityKey='TD_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
  }
  else if(/\bICBC\s+INS\b|INSURANCE|PREMIUM\s+FIN/.test(s)){
    family='OTHER';entityKey='TD_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
  }
  else if(/CREDIT\s+CARD|VISA|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|\bMBNA\b/.test(s)){
    family='OTHER';entityKey='TD_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
  }
  else if(/\bLN\s+PYT\s+(?:INT|PRI)\b|\bLN\s+PYMT\b|\bLOAN\s+(?:PYMT|PAYMENT)\b/.test(s)){
    const n=vfcTdLoanReference_(s);family='FINANCING';entityKey=n?'TD_LOAN_'+n:'TD_FINANCE_'+vfcCounterpartyKey_(cp||raw);label=n?'TD Loan '+n:(cp||raw);
    debtJustification='Explicit TD loan-payment wording tied to a stable loan reference plus recurring observed cadence; principal and interest components with the same reference are one obligation.';
  }
  else if(/^LOAN\s*$/i.test(raw)){
    const cents=Math.round(vfcNum_(t.amount)*100);family='FINANCING';entityKey='TD_STANDALONE_LOAN_'+cents;label='TD Loan';
    debtJustification='Standalone TD LOAN debit is explicit financing evidence. It becomes confirmed monthly debt only if the same financing stream recurs with a regular cadence.';
  }
  else if(/\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bMCA\b|\bLEASE\b|\bFINANC(?:E|ING)?\b|\bLOAN\b/.test(s)){
    const n=vfcTdLoanReference_(s);family='FINANCING';entityKey=n?'TD_LOAN_'+n:'TD_FINANCE_'+vfcCounterpartyKey_(cp||raw);label=n?'TD Loan '+n:(cp||raw);
    debtJustification='Explicit loan/mortgage/LOC/financing/lease/MCA wording plus recurring observed cadence.';
  }
  else if(/\bPAD\b|PRE[- ]?AUTH/.test(s)){
    family='OTHER';entityKey='TD_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
  }
  else if(/TFR-TO\s+C\/C|TFR-FR\s+C\/C|E-TRANSFER|SEND\s+E-TFR|TRANSFER|CHQ#|CHEQUE|ATM\s+W\/D|ATM\s+DEP/.test(s)){
    return null;
  }
  else return null;

  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcTdLoanReference_(s){
  s=String(s||'').toUpperCase();
  let m=s.match(/\*([0-9]{6,})/);if(m)return m[1];
  m=s.match(/(?:LN\s+PYT\s+(?:INT|PRI)|LN\s+PYMT|LOAN\s+(?:PYMT|PAYMENT))[^0-9]{0,20}([0-9]{6,})/);if(m)return m[1];
  m=s.match(/\b([0-9]{9})\b/);return m?m[1]:'';
}

function vfcTdKnownFinancingCredit_(t){
  const s=String((t&&t.description)||'').toUpperCase();
  return /JOURNEY|ONDECK|\bBDC\b|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b/.test(s);
}

function vfcTdStrongEntityKey_(key){
  return /^(TD_JOURNEY_ONDECK|TD_BDC|TD_RBC_LOAN_PAYMENT|TD_LOAN_|TD_FINANCE_|TD_STANDALONE_LOAN_)/.test(String(key||'').toUpperCase());
}

function vfcTdIsReturnedFinancingCredit_(t){
  const s=String((t&&t.description)||'').toUpperCase();
  return /\bLN\s+PYMT-C\b|\bLOAN\s+PYMT-C\b|\bLOAN\s+PAYMENT-C\b/.test(s);
}
