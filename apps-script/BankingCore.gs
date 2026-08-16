/**
 * VFC Banking Core 3.0
 * Shared, bank-agnostic banking math.
 *
 * Important design rule:
 * - A bank file reads/classifies that bank.
 * - This file only stores frozen facts, finds recurrence, calculates monthly
 *   equivalents, links financing credits, and produces deterministic output.
 * - It does not re-read a PDF during underwriting.
 */
const VFC_BANK_ENGINE = {
  VERSION:'VFC-BANKING-CORE-3.0',
  FACTS_VERSION:'VFC-BANK-FACTS-1.0',
  CACHE_PREFIX:'VFC_BANK_FACTS_V1:',
  LEGACY_PREFIXES:[
    'VFC_BANK_PURE_V46:','VFC_BANK_PURE_V45:','VFC_BANK_PURE_V44:',
    'VFC_BANK_PURE_V43:','VFC_BANK_PURE_V42:','VFC_BANK_PURE_V41:',
    'VFC_BANK_PURE_V40:','VFC_BANK_PURE_V35:','VFC_BANK_PURE_V34:',
    'VFC_BANK_PURE_V1:'
  ],
  MAX_STATEMENTS:12,
  DEBT_LOOKBACK:6,
  ACTIVE_DAYS:75,
  RECONCILE_TOLERANCE:5
};
const VFC_BANK_SIMPLE = VFC_BANK_ENGINE;

function getBankingInputQualityStatus(){
  return {
    modelVersion:VFC_BANK_ENGINE.VERSION,
    factsVersion:VFC_BANK_ENGINE.FACTS_VERSION,
    deterministic:true,
    pdfReReadDuringUnderwriting:false,
    frozenStatementFacts:true,
    architecture:'BankingCore + BankRouter + one isolated file per bank',
    banks:getBankParserTabs()
  };
}

function vfcBankCreateIntakePayload_(summary,fileName){
  summary=summary||{};
  const opening=vfcNumNull_(summary.opening_balance);
  const closing=vfcNumNull_(summary.closing_balance);
  const deposits=vfcNumNull_(summary.total_deposits);
  const withdrawals=vfcNumNull_(summary.total_withdrawals);
  const diff=(opening!==null&&closing!==null&&deposits!==null&&withdrawals!==null)
    ? vfcRound_((opening+deposits-withdrawals)-closing,.01):null;
  const bankName=String(summary.bank_name||'Unknown');
  const payload={
    version:3,
    extractionVersion:VFC_BANK_ENGINE.FACTS_VERSION,
    fileName:String(fileName||''),
    bankId:vfcDetectBankId_(bankName),
    bankName:bankName,
    statementStartDate:vfcIso_(summary.statement_start_date),
    statementEndDate:vfcIso_(summary.statement_end_date),
    openingBalance:opening,
    closingBalance:closing,
    totalDeposits:deposits,
    totalWithdrawals:withdrawals,
    reconciliationDifference:diff,
    nsfCount:Math.max(0,vfcNum_(summary.nsf_count)),
    negativeBalanceDetected:vfcBool_(summary.negative_balance_detected),
    transactionsVerified:true,
    transactions:vfcNormalizeTransactions_(summary.banking_transactions||[])
  };
  return VFC_BANK_ENGINE.CACHE_PREFIX+JSON.stringify(payload);
}

function getValidatedBankingFeatures_(companyName,period){
  const base=vfcBaseFeatures_(companyName,period);
  if(!base)return null;
  const rows=vfcSelectedStatementRows_(companyName,period);
  if(!rows.length)return base;
  const prepared=[],errors=[];
  rows.forEach(function(row){
    const payload=vfcCanonicalPayloadForRow_(row,rows);
    if(!payload){errors.push(row.fileName+': no frozen transaction ledger found; re-upload this statement once.');return;}
    const check=vfcReconcilePayload_(payload,row);
    if(!check.ok){errors.push(row.fileName+': statement totals do not reconcile.');return;}
    prepared.push({row:row,payload:payload});
  });
  if(errors.length)throw new Error('Unable to verify uploaded bank statement(s): '+errors.join(' | '));
  return vfcBuildBankingFeatures_(base,prepared);
}

