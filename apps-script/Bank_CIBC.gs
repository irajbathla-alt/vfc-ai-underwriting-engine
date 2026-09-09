/**
 * CIBC BANK ENGINE v1.0 — CANDIDATE
 *
 * One permanent CIBC module. CIBC-specific statement parsing, transaction
 * classification, financing-credit recognition, transfer/return handling and
 * deterministic regression tests live here.
 *
 * This is a candidate until validated against real VFC CIBC business statements.
 * Shared recurrence math and frozen-fact underwriting remain in BankingCore.gs.
 */
function vfcCibcBankProfile_(){
  return{
    id:'CIBC',
    label:'CIBC',
    status:'CANDIDATE',
    rulesVersion:'CIBC-1.0-CANDIDATE',
    aliases:['CANADIAN IMPERIAL BANK OF COMMERCE','CIBC BUSINESS BANKING','CIBC']
  };
}

function vfcCibcExtractionRules_(){return[
  'CIBC statements show an Account summary with opening balance, withdrawals, deposits and closing balance. These printed summary values control statement totals.',
  'Transaction direction is controlled only by the printed Withdrawals versus Deposits columns.',
  'Preserve the printed statement period and every visible transaction needed for recurrence, financing-credit, return and transfer analysis.',
  'PREAUTHORIZED DEBIT is not debt by itself. It becomes confirmed financing debt only with explicit financing evidence or a recognized financing counterparty plus recurrence.',
  'INTERNET TRANSFER, ACCOUNT TRANSFER and clearly labelled transfer credits are non-operating account movements. INTERAC e-Transfer deposits are not automatically internal transfers.',
  'Returned item, returned payment, reversal and NSF reversal credits are not operating revenue. Preserve them as printed facts.',
  'Explicit LOAN PAYMENT, LOAN PMT, MORTGAGE, LOC, LINE OF CREDIT, MCA, LEASE and FINANCING PAYMENT wording is financing evidence.',
  'Known financing counterparties such as BDC, Journey/OnDeck, Merchant Growth, Canacap, Greenbox, iCapital, Ford Credit and Nissan Finance are financing candidates; recurrence is still required for confirmed monthly debt.',
  'Credit-card payments including CIBC Visa/Mastercard, AMEX and other card issuers are informational, not fixed financing debt.',
  'CRA, CCRA, GST, HST and tax payments are tax/government obligations, not financing debt.',
  'Same or near-identical dollar amount by itself never proves debt.',
  'Do not invent a missing amount, date, transaction direction, lender relationship or account-transfer relationship.'
].join('\n');}

/* =========================
 * PRINTED CIBC FACT LOCKING
 * ========================= */
function vfcCibcLockFacts_(summary,text,fileName){
  const locked=Object.assign({},summary||{}),facts=vfcCibcSummaryFacts_(text);
  if(!facts.complete){
    throw new Error('CIBC printed Account summary could not be fully verified for '+String(fileName||'statement')+'. Upload was stopped before saving incomplete statement totals.');
  }
  locked.statement_start_date=facts.startDate;
  locked.statement_end_date=facts.endDate;
  locked.opening_balance=facts.opening;
  locked.total_withdrawals=facts.withdrawals;
  locked.total_deposits=facts.deposits;
  locked.closing_balance=facts.closing;
  locked.negative_balance_detected=vfcCibcNegativeBalanceFlag_(text,facts);
  return locked;
}

function vfcCibcSummaryFacts_(text){
  const s=String(text||'').replace(/\u00a0/g,' ').replace(/[‐‑‒–—]/g,'-');
  const dates=vfcCibcStatementDates_(s);
  const opening=vfcCibcLabelMoney_(s,'Opening\\s+balance(?:\\s+on\\s+[A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})?');
  const withdrawals=vfcCibcLabelMoney_(s,'Withdrawals(?:\\s*\\(\\$\\))?');
  const deposits=vfcCibcLabelMoney_(s,'Deposits(?:\\s*\\(\\$\\))?');
  const closing=vfcCibcLabelMoney_(s,'Closing\\s+balance(?:\\s+on\\s+[A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})?');
  const complete=!!(dates.startDate&&dates.endDate&&opening!==null&&withdrawals!==null&&deposits!==null&&closing!==null&&Math.abs((opening+deposits-withdrawals)-closing)<=.05);
  return{complete:complete,startDate:dates.startDate,endDate:dates.endDate,opening:opening,withdrawals:withdrawals,deposits:deposits,closing:closing};
}

