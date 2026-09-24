/**
 * VFC Banking Core 4.11
 * Shared bank-agnostic banking math over frozen statement facts.
 * No PDF or OpenAI call occurs during underwriting.
 */
const VFC_BANK_ENGINE={
  VERSION:'VFC-BANKING-CORE-4.11',
  FACTS_VERSION:'VFC-BANK-FACTS-1.2',
  INTAKE_CONTRACT:'BANK_MATCHED_FROZEN_LEDGER_V2',
  CACHE_PREFIX:'VFC_BANK_FACTS_V1:',
  LEGACY_PREFIXES:['VFC_BANK_PURE_V46:','VFC_BANK_PURE_V45:','VFC_BANK_PURE_V44:','VFC_BANK_PURE_V43:','VFC_BANK_PURE_V42:','VFC_BANK_PURE_V41:','VFC_BANK_PURE_V40:','VFC_BANK_PURE_V35:','VFC_BANK_PURE_V34:','VFC_BANK_PURE_V1:'],
  MAX_STATEMENTS:12,DEBT_LOOKBACK:6,ACTIVE_DAYS:75,RECONCILE_TOLERANCE:.05
};
const VFC_BANK_SIMPLE=VFC_BANK_ENGINE;

function getBankingInputQualityStatus(){return{modelVersion:VFC_BANK_ENGINE.VERSION,factsVersion:VFC_BANK_ENGINE.FACTS_VERSION,intakeContract:VFC_BANK_ENGINE.INTAKE_CONTRACT,deterministic:true,pdfReReadDuringUnderwriting:false,frozenStatementFacts:true,logicalStatementDeduplication:true,allRiskDrivingFeaturesFromFrozenFacts:true,architecture:'BankingCore + BankRouter + one isolated file per bank',banks:getBankParserTabs()};}

function vfcBankCreateIntakePayload_(summary,fileName){
  summary=summary||{};
  const opening=vfcNumNull_(summary.opening_balance),closing=vfcNumNull_(summary.closing_balance),deposits=vfcNumNull_(summary.total_deposits),withdrawals=vfcNumNull_(summary.total_withdrawals),diff=(opening!==null&&closing!==null&&deposits!==null&&withdrawals!==null)?vfcRound_((opening+deposits-withdrawals)-closing,.01):null,bankName=String(summary.bank_name||'Unknown'),bankId=vfcDetectBankId_(bankName),profile=typeof vfcGetBankProfile_==='function'?vfcGetBankProfile_(bankId):null;
  return VFC_BANK_ENGINE.CACHE_PREFIX+JSON.stringify({version:5,extractionVersion:VFC_BANK_ENGINE.FACTS_VERSION,intakeContract:VFC_BANK_ENGINE.INTAKE_CONTRACT,bankRulesVersion:profile&&profile.rulesVersion?profile.rulesVersion:'',fileName:String(fileName||''),bankId:bankId,bankName:bankName,accountHolder:String(summary.account_holder||'').trim(),accountNumber:String(summary.account_number||summary.account_no||'').trim(),statementStartDate:vfcIso_(summary.statement_start_date),statementEndDate:vfcIso_(summary.statement_end_date),openingBalance:opening,closingBalance:closing,totalDeposits:deposits,totalWithdrawals:withdrawals,reconciliationDifference:diff,nsfCount:Math.max(0,vfcNum_(summary.nsf_count)),negativeBalanceDetected:vfcBool_(summary.negative_balance_detected),transactionsVerified:true,transactions:vfcNormalizeTransactions_(summary.banking_transactions||[],bankId)});
}

/** One shared intake contract for every bank: usable frozen facts, correct bank, dates and exact reconciliation. */
function vfcValidateFrozenPayload_(raw,expectedBankId,fileName){
  const frozen=vfcParseBankCache_(raw),name=String(fileName||'statement');
  if(!vfcPayloadUsable_(frozen))throw new Error('Frozen banking ledger could not be created for '+name+'. Upload was stopped before saving incomplete facts.');
  const expected=String(expectedBankId||'').toUpperCase(),actual=vfcPayloadBankId_(frozen,'');
  if(expected&&actual!==expected)throw new Error('Frozen banking ledger bank mismatch for '+name+': expected '+expected+' but froze '+(actual||'UNKNOWN')+'.');
  const start=vfcIso_(frozen.statementStartDate),end=vfcIso_(frozen.statementEndDate),opening=vfcNumNull_(frozen.openingBalance),closing=vfcNumNull_(frozen.closingBalance),deposits=vfcNumNull_(frozen.totalDeposits),withdrawals=vfcNumNull_(frozen.totalWithdrawals);
  if(!start||!end||opening===null||closing===null||deposits===null||withdrawals===null)throw new Error('Frozen banking ledger header facts were incomplete for '+name+'. Upload was stopped before saving incomplete facts.');
  const diff=Math.abs((opening+deposits-withdrawals)-closing);
  if(diff>VFC_BANK_ENGINE.RECONCILE_TOLERANCE)throw new Error('Frozen banking ledger does not reconcile for '+name+'. Difference: $'+vfcRound_(diff,.01)+'.');
  return frozen;
}

function getValidatedBankingFeatures_(companyName,period){
  const base=vfcBaseFeatures_(companyName,period);if(!base)return null;const rows=vfcSelectedStatementRows_(companyName,period);if(!rows.length)return base;const prepared=[],errors=[];
  rows.forEach(function(row){const payload=vfcCanonicalPayloadForRow_(row);if(!payload){errors.push(row.fileName+': no frozen transaction ledger found; re-upload this statement once.');return;}const check=vfcReconcilePayload_(payload,row);if(!check.ok){errors.push(row.fileName+': statement totals do not reconcile.');return;}prepared.push({row:row,payload:payload});});
  if(errors.length)throw new Error('Unable to verify uploaded bank statement(s): '+errors.join(' | '));return vfcBuildBankingFeatures_(base,prepared);
}

function refreshDebtSignalsForPeriodSafe(companyOrRequest,requestedPeriod){
  try{const req=vfcRequest_(companyOrRequest,requestedPeriod),period=req.period||(typeof resolveLatestAssessmentPeriod_==='function'?resolveLatestAssessmentPeriod_(req.companyName,req.period):req.period),f=getValidatedBankingFeatures_(req.companyName,period);if(!f)throw new Error('No banking features found.');return{ok:true,modelVersion:VFC_BANK_ENGINE.VERSION,resultFingerprint:f.resultFingerprint||'',companyName:req.companyName,period:period,bankTabs:getBankParserTabs(),debtProfile:f.debtProfile||{},inputQualityAudit:f.inputQualityAudit||{},bankingFeatures:{statementCount:f.statementCount||0,totalDeposits:f.totalDeposits||0,averageMonthlyDeposits:f.averageMonthlyDeposits||0,monthlyDeposits:f.monthlyDeposits||[],depositTrend:f.depositTrend||0,estimatedOperatingMonthlyDeposits:f.estimatedOperatingMonthlyDeposits||0,existingMonthlyDebtService:f.existingMonthlyDebtService||0,informationalRecurringMonthlyObligations:f.informationalRecurringMonthlyObligations||0,detectedFinancingCredits:f.detectedFinancingCredits||0,excludedTransferCredits:f.excludedTransferCredits||0,excludedReversalCredits:f.excludedReversalCredits||0},errors:[]};}
  catch(e){return{ok:false,modelVersion:VFC_BANK_ENGINE.VERSION,errors:[String(e&&e.message||e)]};}
}
function refreshLatestDebtSignals(){const rows=vfcSummaryRows_('','');if(!rows.length)throw new Error('No bank statements found.');rows.sort(function(a,b){return vfcTime_(a.createdAt)-vfcTime_(b.createdAt);});const last=rows[rows.length-1];return refreshDebtSignalsForPeriodSafe({companyName:last.companyName,period:last.period});}
function diagnoseLatestBankingInputs(){return refreshLatestDebtSignals();}

function vfcSummaryRows_(companyName,period){
  const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');if(!sh||sh.getLastRow()<2)return[];const values=sh.getDataRange().getValues(),headers=values[0].map(vfcHeader_),idx={};headers.forEach(function(h,i){idx[h]=i;});function val(r,n){const i=idx[vfcHeader_(n)];return i===undefined?'':r[i];}const out=[];
  for(let i=1;i<values.length;i++){const r=values[i],company=String(val(r,'Company Name')||'').trim(),detected=String(val(r,'Detected Period')||'').trim();if(companyName&&!vfcSame_(company,companyName))continue;if(period&&!vfcSame_(detected,period))continue;out.push({rowNumber:i+1,uploadId:String(val(r,'Upload ID')||'').trim(),companyName:company,period:detected,fileName:String(val(r,'File Name')||'').trim(),bank:String(val(r,'Bank Name')||'').trim(),accountHolder:String(val(r,'Account Holder')||'').trim(),startDate:val(r,'Statement Start Date'),endDate:val(r,'Statement End Date'),opening:vfcNumNull_(val(r,'Opening Balance')),closing:vfcNumNull_(val(r,'Closing Balance')),deposits:vfcNumNull_(val(r,'Total Deposits')),withdrawals:vfcNumNull_(val(r,'Total Withdrawals')),nsf:vfcNum_(val(r,'NSF Count')),negative:vfcBool_(val(r,'Negative Balance Detected')),signalRaw:String(val(r,'Possible MCA Or Loan Payments')||''),createdAt:val(r,'Created At')});}
  return out;
}
function vfcAccountNumberKey_(v){return String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'');}
function vfcFileIdentityKey_(v){return String(v||'').toUpperCase().replace(/\.[A-Z0-9]+$/,'').replace(/\s*\(\d+\)$/,'').replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,'');}
function vfcStatementMeta_(r){r=r||{};const p=vfcParseBankCache_(r.signalRaw);return{bankId:vfcPayloadBankId_(p,r.bank||''),start:vfcIso_((p&&p.statementStartDate)||r.startDate),end:vfcIso_((p&&p.statementEndDate)||r.endDate),account:vfcAccountNumberKey_((p&&p.accountNumber)||r.accountNumber||''),fileKey:vfcFileIdentityKey_((p&&p.fileName)||r.fileName||''),holder:vfcCounterpartyKey_((p&&p.accountHolder)||r.accountHolder||'')};}
function vfcStatementBasePeriodKey_(r){const m=vfcStatementMeta_(r);return[m.bankId,m.start,m.end].join('|');}
function vfcStatementIdentityKey_(r){const m=vfcStatementMeta_(r),subject=m.account?'ACCOUNT:'+m.account:(m.fileKey?'FILE:'+m.fileKey:(m.holder?'HOLDER:'+m.holder:'UNKNOWN'));return[m.bankId,subject,m.start,m.end].join('|');}
/**
 * Group one logical statement across re-uploads without trusting extracted dollar totals as identity.
 * Known account numbers are authoritative. Legacy rows without an account number may join exactly one
 * account group only when bank + dates + normalized filename match. Ambiguous legacy rows stay separate.
 */
function vfcGroupLogicalStatementRows_(rows){
  const byPeriod={};(rows||[]).forEach(function(r){const key=vfcStatementBasePeriodKey_(r);if(!byPeriod[key])byPeriod[key]=[];byPeriod[key].push(r);});const out=[];
  Object.keys(byPeriod).sort().forEach(function(periodKey){const bucket=byPeriod[periodKey],accountGroups={},legacy=[];bucket.forEach(function(r){const m=vfcStatementMeta_(r);if(m.account){if(!accountGroups[m.account])accountGroups[m.account]=[];accountGroups[m.account].push(r);}else legacy.push(r);});const groups=Object.keys(accountGroups).sort().map(function(k){return accountGroups[k];});
    legacy.forEach(function(r){const m=vfcStatementMeta_(r),matches=[];if(m.fileKey)groups.forEach(function(g){if(g.some(function(x){return vfcStatementMeta_(x).fileKey===m.fileKey;}))matches.push(g);});if(matches.length===1){matches[0].push(r);return;}let target=null;out.some(function(){return false;});const legacyGroups=groups.filter(function(g){return!g.some(function(x){return!!vfcStatementMeta_(x).account;});});legacyGroups.some(function(g){const gm=vfcStatementMeta_(g[0]);if((m.fileKey&&gm.fileKey===m.fileKey)||(!m.fileKey&&m.holder&&gm.holder===m.holder)){target=g;return true;}return false;});if(target)target.push(r);else groups.push([r]);});groups.forEach(function(g){out.push(g);});
  });return out;
}
function vfcStatementHolderRaw_(r){
  r=r||{};const p=vfcParseBankCache_(r.signalRaw);
  return String((p&&p.accountHolder)||r.accountHolder||'').replace(/\s+/g,' ').trim();
}
function vfcHolderKey_(r){const raw=vfcStatementHolderRaw_(r);return raw?vfcCounterpartyKey_(raw):'';}
function vfcHolderMatchScore_(companyName,holder){
  function compact(v){return String(v||'').toUpperCase().replace(/\b(INCORPORATED|INC|LIMITED|LTD|CORPORATION|CORP|COMPANY|CO)\b/g,'').replace(/[^A-Z0-9]/g,'');}
  const ca=compact(companyName),cb=compact(holder);
  if(ca&&cb&&(ca===cb||ca.indexOf(cb)>=0||cb.indexOf(ca)>=0))return 1;
  const a=vfcTokens_(companyName),b=vfcTokens_(holder);if(!a.length||!b.length)return 0;
  let common=0;a.forEach(function(x){if(b.indexOf(x)>=0)common++;});
  return common/Math.max(1,Math.min(a.length,b.length));
}
function vfcIsolateBorrowerRows_(rows,companyName){
  rows=(rows||[]).slice();if(rows.length<2)return rows;
  const clusters={},unknown=[];
  rows.forEach(function(r){const k=vfcHolderKey_(r);if(!k){unknown.push(r);return;}if(!clusters[k])clusters[k]={key:k,holder:vfcStatementHolderRaw_(r),rows:[],latest:0};clusters[k].rows.push(r);clusters[k].latest=Math.max(clusters[k].latest,vfcTime_(r.createdAt));});
  const list=Object.keys(clusters).map(function(k){const c=clusters[k];c.match=vfcHolderMatchScore_(companyName,c.holder);return c;});
  if(list.length<=1)return rows;
  list.sort(function(a,b){return b.match-a.match||b.rows.length-a.rows.length||b.latest-a.latest||a.key.localeCompare(b.key);});
  const best=list[0],second=list[1];
  if(!(best.match>=.5)){
    throw new Error('Multiple bank-statement account holders were found for "'+companyName+'" in the same assessment period. Refusing to mix borrower data. Holders detected: '+list.map(function(c){return c.holder||c.key;}).join(' | ')+'.');
  }
  if(second&&Math.abs(best.match-second.match)<.0001&&best.rows.length===second.rows.length){
    throw new Error('Bank-statement borrower selection is ambiguous for "'+companyName+'". Refusing to combine different account holders: '+best.holder+' | '+second.holder+'.');
  }
  const allowedAccounts={};best.rows.forEach(function(r){const a=vfcStatementMeta_(r).account;if(a)allowedAccounts[a]=1;});
  unknown.forEach(function(r){const a=vfcStatementMeta_(r).account;if(a&&allowedAccounts[a])best.rows.push(r);});
  best.rows.forEach(function(r){
    r.borrowerIsolation={selectedHolder:best.holder,excludedHolderCount:list.length-1,excludedStatementCount:list.slice(1).reduce(function(n,c){return n+c.rows.length;},0)};
  });
  return best.rows;
}
function vfcSelectedStatementRows_(companyName,period){
  const all=vfcSummaryRows_(companyName,period),groups=vfcGroupLogicalStatementRows_(all),rows=groups.map(function(group){const latest=group.slice().sort(function(a,b){return vfcTime_(b.createdAt)-vfcTime_(a.createdAt)||b.rowNumber-a.rowNumber;})[0],bankId=vfcDetectBankId_(latest.bank||''),canonical=vfcCanonicalSignalRawFromRows_(group,bankId),row=Object.assign({},latest);if(canonical)row.signalRaw=canonical;row.statementIdentity=vfcStatementIdentityKey_(row);row.logicalRowNumbers=group.map(function(x){return x.rowNumber;});row.duplicateRowsCollapsed=Math.max(0,group.length-1);return row;});
  const isolated=vfcIsolateBorrowerRows_(rows,companyName);
  isolated.sort(function(a,b){return vfcTime_(a.endDate)-vfcTime_(b.endDate)||String(a.fileName).localeCompare(String(b.fileName));});return isolated.slice(Math.max(0,isolated.length-VFC_BANK_ENGINE.MAX_STATEMENTS));
}
/** Exact frozen-fact fingerprint retained for diagnostics/regression only; it is not statement identity. */
function vfcStatementFingerprint_(r){return[String(r.bank||'').toUpperCase(),vfcIso_(r.startDate),vfcIso_(r.endDate),vfcRound_(vfcNum_(r.opening),.01),vfcRound_(vfcNum_(r.closing),.01),vfcRound_(vfcNum_(r.deposits),.01),vfcRound_(vfcNum_(r.withdrawals),.01)].join('|');}

