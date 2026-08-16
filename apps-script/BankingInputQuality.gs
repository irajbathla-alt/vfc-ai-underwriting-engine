const VFC_BANKING_V43 = {
  VERSION: 'VFC-BANKING-PURE-4.4-CONTINUATION-DATES',
  PREFIX: 'VFC_BANK_PURE_V44:',
  LEGACY_PREFIXES: ['VFC_BANK_PURE_V43:','VFC_BANK_PURE_V42:','VFC_BANK_PURE_V41:','VFC_BANK_PURE_V40:','VFC_BANK_PURE_V35:','VFC_BANK_PURE_V34:'],
  MAX_STATEMENTS: 12,
  DEBT_LOOKBACK: 6,
  RECONCILE_TOLERANCE: 5,
  ACTIVE_LOOKBACK_DAYS: 60,
  AMOUNT_MATCH_PERCENT: 0.05,
  AMOUNT_MATCH_DOLLARS: 3
};

function getBankingInputQualityStatus() {
  return {
    modelVersion: VFC_BANKING_V43.VERSION,
    automatic: true,
    bankAgnostic: true,
    monthlyEquivalentUsesStatementPeriods: true,
    explicitDebtLinesDeterministicallyVerified: true,
    continuationLineDatesCarriedForward: true,
    duplicateOccurrencesRemovedBeforeMonthlyMath: true,
    recurringGroupingUsesNameAndAmount: true,
    visibleLabelsUsePrintedDescriptions: true,
    creditsNeverCountAsDebt: true,
    historicalTrainingPdfReprocessingRequired: false
  };
}

function refreshDebtSignalsForPeriodSafe(companyOrRequest, requestedPeriod) {
  try {
    const req = vfc43Request_(companyOrRequest, requestedPeriod);
    return {ok:true,modelVersion:VFC_BANKING_V43.VERSION,companyName:req.companyName,period:req.period,deferredToAssessment:true,errors:[]};
  } catch (e) {
    return {ok:false,modelVersion:VFC_BANKING_V43.VERSION,errors:[String(e && e.message || e)]};
  }
}

function refreshLatestDebtSignals() {
  const rows = vfc43SummaryRows_('', '');
  if (!rows.length) throw new Error('No bank statements found.');
  rows.sort(function(a,b){ return vfc43Time_(a.createdAt)-vfc43Time_(b.createdAt); });
  const last = rows[rows.length-1];
  return getValidatedBankingFeatures_(last.companyName,last.period);
}
function diagnoseLatestBankingInputs(){ return refreshLatestDebtSignals(); }

function vfcBankCreateIntakePayload_(summary, fileName) {
  summary = summary || {};
  const opening=vfc43Nullable_(summary.opening_balance);
  const closing=vfc43Nullable_(summary.closing_balance);
  const deposits=vfc43Nullable_(summary.total_deposits);
  const withdrawals=vfc43Nullable_(summary.total_withdrawals);
  const diff=(opening!==null&&closing!==null&&deposits!==null&&withdrawals!==null)
    ? vfc43Round_((opening+deposits-withdrawals)-closing,.01) : null;
  const payload={
    version:44,modelVersion:VFC_BANKING_V43.VERSION,fileName:String(fileName||''),bankName:String(summary.bank_name||'Unknown'),
    statementStartDate:vfc43Iso_(summary.statement_start_date),statementEndDate:vfc43Iso_(summary.statement_end_date),
    openingBalance:opening,closingBalance:closing,totalDeposits:deposits,totalWithdrawals:withdrawals,reconciliationDifference:diff,
    nsfCount:Math.max(0,vfc43Number_(summary.nsf_count)),negativeBalanceDetected:vfc43Bool_(summary.negative_balance_detected),
    transactionsVerified:true,transactions:vfc43NormalizeTransactions_(summary.banking_transactions||[]),explicitScanVerified:false,
    source:'INTAKE_SINGLE_PASS',analyzedAt:new Date().toISOString()
  };
  return VFC_BANKING_V43.PREFIX+JSON.stringify(payload);
}

