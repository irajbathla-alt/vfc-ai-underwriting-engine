/** TD v1.4 — CANDIDATE / REVALIDATION REQUIRED. */
function vfcTdBankProfile_(){return{id:'TD',label:'TD',status:'CANDIDATE',rulesVersion:'TD-1.4-CANDIDATE',aliases:['TD CANADA TRUST','THE TORONTO-DOMINION BANK','TORONTO-DOMINION','TD BANK','TD CANADA TRUST BUSINESS']};}

function vfcTdExtractionRules_(){return [
  'TD statement direction is controlled only by the printed CHEQUE/DEBIT versus DEPOSIT/CREDIT columns.',
  'IMPORTANT TD FORMAT RULE: the Credits and Debits boxes printed at the bottom of each activity page are PAGE SUBTOTALS, not whole-statement totals. For a multi-page TD statement, total_deposits is the sum of every printed page Credits amount and total_withdrawals is the sum of every printed page Debits amount.',
  'The TD lock step independently reads the statement period, first BALANCE FORWARD, every page subtotal, deterministic closing balance, and monthly minimum OD flag. Do not apply RBC/generic balance-lock assumptions to TD continuation pages because each page repeats BALANCE FORWARD.',
  'Preserve every visible transaction required for recurrence and risk analysis, including standalone LOAN debits, LN PYMT, LN PYT INT, LN PYT PRI, RBC LOAN PYMT LOAN, TDCT LOC, FIRST INSURANCE LOAN, FORD CREDIT CA APY, BDC BUS, JOURNEY/ONDECK BUS, tax/government lines, insurance, transfers, NSF/return lines, deposits and financing credits.',
  'TD loan abbreviations are financing signals: standalone LOAN, LN PYMT, LN PYT INT, LN PYT PRI, LOAN PYMT, LOAN PAYMENT, and explicit LOAN/MORTGAGE/LOC/LINE OF CREDIT/MCA/LEASE/FINANCING wording.',
  'A numbered TD loan reference such as *602099601 or 900017902 is a strong debt identity. Repeated payments with the same reference are the same obligation even if wording varies between LN PYMT, LN PYT PRI or LN PYT INT. Principal and interest lines sharing the same reference are components of the same loan obligation.',
  'A standalone debit printed simply as LOAN is explicit financing evidence but does not become confirmed monthly debt until recurrence is observed.',
  'LN PYMT-C, RTN NSF and RTN#... FUNDS HELD are returned/reversal credits, not operating revenue. LN RTN FEE, NSF PAID FEE, NSF RETURN FEE, NSF and overdraft fees are risk/fee events, not debt service by themselves.',
  'FIRST INSURANCE LOAN is explicit loan wording and is financing when recurring. Ordinary ICBC INS or insurance-premium descriptions without loan wording remain informational.',
  'FORD CREDIT CA APY is a financing-obligation candidate. It must recur before a fixed monthly equivalent is confirmed.',
  'BDC BUS is a financing-obligation candidate. JOURNEY/ONDECK BUS is a financing/MCA candidate. They must recur before a fixed monthly equivalent is confirmed.',
  'RBC LOAN PYMT LOAN is a payment to an RBC loan and is a financing-obligation candidate even though it appears on a TD statement. When no loan reference is printed, materially different payment amounts are kept as separate observed streams so catch-up payments do not inflate the regular monthly obligation.',
  'EMPTX, GST-B, GST-P, TXBAL, TAX PYT and similar government remittances are TAX/informational, not financing debt.',
  'ICBC INS and other insurance descriptions without explicit loan wording are informational, not financing debt.',
  'TFR-FR C/C, TFR-TO C/C, E-TRANSFER, SEND E-TFR, GC ... TRANSFER and ordinary cheques are transfers, not debt. A transfer remains non-debt even when its memo contains the word LOAN.',
  'Same or near-identical dollar amount by itself NEVER proves debt.',
  'MONTHLY PLAN FEE, BUS LINE FEE, TAX PYT FEE and ordinary service/transaction fees are not debt obligations.',
  'A financing CREDIT must be printed in the DEPOSIT/CREDIT column and contain explicit financing wording or a known financing entity. Ordinary deposits and transfers are not financing merely because they are large.',
  'Preserve cheque-image pages only as supporting images; do not duplicate a cheque transaction already listed in the statement activity.'
].join('\n');}

function vfcTdLockFacts_(summary,text,fileName){
  const locked=Object.assign({},summary||{}),dates=vfcTdStatementDates_(text),opening=vfcTdOpeningBalance_(text),totals=vfcTdPageTotals_(text),negative=vfcTdNegativeBalanceFlag_(text);
  if(dates.startDate)locked.statement_start_date=dates.startDate;
  if(dates.endDate)locked.statement_end_date=dates.endDate;
  if(opening!==null)locked.opening_balance=opening;
  if(totals.expectedPageCount>0&&!totals.complete){
    throw new Error('TD printed page subtotals could not be fully verified for '+String(fileName||'statement')+'. Expected '+totals.expectedPageCount+' page(s), found '+totals.creditCount+' Credits subtotal(s) and '+totals.debitCount+' Debits subtotal(s).');
  }
  if(totals.pageCount>0){
    locked.total_deposits=totals.totalDeposits;
    locked.total_withdrawals=totals.totalWithdrawals;
    locked.td_page_subtotal_count=totals.pageCount;
    if(opening!==null)locked.closing_balance=vfcRound_(opening+totals.totalDeposits-totals.totalWithdrawals,.01);
  }
  if(negative!==null)locked.negative_balance_detected=negative;
  return locked;
}