function vfcPayloadBankId_(p,rowBank){return String((p&&p.bankId)||vfcDetectBankId_((p&&p.bankName)||rowBank||'')||'UNKNOWN').toUpperCase();}
function vfcCurrentBankRulesVersion_(bankId){if(typeof vfcGetBankProfile_!=='function')return'';const p=vfcGetBankProfile_(bankId);return p&&p.rulesVersion?String(p.rulesVersion):'';}
/** First payload under the current facts version + bank-rules/intake contract is canonical. Older ledgers remain fallback only. */
function vfcCanonicalSignalRawFromRows_(rows,expectedBankId){
  const expected=String(expectedBankId||'').toUpperCase(),currentRules=vfcCurrentBankRulesVersion_(expected),currentContract=VFC_BANK_ENGINE.INTAKE_CONTRACT,currentFacts=VFC_BANK_ENGINE.FACTS_VERSION,candidates=[];
  (rows||[]).forEach(function(row){const raw=String(row.signalRaw||''),p=vfcParseBankCache_(raw);if(!vfcPayloadUsable_(p))return;const actual=vfcPayloadBankId_(p,row.bank||'');if(expected&&actual!==expected)return;let rank=0;if(String(p.intakeContract||'')===currentContract)rank+=1;if(currentRules&&String(p.bankRulesVersion||'')===currentRules)rank+=2;if(currentFacts&&String(p.extractionVersion||'')===currentFacts)rank+=4;candidates.push({raw:raw,payload:p,row:row,rank:rank});});
  candidates.sort(function(a,b){return b.rank-a.rank||vfcTime_(a.row&&a.row.createdAt)-vfcTime_(b.row&&b.row.createdAt);});
  return candidates.length?candidates[0].raw:'';
}
function vfcCanonicalPayloadForRow_(row){
  const all=vfcSummaryRows_(row.companyName,row.period),numbers=Array.isArray(row.logicalRowNumbers)?row.logicalRowNumbers:[],groups=vfcGroupLogicalStatementRows_(all);let pool=[];if(numbers.length)pool=all.filter(function(x){return numbers.indexOf(x.rowNumber)>=0;});if(!pool.length){groups.some(function(g){if(g.some(function(x){return x.rowNumber===row.rowNumber||(row.uploadId&&x.uploadId===row.uploadId);})) {pool=g;return true;}return false;});}if(!pool.length)pool=[row];const expected=vfcDetectBankId_(row.bank||''),raw=vfcCanonicalSignalRawFromRows_(pool,expected)||String(row.signalRaw||'');
  if(raw){const p=vfcParseBankCache_(raw);if(vfcPayloadUsable_(p))return vfcNormalizePayload_(p,row);}const exact=vfcParseBankCache_(row.signalRaw);return vfcPayloadUsable_(exact)&&(!expected||vfcPayloadBankId_(exact,row.bank)===expected)?vfcNormalizePayload_(exact,row):null;
}
function vfcParseBankCache_(raw){const s=String(raw||''),prefixes=[VFC_BANK_ENGINE.CACHE_PREFIX].concat(VFC_BANK_ENGINE.LEGACY_PREFIXES);for(let i=0;i<prefixes.length;i++){if(s.indexOf(prefixes[i])!==0)continue;try{return JSON.parse(s.slice(prefixes[i].length));}catch(e){return null;}}return null;}
function vfcPayloadUsable_(p){return!!(p&&p.transactionsVerified&&Array.isArray(p.transactions)&&vfcNumNull_(p.totalDeposits)!==null&&vfcNumNull_(p.totalWithdrawals)!==null);}
function vfcNormalizePayload_(p,row){const bankId=vfcPayloadBankId_(p,row.bank||'');return{version:Number(p.version)||4,extractionVersion:String(p.extractionVersion||VFC_BANK_ENGINE.FACTS_VERSION),intakeContract:String(p.intakeContract||''),bankRulesVersion:String(p.bankRulesVersion||''),fileName:String(p.fileName||row.fileName||''),bankId:bankId,bankName:String(p.bankName||row.bank||'Unknown'),accountHolder:String(p.accountHolder||row.accountHolder||''),accountNumber:String(p.accountNumber||''),statementStartDate:vfcIso_(p.statementStartDate||row.startDate),statementEndDate:vfcIso_(p.statementEndDate||row.endDate),openingBalance:vfcNumNull_(p.openingBalance),closingBalance:vfcNumNull_(p.closingBalance),totalDeposits:vfcPos_(p.totalDeposits),totalWithdrawals:vfcPos_(p.totalWithdrawals),reconciliationDifference:vfcNum_(p.reconciliationDifference),nsfCount:Math.max(0,vfcNum_(p.nsfCount||row.nsf)),negativeBalanceDetected:!!(p.negativeBalanceDetected||row.negative),transactionsVerified:true,transactions:vfcNormalizeTransactions_(p.transactions||[],bankId)};}
function vfcReconcilePayload_(p,row){const opening=p.openingBalance!==null?p.openingBalance:row.opening,closing=p.closingBalance!==null?p.closingBalance:row.closing,deposits=p.totalDeposits,withdrawals=p.totalWithdrawals;if(opening===null||closing===null||deposits===null||withdrawals===null)return{ok:false,diff:null};const diff=Math.abs((opening+deposits-withdrawals)-closing);return{ok:diff<=VFC_BANK_ENGINE.RECONCILE_TOLERANCE,diff:diff};}
function vfcNormalizeTransactions_(items,bankId){
  const raw=[];(Array.isArray(items)?items:[]).forEach(function(x){const date=vfcIso_(x.date),desc=String(x.description||'').replace(/\s+/g,' ').trim(),direction=String(x.direction||'').toUpperCase(),amount=vfcPos_(x.amount);if(!date||!desc||(direction!=='DEBIT'&&direction!=='CREDIT')||!(amount>0))return;raw.push({date:date,description:desc.substring(0,220),counterparty:String(x.counterparty||desc).replace(/\s+/g,' ').trim().substring(0,140),direction:direction,amount:vfcRound_(amount,.01)});});
  const out=[],seen={};raw.forEach(function(t){const key=[t.date,t.direction,t.amount,t.description.toUpperCase()].join('|'),count=(seen[key]||0)+1;seen[key]=count;if(count===1){out.push(t);return;}if(vfcPreserveBankPrintedDuplicate_(bankId,t,count,raw)){out.push(Object.assign({},t,{occurrence:count}));}});
  out.sort(function(a,b){return vfcTime_(a.date)-vfcTime_(b.date)||a.direction.localeCompare(b.direction)||a.amount-b.amount||a.description.localeCompare(b.description)||(a.occurrence||1)-(b.occurrence||1);});return out;
}
function vfcPreserveBankPrintedDuplicate_(bankId,t,occurrence,items){
  if(typeof vfcBankPreservePrintedDuplicate_==='function'&&vfcBankPreservePrintedDuplicate_(bankId||'UNKNOWN',t,occurrence,items))return true;
  if(!vfcIsReturnedObligationCredit_(bankId||'UNKNOWN',t)&&String(t.direction||'')!=='DEBIT')return false;
  if(t.direction==='DEBIT'){
    const classified=vfcClassifyDebitForBank_(bankId||'UNKNOWN',t);if(!classified||(classified.family!=='FINANCING'&&classified.family!=='MCA'))return false;
    const returns=(items||[]).filter(function(c){if(c.direction!=='CREDIT'||!vfcIsReturnedObligationCredit_(bankId||'UNKNOWN',c)||Math.abs(vfcNum_(c.amount)-vfcNum_(t.amount))>vfcReturnedAmountTolerance_(c.amount,t.amount))return false;const dd=vfcDate_(t.date),cd=vfcDate_(c.date);if(!dd||!cd)return false;const days=(cd-dd)/86400000;return days>=0&&days<=3;}).length;
    return occurrence<=1+returns;
  }
  const debits=(items||[]).filter(function(d){if(d.direction!=='DEBIT'||Math.abs(vfcNum_(d.amount)-vfcNum_(t.amount))>vfcReturnedAmountTolerance_(d.amount,t.amount))return false;const classified=vfcClassifyDebitForBank_(bankId||'UNKNOWN',d);if(!classified||(classified.family!=='FINANCING'&&classified.family!=='MCA'))return false;const dd=vfcDate_(d.date),cd=vfcDate_(t.date);if(!dd||!cd)return false;const days=(cd-dd)/86400000;return days>=0&&days<=3;}).length;
  return occurrence<=debits;
}

/** Every field used by Our Max risk scoring is recalculated from deduplicated frozen statements. */
function vfcBuildBankingFeatures_(base,rows){
  let totalDeposits=0,totalWithdrawals=0,nsf=0,negative=0;const monthlyDeposits=[],monthlyWithdrawals=[],openings=[],closings=[],audit=[],allTx=[];
  rows.forEach(function(x){const p=x.payload;totalDeposits+=p.totalDeposits;totalWithdrawals+=p.totalWithdrawals;monthlyDeposits.push(p.totalDeposits);monthlyWithdrawals.push(p.totalWithdrawals);if(p.openingBalance!==null)openings.push(p.openingBalance);if(p.closingBalance!==null)closings.push(p.closingBalance);nsf+=p.nsfCount||0;if(p.negativeBalanceDetected)negative=1;(p.transactions||[]).forEach(function(t){allTx.push(Object.assign({bankId:p.bankId||'UNKNOWN'},t));});audit.push({fileName:x.row.fileName,statementIdentity:x.row.statementIdentity||vfcStatementIdentityKey_(x.row),duplicateRowsCollapsed:x.row.duplicateRowsCollapsed||0,bankId:p.bankId,bank:p.bankName,accountNumber:p.accountNumber||'',bankRulesVersion:p.bankRulesVersion||'',intakeContract:p.intakeContract||'',start:p.statementStartDate,end:p.statementEndDate,totalDeposits:p.totalDeposits,totalWithdrawals:p.totalWithdrawals,reconciliationDifference:p.reconciliationDifference,transactionsVerified:true,transactionCount:(p.transactions||[]).length});});
  const recent=rows.slice(Math.max(0,rows.length-VFC_BANK_ENGINE.DEBT_LOOKBACK)),debt=vfcDebtProfile_(recent),reversalCredits=vfcOperatingReversalRows_(allTx,debt),reversalCreditsTotal=reversalCredits.reduce(function(s,t){return s+vfcPos_(t.amount);},0),recoveredTransferCredits=vfcRecoverMisdirectedTransferCredits_(rows),transferCredits=vfcDedupeTx_(vfcNonOperatingTransferCredits_(allTx).concat(recoveredTransferCredits)),transferCreditsTotal=transferCredits.reduce(function(s,t){return s+vfcPos_(t.amount);},0),months=Math.max(1,rows.length),grossMonthly=totalDeposits/months,operatingTotal=Math.max(0,totalDeposits-debt.financingCreditsTotal-reversalCreditsTotal-transferCreditsTotal),avgDep=vfcMean_(monthlyDeposits),txText=allTx.map(function(t){return String(t.description||'');}).join(' ').toUpperCase(),overdraftFlag=/OVERDRAFT|OVER LIMIT/.test(txText)?1:0,returnedFlag=reversalCredits.length||allTx.some(function(t){return/RETURNED UNPAID|RETURNED ITEM|RETURNED PAYMENT|REVERSAL|CHARGEBACK|ITEM RETURNED NSF/.test(String(t.description||'').toUpperCase());})?1:0,stackingFlag=(debt.activeDebtObligations||[]).filter(function(x){return x.family==='MCA'||x.family==='PAD';}).length>=2?1:0,inputWarnings=(debt.warnings||[]).filter(function(w){return!/excluded from estimated operating deposits/i.test(String(w||''));});
  if(reversalCreditsTotal)inputWarnings.push('Returned/reversal credit activity of $'+vfcRound_(reversalCreditsTotal,.01)+' is excluded from estimated operating deposits.');
  if(transferCreditsTotal)inputWarnings.push('Explicit bank-account transfer credits of $'+vfcRound_(transferCreditsTotal,.01)+' are excluded from estimated operating deposits. Generic customer e-Transfers are not excluded unless the bank-specific rules identify them as internal transfers.');
  if(recoveredTransferCredits.length)inputWarnings.push('Recovered '+recoveredTransferCredits.length+' internal-transfer credit'+(recoveredTransferCredits.length===1?'':'s')+' from a frozen debit/credit direction mismatch because the amount exactly reconciled the printed statement deposit total.');
  const isolation=rows.length&&rows[0].row&&rows[0].row.borrowerIsolation?rows[0].row.borrowerIsolation:null;
  if(isolation&&isolation.excludedStatementCount)inputWarnings.push('Borrower isolation excluded '+isolation.excludedStatementCount+' statement set'+(isolation.excludedStatementCount===1?'':'s')+' belonging to other account holder(s); selected holder: '+isolation.selectedHolder+'.');
  audit.forEach(function(a){if(a.duplicateRowsCollapsed)inputWarnings.push(a.fileName+': '+a.duplicateRowsCollapsed+' older re-upload row'+(a.duplicateRowsCollapsed===1?' was':'s were')+' collapsed into this logical statement before underwriting.');if((vfcNum_(a.totalDeposits)>0||vfcNum_(a.totalWithdrawals)>0)&&a.transactionCount===0)inputWarnings.push(a.fileName+': statement totals were present but no transaction rows were frozen; recurring-payment analysis may be incomplete.');});
  const result=Object.assign({},base,{statementCount:rows.length,monthsCovered:rows.length,totalDeposits:vfcRound_(totalDeposits,.01),averageMonthlyDeposits:vfcRound_(grossMonthly,.01),totalWithdrawals:vfcRound_(totalWithdrawals,.01),depositWithdrawalRatio:totalWithdrawals?vfcRound_(totalDeposits/totalWithdrawals,.01):0,averageOpeningBalance:vfcRound_(vfcMean_(openings),.01),averageClosingBalance:vfcRound_(vfcMean_(closings),.01),depositVolatility:vfcRound_(avgDep?vfcStdDev_(monthlyDeposits)/avgDep:1,.01),depositTrend:vfcRound_(vfcTrend_(monthlyDeposits),.01),nsfCount:nsf,nsfPerMonth:vfcRound_(nsf/months,.01),negativeBalanceFlag:negative,overdraftFlag:overdraftFlag,returnedPaymentFlag:returnedFlag,suspectedStacking:stackingFlag,missingInfoFlag:0,mcaPaymentFlag:debt.activeDebtObligations.length?1:0,monthlyDeposits:monthlyDeposits.slice(),monthlyWithdrawals:monthlyWithdrawals.slice(),estimatedOperatingTotalDeposits:vfcRound_(operatingTotal,.01),estimatedOperatingMonthlyDeposits:vfcRound_(operatingTotal/months,.01),detectedFinancingCredits:vfcRound_(debt.financingCreditsTotal,.01),excludedReversalCredits:vfcRound_(reversalCreditsTotal,.01),excludedReversalCreditTransactions:reversalCredits,excludedTransferCredits:vfcRound_(transferCreditsTotal,.01),excludedTransferCreditTransactions:transferCredits,existingMonthlyDebtService:vfcRound_(debt.confirmedMonthlyDebtService,.01),informationalRecurringMonthlyObligations:vfcRound_(debt.informationalMonthlyObligations,.01),otherRecurringMonthlyObligations:vfcRound_(debt.informationalMonthlyObligations,.01),debtServiceToDepositsRatio:grossMonthly?vfcRound_(debt.confirmedMonthlyDebtService/grossMonthly,.0001):0,debtProfile:debt,inputQualityAudit:{modelVersion:VFC_BANK_ENGINE.VERSION,intakeContract:VFC_BANK_ENGINE.INTAKE_CONTRACT,verified:true,statementAudit:audit,selectedStatementCount:rows.length,excludedReversalCredits:vfcRound_(reversalCreditsTotal,.01),excludedTransferCredits:vfcRound_(transferCreditsTotal,.01),warnings:inputWarnings}});
  result.resultFingerprint=vfcResultFingerprint_(result);result.inputQualityAudit.resultFingerprint=result.resultFingerprint;return result;
}

function vfcIsGenericReturnedPaymentRow_(t){
  if(!t)return false;
  const s=String(t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s)return false;
  if(/\bFEE\b|\bCHARGE\b|\bPENALTY\b/.test(s))return false;
  return /CHEQUE\s+RETURNED(?:\s+NSF)?|CHECK\s+RETURNED(?:\s+NSF)?|ITEM\s+RETURNED(?:\s+NSF|\s+UNPAID)?|RETURNED\s+ITEM|RETURNED\s+PAYMENT|PAYMENT\s+RETURNED|RETURNED\s+UNPAID|NSF\s+(?:ITEM\s+)?RETURN|DEBIT\s+RETURNED|PAD\s+RETURNED|PRE[- ]?AUTH(?:ORIZED)?[^\n]{0,20}RETURN|ACH\s+RETURN|\bREVERSAL\b/.test(s);
}
function vfcIsGenericReturnedPaymentCredit_(t){return!!(t&&String(t.direction||'').toUpperCase()==='CREDIT'&&vfcIsGenericReturnedPaymentRow_(t));}
function vfcIsReturnedObligationCredit_(bankId,t){return vfcIsGenericReturnedPaymentCredit_(t)||vfcBankIsReturnedFinancingCredit_(bankId||'UNKNOWN',t);}
function vfcIsNonOperatingReversalCredit_(bankId,t){return vfcIsGenericReturnedPaymentCredit_(t)||vfcBankIsNonOperatingReversalCredit_(bankId||'UNKNOWN',t);}
function vfcClassifyObligationDebit_(bankId,t){return vfcClassifyDebitForBank_(bankId||'UNKNOWN',t)||vfcResidualRecurringClassifyDebit_(bankId||'UNKNOWN',t);}
function vfcNonOperatingReversalCredits_(transactions){const out=(transactions||[]).filter(function(t){return String(t.direction||'').toUpperCase()==='CREDIT'&&vfcIsNonOperatingReversalCredit_(t.bankId||'UNKNOWN',t);});return vfcDedupeTx_(out);}
function vfcOperatingReversalRows_(transactions,debtProfile){
  const out=vfcNonOperatingReversalCredits_(transactions).slice(),seen={};
  function key(t){
    return[
      String(t&&t.bankId||'UNKNOWN').toUpperCase(),
      String(t&&t.date||''),
      vfcRound_(vfcPos_(t&&t.amount),.01),
      String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim()
    ].join('|');
  }
  out.forEach(function(t){seen[key(t)]=1;});
  ((debtProfile&&debtProfile.returnedPaymentEvents)||[]).forEach(function(e){
    const r=(e&&e.returnEvent)|| (e&&e.returnCredit)||{};
    if(!e||!e.failedDebit||!(vfcPos_(r.amount)>0)||!r.date)return;
    const item={
      bankId:String(e.bankId||'UNKNOWN'),
      date:String(r.date||''),
      description:String(r.description||''),
      counterparty:String(r.counterparty||''),
      direction:String(r.direction||'').toUpperCase()||'RETURN',
      amount:vfcRound_(vfcPos_(r.amount),.01),
      matchedReturnedObligation:true
    },k=key(item);
    if(seen[k])return;
    seen[k]=1;out.push(item);
  });
  return out.sort(function(a,b){return vfcTime_(a.date)-vfcTime_(b.date)||vfcPos_(a.amount)-vfcPos_(b.amount);});
}
function vfcNonOperatingTransferCredits_(transactions){
  const out=(transactions||[]).filter(function(t){const bankId=t.bankId||'UNKNOWN';return String(t.direction||'').toUpperCase()==='CREDIT'&&!vfcIsNonOperatingReversalCredit_(bankId,t)&&!vfcIsKnownFinancingCreditForBank_(bankId,t)&&vfcBankIsNonOperatingTransferCredit_(bankId,t);});
  return vfcDedupeTx_(out);
}
function vfcStrongInternalTransferRow_(bankId,t){
  if(!t)return false;
  const probe=Object.assign({},t,{direction:'CREDIT'});
  return !vfcIsKnownFinancingCreditForBank_(bankId||'UNKNOWN',probe)&&
         !vfcIsNonOperatingReversalCredit_(bankId||'UNKNOWN',probe)&&
         vfcBankIsNonOperatingTransferCredit_(bankId||'UNKNOWN',probe);
}
function vfcUniqueExactTransferSubset_(candidates,target){
  target=vfcRound_(vfcPos_(target),.01);if(!(target>0)||!candidates||!candidates.length)return[];
  const tol=.05,solutions=[],n=Math.min(candidates.length,14);
  function walk(i,total,picked){
    if(solutions.length>1)return;
    if(Math.abs(total-target)<=tol){solutions.push(picked.slice());return;}
    if(i>=n||total>target+tol)return;
    walk(i+1,total,picked);
    picked.push(candidates[i]);walk(i+1,total+vfcPos_(candidates[i].amount),picked);picked.pop();
  }
  walk(0,0,[]);
  return solutions.length===1?solutions[0]:[];
}
function vfcRecoverMisdirectedTransferCredits_(rows){
  const recovered=[];
  (rows||[]).forEach(function(x){
    const p=x&&x.payload;if(!p||!Array.isArray(p.transactions))return;
    const bankId=String(p.bankId||'UNKNOWN').toUpperCase(),printed=vfcPos_(p.totalDeposits);
    const frozenCredits=p.transactions.filter(function(t){return String(t.direction||'').toUpperCase()==='CREDIT';});
    const frozenCreditTotal=frozenCredits.reduce(function(sum,t){return sum+vfcPos_(t.amount);},0);
    const gap=vfcRound_(printed-frozenCreditTotal,.01);
    if(!(gap>.05))return;
    const candidates=p.transactions.filter(function(t){
      return String(t.direction||'').toUpperCase()==='DEBIT'&&vfcStrongInternalTransferRow_(bankId,t);
    });
    const matched=vfcUniqueExactTransferSubset_(candidates,gap);
    matched.forEach(function(t){
      recovered.push(Object.assign({},t,{
        bankId:bankId,
        direction:'CREDIT',
        recoveredFromDirectionMismatch:true,
        originalDirection:'DEBIT'
      }));
    });
  });
  return vfcDedupeTx_(recovered);
}