function getValidatedBankingFeatures_(companyName, period) {
  const base = typeof buildPowerFeatures_ === 'function'
    ? buildPowerFeatures_(companyName,period)
    : (typeof buildFeaturesForCase_ === 'function' ? buildFeaturesForCase_(companyName,period) : null);
  if (!base) return null;

  const rows=vfc43SelectedRows_(companyName,period);
  if(!rows.length) return base;
  const prepared=vfc43PrepareRows_(rows);
  if(prepared.errors.length) throw new Error('Unable to verify uploaded bank statement(s): '+prepared.errors.join(' | '));

  let totalDeposits=0,totalWithdrawals=0,nsf=0,negative=0;
  const monthlyDeposits=[],monthlyWithdrawals=[],audit=[];
  prepared.rows.forEach(function(x){
    const p=x.payload;
    totalDeposits+=p.totalDeposits; totalWithdrawals+=p.totalWithdrawals;
    monthlyDeposits.push(p.totalDeposits); monthlyWithdrawals.push(p.totalWithdrawals);
    nsf+=Math.max(0,p.nsfCount||0); if(p.negativeBalanceDetected) negative=1;
    audit.push({fileName:x.row.fileName,bank:p.bankName,start:p.statementStartDate,end:p.statementEndDate,totalDeposits:p.totalDeposits,totalWithdrawals:p.totalWithdrawals,reconciliationDifference:p.reconciliationDifference,explicitScanVerified:!!p.explicitScanVerified,source:p.source||''});
  });

  const recent=prepared.rows.slice(Math.max(0,prepared.rows.length-VFC_BANKING_V43.DEBT_LOOKBACK));
  const debt=vfc43DebtProfile_(recent,prepared.rows);
  const months=Math.max(1,prepared.rows.length);
  const grossMonthly=totalDeposits/months;
  const operatingTotal=Math.max(0,totalDeposits-debt.financingCreditsTotal);
  const operatingMonthly=operatingTotal/months;

  return Object.assign({},base,{
    statementCount:prepared.rows.length,monthsCovered:months,totalDeposits:vfc43Round_(totalDeposits,.01),averageMonthlyDeposits:vfc43Round_(grossMonthly,.01),
    totalWithdrawals:vfc43Round_(totalWithdrawals,.01),depositWithdrawalRatio:totalWithdrawals?vfc43Round_(totalDeposits/totalWithdrawals,.01):0,
    nsfCount:nsf,nsfPerMonth:vfc43Round_(nsf/months,.01),negativeBalanceFlag:negative,mcaPaymentFlag:debt.activeDebtObligations.length?1:0,
    monthlyDeposits:monthlyDeposits,monthlyWithdrawals:monthlyWithdrawals,estimatedOperatingTotalDeposits:vfc43Round_(operatingTotal,.01),
    estimatedOperatingMonthlyDeposits:vfc43Round_(operatingMonthly,.01),detectedFinancingCredits:vfc43Round_(debt.financingCreditsTotal,.01),
    existingMonthlyDebtService:vfc43Round_(debt.confirmedMonthlyDebtService,.01),otherRecurringMonthlyObligations:vfc43Round_(debt.otherRecurringMonthlyObligations,.01),
    debtServiceToDepositsRatio:grossMonthly?vfc43Round_(debt.confirmedMonthlyDebtService/grossMonthly,.0001):0,debtProfile:debt,
    inputQualityAudit:{modelVersion:VFC_BANKING_V43.VERSION,statementAudit:audit,warnings:debt.warnings}
  });
}

function vfc43SelectedRows_(companyName,period){
  const all=vfc43SummaryRows_(companyName,period); if(!all.length)return[];
  const map={};
  all.forEach(function(r){const key=vfc43StatementKey_(r),old=map[key];if(!old||vfc43Time_(r.createdAt)>=vfc43Time_(old.createdAt))map[key]=r;});
  const rows=Object.keys(map).map(function(k){return map[k];});
  rows.sort(function(a,b){return (vfc43Date_(a.endDate)||vfc43Date_(a.startDate)||new Date(0))-(vfc43Date_(b.endDate)||vfc43Date_(b.startDate)||new Date(0));});
  return rows.slice(Math.max(0,rows.length-VFC_BANKING_V43.MAX_STATEMENTS));
}

function vfc43SummaryRows_(companyName,period){
  const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  if(!sh||sh.getLastRow()<2)return[];
  const values=sh.getDataRange().getValues(),headers=values[0].map(vfc43Header_),idx={};
  headers.forEach(function(h,i){idx[h]=i;});
  function val(r,n){const i=idx[vfc43Header_(n)];return i===undefined?'':r[i];}
  const out=[];
  for(let i=1;i<values.length;i++){
    const r=values[i],company=String(val(r,'Company Name')||'').trim(),detected=String(val(r,'Detected Period')||'').trim();
    if(companyName&&!vfc43Same_(company,companyName))continue;
    if(period&&!vfc43Same_(detected,period))continue;
    const signalIndex=idx[vfc43Header_('Possible MCA Or Loan Payments')];
    out.push({rowNumber:i+1,signalColumn:signalIndex===undefined?-1:signalIndex+1,uploadId:String(val(r,'Upload ID')||'').trim(),companyName:company,period:detected,
      fileName:String(val(r,'File Name')||'').trim(),bank:String(val(r,'Bank Name')||'').trim(),startDate:val(r,'Statement Start Date'),endDate:val(r,'Statement End Date'),
      opening:vfc43Nullable_(val(r,'Opening Balance')),closing:vfc43Nullable_(val(r,'Closing Balance')),deposits:vfc43Nullable_(val(r,'Total Deposits')),withdrawals:vfc43Nullable_(val(r,'Total Withdrawals')),
      nsf:vfc43Number_(val(r,'NSF Count')),negative:vfc43Bool_(val(r,'Negative Balance Detected')),signalRaw:String(val(r,'Possible MCA Or Loan Payments')||''),createdAt:val(r,'Created At')});
  }
  return out;
}

