/**
 * TD BANK ENGINE v1.7 — CANDIDATE
 *
 * One permanent TD module. All TD-specific behavior lives here:
 * - extraction instructions
 * - printed statement fact locking
 * - page / cheque-image handling
 * - debit classification and debt identity
 * - financing-credit classification
 * - returned / reversed credit recognition
 * - deterministic TD regression tests
 *
 * Shared recurrence math, frozen-fact storage and underwriting remain in BankingCore.gs.
 */
function vfcTdBankProfile_(){
  return{
    id:'TD',
    label:'TD',
    status:'CANDIDATE',
    rulesVersion:'TD-1.7-CANDIDATE',
    aliases:['TD CANADA TRUST','THE TORONTO-DOMINION BANK','TORONTO-DOMINION','TD BANK','TD CANADA TRUST BUSINESS']
  };
}

function vfcTdExtractionRules_(){return[
  'TD statement direction is controlled only by the printed CHEQUE/DEBIT versus DEPOSIT/CREDIT columns.',
  'The Credits and Debits boxes printed at the bottom of each TD activity page are PAGE SUBTOTALS, not whole-statement totals. Sum every verified activity-page Credits amount for total_deposits and every verified activity-page Debits amount for total_withdrawals.',
  'TD Page X of Y can include cheque-image support pages. Cheque-image pages do not contain Credits/Debits activity subtotals and must not be treated as missing activity or duplicated as transactions.',
  'The TD lock step independently reads the statement period, first BALANCE FORWARD, all activity-page subtotals, deterministic closing balance and monthly minimum OD flag. Never use later continuation-page BALANCE FORWARD values as the opening balance.',
  'Preserve every visible transaction needed for recurrence and risk analysis, including standalone LOAN, LN PYMT, LN PYT INT, LN PYT PRI, RBC LOAN PYMT LOAN, TDCT LOC, FIRST INSURANCE LOAN, FORD CREDIT CA APY, BDC BUS, JOURNEY/ONDECK BUS, tax/government lines, insurance, transfers, NSF/return lines, deposits and financing-credit candidates.',
  'TD loan abbreviations are financing signals: standalone LOAN, LN PYMT, LN PYT INT, LN PYT PRI, LOAN PYMT, LOAN PAYMENT and explicit LOAN/MORTGAGE/LOC/LINE OF CREDIT/MCA/LEASE/FINANCING wording.',
  'A numbered TD loan reference such as *602099601 or 900017902 is a strong debt identity. Repeated payments with the same reference are the same obligation even when wording changes. Principal and interest with the same reference are components of one obligation.',
  'A standalone debit printed simply as LOAN is explicit financing evidence but is not confirmed monthly debt until recurrence is observed.',
  'LN PYMT-C, RTN NSF, RTN#... NSF, RTN#... FUNDS HELD and returned-cheque credits are reversal/return credits, not operating revenue. Return fees and NSF fees are risk/fee events, not debt service.',
  'FIRST INSURANCE LOAN is financing when recurring. Ordinary ICBC INS or insurance-premium descriptions without explicit loan wording remain informational.',
  'FORD CREDIT CA APY is a vehicle-financing candidate and must recur before a fixed monthly equivalent is confirmed.',
  'BDC BUS is a financing candidate. JOURNEY/ONDECK BUS is a financing/MCA candidate. They must recur before fixed monthly debt is confirmed.',
  'RBC LOAN PYMT LOAN is financing even though it appears on a TD account. When no reference is printed, materially different payment amounts remain separate streams so a catch-up payment cannot inflate the regular monthly obligation.',
  'EMPTX, GST-B, GST-P, TXBAL, TAX PYT, CRA, CCRA and HST are TAX/informational, not financing debt.',
  'TFR-FR C/C, TFR-TO C/C, E-TRANSFER, SEND E-TFR, GC ... TRANSFER and ordinary cheques are transfers, not debt. A transfer remains non-debt even if its memo contains the word LOAN.',
  'Same or near-identical dollar amount by itself NEVER proves debt.',
  'MONTHLY PLAN FEE, BUS LINE FEE, TAX PYT FEE, SERVICE CHARGE and ordinary transaction fees are not debt obligations.',
  'A financing CREDIT must be in the DEPOSIT/CREDIT column and contain explicit financing wording or a known financing entity. Ordinary deposits and transfers are not financing merely because they are large.',
  'Cheque-image pages are supporting images only. Do not duplicate a cheque already listed in statement activity.'
].join('\n');}

/* =========================
 * PRINTED TD FACT LOCKING
 * ========================= */
function vfcTdLockFacts_(summary,text,fileName){
  const locked=Object.assign({},summary||{});
  const dates=vfcTdStatementDates_(text);
  const opening=vfcTdOpeningBalance_(text);
  const totals=vfcTdPageTotals_(text);
  const negative=vfcTdNegativeBalanceFlag_(text);

  if(dates.startDate)locked.statement_start_date=dates.startDate;
  if(dates.endDate)locked.statement_end_date=dates.endDate;
  if(opening!==null)locked.opening_balance=opening;

  if(!totals.complete){
    throw new Error(
      'TD printed activity-page subtotals could not be fully verified for '+String(fileName||'statement')+
      '. PDF pages: '+totals.declaredPageCount+
      ', cheque-image pages: '+totals.chequeImagePageCount+
      ', expected activity pages: '+totals.expectedActivityPageCount+
      ', found '+totals.creditCount+' Credits subtotal(s) and '+totals.debitCount+' Debits subtotal(s).'
    );
  }

  locked.total_deposits=totals.totalDeposits;
  locked.total_withdrawals=totals.totalWithdrawals;
  locked.td_page_subtotal_count=totals.pageCount;
  locked.td_cheque_image_page_count=totals.chequeImagePageCount;
  if(opening!==null)locked.closing_balance=vfcRound_(opening+totals.totalDeposits-totals.totalWithdrawals,.01);
  if(negative!==null)locked.negative_balance_detected=negative;
  return locked;
}

