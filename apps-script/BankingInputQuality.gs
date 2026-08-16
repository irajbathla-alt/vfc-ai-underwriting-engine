const VFC_BANKING = {
  VERSION: 'VFC-BANKING-PURE-4.6-CADENCE-CANONICAL',
  PREFIX: 'VFC_BANK_PURE_V46:',
  LEGACY: ['VFC_BANK_PURE_V45:','VFC_BANK_PURE_V44:','VFC_BANK_PURE_V43:','VFC_BANK_PURE_V42:','VFC_BANK_PURE_V41:','VFC_BANK_PURE_V40:','VFC_BANK_PURE_V35:','VFC_BANK_PURE_V34:'],
  PAYLOAD_VERSION: 46,
  MAX_STATEMENTS: 12,
  DEBT_LOOKBACK: 6,
  RECONCILE_TOLERANCE: 5,
  ACTIVE_LOOKBACK_DAYS: 60,
  AMOUNT_MATCH_PERCENT: 0.05,
  AMOUNT_MATCH_DOLLARS: 3
};

function getBankingInputQualityStatus() {
  return {
    modelVersion: VFC_BANKING.VERSION,
    automatic: true,
    bankAgnostic: true,
    statementHeaderTotalsAuthoritative: true,
    financingCreditFamiliesCanonicalized: true,
    operatingDepositsExcludeUniqueConfirmedFinancingCredits: true,
    recurringMonthlyEquivalentUsesObservedCadence: true,
    splitOcrLinesJoined: true,
    continuationLineDatesCarriedForward: true,
    debitVerificationNeverDeletesCredits: true,
    recurringGroupingUsesNameAndAmount: true,
    visibleLabelsUsePrintedDescriptions: true,
    creditsNeverCountAsDebt: true,
    historicalTrainingPdfReprocessingRequired: false
  };
}

function refreshDebtSignalsForPeriodSafe(companyOrRequest, requestedPeriod) {
  try {
    const req = b46Request_(companyOrRequest, requestedPeriod);
    return {ok:true,modelVersion:VFC_BANKING.VERSION,companyName:req.companyName,period:req.period,deferredToAssessment:true,errors:[]};
  } catch (e) {
    return {ok:false,modelVersion:VFC_BANKING.VERSION,errors:[String(e && e.message || e)]};
  }
}

function refreshLatestDebtSignals() {
  const rows = b46SummaryRows_('', '');
  if (!rows.length) throw new Error('No bank statements found.');
  rows.sort(function(a,b){ return b46Time_(a.createdAt)-b46Time_(b.createdAt); });
  const last = rows[rows.length-1];
  return getValidatedBankingFeatures_(last.companyName,last.period);
}
function diagnoseLatestBankingInputs(){ return refreshLatestDebtSignals(); }

function vfcBankCreateIntakePayload_(summary, fileName) {
  summary = summary || {};
  const opening=b46Nullable_(summary.opening_balance), closing=b46Nullable_(summary.closing_balance), deposits=b46Nullable_(summary.total_deposits), withdrawals=b46Nullable_(summary.total_withdrawals);
  const diff=(opening!==null&&closing!==null&&deposits!==null&&withdrawals!==null)?b46Round_((opening+deposits-withdrawals)-closing,.01):null;
  const payload={
    version:VFC_BANKING.PAYLOAD_VERSION,modelVersion:VFC_BANKING.VERSION,fileName:String(fileName||''),bankName:String(summary.bank_name||'Unknown'),
    statementStartDate:b46Iso_(summary.statement_start_date),statementEndDate:b46Iso_(summary.statement_end_date),
    openingBalance:opening,closingBalance:closing,totalDeposits:deposits,totalWithdrawals:withdrawals,reconciliationDifference:diff,
    nsfCount:Math.max(0,b46Number_(summary.nsf_count)),negativeBalanceDetected:b46Bool_(summary.negative_balance_detected),
    transactionsVerified:true,transactions:b46Dedupe_(summary.banking_transactions||[]),explicitScanVerified:false,
    source:'INTAKE_SINGLE_PASS',analyzedAt:new Date().toISOString()
  };
  return VFC_BANKING.PREFIX+JSON.stringify(payload);
}