function vfc43PrepareRows_(rows){
  const uploads=vfc43UploadIndex_(),sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries'),out=[],errors=[];
  rows.forEach(function(row,index){
    const recent=index>=Math.max(0,rows.length-VFC_BANKING_V43.DEBT_LOOKBACK);
    let payload=vfc43ParsePayload_(row.signalRaw),changed=false;
    try{
      const totals=vfc43Totals_(row); if(!totals.ok)throw new Error('statement totals do not reconcile');
      if(!payload){
        payload={version:44,modelVersion:VFC_BANKING_V43.VERSION,fileName:row.fileName,bankName:row.bank||'Unknown',statementStartDate:vfc43Iso_(row.startDate),statementEndDate:vfc43Iso_(row.endDate),
          openingBalance:totals.opening,closingBalance:totals.closing,totalDeposits:totals.deposits,totalWithdrawals:totals.withdrawals,reconciliationDifference:totals.diff,
          nsfCount:Math.max(0,row.nsf||0),negativeBalanceDetected:!!row.negative,transactionsVerified:!recent,transactions:[],explicitScanVerified:!recent,source:'TOTALS_ONLY'};
        changed=true;
      }
      payload.openingBalance=totals.opening;payload.closingBalance=totals.closing;payload.totalDeposits=totals.deposits;payload.totalWithdrawals=totals.withdrawals;payload.reconciliationDifference=totals.diff;
      payload.statementStartDate=vfc43Iso_(row.startDate)||payload.statementStartDate;payload.statementEndDate=vfc43Iso_(row.endDate)||payload.statementEndDate;
      payload.transactions=vfc43SemanticDedupe_(vfc43NormalizeTransactions_(payload.transactions||[]));

      if(recent && (!payload.explicitScanVerified || Number(payload.version||0)<44)){
        const upload=vfc43ResolveUpload_(row,uploads); if(!upload||!upload.fileId)throw new Error('uploaded PDF file ID not found');
        const text=extractTextFromPdf_(upload.fileId);
        const direct=vfc43DirectExplicitTransactions_(text,payload);
        payload.transactions=vfc43ReplaceExplicitTransactions_(payload.transactions,direct);
        payload.transactionsVerified=true; payload.explicitScanVerified=true; payload.version=44; payload.modelVersion=VFC_BANKING_V43.VERSION;
        payload.source='INTAKE_LEDGER+V44_CONTINUATION_SCAN'; changed=true;
      }
      if(recent && !Array.isArray(payload.transactions)) throw new Error('verified transaction ledger is missing');
      payload.transactions=vfc43SemanticDedupe_(payload.transactions||[]);
      if(changed||String(row.signalRaw||'').indexOf(VFC_BANKING_V43.PREFIX)!==0){
        if(row.signalColumn>0)sh.getRange(row.rowNumber,row.signalColumn).setValue(VFC_BANKING_V43.PREFIX+JSON.stringify(payload));
      }
      out.push({row:row,payload:payload});
    }catch(e){errors.push(row.fileName+': '+String(e&&e.message||e));}
  });
  return{rows:out,errors:errors};
}

function vfc43DirectExplicitTransactions_(text,payload){
  const lines=String(text||'').replace(/\u00a0/g,' ').split(/\r?\n/),out=[];
  let currentDate='';
  for(let i=0;i<lines.length;i++){
    const line=String(lines[i]||'').replace(/\s+/g,' ').trim(); if(!line)continue;
    const dated=vfc43ExtractLineDate_(line,payload);
    if(dated.date) currentDate=dated.date;
    const parsed=vfc43ParseExplicitBody_(dated.body,currentDate); if(parsed)out.push(parsed);
  }
  return vfc43SemanticDedupe_(out);
}

function vfc43ExtractLineDate_(line,payload){
  let m=line.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(.+)$/);
  if(m)return{date:vfc43ActivityDate_(m[1],m[2],payload.statementStartDate,payload.statementEndDate),body:m[3]};
  m=line.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(.+)$/);
  if(m)return{date:vfc43ActivityDate_(m[2],m[1],payload.statementStartDate,payload.statementEndDate),body:m[3]};
  m=line.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
  if(m)return{date:m[1],body:m[2]};
  return{date:'',body:line};
}

function vfc43ParseExplicitBody_(body,date){
  if(!date)return null;
  const upper=String(body||'').toUpperCase();
  const markers=['LOAN PAYMENT','LOAN INTEREST','COMM EQUIP RENT/LSE','COMMERCIAL EQUIP RENT/LSE','EQUIPMENT RENT/LSE','EQUIP RENT/LSE','EQUIPMENT LEASE','EQUIP LEASE','LEASE PAYMENT','EQUIPMENT FINANCE','EQUIPMENT FINANCING','EQUIPMENT RENT','EQUIP RENT'];
  let at=-1;
  markers.forEach(function(marker){const j=upper.indexOf(marker);if(j>=0&&(at<0||j<at))at=j;});
  if(at<0)return null;
  const tail=body.slice(at);
  const amounts=tail.match(/\d{1,3}(?:,\d{3})*\.\d{2}/g); if(!amounts||!amounts.length)return null;
  const amount=vfc43Number_(amounts[0]); if(!(amount>0))return null;
  const pos=tail.indexOf(amounts[0]);
  const description=tail.slice(0,pos).replace(/\s+/g,' ').trim(); if(!description)return null;
  return{date:date,description:description,counterparty:description,direction:'DEBIT',amount:vfc43Round_(amount,.01)};
}