function vfcDebtProfile_(rows){
  let tx=[],latest='';rows.forEach(function(x){if(!latest||vfcTime_(x.payload.statementEndDate)>vfcTime_(latest))latest=x.payload.statementEndDate;(x.payload.transactions||[]).forEach(function(t){tx.push(Object.assign({bankId:x.payload.bankId||'UNKNOWN'},t));});});
  tx=vfcDedupeTx_(tx);const rawDebits=tx.filter(function(t){return t.direction==='DEBIT';}),credits=tx.filter(function(t){return t.direction==='CREDIT';}),returnResolution=vfcResolveReturnedObligationDebits_(rawDebits,credits),returnedCredits=returnResolution.returnedCredits,returnedCreditsTotal=returnedCredits.reduce(function(s,c){return s+vfcPos_(c.amount);},0),debits=returnResolution.debits,returnedFinanceDebitsSuppressed=returnResolution.suppressedCount,probableRetryPaymentsLinked=returnResolution.retryLinkedCount,classified=debits.map(function(t){return vfcClassifyObligationDebit_(t.bankId,t);}).filter(Boolean),groups={};
  classified.forEach(function(t){const key=t.bankId+'|'+t.family+'|'+t.entityKey;if(!groups[key])groups[key]={bankId:t.bankId,family:t.family,entityKey:t.entityKey,label:t.label,debtJustification:t.debtJustification||'',items:[],failedEvents:[]};if(!groups[key].debtJustification&&t.debtJustification)groups[key].debtJustification=t.debtJustification;groups[key].items.push(t);});
  (returnResolution.events||[]).forEach(function(e){Object.keys(groups).forEach(function(k){const g=groups[k];if(String(g.bankId||'UNKNOWN')===String(e.bankId||'UNKNOWN')&&String(g.entityKey||'')===String(e.entityKey||''))g.failedEvents.push(e);});});
  let summaries=Object.keys(groups).sort().map(function(k){return vfcSummarizeGroup_(groups[k],latest);}).filter(Boolean);summaries=vfcMergeGenericAmountMatches_(summaries);
  const sweepByBank={};credits.forEach(function(c){if(/\bLOAN\s+CREDIT\b/i.test(c.description))sweepByBank[c.bankId]=(sweepByBank[c.bankId]||0)+1;});const active=[],revolving=[],tax=[],other=[],inactive=[],once=[];
  summaries.forEach(function(g){if((sweepByBank[g.bankId]||0)>=2&&g.entityKey==='GENERIC_LOAN_PAYMENT'){revolving.push(g);return;}if(!g.recurring){once.push(g);return;}if(g.family==='FINANCING'||g.family==='MCA'||g.family==='PAD'){if(g.active)active.push(g);else once.push(g);}else if(g.family==='TAX'){if(g.active)tax.push(g);else inactive.push(g);}else{if(g.active)other.push(g);else inactive.push(g);}});
  const financing=vfcFinancingCredits_(credits,classified);active.sort(vfcObligationSort_);tax.sort(vfcObligationSort_);other.sort(vfcObligationSort_);const confirmed=active.reduce(function(s,x){return s+x.monthlyEquivalent;},0),info=tax.concat(other).reduce(function(s,x){return s+x.monthlyEquivalent;},0),warnings=[];
  if(other.some(function(x){return/^RESIDUAL_RECURRING_/.test(String(x.entityKey||''));}))warnings.push('Unclassified recurring outflows are shown as informational obligations and are not counted as debt without financing evidence.');if(revolving.length)warnings.push('Generic revolving loan sweep activity is excluded from fixed monthly debt.');if(returnedFinanceDebitsSuppressed)warnings.push(returnedFinanceDebitsSuppressed+' failed/returned obligation debit'+(returnedFinanceDebitsSuppressed===1?' was':'s were')+' excluded from recurrence calculations; the return event remains a risk fact.');if(probableRetryPaymentsLinked)warnings.push(probableRetryPaymentsLinked+' probable retry payment'+(probableRetryPaymentsLinked===1?' was':'s were')+' linked to a prior failed payment so the retry does not create an additional obligation.');if(inactive.length)warnings.push('Stale informational obligations are retained without a fabricated monthly equivalent.');if(financing.possible.length)warnings.push('Possible financing credits are shown separately and are not removed from operating deposits unless confirmed.');
  return{confirmedMonthlyDebtService:vfcRound_(confirmed,.01),informationalMonthlyObligations:vfcRound_(info,.01),activeDebtObligations:active,revolvingFinancingActivity:revolving,taxGovernmentPads:tax,otherRecurringObligations:other,inactiveInformationalObligations:inactive,observedOnce:once,allDetectedObligations:summaries,financingCredits:financing.confirmed,possibleFinancingCredits:financing.possible,financingCreditsTotal:vfcRound_(financing.total,.01),returnedCredits:returnedCredits,returnedCreditsTotal:vfcRound_(returnedCreditsTotal,.01),returnedFinanceDebitsSuppressed:returnedFinanceDebitsSuppressed,returnedObligationDebitsSuppressed:returnedFinanceDebitsSuppressed,probableRetryPaymentsLinked:probableRetryPaymentsLinked,returnedPaymentEvents:returnResolution.events,warnings:warnings};
}

/** Resolve failed-payment lifecycles generically before recurrence math.
 * A failed debit is suppressed when a nearby return/NSF/reversal credit can be tied to it.
 * A later similar debit to the same obligation may be linked as a probable retry, but remains
 * the successful payment used by recurrence logic.
 */
function vfcReturnedAmountTolerance_(a,b){
  a=vfcPos_(a);b=vfcPos_(b);return Math.max(2,Math.min(25,Math.min(a,b)*.005));
}
function vfcRetryAmountTolerance_(a,b){
  a=vfcPos_(a);b=vfcPos_(b);return Math.max(10,Math.min(150,Math.min(a,b)*.08));
}
function vfcEntitySimilarity_(a,b){
  a=a||{};b=b||{};
  const ak=String(a.entityKey||a.key||''),bk=String(b.entityKey||b.key||'');
  if(ak&&bk&&ak===bk)return 100;
  const at=vfcTokens_(a.label||a.counterparty||a.description),bt=vfcTokens_(b.label||b.counterparty||b.description);
  if(!at.length||!bt.length)return 0;
  let n=0;at.forEach(function(x){if(bt.indexOf(x)>=0)n++;});
  return Math.round(100*n/Math.max(1,Math.min(at.length,bt.length)));
}
function vfcResolveReturnedObligationDebits_(debits,credits){
  const allDebits=(debits||[]).slice(),creditReturns=(credits||[]).filter(function(c){return vfcIsReturnedObligationCredit_(c.bankId||'UNKNOWN',c);}),returnDebitIndexes={},debitReturnRows=[];
  allDebits.forEach(function(d,i){if(vfcIsGenericReturnedPaymentRow_(d)){returnDebitIndexes[i]=1;debitReturnRows.push(d);}});
  const returned=creditReturns.concat(debitReturnRows).slice().sort(function(a,b){return vfcTime_(a.date)-vfcTime_(b.date);}),suppressed={},events=[];
  returned.forEach(function(c){
    const cd=vfcDate_(c.date);if(!cd)return;
    const candidates=[];
    allDebits.forEach(function(d,i){
      if(returnDebitIndexes[i]||suppressed[i]||String(d.bankId||'UNKNOWN')!==String(c.bankId||'UNKNOWN'))return;
      const dd=vfcDate_(d.date);if(!dd)return;
      const days=(cd-dd)/86400000;if(days<0||days>5)return;
      const diff=Math.abs(vfcPos_(d.amount)-vfcPos_(c.amount)),tol=vfcReturnedAmountTolerance_(d.amount,c.amount);
      if(diff>tol)return;
      const classified=vfcClassifyObligationDebit_(d.bankId||'UNKNOWN',d);if(!classified)return;
      const ct=vfcTokens_(c.counterparty||c.description),dt=vfcTokens_(d.counterparty||d.description);
      let tokenOverlap=0;ct.forEach(function(x){if(dt.indexOf(x)>=0)tokenOverlap++;});
      const amountScore=diff<=.01?120:Math.max(20,80-Math.round(diff/Math.max(1,tol)*60));
      const dayScore=Math.max(0,25-Math.round(days*5));
      const tokenScore=tokenOverlap*10;
      candidates.push({index:i,debit:d,classified:classified,days:days,diff:diff,score:amountScore+dayScore+tokenScore});
    });
    if(!candidates.length)return;
    candidates.sort(function(a,b){return b.score-a.score||a.days-b.days||a.diff-b.diff||a.index-b.index;});
    const best=candidates[0],second=candidates[1];
    if(second&&best.score===second.score&&best.days===second.days&&Math.abs(best.diff-second.diff)<.001&&String(best.classified.entityKey||'')!==String(second.classified.entityKey||''))return;
    suppressed[best.index]=1;
    events.push({
      bankId:String(c.bankId||'UNKNOWN'),
      entityKey:String(best.classified.entityKey||best.classified.key||''),
      label:String(best.classified.label||best.debit.counterparty||best.debit.description||''),
      failedDebit:{date:best.debit.date,description:best.debit.description,counterparty:best.debit.counterparty||'',amount:vfcRound_(best.debit.amount,.01)},
      returnEvent:{date:c.date,description:c.description,counterparty:c.counterparty||'',direction:String(c.direction||''),amount:vfcRound_(c.amount,.01)},
      returnCredit:{date:c.date,description:c.description,counterparty:c.counterparty||'',direction:String(c.direction||''),amount:vfcRound_(c.amount,.01)},
      retryDebit:null
    });
  });
  // Return-marker rows themselves are never payment observations, even if intake froze their direction as DEBIT.
  const kept=allDebits.filter(function(d,i){return!returnDebitIndexes[i]&&!suppressed[i];});
  events.forEach(function(e){
    const returnDate=vfcDate_((e.returnEvent||e.returnCredit||{}).date);if(!returnDate)return;
    const failedAmount=vfcPos_(e.failedDebit&&e.failedDebit.amount),candidates=[];
    kept.forEach(function(d){
      if(String(d.bankId||'UNKNOWN')!==String(e.bankId||'UNKNOWN'))return;
      const dd=vfcDate_(d.date);if(!dd)return;
      const days=(dd-returnDate)/86400000;if(days<0||days>7)return;
      const classified=vfcClassifyObligationDebit_(d.bankId||'UNKNOWN',d);if(!classified)return;
      const similarity=vfcEntitySimilarity_({entityKey:e.entityKey,label:e.label},classified),diff=Math.abs(vfcPos_(d.amount)-failedAmount),tol=vfcRetryAmountTolerance_(d.amount,failedAmount);
      if(similarity<70||diff>tol)return;
      candidates.push({debit:d,classified:classified,days:days,diff:diff,similarity:similarity});
    });
    candidates.sort(function(a,b){return b.similarity-a.similarity||a.days-b.days||a.diff-b.diff;});
    if(candidates.length){
      const r=candidates[0].debit;
      e.retryDebit={date:r.date,description:r.description,counterparty:r.counterparty||'',amount:vfcRound_(r.amount,.01)};
    }
  });
  return{
    debits:kept,
    returnedCredits:vfcDedupeTx_(creditReturns),
    returnedRows:vfcDedupeTx_(returned),
    suppressedCount:Object.keys(suppressed).length,
    returnMarkerDebitsExcluded:Object.keys(returnDebitIndexes).length,
    retryLinkedCount:events.filter(function(e){return!!e.retryDebit;}).length,
    events:events
  };
}
/** Backward-compatible wrapper retained for callers outside BankingCore. */
function vfcSuppressReturnedFinanceDebits_(debits,credits){return vfcResolveReturnedObligationDebits_(debits,credits).debits;}

function vfcResidualRecurringLabel_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),cp=String(t&&t.counterparty||'').replace(/\s+/g,' ').trim();
  function meaningful(v){
    const x=String(v||'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    if(!x||/^\d+$/.test(x))return false;
    if(/^(MISC|MISC PAYMENT|PAYMENT|BILL PAYMENT|BUSINESS PAD|PAD|AUTO PAYMENT|ONLINE BANKING|ONLINE BANKING PAYMENT|ONLINE BANKING TRANSFER|TRANSFER|E TRANSFER|INTERAC|CHEQUE|ATM|PURCHASE|DEBIT|WITHDRAWAL|ACCOUNT PAYABLE PMT|ACCOUNT PAYABLE PAYMENT)$/.test(x))return false;
    return vfcTokens_(x).length>0;
  }
  if(meaningful(cp))return cp;
  let clean=raw
    .replace(/^MISC\s+PAYMENT\s*/i,'')
    .replace(/^BILL\s+PAYMENT\s*/i,'')
    .replace(/^BUSINESS\s+PAD\s*/i,'')
    .replace(/^AUTO\s+PAYMENT\s*/i,'')
    .replace(/^PRE[- ]?AUTH(?:ORIZED)?\s+(?:PAYMENT|DEBIT)?\s*/i,'')
    .replace(/^ONLINE\s+BANKING\s+PAYMENT\s*-?\s*\d*\s*/i,'')
    .replace(/^ACCOUNT\s+PAYABLE\s+(?:PMT|PAYMENT)\s*/i,'')
    .replace(/^E-?TRANSFER\s+SENT\s*/i,'')
    .replace(/^INTERAC\s+E-?TRANSFER\s*/i,'')
    .replace(/\s+/g,' ').trim();
  if(!meaningful(clean))return'';
  return clean;
}

