/**
 * BMO BANK ENGINE v1.1 — CANDIDATE
 *
 * One permanent BMO module. All BMO-specific behavior lives here:
 * - extraction instructions
 * - deterministic printed statement facts
 * - deterministic NSF count / negative-balance flag
 * - debit classification and debt identity
 * - financing-credit classification
 * - returned/reversed credit recognition
 * - non-operating transfer recognition
 * - legitimate printed-duplicate preservation
 * - deterministic BMO regression tests
 *
 * Shared recurrence math, frozen-fact storage and underwriting remain in BankingCore.gs.
 */
function vfcBmoBankProfile_(){
  return{
    id:'BMO',
    label:'BMO',
    status:'CANDIDATE',
    rulesVersion:'BMO-1.1-CANDIDATE',
    aliases:['BANK OF MONTREAL','BMO BANK OF MONTREAL','BMO.COM','BMO']
  };
}

function vfcBmoExtractionRules_(){return[
  'BMO Business Banking statements print a Summary of account with opening balance, total amounts debited, total amounts credited and closing balance. Those printed summary values control statement totals.',
  'Transaction direction is controlled only by the printed Amounts debited from your account versus Amounts credited to your account columns.',
  'Preserve the first transaction Opening balance row and the printed For the period ending date. BMO statement cycles do not always begin on the first day of a month.',
  'Preserve Pre-Authorized Payment rows needed for financing analysis, including CANACAP, GREENBOX CAPITAL, 2M7 FINANCIAL, GFFG-CLOVERDALE LNS/PRE, FORD CREDIT, NISSAN FINANCE and IPFS/premium-finance wording.',
  'Preserve financing credits such as CANACAP CLN/PEE, 2M7 FINANCIAL, known lender direct deposits and explicit LOAN/MCA/FINANCING/LOC proceeds. A large ordinary Deposit or Direct Deposit is not financing merely because it is large.',
  'Cheque Returned NSF, Returned Item Payment Stopped, Returned Item, returned-payment/reversal credits and Error Correction credits are non-operating reversals. Preserve them as printed facts; they are not revenue.',
  'Transfer, Online Transfer and account-to-account transfer credits are non-operating transfers. INTERAC e-Transfer Received is not automatically an internal transfer and remains an ordinary credit unless other evidence proves otherwise.',
  'INTERAC e-Transfer Sent, Transfer debits, ordinary cheques, Canadian Drafts and card purchases are not debt merely because they recur.',
  'FORD CREDIT and NISSAN FINANCE are financing candidates. Ordinary ICBC insurance remains informational.',
  'AMEX, VISA, Mastercard and M/C-CIBC bill payments remain informational revolving-card payments, not fixed financing debt.',
  'PAYWORKS and ordinary payroll activity are operating expenses, not financing debt.',
  'CANADA TXD/DIM, CRA, CCRA, GST, HST and explicit tax payments are tax/government obligations, not financing debt.',
  'An unknown recurring pre-authorized payment stays informational unless independent financing evidence exists.',
  'Same or near-identical dollar amount by itself never proves debt. Financing evidence plus observed recurrence is required for confirmed monthly debt.',
  'BMO statements can append cheque-image/support pages after the transaction activity. Do not duplicate those cheque images as new transactions.'
].join('\n');}

/* =========================
 * PRINTED BMO FACT LOCKING
 * ========================= */
function vfcBmoLockFacts_(summary,text,fileName){
  const locked=Object.assign({},summary||{}),facts=vfcBmoSummaryFacts_(text);
  if(!facts.complete){
    const why=facts.ambiguous?' Multiple BMO account summary rows were detected; this statement is not accepted as a single-account statement.':'';
    throw new Error('BMO printed Summary of account could not be fully verified for '+String(fileName||'statement')+'.'+why+' Upload was stopped before saving incomplete statement totals.');
  }
  locked.statement_start_date=facts.startDate;
  locked.statement_end_date=facts.endDate;
  locked.opening_balance=facts.opening;
  locked.total_withdrawals=facts.withdrawals;
  locked.total_deposits=facts.deposits;
  locked.closing_balance=facts.closing;
  locked.nsf_count=vfcBmoCountNsf_(text);
  locked.negative_balance_detected=vfcBmoNegativeBalanceFlag_(text,facts);
  return locked;
}