function vfcTdStatementDates_(text){
  const s=String(text||'').replace(/\u00a0/g,' '),m=s.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{1,2})\/(\d{2,4})\s*[-–—]\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{1,2})\/(\d{2,4})\b/i);
  if(!m)return{startDate:'',endDate:''};
  return{startDate:vfcTdIsoParts_(m[1],m[2],m[3]),endDate:vfcTdIsoParts_(m[4],m[5],m[6])};
}
function vfcTdIsoParts_(month,day,year){
  const months={JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12},mm=months[String(month||'').toUpperCase()],dd=Number(day),raw=Number(year),yyyy=String(year||'').length===2?2000+raw:raw;
  if(!mm||!dd||!yyyy)return'';
  return String(yyyy).padStart(4,'0')+'-'+String(mm).padStart(2,'0')+'-'+String(dd).padStart(2,'0');
}

function vfcTdOpeningBalance_(text){
  const s=String(text||'').replace(/\u00a0/g,' '),m=s.match(/\bBALANCE\s+FORWARD(?:\s+[A-Z]{3}\s*\d{1,2}|\s+[A-Z]{3}\d{1,2})?\s+\$?([0-9][0-9,]*\.\d{2})\s*(OD)?\b/i);
  if(!m)return null;const n=Number(String(m[1]).replace(/,/g,''));if(!Number.isFinite(n))return null;return m[2]? -n:n;
}

function vfcTdDeclaredPageCount_(text){
  const s=String(text||''),re=/\bPage\s+\d+\s+of\s+(\d+)\b/gi;let m,max=0;while((m=re.exec(s))!==null)max=Math.max(max,Number(m[1])||0);return max;
}

function vfcTdPageTotals_(text){
  const s=String(text||'').replace(/\u00a0/g,' '),credits=[],debits=[],expectedPageCount=vfcTdDeclaredPageCount_(s);
  let m,re=/\bCredits\s+\d+\s+\$?([0-9][0-9,]*\.\d{2})\b/gi;
  while((m=re.exec(s))!==null)credits.push(Number(String(m[1]).replace(/,/g,''))||0);
  re=/\bDebits\s+\d+\s+\$?([0-9][0-9,]*\.\d{2})\b/gi;
  while((m=re.exec(s))!==null)debits.push(Number(String(m[1]).replace(/,/g,''))||0);
  const same=credits.length>0&&credits.length===debits.length,complete=same&&(!expectedPageCount||credits.length===expectedPageCount);
  if(!complete)return{pageCount:0,totalDeposits:0,totalWithdrawals:0,creditCount:credits.length,debitCount:debits.length,expectedPageCount:expectedPageCount,complete:false};
  return{pageCount:credits.length,totalDeposits:vfcRound_(credits.reduce(function(a,b){return a+b;},0),.01),totalWithdrawals:vfcRound_(debits.reduce(function(a,b){return a+b;},0),.01),creditCount:credits.length,debitCount:debits.length,expectedPageCount:expectedPageCount,complete:true};
}

function vfcTdNegativeBalanceFlag_(text){
  const s=String(text||'').replace(/\u00a0/g,' '),m=s.match(/MONTHLY\s+MIN\.\s+BAL\.\s+\$?([0-9][0-9,]*\.\d{2})\s*(OD)?\b/i);
  if(m)return!!m[2];if(/\b[0-9][0-9,]*\.\d{2}\s*OD\b/i.test(s))return true;return null;
}