function vfcTdStatementDates_(text){
  const s=String(text||'').replace(/\u00a0/g,' ');
  const m=s.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{1,2})\/(\d{2,4})\s*[-–—]\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{1,2})\/(\d{2,4})\b/i);
  if(!m)return{startDate:'',endDate:''};
  return{startDate:vfcTdIsoParts_(m[1],m[2],m[3]),endDate:vfcTdIsoParts_(m[4],m[5],m[6])};
}

function vfcTdIsoParts_(month,day,year){
  const months={JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};
  const mm=months[String(month||'').toUpperCase()],dd=Number(day),raw=Number(year),yyyy=String(year||'').length===2?2000+raw:raw;
  if(!mm||!dd||!yyyy)return'';
  return String(yyyy).padStart(4,'0')+'-'+String(mm).padStart(2,'0')+'-'+String(dd).padStart(2,'0');
}

function vfcTdOpeningBalance_(text){
  const s=String(text||'').replace(/\u00a0/g,' ');
  const m=s.match(/\bBALANCE\s+FORWARD(?:\s+[A-Z]{3}\s*\d{1,2}|\s+[A-Z]{3}\d{1,2})?\s+\$?([0-9][0-9,]*\.\d{2})\s*(OD)?\b/i);
  if(!m)return null;
  const n=Number(String(m[1]).replace(/,/g,''));
  if(!Number.isFinite(n))return null;
  return m[2]?-n:n;
}

