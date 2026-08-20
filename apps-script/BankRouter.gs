/**
 * VFC Bank Router
 * Bank selection + one common upload pipeline only.
 * Bank-specific extraction/classification lives in Bank_<BANK>.gs.
 */
function vfcBankRegistry_(){return[vfcRbcBankProfile_(),vfcTdBankProfile_(),vfcScotiaBankProfile_(),vfcBmoBankProfile_(),vfcCibcBankProfile_(),vfcCoastCapitalBankProfile_()];}
function getBankParserTabs(){return vfcBankRegistry_().map(function(p){return{id:p.id,label:p.label,status:p.status,active:p.status==='LOCKED',rulesVersion:p.rulesVersion};});}
function vfcGetBankProfile_(bankId){const id=String(bankId||'').toUpperCase().replace(/\s+/g,'_'),rows=vfcBankRegistry_();for(let i=0;i<rows.length;i++)if(rows[i].id===id)return rows[i];return{id:'UNKNOWN',label:'Unknown',status:'UNSUPPORTED',rulesVersion:'UNTRAINED',aliases:[]};}
function vfcDetectBankId_(text){
  const raw=String(text||'').trim(),s=raw.toUpperCase(),rows=vfcBankRegistry_();
  for(let i=0;i<rows.length;i++)if(s===rows[i].id||s===String(rows[i].label||'').toUpperCase())return rows[i].id;
  let bestId='UNKNOWN',bestScore=0;
  rows.forEach(function(p){(p.aliases||[]).forEach(function(alias){const a=String(alias||'').toUpperCase();if(!a||s.indexOf(a)<0)return;let score=a.length;if(a.length>=10||/BANK|ROYAL|MONTREAL|SCOTIA|IMPERIAL|COAST|DOMINION/.test(a))score+=100;if(score>bestScore){bestScore=score;bestId=p.id;}});});
  return bestId;
}
function vfcClassifyDebitForBank_(bankId,t){switch(String(bankId||'').toUpperCase()){case'RBC':return vfcRbcClassifyDebit_(t);case'TD':return vfcTdClassifyDebit_(t);case'SCOTIA':return vfcScotiaClassifyDebit_(t);case'BMO':return vfcBmoClassifyDebit_(t);case'CIBC':return vfcCibcClassifyDebit_(t);case'COAST_CAPITAL':return vfcCoastCapitalClassifyDebit_(t);default:return vfcGenericConservativeClassifyDebit_(t);}}
function vfcIsKnownFinancingCreditForBank_(bankId,t){switch(String(bankId||'').toUpperCase()){case'RBC':return vfcRbcKnownFinancingCredit_(t);case'TD':return vfcTdKnownFinancingCredit_(t);case'SCOTIA':return vfcScotiaKnownFinancingCredit_(t);case'BMO':return vfcBmoKnownFinancingCredit_(t);case'CIBC':return vfcCibcKnownFinancingCredit_(t);case'COAST_CAPITAL':return vfcCoastCapitalKnownFinancingCredit_(t);default:return false;}}
function vfcBankStrongEntityKey_(bankId,key,family){switch(String(bankId||'').toUpperCase()){case'RBC':return vfcRbcStrongEntityKey_(key);default:return false;}}
function vfcBankExtractionRules_(bankId){switch(String(bankId||'').toUpperCase()){case'RBC':return vfcRbcExtractionRules_();case'TD':return vfcTdExtractionRules_();case'SCOTIA':return vfcScotiaExtractionRules_();case'BMO':return vfcBmoExtractionRules_();case'CIBC':return vfcCibcExtractionRules_();case'COAST_CAPITAL':return vfcCoastCapitalExtractionRules_();default:return'Extract conservatively. Do not infer missing transactions.';}}
function vfcLockBankStatementFacts_(bankId,summary,text,fileName){switch(String(bankId||'').toUpperCase()){case'RBC':return vfcRbcLockFacts_(summary,text,fileName);case'TD':return vfcTdLockFacts_(summary,text,fileName);case'SCOTIA':return vfcScotiaLockFacts_(summary,text,fileName);case'BMO':return vfcBmoLockFacts_(summary,text,fileName);case'CIBC':return vfcCibcLockFacts_(summary,text,fileName);case'COAST_CAPITAL':return vfcCoastCapitalLockFacts_(summary,text,fileName);default:return vfcLockPrintedStatementFacts_(summary,text);}}

