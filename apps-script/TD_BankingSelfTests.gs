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
  function test(name,fn){try{const detail=fn()||'';results.push({name:name,pass:true,detail:String(detail||'')});}catch(e){results.push({name:name,pass:false,detail:String(e&&e.message||e)});}}

  test('TD multi-page footer subtotals sum to whole-statement totals',function(){
    const text=[
      'Credits 3 33,132.31 Debits 28 39,968.90',
      'Credits 2 15,043.38 Debits 29 16,693.00',
      'Credits 2 18,603.11 Debits 29 16,908.00',
      'Credits 1 20,198.13 Debits 30 11,199.04',
      'Credits 2 25,724.74 Debits 26 12,816.95'
    ].join('\n');
    const t=vfcTdPageTotals_(text);
    equal(t.pageCount,5,'TD page subtotal count');
    close(t.totalDeposits,112701.67,.02,'TD total deposits');
    close(t.totalWithdrawals,97585.89,.02,'TD total withdrawals');
    return 'deposits='+t.totalDeposits+', withdrawals='+t.totalWithdrawals;
  });

  test('One standalone TD LOAN debit is financing evidence but not recurring debt',function(){
    const d=vfcDebtProfile_([row('2025-09-29',[tx('2025-09-08','LOAN','DEBIT',11105,'LOAN')])]);
    close(d.confirmedMonthlyDebtService,0,.001,'one-time standalone loan debt');
    equal(d.observedOnce.length,1,'standalone loan observed-once count');
    if(!/^TD_STANDALONE_LOAN_/.test(d.observedOnce[0].entityKey||''))throw new Error('standalone loan did not receive TD financing identity');
    return 'observed once; confirmed debt=0';
  });

  test('Recurring standalone TD LOAN debits become confirmed monthly debt',function(){
    const d=vfcDebtProfile_([
      row('2025-09-30',[tx('2025-09-08','LOAN','DEBIT',11105,'LOAN')]),
      row('2025-10-31',[tx('2025-10-08','LOAN','DEBIT',11105,'LOAN')]),
      row('2025-11-30',[tx('2025-11-08','LOAN','DEBIT',11105,'LOAN')])
    ]);
    close(d.confirmedMonthlyDebtService,11105,.02,'recurring standalone loan monthly debt');
    equal(d.activeDebtObligations.length,1,'recurring standalone loan obligation count');
    return 'confirmed debt='+d.confirmedMonthlyDebtService;
  });

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,tdRulesVersion:vfcTdBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