function vfcResidualRecurringClassifyDebit_(bankId,t){
  if(!t||String(t.direction||'').toUpperCase()!=='DEBIT'||!(vfcPos_(t.amount)>0))return null;
  const raw=String(t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase();
  if(!raw)return null;
  // Never convert fees, returns, reversals, cash withdrawals, card purchases or bare cheque rows into residual obligations.
  if(/\bNSF\b|RETURNED|REVERSAL|REFUND|MONTHLY\s+FEE|TRANSACTION\s+FEE|SERVICE\s+CHARGE|OVERDRAFT\s+INTEREST|E-?TRANSFER\s+FEE/.test(s))return null;
  if(/^CHEQUE\b|^ATM\b|CASH\s+WITHDRAWAL|INTERAC\s+PURCHASE|CONTACTLESS\s+INTERAC\s+PURCHASE|\bPOS\s+PURCHASE\b/.test(s))return null;
  const cp=String(t.counterparty||'').replace(/\s+/g,' ').trim(),cpUpper=cp.toUpperCase();
  const genericTransferCp=!cp||/^(ONLINE\s+BANKING\s+TRANSFER|ONLINE\s+TRANSFER|BR\s+TO\s+BR|BANK\s+TRANSFER|TRANSFER)(?:\s*-\s*\d+)?$/.test(cpUpper);
  if((/^ONLINE\s+BANKING\s+TRANSFER\b|^BR\s+TO\s+BR\b|^BANK\s+TRANSFER\b/.test(s))&&genericTransferCp)return null;
  const label=vfcResidualRecurringLabel_(t);if(!label)return null;
  const key=vfcCounterpartyKey_(label);if(!key)return null;
  return Object.assign({},t,{
    family:'OTHER',
    entityKey:'RESIDUAL_RECURRING_'+String(bankId||'UNKNOWN').toUpperCase()+'_'+key,
    key:'RESIDUAL_RECURRING_'+String(bankId||'UNKNOWN').toUpperCase()+'_'+key,
    label:label,
    debtJustification:'Unclassified recurring outflow. It is surfaced as informational because recurrence can establish an obligation pattern, but no financing evidence is present.'
  });
}

function vfcCatchUpInstallmentBase_(items,failedEvents){
  const success=(items||[]).slice(),failed=(failedEvents||[]).map(function(e){
    const d=e&&e.failedDebit||{};
    return{date:String(d.date||''),amount:vfcPos_(d.amount),failed:true};
  }).filter(function(x){return x.date&&x.amount>0;});
  if(!failed.length||success.length<1)return null;
  const evidence=success.map(function(x){return{date:String(x.date||''),amount:vfcPos_(x.amount),failed:false};}).concat(failed);
  if(evidence.length<3)return null;
  const monthSet={};evidence.forEach(function(x){monthSet[String(x.date).slice(0,7)]=1;});
  if(Object.keys(monthSet).length<3)return null;
  const successMonthSet={};success.forEach(function(x){successMonthSet[String(x.date||'').slice(0,7)]=1;});
  if(success.length/Math.max(1,Object.keys(successMonthSet).length)>1.5)return null;

  const seeds=[];
  evidence.forEach(function(x){
    for(let n=1;n<=4;n++)seeds.push(x.amount/n);
  });
  let best=null;
  seeds.forEach(function(seed){
    if(!(seed>0))return;
    const matched=[];
    evidence.forEach(function(x){
      const ratio=x.amount/seed,n=Math.round(ratio);
      if(n<1||n>4)return;
      const normalized=x.amount/n,tol=Math.max(20,seed*.055);
      if(Math.abs(normalized-seed)>tol)return;
      matched.push({date:x.date,amount:x.amount,multiple:n,normalized:normalized,failed:x.failed});
    });
    if(matched.length<3)return;
    const direct=matched.filter(function(x){return x.multiple===1;}).length,multi=matched.filter(function(x){return x.multiple>=2;}).length,failedMatched=matched.filter(function(x){return x.failed;}).length;
    if(!direct||!multi||!failedMatched)return;
    const months={};matched.forEach(function(x){months[String(x.date).slice(0,7)]=1;});
    if(Object.keys(months).length<3)return;
    const base=vfcMedian_(matched.map(function(x){return x.normalized;}));
    const verified=matched.filter(function(x){return Math.abs(x.normalized-base)<=Math.max(20,base*.055);});
    if(verified.length<3)return;
    const vDirect=verified.filter(function(x){return x.multiple===1;}).length,vMulti=verified.filter(function(x){return x.multiple>=2;}).length,vFailed=verified.filter(function(x){return x.failed;}).length;
    if(!vDirect||!vMulti||!vFailed)return;
    const vMonths={};verified.forEach(function(x){vMonths[String(x.date).slice(0,7)]=1;});
    const score=Object.keys(vMonths).length*100+verified.length*20+vFailed*10+vDirect*5;
    if(!best||score>best.score||(score===best.score&&base<best.baseInstallment)){
      best={baseInstallment:base,score:score,evidence:verified};
    }
  });
  if(!best)return null;
  return{
    monthlyEquivalent:vfcRound_(best.baseInstallment,.01),
    baseInstallment:vfcRound_(best.baseInstallment,.01),
    evidenceCount:best.evidence.length,
    failedEvidenceCount:best.evidence.filter(function(x){return x.failed;}).length,
    multiples:best.evidence.map(function(x){return{date:x.date,amount:vfcRound_(x.amount,.01),multiple:x.multiple,failed:!!x.failed};})
  };
}

function vfcStableInstallmentComponents_(items,totalDistinctMonths){
  items=(items||[]).slice().sort(function(a,b){return vfcNum_(a.amount)-vfcNum_(b.amount);});
  totalDistinctMonths=Math.max(0,Number(totalDistinctMonths||0));
  if(items.length<2||totalDistinctMonths<2)return null;
  const avgOccurrencesPerMonth=items.length/Math.max(1,totalDistinctMonths);
  // High-frequency obligations (daily/weekly-style MCA or similar) must keep cadence math.
  if(avgOccurrencesPerMonth>3)return null;
  const clusters=[];
  items.forEach(function(item){
    const amount=vfcPos_(item.amount);if(!(amount>0))return;
    let best=null,bestDiff=Infinity;
    clusters.forEach(function(c){
      const center=vfcMedian_(c.items.map(function(x){return vfcPos_(x.amount);}));
      const tolerance=Math.max(15,center*.18),diff=Math.abs(amount-center);
      if(diff<=tolerance&&diff<bestDiff){best=c;bestDiff=diff;}
    });
    if(!best){best={items:[]};clusters.push(best);}best.items.push(item);
  });
  const requiredMonths=totalDistinctMonths<=2?totalDistinctMonths:Math.max(2,Math.ceil(totalDistinctMonths*.5));
  const eligible=clusters.map(function(c){
    const months={};c.items.forEach(function(x){months[String(x.date||'').slice(0,7)]=1;});
    const amounts=c.items.map(function(x){return vfcPos_(x.amount);});
    return{items:c.items,distinctMonths:Object.keys(months).length,averageAmount:vfcMean_(amounts),medianAmount:vfcMedian_(amounts)};
  }).filter(function(c){return c.distinctMonths>=requiredMonths;});
  if(!eligible.length)return null;
  const monthly=eligible.reduce(function(sum,c){return sum+c.averageAmount;},0);
  if(!(monthly>0))return null;
  return{
    monthlyEquivalent:vfcRound_(monthly,.01),
    componentCount:eligible.length,
    requiredMonths:requiredMonths,
    components:eligible.map(function(c){return{averageAmount:vfcRound_(c.averageAmount,.01),medianAmount:vfcRound_(c.medianAmount,.01),distinctMonths:c.distinctMonths,occurrences:c.items.length};})
  };
}

function vfcSummarizeGroup_(g,latestEnd){
  const items=(g.items||[]).slice().sort(function(a,b){return vfcTime_(a.date)-vfcTime_(b.date);});if(!items.length)return null;const amounts=items.map(function(x){return x.amount;}),months={};items.forEach(function(x){const m=x.date.slice(0,7);months[m]=(months[m]||0)+x.amount;});const distinct=Object.keys(months).length,occ=items.length,gaps=[];for(let i=1;i<items.length;i++)gaps.push((vfcDate_(items[i].date)-vfcDate_(items[i-1].date))/86400000);const medianGap=gaps.length?vfcMedian_(gaps):0,median=vfcMedian_(amounts),cv=vfcCv_(amounts),weeklyRatio=gaps.length?gaps.filter(function(x){return x>=5&&x<=10;}).length/gaps.length:0,biweeklyRatio=gaps.length?gaps.filter(function(x){return x>10&&x<=18;}).length/gaps.length:0,recurring=distinct>=2||occ>=3,daysSince=vfcDays_(items[items.length-1].date,latestEnd),active=daysSince===null?true:daysSince<=VFC_BANK_ENGINE.ACTIVE_DAYS,isFinance=(g.family==='FINANCING'||g.family==='MCA'||g.family==='PAD'),catchup=isFinance?vfcCatchUpInstallmentBase_(items,g.failedEvents||[]):null;let frequency='Observed statement-period cash flow',monthly=0,method='OBSERVED_ONLY',displayPayment=median;
  if(recurring&&medianGap>=5&&medianGap<=10&&occ>=4&&weeklyRatio>=.65){frequency='Weekly observed cadence';monthly=median*52/12;method='WEEKLY_MEDIAN';}else if(recurring&&medianGap>10&&medianGap<=18&&occ>=3&&biweeklyRatio>=.55){frequency='Biweekly observed cadence';monthly=median*26/12;method='BIWEEKLY_MEDIAN';}else if(recurring&&catchup){frequency='Catch-up normalized monthly installment';monthly=catchup.monthlyEquivalent;displayPayment=catchup.baseInstallment;method='CATCHUP_NORMALIZED_INSTALLMENT';}else if(recurring&&distinct>=2&&occ===distinct){frequency='Monthly observed cadence';monthly=cv<=.03?median:vfcMeanObject_(months);method=cv<=.03?'MONTHLY_MEDIAN':'MONTHLY_VARIABLE_MEAN';}else if(recurring){const stable=isFinance?vfcStableInstallmentComponents_(items,distinct):null;if(stable){frequency='Stable recurring installment component';monthly=stable.monthlyEquivalent;method='STABLE_INSTALLMENT_COMPONENTS';}else{frequency='Multiple payments per month';monthly=vfcRecentMonthAverage_(months,3);method='RECENT_3_MONTH_AVERAGE';}}
  if(!active&&!isFinance){monthly=0;method='STALE_INFORMATIONAL';}
  let why=String(g.debtJustification||'').trim();if(why&&recurring)why+=' Recurrence evidence: '+occ+' observed payment'+(occ===1?'':'s')+' across '+distinct+' month'+(distinct===1?'':'s')+'; '+frequency+'.';
  return{bankId:g.bankId||'',family:g.family,key:g.entityKey,entityKey:g.entityKey,counterparty:g.label,description:g.label,category:g.family==='FINANCING'?'LOAN':g.family,paymentAmount:vfcRound_(displayPayment,.01),averagePayment:vfcRound_(vfcMean_(amounts),.01),frequency:frequency,monthlyEquivalent:vfcRound_(monthly,.01),monthlyEquivalentMethod:method,catchUpNormalization:catchup||null,occurrences:occ,distinctMonths:distinct,firstSeen:items[0].date,lastSeen:items[items.length-1].date,daysSinceLastObserved:daysSince,active:active,recurring:recurring,confidence:!recurring?'Low':(distinct>=3?'High':'Moderate'),observedTotal:vfcRound_(vfcSum_(amounts),.01),observedMonthlyTotals:vfcSortedMoneyObject_(months),components:vfcAmountComponents_(items),debtJustification:why};
}

function runBankingCoreRecurrenceSelfTests(){
  const results=[];
  function test(name,fn){try{results.push({name:name,pass:true,detail:String(fn()||'')});}catch(e){results.push({name:name,pass:false,detail:String(e&&e.message||e)});}}
  function close(a,b,tol,label){tol=tol==null?.05:tol;if(Math.abs(Number(a||0)-Number(b||0))>tol)throw new Error((label||'value')+' expected '+b+' got '+a);}
  function item(date,amount){return{date:date,amount:amount};}
  test('Operating deposits exclude matched return even when frozen direction is debit',function(){
    const tx=[
      {bankId:'UNKNOWN',date:'2026-01-10',description:'Cheque returned NSF',counterparty:'',direction:'DEBIT',amount:2500}
    ];
    const debt={returnedPaymentEvents:[{
      bankId:'UNKNOWN',
      failedDebit:{date:'2026-01-10',description:'Loan payment ABC Finance',amount:2500},
      returnEvent:{date:'2026-01-10',description:'Cheque returned NSF',counterparty:'',direction:'DEBIT',amount:2500}
    }]};
    const r=vfcOperatingReversalRows_(tx,debt);
    if(r.length!==1)throw new Error('expected one operating-deposit reversal exclusion');
    close(r[0].amount,2500,.001,'direction-agnostic reversal amount');
    return r[0].amount;
  });
  test('Matched return is not double counted when already frozen as a credit',function(){
    const tx=[
      {bankId:'UNKNOWN',date:'2026-01-10',description:'Cheque returned NSF',counterparty:'',direction:'CREDIT',amount:2500}
    ];
    const debt={returnedPaymentEvents:[{
      bankId:'UNKNOWN',
      failedDebit:{date:'2026-01-10',description:'Loan payment ABC Finance',amount:2500},
      returnEvent:{date:'2026-01-10',description:'Cheque returned NSF',counterparty:'',direction:'CREDIT',amount:2500}
    }]};
    const r=vfcOperatingReversalRows_(tx,debt);
    if(r.length!==1)throw new Error('credit return was double counted');
    close(r[0].amount,2500,.001,'deduped reversal amount');
    return r[0].amount;
  });
  test('Returned-payment history normalizes accumulated catch-up multiples',function(){
    const items=[item('2025-09-29',2800),item('2025-12-29',8400)];
    const failed=[
      {failedDebit:{date:'2025-10-27',amount:2800}},
      {failedDebit:{date:'2025-11-27',amount:5600}}
    ];
    const r=vfcCatchUpInstallmentBase_(items,failed);
    if(!r)throw new Error('catch-up base not detected');
    close(r.monthlyEquivalent,2800,.05,'catch-up normalized installment');
    return r.monthlyEquivalent;
  });
  test('Variable monthly payments are not normalized without returned-payment evidence',function(){
    const r=vfcCatchUpInstallmentBase_([item('2026-01-10',1000),item('2026-02-10',2000)],[]);
    if(r!==null)throw new Error('catch-up normalization must require failed/returned evidence');
    return'not normalized';
  });
  test('Stable installment ignores isolated large catch-up payment',function(){
    const r=vfcStableInstallmentComponents_([item('2026-03-27',2578.34),item('2026-04-27',2656.97),item('2026-07-27',7952.39),item('2026-08-17',2285.91)],4);
    if(!r)throw new Error('stable component not detected');
    close(r.monthlyEquivalent,(2578.34+2656.97+2285.91)/3,.05,'stable installment');
    return r.monthlyEquivalent;
  });
  test('Stable smaller installment ignores one irregular first payment',function(){
    const r=vfcStableInstallmentComponents_([item('2026-06-20',502.45),item('2026-07-02',234.96),item('2026-08-04',234.96),item('2026-09-01',234.96)],4);
    if(!r)throw new Error('stable component not detected');
    close(r.monthlyEquivalent,234.96,.05,'stable smaller installment');
    return r.monthlyEquivalent;
  });
  test('High-frequency financing keeps cadence math instead of installment clustering',function(){
    const items=[];for(let m=1;m<=2;m++){for(let i=1;i<=8;i++)items.push(item('2026-0'+m+'-'+String(i*3).padStart(2,'0'),681.35));}
    const r=vfcStableInstallmentComponents_(items,2);
    if(r!==null)throw new Error('high-frequency payments must not use installment clustering');
    return'high-frequency preserved';
  });
  test('Two stable financing components under one entity are both retained',function(){
    const r=vfcStableInstallmentComponents_([item('2026-01-05',1000),item('2026-01-20',2000),item('2026-02-05',1000),item('2026-02-20',2000),item('2026-03-05',1000),item('2026-03-20',2000)],3);
    if(!r)throw new Error('stable components not detected');
    close(r.monthlyEquivalent,3000,.05,'two-component total');
    return r.monthlyEquivalent;
  });
  test('Unknown monthly counterparty becomes informational recurring obligation',function(){
    const rows=[
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-01-31',transactions:[{date:'2026-01-10',description:'Bill Payment ABC123',counterparty:'ABC123',direction:'DEBIT',amount:1250}]}},
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-02-28',transactions:[{date:'2026-02-10',description:'Bill Payment ABC123',counterparty:'ABC123',direction:'DEBIT',amount:1250}]}},
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-03-31',transactions:[{date:'2026-03-10',description:'Bill Payment ABC123',counterparty:'ABC123',direction:'DEBIT',amount:1250}]}}
    ];
    const d=vfcDebtProfile_(rows);
    close(d.confirmedMonthlyDebtService,0,.001,'confirmed debt');
    if(!d.otherRecurringObligations.length)throw new Error('residual recurring obligation not surfaced');
    close(d.otherRecurringObligations[0].monthlyEquivalent,1250,.05,'residual monthly equivalent');
    return d.otherRecurringObligations[0].counterparty;
  });
  test('Unknown weekly counterparty is informational, not debt',function(){
    const txs=[
      {date:'2026-01-05',description:'EFT XYZ SERVICE',counterparty:'XYZ SERVICE',direction:'DEBIT',amount:681},
      {date:'2026-01-12',description:'EFT XYZ SERVICE',counterparty:'XYZ SERVICE',direction:'DEBIT',amount:681},
      {date:'2026-01-19',description:'EFT XYZ SERVICE',counterparty:'XYZ SERVICE',direction:'DEBIT',amount:681},
      {date:'2026-01-26',description:'EFT XYZ SERVICE',counterparty:'XYZ SERVICE',direction:'DEBIT',amount:681},
      {date:'2026-02-02',description:'EFT XYZ SERVICE',counterparty:'XYZ SERVICE',direction:'DEBIT',amount:681}
    ];
    const d=vfcDebtProfile_([{payload:{bankId:'UNKNOWN',statementEndDate:'2026-02-28',transactions:txs}}]);
    close(d.confirmedMonthlyDebtService,0,.001,'confirmed debt');
    if(!d.otherRecurringObligations.length)throw new Error('weekly residual not surfaced');
    return d.otherRecurringObligations[0].frequency;
  });
  test('Generic NSF wording suppresses the failed obligation debit',function(){
    const debits=[{bankId:'UNKNOWN',date:'2026-01-10',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2500}];
    const credits=[{bankId:'UNKNOWN',date:'2026-01-11',description:'Cheque returned NSF',counterparty:'',direction:'CREDIT',amount:2500}];
    const r=vfcResolveReturnedObligationDebits_(debits,credits);
    if(r.debits.length!==0)throw new Error('failed debit was not suppressed');
    if(r.suppressedCount!==1)throw new Error('suppressed count expected 1 got '+r.suppressedCount);
    return'suppressed';
  });
  test('Returned-payment row is honored before recurrence even when frozen as a debit',function(){
    const rows=[
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-01-31',transactions:[{date:'2026-01-10',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2500}]}},
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-02-28',transactions:[
        {date:'2026-02-10',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2600},
        {date:'2026-02-10',description:'Cheque returned NSF',counterparty:'',direction:'DEBIT',amount:2600}
      ]}},
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-03-31',transactions:[{date:'2026-03-10',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2500}]}}
    ];
    const d=vfcDebtProfile_(rows);
    close(d.confirmedMonthlyDebtService,2500,.05,'monthly obligation after debit-coded return marker');
    if(d.returnedObligationDebitsSuppressed!==1)throw new Error('expected failed payment suppression');
    return d.confirmedMonthlyDebtService;
  });
  test('Retry replaces failed payment without increasing monthly obligation',function(){
    const rows=[
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-01-31',transactions:[{date:'2026-01-10',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2500}]}},
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-02-28',transactions:[
        {date:'2026-02-10',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2500},
        {date:'2026-02-11',description:'Payment returned NSF',counterparty:'',direction:'CREDIT',amount:2500},
        {date:'2026-02-13',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2525}
      ]}},
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-03-31',transactions:[{date:'2026-03-10',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2500}]}}
    ];
    const d=vfcDebtProfile_(rows);
    close(d.confirmedMonthlyDebtService,2500,.05,'monthly obligation after retry');
    if(d.returnedObligationDebitsSuppressed!==1)throw new Error('expected one failed debit suppressed');
    if(d.probableRetryPaymentsLinked!==1)throw new Error('expected one retry link');
    return d.confirmedMonthlyDebtService;
  });
  test('NSF fee alone never suppresses a payment',function(){
    const debits=[{bankId:'UNKNOWN',date:'2026-01-10',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2500}];
    const credits=[{bankId:'UNKNOWN',date:'2026-01-11',description:'NSF item fee reversal',counterparty:'',direction:'CREDIT',amount:45}];
    const r=vfcResolveReturnedObligationDebits_(debits,credits);
    if(r.debits.length!==1)throw new Error('valid payment was suppressed by fee');
    return'preserved';
  });
  test('ISO literal dates are idempotent and do not drift backward',function(){
    const d='2026-06-23';
    if(vfcIso_(d)!==d||vfcIso_(vfcIso_(d))!==d)throw new Error('ISO date drift detected');
    return d;
  });
  test('Printed deposit total can recover one debit-coded internal transfer credit exactly',function(){
    const rows=[{payload:{
      bankId:'RBC',
      totalDeposits:17887.46,
      transactions:[
        {date:'2026-06-22',description:'BR TO BR - 0863',counterparty:'BR TO BR',direction:'CREDIT',amount:7200},
        {date:'2026-06-23',description:'BR TO BR - 0863',counterparty:'BR TO BR',direction:'DEBIT',amount:4687.46},
        {date:'2026-06-26',description:'BR TO BR - 0863',counterparty:'BR TO BR',direction:'CREDIT',amount:6000}
      ]
    }}];
    const r=vfcRecoverMisdirectedTransferCredits_(rows);
    if(r.length!==1)throw new Error('expected one recovered transfer credit');
    close(r[0].amount,4687.46,.001,'recovered transfer');
    return r[0].amount;
  });
  test('Internal transfer direction is not guessed when printed deposit gap does not match exactly',function(){
    const rows=[{payload:{
      bankId:'RBC',
      totalDeposits:20000,
      transactions:[
        {date:'2026-06-22',description:'BR TO BR - 0863',counterparty:'BR TO BR',direction:'CREDIT',amount:7200},
        {date:'2026-06-23',description:'BR TO BR - 0863',counterparty:'BR TO BR',direction:'DEBIT',amount:4687.46},
        {date:'2026-06-26',description:'BR TO BR - 0863',counterparty:'BR TO BR',direction:'CREDIT',amount:6000}
      ]
    }}];
    const r=vfcRecoverMisdirectedTransferCredits_(rows);
    if(r.length!==0)throw new Error('transfer direction was guessed without exact reconciliation');
    return'not recovered';
  });
  test('Generic transfer-only rows do not become recurring obligations',function(){
    if(vfcResidualRecurringClassifyDebit_('UNKNOWN',{date:'2026-01-01',description:'Online Banking transfer - 4268',counterparty:'Online Banking transfer',direction:'DEBIT',amount:1000})!==null)throw new Error('generic online transfer classified');
    if(vfcResidualRecurringClassifyDebit_('UNKNOWN',{date:'2026-01-01',description:'BR TO BR - 2920',counterparty:'BR TO BR',direction:'DEBIT',amount:5000})!==null)throw new Error('bank-to-bank transfer classified');
    return'excluded';
  });
  test('Bare cheque and fee rows do not become residual obligations',function(){
    if(vfcResidualRecurringClassifyDebit_('UNKNOWN',{date:'2026-01-01',description:'Cheque - 123',counterparty:'',direction:'DEBIT',amount:900})!==null)throw new Error('bare cheque classified');
    if(vfcResidualRecurringClassifyDebit_('UNKNOWN',{date:'2026-01-01',description:'Monthly fee',counterparty:'',direction:'DEBIT',amount:15})!==null)throw new Error('fee classified');
    return'excluded';
  });
  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}