function refreshDebtSignalsForPeriodSafe(companyOrRequest,requestedPeriod){
  try{
    const req=vfcRequest_(companyOrRequest,requestedPeriod);
    const period=req.period||(typeof resolveLatestAssessmentPeriod_==='function'?resolveLatestAssessmentPeriod_(req.companyName,req.period):req.period);
    const f=getValidatedBankingFeatures_(req.companyName,period);
    if(!f)throw new Error('No banking features found.');
    return {
      ok:true,modelVersion:VFC_BANK_ENGINE.VERSION,resultFingerprint:f.resultFingerprint||'',companyName:req.companyName,period:period,
      bankTabs:getBankParserTabs(),debtProfile:f.debtProfile||{},inputQualityAudit:f.inputQualityAudit||{},
      bankingFeatures:{averageMonthlyDeposits:f.averageMonthlyDeposits||0,estimatedOperatingMonthlyDeposits:f.estimatedOperatingMonthlyDeposits||0,existingMonthlyDebtService:f.existingMonthlyDebtService||0,informationalRecurringMonthlyObligations:f.informationalRecurringMonthlyObligations||0,detectedFinancingCredits:f.detectedFinancingCredits||0},errors:[]
    };
  }catch(e){return {ok:false,modelVersion:VFC_BANK_ENGINE.VERSION,errors:[String(e&&e.message||e)]};}
}

function refreshLatestDebtSignals(){
  const rows=vfcSummaryRows_('','');
  if(!rows.length)throw new Error('No bank statements found.');
  rows.sort(function(a,b){return vfcTime_(a.createdAt)-vfcTime_(b.createdAt);});
  const last=rows[rows.length-1];
  return refreshDebtSignalsForPeriodSafe({companyName:last.companyName,period:last.period});
}
function diagnoseLatestBankingInputs(){return refreshLatestDebtSignals();}

function vfcSummaryRows_(companyName,period){
  const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  if(!sh||sh.getLastRow()<2)return[];
  const values=sh.getDataRange().getValues(),headers=values[0].map(vfcHeader_),idx={};headers.forEach(function(h,i){idx[h]=i;});
  function val(r,n){const i=idx[vfcHeader_(n)];return i===undefined?'':r[i];}
  const out=[];
  for(let i=1;i<values.length;i++){
    const r=values[i],company=String(val(r,'Company Name')||'').trim(),detected=String(val(r,'Detected Period')||'').trim();
    if(companyName&&!vfcSame_(company,companyName))continue;if(period&&!vfcSame_(detected,period))continue;
    out.push({rowNumber:i+1,uploadId:String(val(r,'Upload ID')||'').trim(),companyName:company,period:detected,fileName:String(val(r,'File Name')||'').trim(),bank:String(val(r,'Bank Name')||'').trim(),startDate:val(r,'Statement Start Date'),endDate:val(r,'Statement End Date'),opening:vfcNumNull_(val(r,'Opening Balance')),closing:vfcNumNull_(val(r,'Closing Balance')),deposits:vfcNumNull_(val(r,'Total Deposits')),withdrawals:vfcNumNull_(val(r,'Total Withdrawals')),nsf:vfcNum_(val(r,'NSF Count')),negative:vfcBool_(val(r,'Negative Balance Detected')),signalRaw:String(val(r,'Possible MCA Or Loan Payments')||''),createdAt:val(r,'Created At')});
  }
  return out;
}

function vfcSelectedStatementRows_(companyName,period){
  const all=vfcSummaryRows_(companyName,period),map={};
  all.forEach(function(r){const key=vfcStatementFingerprint_(r),old=map[key];if(!old||vfcTime_(r.createdAt)>vfcTime_(old.createdAt))map[key]=r;});
  const rows=Object.keys(map).map(function(k){return map[k];});
  rows.sort(function(a,b){return vfcTime_(a.endDate)-vfcTime_(b.endDate)||String(a.fileName).localeCompare(String(b.fileName));});
  return rows.slice(Math.max(0,rows.length-VFC_BANK_ENGINE.MAX_STATEMENTS));
}

function vfcStatementFingerprint_(r){return [String(r.bank||'').toUpperCase(),vfcIso_(r.startDate),vfcIso_(r.endDate),vfcRound_(vfcNum_(r.opening),.01),vfcRound_(vfcNum_(r.closing),.01),vfcRound_(vfcNum_(r.deposits),.01),vfcRound_(vfcNum_(r.withdrawals),.01)].join('|');}

