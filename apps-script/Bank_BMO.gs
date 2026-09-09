/**
 * BMO BANK ENGINE v1.0 — CANDIDATE
 *
 * One permanent BMO module. BMO-specific statement parsing, transaction
 * classification, financing-credit recognition, transfer/return handling and
 * deterministic regression tests live here.
 *
 * Shared recurrence math and frozen-fact underwriting remain in BankingCore.gs.
 */
function vfcBmoBankProfile_(){
  return{
    id:'BMO',
    label:'BMO',
    status:'CANDIDATE',
    rulesVersion:'BMO-1.0-CANDIDATE',
    aliases:['BANK OF MONTREAL','BMO BANK OF MONTREAL','BMO','BUSINESS BANKING STATEMENT']
  };
}

function vfcBmoExtractionRules_(){return[
  'BMO Business Banking statements print a Summary of account with opening balance, total amounts debited, total amounts credited and closing balance. These printed summary values control statement totals.',
  'Transaction direction is controlled only by the printed Amounts debited from your account versus Amounts credited to your account columns.',
  'Preserve the first transaction Opening balance row and the printed For the period ending date. BMO statement cycles do not always begin on the first day of a month.',
  'Preserve Pre-Authorized Payment rows for financing analysis, including CANACAP, GREENBOX CAPITAL, 2M7 FINANCIAL, GFFG-CLOVERDALE LNS/PRE, FORD CREDIT, NISSAN FINANCE and IPFS/premium-finance wording.',
  'Preserve financing credits such as CANACAP CLN/PEE, known lender direct deposits and explicit LOAN/MCA/FINANCING/LOC proceeds. A large ordinary Deposit or Direct Deposit is not financing merely because it is large.',
  'Cheque Returned NSF, Returned Item, returned-payment/reversal credits and Error Correction credits are non-operating reversals. Preserve them as printed facts; they are not revenue.',
  'Transfer, Online Transfer and account-to-account transfer credits are non-operating transfers. INTERAC e-Transfer Received is not automatically an internal transfer and must remain an ordinary credit unless other evidence proves otherwise.',
  'INTERAC e-Transfer Sent, Transfer debits, ordinary cheques, Canadian Drafts and card purchases are not debt merely because they recur.',
  'FORD CREDIT and NISSAN FINANCE are financing candidates. Ordinary ICBC insurance remains informational.',
  'AMEX, VISA, Mastercard and M/C-CIBC bill payments remain informational revolving-card payments, not fixed financing debt.',
  'PAYWORKS is payroll/operating activity, not financing debt.',
  'CANADA TXD/DIM, CRA, CCRA, GST, HST and explicit tax payments are tax/government obligations, not financing debt.',
  'Same or near-identical dollar amount by itself never proves debt. Financing evidence plus observed recurrence is required for confirmed monthly debt.',
  'BMO statements can append cheque-image/support pages after the transaction activity. Do not duplicate those cheque images as new transactions.'
].join('\n');}

/* =========================
 * PRINTED BMO FACT LOCKING
 * ========================= */
function vfcBmoLockFacts_(summary,text,fileName){
  const locked=Object.assign({},summary||{}),facts=vfcBmoSummaryFacts_(text);
  if(!facts.complete){
    throw new Error('BMO printed Summary of account could not be fully verified for '+String(fileName||'statement')+'. Upload was stopped before saving incomplete statement totals.');
  }
  locked.statement_start_date=facts.startDate;
  locked.statement_end_date=facts.endDate;
  locked.opening_balance=facts.opening;
  locked.total_withdrawals=facts.withdrawals;
  locked.total_deposits=facts.deposits;
  locked.closing_balance=facts.closing;
  locked.negative_balance_detected=vfcBmoNegativeBalanceFlag_(text,facts);
  return locked;
}