function vfcAmountComponents_(items){
  const clusters=[];(items||[]).slice().sort(function(a,b){return a.amount-b.amount;}).forEach(function(item){let best=null,bestDiff=Infinity;clusters.forEach(function(c){const center=vfcMedian_(c.map(function(x){return x.amount;})),tolerance=Math.max(12,center*(center<2000?.15:.065)),diff=Math.abs(item.amount-center);if(diff<=tolerance&&diff<bestDiff){best=c;bestDiff=diff;}});if(best)best.push(item);else clusters.push([item]);});
  return clusters.map(function(c,i){const a=c.map(function(x){return x.amount;}),m={};c.forEach(function(x){m[x.date.slice(0,7)]=1;});return{componentId:'C'+(i+1),representativeAmount:vfcRound_(vfcMedian_(a),.01),averageAmount:vfcRound_(vfcMean_(a),.01),minAmount:vfcRound_(Math.min.apply(null,a),.01),maxAmount:vfcRound_(Math.max.apply(null,a),.01),occurrences:a.length,distinctMonths:Object.keys(m).length};}).sort(function(a,b){return a.representativeAmount-b.representativeAmount;});
}

function vfcMergeGenericAmountMatches_(groups){
  const out=[];(groups||[]).forEach(function(g){if(vfcIsStrongEntityKey_(g.entityKey,g.family,g.bankId)){out.push(g);return;}let target=null;out.some(function(e){if(String(e.bankId||'')!==String(g.bankId||''))return false;if(vfcIsStrongEntityKey_(e.entityKey,e.family,e.bankId)||e.family!==g.family||e.frequency!==g.frequency)return false;const tolerance=Math.max(8,Math.min(e.paymentAmount,g.paymentAmount)*.02),em=Object.keys(e.observedMonthlyTotals||{}),gm=Object.keys(g.observedMonthlyTotals||{}),overlap=em.filter(function(m){return gm.indexOf(m)>=0;}).length/Math.max(1,Math.min(em.length,gm.length));if(Math.abs(e.paymentAmount-g.paymentAmount)<=tolerance&&Math.min(e.distinctMonths,g.distinctMonths)>=2&&overlap<=.20){target=e;return true;}return false;});if(!target){out.push(g);return;}target.description=target.description+' / '+g.description;target.counterparty=target.description;target.observedTotal=vfcRound_(target.observedTotal+g.observedTotal,.01);target.occurrences+=g.occurrences;target.confidence='High';target.mergedByAmountCadence=true;});return out;
}

function vfcFinancingCredits_(credits,debits){
  const confirmed=[],possible=[],financingDebits=(debits||[]).filter(function(d){return d&&(d.family==='FINANCING'||d.family==='MCA');});
  (credits||[]).forEach(function(c){const bankId=c.bankId||'UNKNOWN';if(vfcIsNonOperatingReversalCredit_(bankId,c))return;const s=String(c.description||'').toUpperCase(),amount=vfcPos_(c.amount);if(!(amount>0))return;const explicit=/\bLOAN\s+CREDIT\b|LOAN\s+ADVANCE|LOAN\s+PROCEEDS|FINANC(?:E|ING)\s+ADVANCE|FINANC(?:E|ING)\s+PROCEEDS|FUNDING\s+ADVANCE|MCA\s+ADVANCE|CSBFL\s+(?:LOAN\s+)?ADVANCE|CSBFL\s+PROCEEDS|MORTGAGE\s+(?:ADVANCE|PROCEEDS|FUNDING)|(?:\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE)\s+(?:ADVANCE|PROCEEDS|FUNDING)/.test(s),matched=vfcMatchedPaymentEntity_(c,financingDebits),known=vfcIsKnownFinancingCreditForBank_(bankId,c),item={bankId:bankId,date:c.date,description:c.description,counterparty:c.counterparty,amount:c.amount,direction:'CREDIT',occurrence:c.occurrence||1,linkedPaymentEntity:matched,confidence:(explicit||known||matched)?'High':'Moderate'};if(explicit||(amount>=5000&&known))confirmed.push(item);else if(amount>=5000&&(matched||/INVESTMENT|CAPITAL/.test(s)))possible.push(item);});
  const c=vfcDedupeTx_(confirmed),p=vfcDedupeTx_(possible);return{confirmed:c,possible:p,total:c.reduce(function(s,x){return s+x.amount;},0)};
}
function vfcMatchedPaymentEntity_(credit,debits){const ct=vfcTokens_(credit.counterparty||credit.description);if(!ct.length)return'';let found='';(debits||[]).some(function(d){const dt=vfcTokens_(d.counterparty||d.description);if(!dt.length)return false;let n=0;ct.forEach(function(a){if(dt.some(function(b){return a===b||(a.length>=4&&b.length>=4&&(a.indexOf(b)===0||b.indexOf(a)===0));}))n++;});if(n/Math.min(ct.length,dt.length)>=.5){found=d.entityKey||d.key||'';return true;}return false;});return found;}

function lockBankRegressionBaseline(companyName,period,bankId){bankId=String(bankId||'RBC').toUpperCase();const result=refreshDebtSignalsForPeriodSafe({companyName:companyName,period:period});if(!result.ok)throw new Error((result.errors||[]).join(' | '));const ss=SpreadsheetApp.getActiveSpreadsheet();let sh=ss.getSheetByName('BANK_REGRESSION_LOCKS');if(!sh){sh=ss.insertSheet('BANK_REGRESSION_LOCKS');sh.appendRow(['Company Name','Period','Bank','Result Fingerprint','Gross Monthly Deposits','Operating Monthly Deposits','Confirmed Monthly Debt','Financing Credits','Core Version','Locked At']);sh.setFrozenRows(1);}const values=sh.getDataRange().getValues();let rowNum=0;for(let i=1;i<values.length;i++)if(vfcSame_(values[i][0],companyName)&&vfcSame_(values[i][1],period)&&vfcSame_(values[i][2],bankId)){rowNum=i+1;break;}const b=result.bankingFeatures||{},row=[companyName,period,bankId,result.resultFingerprint,b.averageMonthlyDeposits||0,b.estimatedOperatingMonthlyDeposits||0,b.existingMonthlyDebtService||0,b.detectedFinancingCredits||0,VFC_BANK_ENGINE.VERSION,new Date()];if(rowNum)sh.getRange(rowNum,1,1,row.length).setValues([row]);else sh.appendRow(row);return{ok:true,locked:true,resultFingerprint:result.resultFingerprint};}
function verifyBankRegressionBaseline(companyName,period,bankId){bankId=String(bankId||'RBC').toUpperCase();const result=refreshDebtSignalsForPeriodSafe({companyName:companyName,period:period});if(!result.ok)return result;const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BANK_REGRESSION_LOCKS');if(!sh||sh.getLastRow()<2)return{ok:false,error:'No regression baseline is locked.'};const values=sh.getDataRange().getValues();for(let i=1;i<values.length;i++)if(vfcSame_(values[i][0],companyName)&&vfcSame_(values[i][1],period)&&vfcSame_(values[i][2],bankId)){const expected=String(values[i][3]||'');return{ok:true,match:expected===result.resultFingerprint,expectedFingerprint:expected,actualFingerprint:result.resultFingerprint};}return{ok:false,error:'No matching regression baseline is locked.'};}
function vfcResultFingerprint_(f){const d=f.debtProfile||{},canonical={statementCount:f.statementCount||0,totalDeposits:vfcRound_(f.totalDeposits||0,.01),averageMonthlyDeposits:vfcRound_(f.averageMonthlyDeposits||0,.01),estimatedOperatingMonthlyDeposits:vfcRound_(f.estimatedOperatingMonthlyDeposits||0,.01),detectedFinancingCredits:vfcRound_(f.detectedFinancingCredits||0,.01),existingMonthlyDebtService:vfcRound_(f.existingMonthlyDebtService||0,.01),nsfPerMonth:vfcRound_(f.nsfPerMonth||0,.01),negativeBalanceFlag:f.negativeBalanceFlag||0,overdraftFlag:f.overdraftFlag||0,returnedPaymentFlag:f.returnedPaymentFlag||0,suspectedStacking:f.suspectedStacking||0,depositTrend:vfcRound_(f.depositTrend||0,.01),depositVolatility:vfcRound_(f.depositVolatility||0,.01),debt:(d.activeDebtObligations||[]).map(function(x){return[x.bankId||'',x.entityKey,x.monthlyEquivalent,x.frequency,x.paymentAmount,x.lastSeen];}),revolving:(d.revolvingFinancingActivity||[]).map(function(x){return[x.bankId||'',x.entityKey,x.monthlyEquivalent,x.frequency,x.paymentAmount,x.lastSeen];}),info:(d.otherRecurringObligations||[]).map(function(x){return[x.bankId||'',x.entityKey,x.monthlyEquivalent,x.frequency,x.paymentAmount,x.lastSeen];}),financing:(d.financingCredits||[]).map(function(x){return[x.date,x.amount,x.description];}),possibleFinancing:(d.possibleFinancingCredits||[]).map(function(x){return[x.date,x.amount,x.description];})};return vfcDigest_(JSON.stringify(canonical));}

function vfcBaseFeatures_(companyName,period){if(typeof buildPowerFeatures_==='function')return buildPowerFeatures_(companyName,period);if(typeof buildFeaturesForCase_==='function')return buildFeaturesForCase_(companyName,period);return null;}
function vfcRequest_(a,p){return a&&typeof a==='object'?{companyName:String(a.companyName||'').trim(),period:String(a.period||p||'').trim()}:{companyName:String(a||'').trim(),period:String(p||'').trim()};}
function vfcHeader_(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'');}
function vfcSame_(a,b){return String(a||'').trim().toLowerCase()===String(b||'').trim().toLowerCase();}
function vfcNum_(v){const n=Number(String(v==null?'':v).replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:0;}
function vfcNumNull_(v){if(v===null||v===undefined||v==='')return null;const n=Number(String(v).replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:null;}
function vfcPos_(v){return Math.max(0,vfcNum_(v));}
function vfcBool_(v){return/^(true|yes|y|1)$/i.test(String(v||'').trim())||/negative/i.test(String(v||''));}
function vfcRound_(v,step){step=step||.01;return Math.round((v+Number.EPSILON)/step)*step;}
function vfcDate_(v){if(!v)return null;const d=v instanceof Date?v:new Date(v);return isNaN(d.getTime())?null:d;}
function vfcIso_(v){const raw=String(v==null?'':v).trim();if(/^\d{4}-\d{2}-\d{2}$/.test(raw))return raw;const d=vfcDate_(v);if(!d)return'';return Utilities.formatDate(d,Session.getScriptTimeZone()||'GMT','yyyy-MM-dd');}
function vfcTime_(v){const d=vfcDate_(v);return d?d.getTime():0;}
function vfcSum_(a){return(a||[]).reduce(function(s,x){return s+vfcNum_(x);},0);}
function vfcMean_(a){return a&&a.length?vfcSum_(a)/a.length:0;}
function vfcMedian_(a){const x=(a||[]).slice().sort(function(m,n){return m-n;});if(!x.length)return 0;const k=Math.floor(x.length/2);return x.length%2?x[k]:(x[k-1]+x[k])/2;}
function vfcStdDev_(a){if(!a||!a.length)return 0;const m=vfcMean_(a);return Math.sqrt(a.reduce(function(s,x){return s+Math.pow(x-m,2);},0)/a.length);}
function vfcCv_(a){const m=vfcMean_(a);return m?vfcStdDev_(a)/m:0;}
function vfcTrend_(a){if(!a||a.length<2)return 0;const first=a[0],last=a[a.length-1],den=Math.max(Math.abs(first),1);return(last-first)/den;}
function vfcDays_(a,b){const da=vfcDate_(a),db=vfcDate_(b);return!da||!db?null:Math.max(0,Math.round((db-da)/86400000));}
function vfcMeanObject_(o){const k=Object.keys(o||{});return k.length?k.reduce(function(s,x){return s+vfcNum_(o[x]);},0)/k.length:0;}
function vfcRecentMonthAverage_(o,n){const k=Object.keys(o||{}).sort().slice(-Math.max(1,n||3));return k.length?k.reduce(function(s,x){return s+vfcNum_(o[x]);},0)/k.length:0;}
function vfcSortedMoneyObject_(o){const out={};Object.keys(o||{}).sort().forEach(function(k){out[k]=vfcRound_(o[k],.01);});return out;}
function vfcObligationSort_(a,b){return(b.monthlyEquivalent||0)-(a.monthlyEquivalent||0)||String(a.counterparty||'').localeCompare(String(b.counterparty||''));}
function vfcDedupeTx_(a){const out=[],seen={};(a||[]).forEach(function(t){const k=[t.bankId||'',t.date,t.direction,t.amount,String(t.description||'').toUpperCase(),t.occurrence||1].join('|');if(!seen[k]){seen[k]=1;out.push(t);}});return out;}
function vfcTokens_(s){const stop={BUSINESS:1,INVESTMENT:1,PAD:1,PAYMENT:1,LOAN:1,CREDIT:1,DEBIT:1,THE:1,INC:1,LTD:1,CORP:1,CORPORATION:1,COMPANY:1,'001':1};return String(s||'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').split(/\s+/).filter(function(x){return x.length>=3&&!stop[x]&&!/^\d+$/.test(x);});}
function vfcCounterpartyKey_(s){const t=vfcTokens_(s);return t.slice(0,4).join('_')||String(s||'').toUpperCase().replace(/[^A-Z0-9]+/g,'_').slice(0,60);}
function vfcIsStrongEntityKey_(key,family,bankId){const k=String(key||'').toUpperCase();return/^LOAN(_INTEREST)?_[0-9]/.test(k)||/^INSURANCE_/.test(k)||/^RESIDUAL_RECURRING_/.test(k)||vfcBankStrongEntityKey_(bankId,k,family);}
function vfcDigest_(s){const bytes=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(s||''),Utilities.Charset.UTF_8);return bytes.map(function(b){const v=(b<0?b+256:b).toString(16);return v.length===1?'0'+v:v;}).join('').substring(0,24);}+vfcRound_(transferCreditsTotal,.01)+' are excluded from estimated operating deposits. Generic customer e-Transfers are not excluded unless the bank-specific rules identify them as internal transfers.');if(recoveredTransferCredits.length)inputWarnings.push('Recovered '+recoveredTransferCredits.length+' internal-transfer credit'+(recoveredTransferCredits.length===1?'':'s')+' from a frozen debit/credit direction mismatch because the amount exactly reconciled the printed statement deposit total.');
  const isolation=rows.length&&rows[0].row&&rows[0].row.borrowerIsolation?rows[0].row.borrowerIsolation:null;
  if(isolation&&isolation.excludedStatementCount)inputWarnings.push('Borrower isolation excluded '+isolation.excludedStatementCount+' statement set'+(isolation.excludedStatementCount===1?'':'s')+' belonging to other account holder(s); selected holder: '+isolation.selectedHolder+'.');
  audit.forEach(function(a){if(a.duplicateRowsCollapsed)inputWarnings.push(a.fileName+': '+a.duplicateRowsCollapsed+' older re-upload row'+(a.duplicateRowsCollapsed===1?' was':'s were')+' collapsed into this logical statement before underwriting.');if((vfcNum_(a.totalDeposits)>0||vfcNum_(a.totalWithdrawals)>0)&&a.transactionCount===0)inputWarnings.push(a.fileName+': statement totals were present but no transaction rows were frozen; recurring-payment analysis may be incomplete.');});
  const result=Object.assign({},base,{statementCount:rows.length,monthsCovered:rows.length,totalDeposits:vfcRound_(totalDeposits,.01),averageMonthlyDeposits:vfcRound_(grossMonthly,.01),totalWithdrawals:vfcRound_(totalWithdrawals,.01),depositWithdrawalRatio:totalWithdrawals?vfcRound_(totalDeposits/totalWithdrawals,.01):0,averageOpeningBalance:vfcRound_(vfcMean_(openings),.01),averageClosingBalance:vfcRound_(vfcMean_(closings),.01),depositVolatility:vfcRound_(avgDep?vfcStdDev_(monthlyDeposits)/avgDep:1,.01),depositTrend:vfcRound_(vfcTrend_(monthlyDeposits),.01),nsfCount:nsf,nsfPerMonth:vfcRound_(nsf/months,.01),negativeBalanceFlag:negative,overdraftFlag:overdraftFlag,returnedPaymentFlag:returnedFlag,suspectedStacking:stackingFlag,missingInfoFlag:0,mcaPaymentFlag:debt.activeDebtObligations.length?1:0,monthlyDeposits:monthlyDeposits.slice(),monthlyWithdrawals:monthlyWithdrawals.slice(),estimatedOperatingTotalDeposits:vfcRound_(operatingTotal,.01),estimatedOperatingMonthlyDeposits:vfcRound_(operatingTotal/months,.01),detectedFinancingCredits:vfcRound_(debt.financingCreditsTotal,.01),excludedReversalCredits:vfcRound_(reversalCreditsTotal,.01),excludedReversalCreditTransactions:reversalCredits,excludedTransferCredits:vfcRound_(transferCreditsTotal,.01),excludedTransferCreditTransactions:transferCredits,existingMonthlyDebtService:vfcRound_(debt.confirmedMonthlyDebtService,.01),informationalRecurringMonthlyObligations:vfcRound_(debt.informationalMonthlyObligations,.01),otherRecurringMonthlyObligations:vfcRound_(debt.informationalMonthlyObligations,.01),debtServiceToDepositsRatio:grossMonthly?vfcRound_(debt.confirmedMonthlyDebtService/grossMonthly,.0001):0,debtProfile:debt,inputQualityAudit:{modelVersion:VFC_BANK_ENGINE.VERSION,intakeContract:VFC_BANK_ENGINE.INTAKE_CONTRACT,verified:true,statementAudit:audit,selectedStatementCount:rows.length,excludedReversalCredits:vfcRound_(reversalCreditsTotal,.01),excludedTransferCredits:vfcRound_(transferCreditsTotal,.01),warnings:inputWarnings}});
  result.resultFingerprint=vfcResultFingerprint_(result);result.inputQualityAudit.resultFingerprint=result.resultFingerprint;return result;
}