function vfcCanonicalPayloadForRow_(row,allRows){
  const exact=vfcParseBankCache_(row.signalRaw);if(vfcPayloadUsable_(exact))return vfcNormalizePayload_(exact,row);
  const fp=vfcStatementFingerprint_(row);
  const candidates=(allRows||[]).filter(function(x){return vfcStatementFingerprint_(x)===fp;}).sort(function(a,b){return vfcTime_(a.createdAt)-vfcTime_(b.createdAt);});
  for(let i=0;i<candidates.length;i++){const p=vfcParseBankCache_(candidates[i].signalRaw);if(vfcPayloadUsable_(p))return vfcNormalizePayload_(p,row);}
  return null;
}

function vfcParseBankCache_(raw){
  const s=String(raw||''),prefixes=[VFC_BANK_ENGINE.CACHE_PREFIX].concat(VFC_BANK_ENGINE.LEGACY_PREFIXES);
  for(let i=0;i<prefixes.length;i++){if(s.indexOf(prefixes[i])!==0)continue;try{return JSON.parse(s.slice(prefixes[i].length));}catch(e){return null;}}
  return null;
}
function vfcPayloadUsable_(p){return !!(p&&p.transactionsVerified&&Array.isArray(p.transactions)&&vfcNumNull_(p.totalDeposits)!==null&&vfcNumNull_(p.totalWithdrawals)!==null);}

function vfcNormalizePayload_(p,row){
  return {version:3,extractionVersion:VFC_BANK_ENGINE.FACTS_VERSION,fileName:String(p.fileName||row.fileName||''),bankId:String(p.bankId||vfcDetectBankId_(p.bankName||row.bank||'')),bankName:String(p.bankName||row.bank||'Unknown'),statementStartDate:vfcIso_(p.statementStartDate||row.startDate),statementEndDate:vfcIso_(p.statementEndDate||row.endDate),openingBalance:vfcNumNull_(p.openingBalance),closingBalance:vfcNumNull_(p.closingBalance),totalDeposits:vfcPos_(p.totalDeposits),totalWithdrawals:vfcPos_(p.totalWithdrawals),reconciliationDifference:vfcNum_(p.reconciliationDifference),nsfCount:Math.max(0,vfcNum_(p.nsfCount||row.nsf)),negativeBalanceDetected:!!(p.negativeBalanceDetected||row.negative),transactionsVerified:true,transactions:vfcNormalizeTransactions_(p.transactions||[])};
}
function vfcReconcilePayload_(p,row){
  const opening=p.openingBalance!==null?p.openingBalance:row.opening,closing=p.closingBalance!==null?p.closingBalance:row.closing,deposits=p.totalDeposits,withdrawals=p.totalWithdrawals;
  if(opening===null||closing===null||deposits===null||withdrawals===null)return{ok:false};const diff=Math.abs((opening+deposits-withdrawals)-closing);return{ok:diff<=VFC_BANK_ENGINE.RECONCILE_TOLERANCE,diff:diff};
}
function vfcNormalizeTransactions_(items){
  const out=[],seen={};(Array.isArray(items)?items:[]).forEach(function(x){const date=vfcIso_(x.date),desc=String(x.description||'').replace(/\s+/g,' ').trim(),direction=String(x.direction||'').toUpperCase(),amount=vfcPos_(x.amount);if(!date||!desc||(direction!=='DEBIT'&&direction!=='CREDIT')||!(amount>0))return;const t={date:date,description:desc.substring(0,220),counterparty:String(x.counterparty||desc).replace(/\s+/g,' ').trim().substring(0,140),direction:direction,amount:vfcRound_(amount,.01)};const key=[t.date,t.direction,t.amount,t.description.toUpperCase()].join('|');if(!seen[key]){seen[key]=1;out.push(t);}});
  out.sort(function(a,b){return vfcTime_(a.date)-vfcTime_(b.date)||a.direction.localeCompare(b.direction)||a.amount-b.amount||a.description.localeCompare(b.description);});return out;
}