function getValidatedBankingFeatures_(companyName, period) {
  const base=typeof buildPowerFeatures_==='function'?buildPowerFeatures_(companyName,period):(typeof buildFeaturesForCase_==='function'?buildFeaturesForCase_(companyName,period):null);
  if(!base)return null;
  const rows=b46SelectedRows_(companyName,period); if(!rows.length)return base;
  const prepared=b46PrepareRows_(rows); if(prepared.errors.length)throw new Error('Unable to verify uploaded bank statement(s): '+prepared.errors.join(' | '));

  let totalDeposits=0,totalWithdrawals=0,nsf=0,negative=0;
  const monthlyDeposits=[],monthlyWithdrawals=[],audit=[];
  prepared.rows.forEach(function(x){
    const p=x.payload;
    totalDeposits+=p.totalDeposits; totalWithdrawals+=p.totalWithdrawals; monthlyDeposits.push(p.totalDeposits); monthlyWithdrawals.push(p.totalWithdrawals);
    nsf+=Math.max(0,p.nsfCount||0); if(p.negativeBalanceDetected)negative=1;
    audit.push({fileName:x.row.fileName,bank:p.bankName,start:p.statementStartDate,end:p.statementEndDate,totalDeposits:p.totalDeposits,totalWithdrawals:p.totalWithdrawals,reconciliationDifference:p.reconciliationDifference,explicitScanVerified:!!p.explicitScanVerified,source:p.source||''});
  });

  const recent=prepared.rows.slice(Math.max(0,prepared.rows.length-VFC_BANKING.DEBT_LOOKBACK));
  const debt=b46DebtProfile_(recent,prepared.rows);
  const months=Math.max(1,prepared.rows.length), grossMonthly=totalDeposits/months;
  const operatingTotal=Math.max(0,totalDeposits-debt.financingCreditsTotal), operatingMonthly=operatingTotal/months;

  return Object.assign({},base,{
    statementCount:prepared.rows.length,monthsCovered:months,totalDeposits:b46Round_(totalDeposits,.01),averageMonthlyDeposits:b46Round_(grossMonthly,.01),
    totalWithdrawals:b46Round_(totalWithdrawals,.01),depositWithdrawalRatio:totalWithdrawals?b46Round_(totalDeposits/totalWithdrawals,.01):0,
    nsfCount:nsf,nsfPerMonth:b46Round_(nsf/months,.01),negativeBalanceFlag:negative,mcaPaymentFlag:debt.activeDebtObligations.length?1:0,
    monthlyDeposits:monthlyDeposits,monthlyWithdrawals:monthlyWithdrawals,
    estimatedOperatingTotalDeposits:b46Round_(operatingTotal,.01),estimatedOperatingMonthlyDeposits:b46Round_(operatingMonthly,.01),
    detectedFinancingCredits:b46Round_(debt.financingCreditsTotal,.01),existingMonthlyDebtService:b46Round_(debt.confirmedMonthlyDebtService,.01),
    otherRecurringMonthlyObligations:b46Round_(debt.otherRecurringMonthlyObligations,.01),debtServiceToDepositsRatio:grossMonthly?b46Round_(debt.confirmedMonthlyDebtService/grossMonthly,.0001):0,
    debtProfile:debt,inputQualityAudit:{modelVersion:VFC_BANKING.VERSION,statementAudit:audit,warnings:debt.warnings}
  });
}

function b46SelectedRows_(companyName,period){
  const all=b46SummaryRows_(companyName,period),map={};
  all.forEach(function(r){const key=b46StatementKey_(r),old=map[key];if(!old||b46Time_(r.createdAt)>=b46Time_(old.createdAt))map[key]=r;});
  const rows=Object.keys(map).map(function(k){return map[k];});
  rows.sort(function(a,b){return (b46Date_(a.endDate)||b46Date_(a.startDate)||new Date(0))-(b46Date_(b.endDate)||b46Date_(b.startDate)||new Date(0));});
  return rows.slice(Math.max(0,rows.length-VFC_BANKING.MAX_STATEMENTS));
}

function b46SummaryRows_(companyName,period){
  const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries'); if(!sh||sh.getLastRow()<2)return[];
  const values=sh.getDataRange().getValues(),headers=values[0].map(b46Header_),idx={}; headers.forEach(function(h,i){idx[h]=i;});
  function val(r,n){const i=idx[b46Header_(n)];return i===undefined?'':r[i];}
  const out=[];
  for(let i=1;i<values.length;i++){
    const r=values[i],company=String(val(r,'Company Name')||'').trim(),detected=String(val(r,'Detected Period')||'').trim();
    if(companyName&&!b46Same_(company,companyName))continue; if(period&&!b46Same_(detected,period))continue;
    const signalIndex=idx[b46Header_('Possible MCA Or Loan Payments')];
    out.push({rowNumber:i+1,signalColumn:signalIndex===undefined?-1:signalIndex+1,uploadId:String(val(r,'Upload ID')||'').trim(),companyName:company,period:detected,
      fileName:String(val(r,'File Name')||'').trim(),bank:String(val(r,'Bank Name')||'').trim(),startDate:val(r,'Statement Start Date'),endDate:val(r,'Statement End Date'),
      opening:b46Nullable_(val(r,'Opening Balance')),closing:b46Nullable_(val(r,'Closing Balance')),deposits:b46Nullable_(val(r,'Total Deposits')),withdrawals:b46Nullable_(val(r,'Total Withdrawals')),
      nsf:b46Number_(val(r,'NSF Count')),negative:b46Bool_(val(r,'Negative Balance Detected')),signalRaw:String(val(r,'Possible MCA Or Loan Payments')||''),createdAt:val(r,'Created At')});
  }
  return out;
}

