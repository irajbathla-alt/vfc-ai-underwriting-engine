/** TD v1.0 — CANDIDATE / REVALIDATION REQUIRED. */
function vfcTdBankProfile_(){return{id:'TD',label:'TD',status:'CANDIDATE',rulesVersion:'TD-1.0-CANDIDATE',aliases:['TD CANADA TRUST','THE TORONTO-DOMINION BANK','TORONTO-DOMINION','TD BANK','TD CANADA TRUST BUSINESS']};}

function vfcTdExtractionRules_(){return [
  'TD statement header: Credits total is total_deposits and Debits total is total_withdrawals. Use the printed header totals; do not recompute them from transaction rows.',
  'TD transaction direction is controlled only by the printed CHEQUE/DEBIT versus DEPOSIT/CREDIT columns.',
  'Preserve every visible transaction required for recurrence and risk analysis, including LN PYMT, LN PYT INT, LN PYT PRI, RBC LOAN PYMT LOAN, BDC BUS, JOURNEY/ONDECK BUS, tax/government lines, insurance, transfers, NSF/return lines, deposits and financing credits.',
  'TD loan abbreviations are financing signals: LN PYMT, LN PYT INT, LN PYT PRI, LOAN PYMT, LOAN PAYMENT, and explicit LOAN/MORTGAGE/LOC/LINE OF CREDIT/MCA/LEASE/FINANCING wording.',
  'A numbered TD loan reference such as *602099601 or 900017902 is a strong debt identity. Repeated payments with the same reference are the same obligation even if wording varies between LN PYMT, LN PYT PRI or LN PYT INT.',
  'LN PYMT-C is a returned/reversed loan-payment CREDIT, not revenue. LN RTN FEE is a fee/risk event. If a reversed loan debit is retried, the failed debit must not create an extra monthly obligation.',
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

function vfcTdLockFacts_(summary,text,fileName){return vfcLockPrintedStatementFacts_(summary,text);}

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
  else if(/\bLN\s+PYT\s+INT\b/.test(s)){
    const n=vfcTdLoanReference_(s);family='FINANCING';entityKey='TD_LOAN_INTEREST_'+(n||vfcCounterpartyKey_(cp||raw));label=n?'TD Loan Interest '+n:(cp||raw);
    debtJustification='Explicit TD loan-interest wording tied to a loan reference plus recurring observed cadence.';
  }
  else if(/\bLN\s+PYT\s+PRI\b/.test(s)){
    const n=vfcTdLoanReference_(s);family='FINANCING';entityKey='TD_LOAN_PRINCIPAL_'+(n||vfcCounterpartyKey_(cp||raw));label=n?'TD Loan Principal '+n:(cp||raw);
    debtJustification='Explicit TD loan-principal wording tied to a loan reference plus recurring observed cadence.';
  }
  else if(/\bLN\s+PYMT\b|\bLOAN\s+(?:PYMT|PAYMENT)\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bMCA\b|\bLEASE\b|\bFINANC(?:E|ING)?\b/.test(s)){
    const n=vfcTdLoanReference_(s);family='FINANCING';entityKey=n?'TD_LOAN_'+n:'TD_FINANCE_'+vfcCounterpartyKey_(cp||raw);label=n?'TD Loan '+n:(cp||raw);
    debtJustification='Explicit TD loan/financing wording plus recurring observed cadence.';
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
  return /^(TD_JOURNEY_ONDECK|TD_BDC|TD_RBC_LOAN_PAYMENT|TD_LOAN_|TD_LOAN_INTEREST_|TD_LOAN_PRINCIPAL_|TD_FINANCE_)/.test(String(key||'').toUpperCase());
}

function vfcTdIsReturnedFinancingCredit_(t){
  const s=String((t&&t.description)||'').toUpperCase();
  return /\bLN\s+PYMT-C\b|\bLOAN\s+PYMT-C\b|\bLOAN\s+PAYMENT-C\b/.test(s);
}