function vfc43ReplaceExplicitTransactions_(existing,direct){
  existing=vfc43NormalizeTransactions_(existing||[]); direct=vfc43SemanticDedupe_(direct||[]);
  if(!direct.length)return vfc43SemanticDedupe_(existing);
  const directFamilies={}; direct.forEach(function(t){directFamilies[vfc43ExplicitFamily_(t.description)]=1;});
  const kept=existing.filter(function(t){const family=vfc43ExplicitFamily_(t.description);return !family||!directFamilies[family];});
  return vfc43SemanticDedupe_(kept.concat(direct));
}

function vfc43ExplicitFamily_(description){
  const d=String(description||'').toUpperCase();
  const loan=vfc43LoanNumber_(d);
  if(/LOAN INTEREST/.test(d))return'LOAN_INTEREST_'+(loan||vfc43EntityKey_(d));
  if(loan)return'LOAN_'+loan;
  if(vfc43IsEquipmentLease_(d))return'EQUIP_LEASE_'+vfc43EntityKey_(d);
  if(/\bEQUIPMENT RENT\b|\bEQUIP RENT\b/.test(d))return'EQUIP_RENT_'+vfc43EntityKey_(d);
  return'';
}

function vfc43ActivityDate_(day,mon,start,end){
  const mm={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11},mi=mm[String(mon||'').toUpperCase()];if(mi===undefined)return'';
  const s=vfc43Date_(start),e=vfc43Date_(end);let y=e?e.getFullYear():(s?s.getFullYear():new Date().getFullYear());
  if(s&&e&&s.getFullYear()!==e.getFullYear()&&mi>=s.getMonth())y=s.getFullYear();
  return vfc43Iso_(new Date(y,mi,Number(day)));
}

function vfc43DebtProfile_(recentRows,allRows){
  const recentTx=vfc43FlattenTransactions_(recentRows),allTx=vfc43FlattenTransactions_(allRows);
  const debtGroups=[],otherGroups=[],genericLoanCredits=[],genericLoanPayments=[];

  recentTx.forEach(function(t){
    const d=String(t.description||'').toUpperCase(); if(!(t.amount>0))return;
    if(t.direction==='CREDIT'){if(/\bLOAN CREDIT\b/.test(d))genericLoanCredits.push(t);return;}
    if(t.direction!=='DEBIT')return;
    if(/^LOAN PAYMENT\b/.test(d)&&!vfc43LoanNumber_(d)){genericLoanPayments.push(t);return;}
    if(/SUPERPASS|HYDRO|FORTIS|GAS BILL|TELUS|ROGERS|PHONE|PAY-FILE|BANK FEE/.test(d))return;
    if(vfc43IsEquipmentLease_(d)){vfc43AddGroup_(debtGroups,t,'DEBT');return;}
    if(/CRA|CCRA|GST|HST|TAX|EMPTX|TXINS|INSURANCE|IPFS|PREMIUM FINANCE|CREDIT CARD|ICBC|OWIC|EQUITABLE LIFE|IND ALL LIFE/.test(d)){vfc43AddGroup_(otherGroups,t,'OTHER');return;}
    if(/\bPAD\b|\bMCA\b|MERCH|MERCHANT|BDC|JOURNEY|ONDECK|LOAN PAYMENT|LOAN INTEREST|FINANC|ADVANCE/.test(d)){vfc43AddGroup_(debtGroups,t,'DEBT');return;}
    if(/\bEQUIPMENT RENT\b|\bEQUIP RENT\b/.test(d))vfc43AddGroup_(otherGroups,t,'OTHER');
  });

  const latestDate=vfc43LatestStatementDate_(recentRows),active=[],newFinancingObserved=[],otherRecurring=[],otherObserved=[];
  debtGroups.forEach(function(g){
    const periods=vfc43DistinctStatementPeriods_(g.items),occ=g.items.length,total=vfc43Sum_(g.items),firstIndex=vfc43FirstStatementIndex_(g.items),denominator=Math.max(1,recentRows.length-firstIndex),last=vfc43LatestDate_(g.items);
    const item=vfc43GroupItem_(g,total/denominator,occ,periods);
    item.active=!latestDate||!last?true:vfc43DaysBetween_(last,latestDate)<=VFC_BANKING_V43.ACTIVE_LOOKBACK_DAYS;
    if(occ>=2&&periods>=2&&item.active)active.push(item);else newFinancingObserved.push(vfc43ObservedItem_(g));
  });
  otherGroups.forEach(function(g){
    const periods=vfc43DistinctStatementPeriods_(g.items),occ=g.items.length;
    if(occ>=2&&periods>=2&&vfc43OtherRecurringEligible_(g)){
      const denominator=Math.max(1,recentRows.length-vfc43FirstStatementIndex_(g.items));
      otherRecurring.push(vfc43GroupItem_(g,vfc43Sum_(g.items)/denominator,occ,periods));
    }else otherObserved.push(vfc43ObservedItem_(g));
  });

  const financingCredits=[];
  allTx.forEach(function(t){if(t.direction==='CREDIT'&&t.amount>0&&vfc43IsFinancingCredit_(t,debtGroups))financingCredits.push(Object.assign({},t,{classification:'FINANCING_CREDIT'}));});
  const creditTotal=financingCredits.reduce(function(s,t){return s+t.amount;},0),confirmed=active.reduce(function(s,x){return s+x.monthlyEquivalent;},0),otherMonthly=otherRecurring.reduce(function(s,x){return s+x.monthlyEquivalent;},0);
  const sweep=genericLoanCredits.length&&genericLoanPayments.length?[{type:'REVOLVING_LOAN_SWEEP',creditOccurrences:genericLoanCredits.length,paymentOccurrences:genericLoanPayments.length,totalCredits:vfc43Round_(vfc43Sum_(genericLoanCredits),.01),totalPayments:vfc43Round_(vfc43Sum_(genericLoanPayments),.01),includedInMonthlyDebt:false}]:[];
  const warnings=[];
  if(sweep.length)warnings.push('Generic LOAN CREDIT/LOAN PAYMENT activity is treated as revolving sweep activity, not fixed monthly debt.');
  if(newFinancingObserved.length)warnings.push('New or insufficient-history financing activity is shown separately and is not converted into recurring monthly debt.');
  if(otherObserved.length)warnings.push('One-off informational payments are retained for audit but excluded from the recurring monthly-obligation total.');
  return{confirmedMonthlyDebtService:vfc43Round_(confirmed,.01),otherRecurringMonthlyObligations:vfc43Round_(otherMonthly,.01),financingCreditsTotal:vfc43Round_(creditTotal,.01),activeDebtObligations:active,otherRecurringObligations:otherRecurring,otherObservedPayments:otherObserved,financingCredits:financingCredits,newFinancingObserved:newFinancingObserved,revolvingFinancingActivity:sweep,warnings:warnings};
}