/** Normalize AI document labels so BUSINESS_BANK_STATEMENT etc. cannot skip ledger freezing. */
function vfcNormalizeBankDocumentType_(value,summary){
  const s=String(value||'').trim().toUpperCase().replace(/[^A-Z0-9]+/g,'_');
  if(/^(NOT|NON)_?BANK/.test(s)||/NOT_BANK_STATEMENT|NON_BANK_STATEMENT/.test(s))return'NOT_BANK_STATEMENT';
  if((/BANK/.test(s)&&/STATEMENT/.test(s))||Array.isArray(summary&&summary.banking_transactions))return'BANK_STATEMENT';
  return'BANK_STATEMENT';
}

/** Single upload entry point used by the UI for every bank. */
function uploadStatementBatchByBank(bankId,companyName,files){
  const profile=vfcGetBankProfile_(bankId);if(profile.id==='UNKNOWN')throw new Error('Select a supported bank.');if(!companyName)throw new Error('Company name is required.');if(!files||!files.length)throw new Error('Upload at least one PDF.');
  const company=getOrCreateCompany_(companyName),companyFolder=DriveApp.getFolderById(company.folderId),tempFolder=getOrCreateSubFolder_(companyFolder,'_TEMP_PROCESSING'),staged=[];
  files.forEach(function(file){const fileName=file.name||'statement.pdf',blob=Utilities.newBlob(Utilities.base64Decode(file.base64),'application/pdf',fileName.toLowerCase().endsWith('.pdf')?fileName:fileName+'.pdf'),tempFile=tempFolder.createFile(blob),text=extractTextFromPdf_(tempFile.getId()),detected=vfcDetectBankId_(text);if(detected!=='UNKNOWN'&&detected!==profile.id){tempFile.setTrashed(true);throw new Error('Bank mismatch: '+fileName+' appears to be '+vfcGetBankProfile_(detected).label+', but '+profile.label+' was selected.');}staged.push({uploadId:Utilities.getUuid(),fileName:fileName,fileId:tempFile.getId(),fileUrl:tempFile.getUrl(),text:text});});
  const summaries=callOpenAIJsonBatch_(staged.map(function(item){return vfcBuildBankStatementPrompt_(profile,item.text,companyName,item.fileName);}));if(summaries.length!==staged.length)throw new Error(profile.label+' statement reader returned an incomplete batch.');
  const starts=[],ends=[];
  const processed=staged.map(function(item,index){
    let summary=summaries[index]||{};
    summary=vfcLockBankStatementFacts_(profile.id,summary,item.text,item.fileName)||summary;
    summary.bank_name=profile.label;
    summary.document_type=vfcNormalizeBankDocumentType_(summary.document_type,summary);
    if(summary.document_type==='NOT_BANK_STATEMENT')throw new Error(item.fileName+' was not recognized as a bank statement.');
    if(!Array.isArray(summary.banking_transactions))throw new Error('Banking ledger extraction was incomplete for '+item.fileName+'.');
    summary.possible_mca_or_loan_payments=vfcBankCreateIntakePayload_(summary,item.fileName);
    const frozen=vfcParseBankCache_(summary.possible_mca_or_loan_payments);
    if(!vfcPayloadUsable_(frozen))throw new Error('Frozen banking ledger could not be created for '+item.fileName+'. Upload was stopped before saving incomplete facts.');
    const startDate=parseDateSafe_(summary.statement_start_date),endDate=parseDateSafe_(summary.statement_end_date);if(startDate)starts.push(startDate);if(endDate)ends.push(endDate);
    return{uploadId:item.uploadId,fileName:item.fileName,fileId:item.fileId,fileUrl:item.fileUrl,summary:summary};
  });
  if(!starts.length||!ends.length)throw new Error(profile.label+' statement dates could not be verified.');
  const period=buildDetectedPeriod_(starts,ends),periodFolder=getOrCreateSubFolder_(companyFolder,period.label),uploadRows=[],pdfRows=[],batchInput=[],now=new Date();
  processed.forEach(function(item){const driveFile=DriveApp.getFileById(item.fileId);periodFolder.addFile(driveFile);tempFolder.removeFile(driveFile);uploadRows.push([item.uploadId,company.companyId,companyName,period.label,item.fileName,item.fileId,item.fileUrl,'READ',now]);pdfRows.push([item.uploadId,companyName,period.label,item.fileName,'BANK_STATEMENT',profile.label,item.summary.account_holder||'',item.summary.statement_start_date||'',item.summary.statement_end_date||'',item.summary.opening_balance||'',item.summary.closing_balance||'',item.summary.total_deposits||'',item.summary.total_withdrawals||'',item.summary.nsf_count||'',item.summary.negative_balance_detected||'',item.summary.possible_mca_or_loan_payments||'',item.summary.summary||'',item.summary.risks||'',item.summary.missing_info||'',now]);batchInput.push({fileName:item.fileName,summary:item.summary});});
  appendRows_('Uploads',uploadRows);appendRows_('PDF Summaries',pdfRows);const batch=summarizeBatch_(batchInput,companyName,period.label);appendRow_('Batch Summaries',[Utilities.getUuid(),companyName,period.label,files.length,period.earliest||'',period.latest||'',batch.combined_summary||'',batch.key_findings||'',batch.risks||'',batch.missing_info||'',new Date()]);upsertStructuredFeature_(companyName,period.label);vfcFreezeDuplicateStatementFacts_(companyName,period.label);
  return{ok:true,intakeModelVersion:VFC_BANK_ENGINE.VERSION,bankProfile:profile.id,bankRulesVersion:profile.rulesVersion,bankTrainingStatus:profile.status,companyName:companyName,detectedPeriod:period.label,filesUploaded:files.length,companyFolderLink:company.folderLink,periodFolderLink:periodFolder.getUrl(),batchSummary:batch};
}

