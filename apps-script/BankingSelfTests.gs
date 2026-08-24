/**
 * Deterministic banking stability checks.
 * Safe to run manually from Apps Script: runRbcBankingSelfTests().
 * No Sheets, Drive or OpenAI calls are made.
 */
function runRbcBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'RBC',transactions:transactions||[]}};}
  function close(actual,expected,tol,label){tol=tol==null?.02:tol;if(Math.abs(Number(actual||0)-Number(expected||0))>tol)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function equal(actual,expected,label){if(actual!==expected)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function test(name,fn){try{const detail=fn()||'';results.push({name:name,pass:true,detail:String(detail||'')});}catch(e){results.push({name:name,pass:false,detail:String(e&&e.message||e)});}}

  test('Personal loan is confirmed monthly debt',function(){
    const d=vfcDebtProfile_([
      row('2026-01-31',[tx('2026-01-05','Personal Loan SPL 000329209037884','DEBIT',1322.82)]),
      row('2026-02-28',[tx('2026-02-05','Personal Loan SPL 000329209037884','DEBIT',1322.82)]),
      row('2026-03-31',[tx('2026-03-05','Personal Loan SPL 000329209037884','DEBIT',1322.82)])
    ]);
    close(d.confirmedMonthlyDebtService,1322.82,.02,'personal loan monthly debt');
    equal(d.activeDebtObligations.length,1,'personal loan obligation count');
    if(!/Explicit loan|financing/i.test(d.activeDebtObligations[0].debtJustification||''))throw new Error('missing debt justification');
    return d.activeDebtObligations[0].counterparty+' '+d.confirmedMonthlyDebtService;
  });

  test('Lincoln NSF plus retry counts once',function(){
    const d=vfcDebtProfile_([
      row('2026-01-31',[tx('2026-01-05','Auto Payment LINCOLN AFS CA','DEBIT',1367.54,'LINCOLN AFS CA')]),
      row('2026-02-28',[
        tx('2026-02-05','Auto Payment LINCOLN AFS CA','DEBIT',1367.54,'LINCOLN AFS CA'),
        tx('2026-02-05','Item returned NSF','CREDIT',1367.54,'Item returned NSF'),
        tx('2026-02-09','Misc Payment LINCOLN AFS CA','DEBIT',1367.54,'LINCOLN AFS CA')
      ]),
      row('2026-03-31',[tx('2026-03-05','Auto Payment LINCOLN AFS CA','DEBIT',1367.54,'LINCOLN AFS CA')])
    ]);
    close(d.confirmedMonthlyDebtService,1367.54,.02,'Lincoln monthly debt');
    equal(d.returnedFinanceDebitsSuppressed,1,'returned financing debit suppression');
    return 'monthly='+d.confirmedMonthlyDebtService+', suppressed='+d.returnedFinanceDebitsSuppressed;
  });

  test('Same-dollar e-Transfers never become debt',function(){
    const d=vfcDebtProfile_([
      row('2026-01-31',[tx('2026-01-10','e-Transfer sent JOHN DOE','DEBIT',1000,'JOHN DOE')]),
      row('2026-02-28',[tx('2026-02-10','e-Transfer sent JOHN DOE','DEBIT',1000,'JOHN DOE')]),
      row('2026-03-31',[tx('2026-03-10','e-Transfer sent JOHN DOE','DEBIT',1000,'JOHN DOE')])
    ]);
    close(d.confirmedMonthlyDebtService,0,.001,'e-Transfer debt');
    return 'confirmed debt=0';
  });

  test('Unknown recurring PAD is informational, not debt',function(){
    const d=vfcDebtProfile_([
      row('2026-01-31',[tx('2026-01-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),
      row('2026-02-28',[tx('2026-02-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),
      row('2026-03-31',[tx('2026-03-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])
    ]);
    close(d.confirmedMonthlyDebtService,0,.001,'unknown PAD debt');
    close(d.informationalMonthlyObligations,500,.02,'unknown PAD informational amount');
    return 'informational='+d.informationalMonthlyObligations;
  });

  test('RBC Visa payments are informational, not fixed debt',function(){
    const d=vfcDebtProfile_([
      row('2026-01-31',[tx('2026-01-13','Online Banking payment VISA ROYAL BNK','DEBIT',8000,'VISA ROYAL BNK')]),
      row('2026-02-28',[tx('2026-02-13','Online Banking payment VISA ROYAL BNK','DEBIT',8000,'VISA ROYAL BNK')]),
      row('2026-03-31',[tx('2026-03-13','Online Banking payment VISA ROYAL BNK','DEBIT',8000,'VISA ROYAL BNK')])
    ]);
    close(d.confirmedMonthlyDebtService,0,.001,'Visa debt');
    close(d.informationalMonthlyObligations,8000,.02,'Visa informational amount');
    return 'informational='+d.informationalMonthlyObligations;
  });

  test('CCRA weekly cadence is informational tax',function(){
    const items1=[tx('2026-01-06','PAD CCRA CANADA','DEBIT',768.71,'CCRA CANADA'),tx('2026-01-13','PAD CCRA CANADA','DEBIT',768.71,'CCRA CANADA'),tx('2026-01-20','PAD CCRA CANADA','DEBIT',768.71,'CCRA CANADA'),tx('2026-01-27','PAD CCRA CANADA','DEBIT',768.71,'CCRA CANADA')];
    const items2=[tx('2026-02-03','PAD CCRA CANADA','DEBIT',768.71,'CCRA CANADA'),tx('2026-02-10','PAD CCRA CANADA','DEBIT',768.71,'CCRA CANADA'),tx('2026-02-17','PAD CCRA CANADA','DEBIT',768.71,'CCRA CANADA'),tx('2026-02-24','PAD CCRA CANADA','DEBIT',768.71,'CCRA CANADA')];
    const d=vfcDebtProfile_([row('2026-01-31',items1),row('2026-02-28',items2)]);
    close(d.confirmedMonthlyDebtService,0,.001,'CCRA debt');
    close(d.informationalMonthlyObligations,768.71*52/12,.05,'CCRA monthly equivalent');
    return 'tax monthly='+d.informationalMonthlyObligations;
  });

  test('CSBFL advance is financing credit and numbered loan is debt',function(){
    const d=vfcDebtProfile_([
      row('2026-01-31',[tx('2026-01-08','Loan payment NO.09530611 001','DEBIT',3232.33,'Loan payment NO.09530611 001')]),
      row('2026-02-28',[tx('2026-02-08','Loan payment NO.09530611 001','DEBIT',3232.33,'Loan payment NO.09530611 001')]),
      row('2026-03-31',[
        tx('2026-03-08','Loan payment NO.09530611 001','DEBIT',3232.33,'Loan payment NO.09530611 001'),
        tx('2026-03-10','BR TO BR - Credit Memo 7512 CSBFL advance Loan: 09530611-001','CREDIT',13775,'CSBFL')
      ])
    ]);
    close(d.confirmedMonthlyDebtService,3232.33,.02,'CSBFL loan payment');
    close(d.financingCreditsTotal,13775,.02,'CSBFL financing credit');
    return 'debt='+d.confirmedMonthlyDebtService+', financing credit='+d.financingCreditsTotal;
  });

  test('iCapital large credit is financing; generic DLCI EFT is not',function(){
    const d=vfcDebtProfile_([
      row('2026-01-31',[tx('2026-01-10','Credit Memo ICAPITAL FINANCING','CREDIT',50000,'ICAPITAL')]),
      row('2026-02-28',[tx('2026-02-10','Misc Payment DLCI EFT','CREDIT',50000,'DLCI EFT')])
    ]);
    close(d.financingCreditsTotal,50000,.02,'iCapital financing credit');
    equal(d.financingCredits.length,1,'confirmed financing-credit count');
    return 'confirmed financing credit='+d.financingCreditsTotal;
  });

  test('Mortgage and LOC recurring payments are financing debt',function(){
    const d=vfcDebtProfile_([
      row('2026-01-31',[tx('2026-01-05','Mortgage payment 123456789','DEBIT',2200,'Mortgage 123456789'),tx('2026-01-15','LOC payment 987654321','DEBIT',900,'LOC 987654321')]),
      row('2026-02-28',[tx('2026-02-05','Mortgage payment 123456789','DEBIT',2200,'Mortgage 123456789'),tx('2026-02-15','LOC payment 987654321','DEBIT',900,'LOC 987654321')]),
      row('2026-03-31',[tx('2026-03-05','Mortgage payment 123456789','DEBIT',2200,'Mortgage 123456789'),tx('2026-03-15','LOC payment 987654321','DEBIT',900,'LOC 987654321')])
    ]);
    close(d.confirmedMonthlyDebtService,3100,.02,'mortgage plus LOC debt');
    equal(d.activeDebtObligations.length,2,'mortgage/LOC obligation count');
    return 'confirmed debt='+d.confirmedMonthlyDebtService;
  });

  test('Loan line containing fee wording is not discarded',function(){
    const d=vfcDebtProfile_([
      row('2026-01-31',[tx('2026-01-20','Loan payment service fee NO.123456','DEBIT',250,'Loan NO.123456')]),
      row('2026-02-28',[tx('2026-02-20','Loan payment service fee NO.123456','DEBIT',250,'Loan NO.123456')]),
      row('2026-03-31',[tx('2026-03-20','Loan payment service fee NO.123456','DEBIT',250,'Loan NO.123456')])
    ]);
    close(d.confirmedMonthlyDebtService,250,.02,'loan-fee recurring debt');
    return 'confirmed debt='+d.confirmedMonthlyDebtService;
  });

  test('Capital One auto payment remains card/informational',function(){
    const d=vfcDebtProfile_([
      row('2026-01-31',[tx('2026-01-18','Auto Payment CAPITAL ONE MASTERCARD','DEBIT',700,'CAPITAL ONE')]),
      row('2026-02-28',[tx('2026-02-18','Auto Payment CAPITAL ONE MASTERCARD','DEBIT',700,'CAPITAL ONE')]),
      row('2026-03-31',[tx('2026-03-18','Auto Payment CAPITAL ONE MASTERCARD','DEBIT',700,'CAPITAL ONE')])
    ]);
    close(d.confirmedMonthlyDebtService,0,.001,'Capital One debt');
    close(d.informationalMonthlyObligations,700,.02,'Capital One informational amount');
    return 'informational='+d.informationalMonthlyObligations;
  });

  test('Known funders with same amount stay separate obligations',function(){
    const rows=[];
    ['2026-01','2026-02','2026-03'].forEach(function(m,i){const day=i===0?'31':i===1?'28':'31';rows.push(row(m+'-'+day,[tx(m+'-07','CANACAP Funding payment','DEBIT',1000,'CANACAP'),tx(m+'-17','ICAPITAL payment','DEBIT',1000,'ICAPITAL')]));});
    const d=vfcDebtProfile_(rows);
    close(d.confirmedMonthlyDebtService,2000,.02,'same-amount known-funder debt');
    equal(d.activeDebtObligations.length,2,'known-funder obligation count');
    return 'obligations='+d.activeDebtObligations.length;
  });

  test('Ambiguous same-day NSF does not suppress the wrong lender',function(){
    const debits=[
      Object.assign({bankId:'RBC'},tx('2026-01-10','CANACAP Funding payment','DEBIT',1000,'CANACAP')),
      Object.assign({bankId:'RBC'},tx('2026-01-10','ICAPITAL payment','DEBIT',1000,'ICAPITAL'))
    ];
    const credits=[Object.assign({bankId:'RBC'},tx('2026-01-10','Item returned NSF','CREDIT',1000,'Item returned NSF'))];
    const kept=vfcSuppressReturnedFinanceDebits_(debits,credits);
    equal(kept.length,2,'ambiguous return kept debit count');
    return 'kept='+kept.length;
  });

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,rbcRulesVersion:vfcRbcBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}

function runBankingStabilitySelfTests(){return runRbcBankingSelfTests();}