function vfcIsGenericReturnedPaymentRow_(t){
  if(!t)return false;
  const s=String(t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s)return false;
  if(/\bFEE\b|\bCHARGE\b|\bPENALTY\b/.test(s))return false;
  return /CHEQUE\s+RETURNED(?:\s+NSF)?|CHECK\s+RETURNED(?:\s+NSF)?|ITEM\s+RETURNED(?:\s+NSF|\s+UNPAID)?|RETURNED\s+ITEM|RETURNED\s+PAYMENT|PAYMENT\s+RETURNED|RETURNED\s+UNPAID|NSF\s+(?:ITEM\s+)?RETURN|DEBIT\s+RETURNED|PAD\s+RETURNED|PRE[- ]?AUTH(?:ORIZED)?[^\n]{0,20}RETURN|ACH\s+RETURN|\bREVERSAL\b/.test(s);
}
function vfcIsGenericReturnedPaymentCredit_(t){return!!(t&&String(t.direction||'').toUpperCase()==='CREDIT'&&vfcIsGenericReturnedPaymentRow_(t));}
function vfcIsReturnedObligationCredit_(bankId,t){return vfcIsGenericReturnedPaymentCredit_(t)||vfcBankIsReturnedFinancingCredit_(bankId||'UNKNOWN',t);}
function vfcIsNonOperatingReversalCredit_(bankId,t){return vfcIsGenericReturnedPaymentCredit_(t)||vfcBankIsNonOperatingReversalCredit_(bankId||'UNKNOWN',t);}
function vfcClassifyObligationDebit_(bankId,t){return vfcClassifyDebitForBank_(bankId||'UNKNOWN',t)||vfcResidualRecurringClassifyDebit_(bankId||'UNKNOWN',t);}
function vfcNonOperatingReversalCredits_(transactions){const out=(transactions||[]).filter(function(t){return String(t.direction||'').toUpperCase()==='CREDIT'&&vfcIsNonOperatingReversalCredit_(t.bankId||'UNKNOWN',t);});return vfcDedupeTx_(out);}
function vfcOperatingReversalRows_(transactions,debtProfile){
  const out=vfcNonOperatingReversalCredits_(transactions).slice(),seen={};
  function key(t){
    return[
      String(t&&t.bankId||'UNKNOWN').toUpperCase(),
      String(t&&t.date||''),
      vfcRound_(vfcPos_(t&&t.amount),.01),
      String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim()
    ].join('|');
  }
  out.forEach(function(t){seen[key(t)]=1;});
  ((debtProfile&&debtProfile.returnedPaymentEvents)||[]).forEach(function(e){
    const r=(e&&e.returnEvent)|| (e&&e.returnCredit)||{};
    if(!e||!e.failedDebit||!(vfcPos_(r.amount)>0)||!r.date)return;
    const item={
      bankId:String(e.bankId||'UNKNOWN'),
      date:String(r.date||''),
      description:String(r.description||''),
      counterparty:String(r.counterparty||''),
      direction:String(r.direction||'').toUpperCase()||'RETURN',
      amount:vfcRound_(vfcPos_(r.amount),.01),
      matchedReturnedObligation:true
    },k=key(item);
    if(seen[k])return;
    seen[k]=1;out.push(item);
  });
  return out.sort(function(a,b){return vfcTime_(a.date)-vfcTime_(b.date)||vfcPos_(a.amount)-vfcPos_(b.amount);});
}
function vfcNonOperatingTransferCredits_(transactions){
  const out=(transactions||[]).filter(function(t){const bankId=t.bankId||'UNKNOWN';return String(t.direction||'').toUpperCase()==='CREDIT'&&!vfcIsNonOperatingReversalCredit_(bankId,t)&&!vfcIsKnownFinancingCreditForBank_(bankId,t)&&vfcBankIsNonOperatingTransferCredit_(bankId,t);});
  return vfcDedupeTx_(out);
}
function vfcStrongInternalTransferRow_(bankId,t){
  if(!t)return false;
  const probe=Object.assign({},t,{direction:'CREDIT'});
  return !vfcIsKnownFinancingCreditForBank_(bankId||'UNKNOWN',probe)&&
         !vfcIsNonOperatingReversalCredit_(bankId||'UNKNOWN',probe)&&
         vfcBankIsNonOperatingTransferCredit_(bankId||'UNKNOWN',probe);
}
function vfcUniqueExactTransferSubset_(candidates,target){
  target=vfcRound_(vfcPos_(target),.01);if(!(target>0)||!candidates||!candidates.length)return[];
  const tol=.05,solutions=[],n=Math.min(candidates.length,14);
  function walk(i,total,picked){
    if(solutions.length>1)return;
    if(Math.abs(total-target)<=tol){solutions.push(picked.slice());return;}
    if(i>=n||total>target+tol)return;
    walk(i+1,total,picked);
    picked.push(candidates[i]);walk(i+1,total+vfcPos_(candidates[i].amount),picked);picked.pop();
  }
  walk(0,0,[]);
  return solutions.length===1?solutions[0]:[];
}
function vfcRecoverMisdirectedTransferCredits_(rows){
  const recovered=[];
  (rows||[]).forEach(function(x){
    const p=x&&x.payload;if(!p||!Array.isArray(p.transactions))return;
    const bankId=String(p.bankId||'UNKNOWN').toUpperCase(),printed=vfcPos_(p.totalDeposits);
    const frozenCredits=p.transactions.filter(function(t){return String(t.direction||'').toUpperCase()==='CREDIT';});
    const frozenCreditTotal=frozenCredits.reduce(function(sum,t){return sum+vfcPos_(t.amount);},0);
    const gap=vfcRound_(printed-frozenCreditTotal,.01);
    if(!(gap>.05))return;
    const candidates=p.transactions.filter(function(t){
      return String(t.direction||'').toUpperCase()==='DEBIT'&&vfcStrongInternalTransferRow_(bankId,t);
    });
    const matched=vfcUniqueExactTransferSubset_(candidates,gap);
    matched.forEach(function(t){
      recovered.push(Object.assign({},t,{
        bankId:bankId,
        direction:'CREDIT',
        recoveredFromDirectionMismatch:true,
        originalDirection:'DEBIT'
      }));
    });
  });
  return vfcDedupeTx_(recovered);
}

function vfcDebtProfile_(rows){
  let tx=[],latest='';rows.forEach(function(x){if(!latest||vfcTime_(x.payload.statementEndDate)>vfcTime_(latest))latest=x.payload.statementEndDate;(x.payload.transactions||[]).forEach(function(t){tx.push(Object.assign({bankId:x.payload.bankId||'UNKNOWN'},t));});});
  tx=vfcDedupeTx_(tx);const rawDebits=tx.filter(function(t){return t.direction==='DEBIT';}),credits=tx.filter(function(t){return t.direction==='CREDIT';}),returnResolution=vfcResolveReturnedObligationDebits_(rawDebits,credits),returnedCredits=returnResolution.returnedCredits,returnedCreditsTotal=returnedCredits.reduce(function(s,c){return s+vfcPos_(c.amount);},0),debits=returnResolution.debits,returnedFinanceDebitsSuppressed=returnResolution.suppressedCount,probableRetryPaymentsLinked=returnResolution.retryLinkedCount,classified=debits.map(function(t){return vfcClassifyObligationDebit_(t.bankId,t);}).filter(Boolean),groups={};
  classified.forEach(function(t){const key=t.bankId+'|'+t.family+'|'+t.entityKey;if(!groups[key])groups[key]={bankId:t.bankId,family:t.family,entityKey:t.entityKey,label:t.label,debtJustification:t.debtJustification||'',items:[],failedEvents:[]};if(!groups[key].debtJustification&&t.debtJustification)groups[key].debtJustification=t.debtJustification;groups[key].items.push(t);});
  (returnResolution.events||[]).forEach(function(e){Object.keys(groups).forEach(function(k){const g=groups[k];if(String(g.bankId||'UNKNOWN')===String(e.bankId||'UNKNOWN')&&String(g.entityKey||'')===String(e.entityKey||''))g.failedEvents.push(e);});});
  let summaries=Object.keys(groups).sort().map(function(k){return vfcSummarizeGroup_(groups[k],latest);}).filter(Boolean);summaries=vfcMergeGenericAmountMatches_(summaries);
  const sweepByBank={};credits.forEach(function(c){if(/\bLOAN\s+CREDIT\b/i.test(c.description))sweepByBank[c.bankId]=(sweepByBank[c.bankId]||0)+1;});const active=[],revolving=[],tax=[],other=[],inactive=[],once=[];
  summaries.forEach(function(g){if((sweepByBank[g.bankId]||0)>=2&&g.entityKey==='GENERIC_LOAN_PAYMENT'){revolving.push(g);return;}if(!g.recurring){once.push(g);return;}if(g.family==='FINANCING'||g.family==='MCA'||g.family==='PAD'){if(g.active)active.push(g);else once.push(g);}else if(g.family==='TAX'){if(g.active)tax.push(g);else inactive.push(g);}else{if(g.active)other.push(g);else inactive.push(g);}});
  const financing=vfcFinancingCredits_(credits,classified);active.sort(vfcObligationSort_);tax.sort(vfcObligationSort_);other.sort(vfcObligationSort_);const confirmed=active.reduce(function(s,x){return s+x.monthlyEquivalent;},0),info=tax.concat(other).reduce(function(s,x){return s+x.monthlyEquivalent;},0),warnings=[];
  if(other.some(function(x){return/^RESIDUAL_RECURRING_/.test(String(x.entityKey||''));}))warnings.push('Unclassified recurring outflows are shown as informational obligations and are not counted as debt without financing evidence.');if(revolving.length)warnings.push('Generic revolving loan sweep activity is excluded from fixed monthly debt.');if(returnedFinanceDebitsSuppressed)warnings.push(returnedFinanceDebitsSuppressed+' failed/returned obligation debit'+(returnedFinanceDebitsSuppressed===1?' was':'s were')+' excluded from recurrence calculations; the return event remains a risk fact.');if(probableRetryPaymentsLinked)warnings.push(probableRetryPaymentsLinked+' probable retry payment'+(probableRetryPaymentsLinked===1?' was':'s were')+' linked to a prior failed payment so the retry does not create an additional obligation.');if(inactive.length)warnings.push('Stale informational obligations are retained without a fabricated monthly equivalent.');if(financing.possible.length)warnings.push('Possible financing credits are shown separately and are not removed from operating deposits unless confirmed.');
  return{confirmedMonthlyDebtService:vfcRound_(confirmed,.01),informationalMonthlyObligations:vfcRound_(info,.01),activeDebtObligations:active,revolvingFinancingActivity:revolving,taxGovernmentPads:tax,otherRecurringObligations:other,inactiveInformationalObligations:inactive,observedOnce:once,allDetectedObligations:summaries,financingCredits:financing.confirmed,possibleFinancingCredits:financing.possible,financingCreditsTotal:vfcRound_(financing.total,.01),returnedCredits:returnedCredits,returnedCreditsTotal:vfcRound_(returnedCreditsTotal,.01),returnedFinanceDebitsSuppressed:returnedFinanceDebitsSuppressed,returnedObligationDebitsSuppressed:returnedFinanceDebitsSuppressed,probableRetryPaymentsLinked:probableRetryPaymentsLinked,returnedPaymentEvents:returnResolution.events,warnings:warnings};
}

/** Resolve failed-payment lifecycles generically before recurrence math.
 * A failed debit is suppressed when a nearby return/NSF/reversal credit can be tied to it.
 * A later similar debit to the same obligation may be linked as a probable retry, but remains
 * the successful payment used by recurrence logic.
 */
function vfcReturnedAmountTolerance_(a,b){
  a=vfcPos_(a);b=vfcPos_(b);return Math.max(2,Math.min(25,Math.min(a,b)*.005));
}
function vfcRetryAmountTolerance_(a,b){
  a=vfcPos_(a);b=vfcPos_(b);return Math.max(10,Math.min(150,Math.min(a,b)*.08));
}
function vfcEntitySimilarity_(a,b){
  a=a||{};b=b||{};
  const ak=String(a.entityKey||a.key||''),bk=String(b.entityKey||b.key||'');
  if(ak&&bk&&ak===bk)return 100;
  const at=vfcTokens_(a.label||a.counterparty||a.description),bt=vfcTokens_(b.label||b.counterparty||b.description);
  if(!at.length||!bt.length)return 0;
  let n=0;at.forEach(function(x){if(bt.indexOf(x)>=0)n++;});
  return Math.round(100*n/Math.max(1,Math.min(at.length,bt.length)));
}
function vfcResolveReturnedObligationDebits_(debits,credits){
  const allDebits=(debits||[]).slice(),creditReturns=(credits||[]).filter(function(c){return vfcIsReturnedObligationCredit_(c.bankId||'UNKNOWN',c);}),returnDebitIndexes={},debitReturnRows=[];
  allDebits.forEach(function(d,i){if(vfcIsGenericReturnedPaymentRow_(d)){returnDebitIndexes[i]=1;debitReturnRows.push(d);}});
  const returned=creditReturns.concat(debitReturnRows).slice().sort(function(a,b){return vfcTime_(a.date)-vfcTime_(b.date);}),suppressed={},events=[];
  returned.forEach(function(c){
    const cd=vfcDate_(c.date);if(!cd)return;
    const candidates=[];
    allDebits.forEach(function(d,i){
      if(returnDebitIndexes[i]||suppressed[i]||String(d.bankId||'UNKNOWN')!==String(c.bankId||'UNKNOWN'))return;
      const dd=vfcDate_(d.date);if(!dd)return;
      const days=(cd-dd)/86400000;if(days<0||days>5)return;
      const diff=Math.abs(vfcPos_(d.amount)-vfcPos_(c.amount)),tol=vfcReturnedAmountTolerance_(d.amount,c.amount);
      if(diff>tol)return;
      const classified=vfcClassifyObligationDebit_(d.bankId||'UNKNOWN',d);if(!classified)return;
      const ct=vfcTokens_(c.counterparty||c.description),dt=vfcTokens_(d.counterparty||d.description);
      let tokenOverlap=0;ct.forEach(function(x){if(dt.indexOf(x)>=0)tokenOverlap++;});
      const amountScore=diff<=.01?120:Math.max(20,80-Math.round(diff/Math.max(1,tol)*60));
      const dayScore=Math.max(0,25-Math.round(days*5));
      const tokenScore=tokenOverlap*10;
      candidates.push({index:i,debit:d,classified:classified,days:days,diff:diff,score:amountScore+dayScore+tokenScore});
    });
    if(!candidates.length)return;
    candidates.sort(function(a,b){return b.score-a.score||a.days-b.days||a.diff-b.diff||a.index-b.index;});
    const best=candidates[0],second=candidates[1];
    if(second&&best.score===second.score&&best.days===second.days&&Math.abs(best.diff-second.diff)<.001&&String(best.classified.entityKey||'')!==String(second.classified.entityKey||''))return;
    suppressed[best.index]=1;
    events.push({
      bankId:String(c.bankId||'UNKNOWN'),
      entityKey:String(best.classified.entityKey||best.classified.key||''),
      label:String(best.classified.label||best.debit.counterparty||best.debit.description||''),
      failedDebit:{date:best.debit.date,description:best.debit.description,counterparty:best.debit.counterparty||'',amount:vfcRound_(best.debit.amount,.01)},
      returnEvent:{date:c.date,description:c.description,counterparty:c.counterparty||'',direction:String(c.direction||''),amount:vfcRound_(c.amount,.01)},
      returnCredit:{date:c.date,description:c.description,counterparty:c.counterparty||'',direction:String(c.direction||''),amount:vfcRound_(c.amount,.01)},
      retryDebit:null
    });
  });
  // Return-marker rows themselves are never payment observations, even if intake froze their direction as DEBIT.
  const kept=allDebits.filter(function(d,i){return!returnDebitIndexes[i]&&!suppressed[i];});
  events.forEach(function(e){
    const returnDate=vfcDate_((e.returnEvent||e.returnCredit||{}).date);if(!returnDate)return;
    const failedAmount=vfcPos_(e.failedDebit&&e.failedDebit.amount),candidates=[];
    kept.forEach(function(d){
      if(String(d.bankId||'UNKNOWN')!==String(e.bankId||'UNKNOWN'))return;
      const dd=vfcDate_(d.date);if(!dd)return;
      const days=(dd-returnDate)/86400000;if(days<0||days>7)return;
      const classified=vfcClassifyObligationDebit_(d.bankId||'UNKNOWN',d);if(!classified)return;
      const similarity=vfcEntitySimilarity_({entityKey:e.entityKey,label:e.label},classified),diff=Math.abs(vfcPos_(d.amount)-failedAmount),tol=vfcRetryAmountTolerance_(d.amount,failedAmount);
      if(similarity<70||diff>tol)return;
      candidates.push({debit:d,classified:classified,days:days,diff:diff,similarity:similarity});
    });
    candidates.sort(function(a,b){return b.similarity-a.similarity||a.days-b.days||a.diff-b.diff;});
    if(candidates.length){
      const r=candidates[0].debit;
      e.retryDebit={date:r.date,description:r.description,counterparty:r.counterparty||'',amount:vfcRound_(r.amount,.01)};
    }
  });
  return{
    debits:kept,
    returnedCredits:vfcDedupeTx_(creditReturns),
    returnedRows:vfcDedupeTx_(returned),
    suppressedCount:Object.keys(suppressed).length,
    returnMarkerDebitsExcluded:Object.keys(returnDebitIndexes).length,
    retryLinkedCount:events.filter(function(e){return!!e.retryDebit;}).length,
    events:events
  };
}
/** Backward-compatible wrapper retained for callers outside BankingCore. */
function vfcSuppressReturnedFinanceDebits_(debits,credits){return vfcResolveReturnedObligationDebits_(debits,credits).debits;}