function vfcBuildBankStatementPrompt_(profile,text,companyName,fileName){return[
  'You are the VFC '+profile.label+' Bank Statement Fact Reader. Return JSON only.','Company: '+companyName,'File: '+fileName,'Selected bank profile: '+profile.id+' / '+profile.rulesVersion,
  'FACT EXTRACTION ONLY. Do not underwrite, estimate debt service, or infer frequency.',
  'Return fields: document_type, bank_name, account_holder, statement_start_date, statement_end_date, opening_balance, closing_balance, total_deposits, total_withdrawals, nsf_count, negative_balance_detected, banking_transactions, summary, risks, missing_info.',
  'For a valid bank statement set document_type exactly to BANK_STATEMENT.',
  'banking_transactions is an array of {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
  'COMMON RULES:','1. Header totals come from the printed statement summary, never by summing the transaction list.','2. Printed debit/withdrawal versus credit/deposit columns control direction; wording never overrides the printed column.','3. Preserve exact amounts and visible descriptions. Never borrow an amount from an adjacent row.','4. Do not duplicate cheque-image pages when the transaction already appears in account activity.','5. Extract financing/loan/MCA/PAD/advance/funding activity, loan interest, recurring PADs, tax/government, insurance/premium finance, credit-card payments, and explicit equipment finance/lease payments.','6. Extract NSF, returned/unpaid items, reversals and overdraft/over-limit events so banking conduct is frozen with the statement facts.','7. Also extract incoming credits of $5,000 or more when they could plausibly be financing. Classification happens later.','8. If uncertain, omit a transaction rather than inventing one.','BANK-SPECIFIC RULES:',vfcBankExtractionRules_(profile.id),'Document text:',String(text||'').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
].join('\n');}