function vfcBuildBankingFeatures_(base,rows){
  let totalDeposits=0,totalWithdrawals=0,nsf=0,negative=0;const monthlyDeposits=[],monthlyWithdrawals=[],audit=[];
  rows.forEach(function(x){const p=x.payload;totalDeposits+=p.totalDeposits;totalWithdrawals+=p.totalWithdrawals;monthlyDeposits.push(p.totalDeposits);monthlyWithdrawals.push(p.totalWithdrawals);nsf+=p.nsfCount||0;if(p.negativeBalanceDetected)negative=1;audit.push({fileName:x.row.fileName,bankId:p.bankId,bank:p.bankName,start:p.statementStartDate,end:p.statementEndDate,totalDeposits:p.totalDeposits,totalWithdrawals:p.totalWithdrawals,reconciliationDifference:p.reconciliationDifference,transactionsVerified:true});});
  const recent=rows.slice(Math.max(0,rows.length-VFC_BANK_ENGINE.DEBT_LOOKBACK)),debt=vfcDebtProfile_(recent),months=Math.max(1,rows.length),grossMonthly=totalDeposits/months,operatingTotal=Math.max(0,totalDeposits-debt.financingCreditsTotal);
  const result=Object.assign({},base,{statementCount:rows.length,monthsCovered:rows.length,totalDeposits:vfcRound_(totalDeposits,.01),averageMonthlyDeposits:vfcRound_(grossMonthly,.01),totalWithdrawals:vfcRound_(totalWithdrawals,.01),depositWithdrawalRatio:totalWithdrawals?vfcRound_(totalDeposits/totalWithdrawals,.01):0,nsfCount:nsf,nsfPerMonth:vfcRound_(nsf/months,.01),negativeBalanceFlag:negative,mcaPaymentFlag:debt.activeDebtObligations.length?1:0,monthlyDeposits:monthlyDeposits,monthlyWithdrawals:monthlyWithdrawals,estimatedOperatingTotalDeposits:vfcRound_(operatingTotal,.01),estimatedOperatingMonthlyDeposits:vfcRound_(operatingTotal/months,.01),detectedFinancingCredits:vfcRound_(debt.financingCreditsTotal,.01),existingMonthlyDebtService:vfcRound_(debt.confirmedMonthlyDebtService,.01),informationalRecurringMonthlyObligations:vfcRound_(debt.informationalMonthlyObligations,.01),otherRecurringMonthlyObligations:vfcRound_(debt.informationalMonthlyObligations,.01),debtServiceToDepositsRatio:grossMonthly?vfcRound_(debt.confirmedMonthlyDebtService/grossMonthly,.0001):0,debtProfile:debt,inputQualityAudit:{modelVersion:VFC_BANK_ENGINE.VERSION,verified:true,statementAudit:audit,warnings:debt.warnings}});
  result.resultFingerprint=vfcResultFingerprint_(result);result.inputQualityAudit.resultFingerprint=result.resultFingerprint;return result;
}

function vfcDebtProfile_(rows){
  let tx=[],latest='';rows.forEach(function(x){if(!latest||vfcTime_(x.payload.statementEndDate)>vfcTime_(latest))latest=x.payload.statementEndDate;(x.payload.transactions||[]).forEach(function(t){tx.push(Object.assign({bankId:x.payload.bankId||'UNKNOWN'},t));});});
  tx=vfcDedupeTx_(tx);const debits=tx.filter(function(t){return t.direction==='DEBIT';}),credits=tx.filter(function(t){return t.direction==='CREDIT';}),classified=debits.map(function(t){return vfcClassifyDebitForBank_(t.bankId,t);}).filter(Boolean),groups={};
  classified.forEach(function(t){const key=t.family+'|'+t.entityKey;if(!groups[key])groups[key]={family:t.family,entityKey:t.entityKey,label:t.label,items:[]};groups[key].items.push(t);});
  let summaries=Object.keys(groups).sort().map(function(k){return vfcSummarizeGroup_(groups[k],latest);}).filter(Boolean);summaries=vfcMergeGenericAmountMatches_(summaries);
  const hasSweep=credits.filter(function(c){return /\bLOAN\s+CREDIT\b/i.test(c.description);}).length>=2,active=[],revolving=[],tax=[],other=[],inactive=[],once=[];
  summaries.forEach(function(g){if(hasSweep&&g.entityKey==='GENERIC_LOAN_PAYMENT'){revolving.push(g);return;}if(!g.recurring){once.push(g);return;}if(g.family==='FINANCING'||g.family==='MCA'||g.family==='PAD'){if(g.active)active.push(g);else once.push(g);}else if(g.family==='TAX'){if(g.active)tax.push(g);else inactive.push(g);}else{if(g.active)other.push(g);else inactive.push(g);}});
  const financing=vfcFinancingCredits_(credits,classified);active.sort(vfcObligationSort_);tax.sort(vfcObligationSort_);other.sort(vfcObligationSort_);const confirmed=active.reduce(function(s,x){return s+x.monthlyEquivalent;},0),info=tax.concat(other).reduce(function(s,x){return s+x.monthlyEquivalent;},0),warnings=[];
  if(revolving.length)warnings.push('Generic revolving loan sweep activity is excluded from fixed monthly debt.');if(inactive.length)warnings.push('Stale informational obligations are retained without a fabricated monthly equivalent.');if(financing.possible.length)warnings.push('Possible financing credits are shown separately and are not removed from operating deposits unless confirmed.');
  return {confirmedMonthlyDebtService:vfcRound_(confirmed,.01),informationalMonthlyObligations:vfcRound_(info,.01),activeDebtObligations:active,revolvingFinancingActivity:revolving,taxGovernmentPads:tax,otherRecurringObligations:other,inactiveInformationalObligations:inactive,observedOnce:once,allDetectedObligations:summaries,financingCredits:financing.confirmed,possibleFinancingCredits:financing.possible,financingCreditsTotal:vfcRound_(financing.total,.01),warnings:warnings};
}

