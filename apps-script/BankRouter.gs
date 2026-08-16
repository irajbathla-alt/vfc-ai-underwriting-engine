/** VFC Bank Router — no underwriting math lives here. */
function vfcBankRegistry_(){
  return [vfcRbcBankProfile_(),vfcTdBankProfile_(),vfcScotiaBankProfile_(),vfcBmoBankProfile_(),vfcCibcBankProfile_(),vfcCoastCapitalBankProfile_()];
}
function getBankParserTabs(){return vfcBankRegistry_().map(function(p){return{id:p.id,label:p.label,status:p.status,active:p.status==='LOCKED',rulesVersion:p.rulesVersion};});}
function vfcGetBankProfile_(bankId){const id=String(bankId||'').toUpperCase().replace(/\s+/g,'_'),rows=vfcBankRegistry_();for(let i=0;i<rows.length;i++)if(rows[i].id===id)return rows[i];return{id:'UNKNOWN',label:'Unknown',status:'UNSUPPORTED',rulesVersion:'UNTRAINED',aliases:[]};}
function vfcDetectBankId_(text){const s=String(text||'').toUpperCase(),rows=vfcBankRegistry_();for(let i=0;i<rows.length;i++){const aliases=rows[i].aliases||[];for(let j=0;j<aliases.length;j++)if(s.indexOf(String(aliases[j]).toUpperCase())>=0)return rows[i].id;}return'UNKNOWN';}
function vfcClassifyDebitForBank_(bankId,t){switch(String(bankId||'').toUpperCase()){case'RBC':return vfcRbcClassifyDebit_(t);case'TD':return vfcTdClassifyDebit_(t);case'SCOTIA':return vfcScotiaClassifyDebit_(t);case'BMO':return vfcBmoClassifyDebit_(t);case'CIBC':return vfcCibcClassifyDebit_(t);case'COAST_CAPITAL':return vfcCoastCapitalClassifyDebit_(t);default:return vfcGenericConservativeClassifyDebit_(t);}}
function vfcIsKnownFinancingCreditForBank_(bankId,t){switch(String(bankId||'').toUpperCase()){case'RBC':return vfcRbcKnownFinancingCredit_(t);case'TD':return vfcTdKnownFinancingCredit_(t);case'SCOTIA':return vfcScotiaKnownFinancingCredit_(t);case'BMO':return vfcBmoKnownFinancingCredit_(t);case'CIBC':return vfcCibcKnownFinancingCredit_(t);case'COAST_CAPITAL':return vfcCoastCapitalKnownFinancingCredit_(t);default:return false;}}
function vfcBankStrongEntityKey_(key,family){return vfcRbcStrongEntityKey_(key);}

/** One UI entry point. Each bank can later replace only its own upload reader if required. */
function uploadStatementBatchByBank(bankId,companyName,files){
  const profile=vfcGetBankProfile_(bankId);if(profile.id==='UNKNOWN')throw new Error('Select a supported bank.');
  const result=uploadStatementBatch(companyName,files);
  // If the exact statement was already seen, restore its first verified frozen ledger.
  // This prevents a later OpenAI upload read from changing the result for the same PDF facts.
  if(result&&result.detectedPeriod)vfcFreezeDuplicateStatementFacts_(companyName,result.detectedPeriod);
  result.bankProfile=profile.id;result.bankRulesVersion=profile.rulesVersion;result.bankTrainingStatus=profile.status;return result;
}