function b46PrepareRows_(rows){
  const uploads=b46UploadIndex_(),sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries'),out=[],errors=[];
  rows.forEach(function(row,index){
    const recent=index>=Math.max(0,rows.length-VFC_BANKING.DEBT_LOOKBACK); let payload=b46ParsePayload_(row.signalRaw),changed=false;
    try{
      const totals=b46Totals_(row); if(!totals.ok)throw new Error('statement totals do not reconcile');
      if(!payload){payload={version:0,fileName:row.fileName,bankName:row.bank||'Unknown',statementStartDate:b46Iso_(row.startDate),statementEndDate:b46Iso_(row.endDate),openingBalance:totals.opening,closingBalance:totals.closing,totalDeposits:totals.deposits,totalWithdrawals:totals.withdrawals,reconciliationDifference:totals.diff,nsfCount:Math.max(0,row.nsf||0),negativeBalanceDetected:!!row.negative,transactionsVerified:!recent,transactions:[],explicitScanVerified:!recent,source:'TOTALS_ONLY'};changed=true;}
      payload.openingBalance=totals.opening;payload.closingBalance=totals.closing;payload.totalDeposits=totals.deposits;payload.totalWithdrawals=totals.withdrawals;payload.reconciliationDifference=totals.diff;
      payload.statementStartDate=b46Iso_(row.startDate)||payload.statementStartDate;payload.statementEndDate=b46Iso_(row.endDate)||payload.statementEndDate;
      payload.transactions=b46Dedupe_(payload.transactions||[]);

      if(recent&&(!payload.explicitScanVerified||Number(payload.version||0)<VFC_BANKING.PAYLOAD_VERSION)){
        const upload=b46ResolveUpload_(row,uploads); if(!upload||!upload.fileId)throw new Error('uploaded PDF file ID not found');
        const scan=b46Scan_(extractTextFromPdf_(upload.fileId),payload);
        payload.transactions=b46ReplaceExplicitDebits_(payload.transactions,scan.debits);
        payload.transactions=b46ReplaceStrongCredits_(payload.transactions,scan.credits);
        payload.transactions=b46Dedupe_(payload.transactions);
        payload.transactionsVerified=true;payload.explicitScanVerified=true;payload.version=VFC_BANKING.PAYLOAD_VERSION;payload.modelVersion=VFC_BANKING.VERSION;
        payload.source='INTAKE_LEDGER+V46_CANONICAL_SCAN';changed=true;
      }
      payload.transactions=b46Dedupe_(payload.transactions||[]);
      if(changed||String(row.signalRaw||'').indexOf(VFC_BANKING.PREFIX)!==0){if(row.signalColumn>0)sh.getRange(row.rowNumber,row.signalColumn).setValue(VFC_BANKING.PREFIX+JSON.stringify(payload));}
      out.push({row:row,payload:payload});
    }catch(e){errors.push(row.fileName+': '+String(e&&e.message||e));}
  });
  return{rows:out,errors:errors};
}

function b46Scan_(text,payload){
  const lines=String(text||'').replace(/\u00a0/g,' ').split(/\r?\n/),debits=[],credits=[]; let currentDate='',pending=null;
  for(let i=0;i<lines.length;i++){
    const line=String(lines[i]||'').replace(/\s+/g,' ').trim(); if(!line)continue;
    const dated=b46ExtractLineDate_(line,payload); if(dated.date){currentDate=dated.date;pending=null;}
    const body=dated.body;
    if(pending){
      const joined=(pending.body+' '+body).replace(/\s+/g,' ').trim(),tx=b46ParseStrongTransaction_(joined,pending.date);
      if(tx){(tx.direction==='CREDIT'?credits:debits).push(tx);pending=null;continue;}
      if(b46ContainsStrongMarker_(body))pending=null;else if(i-pending.index<=3){pending.body=joined;continue;}else pending=null;
    }
    const tx=b46ParseStrongTransaction_(body,currentDate);
    if(tx){(tx.direction==='CREDIT'?credits:debits).push(tx);continue;}
    if(currentDate&&b46ContainsStrongMarker_(body)&&!b46ContainsMoney_(body))pending={body:body,date:currentDate,index:i};
  }
  return{debits:b46Dedupe_(debits),credits:b46Dedupe_(credits)};
}

function b46ExtractLineDate_(line,payload){
  let m=line.match(/^(\d{1,2})\s+([A-Za-z]{3})(?:\s+(.*))?$/);if(m)return{date:b46ActivityDate_(m[1],m[2],payload.statementStartDate,payload.statementEndDate),body:m[3]||''};
  m=line.match(/^([A-Za-z]{3})\s+(\d{1,2})(?:\s+(.*))?$/);if(m)return{date:b46ActivityDate_(m[2],m[1],payload.statementStartDate,payload.statementEndDate),body:m[3]||''};
  m=line.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(.*))?$/);return m?{date:m[1],body:m[2]||''}:{date:'',body:line};
}

function b46ContainsStrongMarker_(s){return /LOAN PAYMENT|LOAN INTEREST|COMM(?:ERCIAL)?\s+EQUIP(?:MENT)?\s+RENT\/LSE|EQUIP(?:MENT)?\s+RENT\/LSE|EQUIP(?:MENT)?\s+LEASE|LEASE PAYMENT|EQUIP(?:MENT)?\s+FINANC(?:E|ING)|EQUIP(?:MENT)?\s+RENT|CSBFL ADVANCE|LOAN CREDIT|LOAN ADVANCE|LOAN PROCEEDS|MCA ADVANCE|FINANCING ADVANCE/i.test(String(s||''));}
function b46ContainsMoney_(s){return /\d{1,3}(?:,\d{3})*\.\d{2}/.test(String(s||''));}
function b46ParseStrongTransaction_(s,date){
  if(!date)return null;
  const src=String(s||'').replace(/\s+/g,' ').trim(),upper=src.toUpperCase();
  const creditMarkers=['CSBFL ADVANCE','LOAN CREDIT','LOAN ADVANCE','LOAN PROCEEDS','MCA ADVANCE','FINANCING ADVANCE'];
  const debitMarkers=['LOAN PAYMENT','LOAN INTEREST','COMM EQUIP RENT/LSE','COMMERCIAL EQUIP RENT/LSE','EQUIPMENT RENT/LSE','EQUIP RENT/LSE','EQUIPMENT LEASE','EQUIP LEASE','LEASE PAYMENT','EQUIPMENT FINANCE','EQUIPMENT FINANCING','EQUIPMENT RENT','EQUIP RENT'];
  let at=-1,direction='';
  creditMarkers.forEach(function(marker){const j=upper.indexOf(marker);if(j>=0&&(at<0||j<at)){at=j;direction='CREDIT';}});
  debitMarkers.forEach(function(marker){const j=upper.indexOf(marker);if(j>=0&&(at<0||j<at)){at=j;direction='DEBIT';}});
  if(at<0)return null;
  const tail=src.slice(at),amountMatch=tail.match(/\d{1,3}(?:,\d{3})*\.\d{2}/g); if(!amountMatch||!amountMatch.length)return null;
  const amount=b46Number_(amountMatch[0]),pos=tail.indexOf(amountMatch[0]),description=tail.slice(0,pos).trim();
  return amount>0&&description?{date:date,description:description,counterparty:description,direction:direction,amount:b46Round_(amount,.01)}:null;
}