function vfc43FlattenTransactions_(rows){
  const out=[];
  (rows||[]).forEach(function(x,statementIndex){
    const p=x.payload||{},statementKey=[p.statementStartDate||x.row.startDate||'',p.statementEndDate||x.row.endDate||'',x.row.fileName||''].join('|');
    const tx=vfc43SemanticDedupe_(p.transactions||[]);
    tx.forEach(function(t){out.push(Object.assign({},t,{_statementIndex:statementIndex,_statementKey:statementKey}));});
  });
  return out;
}

function vfc43SemanticDedupe_(items){
  const normalized=vfc43NormalizeTransactions_(items||[]),out=[];
  normalized.forEach(function(t){
    let duplicate=null;
    for(let i=0;i<out.length;i++){
      const old=out[i];
      if(old.direction!==t.direction||old.date!==t.date)continue;
      if(!vfc43AmountsClose_(old.amount,t.amount,0.01,0.05))continue;
      if(vfc43OccurrenceIdentityRelated_(old.description,t.description)){duplicate=old;break;}
    }
    if(!duplicate){out.push(t);return;}
    const aliases=[t.description].concat(Array.isArray(t._aliases)?t._aliases:[]);
    duplicate._aliases=Array.isArray(duplicate._aliases)?duplicate._aliases:[];
    aliases.forEach(function(name){name=vfc43PrintedLabel_(name);if(name&&name!==duplicate.description&&duplicate._aliases.indexOf(name)===-1)duplicate._aliases.push(name);});
  });
  return out;
}

function vfc43OccurrenceIdentityRelated_(left,right){
  const a=String(left||'').toUpperCase(),b=String(right||'').toUpperCase();
  const la=vfc43LoanNumber_(a),lb=vfc43LoanNumber_(b); if(la||lb)return !!la&&la===lb;
  const fa=vfc43ExplicitFamily_(a),fb=vfc43ExplicitFamily_(b); if(fa&&fb&&fa===fb)return true;
  const ca=vfc43CompactName_(a),cb=vfc43CompactName_(b); if(ca&&cb&&(ca===cb||ca.indexOf(cb)>=0||cb.indexOf(ca)>=0))return true;
  return vfc43NameSimilarity_(a,b)>=0.60;
}

function vfc43AddGroup_(groups,t,type){
  const identity=vfc43Identity_(t,type); let group=null;
  for(let i=0;i<groups.length;i++){
    if(vfc43GroupMatches_(groups[i],identity,t)){group=groups[i];break;}
  }
  if(!group){group={type:type,strongKey:identity.strongKey||'',entityKey:identity.entityKey||'',items:[],names:[]};groups.push(group);}
  const duplicate=group.items.some(function(old){return old.date===t.date&&old.direction===t.direction&&vfc43AmountsClose_(old.amount,t.amount,0.01,0.05);});
  if(!duplicate)group.items.push(t);
  const labels=[t.description].concat(Array.isArray(t._aliases)?t._aliases:[]);
  labels.forEach(function(name){const printed=vfc43PrintedLabel_(name);if(printed&&group.names.indexOf(printed)===-1)group.names.push(printed);});
}

