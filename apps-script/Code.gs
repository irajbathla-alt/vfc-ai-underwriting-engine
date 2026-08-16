const VFC_CONFIG = {
  ROOT_FOLDER_NAME: 'VFC AI Engine',
  OPENAI_MODEL: 'gpt-4.1-mini',
  OCR_RETRY_ATTEMPTS: 4,
  OCR_DELAY_MS: 1000,
  MODEL_VERSION: 'VFC-V1.1-FAST-INTAKE',
  MAX_SIMILAR_CASES: 10,
  STATEMENT_TEXT_LIMIT: 50000
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('VFC AI Underwriting Engine')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function setupVFC() {
  const schemas = {
    'Companies': ['Company ID','Company Name','Folder ID','Folder Link','Created At'],
    'Uploads': ['Upload ID','Company ID','Company Name','Detected Period','File Name','File ID','File Link','Status','Created At'],
    'PDF Summaries': ['Upload ID','Company Name','Detected Period','File Name','Document Type','Bank Name','Account Holder','Statement Start Date','Statement End Date','Opening Balance','Closing Balance','Total Deposits','Total Withdrawals','NSF Count','Negative Balance Detected','Possible MCA Or Loan Payments','Summary','Risks','Missing Info','Created At'],
    'Batch Summaries': ['Batch ID','Company Name','Detected Period','Files Read','Earliest Statement Date','Latest Statement Date','Combined Summary','Key Findings','Risks','Missing Info','Created At'],
    'Settings': ['Key','Value'],
    'Lenders': ['Lender ID','Lender Name','Product Type','Notes','Status','Created At'],
    'Observed Lender Behaviour': ['Behaviour ID','Lender Name','Company Name','Period','Decision','Approved Amount','Decline Reason','Observed Pattern Note','Created At'],
    'Training Records': ['Training ID','Company Name','Period','Lender Name','Decision','Approved Amount','Decline Reason','Bank Summary','Key Findings','Risks','Missing Info','Created At'],
    'Structured Features': ['Feature ID','Company Name','Period','Statement Count','Months Covered','Total Deposits','Average Monthly Deposits','Total Withdrawals','Deposit Withdrawal Ratio','NSF Count','Negative Balance Flag','MCA Payment Flag','Summary Text','Updated At'],
    'Underwriting Assessments': ['Assessment ID','Model Version','Company Name','Period','Lender Name','Observed Fit','Observed Score','Confidence','Historical Cases','Similar Cases','Similar Approvals','Similar Declines','Observed Approval Rate','Low Approved Amount','High Approved Amount','Median Approved Amount','Reasoning','Risks','Created At'],
    'AI Recommendations': ['Recommendation ID','Company Name','Period','Recommended Lender','Fit Level','Reasoning','Risks','Missing Info','Created At'],
    'Deal Outcomes': ['Outcome ID','Company Name','Period','Selected Lender','AI Recommended Lender','Final Result','Funded Amount','Funded Date','Why This Lender Won','Admin Notes','Created At']
  };
  Object.keys(schemas).forEach(function(name){ ensureSheetSchema_(name, schemas[name]); });
  getOrCreateRootFolder_();
  seedDefaultLenders_();
  return {ok:true,message:'VFC Underwriting Engine setup complete. Existing data was preserved.'};
}

/**
 * Fast one-click intake:
 * PDF save/OCR -> parallel OpenAI fact reads -> deterministic header lock -> batch Sheet writes.
 */
function uploadStatementBatch(companyName, files) {
  if (!companyName) throw new Error('Company name is required.');
  if (!files || !files.length) throw new Error('Upload at least one PDF.');

  const company = getOrCreateCompany_(companyName);
  const companyFolder = DriveApp.getFolderById(company.folderId);
  const tempFolder = getOrCreateSubFolder_(companyFolder, '_TEMP_PROCESSING');
  const staged = [];

  files.forEach(function(file){
    const fileName = file.name || 'statement.pdf';
    const blob = Utilities.newBlob(
      Utilities.base64Decode(file.base64),
      'application/pdf',
      fileName.toLowerCase().endsWith('.pdf') ? fileName : fileName + '.pdf'
    );
    const tempFile = tempFolder.createFile(blob);
    const text = extractTextFromPdf_(tempFile.getId());
    staged.push({
      uploadId:Utilities.getUuid(),
      fileName:fileName,
      fileId:tempFile.getId(),
      fileUrl:tempFile.getUrl(),
      text:text
    });
  });

  const prompts = staged.map(function(item){
    return buildSingleBankStatementPrompt_(item.text, companyName, item.fileName);
  });
  const summaries = callOpenAIJsonBatch_(prompts);
  if (summaries.length !== staged.length) throw new Error('Statement reader returned an incomplete batch.');

  const starts = [];
  const ends = [];
  const processed = staged.map(function(item,index){
    let summary = summaries[index] || {};
    summary = vfcLockPrintedStatementFacts_(summary, item.text);

    const documentType = String(summary.document_type || '').trim().toUpperCase().replace(/\s+/g,'_');
    summary.document_type = documentType || 'BANK_STATEMENT';

    if (summary.document_type === 'BANK_STATEMENT') {
      if (!Array.isArray(summary.banking_transactions)) {
        throw new Error('Banking ledger extraction was incomplete for ' + item.fileName + '.');
      }
      if (typeof vfcBankCreateIntakePayload_ === 'function') {
        summary.possible_mca_or_loan_payments = vfcBankCreateIntakePayload_(summary, item.fileName);
      }
    }

    const startDate = parseDateSafe_(summary.statement_start_date);
    const endDate = parseDateSafe_(summary.statement_end_date);
    if (startDate) starts.push(startDate);
    if (endDate) ends.push(endDate);
    return {uploadId:item.uploadId,fileName:item.fileName,fileId:item.fileId,fileUrl:item.fileUrl,summary:summary};
  });

  if (!starts.length || !ends.length) {
    throw new Error('Statement dates could not be verified from the uploaded bank statements.');
  }

  const period = buildDetectedPeriod_(starts, ends);
  const periodFolder = getOrCreateSubFolder_(companyFolder, period.label);
  const uploadRows = [];
  const pdfRows = [];
  const batchInput = [];
  const now = new Date();

  processed.forEach(function(item){
    const driveFile = DriveApp.getFileById(item.fileId);
    periodFolder.addFile(driveFile);
    tempFolder.removeFile(driveFile);

    uploadRows.push([
      item.uploadId,company.companyId,companyName,period.label,item.fileName,item.fileId,item.fileUrl,
      item.summary.document_type === 'BANK_STATEMENT' ? 'READ' : 'REVIEW_REQUIRED',now
    ]);
    pdfRows.push([
      item.uploadId,companyName,period.label,item.fileName,item.summary.document_type || '',item.summary.bank_name || '',item.summary.account_holder || '',
      item.summary.statement_start_date || '',item.summary.statement_end_date || '',item.summary.opening_balance || '',item.summary.closing_balance || '',
      item.summary.total_deposits || '',item.summary.total_withdrawals || '',item.summary.nsf_count || '',item.summary.negative_balance_detected || '',
      item.summary.possible_mca_or_loan_payments || '',item.summary.summary || '',item.summary.risks || '',item.summary.missing_info || '',now
    ]);
    batchInput.push({fileName:item.fileName,summary:item.summary});
  });

  appendRows_('Uploads', uploadRows);
  appendRows_('PDF Summaries', pdfRows);

  const batch = summarizeBatch_(batchInput, companyName, period.label);
  appendRow_('Batch Summaries', [
    Utilities.getUuid(),companyName,period.label,files.length,period.earliest || '',period.latest || '',
    batch.combined_summary || '',batch.key_findings || '',batch.risks || '',batch.missing_info || '',new Date()
  ]);
  upsertStructuredFeature_(companyName, period.label);

  return {
    ok:true,
    intakeModelVersion:VFC_CONFIG.MODEL_VERSION,
    companyName:companyName,
    detectedPeriod:period.label,
    filesUploaded:files.length,
    companyFolderLink:company.folderLink,
    periodFolderLink:periodFolder.getUrl(),
    batchSummary:batch
  };
}

function saveLenderDecision(payload) {
  const companyName = payload.companyName || '';
  const period = payload.period || '';
  const lenderName = payload.lenderName || '';
  const decision = normalizeDecision_(payload.decision);
  const approvedAmount = decision === 'Declined' ? '' : payload.approvedAmount || '';
  const declineReason = decision === 'Approved' ? '' : payload.declineReason || '';
  const batch = getLatestBatchSummary_(companyName, period) || {};
  appendRow_('Observed Lender Behaviour', [Utilities.getUuid(),lenderName,companyName,period,decision,approvedAmount,declineReason,payload.notes || 'Saved from VFC intake page.',new Date()]);
  appendRow_('Training Records', [Utilities.getUuid(),companyName,period,lenderName,decision,approvedAmount,declineReason,batch.combinedSummary || batch.combined_summary || '',batch.keyFindings || batch.key_findings || '',batch.risks || '',batch.missingInfo || batch.missing_info || '',new Date()]);
  upsertStructuredFeature_(companyName, period);
  return {ok:true,message:'Historical lender outcome saved to the VFC training dataset.'};
}

function rebuildStructuredFeatures() {
  setupVFC();
  const pairs = {};
  getSheetObjects_('PDF Summaries').forEach(function(row){
    const company = row.companyName || '';
    const period = row.detectedPeriod || '';
    if (company) pairs[normalizeKey_(company,period)] = {companyName:company,period:period};
  });
  collectHistoricalOutcomes_().forEach(function(row){
    if (row.companyName) pairs[normalizeKey_(row.companyName,row.period)] = {companyName:row.companyName,period:row.period || ''};
  });
  let updated = 0;
  Object.keys(pairs).forEach(function(key){ upsertStructuredFeature_(pairs[key].companyName,pairs[key].period); updated++; });
  return {ok:true,recordsUpdated:updated,message:'Structured historical features rebuilt.'};
}

function buildFeaturesForCase_(companyName, period) {
  const pdfRows = getSheetObjects_('PDF Summaries').filter(function(row){
    return sameText_(row.companyName,companyName) && (!period || sameText_(row.detectedPeriod,period));
  });
  const batch = getLatestBatchSummary_(companyName,period) || {};
  if (!pdfRows.length && !batch.companyName) return null;

  const starts = pdfRows.map(function(row){return parseDateSafe_(row.statementStartDate);}).filter(Boolean);
  const ends = pdfRows.map(function(row){return parseDateSafe_(row.statementEndDate);}).filter(Boolean);
  const monthsCovered = estimateMonthsCovered_(starts,ends,pdfRows.length);
  const totalDeposits = pdfRows.reduce(function(sum,row){return sum + toNumber_(row.totalDeposits);},0);
  const totalWithdrawals = pdfRows.reduce(function(sum,row){return sum + toNumber_(row.totalWithdrawals);},0);
  const nsfCount = pdfRows.reduce(function(sum,row){return sum + toNumber_(row.nsfCount);},0);
  const negativeFlag = pdfRows.some(function(row){return truthyFlag_(row.negativeBalanceDetected);}) ? 1 : 0;
  const mcaFlag = pdfRows.some(function(row){return hasMeaningfulMca_(row.possibleMcaOrLoanPayments);}) ? 1 : 0;

  return {
    companyName:companyName,
    period:period || (pdfRows[0] ? pdfRows[0].detectedPeriod : ''),
    statementCount:pdfRows.length,
    monthsCovered:monthsCovered,
    totalDeposits:round2_(totalDeposits),
    averageMonthlyDeposits:round2_(totalDeposits / Math.max(monthsCovered,1)),
    totalWithdrawals:round2_(totalWithdrawals),
    depositWithdrawalRatio:round2_(totalWithdrawals ? totalDeposits / totalWithdrawals : totalDeposits ? 10 : 0),
    nsfCount:nsfCount,
    negativeBalanceFlag:negativeFlag,
    mcaPaymentFlag:mcaFlag,
    summaryText:cleanCell_([batch.combinedSummary || batch.combined_summary || '',batch.keyFindings || batch.key_findings || '',batch.risks || ''])
  };
}

function upsertStructuredFeature_(companyName, period) {
  const features = buildFeaturesForCase_(companyName,period);
  if (!features) return null;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Structured Features');
  const values = sheet.getDataRange().getValues();
  let rowNumber = 0;
  for (let i=1;i<values.length;i++) {
    if (sameText_(values[i][1],companyName) && sameText_(values[i][2],period)) { rowNumber=i+1; break; }
  }
  const row = [Utilities.getUuid(),companyName,period,features.statementCount,features.monthsCovered,features.totalDeposits,features.averageMonthlyDeposits,features.totalWithdrawals,features.depositWithdrawalRatio,features.nsfCount,features.negativeBalanceFlag,features.mcaPaymentFlag,features.summaryText,new Date()].map(cleanCell_);
  if (rowNumber) {
    row[0] = values[rowNumber-1][0] || row[0];
    sheet.getRange(rowNumber,1,1,row.length).setValues([row]);
  } else sheet.appendRow(row);
  return features;
}

function collectHistoricalOutcomes_() {
  let rows = [];
  ['Training Records','Observed Lender Behaviour','Lender Decisions'].forEach(function(sheetName){
    getSheetObjects_(sheetName).forEach(function(row){
      rows.push({
        companyName:row.companyName || '',period:row.period || row.detectedPeriod || '',lenderName:row.lenderName || '',
        decision:row.decision || row.finalResult || '',approvedAmount:row.approvedAmount || row.fundedAmount || '',
        declineReason:row.declineReason || '',createdAt:row.createdAt || ''
      });
    });
  });
  const seen = {};
  return rows.filter(function(row){return row.companyName && row.lenderName && row.decision;}).filter(function(row){
    const key=[row.companyName,row.period,row.lenderName,row.decision,row.approvedAmount,row.declineReason].map(function(v){return String(v).trim().toLowerCase();}).join('|');
    if(seen[key])return false; seen[key]=true; return true;
  });
}

function extractTextFromPdf_(fileId) {
  const sourceFile = DriveApp.getFileById(fileId);
  const pdfBlob = sourceFile.getBlob().setContentType('application/pdf').setName(sourceFile.getName());
  let lastError = null;
  for (let attempt=1;attempt<=VFC_CONFIG.OCR_RETRY_ATTEMPTS;attempt++) {
    try {
      const converted = Drive.Files.insert({title:'OCR_'+sourceFile.getName()},pdfBlob,{convert:true,ocr:true,ocrLanguage:'en'});
      const doc = DocumentApp.openById(converted.id);
      const text = doc.getBody().getText();
      DriveApp.getFileById(converted.id).setTrashed(true);
      return text || '';
    } catch(error) {
      lastError=error;
      const message=String(error && error.message || error);
      const retryable=/rate limit|quota|user rate limit|backend error|internal error/i.test(message);
      if(!retryable || attempt===VFC_CONFIG.OCR_RETRY_ATTEMPTS)break;
      Utilities.sleep(Math.min(15000,VFC_CONFIG.OCR_DELAY_MS*Math.pow(2,attempt-1)));
    }
  }
  throw new Error('Google Drive OCR is temporarily unavailable after automatic retries. Original error: '+String(lastError && lastError.message || lastError));
}

function buildSingleBankStatementPrompt_(text, companyName, fileName) {
  return [
    'You are the VFC AI Bank Statement Fact Reader. Return JSON only.',
    'Company: '+companyName,
    'File: '+fileName,
    'Return fields: document_type, bank_name, account_holder, statement_start_date, statement_end_date, opening_balance, closing_balance, total_deposits, total_withdrawals, nsf_count, negative_balance_detected, banking_transactions, summary, risks, missing_info.',
    'banking_transactions is an array: {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
    'FACT EXTRACTION ONLY. Do not underwrite.',
    'Printed bank column controls direction. Deposits/Credits=CREDIT. Cheques/Debits=DEBIT. Wording never overrides the column.',
    'Extract financing/loan/PAD/MCA/advance/funding/capital transactions, loan interest, recurring PADs, tax/government payments, insurance/premium finance and credit-card payments.',
    'Also extract incoming credits of $5,000 or more when they could plausibly be financing. Deterministic code will classify them.',
    'Do not extract ordinary suppliers, payroll, customer receipts, utilities, fuel, phone or bank fees unless clearly financing/tax/insurance.',
    'Do not duplicate cheque-image pages. If uncertain, omit the transaction.',
    'Header totals must come from the statement summary/header, not transaction summing. The program independently verifies printed totals.',
    'Use YYYY-MM-DD dates. If not a bank statement, set document_type=NOT_BANK_STATEMENT and banking_transactions=[].',
    'Document text:',String(text || '').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
  ].join('\n');
}

function summarizeSingleBankStatement_(text, companyName, fileName) {
  return callOpenAIJson_(buildSingleBankStatementPrompt_(text,companyName,fileName));
}

function vfcLockPrintedStatementFacts_(summary,text) {
  summary=summary || {};
  const facts=vfcExtractPrintedStatementFacts_(text);
  if(facts.startDate)summary.statement_start_date=facts.startDate;
  if(facts.endDate)summary.statement_end_date=facts.endDate;
  if(facts.totalsVerified){
    summary.opening_balance=facts.opening;
    summary.closing_balance=facts.closing;
    summary.total_deposits=facts.deposits;
    summary.total_withdrawals=facts.withdrawals;
  }
  return summary;
}

function vfcExtractPrintedStatementFacts_(text) {
  const source=String(text || '').replace(/\u00a0/g,' ');
  const out={startDate:'',endDate:'',opening:null,closing:null,deposits:null,withdrawals:null,totalsVerified:false};
  const monthRange=source.match(/([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})\s+(?:to|through|[-–—])\s+([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i);
  const isoRange=source.match(/(\d{4}-\d{2}-\d{2})\s+(?:to|through|[-–—])\s+(\d{4}-\d{2}-\d{2})/i);
  const range=monthRange || isoRange;
  if(range){out.startDate=vfcPrintedIsoDate_(range[1]);out.endDate=vfcPrintedIsoDate_(range[2]);}
  const printedDate='(?:[A-Za-z]{3,9}\\s+\\d{1,2},\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})';
  out.opening=vfcPrintedMoneyAfter_(source,[new RegExp('Opening\\s+balance(?:\\s+on\\s+'+printedDate+')?\\s+([+\\-]?\\s*\\$?\\s*\\(?\\-?\\$?[\\d,]+(?:\\.\\d{2})?\\)?)','i'),/Beginning\s+balance\s+([+\-]?\s*\$?\s*\(?\-?\$?[\d,]+(?:\.\d{2})?\)?)/i]);
  out.closing=vfcPrintedMoneyAfter_(source,[new RegExp('Closing\\s+balance(?:\\s+on\\s+'+printedDate+')?\\s*(?:=)?\\s*([+\\-]?\\s*\\$?\\s*\\(?\\-?\\$?[\\d,]+(?:\\.\\d{2})?\\)?)','i'),/Ending\s+balance\s+([+\-]?\s*\$?\s*\(?\-?\$?[\d,]+(?:\.\d{2})?\)?)/i]);
  out.deposits=vfcPrintedMoneyAfter_(source,[/Total\s+deposits\s*(?:&|and)\s*credits(?:\s*\(\d+\))?\s*([+\-]?\s*\$?\s*[\d,]+(?:\.\d{2})?)/i,/Total\s+credits(?:\s*\(\d+\))?\s*([+\-]?\s*\$?\s*[\d,]+(?:\.\d{2})?)/i,/Total\s+deposits(?:\s*\(\d+\))?\s*([+\-]?\s*\$?\s*[\d,]+(?:\.\d{2})?)/i]);
  out.withdrawals=vfcPrintedMoneyAfter_(source,[/Total\s+cheques?\s*(?:&|and)\s*debits(?:\s*\(\d+\))?\s*([+\-]?\s*\$?\s*[\d,]+(?:\.\d{2})?)/i,/Total\s+withdrawals(?:\s*\(\d+\))?\s*([+\-]?\s*\$?\s*[\d,]+(?:\.\d{2})?)/i,/Total\s+debits(?:\s*\(\d+\))?\s*([+\-]?\s*\$?\s*[\d,]+(?:\.\d{2})?)/i]);
  if(out.deposits!==null)out.deposits=Math.abs(out.deposits);
  if(out.withdrawals!==null)out.withdrawals=Math.abs(out.withdrawals);
  if(out.opening!==null && out.closing!==null && out.deposits!==null && out.withdrawals!==null){
    const diff=(out.opening+out.deposits-out.withdrawals)-out.closing;
    out.totalsVerified=Math.abs(diff)<=5;
  }
  return out;
}

function vfcPrintedMoneyAfter_(source,patterns){
  for(let i=0;i<patterns.length;i++){
    const match=source.match(patterns[i]);
    if(!match || !match[1])continue;
    const value=vfcPrintedMoney_(match[1]);
    if(value!==null)return value;
  }
  return null;
}
function vfcPrintedMoney_(value){
  const raw=String(value || '').trim();
  if(!raw)return null;
  const negative=/^\s*-/.test(raw) || /-\s*\$/.test(raw) || /^\s*\(/.test(raw);
  const cleaned=raw.replace(/[^0-9.]/g,'');
  if(!cleaned)return null;
  const number=parseFloat(cleaned);
  return isFinite(number) ? (negative ? -number : number) : null;
}
function vfcPrintedIsoDate_(value){
  if(!value)return '';
  const direct=String(value).match(/^\d{4}-\d{2}-\d{2}$/);
  if(direct)return direct[0];
  const date=new Date(value);
  return isNaN(date.getTime()) ? '' : Utilities.formatDate(date,Session.getScriptTimeZone(),'yyyy-MM-dd');
}

/** No seventh OpenAI request. */
function summarizeBatch_(items,companyName,detectedPeriod){
  const statements=(items || []).map(function(item){return item.summary || {};});
  const totalDeposits=statements.reduce(function(sum,s){return sum+toNumber_(s.total_deposits);},0);
  const totalWithdrawals=statements.reduce(function(sum,s){return sum+toNumber_(s.total_withdrawals);},0);
  const nsf=statements.reduce(function(sum,s){return sum+toNumber_(s.nsf_count);},0);
  const negative=statements.some(function(s){return truthyFlag_(s.negative_balance_detected);});
  const banks=unique_(statements.map(function(s){return s.bank_name;}).filter(Boolean));
  return {
    combined_summary:companyName+' | '+detectedPeriod+' | '+statements.length+' bank statement(s) verified. Gross deposits: $'+round2_(totalDeposits)+'. Gross withdrawals: $'+round2_(totalWithdrawals)+'.',
    key_findings:'Bank(s): '+(banks.join(', ') || 'Not identified')+'. Statement headers and ledger facts captured during intake.',
    risks:(nsf ? 'NSF/returned-item indications observed: '+nsf+'. ' : '')+(negative ? 'Negative-balance activity was detected.' : ''),
    missing_info:''
  };
}

function callOpenAIJsonBatch_(prompts){
  if(!Array.isArray(prompts) || !prompts.length)return [];
  const apiKey=PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if(!apiKey)throw new Error('Missing OPENAI_API_KEY in Script Properties.');
  const requests=prompts.map(function(prompt){return {
    url:'https://api.openai.com/v1/responses',method:'post',contentType:'application/json',
    headers:{Authorization:'Bearer '+apiKey},
    payload:JSON.stringify({model:VFC_CONFIG.OPENAI_MODEL,input:prompt,text:{format:{type:'json_object'}}}),
    muteHttpExceptions:true
  };});
  const responses=UrlFetchApp.fetchAll(requests);
  return responses.map(function(response,index){return parseOpenAIJsonResponse_(response,'statement '+(index+1));});
}

function callOpenAIJson_(prompt){
  const apiKey=PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if(!apiKey)throw new Error('Missing OPENAI_API_KEY in Script Properties.');
  const response=UrlFetchApp.fetch('https://api.openai.com/v1/responses',{
    method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+apiKey},
    payload:JSON.stringify({model:VFC_CONFIG.OPENAI_MODEL,input:prompt,text:{format:{type:'json_object'}}}),muteHttpExceptions:true
  });
  return parseOpenAIJsonResponse_(response,'OpenAI');
}
function parseOpenAIJsonResponse_(response,label){
  const code=response.getResponseCode ? response.getResponseCode() : 200;
  const text=response.getContentText ? response.getContentText() : String(response || '');
  let body;
  try{body=JSON.parse(text);}catch(e){throw new Error((label || 'OpenAI')+' returned invalid JSON (HTTP '+code+').');}
  if(body.error)throw new Error((label || 'OpenAI')+': '+body.error.message);
  if(code<200 || code>=300)throw new Error((label || 'OpenAI')+' failed with HTTP '+code+'.');
  let outputText=body.output_text || '';
  if(!outputText && body.output && body.output[0] && body.output[0].content && body.output[0].content[0])outputText=body.output[0].content[0].text || '';
  if(!outputText)throw new Error((label || 'OpenAI')+' response text not found.');
  try{return JSON.parse(outputText);}catch(e){throw new Error((label || 'OpenAI')+' returned non-JSON output.');}
}

function getLatestBatchSummary_(companyName,period){
  const rows=getSheetObjects_('Batch Summaries').filter(function(row){return sameText_(row.companyName,companyName) && (!period || sameText_(row.detectedPeriod,period));});
  return rows.length ? rows[rows.length-1] : null;
}
function getSheetObjects_(sheetName){
  const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if(!sheet)return [];
  const values=sheet.getDataRange().getValues();
  if(values.length<2)return [];
  const headers=values[0].map(normalizeHeader_);
  return values.slice(1).filter(function(row){return row.some(function(cell){return String(cell).trim()!=='';});}).map(function(row){
    const obj={};headers.forEach(function(header,index){obj[header]=row[index];});return obj;
  });
}
function ensureSheetSchema_(sheetName,headers){
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  let sheet=ss.getSheetByName(sheetName);
  if(!sheet)sheet=ss.insertSheet(sheetName);
  if(sheet.getLastRow()===0){sheet.appendRow(headers);return;}
  const current=sheet.getRange(1,1,1,Math.max(sheet.getLastColumn(),1)).getValues()[0].map(function(v){return String(v).trim();});
  headers.forEach(function(header){if(current.indexOf(header)===-1){current.push(header);sheet.getRange(1,current.length).setValue(header);}});
}
function appendRow_(sheetName,row){
  const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if(!sheet)throw new Error('Missing sheet: '+sheetName+'.');
  sheet.appendRow(row.map(cleanCell_));
}
function appendRows_(sheetName,rows){
  if(!rows || !rows.length)return;
  const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if(!sheet)throw new Error('Missing sheet: '+sheetName+'.');
  const clean=rows.map(function(row){return row.map(cleanCell_);});
  sheet.getRange(sheet.getLastRow()+1,1,clean.length,clean[0].length).setValues(clean);
}
function cleanCell_(value){
  if(value===null || value===undefined)return '';
  if(Object.prototype.toString.call(value)==='[object Date]')return value;
  if(Array.isArray(value))return value.map(cleanCell_).filter(Boolean).join('\n');
  if(typeof value==='object')return Object.keys(value).map(function(key){return key+': '+cleanCell_(value[key]);}).join('\n');
  return String(value);
}

function getOrCreateCompany_(companyName){
  const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Companies');
  const values=sheet.getDataRange().getValues();
  for(let i=1;i<values.length;i++)if(sameText_(values[i][1],companyName))return {companyId:values[i][0],companyName:values[i][1],folderId:values[i][2],folderLink:values[i][3]};
  const folder=getOrCreateSubFolder_(getOrCreateRootFolder_(),cleanFolderName_(companyName));
  const companyId=Utilities.getUuid();
  sheet.appendRow([companyId,companyName,folder.getId(),folder.getUrl(),new Date()]);
  return {companyId:companyId,companyName:companyName,folderId:folder.getId(),folderLink:folder.getUrl()};
}
function seedDefaultLenders_(){
  const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Lenders');
  const existing=getSheetObjects_('Lenders').map(function(row){return String(row.lenderName || '').toLowerCase();});
  ['Journey Capital','Merchant Growth','iCapital Financing','Canacap Funding'].forEach(function(name){if(existing.indexOf(name.toLowerCase())===-1)sheet.appendRow([Utilities.getUuid(),name,'Merchant Cash Advance','','Active',new Date()]);});
}
function getOrCreateRootFolder_(){const folders=DriveApp.getFoldersByName(VFC_CONFIG.ROOT_FOLDER_NAME);return folders.hasNext()?folders.next():DriveApp.createFolder(VFC_CONFIG.ROOT_FOLDER_NAME);}
function getOrCreateSubFolder_(parent,name){const cleanName=cleanFolderName_(name);const folders=parent.getFoldersByName(cleanName);return folders.hasNext()?folders.next():parent.createFolder(cleanName);}
function buildDetectedPeriod_(startDates,endDates){
  const all=(startDates || []).concat(endDates || []).filter(Boolean).sort(function(a,b){return a.getTime()-b.getTime();});
  if(!all.length)return {label:'Period Not Detected',earliest:'',latest:''};
  return {label:formatMonthYear_(all[0])+' to '+formatMonthYear_(all[all.length-1]),earliest:formatDate_(all[0]),latest:formatDate_(all[all.length-1])};
}
function estimateMonthsCovered_(starts,ends,fallback){
  if(starts.length && ends.length){const earliest=new Date(Math.min.apply(null,starts.map(function(d){return d.getTime();})));const latest=new Date(Math.max.apply(null,ends.map(function(d){return d.getTime();})));const days=Math.max(1,(latest-earliest)/(1000*60*60*24)+1);return Math.max(1,Math.round(days/30.4375));}
  return Math.max(1,fallback || 1);
}
function parseDateSafe_(value){if(!value)return null;const date=new Date(value);return isNaN(date.getTime())?null:date;}
function formatMonthYear_(date){return Utilities.formatDate(date,Session.getScriptTimeZone(),'MMM yyyy');}
function formatDate_(date){return Utilities.formatDate(date,Session.getScriptTimeZone(),'yyyy-MM-dd');}
function cleanFolderName_(name){return String(name || 'Unknown').replace(/[\\/:*?"<>|]/g,'-').trim();}
function normalizeHeader_(header){return String(header || '').trim().replace(/[^a-zA-Z0-9]+(.)/g,function(_,chr){return chr.toUpperCase();}).replace(/^[A-Z]/,function(c){return c.toLowerCase();});}
function normalizeKey_(company,period){return String(company || '').trim().toLowerCase()+'|'+String(period || '').trim().toLowerCase();}
function sameText_(a,b){return String(a || '').trim().toLowerCase()===String(b || '').trim().toLowerCase();}
function unique_(items){const seen={};return items.filter(function(item){const key=String(item).trim().toLowerCase();if(!key || seen[key])return false;seen[key]=true;return true;});}
function normalizeDecision_(value){const text=String(value || '').trim().toLowerCase();if(text.indexOf('approv')>=0)return 'Approved';if(text.indexOf('declin')>=0)return 'Declined';if(text.indexOf('condition')>=0)return 'Conditional';return value || '';}
function toNumber_(value){if(typeof value==='number')return isFinite(value)?value:0;const cleaned=String(value || '').replace(/[^0-9.\-]/g,'');const number=parseFloat(cleaned);return isFinite(number)?number:0;}
function truthyFlag_(value){return /yes|true|detected|negative|1/i.test(String(value || ''));}
function hasMeaningfulMca_(value){const text=String(cleanCell_(value) || '').trim();return !!text && !/^(no|none|not detected|false|0)$/i.test(text);}
function clamp_(value,min,max){return Math.max(min,Math.min(max,value));}
function round2_(value){return Math.round((Number(value) || 0)*100)/100;}
function median_(values){if(!values.length)return '';const middle=Math.floor(values.length/2);return values.length%2?values[middle]:Math.round((values[middle-1]+values[middle])/2*100)/100;}