function b46ReplaceExplicitDebits_(existing,direct){
  existing=b46NormalizeTransactions_(existing||[]);direct=b46Dedupe_(direct||[]);if(!direct.length)return b46Dedupe_(existing);
  const families={};direct.forEach(function(t){const f=b46DebitFamily_(t.description);if(f)families[f]=1;});
  const kept=existing.filter(function(t){if(t.direction!=='DEBIT')return true;const f=b46DebitFamily_(t.description);return !f||!families[f];});
  return b46Dedupe_(kept.concat(direct));
}

function b46ReplaceStrongCredits_(existing,direct){
  existing=b46NormalizeTransactions_(existing||[]);direct=b46Dedupe_(direct||[]);if(!direct.length)return b46Dedupe_(existing);
  const families={};direct.forEach(function(t){const f=b46CreditFamily_(t.description);if(f)families[f]=1;});
  const kept=existing.filter(function(t){if(t.direction!=='CREDIT')return true;const f=b46CreditFamily_(t.description);return !f||!families[f];});
  return b46Dedupe_(kept.concat(direct));
}

function b46DebitFamily_(description){
  const d=String(description||'').toUpperCase(),loan=b46LoanNumber_(d);
  if(/LOAN INTEREST/.test(d))return'LOAN_INTEREST_'+(loan||b46EntityKey_(d));
  if(loan&&/LOAN PAYMENT/.test(d))return'LOAN_'+loan;
  if(b46IsEquipmentLease_(d))return'EQUIPMENT_LEASE_'+b46EntityKey_(d);
  if(/\bEQUIPMENT RENT\b|\bEQUIP RENT\b/.test(d))return'EQUIPMENT_RENT_'+b46EntityKey_(d);
  return'';
}
function b46CreditFamily_(description){
  const d=String(description||'').toUpperCase(),loan=b46LoanNumber_(d);
  if(/CSBFL ADVANCE/.test(d))return'CSBFL_ADVANCE_'+(loan||b46EntityKey_(d));
  if(/LOAN CREDIT/.test(d))return'LOAN_CREDIT_'+(loan||b46EntityKey_(d));
  if(/LOAN ADVANCE/.test(d))return'LOAN_ADVANCE_'+(loan||b46EntityKey_(d));
  if(/LOAN PROCEEDS/.test(d))return'LOAN_PROCEEDS_'+(loan||b46EntityKey_(d));
  if(/MCA ADVANCE/.test(d))return'MCA_ADVANCE_'+b46EntityKey_(d);
  if(/FINANCING ADVANCE/.test(d))return'FINANCING_ADVANCE_'+b46EntityKey_(d);
  return'';
}