function vfc43GroupMatches_(group,identity,t){
  if(group.strongKey&&identity.strongKey)return group.strongKey===identity.strongKey;
  if(group.strongKey||identity.strongKey)return false;
  if(!group.items.length)return false;
  const reference=vfc43Median_(group.items.map(function(x){return x.amount;}).sort(function(a,b){return a-b;}));
  if(!vfc43AmountsClose_(reference,t.amount,VFC_BANKING_V43.AMOUNT_MATCH_PERCENT,VFC_BANKING_V43.AMOUNT_MATCH_DOLLARS))return false;
  if(group.entityKey&&identity.entityKey&&(group.entityKey===identity.entityKey||group.entityKey.indexOf(identity.entityKey)>=0||identity.entityKey.indexOf(group.entityKey)>=0))return true;
  return vfc43NameSimilarity_(group.names.join(' '),t.description)>=0.50;
}

function vfc43Identity_(t,type){
  const d=String(t.description||'').toUpperCase(),loan=vfc43LoanNumber_(d);
  if(/LOAN INTEREST/.test(d))return{strongKey:'LOAN_INTEREST_'+(loan||vfc43EntityKey_(d)),entityKey:'LOAN_INTEREST_'+(loan||vfc43EntityKey_(d))};
  if(loan)return{strongKey:'LOAN_'+loan,entityKey:'LOAN_'+loan};
  if(type==='DEBT'){
    if(/MERCH|MERCHANT/.test(d))return{strongKey:'MERCHANT',entityKey:'MERCHANT'};
    if(/\bBDC\b/.test(d))return{strongKey:'BDC',entityKey:'BDC'};
    if(/JOURNEY|ONDECK/.test(d))return{strongKey:'JOURNEY_ONDECK',entityKey:'JOURNEYONDECK'};
    if(vfc43IsEquipmentLease_(d))return{strongKey:'',entityKey:vfc43EntityKey_(d)};
  }
  const tax=vfc43TaxKey_(d); if(tax)return{strongKey:tax,entityKey:tax};
  return{strongKey:'',entityKey:vfc43EntityKey_(d)};
}

function vfc43GroupItem_(group,monthly,occ,periods){
  const vals=group.items.map(function(t){return t.amount;}).sort(function(a,b){return a-b;}),dates=group.items.map(function(t){return t.date;}).sort();
  const label=group.names.length?group.names.join(' / '):vfc43PrintedLabel_(group.items[0]&&group.items[0].description||'Detected obligation');
  return{counterparty:label,description:label,printedDescriptions:group.names.slice(),category:group.type,paymentAmount:vfc43Round_(vfc43Median_(vals),.01),frequency:'Observed cash flow',monthlyEquivalent:vfc43Round_(monthly,.01),occurrences:occ,monthsObserved:periods,statementPeriodsObserved:periods,firstSeen:dates[0]||'',lastSeen:dates.length?dates[dates.length-1]:'',active:true,confidence:(occ>=3&&periods>=2)?'High':'Moderate'};
}

function vfc43ObservedItem_(group){
  const vals=group.items.map(function(t){return t.amount;}).sort(function(a,b){return a-b;}),dates=group.items.map(function(t){return t.date;}).sort(),periods=vfc43DistinctStatementPeriods_(group.items);
  const label=group.names.length?group.names.join(' / '):vfc43PrintedLabel_(group.items[0]&&group.items[0].description||'Detected obligation');
  return{counterparty:label,description:label,printedDescriptions:group.names.slice(),category:group.type,observedAmount:vfc43Round_(vfc43Sum_(group.items),.01),paymentAmount:vfc43Round_(vfc43Median_(vals),.01),monthlyEquivalent:0,occurrences:group.items.length,monthsObserved:periods,statementPeriodsObserved:periods,firstSeen:dates[0]||'',lastSeen:dates.length?dates[dates.length-1]:'',recurring:false,confidence:group.items.length>=2?'Moderate':'Observed once'};
}

function vfc43OtherRecurringEligible_(group){return group.strongKey!=='TAX_UNSPECIFIED';}

function vfc43IsFinancingCredit_(t,debtGroups){
  const d=String(t.description||'').toUpperCase();
  if(/\bLOAN CREDIT\b/.test(d))return true;
  if(/\b(LOAN ADVANCE|LOAN PROCEEDS|CASH ADVANCE|MCA ADVANCE|FUNDING|FINANCING ADVANCE|CSBFL ADVANCE)\b/.test(d))return true;
  if(/\bCREDIT MEMO\b/.test(d)&&/\b(CLIENT REQUEST|RETURN|TRF|TRANSFER|INTERNAL)\b/.test(d))return false;
  for(let i=0;i<(debtGroups||[]).length;i++){
    const g=debtGroups[i];
    if(g.names.some(function(name){return vfc43NameSimilarity_(name,t.description)>=0.55;}))return true;
  }
  if(/\bLOAN\b/.test(d)&&!/\b(RETURN|TRF|TRANSFER|CLIENT REQUEST)\b/.test(d))return true;
  return false;
}

function vfc43IsEquipmentLease_(description){
  const d=String(description||'').toUpperCase();
  return /\bEQUIP(?:MENT)?\s+RENT\/LSE\b/.test(d)||/\bEQUIP(?:MENT)?\s+LEASE\b/.test(d)||/\bLEASE\s+PAYMENT\b/.test(d)||/\bEQUIPMENT\s+FINANC(?:E|ING)\b/.test(d)||/\bEQUIP\s+FINANC(?:E|ING)\b/.test(d);
}