function vfcResidualRecurringLabel_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),cp=String(t&&t.counterparty||'').replace(/\s+/g,' ').trim();
  function meaningful(v){
    const x=String(v||'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    if(!x||/^\d+$/.test(x))return false;
    if(/^(MISC|MISC PAYMENT|PAYMENT|BILL PAYMENT|BUSINESS PAD|PAD|AUTO PAYMENT|ONLINE BANKING|ONLINE BANKING PAYMENT|ONLINE BANKING TRANSFER|TRANSFER|E TRANSFER|INTERAC|CHEQUE|ATM|PURCHASE|DEBIT|WITHDRAWAL|ACCOUNT PAYABLE PMT|ACCOUNT PAYABLE PAYMENT)$/.test(x))return false;
    return vfcTokens_(x).length>0;
  }
  if(meaningful(cp))return cp;
  let clean=raw
    .replace(/^MISC\s+PAYMENT\s*/i,'')
    .replace(/^BILL\s+PAYMENT\s*/i,'')
    .replace(/^BUSINESS\s+PAD\s*/i,'')
    .replace(/^AUTO\s+PAYMENT\s*/i,'')
    .replace(/^PRE[- ]?AUTH(?:ORIZED)?\s+(?:PAYMENT|DEBIT)?\s*/i,'')
    .replace(/^ONLINE\s+BANKING\s+PAYMENT\s*-?\s*\d*\s*/i,'')
    .replace(/^ACCOUNT\s+PAYABLE\s+(?:PMT|PAYMENT)\s*/i,'')
    .replace(/^E-?TRANSFER\s+SENT\s*/i,'')
    .replace(/^INTERAC\s+E-?TRANSFER\s*/i,'')
    .replace(/\s+/g,' ').trim();
  if(!meaningful(clean))return'';
  return clean;
}

function vfcResidualRecurringClassifyDebit_(bankId,t){
  if(!t||String(t.direction||'').toUpperCase()!=='DEBIT'||!(vfcPos_(t.amount)>0))return null;
  const raw=String(t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase();
  if(!raw)return null;
  // Never convert fees, returns, reversals, cash withdrawals, card purchases or bare cheque rows into residual obligations.
  if(/\bNSF\b|RETURNED|REVERSAL|REFUND|MONTHLY\s+FEE|TRANSACTION\s+FEE|SERVICE\s+CHARGE|OVERDRAFT\s+INTEREST|E-?TRANSFER\s+FEE/.test(s))return null;
  if(/^CHEQUE\b|^ATM\b|CASH\s+WITHDRAWAL|INTERAC\s+PURCHASE|CONTACTLESS\s+INTERAC\s+PURCHASE|\bPOS\s+PURCHASE\b/.test(s))return null;
  const cp=String(t.counterparty||'').replace(/\s+/g,' ').trim(),cpUpper=cp.toUpperCase();
  const genericTransferCp=!cp||/^(ONLINE\s+BANKING\s+TRANSFER|ONLINE\s+TRANSFER|BR\s+TO\s+BR|BANK\s+TRANSFER|TRANSFER)(?:\s*-\s*\d+)?$/.test(cpUpper);
  if((/^ONLINE\s+BANKING\s+TRANSFER\b|^BR\s+TO\s+BR\b|^BANK\s+TRANSFER\b/.test(s))&&genericTransferCp)return null;
  const label=vfcResidualRecurringLabel_(t);if(!label)return null;
  const key=vfcCounterpartyKey_(label);if(!key)return null;
  return Object.assign({},t,{
    family:'OTHER',
    entityKey:'RESIDUAL_RECURRING_'+String(bankId||'UNKNOWN').toUpperCase()+'_'+key,
    key:'RESIDUAL_RECURRING_'+String(bankId||'UNKNOWN').toUpperCase()+'_'+key,
    label:label,
    debtJustification:'Unclassified recurring outflow. It is surfaced as informational because recurrence can establish an obligation pattern, but no financing evidence is present.'
  });
}

function vfcCatchUpInstallmentBase_(items,failedEvents){
  const success=(items||[]).slice(),failed=(failedEvents||[]).map(function(e){
    const d=e&&e.failedDebit||{};
    return{date:String(d.date||''),amount:vfcPos_(d.amount),failed:true};
  }).filter(function(x){return x.date&&x.amount>0;});
  if(!failed.length||success.length<1)return null;
  const evidence=success.map(function(x){return{date:String(x.date||''),amount:vfcPos_(x.amount),failed:false};}).concat(failed);
  if(evidence.length<3)return null;
  const monthSet={};evidence.forEach(function(x){monthSet[String(x.date).slice(0,7)]=1;});
  if(Object.keys(monthSet).length<3)return null;
  const successMonthSet={};success.forEach(function(x){successMonthSet[String(x.date||'').slice(0,7)]=1;});
  if(success.length/Math.max(1,Object.keys(successMonthSet).length)>1.5)return null;

  const seeds=[];
  evidence.forEach(function(x){
    for(let n=1;n<=4;n++)seeds.push(x.amount/n);
  });
  let best=null;
  seeds.forEach(function(seed){
    if(!(seed>0))return;
    const matched=[];
    evidence.forEach(function(x){
      const ratio=x.amount/seed,n=Math.round(ratio);
      if(n<1||n>4)return;
      const normalized=x.amount/n,tol=Math.max(20,seed*.055);
      if(Math.abs(normalized-seed)>tol)return;
      matched.push({date:x.date,amount:x.amount,multiple:n,normalized:normalized,failed:x.failed});
    });
    if(matched.length<3)return;
    const direct=matched.filter(function(x){return x.multiple===1;}).length,multi=matched.filter(function(x){return x.multiple>=2;}).length,failedMatched=matched.filter(function(x){return x.failed;}).length;
    if(!direct||!multi||!failedMatched)return;
    const months={};matched.forEach(function(x){months[String(x.date).slice(0,7)]=1;});
    if(Object.keys(months).length<3)return;
    const base=vfcMedian_(matched.map(function(x){return x.normalized;}));
    const verified=matched.filter(function(x){return Math.abs(x.normalized-base)<=Math.max(20,base*.055);});
    if(verified.length<3)return;
    const vDirect=verified.filter(function(x){return x.multiple===1;}).length,vMulti=verified.filter(function(x){return x.multiple>=2;}).length,vFailed=verified.filter(function(x){return x.failed;}).length;
    if(!vDirect||!vMulti||!vFailed)return;
    const vMonths={};verified.forEach(function(x){vMonths[String(x.date).slice(0,7)]=1;});
    const score=Object.keys(vMonths).length*100+verified.length*20+vFailed*10+vDirect*5;
    if(!best||score>best.score||(score===best.score&&base<best.baseInstallment)){
      best={baseInstallment:base,score:score,evidence:verified};
    }
  });
  if(!best)return null;
  return{
    monthlyEquivalent:vfcRound_(best.baseInstallment,.01),
    baseInstallment:vfcRound_(best.baseInstallment,.01),
    evidenceCount:best.evidence.length,
    failedEvidenceCount:best.evidence.filter(function(x){return x.failed;}).length,
    multiples:best.evidence.map(function(x){return{date:x.date,amount:vfcRound_(x.amount,.01),multiple:x.multiple,failed:!!x.failed};})
  };
}

function vfcStableInstallmentComponents_(items,totalDistinctMonths){
  items=(items||[]).slice().sort(function(a,b){return vfcNum_(a.amount)-vfcNum_(b.amount);});
  totalDistinctMonths=Math.max(0,Number(totalDistinctMonths||0));
  if(items.length<2||totalDistinctMonths<2)return null;
  const avgOccurrencesPerMonth=items.length/Math.max(1,totalDistinctMonths);
  // High-frequency obligations (daily/weekly-style MCA or similar) must keep cadence math.
  if(avgOccurrencesPerMonth>3)return null;
  const clusters=[];
  items.forEach(function(item){
    const amount=vfcPos_(item.amount);if(!(amount>0))return;
    let best=null,bestDiff=Infinity;
    clusters.forEach(function(c){
      const center=vfcMedian_(c.items.map(function(x){return vfcPos_(x.amount);}));
      const tolerance=Math.max(15,center*.18),diff=Math.abs(amount-center);
      if(diff<=tolerance&&diff<bestDiff){best=c;bestDiff=diff;}
    });
    if(!best){best={items:[]};clusters.push(best);}best.items.push(item);
  });
  const requiredMonths=totalDistinctMonths<=2?totalDistinctMonths:Math.max(2,Math.ceil(totalDistinctMonths*.5));
  const eligible=clusters.map(function(c){
    const months={};c.items.forEach(function(x){months[String(x.date||'').slice(0,7)]=1;});
    const amounts=c.items.map(function(x){return vfcPos_(x.amount);});
    return{items:c.items,distinctMonths:Object.keys(months).length,averageAmount:vfcMean_(amounts),medianAmount:vfcMedian_(amounts)};
  }).filter(function(c){return c.distinctMonths>=requiredMonths;});
  if(!eligible.length)return null;
  const monthly=eligible.reduce(function(sum,c){return sum+c.averageAmount;},0);
  if(!(monthly>0))return null;
  return{
    monthlyEquivalent:vfcRound_(monthly,.01),
    componentCount:eligible.length,
    requiredMonths:requiredMonths,
    components:eligible.map(function(c){return{averageAmount:vfcRound_(c.averageAmount,.01),medianAmount:vfcRound_(c.medianAmount,.01),distinctMonths:c.distinctMonths,occurrences:c.items.length};})
  };
}

function vfcSummarizeGroup_(g,latestEnd){
  const items=(g.items||[]).slice().sort(function(a,b){return vfcTime_(a.date)-vfcTime_(b.date);});if(!items.length)return null;const amounts=items.map(function(x){return x.amount;}),months={};items.forEach(function(x){const m=x.date.slice(0,7);months[m]=(months[m]||0)+x.amount;});const distinct=Object.keys(months).length,occ=items.length,gaps=[];for(let i=1;i<items.length;i++)gaps.push((vfcDate_(items[i].date)-vfcDate_(items[i-1].date))/86400000);const medianGap=gaps.length?vfcMedian_(gaps):0,median=vfcMedian_(amounts),cv=vfcCv_(amounts),weeklyRatio=gaps.length?gaps.filter(function(x){return x>=5&&x<=10;}).length/gaps.length:0,biweeklyRatio=gaps.length?gaps.filter(function(x){return x>10&&x<=18;}).length/gaps.length:0,recurring=distinct>=2||occ>=3,daysSince=vfcDays_(items[items.length-1].date,latestEnd),active=daysSince===null?true:daysSince<=VFC_BANK_ENGINE.ACTIVE_DAYS,isFinance=(g.family==='FINANCING'||g.family==='MCA'||g.family==='PAD'),catchup=isFinance?vfcCatchUpInstallmentBase_(items,g.failedEvents||[]):null;let frequency='Observed statement-period cash flow',monthly=0,method='OBSERVED_ONLY',displayPayment=median;
  if(recurring&&medianGap>=5&&medianGap<=10&&occ>=4&&weeklyRatio>=.65){frequency='Weekly observed cadence';monthly=median*52/12;method='WEEKLY_MEDIAN';}else if(recurring&&medianGap>10&&medianGap<=18&&occ>=3&&biweeklyRatio>=.55){frequency='Biweekly observed cadence';monthly=median*26/12;method='BIWEEKLY_MEDIAN';}else if(recurring&&catchup){frequency='Catch-up normalized monthly installment';monthly=catchup.monthlyEquivalent;displayPayment=catchup.baseInstallment;method='CATCHUP_NORMALIZED_INSTALLMENT';}else if(recurring&&distinct>=2&&occ===distinct){frequency='Monthly observed cadence';monthly=cv<=.03?median:vfcMeanObject_(months);method=cv<=.03?'MONTHLY_MEDIAN':'MONTHLY_VARIABLE_MEAN';}else if(recurring){const stable=isFinance?vfcStableInstallmentComponents_(items,distinct):null;if(stable){frequency='Stable recurring installment component';monthly=stable.monthlyEquivalent;method='STABLE_INSTALLMENT_COMPONENTS';}else{frequency='Multiple payments per month';monthly=vfcRecentMonthAverage_(months,3);method='RECENT_3_MONTH_AVERAGE';}}
  if(!active&&!isFinance){monthly=0;method='STALE_INFORMATIONAL';}
  let why=String(g.debtJustification||'').trim();if(why&&recurring)why+=' Recurrence evidence: '+occ+' observed payment'+(occ===1?'':'s')+' across '+distinct+' month'+(distinct===1?'':'s')+'; '+frequency+'.';
  return{bankId:g.bankId||'',family:g.family,key:g.entityKey,entityKey:g.entityKey,counterparty:g.label,description:g.label,category:g.family==='FINANCING'?'LOAN':g.family,paymentAmount:vfcRound_(displayPayment,.01),averagePayment:vfcRound_(vfcMean_(amounts),.01),frequency:frequency,monthlyEquivalent:vfcRound_(monthly,.01),monthlyEquivalentMethod:method,catchUpNormalization:catchup||null,occurrences:occ,distinctMonths:distinct,firstSeen:items[0].date,lastSeen:items[items.length-1].date,daysSinceLastObserved:daysSince,active:active,recurring:recurring,confidence:!recurring?'Low':(distinct>=3?'High':'Moderate'),observedTotal:vfcRound_(vfcSum_(amounts),.01),observedMonthlyTotals:vfcSortedMoneyObject_(months),components:vfcAmountComponents_(items),debtJustification:why};
}

function runBankingCoreRecurrenceSelfTests(){
  const results=[];
  function test(name,fn){try{results.push({name:name,pass:true,detail:String(fn()||'')});}catch(e){results.push({name:name,pass:false,detail:String(e&&e.message||e)});}}
  function close(a,b,tol,label){tol=tol==null?.05:tol;if(Math.abs(Number(a||0)-Number(b||0))>tol)throw new Error((label||'value')+' expected '+b+' got '+a);}
  function item(date,amount){return{date:date,amount:amount};}
  test('Operating deposits exclude matched return even when frozen direction is debit',function(){
    const tx=[
      {bankId:'UNKNOWN',date:'2026-01-10',description:'Cheque returned NSF',counterparty:'',direction:'DEBIT',amount:2500}
    ];
    const debt={returnedPaymentEvents:[{
      bankId:'UNKNOWN',
      failedDebit:{date:'2026-01-10',description:'Loan payment ABC Finance',amount:2500},
      returnEvent:{date:'2026-01-10',description:'Cheque returned NSF',counterparty:'',direction:'DEBIT',amount:2500}
    }]};
    const r=vfcOperatingReversalRows_(tx,debt);
    if(r.length!==1)throw new Error('expected one operating-deposit reversal exclusion');
    close(r[0].amount,2500,.001,'direction-agnostic reversal amount');
    return r[0].amount;
  });
  test('Matched return is not double counted when already frozen as a credit',function(){
    const tx=[
      {bankId:'UNKNOWN',date:'2026-01-10',description:'Cheque returned NSF',counterparty:'',direction:'CREDIT',amount:2500}
    ];
    const debt={returnedPaymentEvents:[{
      bankId:'UNKNOWN',
      failedDebit:{date:'2026-01-10',description:'Loan payment ABC Finance',amount:2500},
      returnEvent:{date:'2026-01-10',description:'Cheque returned NSF',counterparty:'',direction:'CREDIT',amount:2500}
    }]};
    const r=vfcOperatingReversalRows_(tx,debt);
    if(r.length!==1)throw new Error('credit return was double counted');
    close(r[0].amount,2500,.001,'deduped reversal amount');
    return r[0].amount;
  });
  test('Returned-payment history normalizes accumulated catch-up multiples',function(){
    const items=[item('2025-09-29',2800),item('2025-12-29',8400)];
    const failed=[
      {failedDebit:{date:'2025-10-27',amount:2800}},
      {failedDebit:{date:'2025-11-27',amount:5600}}
    ];
    const r=vfcCatchUpInstallmentBase_(items,failed);
    if(!r)throw new Error('catch-up base not detected');
    close(r.monthlyEquivalent,2800,.05,'catch-up normalized installment');
    return r.monthlyEquivalent;
  });
  test('Variable monthly payments are not normalized without returned-payment evidence',function(){
    const r=vfcCatchUpInstallmentBase_([item('2026-01-10',1000),item('2026-02-10',2000)],[]);
    if(r!==null)throw new Error('catch-up normalization must require failed/returned evidence');
    return'not normalized';
  });
  test('Stable installment ignores isolated large catch-up payment',function(){
    const r=vfcStableInstallmentComponents_([item('2026-03-27',2578.34),item('2026-04-27',2656.97),item('2026-07-27',7952.39),item('2026-08-17',2285.91)],4);
    if(!r)throw new Error('stable component not detected');
    close(r.monthlyEquivalent,(2578.34+2656.97+2285.91)/3,.05,'stable installment');
    return r.monthlyEquivalent;
  });
  test('Stable smaller installment ignores one irregular first payment',function(){
    const r=vfcStableInstallmentComponents_([item('2026-06-20',502.45),item('2026-07-02',234.96),item('2026-08-04',234.96),item('2026-09-01',234.96)],4);
    if(!r)throw new Error('stable component not detected');
    close(r.monthlyEquivalent,234.96,.05,'stable smaller installment');
    return r.monthlyEquivalent;
  });
  test('High-frequency financing keeps cadence math instead of installment clustering',function(){
    const items=[];for(let m=1;m<=2;m++){for(let i=1;i<=8;i++)items.push(item('2026-0'+m+'-'+String(i*3).padStart(2,'0'),681.35));}
    const r=vfcStableInstallmentComponents_(items,2);
    if(r!==null)throw new Error('high-frequency payments must not use installment clustering');
    return'high-frequency preserved';
  });
  test('Two stable financing components under one entity are both retained',function(){
    const r=vfcStableInstallmentComponents_([item('2026-01-05',1000),item('2026-01-20',2000),item('2026-02-05',1000),item('2026-02-20',2000),item('2026-03-05',1000),item('2026-03-20',2000)],3);
    if(!r)throw new Error('stable components not detected');
    close(r.monthlyEquivalent,3000,.05,'two-component total');
    return r.monthlyEquivalent;
  });
  test('Unknown monthly counterparty becomes informational recurring obligation',function(){
    const rows=[
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-01-31',transactions:[{date:'2026-01-10',description:'Bill Payment ABC123',counterparty:'ABC123',direction:'DEBIT',amount:1250}]}},
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-02-28',transactions:[{date:'2026-02-10',description:'Bill Payment ABC123',counterparty:'ABC123',direction:'DEBIT',amount:1250}]}},
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-03-31',transactions:[{date:'2026-03-10',description:'Bill Payment ABC123',counterparty:'ABC123',direction:'DEBIT',amount:1250}]}}
    ];
    const d=vfcDebtProfile_(rows);
    close(d.confirmedMonthlyDebtService,0,.001,'confirmed debt');
    if(!d.otherRecurringObligations.length)throw new Error('residual recurring obligation not surfaced');
    close(d.otherRecurringObligations[0].monthlyEquivalent,1250,.05,'residual monthly equivalent');
    return d.otherRecurringObligations[0].counterparty;
  });
  test('Unknown weekly counterparty is informational, not debt',function(){
    const txs=[
      {date:'2026-01-05',description:'EFT XYZ SERVICE',counterparty:'XYZ SERVICE',direction:'DEBIT',amount:681},
      {date:'2026-01-12',description:'EFT XYZ SERVICE',counterparty:'XYZ SERVICE',direction:'DEBIT',amount:681},
      {date:'2026-01-19',description:'EFT XYZ SERVICE',counterparty:'XYZ SERVICE',direction:'DEBIT',amount:681},
      {date:'2026-01-26',description:'EFT XYZ SERVICE',counterparty:'XYZ SERVICE',direction:'DEBIT',amount:681},
      {date:'2026-02-02',description:'EFT XYZ SERVICE',counterparty:'XYZ SERVICE',direction:'DEBIT',amount:681}
    ];
    const d=vfcDebtProfile_([{payload:{bankId:'UNKNOWN',statementEndDate:'2026-02-28',transactions:txs}}]);
    close(d.confirmedMonthlyDebtService,0,.001,'confirmed debt');
    if(!d.otherRecurringObligations.length)throw new Error('weekly residual not surfaced');
    return d.otherRecurringObligations[0].frequency;
  });
  test('Generic NSF wording suppresses the failed obligation debit',function(){
    const debits=[{bankId:'UNKNOWN',date:'2026-01-10',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2500}];
    const credits=[{bankId:'UNKNOWN',date:'2026-01-11',description:'Cheque returned NSF',counterparty:'',direction:'CREDIT',amount:2500}];
    const r=vfcResolveReturnedObligationDebits_(debits,credits);
    if(r.debits.length!==0)throw new Error('failed debit was not suppressed');
    if(r.suppressedCount!==1)throw new Error('suppressed count expected 1 got '+r.suppressedCount);
    return'suppressed';
  });
  test('Returned-payment row is honored before recurrence even when frozen as a debit',function(){
    const rows=[
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-01-31',transactions:[{date:'2026-01-10',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2500}]}},
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-02-28',transactions:[
        {date:'2026-02-10',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2600},
        {date:'2026-02-10',description:'Cheque returned NSF',counterparty:'',direction:'DEBIT',amount:2600}
      ]}},
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-03-31',transactions:[{date:'2026-03-10',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2500}]}}
    ];
    const d=vfcDebtProfile_(rows);
    close(d.confirmedMonthlyDebtService,2500,.05,'monthly obligation after debit-coded return marker');
    if(d.returnedObligationDebitsSuppressed!==1)throw new Error('expected failed payment suppression');
    return d.confirmedMonthlyDebtService;
  });
  test('Retry replaces failed payment without increasing monthly obligation',function(){
    const rows=[
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-01-31',transactions:[{date:'2026-01-10',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2500}]}},
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-02-28',transactions:[
        {date:'2026-02-10',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2500},
        {date:'2026-02-11',description:'Payment returned NSF',counterparty:'',direction:'CREDIT',amount:2500},
        {date:'2026-02-13',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2525}
      ]}},
      {payload:{bankId:'UNKNOWN',statementEndDate:'2026-03-31',transactions:[{date:'2026-03-10',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2500}]}}
    ];
    const d=vfcDebtProfile_(rows);
    close(d.confirmedMonthlyDebtService,2500,.05,'monthly obligation after retry');
    if(d.returnedObligationDebitsSuppressed!==1)throw new Error('expected one failed debit suppressed');
    if(d.probableRetryPaymentsLinked!==1)throw new Error('expected one retry link');
    return d.confirmedMonthlyDebtService;
  });
  test('NSF fee alone never suppresses a payment',function(){
    const debits=[{bankId:'UNKNOWN',date:'2026-01-10',description:'Loan payment ABC Finance',counterparty:'ABC Finance',direction:'DEBIT',amount:2500}];
    const credits=[{bankId:'UNKNOWN',date:'2026-01-11',description:'NSF item fee reversal',counterparty:'',direction:'CREDIT',amount:45}];
    const r=vfcResolveReturnedObligationDebits_(debits,credits);
    if(r.debits.length!==1)throw new Error('valid payment was suppressed by fee');
    return'preserved';
  });
  test('Generic transfer-only rows do not become recurring obligations',function(){
    if(vfcResidualRecurringClassifyDebit_('UNKNOWN',{date:'2026-01-01',description:'Online Banking transfer - 4268',counterparty:'Online Banking transfer',direction:'DEBIT',amount:1000})!==null)throw new Error('generic online transfer classified');
    if(vfcResidualRecurringClassifyDebit_('UNKNOWN',{date:'2026-01-01',description:'BR TO BR - 2920',counterparty:'BR TO BR',direction:'DEBIT',amount:5000})!==null)throw new Error('bank-to-bank transfer classified');
    return'excluded';
  });
  test('Bare cheque and fee rows do not become residual obligations',function(){
    if(vfcResidualRecurringClassifyDebit_('UNKNOWN',{date:'2026-01-01',description:'Cheque - 123',counterparty:'',direction:'DEBIT',amount:900})!==null)throw new Error('bare cheque classified');
    if(vfcResidualRecurringClassifyDebit_('UNKNOWN',{date:'2026-01-01',description:'Monthly fee',counterparty:'',direction:'DEBIT',amount:15})!==null)throw new Error('fee classified');
    return'excluded';
  });
  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}