function b46DebtProfile_(recentRows,allRows){
  const recentTx=b46Flatten_(recentRows),allTx=b46Flatten_(allRows),debtGroups=[],otherGroups=[],genericLoanCredits=[],genericLoanPayments=[];
  recentTx.forEach(function(t){
    const d=String(t.description||'').toUpperCase();if(!(t.amount>0))return;
    if(t.direction==='CREDIT'){if(/\bLOAN CREDIT\b/.test(d))genericLoanCredits.push(t);return;}
    if(t.direction!=='DEBIT')return;
    if(/^LOAN PAYMENT\b/.test(d)&&!b46LoanNumber_(d)){genericLoanPayments.push(t);return;}
    if(/SUPERPASS|HYDRO|FORTIS|GAS BILL|TELUS|ROGERS|PHONE|PAY-FILE|BANK FEE/.test(d))return;
    if(b46IsEquipmentLease_(d)){b46AddGroup_(debtGroups,t,'DEBT');return;}
    if(/CRA|CCRA|GST|HST|TAX|EMPTX|TXINS|INSURANCE|IPFS|PREMIUM FINANCE|CREDIT CARD|ICBC|OWIC|EQUITABLE LIFE|IND ALL LIFE/.test(d)){b46AddGroup_(otherGroups,t,'OTHER');return;}
    if(/\bPAD\b|\bMCA\b|MERCH|MERCHANT|BDC|JOURNEY|ONDECK|LOAN PAYMENT|LOAN INTEREST|FINANC/.test(d)){b46AddGroup_(debtGroups,t,'DEBT');return;}
    if(/\bEQUIPMENT RENT\b|\bEQUIP RENT\b/.test(d))b46AddGroup_(otherGroups,t,'OTHER');
  });
  if(!genericLoanCredits.length)genericLoanPayments.forEach(function(t){b46AddGroup_(debtGroups,t,'DEBT');});

  const latestDate=b46LatestStatementDate_(recentRows),active=[],newFinancingObserved=[],otherRecurring=[],otherObserved=[];
  debtGroups.forEach(function(g){
    const periods=b46Periods_(g.items),occ=g.items.length,last=b46LatestDate_(g.items),monthly=b46MonthlyEquivalent_(g,recentRows.length);
    const item=b46GroupItem_(g,monthly.monthly,occ,periods,monthly.frequency);
    item.active=!latestDate||!last?true:b46DaysBetween_(last,latestDate)<=VFC_BANKING.ACTIVE_LOOKBACK_DAYS;
    if(occ>=2&&periods>=2&&item.active)active.push(item);else newFinancingObserved.push(b46ObservedItem_(g));
  });
  otherGroups.forEach(function(g){
    const periods=b46Periods_(g.items),occ=g.items.length;
    if(occ>=2&&periods>=2&&b46OtherRecurringEligible_(g)){
      const monthly=b46MonthlyEquivalent_(g,recentRows.length);otherRecurring.push(b46GroupItem_(g,monthly.monthly,occ,periods,monthly.frequency));
    }else otherObserved.push(b46ObservedItem_(g));
  });

  let financingCredits=[];
  allTx.forEach(function(t){if(t.direction==='CREDIT'&&t.amount>0&&b46IsFinancingCredit_(t,debtGroups))financingCredits.push(Object.assign({},t,{classification:'FINANCING_CREDIT'}));});
  financingCredits=b46UniqueFinancingCredits_(financingCredits);
  const creditTotal=b46Sum_(financingCredits),confirmed=active.reduce(function(s,x){return s+x.monthlyEquivalent;},0),otherMonthly=otherRecurring.reduce(function(s,x){return s+x.monthlyEquivalent;},0),warnings=[];
  if(genericLoanCredits.length&&genericLoanPayments.length)warnings.push('Generic LOAN CREDIT/LOAN PAYMENT activity is treated as revolving sweep activity, not fixed monthly debt.');
  if(newFinancingObserved.length)warnings.push('New or insufficient-history financing activity is shown separately and is not converted into recurring monthly debt.');
  if(otherObserved.length)warnings.push('One-off informational payments are retained for audit but excluded from the recurring monthly-obligation total.');
  return{
    confirmedMonthlyDebtService:b46Round_(confirmed,.01),otherRecurringMonthlyObligations:b46Round_(otherMonthly,.01),financingCreditsTotal:b46Round_(creditTotal,.01),
    activeDebtObligations:active,otherRecurringObligations:otherRecurring,otherObservedPayments:otherObserved,financingCredits:financingCredits,newFinancingObserved:newFinancingObserved,
    revolvingFinancingActivity:genericLoanCredits.length&&genericLoanPayments.length?[{type:'REVOLVING_LOAN_SWEEP',creditOccurrences:genericLoanCredits.length,paymentOccurrences:genericLoanPayments.length,totalCredits:b46Round_(b46Sum_(genericLoanCredits),.01),totalPayments:b46Round_(b46Sum_(genericLoanPayments),.01),includedInMonthlyDebt:false}]:[],warnings:warnings
  };
}

function b46MonthlyEquivalent_(group,recentStatementCount){
  const items=group.items||[],values=items.map(function(t){return t.amount;}).sort(function(a,b){return a-b;}),payment=b46Median_(values),periods=b46Periods_(items);
  const observed=b46Sum_(items)/Math.max(1,recentStatementCount-b46FirstStatementIndex_(items));
  const stableCount=items.filter(function(t){return b46AmountsClose_(t.amount,payment,VFC_BANKING.AMOUNT_MATCH_PERCENT,VFC_BANKING.AMOUNT_MATCH_DOLLARS);}).length;
  const stableRatio=items.length?stableCount/items.length:0;
  const uniqueDates={},dates=[];
  items.forEach(function(t){if(t.date&&!uniqueDates[t.date]){uniqueDates[t.date]=1;const d=b46Date_(t.date);if(d)dates.push(d);}});
  dates.sort(function(a,b){return a-b;});
  const gaps=[];for(let i=1;i<dates.length;i++){const gap=(dates[i]-dates[i-1])/86400000;if(gap>=1&&gap<=45)gaps.push(gap);}
  const medianGap=gaps.length?b46Median_(gaps.sort(function(a,b){return a-b;})):0;
  if(periods>=2&&items.length>=4&&stableRatio>=0.70){
    if(medianGap>=5&&medianGap<=9)return{monthly:payment*52/12,frequency:'Weekly observed cadence'};
    if(medianGap>=12&&medianGap<=16)return{monthly:payment*26/12,frequency:'Biweekly observed cadence'};
    if(medianGap>=25&&medianGap<=36)return{monthly:payment,frequency:'Monthly observed cadence'};
  }
  return{monthly:observed,frequency:'Observed statement-period cash flow'};
}

function b46UniqueFinancingCredits_(items){
  const out=[];
  (items||[]).forEach(function(t){
    const family=b46CreditFamily_(t.description)||('OTHER_'+b46EntityKey_(t.description));
    let duplicate=false;
    for(let i=0;i<out.length;i++){
      const o=out[i],of=b46CreditFamily_(o.description)||('OTHER_'+b46EntityKey_(o.description));
      if(o._statementKey===t._statementKey&&of===family&&b46AmountsClose_(o.amount,t.amount,0,.05)&&b46DaysBetween_(o.date,t.date)<=3){duplicate=true;break;}
    }
    if(!duplicate)out.push(t);
  });
  return out;
}

function b46Flatten_(rows){
  const out=[];(rows||[]).forEach(function(x,statementIndex){const p=x.payload||{},statementKey=[p.statementStartDate||x.row.startDate||'',p.statementEndDate||x.row.endDate||'',x.row.fileName||''].join('|');b46Dedupe_(p.transactions||[]).forEach(function(t){out.push(Object.assign({},t,{_statementIndex:statementIndex,_statementKey:statementKey}));});});return out;
}