function vfcTdPageStructure_(text){
  const s=String(text||'');
  const re=/\bPage\s+(\d+)\s+of\s+(\d+)\b/gi,marks=[];
  let m,declared=0;
  while((m=re.exec(s))!==null){
    marks.push({page:Number(m[1])||0,total:Number(m[2])||0,index:m.index});
    declared=Math.max(declared,Number(m[2])||0);
  }

  let chequeImagePageCount=0,activityPageCount=0,unknownPageCount=0;
  marks.forEach(function(mark,i){
    const segment=s.slice(mark.index,i+1<marks.length?marks[i+1].index:s.length);
    const hasCredits=/\bCredits\s+\d+\s+\$?[0-9][0-9,]*\.\d{2}\b/i.test(segment);
    const hasDebits=/\bDebits\s+\d+\s+\$?[0-9][0-9,]*\.\d{2}\b/i.test(segment);
    const hasChequeImage=/\b(?:CHEQUE|CHQ)\s*#\s*\d+/i.test(segment);
    if(hasCredits||hasDebits)activityPageCount++;
    else if(hasChequeImage)chequeImagePageCount++;
    else unknownPageCount++;
  });

  /* Some Drive OCR exports omit the Page marker on image-only pages. */
  const unmarkedPages=Math.max(0,declared-marks.length);
  if(unmarkedPages>0&&/\b(?:CHEQUE|CHQ)\s*#\s*\d+/i.test(s))chequeImagePageCount+=unmarkedPages;

  const expectedActivityPageCount=declared?Math.max(0,declared-chequeImagePageCount):activityPageCount;
  return{
    declaredPageCount:declared,
    activityPageCount:activityPageCount,
    chequeImagePageCount:chequeImagePageCount,
    unknownPageCount:unknownPageCount,
    expectedActivityPageCount:expectedActivityPageCount
  };
}

function vfcTdPageTotals_(text){
  const s=String(text||'').replace(/\u00a0/g,' '),credits=[],debits=[],structure=vfcTdPageStructure_(s);
  let m,re=/\bCredits\s+\d+\s+\$?([0-9][0-9,]*\.\d{2})\b/gi;
  while((m=re.exec(s))!==null)credits.push(Number(String(m[1]).replace(/,/g,''))||0);
  re=/\bDebits\s+\d+\s+\$?([0-9][0-9,]*\.\d{2})\b/gi;
  while((m=re.exec(s))!==null)debits.push(Number(String(m[1]).replace(/,/g,''))||0);

  const same=credits.length>0&&credits.length===debits.length;
  const expected=structure.expectedActivityPageCount;
  const complete=same&&(!expected||credits.length===expected);
  const base={
    pageCount:complete?credits.length:0,
    totalDeposits:complete?vfcRound_(credits.reduce(function(a,b){return a+b;},0),.01):0,
    totalWithdrawals:complete?vfcRound_(debits.reduce(function(a,b){return a+b;},0),.01):0,
    creditCount:credits.length,
    debitCount:debits.length,
    complete:complete
  };
  return Object.assign(base,structure);
}

function vfcTdNegativeBalanceFlag_(text){
  const s=String(text||'').replace(/\u00a0/g,' ');
  const m=s.match(/MONTHLY\s+MIN\.\s+BAL\.\s+\$?([0-9][0-9,]*\.\d{2})\s*(OD)?\b/i);
  if(m)return!!m[2];
  if(/\b[0-9][0-9,]*\.\d{2}\s*OD\b/i.test(s))return true;
  return null;
}

/* =========================
 * TD TRANSACTION CLASSIFIER
 * ========================= */
function vfcTdClassifyDebit_(t){
  const raw=String(t.description||'').replace(/\s+/g,' ').trim();
  const s=raw.toUpperCase();
  const cp=String(t.counterparty||'').replace(/\s+/g,' ').trim();
  const cents=Math.round(vfcNum_(t.amount)*100);

  if(/NSF\s+(?:PAID|RETURN)\s+FEE|LN\s+RTN\s+FEE|TAX\s+PYT\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE\s+FEE|MONTHLY\s+PLAN\s+FEE|BUS\s+LINE\s+FEE|SERVICE\s+CHARGE|TRANSACTION\s+FEE|^NSF(?:\s|$)/.test(s))return null;

  let family='',entityKey='',label=cp||raw,debtJustification='';

  if(/JOURNEY|ONDECK/.test(s)){
    family='MCA';entityKey='TD_JOURNEY_ONDECK';label='Journey / OnDeck';
    debtJustification='Known financing/MCA entity on a TD statement plus recurring observed payment cadence.';
  }
  else if(/\bBDC\b/.test(s)){
    family='FINANCING';entityKey='TD_BDC';label='BDC';
    debtJustification='Known business lender on a TD statement plus recurring observed payment cadence.';
  }
  else if(/FORD\s+CREDIT/.test(s)){
    family='FINANCING';entityKey='TD_FORD_CREDIT';label='Ford Credit';
    debtJustification='Known vehicle-finance counterparty on a TD statement plus recurring observed payment cadence.';
  }
  else if(/RBC\s+LOAN\s+PYMT\s+LOAN/.test(s)){
    family='FINANCING';entityKey='TD_RBC_LOAN_PAYMENT_'+cents;label='RBC Loan Payment';
    debtJustification='Explicit RBC loan-payment wording on the TD statement plus recurring observed cadence. Amount-separated identity prevents one-time catch-up payments from inflating the regular monthly stream when no reference is printed.';
  }
  else if(/\bLN\s+PYT\s+(?:INT|PRI)\b|\bLN\s+PYMT\b|\bLOAN\s+(?:PYMT|PAYMENT)\b/.test(s)){
    const n=vfcTdLoanReference_(s);
    family='FINANCING';entityKey=n?'TD_LOAN_'+n:'TD_UNREFERENCED_LOAN_'+cents;label=n?'TD Loan '+n:(cp||raw);
    debtJustification='Explicit TD loan-payment wording tied to a stable loan reference plus recurring observed cadence; principal and interest with the same reference are one obligation. Unreferenced streams are amount-separated to avoid merging unrelated loans.';
  }
  else if(/^LOAN\s*$/i.test(raw)){
    family='FINANCING';entityKey='TD_STANDALONE_LOAN_'+cents;label='TD Loan';
    debtJustification='Standalone TD LOAN debit is explicit financing evidence. It becomes confirmed monthly debt only when the same stream recurs.';
  }
  else if(vfcTdIsTransferDebit_(s))return null;
  else if(/\bEMPTX\b|\bGST[- ]?[BP]?\b|\bTXBAL\b|TAX\s+PYT|\bCRA\b|\bCCRA\b|\bHST\b/.test(s)){
    family='TAX';entityKey='TD_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
  }
  else if(/\bINSURANCE\b.*\bLOAN\b|\bLOAN\b.*\bINSURANCE\b/.test(s)){
    family='FINANCING';entityKey='TD_INSURANCE_LOAN_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
    debtJustification='Explicit insurance-loan wording plus recurring observed payment cadence.';
  }
  else if(/\bICBC\s+INS\b|INSURANCE|PREMIUM\s+FIN/.test(s)){
    family='OTHER';entityKey='TD_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
  }
  else if(/CREDIT\s+CARD|VISA|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|\bMBNA\b/.test(s)){
    family='OTHER';entityKey='TD_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
  }
  else if(/\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bMCA\b|\bLEASE\b|\bFINANC(?:E|ING)?\b|\bLOAN\b/.test(s)){
    const n=vfcTdLoanReference_(s);
    family='FINANCING';entityKey=n?'TD_LOAN_'+n:'TD_FINANCE_'+vfcCounterpartyKey_(cp||raw);label=n?'TD Loan '+n:(cp||raw);
    debtJustification='Explicit loan/mortgage/LOC/financing/lease/MCA wording plus recurring observed cadence.';
  }
  else if(/\bPAD\b|PRE[- ]?AUTH/.test(s)){
    family='OTHER';entityKey='TD_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
  }
  else return null;

  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcTdIsTransferDebit_(s){
  return/TFR-TO\s+C\/C|TFR-FR\s+C\/C|E-TRANSFER|SEND\s+E-TFR|\bTRANSFER\b|CHQ#|CHEQUE|ATM\s+W\/D|ATM\s+DEP|GC\s+\d+-(?:TRANSFER|DEPOSIT)/.test(String(s||'').toUpperCase());
}

function vfcTdLoanReference_(s){
  s=String(s||'').toUpperCase();
  let m=s.match(/\*([0-9]{6,})/);if(m)return m[1];
  m=s.match(/(?:LN\s+PYT\s+(?:INT|PRI)|LN\s+PYMT|LOAN\s+(?:PYMT|PAYMENT))[^0-9]{0,20}([0-9]{6,})/);if(m)return m[1];
  m=s.match(/\b([0-9]{9})\b/);return m?m[1]:'';
}

function vfcTdKnownFinancingCredit_(t){
  const s=String((t&&t.description)||'').toUpperCase();
  if(vfcTdIsReturnedFinancingCredit_(t))return false;
  return/JOURNEY|ONDECK|\bBDC\b|LOAN\s+(?:ADVANCE|PROCEEDS|CREDIT)|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b/.test(s);
}

function vfcTdStrongEntityKey_(key){
  return/^(TD_JOURNEY_ONDECK|TD_BDC|TD_FORD_CREDIT|TD_RBC_LOAN_PAYMENT_|TD_INSURANCE_LOAN_|TD_LOAN_|TD_UNREFERENCED_LOAN_|TD_FINANCE_|TD_STANDALONE_LOAN_)/.test(String(key||'').toUpperCase());
}

function vfcTdIsReturnedFinancingCredit_(t){
  const s=String((t&&t.description)||'').toUpperCase();
  return/\bLN\s+PYMT-C\b|\bLOAN\s+PYMT-C\b|\bLOAN\s+PAYMENT-C\b|^RTN\s+NSF\b|^RTN#?\d+\s+(?:NSF|FUNDS\s+HELD)\b|RETURNED\s+CHEQUE|CHEQUE\s+RETURNED/.test(s);
}

/* =========================
 * TD REGRESSION SUITE
 * Lives here deliberately: one TD file, one source of truth.
 * No Sheets, Drive or OpenAI calls.
 * ========================= */
function runTdBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'TD',transactions:transactions||[]}};}
  function close(actual,expected,tol,label){tol=tol==null?.02:tol;if(Math.abs(Number(actual||0)-Number(expected||0))>tol)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function equal(actual,expected,label){if(actual!==expected)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function truthy(value,label){if(!value)throw new Error((label||'value')+' expected truthy');}
  function test(name,fn){try{const detail=fn()||'';results.push({name:name,pass:true,detail:String(detail||'')});}catch(e){results.push({name:name,pass:false,detail:String(e&&e.message||e)});}}
  function footerText(range,opening,pages,minLine){
    const parts=[range,'BALANCE FORWARD '+String(range||'').split(' ')[0]+'01 '+(opening<0?Math.abs(opening).toFixed(2)+'OD':Number(opening).toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2}))];
    (pages||[]).forEach(function(p,i){parts.push('Page '+(i+1)+' of '+pages.length);parts.push('Credits '+(p[2]||0)+' '+Number(p[0]).toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2}));parts.push('Debits '+(p[3]||0)+' '+Number(p[1]).toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2}));});
    if(minLine)parts.push(minLine);return parts.join('\n');
  }

  test('Waveform nine real TD statements reconcile exactly',function(){
    const cases=[
      {range:'APR 01/25 - APR 30/25',opening:0,closing:-39.02,pages:[[0,39.02,1,2]],min:'MONTHLY MIN. BAL. $39.02OD'},
      {range:'APR 30/25 - MAY 30/25',opening:-39.02,closing:-78.76,pages:[[0,39.74,0,2]],min:'MONTHLY MIN. BAL. $78.76OD'},
      {range:'MAY 30/25 - JUN 30/25',opening:-78.76,closing:28443.61,pages:[[28561.92,39.55,8,3]],min:'MONTHLY MIN. BAL. $78.76OD'},
      {range:'JUN 30/25 - JUL 31/25',opening:28443.61,closing:30892.06,pages:[[21403.47,36528.45,7,24],[16394.56,12628.50,4,27],[24428.67,4556.90,2,29],[22013.80,7351.00,4,27],[0,20713.45,0,31],[0,13.75,0,1]],min:'MONTHLY MIN. BAL. $124.79'},
      {range:'JUL 31/25 - AUG 29/25',opening:30892.06,closing:56583.80,pages:[[22909.35,25787.95,3,28],[22135.12,8143.50,1,30],[23164.33,13441.12,3,28],[21366.32,8864.81,5,26],[0,7646.00,0,8]],min:'MONTHLY MIN. BAL. $28,013.46'},
      {range:'AUG 29/25 - SEP 29/25',opening:56583.80,closing:71699.58,pages:[[33132.31,39968.90,3,28],[15043.38,16693.00,2,29],[18603.11,16908.00,2,29],[20198.13,11199.04,1,30],[25724.74,12816.95,2,26]],min:'MONTHLY MIN. BAL. $35,227.59'},
      {range:'SEP 29/25 - OCT 31/25',opening:71699.58,closing:86143.26,pages:[[44636.46,35049.90,7,24],[150.00,16812.50,1,30],[44904.13,15918.50,8,23],[33.99,6295.50,2,29],[39.00,1243.50,1,7]],min:'MONTHLY MIN. BAL. $53,113.68'},
      {range:'OCT 31/25 - NOV 28/25',opening:86143.26,closing:96425.78,pages:[[25652.16,12517.64,3,28],[22431.40,43791.35,6,25],[27612.68,14078.00,2,29],[20130.77,13332.50,2,29],[39.00,1864.00,1,12]],min:'MONTHLY MIN. BAL. $65,824.33'},
      {range:'NOV 28/25 - DEC 31/25',opening:96425.78,closing:118371.74,pages:[[30992.62,40469.40,3,28],[18063.91,7552.50,1,30],[40296.08,6169.50,2,29],[200.00,13312.50,1,30],[39.00,141.75,1,4]],min:'MONTHLY MIN. BAL. $86,143.00'}
    ];
    let gross=0,withdrawals=0;
    cases.forEach(function(c,i){const s=vfcTdLockFacts_({},footerText(c.range,c.opening,c.pages,c.min),'waveform-'+i+'.pdf');close(s.closing_balance,c.closing,.02,'Waveform closing '+i);gross+=s.total_deposits;withdrawals+=s.total_withdrawals;});
    close(gross,590300.41,.02,'Waveform deposits');close(withdrawals,471928.67,.02,'Waveform withdrawals');
    return'gross='+vfcRound_(gross,.01)+', withdrawals='+vfcRound_(withdrawals,.01);
  });

  test('Waveform latest six benchmark average remains 93623.08',function(){const deposits=[84240.50,89575.12,112701.67,89763.58,95866.01,89591.61];close(deposits.reduce(function(a,b){return a+b;},0),561738.49,.02,'latest six deposits');close(deposits.reduce(function(a,b){return a+b;},0)/6,93623.081666,.02,'latest six average');return'latest six average=93623.08';});

  test('TD multi-page subtotals sum to whole-statement totals',function(){const text=['Page 1 of 5','Credits 3 33,132.31 Debits 28 39,968.90','Page 2 of 5','Credits 2 15,043.38 Debits 29 16,693.00','Page 3 of 5','Credits 2 18,603.11 Debits 29 16,908.00','Page 4 of 5','Credits 1 20,198.13 Debits 30 11,199.04','Page 5 of 5','Credits 2 25,724.74 Debits 26 12,816.95'].join('\n'),t=vfcTdPageTotals_(text);equal(t.pageCount,5,'page count');truthy(t.complete,'complete');close(t.totalDeposits,112701.67,.02,'deposits');close(t.totalWithdrawals,97585.89,.02,'withdrawals');return'deposits='+t.totalDeposits;});

  test('TD cheque-image pages do not look like missing activity pages',function(){const text=['JUN 30/25 - JUL 31/25','BALANCE FORWARD JUN30 34.49','Page 1 of 2','Credits 7 24,121.00','Debits 18 18,350.24','MONTHLY MIN. BAL. $34.49','CHEQUE # 00410 $1,064.92 CHEQUE # 00410','CHEQUE # 00413 $2,000.00 CHEQUE # 00413'].join('\n'),t=vfcTdPageTotals_(text);equal(t.declaredPageCount,2,'declared pages');equal(t.chequeImagePageCount,1,'cheque pages');equal(t.expectedActivityPageCount,1,'expected activity pages');truthy(t.complete,'cheque-image completeness');const s=vfcTdLockFacts_({},text,'new-age-july.pdf');close(s.total_deposits,24121,.001,'deposits');close(s.total_withdrawals,18350.24,.001,'withdrawals');close(s.closing_balance,5805.25,.001,'closing');return'activity=1, cheque=1';});

  test('Lotus Pharmacy 7-page TD statement has 6 activity pages plus one cheque-image page',function(){
    const text=[
      'APR 30/25 - MAY 30/25','BALANCE FORWARD APR30 13,860.16OD',
      'Page 1 of 7','Credits 20 30,324.40','Debits 11 9,110.85',
      'Page 2 of 7','Credits 23 27,337.51','Debits 8 62,985.31',
      'Page 3 of 7','Credits 27 29,595.72','Debits 4 10,631.20',
      'Page 4 of 7','Credits 25 29,557.15','Debits 6 15,492.49',
      'Page 5 of 7','Credits 23 34,578.29','Debits 8 72,099.88',
      'Page 6 of 7','Credits 12 209,806.93','Debits 10 89,450.33',
      'Page 7 of 7','9280-5229903','CHEQUE # 01866 $5,551.88 CHEQUE # 01866',
      'MONTHLY MIN. BAL. $39,804.16OD'
    ].join('\n');
    const t=vfcTdPageTotals_(text);
    equal(t.declaredPageCount,7,'Lotus declared pages');
    equal(t.chequeImagePageCount,1,'Lotus cheque-image pages');
    equal(t.expectedActivityPageCount,6,'Lotus expected activity pages');
    equal(t.creditCount,6,'Lotus Credits subtotals');
    equal(t.debitCount,6,'Lotus Debits subtotals');
    truthy(t.complete,'Lotus statement completeness');
    close(t.totalDeposits,361200.00,.02,'Lotus deposits');
    close(t.totalWithdrawals,259770.06,.02,'Lotus withdrawals');
    const s=vfcTdLockFacts_({},text,'TD_EVERY_DAY_B_BUSINESS_PLAN_9280-5229903_Apr_30-May_30_2025.pdf');
    close(s.opening_balance,-13860.16,.02,'Lotus opening');
    close(s.closing_balance,87569.78,.02,'Lotus closing');
    return'activity=6, cheque=1, deposits='+t.totalDeposits+', withdrawals='+t.totalWithdrawals;
  });

  test('TD lock sets dates opening closing and OD deterministically',function(){const text=['MAR 31/26 - APR 30/26','Page 1 of 2','Credits 13 11,441.88','Debits 18 8,762.88','MONTHLY MIN. BAL. $30.76OD','BALANCE FORWARD MAR31 3.63','Page 2 of 2','Credits 1 2,520.00','Debits 10 2,142.71','MONTHLY MIN. BAL. $30.76OD','BALANCE FORWARD APR27 2,682.63'].join('\n'),s=vfcTdLockFacts_({closing_balance:999999,negative_balance_detected:false},text,'test.pdf');equal(s.statement_start_date,'2026-03-31','start');equal(s.statement_end_date,'2026-04-30','end');close(s.opening_balance,3.63,.001,'opening');close(s.total_deposits,13961.88,.001,'deposits');close(s.total_withdrawals,10905.59,.001,'withdrawals');close(s.closing_balance,3059.92,.001,'closing');equal(s.negative_balance_detected,true,'OD');return'closing='+s.closing_balance;});

  test('TD incomplete activity pages fail closed',function(){let threw=false;try{vfcTdLockFacts_({},['MAR 31/26 - APR 30/26','Page 1 of 2','Credits 13 11,441.88','Debits 18 8,762.88','BALANCE FORWARD MAR31 3.63'].join('\n'),'incomplete.pdf');}catch(e){threw=/could not be fully verified/i.test(String(e&&e.message||e));}truthy(threw,'fail closed');return'failed closed';});

  test('TD transfer memo containing LOAN is never debt',function(){equal(vfcTdClassifyDebit_(tx('2025-06-01','SEND E-TFR *Esd LOAN','DEBIT',2000)),null,'transfer loan memo');return'excluded';});
  test('Same-dollar TD e-transfers never become debt',function(){const d=vfcDebtProfile_([row('2025-07-31',[tx('2025-07-10','SEND E-TFR ***AAA','DEBIT',1000)]),row('2025-08-29',[tx('2025-08-10','SEND E-TFR ***AAA','DEBIT',1000)]),row('2025-09-29',[tx('2025-09-10','SEND E-TFR ***AAA','DEBIT',1000)])]);close(d.confirmedMonthlyDebtService,0,.001,'e-transfer debt');return'debt=0';});
  test('TD tax payment fee is not tax debt',function(){equal(vfcTdClassifyDebit_(tx('2025-09-02','TAX PYT FEE','DEBIT',6)),null,'tax fee');return'excluded';});
  test('TD recurring tax remains informational',function(){const d=vfcDebtProfile_([row('2025-07-31',[tx('2025-07-11','EMPTX 240075 BUS','DEBIT',1061.25)]),row('2025-08-29',[tx('2025-08-11','EMPTX 240075 BUS','DEBIT',1061.25)]),row('2025-09-29',[tx('2025-09-11','EMPTX 240075 BUS','DEBIT',1061.25)])]);close(d.confirmedMonthlyDebtService,0,.001,'tax debt');close(d.informationalMonthlyObligations,1061.25,.02,'tax info');return'informational='+d.informationalMonthlyObligations;});
  test('TD recurring card remains informational',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-21','TD VISA','DEBIT',1000)]),row('2026-02-28',[tx('2026-02-21','TD VISA','DEBIT',1000)]),row('2026-03-31',[tx('2026-03-21','TD VISA','DEBIT',1000)])]);close(d.confirmedMonthlyDebtService,0,.001,'Visa debt');close(d.informationalMonthlyObligations,1000,.02,'Visa info');return'informational='+d.informationalMonthlyObligations;});
  test('Unknown recurring TD PAD remains informational',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-02-28',[tx('2026-02-12','PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-03-31',[tx('2026-03-12','PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])]);close(d.confirmedMonthlyDebtService,0,.001,'PAD debt');close(d.informationalMonthlyObligations,500,.02,'PAD info');return'informational='+d.informationalMonthlyObligations;});

  test('One standalone TD LOAN is evidence but not monthly debt',function(){const d=vfcDebtProfile_([row('2025-09-29',[tx('2025-09-08','LOAN','DEBIT',11105)])]);close(d.confirmedMonthlyDebtService,0,.001,'single loan debt');equal(d.observedOnce.length,1,'observed once');truthy(/^TD_STANDALONE_LOAN_/.test(d.observedOnce[0].entityKey||''),'identity');return'observed once';});
  test('Recurring standalone TD LOAN becomes debt',function(){const d=vfcDebtProfile_([row('2025-09-30',[tx('2025-09-08','LOAN','DEBIT',11105)]),row('2025-10-31',[tx('2025-10-08','LOAN','DEBIT',11105)]),row('2025-11-30',[tx('2025-11-08','LOAN','DEBIT',11105)])]);close(d.confirmedMonthlyDebtService,11105,.02,'standalone loan');equal(d.activeDebtObligations.length,1,'obligations');return'debt='+d.confirmedMonthlyDebtService;});

  test('TD principal and interest with one reference become one obligation',function(){const d=vfcDebtProfile_([row('2025-07-31',[tx('2025-07-16','LN PYT INT 900017902','DEBIT',265.90),tx('2025-07-16','LN PYT PRI 900017902','DEBIT',663.84)]),row('2025-08-29',[tx('2025-08-19','LN PYT INT 900017902','DEBIT',258.97),tx('2025-08-19','LN PYT PRI 900017902','DEBIT',670.77)]),row('2025-09-29',[tx('2025-09-08','LN PYT INT 900017902','DEBIT',543.96),tx('2025-09-08','LN PYT PRI 900017902','DEBIT',385.78)])]);equal(d.activeDebtObligations.length,1,'PRI/INT count');equal(d.activeDebtObligations[0].entityKey,'TD_LOAN_900017902','identity');close(d.confirmedMonthlyDebtService,929.74,.02,'PRI/INT debt');return'debt='+d.confirmedMonthlyDebtService;});

  test('TD RBC-loan catch-up does not inflate regular monthly debt',function(){const d=vfcDebtProfile_([row('2025-06-30',[tx('2025-06-02','RBC LOAN PYMT LOAN','DEBIT',1539.56),tx('2025-06-10','RBC LOAN PYMT LOAN','DEBIT',769.78)]),row('2025-07-31',[tx('2025-07-10','RBC LOAN PYMT LOAN','DEBIT',769.78)]),row('2025-08-29',[tx('2025-08-12','RBC LOAN PYMT LOAN','DEBIT',769.78)])]);close(d.confirmedMonthlyDebtService,769.78,.02,'regular RBC loan');truthy(d.observedOnce.some(function(x){return Math.abs((x.paymentAmount||0)-1539.56)<.02;}),'catch-up observed');return'regular='+d.confirmedMonthlyDebtService;});
  test('TD FIRST INSURANCE LOAN is debt when recurring',function(){const d=vfcDebtProfile_([row('2025-12-31',[tx('2025-12-18','FIRST INSURANCE LOAN','DEBIT',437.99)]),row('2026-01-30',[tx('2026-01-19','FIRST INSURANCE LOAN','DEBIT',437.99)]),row('2026-02-27',[tx('2026-02-18','FIRST INSURANCE LOAN','DEBIT',437.99)])]);close(d.confirmedMonthlyDebtService,437.99,.02,'insurance loan');return'debt='+d.confirmedMonthlyDebtService;});
  test('Ordinary ICBC insurance stays informational',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-16','ICBC INS','DEBIT',366.73)]),row('2026-02-28',[tx('2026-02-16','ICBC INS','DEBIT',366.73)]),row('2026-03-31',[tx('2026-03-16','ICBC INS','DEBIT',366.73)])]);close(d.confirmedMonthlyDebtService,0,.001,'ICBC debt');close(d.informationalMonthlyObligations,366.73,.02,'ICBC info');return'informational='+d.informationalMonthlyObligations;});
  test('TD Ford Credit recurring payments are debt',function(){const d=vfcDebtProfile_([row('2026-01-30',[tx('2026-01-12','FORD CREDIT CA APY','DEBIT',950.61)]),row('2026-02-27',[tx('2026-02-10','FORD CREDIT CA APY','DEBIT',950.61)]),row('2026-03-31',[tx('2026-03-10','FORD CREDIT CA APY','DEBIT',950.61)])]);close(d.confirmedMonthlyDebtService,950.61,.02,'Ford debt');return'debt='+d.confirmedMonthlyDebtService;});
  test('TDCT LOC recurring payments are debt',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-15','TDCT LOC PAYMENT','DEBIT',850)]),row('2026-02-28',[tx('2026-02-15','TDCT LOC PAYMENT','DEBIT',850)]),row('2026-03-31',[tx('2026-03-15','TDCT LOC PAYMENT','DEBIT',850)])]);close(d.confirmedMonthlyDebtService,850,.02,'TD LOC debt');return'debt='+d.confirmedMonthlyDebtService;});
  test('TD Journey weekly cadence becomes MCA debt',function(){const a=[];['2025-08-07','2025-08-14','2025-08-21','2025-08-28','2025-09-04','2025-09-11','2025-09-18','2025-09-25'].forEach(function(date){a.push(tx(date,'JOURNEY/ONDECK BUS','DEBIT',4274.21));});const d=vfcDebtProfile_([row('2025-08-29',a.slice(0,4)),row('2025-09-29',a.slice(4))]);close(d.confirmedMonthlyDebtService,4274.21*52/12,.05,'Journey debt');return'debt='+d.confirmedMonthlyDebtService;});
  test('TD BDC monthly payments become debt',function(){const d=vfcDebtProfile_([row('2025-08-29',[tx('2025-08-18','BDC BUS','DEBIT',664.09)]),row('2025-09-29',[tx('2025-09-18','BDC BUS','DEBIT',664.09)]),row('2025-10-31',[tx('2025-10-18','BDC BUS','DEBIT',664.09)])]);close(d.confirmedMonthlyDebtService,664.09,.02,'BDC debt');return'debt='+d.confirmedMonthlyDebtService;});

  test('TD explicit loan proceeds are financing credit',function(){const d=vfcDebtProfile_([row('2025-04-30',[tx('2025-04-15','LOAN PROCEEDS','CREDIT',50000)])]);close(d.financingCreditsTotal,50000,.02,'loan proceeds');equal(d.financingCredits.length,1,'financing count');return'financing='+d.financingCreditsTotal;});
  test('TD LN PYMT-C suppresses failed debit and is not revenue',function(){const d=vfcDebtProfile_([row('2025-09-29',[tx('2025-09-09','LN PYMT *602099601','DEBIT',1265.14),tx('2025-09-09','LN PYMT-C *602099601','CREDIT',1265.14)])]);close(d.confirmedMonthlyDebtService,0,.001,'returned debt');equal(d.returnedFinanceDebitsSuppressed,1,'suppressed');close(d.returnedCreditsTotal,1265.14,.001,'returned credit');close(d.financingCreditsTotal,0,.001,'not financing proceeds');return'returned='+d.returnedCreditsTotal;});
  test('TD RTN NSF suppresses same-amount financing debit',function(){const d=vfcDebtProfile_([row('2025-09-29',[tx('2025-09-10','RBC LOAN PYMT LOAN','DEBIT',769.78),tx('2025-09-10','RTN NSF','CREDIT',769.78)])]);equal(d.returnedFinanceDebitsSuppressed,1,'RTN suppression');close(d.returnedCreditsTotal,769.78,.001,'RTN total');close(d.confirmedMonthlyDebtService,0,.001,'returned debt');return'returned='+d.returnedCreditsTotal;});
  test('TD numbered RTN# NSF is a returned credit',function(){truthy(vfcTdIsReturnedFinancingCredit_(tx('2025-07-10','RTN#00409 NSF','CREDIT',2000)),'numbered NSF return');return'return recognized';});
  test('TD returned cheque FUNDS HELD is excluded from operating deposits',function(){const txs=vfcNormalizeTransactions_([tx('2026-02-17','CHQ#01564-0146568325','DEBIT',80000),tx('2026-02-17','RTN#01564 FUNDS HELD','CREDIT',80000)],'TD'),p={bankId:'TD',bankName:'TD',statementStartDate:'2026-01-30',statementEndDate:'2026-02-27',openingBalance:0,closingBalance:0,totalDeposits:100000,totalWithdrawals:100000,reconciliationDifference:0,nsfCount:1,negativeBalanceDetected:false,transactionsVerified:true,transactions:txs},f=vfcBuildBankingFeatures_({},[{row:{fileName:'3d-concrete.pdf'},payload:p}]);close(f.estimatedOperatingTotalDeposits,20000,.02,'operating deposits');close(f.debtProfile.returnedCreditsTotal,80000,.02,'returned cheque');return'operating='+f.estimatedOperatingTotalDeposits;});
  test('TD failed debit plus same-day retry preserves one real payment',function(){function retryRow(end,date){const items=vfcNormalizeTransactions_([tx(date,'LN PYMT *602099601','DEBIT',1265.14),tx(date,'LN PYMT-C *602099601','CREDIT',1265.14),tx(date,'LN PYMT *602099601','DEBIT',1265.14)],'TD');equal(items.filter(function(x){return x.direction==='DEBIT';}).length,2,'two printed debits');return row(end,items);}const d=vfcDebtProfile_([retryRow('2025-07-31','2025-07-09'),retryRow('2025-08-29','2025-08-11'),retryRow('2025-09-29','2025-09-09')]);equal(d.returnedFinanceDebitsSuppressed,3,'suppressed failed debits');close(d.confirmedMonthlyDebtService,1265.14,.02,'retry debt');equal(d.activeDebtObligations.length,1,'one obligation');return'debt='+d.confirmedMonthlyDebtService;});
  test('TD returned credits reduce estimated operating deposits',function(){const txs=vfcNormalizeTransactions_([tx('2025-09-09','LN PYMT *602099601','DEBIT',1265.14),tx('2025-09-09','LN PYMT-C *602099601','CREDIT',1265.14)],'TD'),p={bankId:'TD',bankName:'TD',statementStartDate:'2025-08-29',statementEndDate:'2025-09-29',openingBalance:0,closingBalance:0,totalDeposits:5000,totalWithdrawals:5000,reconciliationDifference:0,nsfCount:1,negativeBalanceDetected:false,transactionsVerified:true,transactions:txs},f=vfcBuildBankingFeatures_({},[{row:{fileName:'td.pdf'},payload:p}]);close(f.estimatedOperatingTotalDeposits,3734.86,.02,'operating');equal(f.returnedPaymentFlag,1,'return flag');return'operating='+f.estimatedOperatingTotalDeposits;});
  test('TD debt profile is deterministic for identical frozen facts',function(){const rows=[row('2026-01-31',[tx('2026-01-10','FORD CREDIT CA APY','DEBIT',950.61),tx('2026-01-18','FIRST INSURANCE LOAN','DEBIT',437.99)]),row('2026-02-28',[tx('2026-02-10','FORD CREDIT CA APY','DEBIT',950.61),tx('2026-02-18','FIRST INSURANCE LOAN','DEBIT',437.99)]),row('2026-03-31',[tx('2026-03-10','FORD CREDIT CA APY','DEBIT',950.61),tx('2026-03-18','FIRST INSURANCE LOAN','DEBIT',437.99)])],a=JSON.stringify(vfcDebtProfile_(rows)),b=JSON.stringify(vfcDebtProfile_(rows));equal(a,b,'deterministic JSON');return'deterministic';});

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,tdRulesVersion:vfcTdBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