function vfcSummarizeGroup_(g,latestEnd){
  const items=(g.items||[]).slice().sort(function(a,b){return vfcTime_(a.date)-vfcTime_(b.date);});if(!items.length)return null;const amounts=items.map(function(x){return x.amount;}),months={};items.forEach(function(x){const m=x.date.slice(0,7);months[m]=(months[m]||0)+x.amount;});const monthKeys=Object.keys(months).sort(),distinct=monthKeys.length,occ=items.length,gaps=[];for(let i=1;i<items.length;i++)gaps.push((vfcDate_(items[i].date)-vfcDate_(items[i-1].date))/86400000);const medianGap=gaps.length?vfcMedian_(gaps):0,median=vfcMedian_(amounts),cv=vfcCv_(amounts),weeklyRatio=gaps.length?gaps.filter(function(x){return x>=5&&x<=10;}).length/gaps.length:0,biweeklyRatio=gaps.length?gaps.filter(function(x){return x>10&&x<=18;}).length/gaps.length:0,recurring=distinct>=2||occ>=3,daysSince=vfcDays_(items[items.length-1].date,latestEnd),active=daysSince===null?true:daysSince<=VFC_BANK_ENGINE.ACTIVE_DAYS;let frequency='Observed statement-period cash flow',monthly=0,method='OBSERVED_ONLY';
  if(recurring&&medianGap>=5&&medianGap<=10&&occ>=4&&weeklyRatio>=.65){frequency='Weekly observed cadence';monthly=median*52/12;method='WEEKLY_MEDIAN';}else if(recurring&&medianGap>10&&medianGap<=18&&occ>=3&&biweeklyRatio>=.55){frequency='Biweekly observed cadence';monthly=median*26/12;method='BIWEEKLY_MEDIAN';}else if(recurring&&distinct>=2&&occ===distinct){frequency='Monthly observed cadence';monthly=cv<=.03?median:vfcMeanObject_(months);method=cv<=.03?'MONTHLY_MEDIAN':'MONTHLY_VARIABLE_MEAN';}else if(recurring){frequency='Multiple payments per month';monthly=vfcRecentMonthAverage_(months,3);method='RECENT_3_MONTH_AVERAGE';}
  if(!active&&g.family!=='FINANCING'&&g.family!=='MCA'&&g.family!=='PAD'){monthly=0;method='STALE_INFORMATIONAL';}
  return {family:g.family,key:g.entityKey,entityKey:g.entityKey,counterparty:g.label,description:g.label,category:g.family==='FINANCING'?'LOAN':g.family,paymentAmount:vfcRound_(median,.01),averagePayment:vfcRound_(vfcSum_(amounts)/amounts.length,.01),frequency:frequency,monthlyEquivalent:vfcRound_(monthly,.01),monthlyEquivalentMethod:method,occurrences:occ,distinctMonths:distinct,firstSeen:items[0].date,lastSeen:items[items.length-1].date,daysSinceLastObserved:daysSince,active:active,recurring:recurring,confidence:!recurring?'Low':(distinct>=3?'High':'Moderate'),observedTotal:vfcRound_(vfcSum_(amounts),.01),observedMonthlyTotals:vfcSortedMoneyObject_(months),components:vfcAmountComponents_(items)};
}