function vfcTdClassifyDebit_(t){
  const raw=String(t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t.counterparty||'').replace(/\s+/g,' ').trim(),cents=Math.round(vfcNum_(t.amount)*100);
  if(/NSF\s+(?:PAID|RETURN)\s+FEE|LN\s+RTN\s+FEE|TAX\s+PYT\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE\s+FEE|MONTHLY\s+PLAN\s+FEE|BUS\s+LINE\s+FEE|SERVICE\s+CHARGE|TRANSACTION\s+FEE|^NSF(?:\s|$)/.test(s))return null;

  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/JOURNEY|ONDECK/.test(s)){family='MCA';entityKey='TD_JOURNEY_ONDECK';label='Journey / OnDeck';debtJustification='Known financing/MCA entity on a TD statement plus recurring observed payment cadence.';}
  else if(/\bBDC\b/.test(s)){family='FINANCING';entityKey='TD_BDC';label='BDC';debtJustification='Known business lender on a TD statement plus recurring observed payment cadence.';}
  else if(/FORD\s+CREDIT/.test(s)){family='FINANCING';entityKey='TD_FORD_CREDIT';label='Ford Credit';debtJustification='Known vehicle-finance counterparty on a TD statement plus recurring observed payment cadence.';}
  else if(/RBC\s+LOAN\s+PYMT\s+LOAN/.test(s)){family='FINANCING';entityKey='TD_RBC_LOAN_PAYMENT_'+cents;label='RBC Loan Payment';debtJustification='Explicit RBC loan-payment wording on the TD statement plus recurring observed cadence. Amount-separated identity prevents one-time catch-up payments from inflating the regular monthly stream when no reference is printed.';}
  else if(/\bLN\s+PYT\s+(?:INT|PRI)\b|\bLN\s+PYMT\b|\bLOAN\s+(?:PYMT|PAYMENT)\b/.test(s)){
    const n=vfcTdLoanReference_(s);family='FINANCING';entityKey=n?'TD_LOAN_'+n:'TD_UNREFERENCED_LOAN_'+cents;label=n?'TD Loan '+n:(cp||raw);debtJustification='Explicit TD loan-payment wording tied to a stable loan reference plus recurring observed cadence; principal and interest components with the same reference are one obligation. Unreferenced streams are kept amount-separated to avoid merging unrelated loans.';
  }
  else if(/^LOAN\s*$/i.test(raw)){family='FINANCING';entityKey='TD_STANDALONE_LOAN_'+cents;label='TD Loan';debtJustification='Standalone TD LOAN debit is explicit financing evidence. It becomes confirmed monthly debt only if the same financing stream recurs with a regular cadence.';}
  else if(vfcTdIsTransferDebit_(s))return null;
  else if(/\bEMPTX\b|\bGST[- ]?[BP]?\b|\bTXBAL\b|TAX\s+PYT|\bCRA\b|\bCCRA\b|\bHST\b/.test(s)){family='TAX';entityKey='TD_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/\bINSURANCE\b.*\bLOAN\b|\bLOAN\b.*\bINSURANCE\b/.test(s)){family='FINANCING';entityKey='TD_INSURANCE_LOAN_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;debtJustification='Explicit insurance-loan wording plus recurring observed payment cadence.';}
  else if(/\bICBC\s+INS\b|INSURANCE|PREMIUM\s+FIN/.test(s)){family='OTHER';entityKey='TD_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/CREDIT\s+CARD|VISA|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|\bMBNA\b/.test(s)){family='OTHER';entityKey='TD_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bMCA\b|\bLEASE\b|\bFINANC(?:E|ING)?\b|\bLOAN\b/.test(s)){
    const n=vfcTdLoanReference_(s);family='FINANCING';entityKey=n?'TD_LOAN_'+n:'TD_FINANCE_'+vfcCounterpartyKey_(cp||raw);label=n?'TD Loan '+n:(cp||raw);debtJustification='Explicit loan/mortgage/LOC/financing/lease/MCA wording plus recurring observed cadence.';
  }
  else if(/\bPAD\b|PRE[- ]?AUTH/.test(s)){family='OTHER';entityKey='TD_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else return null;
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcTdIsTransferDebit_(s){return/TFR-TO\s+C\/C|TFR-FR\s+C\/C|E-TRANSFER|SEND\s+E-TFR|\bTRANSFER\b|CHQ#|CHEQUE|ATM\s+W\/D|ATM\s+DEP|GC\s+\d+-(?:TRANSFER|DEPOSIT)/.test(String(s||'').toUpperCase());}

function vfcTdLoanReference_(s){
  s=String(s||'').toUpperCase();let m=s.match(/\*([0-9]{6,})/);if(m)return m[1];m=s.match(/(?:LN\s+PYT\s+(?:INT|PRI)|LN\s+PYMT|LOAN\s+(?:PYMT|PAYMENT))[^0-9]{0,20}([0-9]{6,})/);if(m)return m[1];m=s.match(/\b([0-9]{9})\b/);return m?m[1]:'';
}

function vfcTdKnownFinancingCredit_(t){
  const s=String((t&&t.description)||'').toUpperCase();if(vfcTdIsReturnedFinancingCredit_(t))return false;
  return /JOURNEY|ONDECK|\bBDC\b|LOAN\s+(?:ADVANCE|PROCEEDS|CREDIT)|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b/.test(s);
}

function vfcTdStrongEntityKey_(key){return/^(TD_JOURNEY_ONDECK|TD_BDC|TD_FORD_CREDIT|TD_RBC_LOAN_PAYMENT_|TD_INSURANCE_LOAN_|TD_LOAN_|TD_UNREFERENCED_LOAN_|TD_FINANCE_|TD_STANDALONE_LOAN_)/.test(String(key||'').toUpperCase());}

function vfcTdIsReturnedFinancingCredit_(t){
  const s=String((t&&t.description)||'').toUpperCase();return/\bLN\s+PYMT-C\b|\bLOAN\s+PYMT-C\b|\bLOAN\s+PAYMENT-C\b|^RTN\s+NSF\b|^RTN#?\d+\s+FUNDS\s+HELD\b|RETURNED\s+CHEQUE|CHEQUE\s+RETURNED/.test(s);
}