function b46Dedupe_(items){
  const normalized=b46NormalizeTransactions_(items||[]),out=[];
  normalized.forEach(function(t){
    let duplicate=null;
    for(let i=0;i<out.length;i++){
      const old=out[i];if(old.direction!==t.direction||old.date!==t.date)continue;if(!b46AmountsClose_(old.amount,t.amount,.01,.05))continue;if(b46OccurrenceRelated_(old.description,t.description)){duplicate=old;break;}
    }
    if(!duplicate){out.push(t);return;}
    duplicate._aliases=duplicate._aliases||[];[t.description].concat(t._aliases||[]).forEach(function(name){name=b46Label_(name);if(name&&name!==duplicate.description&&duplicate._aliases.indexOf(name)<0)duplicate._aliases.push(name);});
  });
  return out;
}
function b46OccurrenceRelated_(a,b){
  const la=b46LoanNumber_(a),lb=b46LoanNumber_(b);if(la||lb)return!!la&&la===lb;
  const da=b46DebitFamily_(a),db=b46DebitFamily_(b);if(da&&db&&da===db)return true;
  const ca=b46CreditFamily_(a),cb=b46CreditFamily_(b);if(ca&&cb&&ca===cb)return true;
  const ea=b46EntityKey_(a),eb=b46EntityKey_(b);return!!ea&&!!eb&&(ea===eb||ea.indexOf(eb)>=0||eb.indexOf(ea)>=0||b46NameSimilarity_(a,b)>=.60);
}

function b46AddGroup_(groups,t,type){
  const identity=b46Identity_(t,type);let group=null;
  for(let i=0;i<groups.length;i++){if(b46GroupMatches_(groups[i],identity,t)){group=groups[i];break;}}
  if(!group){group={type:type,strongKey:identity.strongKey||'',entityKey:identity.entityKey||'',items:[],names:[]};groups.push(group);}
  if(!group.items.some(function(old){return old.date===t.date&&old.direction===t.direction&&b46AmountsClose_(old.amount,t.amount,.01,.05);}))group.items.push(t);
  [t.description].concat(t._aliases||[]).forEach(function(name){name=b46Label_(name);if(name&&group.names.indexOf(name)<0)group.names.push(name);});
}
function b46GroupMatches_(group,identity,t){
  if(group.strongKey&&identity.strongKey)return group.strongKey===identity.strongKey;if(group.strongKey||identity.strongKey||!group.items.length)return false;
  const reference=b46Median_(group.items.map(function(x){return x.amount;}).sort(function(a,b){return a-b;}));if(!b46AmountsClose_(reference,t.amount,VFC_BANKING.AMOUNT_MATCH_PERCENT,VFC_BANKING.AMOUNT_MATCH_DOLLARS))return false;
  if(group.entityKey&&identity.entityKey&&(group.entityKey===identity.entityKey||group.entityKey.indexOf(identity.entityKey)>=0||identity.entityKey.indexOf(group.entityKey)>=0))return true;
  return b46NameSimilarity_(group.names.join(' '),t.description)>=.50;
}
function b46Identity_(t,type){
  const d=String(t.description||'').toUpperCase(),loan=b46LoanNumber_(d);
  if(/LOAN INTEREST/.test(d))return{strongKey:'LOAN_INTEREST_'+(loan||b46EntityKey_(d)),entityKey:'LOAN_INTEREST_'+(loan||b46EntityKey_(d))};
  if(loan)return{strongKey:'LOAN_'+loan,entityKey:'LOAN_'+loan};
  if(type==='DEBT'){
    if(/MERCH|MERCHANT/.test(d))return{strongKey:'MERCHANT',entityKey:'MERCHANT'};
    if(/\bBDC\b/.test(d))return{strongKey:'BDC',entityKey:'BDC'};
    if(/JOURNEY|ONDECK/.test(d))return{strongKey:'JOURNEY_ONDECK',entityKey:'JOURNEYONDECK'};
  }
  const tax=b46TaxKey_(d);return tax?{strongKey:tax,entityKey:tax}:{strongKey:'',entityKey:b46EntityKey_(d)};
}

function b46GroupItem_(group,monthly,occ,periods,frequency){
  const values=group.items.map(function(t){return t.amount;}).sort(function(a,b){return a-b;}),dates=group.items.map(function(t){return t.date;}).sort();
  const label=group.names.length?group.names.join(' / '):b46Label_(group.items[0]&&group.items[0].description||'Detected obligation');
  return{counterparty:label,description:label,printedDescriptions:group.names.slice(),category:group.type,paymentAmount:b46Round_(b46Median_(values),.01),frequency:frequency||'Observed cash flow',monthlyEquivalent:b46Round_(monthly,.01),occurrences:occ,monthsObserved:periods,statementPeriodsObserved:periods,firstSeen:dates[0]||'',lastSeen:dates.length?dates[dates.length-1]:'',active:true,confidence:occ>=3&&periods>=2?'High':'Moderate'};
}
function b46ObservedItem_(group){
  const values=group.items.map(function(t){return t.amount;}).sort(function(a,b){return a-b;}),dates=group.items.map(function(t){return t.date;}).sort(),periods=b46Periods_(group.items),label=group.names.length?group.names.join(' / '):b46Label_(group.items[0]&&group.items[0].description||'Detected obligation');
  return{counterparty:label,description:label,printedDescriptions:group.names.slice(),category:group.type,observedAmount:b46Round_(b46Sum_(group.items),.01),paymentAmount:b46Round_(b46Median_(values),.01),monthlyEquivalent:0,occurrences:group.items.length,monthsObserved:periods,statementPeriodsObserved:periods,firstSeen:dates[0]||'',lastSeen:dates.length?dates[dates.length-1]:'',recurring:false,confidence:group.items.length>=2?'Moderate':'Observed once'};
}