function vfcAmountComponents_(items){
  const clusters=[];(items||[]).slice().sort(function(a,b){return a.amount-b.amount;}).forEach(function(item){let best=null,bestDiff=Infinity;clusters.forEach(function(c){const center=vfcMedian_(c.map(function(x){return x.amount;})),tolerance=Math.max(12,center*(center<2000?.15:.065)),diff=Math.abs(item.amount-center);if(diff<=tolerance&&diff<bestDiff){best=c;bestDiff=diff;}});if(best)best.push(item);else clusters.push([item]);});
  return clusters.map(function(c,i){const a=c.map(function(x){return x.amount;}),m={};c.forEach(function(x){m[x.date.slice(0,7)]=1;});return{componentId:'C'+(i+1),representativeAmount:vfcRound_(vfcMedian_(a),.01),averageAmount:vfcRound_(vfcMean_(a),.01),minAmount:vfcRound_(Math.min.apply(null,a),.01),maxAmount:vfcRound_(Math.max.apply(null,a),.01),occurrences:a.length,distinctMonths:Object.keys(m).length};}).sort(function(a,b){return a.representativeAmount-b.representativeAmount;});
}

function vfcMergeGenericAmountMatches_(groups){
  const out=[];(groups||[]).forEach(function(g){if(vfcIsStrongEntityKey_(g.entityKey,g.family,g.bankId)){out.push(g);return;}let target=null;out.some(function(e){if(String(e.bankId||'')!==String(g.bankId||''))return false;if(vfcIsStrongEntityKey_(e.entityKey,e.family,e.bankId)||e.family!==g.family||e.frequency!==g.frequency)return false;const tolerance=Math.max(8,Math.min(e.paymentAmount,g.paymentAmount)*.02),em=Object.keys(e.observedMonthlyTotals||{}),gm=Object.keys(g.observedMonthlyTotals||{}),overlap=em.filter(function(m){return gm.indexOf(m)>=0;}).length/Math.max(1,Math.min(em.length,gm.length));if(Math.abs(e.paymentAmount-g.paymentAmount)<=tolerance&&Math.min(e.distinctMonths,g.distinctMonths)>=2&&overlap<=.20){target=e;return true;}return false;});if(!target){out.push(g);return;}target.description=target.description+' / '+g.description;target.counterparty=target.description;target.observedTotal=vfcRound_(target.observedTotal+g.observedTotal,.01);target.occurrences+=g.occurrences;target.confidence='High';target.mergedByAmountCadence=true;});return out;
}

function vfcFinancingCredits_(credits,debits){
  const confirmed=[],possible=[],financingDebits=(debits||[]).filter(function(d){return d&&(d.family==='FINANCING'||d.family==='MCA');});
  (credits||[]).forEach(function(c){const bankId=c.bankId||'UNKNOWN';if(vfcIsNonOperatingReversalCredit_(bankId,c))return;const s=String(c.description||'').toUpperCase(),amount=vfcPos_(c.amount);if(!(amount>0))return;const explicit=/\bLOAN\s+CREDIT\b|LOAN\s+ADVANCE|LOAN\s+PROCEEDS|FINANC(?:E|ING)\s+ADVANCE|FINANC(?:E|ING)\s+PROCEEDS|FUNDING\s+ADVANCE|MCA\s+ADVANCE|CSBFL\s+(?:LOAN\s+)?ADVANCE|CSBFL\s+PROCEEDS|MORTGAGE\s+(?:ADVANCE|PROCEEDS|FUNDING)|(?:\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE)\s+(?:ADVANCE|PROCEEDS|FUNDING)/.test(s),matched=vfcMatchedPaymentEntity_(c,financingDebits),known=vfcIsKnownFinancingCreditForBank_(bankId,c),item={bankId:bankId,date:c.date,description:c.description,counterparty:c.counterparty,amount:c.amount,direction:'CREDIT',occurrence:c.occurrence||1,linkedPaymentEntity:matched,confidence:(explicit||known||matched)?'High':'Moderate'};if(explicit||(amount>=5000&&known))confirmed.push(item);else if(amount>=5000&&(matched||/INVESTMENT|CAPITAL/.test(s)))possible.push(item);});
  const c=vfcDedupeTx_(confirmed),p=vfcDedupeTx_(possible);return{confirmed:c,possible:p,total:c.reduce(function(s,x){return s+x.amount;},0)};
}
function vfcMatchedPaymentEntity_(credit,debits){const ct=vfcTokens_(credit.counterparty||credit.description);if(!ct.length)return'';let found='';(debits||[]).some(function(d){const dt=vfcTokens_(d.counterparty||d.description);if(!dt.length)return false;let n=0;ct.forEach(function(a){if(dt.some(function(b){return a===b||(a.length>=4&&b.length>=4&&(a.indexOf(b)===0||b.indexOf(a)===0));}))n++;});if(n/Math.min(ct.length,dt.length)>=.5){found=d.entityKey||d.key||'';return true;}return false;});return found;}

function lockBankRegressionBaseline(companyName,period,bankId){bankId=String(bankId||'RBC').toUpperCase();const result=refreshDebtSignalsForPeriodSafe({companyName:companyName,period:period});if(!result.ok)throw new Error((result.errors||[]).join(' | '));const ss=SpreadsheetApp.getActiveSpreadsheet();let sh=ss.getSheetByName('BANK_REGRESSION_LOCKS');if(!sh){sh=ss.insertSheet('BANK_REGRESSION_LOCKS');sh.appendRow(['Company Name','Period','Bank','Result Fingerprint','Gross Monthly Deposits','Operating Monthly Deposits','Confirmed Monthly Debt','Financing Credits','Core Version','Locked At']);sh.setFrozenRows(1);}const values=sh.getDataRange().getValues();let rowNum=0;for(let i=1;i<values.length;i++)if(vfcSame_(values[i][0],companyName)&&vfcSame_(values[i][1],period)&&vfcSame_(values[i][2],bankId)){rowNum=i+1;break;}const b=result.bankingFeatures||{},row=[companyName,period,bankId,result.resultFingerprint,b.averageMonthlyDeposits||0,b.estimatedOperatingMonthlyDeposits||0,b.existingMonthlyDebtService||0,b.detectedFinancingCredits||0,VFC_BANK_ENGINE.VERSION,new Date()];if(rowNum)sh.getRange(rowNum,1,1,row.length).setValues([row]);else sh.appendRow(row);return{ok:true,locked:true,resultFingerprint:result.resultFingerprint};}
function verifyBankRegressionBaseline(companyName,period,bankId){bankId=String(bankId||'RBC').toUpperCase();const result=refreshDebtSignalsForPeriodSafe({companyName:companyName,period:period});if(!result.ok)return result;const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BANK_REGRESSION_LOCKS');if(!sh||sh.getLastRow()<2)return{ok:false,error:'No regression baseline is locked.'};const values=sh.getDataRange().getValues();for(let i=1;i<values.length;i++)if(vfcSame_(values[i][0],companyName)&&vfcSame_(values[i][1],period)&&vfcSame_(values[i][2],bankId)){const expected=String(values[i][3]||'');return{ok:true,match:expected===result.resultFingerprint,expectedFingerprint:expected,actualFingerprint:result.resultFingerprint};}return{ok:false,error:'No matching regression baseline is locked.'};}
function vfcResultFingerprint_(f){const d=f.debtProfile||{},canonical={statementCount:f.statementCount||0,totalDeposits:vfcRound_(f.totalDeposits||0,.01),averageMonthlyDeposits:vfcRound_(f.averageMonthlyDeposits||0,.01),estimatedOperatingMonthlyDeposits:vfcRound_(f.estimatedOperatingMonthlyDeposits||0,.01),detectedFinancingCredits:vfcRound_(f.detectedFinancingCredits||0,.01),existingMonthlyDebtService:vfcRound_(f.existingMonthlyDebtService||0,.01),nsfPerMonth:vfcRound_(f.nsfPerMonth||0,.01),negativeBalanceFlag:f.negativeBalanceFlag||0,overdraftFlag:f.overdraftFlag||0,returnedPaymentFlag:f.returnedPaymentFlag||0,suspectedStacking:f.suspectedStacking||0,depositTrend:vfcRound_(f.depositTrend||0,.01),depositVolatility:vfcRound_(f.depositVolatility||0,.01),debt:(d.activeDebtObligations||[]).map(function(x){return[x.bankId||'',x.entityKey,x.monthlyEquivalent,x.frequency,x.paymentAmount,x.lastSeen];}),revolving:(d.revolvingFinancingActivity||[]).map(function(x){return[x.bankId||'',x.entityKey,x.monthlyEquivalent,x.frequency,x.paymentAmount,x.lastSeen];}),info:(d.otherRecurringObligations||[]).map(function(x){return[x.bankId||'',x.entityKey,x.monthlyEquivalent,x.frequency,x.paymentAmount,x.lastSeen];}),financing:(d.financingCredits||[]).map(function(x){return[x.date,x.amount,x.description];}),possibleFinancing:(d.possibleFinancingCredits||[]).map(function(x){return[x.date,x.amount,x.description];})};return vfcDigest_(JSON.stringify(canonical));}

function vfcBaseFeatures_(companyName,period){if(typeof buildPowerFeatures_==='function')return buildPowerFeatures_(companyName,period);if(typeof buildFeaturesForCase_==='function')return buildFeaturesForCase_(companyName,period);return null;}
function vfcRequest_(a,p){return a&&typeof a==='object'?{companyName:String(a.companyName||'').trim(),period:String(a.period||p||'').trim()}:{companyName:String(a||'').trim(),period:String(p||'').trim()};}
function vfcHeader_(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'');}
function vfcSame_(a,b){return String(a||'').trim().toLowerCase()===String(b||'').trim().toLowerCase();}
function vfcNum_(v){const n=Number(String(v==null?'':v).replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:0;}
function vfcNumNull_(v){if(v===null||v===undefined||v==='')return null;const n=Number(String(v).replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:null;}
function vfcPos_(v){return Math.max(0,vfcNum_(v));}
function vfcBool_(v){return/^(true|yes|y|1)$/i.test(String(v||'').trim())||/negative/i.test(String(v||''));}
function vfcRound_(v,step){step=step||.01;return Math.round((v+Number.EPSILON)/step)*step;}
function vfcDate_(v){if(!v)return null;const d=v instanceof Date?v:new Date(v);return isNaN(d.getTime())?null:d;}
function vfcIso_(v){const raw=String(v==null?'':v).trim();if(/^\d{4}-\d{2}-\d{2}$/.test(raw))return raw;const d=vfcDate_(v);if(!d)return'';return Utilities.formatDate(d,Session.getScriptTimeZone()||'GMT','yyyy-MM-dd');}
function vfcTime_(v){const d=vfcDate_(v);return d?d.getTime():0;}
function vfcSum_(a){return(a||[]).reduce(function(s,x){return s+vfcNum_(x);},0);}
function vfcMean_(a){return a&&a.length?vfcSum_(a)/a.length:0;}
function vfcMedian_(a){const x=(a||[]).slice().sort(function(m,n){return m-n;});if(!x.length)return 0;const k=Math.floor(x.length/2);return x.length%2?x[k]:(x[k-1]+x[k])/2;}
function vfcStdDev_(a){if(!a||!a.length)return 0;const m=vfcMean_(a);return Math.sqrt(a.reduce(function(s,x){return s+Math.pow(x-m,2);},0)/a.length);}
function vfcCv_(a){const m=vfcMean_(a);return m?vfcStdDev_(a)/m:0;}
function vfcTrend_(a){if(!a||a.length<2)return 0;const first=a[0],last=a[a.length-1],den=Math.max(Math.abs(first),1);return(last-first)/den;}
function vfcDays_(a,b){const da=vfcDate_(a),db=vfcDate_(b);return!da||!db?null:Math.max(0,Math.round((db-da)/86400000));}
function vfcMeanObject_(o){const k=Object.keys(o||{});return k.length?k.reduce(function(s,x){return s+vfcNum_(o[x]);},0)/k.length:0;}
function vfcRecentMonthAverage_(o,n){const k=Object.keys(o||{}).sort().slice(-Math.max(1,n||3));return k.length?k.reduce(function(s,x){return s+vfcNum_(o[x]);},0)/k.length:0;}
function vfcSortedMoneyObject_(o){const out={};Object.keys(o||{}).sort().forEach(function(k){out[k]=vfcRound_(o[k],.01);});return out;}
function vfcObligationSort_(a,b){return(b.monthlyEquivalent||0)-(a.monthlyEquivalent||0)||String(a.counterparty||'').localeCompare(String(b.counterparty||''));}
function vfcDedupeTx_(a){const out=[],seen={};(a||[]).forEach(function(t){const k=[t.bankId||'',t.date,t.direction,t.amount,String(t.description||'').toUpperCase(),t.occurrence||1].join('|');if(!seen[k]){seen[k]=1;out.push(t);}});return out;}
function vfcTokens_(s){const stop={BUSINESS:1,INVESTMENT:1,PAD:1,PAYMENT:1,LOAN:1,CREDIT:1,DEBIT:1,THE:1,INC:1,LTD:1,CORP:1,CORPORATION:1,COMPANY:1,'001':1};return String(s||'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').split(/\s+/).filter(function(x){return x.length>=3&&!stop[x]&&!/^\d+$/.test(x);});}
function vfcCounterpartyKey_(s){const t=vfcTokens_(s);return t.slice(0,4).join('_')||String(s||'').toUpperCase().replace(/[^A-Z0-9]+/g,'_').slice(0,60);}
function vfcIsStrongEntityKey_(key,family,bankId){const k=String(key||'').toUpperCase();return/^LOAN(_INTEREST)?_[0-9]/.test(k)||/^INSURANCE_/.test(k)||/^RESIDUAL_RECURRING_/.test(k)||vfcBankStrongEntityKey_(bankId,k,family);}
function vfcDigest_(s){const bytes=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(s||''),Utilities.Charset.UTF_8);return bytes.map(function(b){const v=(b<0?b+256:b).toString(16);return v.length===1?'0'+v:v;}).join('').substring(0,24);}