function vfcAmountComponents_(items){
  const clusters=[];(items||[]).slice().sort(function(a,b){return a.amount-b.amount;}).forEach(function(item){let best=null,bestDiff=Infinity;clusters.forEach(function(c){const center=vfcMedian_(c.map(function(x){return x.amount;})),tolerance=Math.max(12,center*(center<2000?.15:.065)),diff=Math.abs(item.amount-center);if(diff<=tolerance&&diff<bestDiff){best=c;bestDiff=diff;}});if(best)best.push(item);else clusters.push([item]);});
  return clusters.map(function(c,i){const a=c.map(function(x){return x.amount;}),m={};c.forEach(function(x){m[x.date.slice(0,7)]=1;});return {componentId:'C'+(i+1),representativeAmount:vfcRound_(vfcMedian_(a),.01),averageAmount:vfcRound_(vfcSum_(a)/a.length,.01),minAmount:vfcRound_(Math.min.apply(null,a),.01),maxAmount:vfcRound_(Math.max.apply(null,a),.01),occurrences:a.length,distinctMonths:Object.keys(m).length};}).sort(function(a,b){return a.representativeAmount-b.representativeAmount;});
}

function vfcMergeGenericAmountMatches_(groups){
  const out=[];(groups||[]).forEach(function(g){if(vfcIsStrongEntityKey_(g.entityKey,g.family)){out.push(g);return;}let target=null;out.some(function(e){if(vfcIsStrongEntityKey_(e.entityKey,e.family)||e.family!==g.family||e.frequency!==g.frequency)return false;const tolerance=Math.max(8,Math.min(e.paymentAmount,g.paymentAmount)*.02),em=Object.keys(e.observedMonthlyTotals||{}),gm=Object.keys(g.observedMonthlyTotals||{}),overlap=em.filter(function(m){return gm.indexOf(m)>=0;}).length/Math.max(1,Math.min(em.length,gm.length));if(Math.abs(e.paymentAmount-g.paymentAmount)<=tolerance&&Math.min(e.distinctMonths,g.distinctMonths)>=2&&overlap<=.20){target=e;return true;}return false;});if(!target){out.push(g);return;}target.description=target.description+' / '+g.description;target.counterparty=target.description;target.observedTotal=vfcRound_(target.observedTotal+g.observedTotal,.01);target.occurrences+=g.occurrences;target.confidence='High';target.mergedByAmountCadence=true;});return out;
}

function vfcFinancingCredits_(credits,debits){
  const confirmed=[],possible=[];(credits||[]).forEach(function(c){const s=String(c.description||'').toUpperCase(),amount=vfcPos_(c.amount);if(!(amount>0))return;const explicit=/\bLOAN\s+CREDIT\b|LOAN\s+ADVANCE|LOAN\s+PROCEEDS|FINANCING\s+ADVANCE|FUNDING\s+ADVANCE|MCA\s+ADVANCE/.test(s),matched=vfcMatchedPaymentEntity_(c,debits),known=vfcIsKnownFinancingCreditForBank_(c.bankId||'UNKNOWN',c),item={date:c.date,description:c.description,counterparty:c.counterparty,amount:c.amount,direction:'CREDIT',linkedPaymentEntity:matched,confidence:(explicit||matched)?'High':'Moderate'};if(explicit||(amount>=5000&&known&&matched))confirmed.push(item);else if(amount>=5000&&(known||matched||/INVESTMENT|CAPITAL/.test(s)))possible.push(item);});const c=vfcDedupeTx_(confirmed),p=vfcDedupeTx_(possible);return{confirmed:c,possible:p,total:c.reduce(function(s,x){return s+x.amount;},0)};
}
function vfcMatchedPaymentEntity_(credit,debits){const ct=vfcTokens_(credit.counterparty||credit.description);if(!ct.length)return'';let found='';(debits||[]).some(function(d){const dt=vfcTokens_(d.counterparty||d.description);if(!dt.length)return false;let n=0;ct.forEach(function(a){if(dt.some(function(b){return a===b||(a.length>=4&&b.length>=4&&(a.indexOf(b)===0||b.indexOf(a)===0));}))n++;});if(n/Math.min(ct.length,dt.length)>=.5){found=d.entityKey||d.key||'';return true;}return false;});return found;}