function vfcCibcLabelMoney_(text,labelPattern){const re=new RegExp(labelPattern+'\\s*[:=]?\\s*\\$?(-?[0-9][0-9,]*\\.\\d{2})','i'),m=String(text||'').match(re);if(!m)return null;const n=Number(String(m[1]).replace(/,/g,''));return Number.isFinite(n)?n:null;}

function vfcCibcStatementDates_(text){
  const s=String(text||'');
  let m=s.match(/For\s+(?:the\s+period\s+)?([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*|\s+)(\d{4})?\s+to\s+([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/i);
  if(m){const endYear=Number(m[6]),startYear=m[3]?Number(m[3]):endYear-(vfcCibcMonth_(m[1])>vfcCibcMonth_(m[4])?1:0);return{startDate:vfcCibcIsoParts_(m[1],m[2],startYear),endDate:vfcCibcIsoParts_(m[4],m[5],endYear)};}
  m=s.match(/Opening\s+balance\s+on\s+([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})[\s\S]{0,500}?Closing\s+balance\s+on\s+([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/i);
  return m?{startDate:vfcCibcIsoParts_(m[1],m[2],m[3]),endDate:vfcCibcIsoParts_(m[4],m[5],m[6])}:{startDate:'',endDate:''};
}

function vfcCibcIsoParts_(month,day,year){const mm=vfcCibcMonth_(month),dd=Number(day),yyyy=Number(year);return mm&&dd&&yyyy?String(yyyy).padStart(4,'0')+'-'+String(mm).padStart(2,'0')+'-'+String(dd).padStart(2,'0'):'';}
function vfcCibcMonth_(month){return{JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12}[String(month||'').substring(0,3).toUpperCase()]||0;}
function vfcCibcNegativeBalanceFlag_(text,facts){if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;return/(?:^|\s)-[0-9][0-9,]*\.\d{2}(?:\s|$)/m.test(String(text||''));}

/* =========================
 * CIBC TRANSACTION RULES
 * ========================= */
function vfcCibcClassifyDebit_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t&&t.counterparty||raw).replace(/\s+/g,' ').trim();
  if(!raw)return null;
  if(/MONTHLY\s+FEE|SERVICE\s+CHARGE|TRANSACTION\s+FEE|INTERAC\s+E-TRANSFER\s+FEE|NSF\s+FEE|OVERDRAFT\s+INTEREST|RETURNED\s+ITEM\s+FEE/.test(s))return null;
  if(vfcCibcIsTransferDebit_(s))return null;

  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/JOURNEY|ONDECK/.test(s)){family='MCA';entityKey='CIBC_JOURNEY_ONDECK';label='Journey / OnDeck';debtJustification='Known financing/MCA counterparty plus recurring observed payment cadence.';}
  else if(/MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='CIBC_MERCHANT_GROWTH';label='Merchant Growth';debtJustification='Known financing/MCA counterparty plus recurring observed payment cadence.';}
  else if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='CIBC_CANACAP';label='Canacap';debtJustification='Known financing/MCA counterparty plus recurring observed payment cadence.';}
  else if(/GREENBOX\s+CAPIT/.test(s)){family='MCA';entityKey='CIBC_GREENBOX_CAPITAL';label='Greenbox Capital';debtJustification='Known financing/MCA counterparty plus recurring observed payment cadence.';}
  else if(/\bBDC\b/.test(s)){family='FINANCING';entityKey='CIBC_BDC';label='BDC';debtJustification='Known business lender plus recurring observed payment cadence.';}
  else if(/FORD\s+CREDIT/.test(s)){family='FINANCING';entityKey='CIBC_FORD_CREDIT';label='Ford Credit';debtJustification='Known vehicle-finance counterparty plus recurring observed payment cadence.';}
  else if(/NISSAN\s+FINANCE/.test(s)){family='FINANCING';entityKey='CIBC_NISSAN_FINANCE';label='Nissan Finance';debtJustification='Known vehicle-finance counterparty plus recurring observed payment cadence.';}
  else if(/ICAPITAL/.test(s)){family='MCA';entityKey='CIBC_ICAPITAL';label='iCapital';debtJustification='Known financing counterparty plus recurring observed payment cadence.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC/.test(s)){family='FINANCING';entityKey='CIBC_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||'Premium Finance';debtJustification='Explicit premium-finance wording plus recurring observed payment cadence.';}
  else if(/\bCRA\b|\bCCRA\b|\bGST\b|\bHST\b|\bTAX\b/.test(s)){family='TAX';entityKey='CIBC_TAX_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/INSURANCE|\bICBC\b/.test(s)){family='OTHER';entityKey='CIBC_INSURANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/CIBC\s+(?:VISA|MASTERCARD|CARD)|AMEX|AMERICAN\s+EXPRESS|\bVISA\b|MASTERCARD|CREDIT\s+CARD/.test(s)){family='OTHER';entityKey='CIBC_CARD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/\bLOAN\s+(?:PAYMENT|PMT|PYMT)\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bMCA\b|\bLEASE\b|FINANC(?:E|ING)\s+(?:PAYMENT|PMT|PYMT)/.test(s)){family='FINANCING';entityKey='CIBC_FINANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;debtJustification='Explicit financing/loan/mortgage/LOC/lease wording plus recurring observed cadence.';}
  else if(/PREAUTHORIZED\s+DEBIT|PRE[- ]?AUTHORIZED\s+DEBIT|\bPAD\b/.test(s)){family='OTHER';entityKey='CIBC_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else return null;
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcCibcIsTransferDebit_(s){return/INTERNET\s+TRANSFER|ACCOUNT\s+TRANSFER|TRANSFER\s+TO|INTERAC\s+E-TRANSFER\s+(?:SENT|SEND)|E-TRANSFER\s+(?:SENT|SEND)|\bCHEQUE\b|RETAIL\s+PURCHASE|DEBIT\s+CARD/.test(String(s||'').toUpperCase());}

function vfcCibcKnownFinancingCredit_(t){
  const s=String(t&&t.description||'').toUpperCase();
  if(vfcCibcIsReturnedFinancingCredit_(t)||vfcCibcIsNonOperatingTransferCredit_(t))return false;
  return/JOURNEY|ONDECK|MERCHANT\s+GROWTH|\bCANACAP\b|GREENBOX\s+CAPIT|\bBDC\b|ICAPITAL|LOAN\s+(?:ADVANCE|PROCEEDS|CREDIT)|MCA\s+(?:ADVANCE|PROCEEDS)|FINANC(?:E|ING)\s+(?:ADVANCE|PROCEEDS)|(?:\bLOC\b|LINE\s+OF\s+CREDIT)\s+(?:ADVANCE|PROCEEDS)/.test(s);
}

function vfcCibcStrongEntityKey_(key){return/^(CIBC_JOURNEY_ONDECK|CIBC_MERCHANT_GROWTH|CIBC_CANACAP|CIBC_GREENBOX_CAPITAL|CIBC_BDC|CIBC_FORD_CREDIT|CIBC_NISSAN_FINANCE|CIBC_ICAPITAL|CIBC_PREMIUM_FINANCE_|CIBC_FINANCE_)/.test(String(key||'').toUpperCase());}
function vfcCibcIsReturnedFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();return/RETURNED\s+ITEM|RETURNED\s+PAYMENT|PAYMENT\s+RETURNED|REVERSAL|NSF\s+REVERSAL/.test(s);}
function vfcCibcIsNonOperatingTransferCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;const s=String(t&&t.description||'').toUpperCase();if(/INTERAC\s+E-TRANSFER/.test(s))return false;return/INTERNET\s+TRANSFER|ACCOUNT\s+TRANSFER|TRANSFER\s+FROM|TRANSFER\s+CREDIT/.test(s);}
function vfcCibcPreservePrintedDuplicate_(t){return false;}

/* =========================
 * CIBC REGRESSION SUITE
 * ========================= */
function runCibcBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'CIBC',transactions:transactions||[]}};}
  function close(actual,expected,tol,label){tol=tol==null?.02:tol;if(Math.abs(Number(actual||0)-Number(expected||0))>tol)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function equal(actual,expected,label){if(actual!==expected)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function truthy(value,label){if(!value)throw new Error((label||'value')+' expected truthy');}
  function test(name,fn){try{results.push({name:name,pass:true,detail:String(fn()||'')});}catch(e){results.push({name:name,pass:false,detail:String(e&&e.message||e)});}}

  test('CIBC documented sample statement summary locks exactly',function(){const text=['For Apr 1 to Apr 30, 2020','Account summary','Opening balance on Apr 1, 2020 $96.45','Withdrawals 2,102.02','Deposits 2,084.42','Closing balance on Apr 30, 2020 $78.85'].join('\n'),f=vfcCibcSummaryFacts_(text);truthy(f.complete,'summary');equal(f.startDate,'2020-04-01','start');equal(f.endDate,'2020-04-30','end');close(f.opening,96.45,.001,'opening');close(f.withdrawals,2102.02,.001,'withdrawals');close(f.deposits,2084.42,.001,'deposits');close(f.closing,78.85,.001,'closing');return'documented sample exact';});
  test('CIBC internet transfer debit is not debt',function(){equal(vfcCibcClassifyDebit_(tx('2020-04-03','INTERNET TRANSFER 000000268351','DEBIT',700)),null,'transfer');return'excluded';});
  test('CIBC unknown preauthorized debit stays informational',function(){const x=vfcCibcClassifyDebit_(tx('2020-04-03','PREAUTHORIZED DEBIT / Shareowner Investments','DEBIT',350));equal(x.family,'OTHER','family');return'informational';});
  test('CIBC explicit loan payment becomes financing candidate',function(){const x=vfcCibcClassifyDebit_(tx('2026-01-15','PREAUTHORIZED DEBIT LOAN PAYMENT ABC FINANCE','DEBIT',1200));equal(x.family,'FINANCING','family');return'financing';});
  test('CIBC recurring BDC becomes debt',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-15','PREAUTHORIZED DEBIT BDC','DEBIT',800)]),row('2026-02-28',[tx('2026-02-15','PREAUTHORIZED DEBIT BDC','DEBIT',800)]),row('2026-03-31',[tx('2026-03-15','PREAUTHORIZED DEBIT BDC','DEBIT',800)])]);close(d.confirmedMonthlyDebtService,800,.02,'BDC debt');return'debt='+d.confirmedMonthlyDebtService;});
  test('CIBC card payment remains informational',function(){const x=vfcCibcClassifyDebit_(tx('2026-01-20','CIBC VISA PAYMENT','DEBIT',1500));equal(x.family,'OTHER','card');return'informational';});
  test('CIBC internal transfer credit is non-operating but Interac is not',function(){truthy(vfcCibcIsNonOperatingTransferCredit_(tx('2026-01-10','INTERNET TRANSFER','CREDIT',5000)),'internal');equal(vfcCibcIsNonOperatingTransferCredit_(tx('2026-01-11','INTERAC e-Transfer Received','CREDIT',5000)),false,'Interac');return'transfer separation';});
  test('CIBC returned credit recognized',function(){truthy(vfcCibcIsReturnedFinancingCredit_(tx('2026-01-12','RETURNED PAYMENT','CREDIT',1200)),'return');return'return recognized';});
  test('CIBC debt profile is deterministic',function(){const rows=[row('2026-01-31',[tx('2026-01-15','PREAUTHORIZED DEBIT BDC','DEBIT',800)]),row('2026-02-28',[tx('2026-02-15','PREAUTHORIZED DEBIT BDC','DEBIT',800)]),row('2026-03-31',[tx('2026-03-15','PREAUTHORIZED DEBIT BDC','DEBIT',800)])],a=JSON.stringify(vfcDebtProfile_(rows)),b=JSON.stringify(vfcDebtProfile_(rows));equal(a,b,'deterministic');return'deterministic';});

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,cibcRulesVersion:vfcCibcBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