function vfcBmoSummaryFacts_(text){
  const s=String(text||'').replace(/\u00a0/g,' ').replace(/[‐‑‒–—]/g,'-');
  const end=vfcBmoPeriodEnd_(s),start=vfcBmoOpeningDate_(s,end);
  const blockMatch=s.match(/Summary\s+of\s+account([\s\S]{0,6000}?)Transaction\s+details/i),block=blockMatch?blockMatch[1]:s;
  const money='(-?\\$?[0-9][0-9,]*\\.\\d{2})';
  const re=new RegExp('Business\\s+Account\\s*#\\s*[0-9][0-9\\s-]*?\\s+'+money+'\\s+'+money+'\\s+'+money+'\\s+'+money,'gi');
  const candidates=[];let m;
  while((m=re.exec(block))!==null){
    const opening=vfcBmoMoney_(m[1]),withdrawals=vfcBmoMoney_(m[2]),deposits=vfcBmoMoney_(m[3]),closing=vfcBmoMoney_(m[4]);
    if(opening===null||withdrawals===null||deposits===null||closing===null)continue;
    if(withdrawals<0||deposits<0)continue;
    if(Math.abs((opening+deposits-withdrawals)-closing)<=.05)candidates.push({opening:opening,withdrawals:withdrawals,deposits:deposits,closing:closing});
  }

  /* OCR fallback: use the only four-money window inside the Summary block that reconciles. */
  if(!candidates.length){
    const tokens=block.match(/-?\s*\$?\s*(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\.\d{2}/g)||[],seen={};
    for(let i=0;i<=tokens.length-4;i++){
      const opening=vfcBmoMoney_(tokens[i]),withdrawals=Math.abs(vfcBmoMoney_(tokens[i+1])),deposits=Math.abs(vfcBmoMoney_(tokens[i+2])),closing=vfcBmoMoney_(tokens[i+3]);
      if(opening===null||withdrawals===null||deposits===null||closing===null)continue;
      if(Math.abs((opening+deposits-withdrawals)-closing)>.05)continue;
      const key=[opening,withdrawals,deposits,closing].join('|');if(seen[key])continue;seen[key]=1;candidates.push({opening:opening,withdrawals:withdrawals,deposits:deposits,closing:closing});
    }
  }

  if(candidates.length!==1)return{complete:false,ambiguous:candidates.length>1,startDate:start,endDate:end,candidateCount:candidates.length};
  const c=candidates[0],complete=!!(start&&end);
  return{complete:complete,ambiguous:false,startDate:start,endDate:end,opening:c.opening,withdrawals:c.withdrawals,deposits:c.deposits,closing:c.closing};
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
function vfcBmoMonth_(month){const k=String(month||'').substring(0,3).toUpperCase();return{JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12}[k]||0;}
function vfcBmoMoney_(value){if(value===null||value===undefined||value==='')return null;const n=Number(String(value).replace(/[$,\s]/g,''));return Number.isFinite(n)?n:null;}
function vfcBmoCountNsf_(text){return(String(text||'').match(/Cheque\s+Returned\s+NSF|Returned\s+Item\s+NSF/gi)||[]).length;}
function vfcBmoNegativeBalanceFlag_(text,facts){if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;return/(?:^|\s)-[0-9][0-9,]*\.\d{2}(?:\s|$)/m.test(String(text||''));}

/* =========================
 * BMO TRANSACTION RULES
 * ========================= */
function vfcBmoClassifyDebit_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t&&t.counterparty||raw).replace(/\s+/g,' ').trim(),cents=Math.round(vfcNum_(t&&t.amount)*100);
  if(!raw)return null;
  if(/RETURNED\s+ITEM\s+FEE|DRAFT\s+FEE|WITHDRAWAL\s+FEE|BILL\s+PAYMENT\s+FEE|MONTHLY\s+(?:PLAN\s+)?FEE|PLAN\s+FEE|CASH\s+MGMT\s+FEE|SERVICE\s+CHARGE|TRANSACTION\s+FEE|OVERDRAFT\s+(?:INTEREST|PER\s+ITEM\s+CHARGE)|NSF\s+FEE|INTERAC\s+E-TRANSFER\s+FEE/.test(s))return null;
  if(vfcBmoIsTransferDebit_(s))return null;

  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='BMO_CANACAP';label='Canacap';debtJustification='Known business financing/MCA counterparty on a BMO statement plus recurring observed payment cadence.';}
  else if(/GREENBOX\s+CAPIT/.test(s)){family='MCA';entityKey='BMO_GREENBOX_CAPITAL';label='Greenbox Capital';debtJustification='Known business financing/MCA counterparty on a BMO statement plus recurring observed payment cadence.';}
  else if(/\b2M7\s*FINANCIAL/.test(s)){family='FINANCING';entityKey='BMO_2M7_FINANCIAL';label='2M7 Financial';debtJustification='Known financing counterparty observed as a BMO pre-authorized payment plus recurring observed cadence.';}
  else if(/GFFG[- ]?CLOVERDALE|\bLNS\/PRE\b/.test(s)){family='FINANCING';entityKey='BMO_GFFG_LOAN';label='GFFG / Loan';debtJustification='BMO description contains an explicit loan pre-authorized-payment marker plus recurring observed cadence.';}
  else if(/FORD\s+CREDIT/.test(s)){family='FINANCING';entityKey='BMO_FORD_CREDIT';label='Ford Credit';debtJustification='Known vehicle-finance counterparty plus recurring observed payment cadence.';}
  else if(/NISSAN\s+FINANCE/.test(s)){family='FINANCING';entityKey='BMO_NISSAN_FINANCE';label='Nissan Finance';debtJustification='Known vehicle-finance counterparty plus recurring observed payment cadence.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC/.test(s)){family='FINANCING';entityKey='BMO_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||'Premium Finance';debtJustification='Explicit premium-finance wording plus recurring observed payment cadence.';}
  else if(/\bCANADA\s+TXD\/DIM\b|\bCRA\b|\bCCRA\b|\bGST\b|\bHST\b|\bTAX\b/.test(s)){family='TAX';entityKey='BMO_TAX_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/\bICBC\b|INSURANCE/.test(s)){family='OTHER';entityKey='BMO_INSURANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/AMEX|AMERICAN\s+EXPRESS|\bVISA\b|MASTERCARD|M\/C-CIBC|CIBC\s+(?:MC|CARD)|BMO\s+MASTERCARD|ROYAL\s+BANK\s+VISA|CREDIT\s+CARD/.test(s)){family='OTHER';entityKey='BMO_CARD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/PAYWORKS|PAYROLL/.test(s)){family='OTHER';entityKey='BMO_PAYROLL_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/\bBDC\b|JOURNEY|ONDECK|MERCHANT\s+GROWTH|ICAPITAL/.test(s)){family=/JOURNEY|ONDECK|MERCHANT\s+GROWTH|ICAPITAL/.test(s)?'MCA':'FINANCING';entityKey='BMO_FIN_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;debtJustification='Known financing counterparty plus recurring observed payment cadence.';}
  else if(/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bMCA\b|\bLEASE\b|\bFINANC(?:E|ING)?\b/.test(s)){family='FINANCING';entityKey='BMO_FINANCE_'+(vfcCounterpartyKey_(cp||raw)||cents);label=cp||raw;debtJustification='Explicit financing/loan/mortgage/LOC/lease wording plus recurring observed cadence.';}
  else if(/PRE[- ]?AUTHORIZED\s+PAYMENT|\bPAD\b/.test(s)){family='OTHER';entityKey='BMO_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else return null;
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcBmoIsTransferDebit_(s){return/INTERAC\s+E-TRANSFER\s+SENT|ONLINE\s+TRANSFER|^TRANSFER\b|\bTRANSFER,|CANADIAN\s+DRAFT|\bCHEQUE\b|DEBIT\s+CARD\s+PURCHASE|OTHER\s+BANK\s+ABM\s+WITHDRAWAL|ABM\s+WITHDRAWAL|WITHDRAWAL\s+AT/.test(String(s||'').toUpperCase());}

function vfcBmoKnownFinancingCredit_(t){
  const s=String(t&&t.description||'').toUpperCase();
  if(vfcBmoIsReturnedFinancingCredit_(t)||vfcBmoIsNonOperatingTransferCredit_(t))return false;
  return/\bCANACAP\b.*\bCLN\/PEE\b|\b2M7\s*FINANCIAL\b|JOURNEY|ONDECK|MERCHANT\s+GROWTH|GREENBOX\s+CAPIT|\bBDC\b|ICAPITAL|LOAN\s+(?:ADVANCE|PROCEEDS|CREDIT)|MCA\s+(?:ADVANCE|PROCEEDS)|FINANC(?:E|ING)\s+(?:ADVANCE|PROCEEDS)|(?:\bLOC\b|LINE\s+OF\s+CREDIT)\s+(?:ADVANCE|PROCEEDS)/.test(s);
}

function vfcBmoStrongEntityKey_(key){return/^(BMO_CANACAP|BMO_GREENBOX_CAPITAL|BMO_2M7_FINANCIAL|BMO_GFFG_LOAN|BMO_FORD_CREDIT|BMO_NISSAN_FINANCE|BMO_PREMIUM_FINANCE_|BMO_FIN_|BMO_FINANCE_)/.test(String(key||'').toUpperCase());}

function vfcBmoIsReturnedFinancingCredit_(t){
  const s=String(t&&t.description||'').toUpperCase();
  return/CHEQUE\s+RETURNED\s+NSF|RETURNED\s+ITEM(?:\s+PAYMENT\s+STOPPED)?|RETURNED\s+PAYMENT|PAYMENT\s+RETURNED|REVERSAL|ERROR\s+CORRECTION/.test(s);
}

function vfcBmoIsNonOperatingTransferCredit_(t){
  if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;
  const s=String(t&&t.description||'').toUpperCase();
  if(/INTERAC\s+E-TRANSFER\s+RECEIVED/.test(s))return false;
  return/^TRANSFER\b|\bTRANSFER,|ONLINE\s+TRANSFER|ACCOUNT\s+TRANSFER/.test(s);
}

/** Preserve only BMO duplicate rows that materially affect debt, returns or operating-deposit exclusions. */
function vfcBmoPreservePrintedDuplicate_(t){
  const direction=String(t&&t.direction||'').toUpperCase(),s=String(t&&t.description||'').toUpperCase();
  if(direction==='CREDIT')return vfcBmoKnownFinancingCredit_(t)||vfcBmoIsReturnedFinancingCredit_(t)||vfcBmoIsNonOperatingTransferCredit_(t);
  if(direction!=='DEBIT'||!/PRE[- ]?AUTHORIZED\s+PAYMENT/.test(s))return false;
  const x=vfcBmoClassifyDebit_(t);return!!(x&&(x.family==='FINANCING'||x.family==='MCA'));
}

/* =========================
 * BMO REGRESSION SUITE
 * Lives here deliberately: one BMO file, one source of truth.
 * No Sheets, Drive or OpenAI calls.
 * ========================= */
function runBmoBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'BMO',transactions:transactions||[]}};}
  function close(actual,expected,tol,label){tol=tol==null?.02:tol;if(Math.abs(Number(actual||0)-Number(expected||0))>tol)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function equal(actual,expected,label){if(actual!==expected)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function truthy(value,label){if(!value)throw new Error((label||'value')+' expected truthy');}
  function test(name,fn){try{results.push({name:name,pass:true,detail:String(fn()||'')});}catch(e){results.push({name:name,pass:false,detail:String(e&&e.message||e)});}}
  function summaryText(endDate,startMon,startDay,opening,withdrawals,deposits,closing){return['Business Banking statement','For the period ending '+endDate,'Summary of account','Business Account # 2065 1997-041 '+opening+' '+withdrawals+' '+deposits+' '+closing,'Transaction details',startMon+' '+startDay+' Opening balance '+opening].join('\n');}

  test('BMO 1151399 six real statement summaries reconcile exactly',function(){
    const cases=[
      ['June 30, 2025','May','31','311.60','64,432.68','66,350.03','2,228.95'],
      ['July 31, 2025','Jul','01','2,228.95','67,820.03','65,542.55','-48.53'],
      ['August 29, 2025','Aug','01','-48.53','170,064.47','170,015.87','-97.13'],
      ['September 29, 2025','Aug','30','-97.13','133,410.82','133,955.27','447.32'],
      ['October 31, 2025','Sep','30','447.32','105,221.98','104,632.46','-142.20'],
      ['November 28, 2025','Nov','01','-142.20','88,098.20','88,145.22','-95.18']
    ];
    let deposits=0,withdrawals=0;cases.forEach(function(c){const f=vfcBmoSummaryFacts_(summaryText.apply(null,c));truthy(f.complete,c[0]);deposits+=f.deposits;withdrawals+=f.withdrawals;close(f.opening+f.deposits-f.withdrawals,f.closing,.02,c[0]+' reconciliation');});
    close(deposits,628641.40,.02,'six-month deposits');close(withdrawals,629048.18,.02,'six-month withdrawals');close(deposits/6,104773.5667,.02,'six-month average deposits');return'deposits='+vfcRound_(deposits,.01)+', withdrawals='+vfcRound_(withdrawals,.01);
  });

  test('BMO JVP December printed summary locks exactly',function(){const f=vfcBmoSummaryFacts_(summaryText('December 31, 2025','Nov','29','12,167.75','197,548.49','187,332.50','1,951.76'));truthy(f.complete,'summary');equal(f.startDate,'2025-11-29','start');equal(f.endDate,'2025-12-31','end');close(f.opening,12167.75,.001,'opening');close(f.withdrawals,197548.49,.001,'withdrawals');close(f.deposits,187332.50,.001,'deposits');close(f.closing,1951.76,.001,'closing');return'JVP December exact';});

  test('BMO multiple account summary rows fail closed',function(){const text=['For the period ending November 28, 2025','Summary of account','Business Account # 2065 1997-041 100.00 50.00 75.00 125.00','Business Account # 2065 1997-099 200.00 20.00 30.00 210.00','Transaction details','Nov 01 Opening balance 100.00'].join('\n'),f=vfcBmoSummaryFacts_(text);equal(f.complete,false,'complete');equal(f.ambiguous,true,'ambiguous');return'failed closed';});

  test('BMO NSF count is deterministic from printed return rows',function(){const text=['Cheque Returned NSF 489.01','Cheque Returned NSF 340.00','Cheque Returned NSF 637.00','Cheque Returned NSF 186.90','Cheque Returned NSF 493.62','Returned Item Payment Stopped 27,267.71'].join('\n');equal(vfcBmoCountNsf_(text),5,'NSF count');return'nsf=5';});

  test('BMO negative balances are detected from statement facts',function(){truthy(vfcBmoNegativeBalanceFlag_('Balance -1,450.12',{opening:10,closing:20}),'negative activity');truthy(vfcBmoNegativeBalanceFlag_('',{opening:-97.13,closing:447.32}),'negative opening');return'negative detected';});

  test('BMO transfer memo containing LOAN is never debt',function(){equal(vfcBmoClassifyDebit_(tx('2025-09-02','Transfer, OWNER LOAN 0985-3976-719','DEBIT',1000)),null,'transfer loan memo');return'excluded';});

  test('BMO known financing counterparties classify correctly',function(){equal(vfcBmoClassifyDebit_(tx('2025-09-04','Pre-Authorized Payment, CANACAP BUS/ENT','DEBIT',637)).family,'MCA','Canacap');equal(vfcBmoClassifyDebit_(tx('2025-09-04','Pre-Authorized Payment, GREENBOX CAPITA LNS/PRE','DEBIT',493.62)).family,'MCA','Greenbox');equal(vfcBmoClassifyDebit_(tx('2025-09-04','Pre-Authorized Payment, 2M7 FINANCIAL MSP/DIV','DEBIT',340)).family,'FINANCING','2M7');equal(vfcBmoClassifyDebit_(tx('2025-09-04','Pre-Authorized Payment, GFFG-CLOVERDALE LNS/PRE','DEBIT',160)).family,'FINANCING','GFFG');equal(vfcBmoClassifyDebit_(tx('2025-09-23','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',489.01)).family,'FINANCING','Ford');equal(vfcBmoClassifyDebit_(tx('2026-02-06','Pre-Authorized Payment, NISSAN FINANCE CLN/PEE','DEBIT',343.24)).family,'FINANCING','Nissan');return'known finance recognized';});

  test('BMO ICBC cards payroll and unknown PAD remain non-debt',function(){equal(vfcBmoClassifyDebit_(tx('2025-12-01','Pre-Authorized Payment, ICBC INS/ASS','DEBIT',336.70)).family,'OTHER','ICBC');equal(vfcBmoClassifyDebit_(tx('2025-10-21','Online Bill Payment, BMO MASTERCARD','DEBIT',395.76)).family,'OTHER','card');equal(vfcBmoClassifyDebit_(tx('2025-11-12','Pre-Authorized Payment, B12937 PAYWORKS PAY/PAY','DEBIT',3274.89)).family,'OTHER','payroll');equal(vfcBmoClassifyDebit_(tx('2025-11-12','Pre-Authorized Payment, ABC SERVICES BUS/ENT','DEBIT',500)).family,'OTHER','unknown PAD');return'informational only';});

  test('BMO recurring Canacap becomes confirmed debt',function(){const d=vfcDebtProfile_([row('2025-08-29',[tx('2025-08-04','Pre-Authorized Payment, CANACAP BUS/ENT','DEBIT',637)]),row('2025-09-29',[tx('2025-09-04','Pre-Authorized Payment, CANACAP BUS/ENT','DEBIT',637)]),row('2025-10-31',[tx('2025-10-04','Pre-Authorized Payment, CANACAP BUS/ENT','DEBIT',637)])]);close(d.confirmedMonthlyDebtService,637,.02,'Canacap debt');equal(d.activeDebtObligations.length,1,'obligation count');return'debt='+d.confirmedMonthlyDebtService;});

  test('BMO duplicate same-day financing PADs are preserved',function(){const a=vfcNormalizeTransactions_([tx('2025-09-02','Pre-Authorized Payment, GREENBOX CAPITA LNS/PRE','DEBIT',493.62),tx('2025-09-02','Pre-Authorized Payment, GREENBOX CAPITA LNS/PRE','DEBIT',493.62)],'BMO');equal(a.length,2,'duplicate PADs');return'count=2';});

  test('BMO real multi-return pattern suppresses financing debits only',function(){const printed=vfcNormalizeTransactions_([
    tx('2025-09-23','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',489.01),
    tx('2025-09-23','Pre-Authorized Payment, 2M7FINANCIALSOL BUS/ENT','DEBIT',340),
    tx('2025-09-23','Pre-Authorized Payment, CANACAP BUS/ENT','DEBIT',637),
    tx('2025-09-23','Pre-Authorized Payment, FD82424110013 MSP/DIV','DEBIT',186.90),
    tx('2025-09-23','Pre-Authorized Payment, GREENBOX CAPITA LNS/PRE','DEBIT',493.62),
    tx('2025-09-23','Cheque Returned NSF','CREDIT',489.01),
    tx('2025-09-23','Cheque Returned NSF','CREDIT',340),
    tx('2025-09-23','Cheque Returned NSF','CREDIT',637),
    tx('2025-09-23','Cheque Returned NSF','CREDIT',186.90),
    tx('2025-09-23','Cheque Returned NSF','CREDIT',493.62)
  ],'BMO'),d=vfcDebtProfile_([row('2025-09-29',printed)]);equal(d.returnedFinanceDebitsSuppressed,4,'suppressed financing debits');close(d.returnedCreditsTotal,2146.53,.02,'returned credits');close(d.confirmedMonthlyDebtService,0,.001,'confirmed debt');return'suppressed=4';});

  test('BMO duplicate Canacap financing credits are preserved and removed from operating revenue',function(){const printed=vfcNormalizeTransactions_([tx('2025-08-15','Direct Deposit, 2M7 FINANCIAL MSP/DIV','CREDIT',15788),tx('2025-08-15','Direct Deposit, CANACAP CLN/PEE','CREDIT',27267.71),tx('2025-08-15','Direct Deposit, CANACAP CLN/PEE','CREDIT',27267.71)],'BMO'),d=vfcDebtProfile_([row('2025-08-29',printed)]);equal(printed.length,3,'printed credits');close(d.financingCreditsTotal,70323.42,.02,'financing credits');equal(d.financingCredits.length,3,'financing credit count');return'financing='+d.financingCreditsTotal;});

  test('BMO ordinary large deposit is not financing',function(){equal(vfcBmoKnownFinancingCredit_(tx('2025-12-01','Deposit','CREDIT',70000)),false,'ordinary deposit');const d=vfcDebtProfile_([row('2025-12-31',[tx('2025-12-01','Deposit','CREDIT',70000)])]);close(d.financingCreditsTotal,0,.001,'financing total');return'not financing';});

  test('BMO internal transfer credit is excluded but Interac received is not',function(){truthy(vfcBmoIsNonOperatingTransferCredit_(tx('2025-09-02','Transfer, 0985-3976-719','CREDIT',1000)),'internal transfer');truthy(vfcBmoIsNonOperatingTransferCredit_(tx('2026-02-23','Online Transfer, TF 0709#3872-634','CREDIT',2000)),'online transfer');equal(vfcBmoIsNonOperatingTransferCredit_(tx('2025-09-22','INTERAC e-Transfer Received','CREDIT',126)),false,'Interac received');return'transfers separated';});

  test('BMO Ford and Nissan recurring streams remain separate obligations',function(){const d=vfcDebtProfile_([row('2025-12-31',[tx('2025-12-01','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',972.91),tx('2025-12-06','Pre-Authorized Payment, NISSAN FINANCE CLN/PEE','DEBIT',343.24)]),row('2026-01-30',[tx('2026-01-02','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',972.91),tx('2026-01-06','Pre-Authorized Payment, NISSAN FINANCE CLN/PEE','DEBIT',343.24)]),row('2026-02-27',[tx('2026-02-02','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',972.91),tx('2026-02-06','Pre-Authorized Payment, NISSAN FINANCE CLN/PEE','DEBIT',343.24)])]);equal(d.activeDebtObligations.length,2,'obligation count');close(d.confirmedMonthlyDebtService,1316.15,.02,'combined debt');return'debt='+d.confirmedMonthlyDebtService;});

  test('BMO debt profile is deterministic for identical frozen facts',function(){const rows=[row('2025-11-28',[tx('2025-11-03','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',972.91)]),row('2025-12-31',[tx('2025-12-01','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',972.91)]),row('2026-01-30',[tx('2026-01-02','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',972.91)])],a=JSON.stringify(vfcDebtProfile_(rows)),b=JSON.stringify(vfcDebtProfile_(rows));equal(a,b,'deterministic JSON');return'deterministic';});

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,bmoRulesVersion:vfcBmoBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
