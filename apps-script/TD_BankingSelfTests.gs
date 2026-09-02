/**
 * TD deterministic regression checks.
 * Safe to run manually from Apps Script: runTdBankingSelfTests().
 * No Sheets, Drive or OpenAI calls are made.
 */
function runTdBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'TD',transactions:transactions||[]}};}
  function close(actual,expected,tol,label){tol=tol==null?.02:tol;if(Math.abs(Number(actual||0)-Number(expected||0))>tol)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function equal(actual,expected,label){if(actual!==expected)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function truthy(value,label){if(!value)throw new Error((label||'value')+' expected truthy');}
  function test(name,fn){try{const detail=fn()||'';results.push({name:name,pass:true,detail:String(detail||'')});}catch(e){results.push({name:name,pass:false,detail:String(e&&e.message||e)});}}

  test('TD multi-page footer subtotals sum to whole-statement totals',function(){
    const text=['Page 1 of 5','Credits 3 33,132.31 Debits 28 39,968.90','Page 2 of 5','Credits 2 15,043.38 Debits 29 16,693.00','Page 3 of 5','Credits 2 18,603.11 Debits 29 16,908.00','Page 4 of 5','Credits 1 20,198.13 Debits 30 11,199.04','Page 5 of 5','Credits 2 25,724.74 Debits 26 12,816.95'].join('\n');
    const t=vfcTdPageTotals_(text);equal(t.pageCount,5,'TD page subtotal count');truthy(t.complete,'TD subtotal completeness');close(t.totalDeposits,112701.67,.02,'TD total deposits');close(t.totalWithdrawals,97585.89,.02,'TD total withdrawals');return'deposits='+t.totalDeposits+', withdrawals='+t.totalWithdrawals;
  });

  test('TD lock deterministically sets dates opening closing and OD flag',function(){
    const text=['MAR 31/26 - APR 30/26','Page 1 of 2','Credits 13 11,441.88','Debits 18 8,762.88','MONTHLY MIN. BAL. $30.76OD','BALANCE FORWARD MAR31 3.63','Page 2 of 2','Credits 1 2,520.00','Debits 10 2,142.71','MONTHLY MIN. BAL. $30.76OD','BALANCE FORWARD APR27 2,682.63'].join('\n');
    const s=vfcTdLockFacts_({closing_balance:999999,negative_balance_detected:false},text,'test.pdf');equal(s.statement_start_date,'2026-03-31','TD start date');equal(s.statement_end_date,'2026-04-30','TD end date');close(s.opening_balance,3.63,.001,'TD opening');close(s.total_deposits,13961.88,.001,'TD deposits');close(s.total_withdrawals,10905.59,.001,'TD withdrawals');close(s.closing_balance,3059.92,.001,'TD deterministic closing');equal(s.negative_balance_detected,true,'TD negative flag');return'closing='+s.closing_balance;
  });

  test('TD incomplete declared page set fails closed instead of guessing totals',function(){
    let threw=false;try{vfcTdLockFacts_({},['MAR 31/26 - APR 30/26','Page 1 of 2','Credits 13 11,441.88','Debits 18 8,762.88','BALANCE FORWARD MAR31 3.63'].join('\n'),'incomplete.pdf');}catch(e){threw=/could not be fully verified/i.test(String(e&&e.message||e));}truthy(threw,'TD incomplete page failure');return'failed closed';
  });

  test('TD transfer memo containing LOAN is never classified as debt',function(){
    const c=vfcTdClassifyDebit_(tx('2025-06-01','SEND E-TFR *Esd LOAN','DEBIT',2000,'SEND E-TFR *Esd LOAN'));equal(c,null,'TD transfer with loan memo');return'correctly excluded';
  });

  test('TD tax payment fee is a bank fee not a tax obligation',function(){
    const c=vfcTdClassifyDebit_(tx('2025-09-02','TAX PYT FEE','DEBIT',6,'TAX PYT FEE'));equal(c,null,'TD tax payment fee');return'fee excluded';
  });

  test('One standalone TD LOAN debit is financing evidence but not recurring debt',function(){
    const d=vfcDebtProfile_([row('2025-09-29',[tx('2025-09-08','LOAN','DEBIT',11105,'LOAN')])]);close(d.confirmedMonthlyDebtService,0,.001,'one-time standalone loan debt');equal(d.observedOnce.length,1,'standalone loan observed-once count');if(!/^TD_STANDALONE_LOAN_/.test(d.observedOnce[0].entityKey||''))throw new Error('standalone loan did not receive TD financing identity');return'observed once; confirmed debt=0';
  });

  test('Recurring standalone TD LOAN debits become confirmed monthly debt',function(){
    const d=vfcDebtProfile_([row('2025-09-30',[tx('2025-09-08','LOAN','DEBIT',11105,'LOAN')]),row('2025-10-31',[tx('2025-10-08','LOAN','DEBIT',11105,'LOAN')]),row('2025-11-30',[tx('2025-11-08','LOAN','DEBIT',11105,'LOAN')])]);close(d.confirmedMonthlyDebtService,11105,.02,'recurring standalone loan monthly debt');equal(d.activeDebtObligations.length,1,'recurring standalone loan obligation count');return'confirmed debt='+d.confirmedMonthlyDebtService;
  });

  test('TD principal and interest sharing one reference become one obligation',function(){
    const d=vfcDebtProfile_([
      row('2025-07-31',[tx('2025-07-16','LN PYT INT 900017902','DEBIT',265.90),tx('2025-07-16','LN PYT PRI 900017902','DEBIT',663.84)]),
      row('2025-08-29',[tx('2025-08-19','LN PYT INT 900017902','DEBIT',258.97),tx('2025-08-19','LN PYT PRI 900017902','DEBIT',670.77)]),
      row('2025-09-29',[tx('2025-09-08','LN PYT INT 900017902','DEBIT',543.96),tx('2025-09-08','LN PYT PRI 900017902','DEBIT',385.78)])
    ]);
    equal(d.activeDebtObligations.length,1,'TD PRI/INT obligation count');equal(d.activeDebtObligations[0].entityKey,'TD_LOAN_900017902','TD PRI/INT identity');close(d.confirmedMonthlyDebtService,929.74,.02,'TD PRI/INT monthly debt');return'one loan='+d.confirmedMonthlyDebtService;
  });

  test('TD LN PYMT-C suppresses failed financing debit and is non-operating credit',function(){
    const d=vfcDebtProfile_([row('2025-09-29',[tx('2025-09-09','LN PYMT *602099601','DEBIT',1265.14),tx('2025-09-09','LN PYMT-C *602099601','CREDIT',1265.14)])]);close(d.confirmedMonthlyDebtService,0,.001,'returned loan debt');equal(d.returnedFinanceDebitsSuppressed,1,'TD returned debit suppression');close(d.returnedCreditsTotal,1265.14,.001,'TD returned credit total');close(d.financingCreditsTotal,0,.001,'TD return not financing proceeds');return'returned credit excluded='+d.returnedCreditsTotal;
  });

  test('TD RTN NSF can suppress a same-amount financing debit without becoming revenue',function(){
    const d=vfcDebtProfile_([row('2025-09-29',[tx('2025-09-10','RBC LOAN PYMT LOAN','DEBIT',769.78),tx('2025-09-10','RTN NSF','CREDIT',769.78)])]);equal(d.returnedFinanceDebitsSuppressed,1,'RTN NSF suppression');close(d.returnedCreditsTotal,769.78,.001,'RTN NSF non-operating total');close(d.confirmedMonthlyDebtService,0,.001,'RTN NSF returned debt');return'returned='+d.returnedCreditsTotal;
  });

  test('TD same-day failed debit and identical successful retry preserve one real payment',function(){
    function retryRow(end,date){const items=vfcNormalizeTransactions_([tx(date,'LN PYMT *602099601','DEBIT',1265.14),tx(date,'LN PYMT-C *602099601','CREDIT',1265.14),tx(date,'LN PYMT *602099601','DEBIT',1265.14)],'TD');equal(items.filter(function(x){return x.direction==='DEBIT';}).length,2,'TD failed plus retry debit count');return row(end,items);}
    const d=vfcDebtProfile_([retryRow('2025-07-31','2025-07-09'),retryRow('2025-08-29','2025-08-11'),retryRow('2025-09-29','2025-09-09')]);
    equal(d.returnedFinanceDebitsSuppressed,3,'TD failed debit suppression count');close(d.confirmedMonthlyDebtService,1265.14,.02,'TD retry monthly debt');close(d.returnedCreditsTotal,3795.42,.02,'TD retry returned credits');equal(d.activeDebtObligations.length,1,'TD retry obligation count');return'confirmed retry debt='+d.confirmedMonthlyDebtService;
  });

  test('TD returned credits are removed from estimated operating deposits',function(){
    const txs=vfcNormalizeTransactions_([tx('2025-09-09','LN PYMT *602099601','DEBIT',1265.14),tx('2025-09-09','LN PYMT-C *602099601','CREDIT',1265.14)],'TD');
    const p={bankId:'TD',bankName:'TD',statementStartDate:'2025-08-29',statementEndDate:'2025-09-29',openingBalance:0,closingBalance:0,totalDeposits:5000,totalWithdrawals:5000,reconciliationDifference:0,nsfCount:1,negativeBalanceDetected:false,transactionsVerified:true,transactions:txs};
    const f=vfcBuildBankingFeatures_({},[{row:{fileName:'td.pdf'},payload:p}]);close(f.estimatedOperatingTotalDeposits,3734.86,.02,'TD operating deposits net of return');equal(f.returnedPaymentFlag,1,'TD returned payment flag');return'operating='+f.estimatedOperatingTotalDeposits;
  });

  const failed=results.filter(function(x){return!x.pass;});return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,tdRulesVersion:vfcTdBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