function lockBankRegressionBaseline(companyName,period,bankId){
  bankId=String(bankId||'RBC').toUpperCase();const result=refreshDebtSignalsForPeriodSafe({companyName:companyName,period:period});if(!result.ok)throw new Error((result.errors||[]).join(' | '));const ss=SpreadsheetApp.getActiveSpreadsheet();let sh=ss.getSheetByName('BANK_REGRESSION_LOCKS');if(!sh){sh=ss.insertSheet('BANK_REGRESSION_LOCKS');sh.appendRow(['Company Name','Period','Bank','Result Fingerprint','Gross Monthly Deposits','Operating Monthly Deposits','Confirmed Monthly Debt','Financing Credits','Core Version','Locked At']);sh.setFrozenRows(1);}const values=sh.getDataRange().getValues();let rowNum=0;for(let i=1;i<values.length;i++)if(vfcSame_(values[i][0],companyName)&&vfcSame_(values[i][1],period)&&vfcSame_(values[i][2],bankId)){rowNum=i+1;break;}const b=result.bankingFeatures||{},row=[companyName,period,bankId,result.resultFingerprint,b.averageMonthlyDeposits||0,b.estimatedOperatingMonthlyDeposits||0,b.existingMonthlyDebtService||0,b.detectedFinancingCredits||0,VFC_BANK_ENGINE.VERSION,new Date()];if(rowNum)sh.getRange(rowNum,1,1,row.length).setValues([row]);else sh.appendRow(row);return{ok:true,locked:true,resultFingerprint:result.resultFingerprint};
}
function verifyBankRegressionBaseline(companyName,period,bankId){bankId=String(bankId||'RBC').toUpperCase();const result=refreshDebtSignalsForPeriodSafe({companyName:companyName,period:period});if(!result.ok)return result;const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BANK_REGRESSION_LOCKS');if(!sh||sh.getLastRow()<2)return{ok:false,error:'No regression baseline is locked.'};const values=sh.getDataRange().getValues();for(let i=1;i<values.length;i++)if(vfcSame_(values[i][0],companyName)&&vfcSame_(values[i][1],period)&&vfcSame_(values[i][2],bankId)){const expected=String(values[i][3]||'');return{ok:true,match:expected===result.resultFingerprint,expectedFingerprint:expected,actualFingerprint:result.resultFingerprint};}return{ok:false,error:'No matching regression baseline is locked.'};}

function vfcResultFingerprint_(f){const d=f.debtProfile||{},canonical={statementCount:f.statementCount||0,totalDeposits:vfcRound_(f.totalDeposits||0,.01),averageMonthlyDeposits:vfcRound_(f.averageMonthlyDeposits||0,.01),estimatedOperatingMonthlyDeposits:vfcRound_(f.estimatedOperatingMonthlyDeposits||0,.01),detectedFinancingCredits:vfcRound_(f.detectedFinancingCredits||0,.01),existingMonthlyDebtService:vfcRound_(f.existingMonthlyDebtService||0,.01),debt:(d.activeDebtObligations||[]).map(function(x){return[x.entityKey,x.monthlyEquivalent,x.frequency,x.paymentAmount,x.lastSeen];}),info:(d.otherRecurringObligations||[]).map(function(x){return[x.entityKey,x.monthlyEquivalent,x.frequency,x.paymentAmount,x.lastSeen];}),financing:(d.financingCredits||[]).map(function(x){return[x.date,x.amount,x.description];})};return vfcDigest_(JSON.stringify(canonical));}

function vfcBaseFeatures_(companyName,period){if(typeof buildPowerFeatures_==='function')return buildPowerFeatures_(companyName,period);if(typeof buildFeaturesForCase_==='function')return buildFeaturesForCase_(companyName,period);return null;}
function vfcRequest_(a,p){return a&&typeof a==='object'?{companyName:String(a.companyName||'').trim(),period:String(a.period||p||'').trim()}:{companyName:String(a||'').trim(),period:String(p||'').trim()};}
function vfcHeader_(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'');}
function vfcSame_(a,b){return String(a||'').trim().toLowerCase()===String(b||'').trim().toLowerCase();}
function vfcNum_(v){const n=Number(String(v==null?'':v).replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:0;}
function vfcNumNull_(v){if(v===null||v===undefined||v==='')return null;const n=Number(String(v).replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:null;}
function vfcPos_(v){return Math.max(0,vfcNum_(v));}
function vfcBool_(v){return /^(true|yes|y|1)$/i.test(String(v||'').trim())||/negative/i.test(String(v||''));}
function vfcRound_(v,step){step=step||.01;return Math.round((v+Number.EPSILON)/step)*step;}
function vfcDate_(v){if(!v)return null;const d=v instanceof Date?v:new Date(v);return isNaN(d.getTime())?null:d;}
function vfcIso_(v){const d=vfcDate_(v);if(!d)return /^\d{4}-\d{2}-\d{2}$/.test(String(v||''))?String(v):'';return Utilities.formatDate(d,Session.getScriptTimeZone()||'GMT','yyyy-MM-dd');}
function vfcTime_(v){const d=vfcDate_(v);return d?d.getTime():0;}
function vfcSum_(a){return(a||[]).reduce(function(s,x){return s+vfcNum_(x);},0);}
function vfcMedian_(a){const x=(a||[]).slice().sort(function(m,n){return m-n;});if(!x.length)return 0;const k=Math.floor(x.length/2);return x.length%2?x[k]:(x[k-1]+x[k])/2;}
function vfcCv_(a){if(!a||!a.length)return 0;const mean=vfcSum_(a)/a.length;if(!mean)return 0;return Math.sqrt(a.reduce(function(s,x){return s+Math.pow(x-mean,2);},0)/a.length)/mean;}
function vfcDays_(a,b){const da=vfcDate_(a),db=vfcDate_(b);return!da||!db?null:Math.max(0,Math.round((db-da)/86400000));}
function vfcMeanObject_(o){const k=Object.keys(o||{});return k.length?k.reduce(function(s,x){return s+vfcNum_(o[x]);},0)/k.length:0;}
function vfcRecentMonthAverage_(o,n){const k=Object.keys(o||{}).sort().slice(-Math.max(1,n||3));return k.length?k.reduce(function(s,x){return s+vfcNum_(o[x]);},0)/k.length:0;}
function vfcSortedMoneyObject_(o){const out={};Object.keys(o||{}).sort().forEach(function(k){out[k]=vfcRound_(o[k],.01);});return out;}
function vfcObligationSort_(a,b){return(b.monthlyEquivalent||0)-(a.monthlyEquivalent||0)||String(a.counterparty||'').localeCompare(String(b.counterparty||''));}
function vfcDedupeTx_(a){const out=[],seen={};(a||[]).forEach(function(t){const k=[t.bankId||'',t.date,t.direction,t.amount,String(t.description||'').toUpperCase()].join('|');if(!seen[k]){seen[k]=1;out.push(t);}});return out;}
function vfcTokens_(s){const stop={BUSINESS:1,INVESTMENT:1,PAD:1,PAYMENT:1,LOAN:1,CREDIT:1,DEBIT:1,THE:1,INC:1,LTD:1,CORP:1,CORPORATION:1,COMPANY:1,001:1};return String(s||'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').split(/\s+/).filter(function(x){return x.length>=3&&!stop[x]&&!/^\d+$/.test(x);});}
function vfcCounterpartyKey_(s){const t=vfcTokens_(s);return t.slice(0,4).join('_')||String(s||'').toUpperCase().replace(/[^A-Z0-9]+/g,'_').slice(0,60);}
function vfcIsStrongEntityKey_(key,family){const k=String(key||'').toUpperCase();return /^LOAN(_INTEREST)?_[0-9]/.test(k)||/^INSURANCE_/.test(k)||vfcBankStrongEntityKey_(k,family);}
function vfcDigest_(s){const bytes=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(s||''),Utilities.Charset.UTF_8);return bytes.map(function(b){const v=(b<0?b+256:b).toString(16);return v.length===1?'0'+v:v;}).join('').substring(0,24);}