function b46OtherRecurringEligible_(group){return group.strongKey!=='TAX_UNSPECIFIED';}
function b46IsFinancingCredit_(t,debtGroups){
  const d=String(t.description||'').toUpperCase();
  if(/\bLOAN CREDIT\b|\b(LOAN ADVANCE|LOAN PROCEEDS|MCA ADVANCE|FINANCING ADVANCE|CSBFL ADVANCE)\b/.test(d))return true;
  if(/\bCREDIT MEMO\b/.test(d)&&/\b(CLIENT REQUEST|RETURN|TRF|TRANSFER|INTERNAL)\b/.test(d))return false;
  for(let i=0;i<(debtGroups||[]).length;i++){if(debtGroups[i].names.some(function(name){return b46NameSimilarity_(name,t.description)>=.55;}))return true;}
  return /\bLOAN\b/.test(d)&&!/\b(RETURN|TRF|TRANSFER|CLIENT REQUEST)\b/.test(d);
}
function b46IsEquipmentLease_(d){d=String(d||'').toUpperCase();return/\bEQUIP(?:MENT)?\s+RENT\/LSE\b|\bEQUIP(?:MENT)?\s+LEASE\b|\bLEASE\s+PAYMENT\b|\bEQUIP(?:MENT)?\s+FINANC(?:E|ING)\b/.test(d);}
function b46LoanNumber_(d){const text=String(d||'').toUpperCase(),m=text.match(/(?:NO\.?|NUMBER|#|LOAN:)\s*([0-9]{5,})/)||text.match(/LOAN\s+PAYMENT\s+([0-9]{5,})/);return m?m[1]:'';}
function b46TaxKey_(d){let m=d.match(/GST[- ]?P\s*(\d{4,})?/);if(m)return'TAX_GSTP_'+(m[1]||'UNSPECIFIED');m=d.match(/EMPTX\s*(\d{4,})?/);if(m)return'TAX_EMPTX_'+(m[1]||'UNSPECIFIED');m=d.match(/TXINS\s*(\d{4,})?/);if(m)return'TAX_TXINS_'+(m[1]||'UNSPECIFIED');return/COMMERCIAL TAXES|\bTAX\b|CRA|CCRA|HST/.test(d)?'TAX_UNSPECIFIED':'';}

const B46_STOP={BUSINESS:1,INVESTMENT:1,PAD:1,PAYMENT:1,PAY:1,LOAN:1,CREDIT:1,DEBIT:1,FINANCING:1,FINANCE:1,INTEREST:1,ADVANCE:1,FUNDING:1,FUND:1,CAPITAL:1,DIRECT:1,DEPOSIT:1,MISC:1,EFT:1,PREAUTHORIZED:1,PREAUTH:1,TRANSFER:1,ONLINE:1,BANKING:1,CLIENT:1,REQUEST:1,RETURN:1,TRF:1,COMM:1,COMMERCIAL:1,EQUIP:1,EQUIPMENT:1,RENT:1,LSE:1,LEASE:1,NO:1,NUMBER:1};
function b46Tokens_(d){return String(d||'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim().split(/\s+/).filter(function(x){return x&&x.length>=3&&!B46_STOP[x]&&!/^\d+$/.test(x);});}
function b46EntityKey_(d){return b46Tokens_(d).join('').substring(0,80);}
function b46NameSimilarity_(a,b){const x=b46Tokens_(a),y=b46Tokens_(b);if(!x.length||!y.length)return 0;let n=0;x.forEach(function(q){if(y.some(function(z){return q===z||(q.length>=4&&z.length>=4&&(q.indexOf(z)===0||z.indexOf(q)===0));}))n++;});const c1=x.join(''),c2=y.join('');return Math.max(n/Math.max(x.length,y.length),c1&&c2&&(c1===c2||c1.indexOf(c2)>=0||c2.indexOf(c1)>=0)?1:0);}

function b46NormalizeTransactions_(items){
  if(!Array.isArray(items))return[];const out=[];
  items.forEach(function(x){x=x||{};const date=b46Iso_(x.date),description=String(x.description||'').replace(/\s+/g,' ').trim(),direction=String(x.direction||'').toUpperCase(),amount=Math.max(0,b46Number_(x.amount));if(!date||!description||(direction!=='DEBIT'&&direction!=='CREDIT')||!(amount>0))return;const t={date:date,description:description.substring(0,240),counterparty:String(x.counterparty||description).replace(/\s+/g,' ').trim().substring(0,140),direction:direction,amount:b46Round_(amount,.01)},aliases=Array.isArray(x._aliases)?x._aliases:(Array.isArray(x.printedDescriptions)?x.printedDescriptions:[]);if(aliases.length)t._aliases=aliases.map(b46Label_).filter(Boolean);out.push(t);});return out;
}

function b46UploadIndex_(){
  const rows=typeof getSheetObjects_==='function'?getSheetObjects_('Uploads'):[],idx={byId:{},byCompanyFile:{},byFile:{}};
  rows.forEach(function(r){let fileId=String(r.fileId||'').trim(),link=String(r.fileLink||'').trim();if(!fileId&&link){const m=link.match(/[-\w]{20,}/);if(m)fileId=m[0];}if(!fileId)return;const item={fileId:fileId,createdAt:r.createdAt||''},uploadId=String(r.uploadId||'').trim(),cf=b46Norm_(r.companyName)+'|'+b46Norm_(r.fileName),f=b46Norm_(r.fileName);if(uploadId)idx.byId[uploadId]=item;b46KeepNewest_(idx.byCompanyFile,cf,item);b46KeepNewest_(idx.byFile,f,item);});return idx;
}
function b46ResolveUpload_(r,idx){return idx.byId[r.uploadId]||idx.byCompanyFile[b46Norm_(r.companyName)+'|'+b46Norm_(r.fileName)]||idx.byFile[b46Norm_(r.fileName)]||null;}
function b46KeepNewest_(map,key,item){if(!key)return;const old=map[key];if(!old||b46Time_(item.createdAt)>=b46Time_(old.createdAt))map[key]=item;}
function b46Totals_(r){const o=r.opening,c=r.closing,d=r.deposits,w=r.withdrawals;if(o===null||c===null||d===null||w===null||d<0||w<0)return{ok:false};const diff=b46Round_((o+d-w)-c,.01);return{ok:Math.abs(diff)<=VFC_BANKING.RECONCILE_TOLERANCE,opening:o,closing:c,deposits:d,withdrawals:w,diff:diff};}
function b46ParsePayload_(raw){raw=String(raw||'').trim();const prefixes=[VFC_BANKING.PREFIX].concat(VFC_BANKING.LEGACY);for(let i=0;i<prefixes.length;i++){if(raw.indexOf(prefixes[i])!==0)continue;try{return JSON.parse(raw.slice(prefixes[i].length));}catch(e){return null;}}return null;}
function b46ActivityDate_(day,mon,start,end){const mm={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11},mi=mm[String(mon||'').toUpperCase()];if(mi===undefined)return'';const s=b46Date_(start),e=b46Date_(end);let y=e?e.getFullYear():(s?s.getFullYear():new Date().getFullYear());if(s&&e&&s.getFullYear()!==e.getFullYear()&&mi>=s.getMonth())y=s.getFullYear();return b46Iso_(new Date(y,mi,Number(day)));}
function b46Request_(x,p){if(typeof x==='string')return{companyName:String(x).trim(),period:String(p||'').trim()};x=x||{};return{companyName:String(x.companyName||x.company||'').trim(),period:String(x.period||p||'').trim()};}
function b46StatementKey_(r){const s=b46Iso_(r.startDate),e=b46Iso_(r.endDate);return s&&e?s+'|'+e:b46Norm_(r.fileName);}
function b46Header_(v){return String(v||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'');}
function b46Norm_(v){return String(v||'').trim().toLowerCase().replace(/\s+/g,' ');}
function b46Same_(a,b){return b46Norm_(a)===b46Norm_(b);}
function b46Nullable_(v){if(v===null||v===undefined||String(v).trim()==='')return null;const n=b46Number_(v);return isFinite(n)?n:null;}
function b46Number_(v){if(typeof v==='number')return isFinite(v)?v:0;const n=parseFloat(String(v||'').replace(/[^0-9.\-]/g,''));return isFinite(n)?n:0;}
function b46Bool_(v){return/yes|true|detected|negative|1/i.test(String(v||''));}
function b46Round_(v,step){step=step||1;return Math.round((Number(v)||0)/step)*step;}
function b46Date_(v){if(!v)return null;const d=new Date(v);return isNaN(d.getTime())?null:d;}
function b46Iso_(v){const d=b46Date_(v);return d?Utilities.formatDate(d,Session.getScriptTimeZone(),'yyyy-MM-dd'):'';}
function b46Time_(v){const d=b46Date_(v);return d?d.getTime():0;}
function b46Median_(a){if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
function b46Sum_(a){return(a||[]).reduce(function(s,t){return s+b46Number_(t.amount);},0);}
function b46AmountsClose_(a,b,pct,dollars){a=b46Number_(a);b=b46Number_(b);return Math.abs(a-b)<=Math.max(dollars||0,Math.max(a,b)*(pct||0));}
function b46Label_(v){return String(v||'').replace(/\s+/g,' ').trim();}
function b46Periods_(a){const s={};(a||[]).forEach(function(t){if(t._statementKey)s[t._statementKey]=1;else if(t._statementIndex!==undefined)s[String(t._statementIndex)]=1;else if(/^\d{4}-\d{2}/.test(t.date))s[t.date.slice(0,7)]=1;});return Object.keys(s).length;}
function b46FirstStatementIndex_(a){let x=null;(a||[]).forEach(function(t){const i=Number(t._statementIndex);if(isFinite(i)&&(x===null||i<x))x=i;});return x===null?0:x;}
function b46LatestStatementDate_(rows){let x=null;(rows||[]).forEach(function(r){const d=b46Date_(r.payload.statementEndDate||r.row.endDate);if(d&&(!x||d>x))x=d;});return x?b46Iso_(x):'';}
function b46LatestDate_(a){const dates=(a||[]).map(function(t){return b46Date_(t.date);}).filter(Boolean).sort(function(x,y){return x-y;});return dates.length?b46Iso_(dates[dates.length-1]):'';}
function b46DaysBetween_(a,b){const x=b46Date_(a),y=b46Date_(b);return!x||!y?0:Math.abs(y-x)/86400000;}