function vfcBmoSummaryFacts_(text){
  const s=String(text||'').replace(/\u00a0/g,' ').replace(/[‐‑‒–—]/g,'-');
  const end=vfcBmoPeriodEnd_(s),start=vfcBmoOpeningDate_(s,end);
  const m=s.match(/Business\s+Account\s*#\s*[0-9][0-9\s-]*\s+(-?\$?[0-9][0-9,]*\.\d{2})\s+(-?\$?[0-9][0-9,]*\.\d{2})\s+(-?\$?[0-9][0-9,]*\.\d{2})\s+(-?\$?[0-9][0-9,]*\.\d{2})/i);
  if(!m)return{complete:false,startDate:start,endDate:end};
  const opening=vfcBmoMoney_(m[1]),withdrawals=vfcBmoMoney_(m[2]),deposits=vfcBmoMoney_(m[3]),closing=vfcBmoMoney_(m[4]);
  const complete=!!(start&&end&&opening!==null&&withdrawals!==null&&deposits!==null&&closing!==null&&Math.abs((opening+deposits-withdrawals)-closing)<=.05);
  return{complete:complete,startDate:start,endDate:end,opening:opening,withdrawals:withdrawals,deposits:deposits,closing:closing};
}

function vfcBmoPeriodEnd_(text){
  const m=String(text||'').match(/For\s+the\s+period\s+ending\s+([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/i);
  return m?vfcBmoIsoParts_(m[1],m[2],m[3]):'';
}

function vfcBmoOpeningDate_(text,endIso){
  const m=String(text||'').match(/\b([A-Za-z]{3})\s+(\d{1,2})\s+Opening\s+balance\b/i);
  if(!m||!endIso)return'';
  const end=vfcDate_(endIso);if(!end)return'';
  const month=vfcBmoMonth_(m[1]),day=Number(m[2]);if(!month||!day)return'';
  let year=end.getFullYear();if(month>end.getMonth()+1)year--;
  return String(year).padStart(4,'0')+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');
}

function vfcBmoIsoParts_(month,day,year){const mm=vfcBmoMonth_(month),dd=Number(day),yyyy=Number(year);return mm&&dd&&yyyy?String(yyyy).padStart(4,'0')+'-'+String(mm).padStart(2,'0')+'-'+String(dd).padStart(2,'0'):'';}
function vfcBmoMonth_(month){return{JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,SEPT:9,OCT:10,NOV:11,DEC:12}[String(month||'').substring(0,4).toUpperCase()]||{JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12}[String(month||'').substring(0,3).toUpperCase()]||0;}
function vfcBmoMoney_(value){if(value===null||value===undefined||value==='')return null;const n=Number(String(value).replace(/[$,\s]/g,''));return Number.isFinite(n)?n:null;}
function vfcBmoNegativeBalanceFlag_(text,facts){if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;return/(?:^|\s)-[0-9][0-9,]*\.\d{2}(?:\s|$)/m.test(String(text||''));}

/* =========================
 * BMO TRANSACTION RULES
 * ========================= */
function vfcBmoClassifyDebit_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t&&t.counterparty||raw).replace(/\s+/g,' ').trim(),cents=Math.round(vfcNum_(t&&t.amount)*100);
  if(!raw)return null;
  if(/RETURNED\s+ITEM\s+FEE|DRAFT\s+FEE|WITHDRAWAL\s+FEE|BILL\s+PAYMENT\s+FEE|MONTHLY\s+(?:PLAN\s+)?FEE|CASH\s+MGMT\s+FEE|SERVICE\s+CHARGE|TRANSACTION\s+FEE|OVERDRAFT\s+INTEREST|NSF\s+FEE/.test(s))return null;
  if(vfcBmoIsTransferDebit_(s))return null;

  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='BMO_CANACAP';label='Canacap';debtJustification='Known business financing/MCA counterparty on a BMO statement plus recurring observed payment cadence.';}
  else if(/GREENBOX\s+CAPIT/.test(s)){family='MCA';entityKey='BMO_GREENBOX_CAPITAL';label='Greenbox Capital';debtJustification='Known business financing/MCA counterparty on a BMO statement plus recurring observed payment cadence.';}
  else if(/\b2M7\s*FINANCIAL/.test(s)){family='FINANCING';entityKey='BMO_2M7_FINANCIAL';label='2M7 Financial';debtJustification='Financing counterparty observed as BMO pre-authorized payments; recurrence is required before monthly debt is confirmed.';}
  else if(/GFFG[- ]?CLOVERDALE|\bLNS\/PRE\b/.test(s)){family='FINANCING';entityKey='BMO_GFFG_LOAN';label='GFFG / Loan';debtJustification='BMO description contains an explicit loan pre-authorized-payment marker plus recurring observed cadence.';}
  else if(/FORD\s+CREDIT/.test(s)){family='FINANCING';entityKey='BMO_FORD_CREDIT';label='Ford Credit';debtJustification='Known vehicle-finance counterparty plus recurring observed payment cadence.';}
  else if(/NISSAN\s+FINANCE/.test(s)){family='FINANCING';entityKey='BMO_NISSAN_FINANCE';label='Nissan Finance';debtJustification='Known vehicle-finance counterparty plus recurring observed payment cadence.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC/.test(s)){family='FINANCING';entityKey='BMO_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||'Premium Finance';debtJustification='Explicit premium-finance wording plus recurring observed payment cadence.';}
  else if(/\bCANADA\s+TXD\/DIM\b|\bCRA\b|\bCCRA\b|\bGST\b|\bHST\b|\bTAX\b/.test(s)){family='TAX';entityKey='BMO_TAX_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/\bICBC\b|INSURANCE/.test(s)){family='OTHER';entityKey='BMO_INSURANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/AMEX|AMERICAN\s+EXPRESS|\bVISA\b|MASTERCARD|M\/C-CIBC|CIBC\s+(?:MC|CARD)|CREDIT\s+CARD/.test(s)){family='OTHER';entityKey='BMO_CARD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/PAYWORKS|PAYROLL/.test(s)){family='OTHER';entityKey='BMO_PAYROLL_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/\bBDC\b|JOURNEY|ONDECK|MERCHANT\s+GROWTH|ICAPITAL/.test(s)){family=/JOURNEY|ONDECK|MERCHANT\s+GROWTH|ICAPITAL/.test(s)?'MCA':'FINANCING';entityKey='BMO_FIN_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;debtJustification='Known financing counterparty plus recurring observed payment cadence.';}
  else if(/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bMCA\b|\bLEASE\b|\bFINANC(?:E|ING)?\b/.test(s)){family='FINANCING';entityKey='BMO_FINANCE_'+(vfcCounterpartyKey_(cp||raw)||cents);label=cp||raw;debtJustification='Explicit financing/loan/mortgage/LOC/lease wording plus recurring observed cadence.';}
  else if(/PRE[- ]?AUTHORIZED\s+PAYMENT|PAD\b/.test(s)){family='OTHER';entityKey='BMO_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else return null;
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcBmoIsTransferDebit_(s){return/INTERAC\s+E-TRANSFER\s+SENT|ONLINE\s+TRANSFER|^TRANSFER\b|\bTRANSFER,|CANADIAN\s+DRAFT|\bCHEQUE\b|DEBIT\s+CARD\s+PURCHASE|ABM\s+WITHDRAWAL/.test(String(s||'').toUpperCase());}

function vfcBmoKnownFinancingCredit_(t){
  const s=String(t&&t.description||'').toUpperCase();
  if(vfcBmoIsReturnedFinancingCredit_(t)||vfcBmoIsNonOperatingTransferCredit_(t))return false;
  return/\bCANACAP\b.*\bCLN\/PEE\b|\b2M7\s*FINANCIAL\b|JOURNEY|ONDECK|MERCHANT\s+GROWTH|GREENBOX\s+CAPIT|\bBDC\b|ICAPITAL|LOAN\s+(?:ADVANCE|PROCEEDS|CREDIT)|MCA\s+(?:ADVANCE|PROCEEDS)|FINANC(?:E|ING)\s+(?:ADVANCE|PROCEEDS)|(?:\bLOC\b|LINE\s+OF\s+CREDIT)\s+(?:ADVANCE|PROCEEDS)/.test(s);
}

function vfcBmoStrongEntityKey_(key){return/^(BMO_CANACAP|BMO_GREENBOX_CAPITAL|BMO_2M7_FINANCIAL|BMO_GFFG_LOAN|BMO_FORD_CREDIT|BMO_NISSAN_FINANCE|BMO_PREMIUM_FINANCE_|BMO_FIN_|BMO_FINANCE_)/.test(String(key||'').toUpperCase());}

function vfcBmoIsReturnedFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();return/CHEQUE\s+RETURNED\s+NSF|RETURNED\s+ITEM|RETURNED\s+PAYMENT|PAYMENT\s+RETURNED|REVERSAL|ERROR\s+CORRECTION/.test(s);}

function vfcBmoIsNonOperatingTransferCredit_(t){
  if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;
  const s=String(t&&t.description||'').toUpperCase();
  if(/INTERAC\s+E-TRANSFER\s+RECEIVED/.test(s))return false;
  return/^TRANSFER\b|\bTRANSFER,|ONLINE\s+TRANSFER|ACCOUNT\s+TRANSFER|ERROR\s+CORRECTION/.test(s);
}

/** BMO transaction pages can contain legitimate identical same-day credits/PADs. */
function vfcBmoPreservePrintedDuplicate_(t){
  const direction=String(t&&t.direction||'').toUpperCase(),s=String(t&&t.description||'').toUpperCase();
  if(direction==='CREDIT')return true;
  if(direction!=='DEBIT'||!/PRE[- ]?AUTHORIZED\s+PAYMENT/.test(s))return false;
  const x=vfcBmoClassifyDebit_(t);return!!(x&&(x.family==='FINANCING'||x.family==='MCA'));
}

/* =========================
 * BMO REGRESSION SUITE
 * ========================= */
function runBmoBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'BMO',transactions:transactions||[]}};}
  function close(actual,expected,tol,label){tol=tol==null?.02:tol;if(Math.abs(Number(actual||0)-Number(expected||0))>tol)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function equal(actual,expected,label){if(actual!==expected)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function truthy(value,label){if(!value)throw new Error((label||'value')+' expected truthy');}
  function test(name,fn){try{results.push({name:name,pass:true,detail:String(fn()||'')});}catch(e){results.push({name:name,pass:false,detail:String(e&&e.message||e)});}}

  test('BMO JVP December printed summary locks exactly',function(){const text=['Business Banking statement','For the period ending December 31, 2025','Summary of account','Business Account # 0709 1983-998 12,167.75 197,548.49 187,332.50 1,951.76','Nov 29 Opening balance 12,167.75'].join('\n'),f=vfcBmoSummaryFacts_(text);truthy(f.complete,'summary');equal(f.startDate,'2025-11-29','start');equal(f.endDate,'2025-12-31','end');close(f.opening,12167.75,.001,'opening');close(f.withdrawals,197548.49,.001,'withdrawals');close(f.deposits,187332.50,.001,'deposits');close(f.closing,1951.76,.001,'closing');return'JVP December exact';});
  test('BMO negative opening summary reconciles exactly',function(){const text=['For the period ending September 29, 2025','Business Account # 2065 1997-041 -97.13 133,410.82 133,955.27 447.32','Aug 30 Opening balance -97.13'].join('\n'),f=vfcBmoSummaryFacts_(text);truthy(f.complete,'summary');close(f.opening,-97.13,.001,'opening');close(f.closing,447.32,.001,'closing');return'negative opening preserved';});
  test('BMO Canacap recurring PAD becomes MCA debt',function(){const d=vfcDebtProfile_([row('2025-08-29',[tx('2025-08-04','Pre-Authorized Payment, CANACAP BUS/ENT','DEBIT',652)]),row('2025-09-29',[tx('2025-09-04','Pre-Authorized Payment, CANACAP BUS/ENT','DEBIT',637)]),row('2025-10-31',[tx('2025-10-04','Pre-Authorized Payment, CANACAP BUS/ENT','DEBIT',637)])]);truthy(d.confirmedMonthlyDebtService>0,'Canacap debt');equal(d.activeDebtObligations.length,1,'obligations');return'debt='+d.confirmedMonthlyDebtService;});
  test('BMO Ford and Nissan finance classify as financing',function(){equal(vfcBmoClassifyDebit_(tx('2026-02-02','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',972.91)).family,'FINANCING','Ford');equal(vfcBmoClassifyDebit_(tx('2026-02-06','Pre-Authorized Payment, NISSAN FINANCE CLN/PEE','DEBIT',343.24)).family,'FINANCING','Nissan');return'finance recognized';});
  test('BMO ICBC and CIBC card remain informational',function(){equal(vfcBmoClassifyDebit_(tx('2025-12-01','Pre-Authorized Payment, ICBC INS/ASS','DEBIT',336.70)).family,'OTHER','ICBC');equal(vfcBmoClassifyDebit_(tx('2025-08-15','Branch Bill Payment, M/C-CIBC','DEBIT',558.07)).family,'OTHER','card');return'informational';});
  test('BMO transfer and e-transfer sent are never debt',function(){equal(vfcBmoClassifyDebit_(tx('2025-12-17','Transfer, 0709-1985-790 0749','DEBIT',33000)),null,'transfer');equal(vfcBmoClassifyDebit_(tx('2025-12-08','INTERAC e-Transfer Sent','DEBIT',656.25)),null,'e-transfer');return'excluded';});
  test('BMO returned NSF credit suppresses failed financing debit',function(){const d=vfcDebtProfile_([row('2025-09-29',vfcNormalizeTransactions_([tx('2025-09-02','Pre-Authorized Payment, CANACAP BUS/ENT','DEBIT',637),tx('2025-09-02','Cheque Returned NSF','CREDIT',637)],'BMO'))]);equal(d.returnedFinanceDebitsSuppressed,1,'suppressed');close(d.confirmedMonthlyDebtService,0,.001,'debt');return'return suppressed';});
  test('BMO internal transfer credit is non-operating but Interac received is not',function(){truthy(vfcBmoIsNonOperatingTransferCredit_(tx('2025-12-17','Transfer, 0709-1985-790 0749','CREDIT',33000)),'internal');equal(vfcBmoIsNonOperatingTransferCredit_(tx('2025-09-08','INTERAC e-Transfer Received','CREDIT',1600)),false,'Interac');return'transfer separation';});
  test('BMO duplicate financing credits are preserved',function(){const a=vfcNormalizeTransactions_([tx('2025-08-15','Direct Deposit, CANACAP CLN/PEE','CREDIT',27267.71),tx('2025-08-15','Direct Deposit, CANACAP CLN/PEE','CREDIT',27267.71)],'BMO');equal(a.length,2,'duplicate credits');return'count=2';});
  test('BMO known financing credit excludes ordinary large deposit',function(){truthy(vfcBmoKnownFinancingCredit_(tx('2025-08-15','Direct Deposit, CANACAP CLN/PEE','CREDIT',27267.71)),'Canacap credit');equal(vfcBmoKnownFinancingCredit_(tx('2025-12-01','Deposit','CREDIT',70000)),false,'ordinary deposit');return'credit classification';});
  test('BMO debt profile is deterministic',function(){const rows=[row('2025-11-28',[tx('2025-11-03','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',972.91)]),row('2025-12-31',[tx('2025-12-01','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',972.91)]),row('2026-01-30',[tx('2026-01-02','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',972.91)])],a=JSON.stringify(vfcDebtProfile_(rows)),b=JSON.stringify(vfcDebtProfile_(rows));equal(a,b,'deterministic');return'deterministic';});

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,bmoRulesVersion:vfcBmoBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