function vfcFreezeDuplicateStatementFacts_(companyName,period){
  const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');if(!sh||sh.getLastRow()<2)return;const values=sh.getDataRange().getValues(),headers=values[0].map(vfcHeader_),idx={};headers.forEach(function(h,i){idx[h]=i;});const signalCol=idx[vfcHeader_('Possible MCA Or Loan Payments')];if(signalCol===undefined)return;function val(r,n){const i=idx[vfcHeader_(n)];return i===undefined?'':r[i];}const groups={};
  for(let i=1;i<values.length;i++){const r=values[i];if(!vfcSame_(val(r,'Company Name'),companyName)||!vfcSame_(val(r,'Detected Period'),period))continue;const row={rowNumber:i+1,bank:String(val(r,'Bank Name')||''),startDate:val(r,'Statement Start Date'),endDate:val(r,'Statement End Date'),opening:vfcNumNull_(val(r,'Opening Balance')),closing:vfcNumNull_(val(r,'Closing Balance')),deposits:vfcNumNull_(val(r,'Total Deposits')),withdrawals:vfcNumNull_(val(r,'Total Withdrawals')),signalRaw:String(val(r,'Possible MCA Or Loan Payments')||''),createdAt:val(r,'Created At')},key=vfcStatementFingerprint_(row);if(!groups[key])groups[key]=[];groups[key].push(row);}
  Object.keys(groups).forEach(function(key){const rows=groups[key].sort(function(a,b){return vfcTime_(a.createdAt)-vfcTime_(b.createdAt);});let canonical='';for(let i=0;i<rows.length;i++){const p=vfcParseBankCache_(rows[i].signalRaw);if(vfcPayloadUsable_(p)){canonical=rows[i].signalRaw;break;}}if(!canonical)return;rows.forEach(function(r){if(String(r.signalRaw||'')!==canonical)sh.getRange(r.rowNumber,signalCol+1).setValue(canonical);});});
}

function setupBankTrainingTabs(){const ss=SpreadsheetApp.getActiveSpreadsheet(),headers=['Bank','Training Status','Parser / Rules Version','Statement Format Notes','Debit Markers','Credit Markers','Financing Keywords','Recurring Payment Notes','Test Company','Test Period','Expected Gross Deposits','Expected Operating Deposits','Expected Monthly Debt','Expected Financing Credits','Last Validated','Notes'],created=[];vfcBankRegistry_().forEach(function(bank){const sheetName='BANK_'+bank.id;let sh=ss.getSheetByName(sheetName);if(!sh){sh=ss.insertSheet(sheetName);created.push(sheetName);}if(sh.getLastRow()===0){sh.getRange(1,1,1,headers.length).setValues([headers]);sh.setFrozenRows(1);sh.getRange(2,1,1,headers.length).setValues([[bank.label,bank.status,bank.rulesVersion,'','','','','','','','','','','','','']]);sh.autoResizeColumns(1,headers.length);}else{sh.getRange(2,1).setValue(bank.label);sh.getRange(2,2).setValue(bank.status);sh.getRange(2,3).setValue(bank.rulesVersion);}});return{ok:true,created:created,tabs:getBankParserTabs()};}

/** Pending-bank fallback: deliberately conservative; no RBC assumptions. */
function vfcGenericConservativeClassifyDebit_(t){const s=String(t.description||'').toUpperCase().replace(/\s+/g,' ').trim();if(/\bFEE\b|SERVICE\s+CHARGE|NSF|OVERDRAFT\s+INTEREST/.test(s))return null;if(/\bCRA\b|\bCCRA\b|GST|HST|\bTAX\b/.test(s)){const k=vfcCounterpartyKey_(t.counterparty||t.description);return Object.assign({},t,{family:'TAX',entityKey:k,key:k,label:t.counterparty||t.description});}if(/INSURANCE|PREMIUM\s+FIN/.test(s)){const k=vfcCounterpartyKey_(t.counterparty||t.description);return Object.assign({},t,{family:'OTHER',entityKey:k,key:k,label:t.counterparty||t.description});}if(/LOAN\s+(PAYMENT|PMT|PYMT|INTEREST)|\bMCA\b|MERCHANT\s+CASH\s+ADVANCE|FINANCING\s+PAYMENT/.test(s)){const k=vfcCounterpartyKey_(t.counterparty||t.description);return Object.assign({},t,{family:'FINANCING',entityKey:k,key:k,label:t.counterparty||t.description});}return null;}