function vfcFreezeDuplicateStatementFacts_(companyName,period){
  const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');if(!sh||sh.getLastRow()<2)return;
  const values=sh.getDataRange().getValues(),headers=values[0].map(vfcHeader_),idx={};headers.forEach(function(h,i){idx[h]=i;});
  const signalCol=idx[vfcHeader_('Possible MCA Or Loan Payments')];if(signalCol===undefined)return;
  function val(r,n){const i=idx[vfcHeader_(n)];return i===undefined?'':r[i];}
  const groups={};
  for(let i=1;i<values.length;i++){
    const r=values[i];if(!vfcSame_(val(r,'Company Name'),companyName)||!vfcSame_(val(r,'Detected Period'),period))continue;
    const row={rowNumber:i+1,bank:String(val(r,'Bank Name')||''),startDate:val(r,'Statement Start Date'),endDate:val(r,'Statement End Date'),opening:vfcNumNull_(val(r,'Opening Balance')),closing:vfcNumNull_(val(r,'Closing Balance')),deposits:vfcNumNull_(val(r,'Total Deposits')),withdrawals:vfcNumNull_(val(r,'Total Withdrawals')),signalRaw:String(val(r,'Possible MCA Or Loan Payments')||''),createdAt:val(r,'Created At')};
    const key=vfcStatementFingerprint_(row);if(!groups[key])groups[key]=[];groups[key].push(row);
  }
  Object.keys(groups).forEach(function(key){
    const rows=groups[key].sort(function(a,b){return vfcTime_(a.createdAt)-vfcTime_(b.createdAt);});let canonical='';
    for(let i=0;i<rows.length;i++){const p=vfcParseBankCache_(rows[i].signalRaw);if(vfcPayloadUsable_(p)){canonical=rows[i].signalRaw;break;}}
    if(!canonical)return;
    rows.forEach(function(r){if(String(r.signalRaw||'')!==canonical)sh.getRange(r.rowNumber,signalCol+1).setValue(canonical);});
  });
}

function setupBankTrainingTabs(){
  const ss=SpreadsheetApp.getActiveSpreadsheet(),headers=['Bank','Training Status','Parser / Rules Version','Statement Format Notes','Debit Markers','Credit Markers','Financing Keywords','Recurring Payment Notes','Test Company','Test Period','Expected Gross Deposits','Expected Operating Deposits','Expected Monthly Debt','Expected Financing Credits','Last Validated','Notes'],created=[];
  vfcBankRegistry_().forEach(function(bank){const sheetName='BANK_'+bank.id;let sh=ss.getSheetByName(sheetName);if(!sh){sh=ss.insertSheet(sheetName);created.push(sheetName);}if(sh.getLastRow()===0){sh.getRange(1,1,1,headers.length).setValues([headers]);sh.setFrozenRows(1);sh.getRange(2,1,1,headers.length).setValues([[bank.label,bank.status,bank.rulesVersion,'','','','','','','','','','','','','']]);sh.autoResizeColumns(1,headers.length);}else{sh.getRange(2,1).setValue(bank.label);sh.getRange(2,2).setValue(bank.status);sh.getRange(2,3).setValue(bank.rulesVersion);}});
  return{ok:true,created:created,tabs:getBankParserTabs()};
}

/** Pending-bank fallback: deliberately conservative; no RBC assumptions. */
function vfcGenericConservativeClassifyDebit_(t){
  const s=String(t.description||'').toUpperCase().replace(/\s+/g,' ').trim();if(/\bFEE\b|SERVICE\s+CHARGE|NSF|OVERDRAFT\s+INTEREST/.test(s))return null;
  if(/\bCRA\b|\bCCRA\b|GST|HST|\bTAX\b/.test(s)){const k=vfcCounterpartyKey_(t.counterparty||t.description);return Object.assign({},t,{family:'TAX',entityKey:k,key:k,label:t.counterparty||t.description});}
  if(/INSURANCE|PREMIUM\s+FIN/.test(s)){const k=vfcCounterpartyKey_(t.counterparty||t.description);return Object.assign({},t,{family:'OTHER',entityKey:k,key:k,label:t.counterparty||t.description});}
  if(/LOAN\s+(PAYMENT|PMT|PYMT|INTEREST)|\bMCA\b|MERCHANT\s+CASH\s+ADVANCE|FINANCING\s+PAYMENT/.test(s)){const k=vfcCounterpartyKey_(t.counterparty||t.description);return Object.assign({},t,{family:'FINANCING',entityKey:k,key:k,label:t.counterparty||t.description});}
  return null;
}