function vfc43LoanNumber_(description){
  const d=String(description||'').toUpperCase();
  const m=d.match(/(?:NO\.?|NUMBER|#|LOAN:)\s*([0-9]{5,})/)||d.match(/LOAN\s+PAYMENT\s+([0-9]{5,})/);
  return m?m[1]:'';
}

function vfc43TaxKey_(d){
  let m=d.match(/GST[- ]?P\s*(\d{4,})?/);if(m)return'TAX_GSTP_'+(m[1]||'UNSPECIFIED');
  m=d.match(/EMPTX\s*(\d{4,})?/);if(m)return'TAX_EMPTX_'+(m[1]||'UNSPECIFIED');
  m=d.match(/TXINS\s*(\d{4,})?/);if(m)return'TAX_TXINS_'+(m[1]||'UNSPECIFIED');
  if(/COMMERCIAL TAXES|\bTAX\b|CRA|CCRA|HST/.test(d))return'TAX_UNSPECIFIED';
  return'';
}

function vfc43EntityKey_(description){
  const stop={BUSINESS:1,INVESTMENT:1,PAD:1,PAYMENT:1,PAY:1,LOAN:1,CREDIT:1,DEBIT:1,FINANCING:1,FINANCE:1,INTEREST:1,ADVANCE:1,FUNDING:1,FUND:1,CAPITAL:1,DIRECT:1,DEPOSIT:1,MISC:1,EFT:1,PREAUTHORIZED:1,PREAUTH:1,TRANSFER:1,ONLINE:1,BANKING:1,CLIENT:1,REQUEST:1,RETURN:1,TRF:1,COMM:1,COMMERCIAL:1,EQUIP:1,EQUIPMENT:1,RENT:1,LSE:1,LEASE:1,NO:1,NUMBER:1};
  const tokens=String(description||'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim().split(/\s+/).filter(function(x){return x&&x.length>=3&&!stop[x]&&!/^\d+$/.test(x);});
  return tokens.join('').substring(0,80);
}

function vfc43CompactName_(description){return vfc43EntityKey_(description);}
function vfc43NameSimilarity_(left,right){
  const a=vfc43EntityTokens_(left),b=vfc43EntityTokens_(right); if(!a.length||!b.length)return 0;
  let matched=0;
  a.forEach(function(x){if(b.some(function(y){return x===y||(x.length>=4&&y.length>=4&&(x.indexOf(y)===0||y.indexOf(x)===0));}))matched++;});
  const tokenScore=matched/Math.max(a.length,b.length);
  const ca=a.join(''),cb=b.join(''); const compactScore=(ca&&cb&&(ca===cb||ca.indexOf(cb)>=0||cb.indexOf(ca)>=0))?1:0;
  return Math.max(tokenScore,compactScore);
}
function vfc43EntityTokens_(description){
  const generic={BUSINESS:1,INVESTMENT:1,PAD:1,PAYMENT:1,PAY:1,LOAN:1,CREDIT:1,DEBIT:1,FINANCING:1,FINANCE:1,INTEREST:1,ADVANCE:1,FUNDING:1,FUND:1,CAPITAL:1,DIRECT:1,DEPOSIT:1,MISC:1,EFT:1,PREAUTHORIZED:1,PREAUTH:1,TRANSFER:1,ONLINE:1,BANKING:1,COMM:1,COMMERCIAL:1,EQUIP:1,EQUIPMENT:1,RENT:1,LSE:1,LEASE:1,NO:1,NUMBER:1};
  return String(description||'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim().split(/\s+/).filter(function(x){return x&&x.length>=3&&!generic[x]&&!/^\d+$/.test(x);});
}

function vfc43PrintedLabel_(description){return String(description||'').replace(/\s+/g,' ').trim();}
function vfc43AmountsClose_(a,b,pct,dollars){a=vfc43Number_(a);b=vfc43Number_(b);const tol=Math.max(dollars||0,Math.max(a,b)*(pct||0));return Math.abs(a-b)<=tol;}
function vfc43DistinctStatementPeriods_(items){const s={};(items||[]).forEach(function(t){if(t._statementKey)s[t._statementKey]=1;else if(t._statementIndex!==undefined)s[String(t._statementIndex)]=1;else if(/^\d{4}-\d{2}/.test(t.date))s[t.date.slice(0,7)]=1;});return Object.keys(s).length;}
function vfc43FirstStatementIndex_(items){let first=null;(items||[]).forEach(function(t){const i=Number(t._statementIndex);if(!isFinite(i))return;if(first===null||i<first)first=i;});return first===null?0:first;}
function vfc43LatestStatementDate_(rows){let latest=null;(rows||[]).forEach(function(x){const d=vfc43Date_(x.payload.statementEndDate||x.row.endDate);if(d&&(!latest||d>latest))latest=d;});return latest?vfc43Iso_(latest):'';}
function vfc43LatestDate_(items){const dates=(items||[]).map(function(t){return vfc43Date_(t.date);}).filter(Boolean).sort(function(a,b){return a-b;});return dates.length?vfc43Iso_(dates[dates.length-1]):'';}
function vfc43DaysBetween_(a,b){const x=vfc43Date_(a),y=vfc43Date_(b);if(!x||!y)return 0;return Math.abs(y-x)/(1000*60*60*24);}
function vfc43Sum_(items){return (items||[]).reduce(function(s,t){return s+vfc43Number_(t.amount);},0);}

function vfc43NormalizeTransactions_(items){
  if(!Array.isArray(items))return[];const out=[];
  items.forEach(function(x){
    x=x||{};const date=vfc43Iso_(x.date),desc=String(x.description||'').replace(/\s+/g,' ').trim(),dir=String(x.direction||'').toUpperCase(),amount=vfc43Positive_(x.amount);if(!date||!desc||(dir!=='DEBIT'&&dir!=='CREDIT')||!(amount>0))return;
    const t={date:date,description:desc.substring(0,240),counterparty:String(x.counterparty||desc).replace(/\s+/g,' ').trim().substring(0,140),direction:dir,amount:vfc43Round_(amount,.01)};
    const aliases=Array.isArray(x._aliases)?x._aliases:(Array.isArray(x.printedDescriptions)?x.printedDescriptions:[]);
    if(aliases.length)t._aliases=aliases.map(vfc43PrintedLabel_).filter(Boolean);
    out.push(t);
  });
  return out;
}

function vfc43Totals_(r){const o=r.opening,c=r.closing,d=r.deposits,w=r.withdrawals;if(o===null||c===null||d===null||w===null||!(d>=0)||!(w>=0))return{ok:false};const diff=vfc43Round_((o+d-w)-c,.01);return{ok:Math.abs(diff)<=VFC_BANKING_V43.RECONCILE_TOLERANCE,opening:o,closing:c,deposits:d,withdrawals:w,diff:diff};}
function vfc43ParsePayload_(raw){raw=String(raw||'').trim();const prefixes=[VFC_BANKING_V43.PREFIX].concat(VFC_BANKING_V43.LEGACY_PREFIXES);for(let i=0;i<prefixes.length;i++){if(raw.indexOf(prefixes[i])!==0)continue;try{return JSON.parse(raw.slice(prefixes[i].length));}catch(e){return null;}}return null;}
function vfc43UploadIndex_(){const rows=typeof getSheetObjects_==='function'?getSheetObjects_('Uploads'):[],idx={byId:{},byCompanyFile:{},byFile:{}};rows.forEach(function(r){let fileId=String(r.fileId||'').trim(),link=String(r.fileLink||'').trim();if(!fileId&&link){const m=link.match(/[-\w]{20,}/);if(m)fileId=m[0];}if(!fileId)return;const item={fileId:fileId,createdAt:r.createdAt||''},uploadId=String(r.uploadId||'').trim(),cf=vfc43Norm_(r.companyName)+'|'+vfc43Norm_(r.fileName),f=vfc43Norm_(r.fileName);if(uploadId)idx.byId[uploadId]=item;vfc43KeepNewest_(idx.byCompanyFile,cf,item);vfc43KeepNewest_(idx.byFile,f,item);});return idx;}
function vfc43ResolveUpload_(r,idx){return idx.byId[r.uploadId]||idx.byCompanyFile[vfc43Norm_(r.companyName)+'|'+vfc43Norm_(r.fileName)]||idx.byFile[vfc43Norm_(r.fileName)]||null;}
function vfc43KeepNewest_(map,key,item){if(!key)return;const old=map[key];if(!old||vfc43Time_(item.createdAt)>=vfc43Time_(old.createdAt))map[key]=item;}
function vfc43Request_(x,p){if(typeof x==='string')return{companyName:String(x).trim(),period:String(p||'').trim()};x=x||{};return{companyName:String(x.companyName||x.company||'').trim(),period:String(x.period||p||'').trim()};}
function vfc43StatementKey_(r){const s=vfc43Iso_(r.startDate),e=vfc43Iso_(r.endDate);return s&&e?s+'|'+e:vfc43Norm_(r.fileName);}
function vfc43Header_(v){return String(v||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'');}
function vfc43Same_(a,b){return vfc43Norm_(a)===vfc43Norm_(b);}
function vfc43Norm_(v){return String(v||'').trim().toLowerCase().replace(/\s+/g,' ');}
function vfc43Nullable_(v){if(v===null||v===undefined||String(v).trim()==='')return null;const n=vfc43Number_(v);return isFinite(n)?n:null;}
function vfc43Number_(v){if(typeof v==='number')return isFinite(v)?v:0;const n=parseFloat(String(v||'').replace(/[^0-9.\-]/g,''));return isFinite(n)?n:0;}
function vfc43Positive_(v){return Math.max(0,vfc43Number_(v));}
function vfc43Bool_(v){return /yes|true|detected|negative|1/i.test(String(v||''));}
function vfc43Round_(v,step){step=step||1;return Math.round((Number(v)||0)/step)*step;}
function vfc43Date_(v){if(!v)return null;const d=new Date(v);return isNaN(d.getTime())?null:d;}
function vfc43Iso_(v){const d=vfc43Date_(v);if(!d)return'';return Utilities.formatDate(d,Session.getScriptTimeZone(),'yyyy-MM-dd');}
function vfc43Time_(v){const d=vfc43Date_(v);return d?d.getTime():0;}
function vfc43Median_(a){if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
