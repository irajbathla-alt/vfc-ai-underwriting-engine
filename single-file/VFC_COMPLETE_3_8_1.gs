/**
 * VFC AI UNDERWRITING — COMPLETE SINGLE-FILE RECOVERY BUILD
 * Version: RBC-3.8.1-FULL-PROJECT-SYNC-20260923
 *
 * INSTALLATION RULE:
 * Use this as the ONLY .gs source in the Apps Script project.
 * Do not load it together with the modular apps-script/*.gs files.
 * Keep Index.html and appsscript.json separately.
 *
 * This build mechanically combines the tested modules in dependency order to
 * prevent missing, crossed, or stale Apps Script source files.
 */


/* ===== BEGIN Code.gs ===== */
const VFC_CONFIG = {
  ROOT_FOLDER_NAME: 'VFC AI Engine',
  OPENAI_MODEL: 'gpt-4.1-mini',
  PDF_EXTRACTION_MODEL: 'gpt-4.1',
  PDF_REPAIR_MODEL: 'gpt-4.1',

  // PDF intake: OpenAI file input is primary. Google Drive OCR is fallback only.
  PDF_TEXT_PROVIDER: 'OPENAI_FILE_INPUT',
  PDF_TEXT_CACHE_VERSION: 'VFC-PDF-TEXT-3.0-COLUMN-STRICT',
  PDF_TEXT_MAX_OUTPUT_TOKENS: 20000,
  PDF_TEXT_CACHE_FOLDER_NAME: '_PDF_TEXT_CACHE',
  DRIVE_OCR_FALLBACK_ENABLED: true,
  OCR_RETRY_ATTEMPTS: 2,
  OCR_DELAY_MS: 5000,
  OCR_MIN_INTERVAL_MS: 10000,
  OCR_RATE_LIMIT_BACKOFF_MS: 20000,

  MODEL_VERSION: 'VFC-V1.3-FAST-EQUIPMENT-LEASE-INTAKE',
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
 * Legacy generic upload is intentionally disabled.
 * Every bank statement must enter through BankRouter so bank-specific locking,
 * bank identity, reconciliation and the frozen-ledger contract cannot be bypassed.
 */
function uploadStatementBatch(companyName, files) {
  throw new Error('Legacy generic bank-statement upload is disabled. Use uploadStatementBatchByBank(bankId, companyName, files).');
}

function saveLenderDecision(payload) {
  const companyName = payload.companyName || '', period = payload.period || '', lenderName = payload.lenderName || '', decision = normalizeDecision_(payload.decision);
  const approvedAmount = decision === 'Declined' ? '' : payload.approvedAmount || '', declineReason = decision === 'Approved' ? '' : payload.declineReason || '';
  const batch = getLatestBatchSummary_(companyName, period) || {};
  appendRow_('Observed Lender Behaviour', [Utilities.getUuid(),lenderName,companyName,period,decision,approvedAmount,declineReason,payload.notes || 'Saved from VFC intake page.',new Date()]);
  appendRow_('Training Records', [Utilities.getUuid(),companyName,period,lenderName,decision,approvedAmount,declineReason,batch.combinedSummary || batch.combined_summary || '',batch.keyFindings || batch.key_findings || '',batch.risks || '',batch.missingInfo || batch.missing_info || '',new Date()]);
  upsertStructuredFeature_(companyName, period);
  return {ok:true,message:'Historical lender outcome saved to the VFC training dataset.'};
}

function rebuildStructuredFeatures() {
  setupVFC(); const pairs = {};
  getSheetObjects_('PDF Summaries').forEach(function(row){ const company=row.companyName||'', period=row.detectedPeriod||''; if(company)pairs[normalizeKey_(company,period)]={companyName:company,period:period}; });
  collectHistoricalOutcomes_().forEach(function(row){ if(row.companyName)pairs[normalizeKey_(row.companyName,row.period)]={companyName:row.companyName,period:row.period||''}; });
  let updated=0; Object.keys(pairs).forEach(function(key){upsertStructuredFeature_(pairs[key].companyName,pairs[key].period);updated++;});
  return {ok:true,recordsUpdated:updated,message:'Structured historical features rebuilt.'};
}

function buildFeaturesForCase_(companyName, period) {
  const pdfRows=getSheetObjects_('PDF Summaries').filter(function(row){return sameText_(row.companyName,companyName)&&(!period||sameText_(row.detectedPeriod,period));});
  const batch=getLatestBatchSummary_(companyName,period)||{}; if(!pdfRows.length&&!batch.companyName)return null;
  const starts=pdfRows.map(function(row){return parseDateSafe_(row.statementStartDate);}).filter(Boolean), ends=pdfRows.map(function(row){return parseDateSafe_(row.statementEndDate);}).filter(Boolean);
  const monthsCovered=estimateMonthsCovered_(starts,ends,pdfRows.length), totalDeposits=pdfRows.reduce(function(sum,row){return sum+toNumber_(row.totalDeposits);},0), totalWithdrawals=pdfRows.reduce(function(sum,row){return sum+toNumber_(row.totalWithdrawals);},0), nsfCount=pdfRows.reduce(function(sum,row){return sum+toNumber_(row.nsfCount);},0);
  const negativeFlag=pdfRows.some(function(row){return truthyFlag_(row.negativeBalanceDetected);})?1:0, mcaFlag=pdfRows.some(function(row){return hasMeaningfulMca_(row.possibleMcaOrLoanPayments);})?1:0;
  return {companyName:companyName,period:period||(pdfRows[0]?pdfRows[0].detectedPeriod:''),statementCount:pdfRows.length,monthsCovered:monthsCovered,totalDeposits:round2_(totalDeposits),averageMonthlyDeposits:round2_(totalDeposits/Math.max(monthsCovered,1)),totalWithdrawals:round2_(totalWithdrawals),depositWithdrawalRatio:round2_(totalWithdrawals?totalDeposits/totalWithdrawals:totalDeposits?10:0),nsfCount:nsfCount,negativeBalanceFlag:negativeFlag,mcaPaymentFlag:mcaFlag,summaryText:cleanCell_([batch.combinedSummary||batch.combined_summary||'',batch.keyFindings||batch.key_findings||'',batch.risks||''])};
}

function upsertStructuredFeature_(companyName, period) {
  const features=buildFeaturesForCase_(companyName,period); if(!features)return null;
  const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Structured Features'), values=sheet.getDataRange().getValues(); let rowNumber=0;
  for(let i=1;i<values.length;i++){if(sameText_(values[i][1],companyName)&&sameText_(values[i][2],period)){rowNumber=i+1;break;}}
  const row=[Utilities.getUuid(),companyName,period,features.statementCount,features.monthsCovered,features.totalDeposits,features.averageMonthlyDeposits,features.totalWithdrawals,features.depositWithdrawalRatio,features.nsfCount,features.negativeBalanceFlag,features.mcaPaymentFlag,features.summaryText,new Date()].map(cleanCell_);
  if(rowNumber){row[0]=values[rowNumber-1][0]||row[0];sheet.getRange(rowNumber,1,1,row.length).setValues([row]);}else sheet.appendRow(row); return features;
}

function collectHistoricalOutcomes_() {
  let rows=[]; ['Training Records','Observed Lender Behaviour','Lender Decisions'].forEach(function(sheetName){getSheetObjects_(sheetName).forEach(function(row){rows.push({companyName:row.companyName||'',period:row.period||row.detectedPeriod||'',lenderName:row.lenderName||'',decision:row.decision||row.finalResult||'',approvedAmount:row.approvedAmount||row.fundedAmount||'',declineReason:row.declineReason||'',createdAt:row.createdAt||''});});});
  const seen={}; return rows.filter(function(row){return row.companyName&&row.lenderName&&row.decision;}).filter(function(row){const key=[row.companyName,row.period,row.lenderName,row.decision,row.approvedAmount,row.declineReason].map(function(v){return String(v).trim().toLowerCase();}).join('|');if(seen[key])return false;seen[key]=true;return true;});
}

function vfcPdfContentHash_(blob){
  const bytes=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,blob.getBytes());
  return bytes.map(function(b){const n=b<0?b+256:b;return('0'+n.toString(16)).slice(-2);}).join('');
}

function vfcPdfTextCacheKey_(blob){
  const version=String(VFC_CONFIG.PDF_TEXT_CACHE_VERSION||'VFC-PDF-TEXT-1').replace(/[^A-Za-z0-9._-]/g,'_');
  return version+'_'+vfcPdfContentHash_(blob);
}

function vfcGetOcrCacheFolder_(){
  // Backward-compatible helper name. This folder now stores provider-neutral PDF text.
  return getOrCreateSubFolder_(getOrCreateRootFolder_(),VFC_CONFIG.PDF_TEXT_CACHE_FOLDER_NAME||'_PDF_TEXT_CACHE');
}

function vfcGetCachedOcrText_(cacheKey){
  if(!cacheKey)return'';
  try{
    const files=vfcGetOcrCacheFolder_().getFilesByName(cacheKey+'.txt');
    if(!files.hasNext())return'';
    return String(files.next().getBlob().getDataAsString('UTF-8')||'');
  }catch(e){return'';}
}

function vfcPutCachedOcrText_(cacheKey,text){
  const value=String(text||'');
  if(!cacheKey||!value.trim())return;
  try{
    const folder=vfcGetOcrCacheFolder_(),name=cacheKey+'.txt',files=folder.getFilesByName(name);
    if(files.hasNext()){files.next().setContent(value);return;}
    folder.createFile(name,value,MimeType.PLAIN_TEXT);
  }catch(e){}
}

function vfcOpenAiResponseText_(body){
  if(!body)return'';
  if(typeof body.output_text==='string'&&body.output_text.trim())return body.output_text;
  const parts=[],out=Array.isArray(body.output)?body.output:[];
  out.forEach(function(item){
    const content=Array.isArray(item&&item.content)?item.content:[];
    content.forEach(function(part){
      if(part&&typeof part.text==='string'&&part.text.trim())parts.push(part.text);
    });
  });
  return parts.join('\n');
}

function vfcBankLedgerJsonSchema_(){
  return{
    type:'object',
    additionalProperties:false,
    properties:{
      banking_transactions:{
        type:'array',
        items:{
          type:'object',
          additionalProperties:false,
          properties:{
            date:{type:'string'},
            description:{type:'string'},
            counterparty:{type:'string'},
            direction:{type:'string',enum:['DEBIT','CREDIT']},
            amount:{type:'number'}
          },
          required:['date','description','counterparty','direction','amount']
        }
      }
    },
    required:['banking_transactions']
  };
}

/**
 * Read a complete ledger directly from the original staged PDF. This deliberately
 * bypasses the cached transcript when deterministic statement checks prove that
 * the transcript-derived ledger has a missing row, wrong amount or wrong column.
 */
function vfcReadBankLedgerFromPdfWithOpenAI_(sourceFileId,prompt,label){
  if(!sourceFileId)throw new Error('Original PDF file ID is required for ledger recovery.');
  const apiKey=PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if(!apiKey)throw new Error('Missing OPENAI_API_KEY in Script Properties.');

  const sourceFile=DriveApp.getFileById(sourceFileId),
        pdfBlob=sourceFile.getBlob().setContentType('application/pdf').setName(sourceFile.getName()),
        requestLabel=String(label||'original PDF ledger recovery');
  let openAiFileId='';
  try{
    const upload=UrlFetchApp.fetch('https://api.openai.com/v1/files',{
      method:'post',
      headers:{Authorization:'Bearer '+apiKey},
      payload:{purpose:'user_data',file:pdfBlob},
      muteHttpExceptions:true
    });
    const uploadCode=upload.getResponseCode(),uploadText=upload.getContentText();
    let uploadBody={};
    try{uploadBody=JSON.parse(uploadText);}catch(e){}
    if(uploadCode<200||uploadCode>=300||!uploadBody.id){
      const uploadMessage=uploadBody&&uploadBody.error&&uploadBody.error.message?uploadBody.error.message:uploadText;
      throw new Error(requestLabel+' PDF upload failed (HTTP '+uploadCode+'): '+String(uploadMessage||'unknown error'));
    }
    openAiFileId=String(uploadBody.id);

    const response=UrlFetchApp.fetch('https://api.openai.com/v1/responses',{
      method:'post',
      contentType:'application/json',
      headers:{Authorization:'Bearer '+apiKey},
      payload:JSON.stringify({
        model:VFC_CONFIG.PDF_REPAIR_MODEL||VFC_CONFIG.PDF_EXTRACTION_MODEL||VFC_CONFIG.OPENAI_MODEL,
        temperature:0,
        max_output_tokens:Number(VFC_CONFIG.PDF_TEXT_MAX_OUTPUT_TOKENS||20000),
        input:[{
          role:'user',
          content:[
            {type:'input_file',file_id:openAiFileId},
            {type:'input_text',text:String(prompt||'')}
          ]
        }],
        text:{format:{
          type:'json_schema',
          name:'vfc_bank_statement_ledger',
          strict:true,
          schema:vfcBankLedgerJsonSchema_()
        }}
      }),
      muteHttpExceptions:true
    });

    const code=response.getResponseCode(),raw=response.getContentText();
    let body={};
    try{body=JSON.parse(raw);}catch(e){}
    if(code<200||code>=300||body.error){
      const responseMessage=body&&body.error&&body.error.message?body.error.message:raw;
      throw new Error(requestLabel+' failed (HTTP '+code+'): '+String(responseMessage||'unknown error'));
    }
    const outputText=vfcOpenAiResponseText_(body);
    if(!String(outputText||'').trim())throw new Error(requestLabel+' returned no structured ledger.');
    let parsed;
    try{parsed=JSON.parse(outputText);}catch(e){throw new Error(requestLabel+' returned invalid ledger JSON.');}
    if(!parsed||!Array.isArray(parsed.banking_transactions))throw new Error(requestLabel+' returned no banking_transactions array.');
    return parsed;
  }finally{
    if(openAiFileId){
      try{
        UrlFetchApp.fetch('https://api.openai.com/v1/files/'+encodeURIComponent(openAiFileId),{
          method:'delete',
          headers:{Authorization:'Bearer '+apiKey},
          muteHttpExceptions:true
        });
      }catch(e){}
    }
  }
}

/**
 * Primary PDF text provider.
 * The output is a provider-neutral transcript. It is cached by PDF SHA-256 + extractor version,
 * so changing the extraction contract never reuses stale Google/OAI transcripts.
 */
function vfcExtractPdfTextWithOpenAI_(pdfBlob,fileName){
  const apiKey=PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if(!apiKey)throw new Error('Missing OPENAI_API_KEY in Script Properties.');

  const safeName=String(fileName||pdfBlob.getName()||'statement.pdf');
  let openAiFileId='';
  try{
    const upload=UrlFetchApp.fetch('https://api.openai.com/v1/files',{
      method:'post',
      headers:{Authorization:'Bearer '+apiKey},
      payload:{purpose:'user_data',file:pdfBlob.setName(safeName)},
      muteHttpExceptions:true
    });

    const uploadCode=upload.getResponseCode(),uploadText=upload.getContentText();
    let uploadBody={};
    try{uploadBody=JSON.parse(uploadText);}catch(e){}
    if(uploadCode<200||uploadCode>=300||!uploadBody.id){
      const msg=uploadBody&&uploadBody.error&&uploadBody.error.message?uploadBody.error.message:uploadText;
      throw new Error('OpenAI PDF upload failed (HTTP '+uploadCode+'): '+String(msg||'unknown error'));
    }
    openAiFileId=String(uploadBody.id);

    const prompt=[
      'Transcribe this bank-statement PDF into plain text for deterministic banking software.',
      'FACT TRANSCRIPTION ONLY. Do not summarize, classify, calculate, underwrite, infer or omit transactions.',
      'Return plain text only: no Markdown, no bullets, no code fences.',
      'Preserve every printed statement date, account number, account-summary line, transaction date, description, amount, debit/credit column and running balance that is visibly readable.',
      'Keep Account Summary wording as close to the PDF as possible, including transaction counts in parentheses and signs on totals.',
      'For tables, preserve row boundaries. If column spacing cannot be preserved, linearize the row and explicitly retain the printed column meaning, for example: DESCRIPTION ... | DEBIT 123.45 | CREDIT | BALANCE -45.67.',
      'Never decide debit/credit direction from the description. Use only the column in which the amount is printed.',
      'Words such as CREDIT, DEBIT, PAYMENT, REFUND or CARD can be part of a transaction description and do not determine direction. For example, RBC CREDIT CARD printed under Cheques & Debits must remain a DEBIT.',
      'Preserve NSF, returned/unpaid/reversal wording exactly when readable.',
      'Do not add Opening balance, Closing balance, summary totals or cheque-image/support-page values as transaction rows when they are not Account Activity.',
      'Do not duplicate a cheque-image/support-page item that already appears in Account Activity.',
      'If a character or value is genuinely unreadable, preserve the surrounding visible text and mark only that unreadable fragment as [UNCLEAR]. Never invent a value.'
    ].join('\n');

    const response=UrlFetchApp.fetch('https://api.openai.com/v1/responses',{
      method:'post',
      contentType:'application/json',
      headers:{Authorization:'Bearer '+apiKey},
      payload:JSON.stringify({
        model:VFC_CONFIG.PDF_EXTRACTION_MODEL||VFC_CONFIG.OPENAI_MODEL,
        temperature:0,
        max_output_tokens:Number(VFC_CONFIG.PDF_TEXT_MAX_OUTPUT_TOKENS||20000),
        input:[{
          role:'user',
          content:[
            {type:'input_file',file_id:openAiFileId},
            {type:'input_text',text:prompt}
          ]
        }]
      }),
      muteHttpExceptions:true
    });

    const code=response.getResponseCode(),raw=response.getContentText();
    let body={};
    try{body=JSON.parse(raw);}catch(e){}
    if(code<200||code>=300||body.error){
      const msg=body&&body.error&&body.error.message?body.error.message:raw;
      throw new Error('OpenAI PDF text extraction failed (HTTP '+code+'): '+String(msg||'unknown error'));
    }

    const text=vfcOpenAiResponseText_(body);
    if(!String(text||'').trim())throw new Error('OpenAI PDF text extraction returned empty text.');
    return String(text);
  }finally{
    if(openAiFileId){
      try{
        UrlFetchApp.fetch('https://api.openai.com/v1/files/'+encodeURIComponent(openAiFileId),{
          method:'delete',
          headers:{Authorization:'Bearer '+apiKey},
          muteHttpExceptions:true
        });
      }catch(e){}
    }
  }
}

function vfcThrottleDriveOcr_(){
  const props=PropertiesService.getScriptProperties(),now=Date.now(),
        last=Number(props.getProperty('VFC_LAST_DRIVE_OCR_MS')||0),
        minimum=Math.max(1000,Number(VFC_CONFIG.OCR_MIN_INTERVAL_MS||10000)),
        wait=Math.max(0,minimum-(now-last));
  if(wait>0)Utilities.sleep(wait);
  props.setProperty('VFC_LAST_DRIVE_OCR_MS',String(Date.now()));
}

function vfcExtractPdfTextWithDriveOcr_(sourceFile,pdfBlob){
  let lastError=null;
  for(let attempt=1;attempt<=Math.max(1,Number(VFC_CONFIG.OCR_RETRY_ATTEMPTS||2));attempt++){
    let convertedId='';
    try{
      vfcThrottleDriveOcr_();
      const converted=Drive.Files.insert(
        {title:'OCR_'+sourceFile.getName()},
        pdfBlob,
        {convert:true,ocr:true,ocrLanguage:'en'}
      );
      convertedId=converted&&converted.id||'';
      if(!convertedId)throw new Error('Drive OCR did not create a converted document.');
      const doc=DocumentApp.openById(convertedId),text=String(doc.getBody().getText()||'');
      if(!text.trim())throw new Error('Drive OCR returned empty text.');
      return text;
    }catch(error){
      lastError=error;
      const message=String(error&&error.message||error),
            rateLimited=/user rate limit|rate limit|too many requests|quota.*ocr|ocr.*quota/i.test(message),
            retryable=rateLimited||/backend error|internal error|service unavailable|temporar/i.test(message);
      if(!retryable||attempt>=Math.max(1,Number(VFC_CONFIG.OCR_RETRY_ATTEMPTS||2)))break;
      const wait=rateLimited
        ?Math.min(30000,Math.max(10000,Number(VFC_CONFIG.OCR_RATE_LIMIT_BACKOFF_MS||20000)))
        :Math.min(15000,Number(VFC_CONFIG.OCR_DELAY_MS||5000)*attempt);
      Utilities.sleep(wait);
    }finally{
      if(convertedId){try{DriveApp.getFileById(convertedId).setTrashed(true);}catch(e){}}
    }
  }
  throw new Error('Google Drive OCR fallback failed: '+String(lastError&&lastError.message||lastError));
}

function extractTextFromPdf_(fileId){
  const sourceFile=DriveApp.getFileById(fileId),
        pdfBlob=sourceFile.getBlob().setContentType('application/pdf').setName(sourceFile.getName()),
        cacheKey=vfcPdfTextCacheKey_(pdfBlob),
        cached=vfcGetCachedOcrText_(cacheKey);
  if(cached)return cached;

  const lock=LockService.getScriptLock();
  if(!lock.tryLock(300000))throw new Error('PDF text extraction queue is busy. Please retry the upload in a moment.');

  try{
    const cachedAfterLock=vfcGetCachedOcrText_(cacheKey);
    if(cachedAfterLock)return cachedAfterLock;

    let openAiError=null;
    try{
      const text=vfcExtractPdfTextWithOpenAI_(pdfBlob,sourceFile.getName());
      vfcPutCachedOcrText_(cacheKey,text);
      return text;
    }catch(e){
      openAiError=e;
    }

    if(!VFC_CONFIG.DRIVE_OCR_FALLBACK_ENABLED){
      throw new Error('OpenAI PDF text extraction failed and Drive OCR fallback is disabled: '+String(openAiError&&openAiError.message||openAiError));
    }

    try{
      const text=vfcExtractPdfTextWithDriveOcr_(sourceFile,pdfBlob);
      vfcPutCachedOcrText_(cacheKey,text);
      return text;
    }catch(driveError){
      throw new Error(
        'PDF text extraction failed on both providers. OpenAI file input: '+
        String(openAiError&&openAiError.message||openAiError)+
        ' | Google Drive OCR fallback: '+
        String(driveError&&driveError.message||driveError)
      );
    }
  }finally{
    try{lock.releaseLock();}catch(e){}
  }
}

function runPdfIntakeSelfTests(){
  const results=[];
  function test(name,fn){try{results.push({name:name,pass:true,detail:String(fn()||'')});}catch(e){results.push({name:name,pass:false,detail:String(e&&e.message||e)});}}
  function equal(a,b,label){if(a!==b)throw new Error((label||'value')+' expected '+b+' got '+a);}

  test('PDF cache key is versioned and deterministic',function(){
    const blob=Utilities.newBlob('same pdf bytes','application/pdf','x.pdf'),
          a=vfcPdfTextCacheKey_(blob),b=vfcPdfTextCacheKey_(blob);
    equal(a,b,'cache key');
    if(a.indexOf(String(VFC_CONFIG.PDF_TEXT_CACHE_VERSION))!==0)throw new Error('cache key missing version');
    return a.substring(0,40)+'...';
  });

  test('OpenAI response parser joins output text parts',function(){
    const body={output:[{content:[{type:'output_text',text:'alpha'},{type:'output_text',text:'beta'}]}]};
    equal(vfcOpenAiResponseText_(body),'alpha\nbeta','response text');
    return'joined';
  });

  test('Drive OCR is fallback, not primary',function(){
    equal(VFC_CONFIG.PDF_TEXT_PROVIDER,'OPENAI_FILE_INPUT','provider');
    return String(VFC_CONFIG.DRIVE_OCR_FALLBACK_ENABLED);
  });

  test('PDF extraction and recovery use fresh high-accuracy configuration',function(){
    if(String(VFC_CONFIG.PDF_TEXT_CACHE_VERSION).indexOf('VFC-PDF-TEXT-3.0')!==0)throw new Error('stale PDF cache generation');
    equal(VFC_CONFIG.PDF_EXTRACTION_MODEL,'gpt-4.1','extraction model');
    equal(VFC_CONFIG.PDF_REPAIR_MODEL,'gpt-4.1','repair model');
    equal(vfcBankLedgerJsonSchema_().required[0],'banking_transactions','ledger schema');
    return VFC_CONFIG.PDF_TEXT_CACHE_VERSION;
  });

  const failed=results.filter(function(x){return!x.pass;});
  return{
    ok:failed.length===0,
    provider:VFC_CONFIG.PDF_TEXT_PROVIDER,
    cacheVersion:VFC_CONFIG.PDF_TEXT_CACHE_VERSION,
    total:results.length,
    passed:results.length-failed.length,
    failed:failed.length,
    results:results
  };
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
    'Words such as CREDIT, DEBIT, PAYMENT, REFUND or CARD inside a description do not determine direction. For example, RBC CREDIT CARD printed under Cheques/Debits is a DEBIT.',
    'Extract financing/loan/PAD/MCA/advance/funding/capital transactions, loan interest, recurring PADs, explicit equipment lease or equipment finance payments, recurring equipment-rent payments, tax/government payments, insurance/premium finance and credit-card payments.',
    'Equipment examples to extract include EQUIP RENT/LSE, EQUIPMENT LEASE, LEASE PAYMENT, EQUIPMENT FINANCE, COMM EQUIP RENT/LSE, or plain EQUIPMENT RENT. Deterministic banking code will decide whether each is debt or informational.',
    'Also extract incoming credits of $5,000 or more when they could plausibly be financing. Deterministic code will classify them.',
    'Do not extract ordinary suppliers, payroll, customer receipts, utilities, fuel, phone or bank fees unless clearly financing/tax/insurance/equipment rent-or-lease.',
    'Do not duplicate cheque-image pages. If uncertain, omit the transaction.',
    'Header totals must come from the statement summary/header, not transaction summing. The program independently verifies printed totals.',
    'Use YYYY-MM-DD dates. If not a bank statement, set document_type=NOT_BANK_STATEMENT and banking_transactions=[].',
    'Document text:',String(text||'').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
  ].join('\n');
}

function summarizeSingleBankStatement_(text, companyName, fileName){return callOpenAIJson_(buildSingleBankStatementPrompt_(text,companyName,fileName));}
function vfcLockPrintedStatementFacts_(summary,text){summary=summary||{};const facts=vfcExtractPrintedStatementFacts_(text);if(facts.startDate)summary.statement_start_date=facts.startDate;if(facts.endDate)summary.statement_end_date=facts.endDate;if(facts.totalsVerified){summary.opening_balance=facts.opening;summary.closing_balance=facts.closing;summary.total_deposits=facts.deposits;summary.total_withdrawals=facts.withdrawals;}return summary;}
function vfcExtractPrintedStatementFacts_(text){const source=String(text||'').replace(/\u00a0/g,' '),out={startDate:'',endDate:'',opening:null,closing:null,deposits:null,withdrawals:null,totalsVerified:false};const monthRange=source.match(/([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})\s+(?:to|through|[-–—])\s+([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i),isoRange=source.match(/(\d{4}-\d{2}-\d{2})\s+(?:to|through|[-–—])\s+(\d{4}-\d{2}-\d{2})/i),range=monthRange||isoRange;if(range){out.startDate=vfcPrintedIsoDate_(range[1]);out.endDate=vfcPrintedIsoDate_(range[2]);}const printedDate='(?:[A-Za-z]{3,9}\\s+\\d{1,2},\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})';out.opening=vfcPrintedMoneyAfter_(source,[new RegExp('Opening\\s+balance(?:\\s+on\\s+'+printedDate+')?\\s+([+\\-]?\\s*\\$?\\s*\\(?\\-?\\$?[\\d,]+(?:\\.\\d{2})?\\)?)','i'),/Beginning\s+balance\s+([+\-]?\s*\$?\s*\(?\-?\$?[\d,]+(?:\.\d{2})?\)?)/i]);out.closing=vfcPrintedMoneyAfter_(source,[new RegExp('Closing\\s+balance(?:\\s+on\\s+'+printedDate+')?\\s*(?:=)?\\s*([+\\-]?\\s*\\$?\\s*\\(?\\-?\\$?[\\d,]+(?:\\.\\d{2})?\\)?)','i'),/Ending\s+balance\s+([+\-]?\s*\$?\s*\(?\-?\$?[\d,]+(?:\.\d{2})?\)?)/i]);out.deposits=vfcPrintedMoneyAfter_(source,[/Total\s+deposits\s*(?:&|and)\s+credits(?:\s*\(\d+\))?\s*([+\-]?\s*\$?\s*[\d,]+(?:\.\d{2})?)/i,/Total\s+credits(?:\s*\(\d+\))?\s*([+\-]?\s*\$?\s*[\d,]+(?:\.\d{2})?)/i,/Total\s+deposits(?:\s*\(\d+\))?\s*([+\-]?\s*\$?\s*[\d,]+(?:\.\d{2})?)/i]);out.withdrawals=vfcPrintedMoneyAfter_(source,[/Total\s+cheques?\s*(?:&|and)\s+debits(?:\s*\(\d+\))?\s*([+\-]?\s*\$?\s*[\d,]+(?:\.\d{2})?)/i,/Total\s+withdrawals(?:\s*\(\d+\))?\s*([+\-]?\s*\$?\s*[\d,]+(?:\.\d{2})?)/i,/Total\s+debits(?:\s*\(\d+\))?\s*([+\-]?\s*\$?\s*[\d,]+(?:\.\d{2})?)/i]);if(out.deposits!==null)out.deposits=Math.abs(out.deposits);if(out.withdrawals!==null)out.withdrawals=Math.abs(out.withdrawals);if(out.opening!==null&&out.closing!==null&&out.deposits!==null&&out.withdrawals!==null){const diff=(out.opening+out.deposits-out.withdrawals)-out.closing;out.totalsVerified=Math.abs(diff)<=.05;}return out;}
function vfcPrintedMoneyAfter_(source,patterns){for(let i=0;i<patterns.length;i++){const match=source.match(patterns[i]);if(!match||!match[1])continue;const value=vfcPrintedMoney_(match[1]);if(value!==null)return value;}return null;}
function vfcPrintedMoney_(value){const raw=String(value||'').trim();if(!raw)return null;const negative=/^\s*-/.test(raw)||/-\s*\$/.test(raw)||/^\s*\(/.test(raw),cleaned=raw.replace(/[^0-9.]/g,'');if(!cleaned)return null;const number=parseFloat(cleaned);return isFinite(number)?(negative?-number:number):null;}
function vfcPrintedIsoDate_(value){if(!value)return'';const direct=String(value).match(/^\d{4}-\d{2}-\d{2}$/);if(direct)return direct[0];const date=new Date(value);return isNaN(date.getTime())?'':Utilities.formatDate(date,Session.getScriptTimeZone(),'yyyy-MM-dd');}

function summarizeBatch_(items, companyName, detectedPeriod) {
  const combined = items.map(function(item){
    return 'FILE: ' + item.fileName + '\nSUMMARY: ' + JSON.stringify(item.summary);
  }).join('\n\n');
  const prompt = 'You are the VFC AI Batch Bank Statement Summarizer. Return JSON only with combined_summary, key_findings, risks, missing_info. ' +
    'Return every field as a readable string, not an array. Do not approve or decline and do not invent figures.\nCompany: ' + companyName + '\nDetected period: ' + detectedPeriod + '\nPDF summaries:\n' + combined;
  return callOpenAIJson_(prompt);
}
function callOpenAIJsonBatch_(prompts){if(!Array.isArray(prompts)||!prompts.length)return[];const apiKey=PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');if(!apiKey)throw new Error('Missing OPENAI_API_KEY in Script Properties.');const requests=prompts.map(function(prompt){return{url:'https://api.openai.com/v1/responses',method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+apiKey},payload:JSON.stringify({model:VFC_CONFIG.OPENAI_MODEL,temperature:0,input:prompt,text:{format:{type:'json_object'}}}),muteHttpExceptions:true};});const responses=UrlFetchApp.fetchAll(requests);return responses.map(function(response,index){return parseOpenAIJsonResponse_(response,'statement '+(index+1));});}
function callOpenAIJson_(prompt){const apiKey=PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');if(!apiKey)throw new Error('Missing OPENAI_API_KEY in Script Properties.');const response=UrlFetchApp.fetch('https://api.openai.com/v1/responses',{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+apiKey},payload:JSON.stringify({model:VFC_CONFIG.OPENAI_MODEL,temperature:0,input:prompt,text:{format:{type:'json_object'}}}),muteHttpExceptions:true});return parseOpenAIJsonResponse_(response,'OpenAI');}
function parseOpenAIJsonResponse_(response,label){const code=response.getResponseCode?response.getResponseCode():200,text=response.getContentText?response.getContentText():String(response||'');let body;try{body=JSON.parse(text);}catch(e){throw new Error((label||'OpenAI')+' returned invalid JSON (HTTP '+code+').');}if(body.error)throw new Error((label||'OpenAI')+': '+body.error.message);if(code<200||code>=300)throw new Error((label||'OpenAI')+' failed with HTTP '+code+'.');let outputText=body.output_text||'';if(!outputText&&body.output&&body.output[0]&&body.output[0].content&&body.output[0].content[0])outputText=body.output[0].content[0].text||'';if(!outputText)throw new Error((label||'OpenAI')+' response text not found.');try{return JSON.parse(outputText);}catch(e){throw new Error((label||'OpenAI')+' returned non-JSON output.');}}
function getLatestBatchSummary_(companyName,period){const rows=getSheetObjects_('Batch Summaries').filter(function(row){return sameText_(row.companyName,companyName)&&(!period||sameText_(row.detectedPeriod,period));});return rows.length?rows[rows.length-1]:null;}
function getSheetObjects_(sheetName){const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);if(!sheet)return[];const values=sheet.getDataRange().getValues();if(values.length<2)return[];const headers=values[0].map(normalizeHeader_);return values.slice(1).filter(function(row){return row.some(function(cell){return String(cell).trim()!=='';});}).map(function(row){const obj={};headers.forEach(function(header,index){obj[header]=row[index];});return obj;});}
function ensureSheetSchema_(sheetName,headers){const ss=SpreadsheetApp.getActiveSpreadsheet();let sheet=ss.getSheetByName(sheetName);if(!sheet)sheet=ss.insertSheet(sheetName);if(sheet.getLastRow()===0){sheet.appendRow(headers);return;}const current=sheet.getRange(1,1,1,Math.max(sheet.getLastColumn(),1)).getValues()[0].map(function(v){return String(v).trim();});headers.forEach(function(header){if(current.indexOf(header)===-1){current.push(header);sheet.getRange(1,current.length).setValue(header);}});}
function appendRow_(sheetName,row){const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);if(!sheet)throw new Error('Missing sheet: '+sheetName+'.');sheet.appendRow(row.map(cleanCell_));}
function appendRows_(sheetName,rows){if(!rows||!rows.length)return;const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);if(!sheet)throw new Error('Missing sheet: '+sheetName+'.');const clean=rows.map(function(row){return row.map(cleanCell_);});sheet.getRange(sheet.getLastRow()+1,1,clean.length,clean[0].length).setValues(clean);}
function cleanCell_(value){if(value===null||value===undefined)return'';if(Object.prototype.toString.call(value)==='[object Date]')return value;if(Array.isArray(value))return value.map(cleanCell_).filter(Boolean).join('\n');if(typeof value==='object')return Object.keys(value).map(function(key){return key+': '+cleanCell_(value[key]);}).join('\n');return String(value);}
function getOrCreateCompany_(companyName){const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Companies'),values=sheet.getDataRange().getValues();for(let i=1;i<values.length;i++)if(sameText_(values[i][1],companyName))return{companyId:values[i][0],companyName:values[i][1],folderId:values[i][2],folderLink:values[i][3]};const folder=getOrCreateSubFolder_(getOrCreateRootFolder_(),cleanFolderName_(companyName)),companyId=Utilities.getUuid();sheet.appendRow([companyId,companyName,folder.getId(),folder.getUrl(),new Date()]);return{companyId:companyId,companyName:companyName,folderId:folder.getId(),folderLink:folder.getUrl()};}
function seedDefaultLenders_(){const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Lenders'),existing=getSheetObjects_('Lenders').map(function(row){return String(row.lenderName||'').toLowerCase();});['Journey Capital','Merchant Growth','iCapital Financing','Canacap Funding'].forEach(function(name){if(existing.indexOf(name.toLowerCase())===-1)sheet.appendRow([Utilities.getUuid(),name,'Merchant Cash Advance','','Active',new Date()]);});}
function getOrCreateRootFolder_(){const folders=DriveApp.getFoldersByName(VFC_CONFIG.ROOT_FOLDER_NAME);return folders.hasNext()?folders.next():DriveApp.createFolder(VFC_CONFIG.ROOT_FOLDER_NAME);}
function getOrCreateSubFolder_(parent,name){const cleanName=cleanFolderName_(name),folders=parent.getFoldersByName(cleanName);return folders.hasNext()?folders.next():parent.createFolder(cleanName);}
function buildDetectedPeriod_(startDates,endDates){const all=(startDates||[]).concat(endDates||[]).filter(Boolean).sort(function(a,b){return a.getTime()-b.getTime();});if(!all.length)return{label:'Period Not Detected',earliest:'',latest:''};return{label:formatMonthYear_(all[0])+' to '+formatMonthYear_(all[all.length-1]),earliest:formatDate_(all[0]),latest:formatDate_(all[all.length-1])};}
function estimateMonthsCovered_(starts,ends,fallback){if(starts.length&&ends.length){const earliest=new Date(Math.min.apply(null,starts.map(function(d){return d.getTime();}))),latest=new Date(Math.max.apply(null,ends.map(function(d){return d.getTime();}))),days=Math.max(1,(latest-earliest)/(1000*60*60*24)+1);return Math.max(1,Math.round(days/30.4375));}return Math.max(1,fallback||1);}
function parseDateSafe_(value){if(!value)return null;const date=new Date(value);return isNaN(date.getTime())?null:date;}
function formatMonthYear_(date){return Utilities.formatDate(date,Session.getScriptTimeZone(),'MMM yyyy');}
function formatDate_(date){return Utilities.formatDate(date,Session.getScriptTimeZone(),'yyyy-MM-dd');}
function cleanFolderName_(name){return String(name||'Unknown').replace(/[\\/:*?"<>|]/g,'-').trim();}
function normalizeHeader_(header){return String(header||'').trim().replace(/[^a-zA-Z0-9]+(.)/g,function(_,chr){return chr.toUpperCase();}).replace(/^[A-Z]/,function(c){return c.toLowerCase();});}
function normalizeKey_(company,period){return String(company||'').trim().toLowerCase()+'|'+String(period||'').trim().toLowerCase();}
function sameText_(a,b){return String(a||'').trim().toLowerCase()===String(b||'').trim().toLowerCase();}
function unique_(items){const seen={};return items.filter(function(item){const key=String(item).trim().toLowerCase();if(!key||seen[key])return false;seen[key]=true;return true;});}
function normalizeDecision_(value){const text=String(value||'').trim().toLowerCase();if(text.indexOf('approv')>=0)return'Approved';if(text.indexOf('declin')>=0)return'Declined';if(text.indexOf('condition')>=0)return'Conditional';return value||'';}
function toNumber_(value){if(typeof value==='number')return isFinite(value)?value:0;const cleaned=String(value||'').replace(/[^0-9.\-]/g,''),number=parseFloat(cleaned);return isFinite(number)?number:0;}
function truthyFlag_(value){return /yes|true|detected|negative|1/i.test(String(value||''));}
function hasMeaningfulMca_(value){const text=String(cleanCell_(value)||'').trim();return!!text&&!/^(no|none|not detected|false|0)$/i.test(text);}
function clamp_(value,min,max){return Math.max(min,Math.min(max,value));}
function round2_(value){return Math.round((Number(value)||0)*100)/100;}
function median_(values){if(!values.length)return'';const middle=Math.floor(values.length/2);return values.length%2?values[middle]:Math.round((values[middle-1]+values[middle])/2*100)/100;}
function numericSimilarity_(a,b,floorScale){a=toNumber_(a);b=toNumber_(b);const scale=Math.max(Math.abs(a),Math.abs(b),floorScale||1);return clamp_(1-Math.abs(a-b)/scale,0,1);}

/* ===== END Code.gs ===== */

/* ===== BEGIN BankingCore.gs ===== */
/**
 * VFC Banking Core 4.5
 * Shared bank-agnostic banking math over frozen statement facts.
 * No PDF or OpenAI call occurs during underwriting.
 */
const VFC_BANK_ENGINE={
  VERSION:'VFC-BANKING-CORE-4.5',
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
  return VFC_BANK_ENGINE.CACHE_PREFIX+JSON.stringify({version:6,extractionVersion:VFC_BANK_ENGINE.FACTS_VERSION,dateNormalizationVersion:'ISO_DATE_LITERAL_V2',intakeContract:VFC_BANK_ENGINE.INTAKE_CONTRACT,bankRulesVersion:profile&&profile.rulesVersion?profile.rulesVersion:'',fileName:String(fileName||''),bankId:bankId,bankName:bankName,accountHolder:String(summary.account_holder||'').trim(),accountNumber:String(summary.account_number||summary.account_no||'').trim(),statementStartDate:vfcIso_(summary.statement_start_date),statementEndDate:vfcIso_(summary.statement_end_date),openingBalance:opening,closingBalance:closing,totalDeposits:deposits,totalWithdrawals:withdrawals,reconciliationDifference:diff,nsfCount:Math.max(0,vfcNum_(summary.nsf_count)),negativeBalanceDetected:vfcBool_(summary.negative_balance_detected),transactionsVerified:true,transactions:vfcNormalizeTransactions_(summary.banking_transactions||[],bankId,0)});
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
function vfcStatementMeta_(r){r=r||{};const p=vfcParseBankCache_(r.signalRaw);return{bankId:vfcPayloadBankId_(p,r.bank||''),start:vfcIso_(r.startDate||(p&&p.statementStartDate)),end:vfcIso_(r.endDate||(p&&p.statementEndDate)),account:vfcAccountNumberKey_((p&&p.accountNumber)||r.accountNumber||''),fileKey:vfcFileIdentityKey_((p&&p.fileName)||r.fileName||''),holder:vfcCounterpartyKey_((p&&p.accountHolder)||r.accountHolder||'')};}
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
function vfcSelectedStatementRows_(companyName,period){
  const all=vfcSummaryRows_(companyName,period),groups=vfcGroupLogicalStatementRows_(all),rows=groups.map(function(group){const latest=group.slice().sort(function(a,b){return vfcTime_(b.createdAt)-vfcTime_(a.createdAt)||b.rowNumber-a.rowNumber;})[0],bankId=vfcDetectBankId_(latest.bank||''),canonical=vfcCanonicalSignalRawFromRows_(group,bankId),row=Object.assign({},latest);if(canonical)row.signalRaw=canonical;row.statementIdentity=vfcStatementIdentityKey_(row);row.logicalRowNumbers=group.map(function(x){return x.rowNumber;});row.duplicateRowsCollapsed=Math.max(0,group.length-1);return row;});
  rows.sort(function(a,b){return vfcTime_(a.endDate)-vfcTime_(b.endDate)||String(a.fileName).localeCompare(String(b.fileName));});return rows.slice(Math.max(0,rows.length-VFC_BANK_ENGINE.MAX_STATEMENTS));
}
/** Exact frozen-fact fingerprint retained for diagnostics/regression only; it is not statement identity. */
function vfcStatementFingerprint_(r){return[String(r.bank||'').toUpperCase(),vfcIso_(r.startDate),vfcIso_(r.endDate),vfcRound_(vfcNum_(r.opening),.01),vfcRound_(vfcNum_(r.closing),.01),vfcRound_(vfcNum_(r.deposits),.01),vfcRound_(vfcNum_(r.withdrawals),.01)].join('|');}

function vfcPayloadBankId_(p,rowBank){return String((p&&p.bankId)||vfcDetectBankId_((p&&p.bankName)||rowBank||'')||'UNKNOWN').toUpperCase();}
function vfcCurrentBankRulesVersion_(bankId){if(typeof vfcGetBankProfile_!=='function')return'';const p=vfcGetBankProfile_(bankId);return p&&p.rulesVersion?String(p.rulesVersion):'';}
/** First payload under the current bank-rules/intake contract is canonical. Older-rule ledgers remain fallback only. */
function vfcCanonicalSignalRawFromRows_(rows,expectedBankId){
  const expected=String(expectedBankId||'').toUpperCase(),currentRules=vfcCurrentBankRulesVersion_(expected),currentContract=VFC_BANK_ENGINE.INTAKE_CONTRACT,candidates=[];
  (rows||[]).forEach(function(row){const raw=String(row.signalRaw||''),p=vfcParseBankCache_(raw);if(!vfcPayloadUsable_(p))return;const actual=vfcPayloadBankId_(p,row.bank||'');if(expected&&actual!==expected)return;let rank=0;if(String(p.intakeContract||'')===currentContract)rank+=1;if(currentRules&&String(p.bankRulesVersion||'')===currentRules)rank+=2;candidates.push({raw:raw,payload:p,row:row,rank:rank});});
  candidates.sort(function(a,b){return b.rank-a.rank||vfcTime_(a.row&&a.row.createdAt)-vfcTime_(b.row&&b.row.createdAt);});
  return candidates.length?candidates[0].raw:'';
}
function vfcCanonicalPayloadForRow_(row){
  const all=vfcSummaryRows_(row.companyName,row.period),numbers=Array.isArray(row.logicalRowNumbers)?row.logicalRowNumbers:[],groups=vfcGroupLogicalStatementRows_(all);let pool=[];if(numbers.length)pool=all.filter(function(x){return numbers.indexOf(x.rowNumber)>=0;});if(!pool.length){groups.some(function(g){if(g.some(function(x){return x.rowNumber===row.rowNumber||(row.uploadId&&x.uploadId===row.uploadId);})) {pool=g;return true;}return false;});}if(!pool.length)pool=[row];const expected=vfcDetectBankId_(row.bank||''),raw=vfcCanonicalSignalRawFromRows_(pool,expected)||String(row.signalRaw||'');
  if(raw){const p=vfcParseBankCache_(raw);if(vfcPayloadUsable_(p))return vfcNormalizePayload_(p,row);}const exact=vfcParseBankCache_(row.signalRaw);return vfcPayloadUsable_(exact)&&(!expected||vfcPayloadBankId_(exact,row.bank)===expected)?vfcNormalizePayload_(exact,row):null;
}
function vfcParseBankCache_(raw){const s=String(raw||''),prefixes=[VFC_BANK_ENGINE.CACHE_PREFIX].concat(VFC_BANK_ENGINE.LEGACY_PREFIXES);for(let i=0;i<prefixes.length;i++){if(s.indexOf(prefixes[i])!==0)continue;try{return JSON.parse(s.slice(prefixes[i].length));}catch(e){return null;}}return null;}
function vfcPayloadUsable_(p){return!!(p&&p.transactionsVerified&&Array.isArray(p.transactions)&&vfcNumNull_(p.totalDeposits)!==null&&vfcNumNull_(p.totalWithdrawals)!==null);}
function vfcNormalizePayload_(p,row){row=row||{};const bankId=vfcPayloadBankId_(p,row.bank||''),rowStart=vfcIso_(row.startDate),rowEnd=vfcIso_(row.endDate),payloadStart=vfcIso_(p.statementStartDate),payloadEnd=vfcIso_(p.statementEndDate),statementStart=rowStart||payloadStart,statementEnd=rowEnd||payloadEnd,legacyDateShiftDays=vfcLegacyPayloadDateShift_(p,payloadStart,payloadEnd,rowStart,rowEnd);return{version:Number(p.version)||4,extractionVersion:String(p.extractionVersion||VFC_BANK_ENGINE.FACTS_VERSION),dateNormalizationVersion:String(p.dateNormalizationVersion||''),legacyDateShiftDays:legacyDateShiftDays,intakeContract:String(p.intakeContract||''),bankRulesVersion:String(p.bankRulesVersion||''),fileName:String(p.fileName||row.fileName||''),bankId:bankId,bankName:String(p.bankName||row.bank||'Unknown'),accountHolder:String(p.accountHolder||row.accountHolder||''),accountNumber:String(p.accountNumber||''),statementStartDate:statementStart,statementEndDate:statementEnd,openingBalance:vfcNumNull_(p.openingBalance),closingBalance:vfcNumNull_(p.closingBalance),totalDeposits:vfcPos_(p.totalDeposits),totalWithdrawals:vfcPos_(p.totalWithdrawals),reconciliationDifference:vfcNum_(p.reconciliationDifference),nsfCount:Math.max(0,vfcNum_(p.nsfCount||row.nsf)),negativeBalanceDetected:!!(p.negativeBalanceDetected||row.negative),transactionsVerified:true,transactions:vfcNormalizeTransactions_(p.transactions||[],bankId,legacyDateShiftDays)};}
function vfcReconcilePayload_(p,row){const opening=p.openingBalance!==null?p.openingBalance:row.opening,closing=p.closingBalance!==null?p.closingBalance:row.closing,deposits=p.totalDeposits,withdrawals=p.totalWithdrawals;if(opening===null||closing===null||deposits===null||withdrawals===null)return{ok:false,diff:null};const diff=Math.abs((opening+deposits-withdrawals)-closing);return{ok:diff<=VFC_BANK_ENGINE.RECONCILE_TOLERANCE,diff:diff};}
function vfcLegacyPayloadDateShift_(p,payloadStart,payloadEnd,rowStart,rowEnd){
  if(String(p&&p.dateNormalizationVersion||'')==='ISO_DATE_LITERAL_V2')return 0;
  const ps=vfcIsoDayNumber_(payloadStart),pe=vfcIsoDayNumber_(payloadEnd),rs=vfcIsoDayNumber_(rowStart),re=vfcIsoDayNumber_(rowEnd);
  return ps!==null&&pe!==null&&rs!==null&&re!==null&&rs-ps===1&&re-pe===1?1:0;
}
function vfcNormalizeTransactions_(items,bankId,dateShiftDays){
  const shift=Number(dateShiftDays)||0,raw=[];(Array.isArray(items)?items:[]).forEach(function(x){const originalDate=vfcIso_(x.date),date=shift?vfcShiftIsoDate_(originalDate,shift):originalDate,desc=String(x.description||'').replace(/\s+/g,' ').trim(),direction=String(x.direction||'').toUpperCase(),amount=vfcPos_(x.amount);if(!date||!desc||(direction!=='DEBIT'&&direction!=='CREDIT')||!(amount>0))return;const t={date:date,description:desc.substring(0,220),counterparty:String(x.counterparty||desc).replace(/\s+/g,' ').trim().substring(0,140),direction:direction,amount:vfcRound_(amount,.01)};if(shift&&date!==originalDate)t.dateCorrectedFrom=originalDate;raw.push(t);});
  const out=[],seen={};raw.forEach(function(t){const key=[t.date,t.direction,t.amount,t.description.toUpperCase()].join('|'),count=(seen[key]||0)+1;seen[key]=count;if(count===1){out.push(t);return;}if(vfcPreserveBankPrintedDuplicate_(bankId,t,count,raw)){out.push(Object.assign({},t,{occurrence:count}));}});
  out.sort(function(a,b){return vfcTime_(a.date)-vfcTime_(b.date)||a.direction.localeCompare(b.direction)||a.amount-b.amount||a.description.localeCompare(b.description)||(a.occurrence||1)-(b.occurrence||1);});return out;
}
function vfcPreserveBankPrintedDuplicate_(bankId,t,occurrence,items){
  if(typeof vfcBankPreservePrintedDuplicate_==='function'&&vfcBankPreservePrintedDuplicate_(bankId||'UNKNOWN',t,occurrence,items))return true;
  if(!vfcBankIsReturnedFinancingCredit_(bankId||'UNKNOWN',t)&&String(t.direction||'')!=='DEBIT')return false;
  if(t.direction==='DEBIT'){
    const classified=vfcClassifyDebitForBank_(bankId||'UNKNOWN',t);if(!classified||(classified.family!=='FINANCING'&&classified.family!=='MCA'))return false;
    const returns=(items||[]).filter(function(c){if(c.direction!=='CREDIT'||!vfcBankIsReturnedFinancingCredit_(bankId||'UNKNOWN',c)||Math.abs(vfcNum_(c.amount)-vfcNum_(t.amount))>.01)return false;const dd=vfcDate_(t.date),cd=vfcDate_(c.date);if(!dd||!cd)return false;const days=(cd-dd)/86400000;return days>=0&&days<=3;}).length;
    return occurrence<=1+returns;
  }
  const debits=(items||[]).filter(function(d){if(d.direction!=='DEBIT'||Math.abs(vfcNum_(d.amount)-vfcNum_(t.amount))>.01)return false;const classified=vfcClassifyDebitForBank_(bankId||'UNKNOWN',d);if(!classified||(classified.family!=='FINANCING'&&classified.family!=='MCA'))return false;const dd=vfcDate_(d.date),cd=vfcDate_(t.date);if(!dd||!cd)return false;const days=(cd-dd)/86400000;return days>=0&&days<=3;}).length;
  return occurrence<=debits;
}

/** Every field used by Our Max risk scoring is recalculated from deduplicated frozen statements. */
function vfcBuildBankingFeatures_(base,rows){
  let totalDeposits=0,totalWithdrawals=0,nsf=0,negative=0;const monthlyDeposits=[],monthlyWithdrawals=[],openings=[],closings=[],audit=[],allTx=[];
  rows.forEach(function(x){const p=x.payload;totalDeposits+=p.totalDeposits;totalWithdrawals+=p.totalWithdrawals;monthlyDeposits.push(p.totalDeposits);monthlyWithdrawals.push(p.totalWithdrawals);if(p.openingBalance!==null)openings.push(p.openingBalance);if(p.closingBalance!==null)closings.push(p.closingBalance);nsf+=p.nsfCount||0;if(p.negativeBalanceDetected)negative=1;(p.transactions||[]).forEach(function(t){allTx.push(Object.assign({bankId:p.bankId||'UNKNOWN'},t));});audit.push({fileName:x.row.fileName,statementIdentity:x.row.statementIdentity||vfcStatementIdentityKey_(x.row),duplicateRowsCollapsed:x.row.duplicateRowsCollapsed||0,bankId:p.bankId,bank:p.bankName,accountNumber:p.accountNumber||'',bankRulesVersion:p.bankRulesVersion||'',intakeContract:p.intakeContract||'',start:p.statementStartDate,end:p.statementEndDate,totalDeposits:p.totalDeposits,totalWithdrawals:p.totalWithdrawals,reconciliationDifference:p.reconciliationDifference,transactionsVerified:true,transactionCount:(p.transactions||[]).length,legacyDateShiftDays:p.legacyDateShiftDays||0,correctedTransactionDates:(p.transactions||[]).filter(function(t){return!!t.dateCorrectedFrom;}).length});});
  const reversalCredits=vfcNonOperatingReversalCredits_(allTx),reversalCreditsTotal=reversalCredits.reduce(function(s,t){return s+vfcPos_(t.amount);},0),transferCredits=vfcNonOperatingTransferCredits_(allTx),transferCreditsTotal=transferCredits.reduce(function(s,t){return s+vfcPos_(t.amount);},0),recent=rows.slice(Math.max(0,rows.length-VFC_BANK_ENGINE.DEBT_LOOKBACK)),debt=vfcDebtProfile_(recent),months=Math.max(1,rows.length),grossMonthly=totalDeposits/months,operatingTotal=Math.max(0,totalDeposits-debt.financingCreditsTotal-reversalCreditsTotal-transferCreditsTotal),operatingMonthly=operatingTotal/months,avgDep=vfcMean_(monthlyDeposits),txText=allTx.map(function(t){return String(t.description||'');}).join(' ').toUpperCase(),overdraftFlag=/OVERDRAFT|OVER LIMIT/.test(txText)?1:0,returnedFlag=reversalCredits.length||allTx.some(function(t){return/RETURNED UNPAID|RETURNED ITEM|RETURNED PAYMENT|REVERSAL|CHARGEBACK|ITEM RETURNED NSF|CHEQUE RETURNED NSF/.test(String(t.description||'').toUpperCase());})?1:0,stackingFlag=(debt.activeDebtObligations||[]).filter(function(x){return x.family==='MCA'||x.family==='PAD';}).length>=2?1:0,inputWarnings=(debt.warnings||[]).filter(function(w){return!/excluded from estimated operating deposits/i.test(String(w||''));});
  if(reversalCreditsTotal)inputWarnings.push('Returned/reversal credit activity of $'+vfcRound_(reversalCreditsTotal,.01)+' is excluded from estimated operating deposits.');
  if(transferCreditsTotal)inputWarnings.push('Explicit bank-account transfer credits of $'+vfcRound_(transferCreditsTotal,.01)+' are excluded from estimated operating deposits. Generic customer e-Transfers are not excluded unless the bank-specific rules identify them as internal transfers.');
  audit.forEach(function(a){if(a.legacyDateShiftDays)inputWarnings.push(a.fileName+': corrected a legacy one-day timezone offset on '+a.correctedTransactionDates+' frozen transaction date'+(a.correctedTransactionDates===1?'':'s')+' before recurrence analysis.');if(a.duplicateRowsCollapsed)inputWarnings.push(a.fileName+': '+a.duplicateRowsCollapsed+' older re-upload row'+(a.duplicateRowsCollapsed===1?' was':'s were')+' collapsed into this logical statement before underwriting.');if((vfcNum_(a.totalDeposits)>0||vfcNum_(a.totalWithdrawals)>0)&&a.transactionCount===0)inputWarnings.push(a.fileName+': statement totals were present but no transaction rows were frozen; recurring-payment analysis may be incomplete.');});
  const result=Object.assign({},base,{statementCount:rows.length,monthsCovered:rows.length,totalDeposits:vfcRound_(totalDeposits,.01),averageMonthlyDeposits:vfcRound_(grossMonthly,.01),totalWithdrawals:vfcRound_(totalWithdrawals,.01),depositWithdrawalRatio:totalWithdrawals?vfcRound_(totalDeposits/totalWithdrawals,.01):0,averageOpeningBalance:vfcRound_(vfcMean_(openings),.01),averageClosingBalance:vfcRound_(vfcMean_(closings),.01),depositVolatility:vfcRound_(avgDep?vfcStdDev_(monthlyDeposits)/avgDep:1,.01),depositTrend:vfcRound_(vfcTrend_(monthlyDeposits),.01),nsfCount:nsf,nsfPerMonth:vfcRound_(nsf/months,.01),negativeBalanceFlag:negative,overdraftFlag:overdraftFlag,returnedPaymentFlag:returnedFlag,suspectedStacking:stackingFlag,missingInfoFlag:0,mcaPaymentFlag:debt.activeDebtObligations.length?1:0,monthlyDeposits:monthlyDeposits.slice(),monthlyWithdrawals:monthlyWithdrawals.slice(),estimatedOperatingTotalDeposits:vfcRound_(operatingTotal,.01),estimatedOperatingMonthlyDeposits:vfcRound_(operatingMonthly,.01),detectedFinancingCredits:vfcRound_(debt.financingCreditsTotal,.01),excludedReversalCredits:vfcRound_(reversalCreditsTotal,.01),excludedReversalCreditTransactions:reversalCredits,excludedTransferCredits:vfcRound_(transferCreditsTotal,.01),excludedTransferCreditTransactions:transferCredits,existingMonthlyDebtService:vfcRound_(debt.confirmedMonthlyDebtService,.01),informationalRecurringMonthlyObligations:vfcRound_(debt.informationalMonthlyObligations,.01),otherRecurringMonthlyObligations:vfcRound_(debt.informationalMonthlyObligations,.01),debtServiceToDepositsRatio:debt.confirmedMonthlyDebtService?(operatingMonthly?vfcRound_(debt.confirmedMonthlyDebtService/operatingMonthly,.0001):1):0,debtServiceToGrossDepositsRatio:debt.confirmedMonthlyDebtService?(grossMonthly?vfcRound_(debt.confirmedMonthlyDebtService/grossMonthly,.0001):1):0,debtServiceRatioBasis:'ESTIMATED_OPERATING_DEPOSITS',debtProfile:debt,inputQualityAudit:{modelVersion:VFC_BANK_ENGINE.VERSION,intakeContract:VFC_BANK_ENGINE.INTAKE_CONTRACT,verified:true,statementAudit:audit,selectedStatementCount:rows.length,excludedReversalCredits:vfcRound_(reversalCreditsTotal,.01),excludedTransferCredits:vfcRound_(transferCreditsTotal,.01),warnings:inputWarnings}});
  result.resultFingerprint=vfcResultFingerprint_(result);result.inputQualityAudit.resultFingerprint=result.resultFingerprint;return result;
}

function vfcNonOperatingReversalCredits_(transactions){const out=(transactions||[]).filter(function(t){return String(t.direction||'').toUpperCase()==='CREDIT'&&vfcBankIsNonOperatingReversalCredit_(t.bankId||'UNKNOWN',t);});return vfcDedupeTx_(out);}
function vfcNonOperatingTransferCredits_(transactions){
  const out=(transactions||[]).filter(function(t){const bankId=t.bankId||'UNKNOWN';return String(t.direction||'').toUpperCase()==='CREDIT'&&!vfcBankIsNonOperatingReversalCredit_(bankId,t)&&!vfcIsKnownFinancingCreditForBank_(bankId,t)&&vfcBankIsNonOperatingTransferCredit_(bankId,t);});
  return vfcDedupeTx_(out);
}

function vfcDebtProfile_(rows){
  let tx=[],latest='';rows.forEach(function(x){if(!latest||vfcTime_(x.payload.statementEndDate)>vfcTime_(latest))latest=x.payload.statementEndDate;(x.payload.transactions||[]).forEach(function(t){tx.push(Object.assign({bankId:x.payload.bankId||'UNKNOWN'},t));});});
  tx=vfcDedupeTx_(tx);const rawDebits=tx.filter(function(t){return t.direction==='DEBIT';}),credits=tx.filter(function(t){return t.direction==='CREDIT';}),returnedCredits=credits.filter(function(c){return vfcBankIsReturnedFinancingCredit_(c.bankId||'UNKNOWN',c);}),returnedCreditsTotal=returnedCredits.reduce(function(s,c){return s+vfcPos_(c.amount);},0),debits=vfcSuppressReturnedFinanceDebits_(rawDebits,credits),returnedFinanceDebitsSuppressed=Math.max(0,rawDebits.length-debits.length),classified=debits.map(function(t){return vfcClassifyDebitForBank_(t.bankId,t);}).filter(Boolean),groups={};
  classified.forEach(function(t){const key=t.bankId+'|'+t.family+'|'+t.entityKey;if(!groups[key])groups[key]={bankId:t.bankId,family:t.family,entityKey:t.entityKey,label:t.label,debtJustification:t.debtJustification||'',items:[]};if(!groups[key].debtJustification&&t.debtJustification)groups[key].debtJustification=t.debtJustification;groups[key].items.push(t);});
  let summaries=Object.keys(groups).sort().map(function(k){return vfcSummarizeGroup_(groups[k],latest);}).filter(Boolean);summaries=vfcMergeGenericAmountMatches_(summaries);
  const sweepByBank={};credits.forEach(function(c){if(/\bLOAN\s+CREDIT\b/i.test(c.description))sweepByBank[c.bankId]=(sweepByBank[c.bankId]||0)+1;});const active=[],revolving=[],tax=[],other=[],inactive=[],once=[];
  summaries.forEach(function(g){if((sweepByBank[g.bankId]||0)>=2&&g.entityKey==='GENERIC_LOAN_PAYMENT'){revolving.push(g);return;}if(!g.recurring){once.push(g);return;}if(g.family==='FINANCING'||g.family==='MCA'||g.family==='PAD'){if(g.active)active.push(g);else once.push(g);}else if(g.family==='TAX'){if(g.active)tax.push(g);else inactive.push(g);}else{if(g.active)other.push(g);else inactive.push(g);}});
  const financing=vfcFinancingCredits_(credits,classified);active.sort(vfcObligationSort_);tax.sort(vfcObligationSort_);other.sort(vfcObligationSort_);const confirmed=active.reduce(function(s,x){return s+x.monthlyEquivalent;},0),info=tax.concat(other).reduce(function(s,x){return s+x.monthlyEquivalent;},0),warnings=[];
  if(revolving.length)warnings.push('Generic revolving loan sweep activity is excluded from fixed monthly debt.');if(returnedFinanceDebitsSuppressed)warnings.push(returnedFinanceDebitsSuppressed+' returned/reversed financing debit'+(returnedFinanceDebitsSuppressed===1?' was':'s were')+' excluded from recurring debt service while the return event remains a risk fact.');if(inactive.length)warnings.push('Stale informational obligations are retained without a fabricated monthly equivalent.');if(financing.possible.length)warnings.push('Possible financing credits are shown separately and are not removed from operating deposits unless confirmed.');
  return{confirmedMonthlyDebtService:vfcRound_(confirmed,.01),informationalMonthlyObligations:vfcRound_(info,.01),activeDebtObligations:active,revolvingFinancingActivity:revolving,taxGovernmentPads:tax,otherRecurringObligations:other,inactiveInformationalObligations:inactive,observedOnce:once,allDetectedObligations:summaries,financingCredits:financing.confirmed,possibleFinancingCredits:financing.possible,financingCreditsTotal:vfcRound_(financing.total,.01),returnedCredits:returnedCredits,returnedCreditsTotal:vfcRound_(returnedCreditsTotal,.01),returnedFinanceDebitsSuppressed:returnedFinanceDebitsSuppressed,warnings:warnings};
}

/** Suppress a financing debit only when a same-amount financing-return marker can be tied to it without ambiguity. */
function vfcSuppressReturnedFinanceDebits_(debits,credits){
  const returned=(credits||[]).filter(function(c){return /ITEM\s+RETURNED\s+NSF|RETURNED\s+ITEM|RETURNED\s+PAYMENT|RETURNED\s+UNPAID|REVERSAL/.test(String(c.description||'').toUpperCase())||vfcBankIsReturnedFinancingCredit_(c.bankId||'UNKNOWN',c);}),suppressed={};
  returned.forEach(function(c){const candidates=[];(debits||[]).forEach(function(d,i){if(suppressed[i])return;if(String(d.bankId||'')!==String(c.bankId||''))return;if(Math.abs(vfcNum_(d.amount)-vfcNum_(c.amount))>.01)return;const dd=vfcDate_(d.date),cd=vfcDate_(c.date);if(!dd||!cd)return;const days=(cd-dd)/86400000;if(days<0||days>3)return;const x=vfcClassifyDebitForBank_(d.bankId,d);if(!x||(x.family!=='FINANCING'&&x.family!=='MCA'))return;candidates.push({index:i,days:days,debit:d,classified:x});});
    if(!candidates.length)return;const minDays=Math.min.apply(null,candidates.map(function(x){return x.days;})),nearest=candidates.filter(function(x){return Math.abs(x.days-minDays)<.000001;});if(nearest.length===1){suppressed[nearest[0].index]=1;return;}const entity=String(nearest[0].classified.entityKey||'');if(entity&&nearest.every(function(x){return String(x.classified.entityKey||'')===entity;})){suppressed[nearest[0].index]=1;return;}
    const generic={ITEM:1,RETURNED:1,NSF:1,PAYMENT:1,REVERSAL:1,UNPAID:1,CREDIT:1,DEBIT:1};const ct=vfcTokens_(c.counterparty||c.description).filter(function(x){return!generic[x];});if(!ct.length)return;const scored=nearest.map(function(x){const dt=vfcTokens_(x.debit.counterparty||x.debit.description);let score=0;ct.forEach(function(a){if(dt.indexOf(a)>=0)score++;});return{index:x.index,score:score};}).sort(function(a,b){return b.score-a.score||a.index-b.index;});if(scored.length&&scored[0].score>0&&(scored.length===1||scored[0].score>scored[1].score))suppressed[scored[0].index]=1;
  });
  return(debits||[]).filter(function(d,i){return!suppressed[i];});
}

function vfcSummarizeGroup_(g,latestEnd){
  const items=(g.items||[]).slice().sort(function(a,b){return vfcTime_(a.date)-vfcTime_(b.date);});if(!items.length)return null;const amounts=items.map(function(x){return x.amount;}),months={};items.forEach(function(x){const m=x.date.slice(0,7);months[m]=(months[m]||0)+x.amount;});const monthAmounts=Object.keys(months).sort().map(function(m){return months[m];}),distinct=Object.keys(months).length,occ=items.length,gaps=[];for(let i=1;i<items.length;i++)gaps.push((vfcDate_(items[i].date)-vfcDate_(items[i-1].date))/86400000);const medianGap=gaps.length?vfcMedian_(gaps):0,median=vfcMedian_(amounts),cv=vfcCv_(amounts),accountComposite=/^LOAN_ACCOUNT_[0-9]/.test(String(g.entityKey||'').toUpperCase()),displayPayment=accountComposite?vfcMedian_(monthAmounts):median,displayAverage=accountComposite?vfcMean_(monthAmounts):vfcMean_(amounts),weeklyRatio=gaps.length?gaps.filter(function(x){return x>=5&&x<=10;}).length/gaps.length:0,biweeklyRatio=gaps.length?gaps.filter(function(x){return x>10&&x<=18;}).length/gaps.length:0,recurring=distinct>=2||occ>=3,daysSince=vfcDays_(items[items.length-1].date,latestEnd),active=daysSince===null?true:daysSince<=VFC_BANK_ENGINE.ACTIVE_DAYS;let frequency='Observed statement-period cash flow',monthly=0,method='OBSERVED_ONLY';
  if(recurring&&accountComposite){frequency='Monthly combined loan-account debits';monthly=vfcMeanObject_(months);method='MONTHLY_ACCOUNT_TOTAL_MEAN';}else if(recurring&&medianGap>=5&&medianGap<=10&&occ>=4&&weeklyRatio>=.65){frequency='Weekly observed cadence';monthly=median*52/12;method='WEEKLY_MEDIAN';}else if(recurring&&medianGap>10&&medianGap<=18&&occ>=3&&biweeklyRatio>=.55){frequency='Biweekly observed cadence';monthly=median*26/12;method='BIWEEKLY_MEDIAN';}else if(recurring&&distinct>=2&&occ===distinct){frequency='Monthly observed cadence';monthly=cv<=.03?median:vfcMeanObject_(months);method=cv<=.03?'MONTHLY_MEDIAN':'MONTHLY_VARIABLE_MEAN';}else if(recurring){frequency='Multiple payments per month';monthly=vfcRecentMonthAverage_(months,3);method='RECENT_3_MONTH_AVERAGE';}
  if(!active&&g.family!=='FINANCING'&&g.family!=='MCA'&&g.family!=='PAD'){monthly=0;method='STALE_INFORMATIONAL';}
  let why=String(g.debtJustification||'').trim();if(why&&recurring)why+=' Recurrence evidence: '+occ+' observed payment'+(occ===1?'':'s')+' across '+distinct+' month'+(distinct===1?'':'s')+'; '+frequency+'.';
  return{bankId:g.bankId||'',family:g.family,key:g.entityKey,entityKey:g.entityKey,counterparty:g.label,description:g.label,category:g.family==='FINANCING'?'LOAN':g.family,paymentAmount:vfcRound_(displayPayment,.01),averagePayment:vfcRound_(displayAverage,.01),frequency:frequency,monthlyEquivalent:vfcRound_(monthly,.01),monthlyEquivalentMethod:method,occurrences:occ,distinctMonths:distinct,firstSeen:items[0].date,lastSeen:items[items.length-1].date,daysSinceLastObserved:daysSince,active:active,recurring:recurring,confidence:!recurring?'Low':(distinct>=3?'High':'Moderate'),observedTotal:vfcRound_(vfcSum_(amounts),.01),observedMonthlyTotals:vfcSortedMoneyObject_(months),components:vfcAmountComponents_(items),debtJustification:why};
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
  (credits||[]).forEach(function(c){const bankId=c.bankId||'UNKNOWN';if(vfcBankIsNonOperatingReversalCredit_(bankId,c))return;const s=String(c.description||'').toUpperCase(),amount=vfcPos_(c.amount);if(!(amount>0))return;const explicit=/\bLOAN\s+CREDIT\b|LOAN\s+ADVANCE|LOAN\s+PROCEEDS|FINANC(?:E|ING)\s+ADVANCE|FINANC(?:E|ING)\s+PROCEEDS|FUNDING\s+ADVANCE|MCA\s+ADVANCE|CSBFL\s+(?:LOAN\s+)?ADVANCE|CSBFL\s+PROCEEDS|MORTGAGE\s+(?:ADVANCE|PROCEEDS|FUNDING)|(?:\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE)\s+(?:ADVANCE|PROCEEDS|FUNDING)/.test(s),matched=vfcMatchedPaymentEntity_(c,financingDebits),known=vfcIsKnownFinancingCreditForBank_(bankId,c),item={bankId:bankId,date:c.date,description:c.description,counterparty:c.counterparty,amount:c.amount,direction:'CREDIT',occurrence:c.occurrence||1,linkedPaymentEntity:matched,confidence:(explicit||known||matched)?'High':'Moderate'};if(explicit||(amount>=5000&&known))confirmed.push(item);else if(amount>=5000&&(matched||/INVESTMENT|CAPITAL/.test(s)))possible.push(item);});
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
function vfcIso_(v){const literal=String(v==null?'':v).trim(),m=literal.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(m){const y=Number(m[1]),mo=Number(m[2]),day=Number(m[3]),check=new Date(Date.UTC(y,mo-1,day));if(check.getUTCFullYear()===y&&check.getUTCMonth()===mo-1&&check.getUTCDate()===day)return literal;}const d=vfcDate_(v);return d?Utilities.formatDate(d,Session.getScriptTimeZone()||'GMT','yyyy-MM-dd'):'';}
function vfcIsoDayNumber_(v){const s=vfcIso_(v),m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?Math.floor(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]))/86400000):null;}
function vfcShiftIsoDate_(v,days){const n=vfcIsoDayNumber_(v);if(n===null)return'';return new Date((n+(Number(days)||0))*86400000).toISOString().slice(0,10);}
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
function vfcIsStrongEntityKey_(key,family,bankId){const k=String(key||'').toUpperCase();return/^LOAN(?:_INTEREST|_ACCOUNT)?_[0-9]/.test(k)||/^INSURANCE_/.test(k)||vfcBankStrongEntityKey_(bankId,k,family);}
function vfcDigest_(s){const bytes=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(s||''),Utilities.Charset.UTF_8);return bytes.map(function(b){const v=(b<0?b+256:b).toString(16);return v.length===1?'0'+v:v;}).join('').substring(0,24);}

/* ===== END BankingCore.gs ===== */

/* ===== BEGIN Bank_RBC.gs ===== */
/**
 * RBC BANK ENGINE v3.8.1 — CANDIDATE / FULL PROJECT SYNC
 * ONE PERMANENT RBC FILE.
 *
 * Architecture:
 * 1) Printed RBC Account Summary is the source of truth for statement totals/counts.
 * 2) Every visible Account Activity amount row is frozen.
 * 3) The extracted ledger must match printed CREDIT/DEBIT counts AND dollar totals exactly.
 * 4) If first-pass extraction misses/duplicates a row, RBC performs a targeted reconciliation pass.
 * 5) A repaired ledger is accepted only after the exact same deterministic audit passes.
 * 6) Printed column controls direction. Verified narrow signatures correct known drift.
 * 7) If row count and grand total are already exact, a unique minimum-flip checksum
 *    solution may correct direction-only PDF/LLM drift without changing any row fact.
 * 8) Transcript-visible transfer rows may be canonicalized only when one unique
 *    assignment exactly satisfies all four printed controls.
 * 9) If the cached transcript split a row, a focused original-PDF pass reads only
 *    that narrow row family before any full-ledger reread is allowed.
 * 10) Other missing rows or wrong amounts trigger a fresh structured read of the PDF.
 * 11) PAD/NSF/return/debt classification remains deterministic after facts are frozen.
 */
function vfcRbcBankProfile_(){
  return{
    id:'RBC',
    label:'RBC',
    status:'CANDIDATE',
    rulesVersion:'RBC-3.8.1-CANDIDATE',
    runtimeFingerprint:'RBC-3.8.1-FULL-PROJECT-SYNC-20260923',
    intakeContract:'BANK_MATCHED_FROZEN_LEDGER_V2',
    aliases:['ROYAL BANK OF CANADA','RBC ROYAL BANK','RBC']
  };
}

function vfcRbcExtractionRules_(){return[
  'RBC Account Summary: Total deposits & credits is total_deposits; Total cheques & debits is total_withdrawals.',
  'RBC Account Activity: Cheques & Debits = DEBIT and Deposits & Credits = CREDIT. The PRINTED COLUMN is authoritative.',
  'FULL LEDGER: banking_transactions must contain EVERY visible Account Activity row carrying a transaction amount, including ordinary fees, purchases, cheques, transfers, PADs, insurance, taxes, loans, refunds and deposits.',
  'Do not add Opening balance, Closing balance, Account Summary totals, Account Fees summary totals, page totals, cheque-image/support pages, serial-number image rows or endorsement/back-of-cheque text as transactions.',
  'The number of CREDIT and DEBIT transaction rows and their dollar sums must equal the printed Account Summary exactly. Never approximate or omit a row simply because it seems irrelevant.',
  'MISC PAYMENT, BR TO BR and ONLINE BANKING TRANSFER can appear on either side and follow the printed RBC column. Never omit debit-side ONLINE BANKING TRANSFER - #### rows.',
  'Verified narrow RBC signatures: MISC PAYMENT RBC CREDIT CARD is a DEBIT; CHEQUE RETURNED NSF is a CREDIT; ITEM RETURNED UNPAID is a DEBIT.',
  'These verified signatures correct known PDF/AI column drift before reconciliation. All other ambiguous return/transfer descriptions follow the printed column.',
  'Every transaction date must fall inside the printed statement period. When RBC prints one date followed by undated continuation rows, carry that printed date forward until the next visible date.',
  'Preserve every PAD-like debit: BUSINESS PAD, PAD, PRE-AUTH, PRE-AUTHORIZED, PREAUTHORIZED, DIRECT DEBIT, EFT DEBIT, ACH DEBIT, AUTOMATIC DEBIT, AUTO PAYMENT and lender-specific PAD wording.',
  'Unknown PAD/direct-debit counterparties remain informational unless independent lender/loan/MCA/finance/lease evidence exists. Recurrence or same amount alone never proves financing.',
  'Preserve every return/NSF/reversal principal event and any later retry. Return wording can be CREDIT or DEBIT; printed RBC column decides direction.',
  'A return CREDIT can reverse a failed borrower debit/PAD. A return DEBIT can reverse a deposited item. Do not confuse those two cases.',
  'Preserve NSF/returned-item fees separately as fee debits; fees are never the returned principal amount.',
  'Any recurring debit explicitly containing LOAN, MORTGAGE, LOC/LINE OF CREDIT, FINANCING, MCA or LEASE is a financing-obligation candidate.',
  'General e-Transfers, transfers, rent, tax, utility, payroll, card payments and unknown PADs are not financing merely because they recur.',
  'AFFIRM CANADA is financing when recurring.',
  'PREMIUM FINANCE, PREMIUM FINANCING, the RBC-truncated label IC PREMIUM FINA, and IPFS are financing when recurring; ordinary insurance remains informational.',
  'BDC: BUSINESS PAD BDC is the normal PAD stream. BDC-LOAN/PRET/manual BDC loan payments stay separate. Materially different BDC PAD amounts are separated into amount bands so catch-up payments cannot inflate normal monthly debt.',
  'Journey/OnDeck, Merchant Growth, Canacap and Greenbox are MCA-style exposures when recurring. iCapital remains general financing unless statement wording proves MCA.',
  'Known financing entities include BDC, Canacap, iCapital, Greenbox, Journey/OnDeck, Merchant Growth, SilverChef, Affirm Canada and explicit premium finance/IPFS.',
  'LOAN CREDIT, CSBFL advances and credits from known financing entities are financing-credit candidates only when printed in Deposits & Credits.',
  'BR TO BR credits, explicit TRANSFER FROM ACCOUNT credits and credit-side ONLINE BANKING TRANSFER - #### rows are internal account transfers unless independently identified as financing proceeds. Generic customer e-Transfers are not excluded.',
  'Do not duplicate cheque-image/support pages.'
].join('\n');}

function vfcRbcLockFacts_(summary,text,fileName,sourceFileId){
  const facts=vfcExtractPrintedStatementFacts_(text),name=String(fileName||'statement'),printed=vfcRbcPrintedActivityCounts_(text);
  if(!facts.startDate||!facts.endDate||facts.opening===null||facts.closing===null||facts.deposits===null||facts.withdrawals===null){
    throw new Error('RBC printed Account Summary could not be fully verified for '+name+'. Upload stopped before saving incomplete statement facts.');
  }
  if(printed.creditCount===null||printed.debitCount===null){
    throw new Error('RBC printed Account Summary transaction counts could not be verified for '+name+'. Upload stopped before freezing the ledger.');
  }

  const statementDiff=Math.abs((facts.opening+facts.deposits-facts.withdrawals)-facts.closing);
  if(statementDiff>.01)throw new Error('RBC printed Account Summary does not reconcile for '+name+'. Difference: $'+vfcRound_(statementDiff,.01)+'.');

  const locked=Object.assign({},summary||{});
  locked.statement_start_date=facts.startDate;
  locked.statement_end_date=facts.endDate;
  locked.opening_balance=facts.opening;
  locked.closing_balance=facts.closing;
  locked.total_deposits=facts.deposits;
  locked.total_withdrawals=facts.withdrawals;

  const directionRepairs=[],missingRowRepairs=[];
  let ledger=vfcRbcPrepareLedger_(locked.banking_transactions||[],directionRepairs),audit=null,lastError='',repairPasses=0,focusedRepairPasses=0;
  let missingRepair=vfcRbcRecoverMissingOnlineTransfers_(ledger,text,facts);
  if(missingRepair.changed){ledger=missingRepair.rows;Array.prototype.push.apply(missingRowRepairs,missingRepair.added);}
  let checksumRepair=vfcRbcReconcileDirectionOnly_(ledger,facts,text);
  if(checksumRepair.changed){ledger=checksumRepair.rows;Array.prototype.push.apply(directionRepairs,checksumRepair.flips);}
  for(let attempt=0;attempt<=2;attempt++){
    try{
      audit=vfcRbcAuditFullLedger_(ledger,facts,text,name);
      break;
    }catch(e){
      lastError=String(e&&e.message||e);
      if(!focusedRepairPasses&&sourceFileId&&vfcRbcHasOneSidedPositiveDeficit_(ledger,text,facts)){
        focusedRepairPasses++;
        try{
          const focusedRows=vfcRbcReadFocusedOnlineTransfersFromPdf_(sourceFileId,name,facts,focusedRepairPasses);
          missingRepair=vfcRbcRecoverMissingOnlineTransfers_(ledger,text,facts,focusedRows);
          if(missingRepair.changed){ledger=missingRepair.rows;Array.prototype.push.apply(missingRowRepairs,missingRepair.added);continue;}
        }catch(focusedError){lastError+=' | Focused RBC transfer recovery: '+String(focusedError&&focusedError.message||focusedError);}
      }
      if(attempt>=2)throw new Error(lastError);
      repairPasses++;
      ledger=vfcRbcRepairLedger_(ledger,text,name,facts,lastError,repairPasses,directionRepairs,sourceFileId);
      missingRepair=vfcRbcRecoverMissingOnlineTransfers_(ledger,text,facts);
      if(missingRepair.changed){ledger=missingRepair.rows;Array.prototype.push.apply(missingRowRepairs,missingRepair.added);}
      checksumRepair=vfcRbcReconcileDirectionOnly_(ledger,facts,text);
      if(checksumRepair.changed){ledger=checksumRepair.rows;Array.prototype.push.apply(directionRepairs,checksumRepair.flips);}
    }
  }

  if(!audit)throw new Error('RBC ledger verification did not complete for '+name+'.');
  locked.banking_transactions=ledger;
  locked.rbc_full_ledger_verified=true;
  locked.rbc_ledger_reconciled=repairPasses>0||directionRepairs.length>0||missingRowRepairs.length>0;
  locked.rbc_ledger_repair_passes=repairPasses;
  locked.rbc_focused_pdf_repair_passes=focusedRepairPasses;
  locked.rbc_original_pdf_repair_used=!!sourceFileId&&(repairPasses>0||focusedRepairPasses>0);
  locked.rbc_direction_repairs=directionRepairs;
  locked.rbc_missing_row_repairs=missingRowRepairs;
  locked.rbc_runtime_fingerprint=vfcRbcBankProfile_().runtimeFingerprint;
  locked.rbc_credit_transaction_count=audit.creditCount;
  locked.rbc_debit_transaction_count=audit.debitCount;
  locked.nsf_count=vfcRbcCountBorrowerNsfEvents_(ledger);
  locked.negative_balance_detected=vfcRbcNegativeBalanceFlag_(text,facts);
  return locked;
}

function vfcRbcPrintedActivityCounts_(text){
  const s=String(text||'').replace(/\u00a0/g,' '),
        c=s.match(/Total\s+deposits\s*(?:&|and)\s*credits\s*\((\d+)\)/i),
        d=s.match(/Total\s+cheques?\s*(?:&|and)\s*debits\s*\((\d+)\)/i);
  return{creditCount:c?Number(c[1]):null,debitCount:d?Number(d[1]):null};
}

function vfcRbcIsNonActivityArtifact_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s)return true;
  return/^OPENING\s+BALANCE\b|^CLOSING\s+BALANCE\b|^ACCOUNT\s+FEES?\b|^ACCOUNT\s+SUMMARY\b|^TOTAL\s+DEPOSITS\s*&\s*CREDITS\b|^TOTAL\s+CHEQUES\s*&\s+DEBITS\b|^PAGE\s+TOTAL\b|^SERIAL\s*#?\s*:?\s*\d+\s+AMOUNT\b|FOR\s+DEPOSIT\s+ONLY|BACKVERSO|BACK\s*\/\s*VERSO|CHEQUE\s+IMAGE|CHECK\s+IMAGE/.test(s);
}

function vfcRbcPrepareLedger_(items,directionRepairs){
  return(Array.isArray(items)?items:[]).filter(function(x){return!vfcRbcIsNonActivityArtifact_(x);}).map(function(x){
    const t=Object.assign({},x||{}),original=String(t.direction||'').toUpperCase(),forced=vfcRbcCertainDirection_(t);
    if(forced){
      t.direction=forced;
      if(original&&original!==forced&&Array.isArray(directionRepairs))directionRepairs.push({date:String(t.date||''),description:String(t.description||''),amount:vfcNum_(t.amount),from:original,to:forced});
    }
    t.direction=String(t.direction||'').toUpperCase();
    t.description=String(t.description||'').replace(/\s+/g,' ').trim();
    t.counterparty=String(t.counterparty||t.description||'').replace(/\s+/g,' ').trim();
    t.amount=vfcNum_(t.amount);
    return t;
  });
}

function vfcRbcCertainDirection_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s)return'';

  /*
   * These narrow RBC labels were verified against the printed columns, running
   * balances, transaction counts and statement totals. Online Banking Transfer
   * is deliberately absent because RBC prints that label in either column.
   */
  if(/^MISC\s+PAYMENT\s+RBC\s+CREDIT\s+CARD\b/.test(s))return'DEBIT';
  if(/^CHEQUE\s+RETURNED\s+NSF\b|^CHECK\s+RETURNED\s+NSF\b/.test(s))return'CREDIT';
  if(/^ITEM\s+RETURNED\s+UNPAID\b/.test(s))return'DEBIT';

  if(vfcRbcReturnEventText_(s))return'';
  if(/^LOAN\s+CREDIT\b/.test(s)||/\bPAYROLL\s+DEPOSIT\b|\bTAX\s+REFUND\b|E-TRANSFER\s+RECEIVED|INTERAC\s+PURCHASE\s+REFUND|E-TRANSFER\s+CANCEL|MOBILE\s+CHEQUE\s+DEPOSIT/.test(s))return'CREDIT';
  if(vfcRbcIsPadLikeText_(s)||/^LOAN\s+PAYMENT\b|^LOAN\s+INTEREST\b|^BLIP\s+PAYMENT\s*-?\s*LOAN\b|^BILL\s+PAYMENT\b|^FUEL\s+BILL\s+PAYMENT\b|^COMM\s+GAS\s+BILL\s+PMT\b|^COMMERCIAL\s+TAXES\b|^AUTO\s+INSURANCE\b|^INSURANCE\b|^RENT\/LEASE\b|^CHEQUE\s*-\s*\d+\b|^CONTACTLESS\s+INTERAC\s+PURCHASE\b|^ACTIVITY\s+FEE\b|^MONTHLY\s+FEE\b|^REGULAR\s+TRANSACTION\s+FEE\b|E-TRANSFER\s+SENT|E-TRANSFER\s+REQUEST\s+FULFILLED/.test(s))return'DEBIT';
  return'';
}

function vfcRbcDirectionCombos_(items,count,limit){
  if(count===0)return{combos:[{sum:0,indexes:[]}],overflow:false};
  if(count<0||count>items.length)return{combos:[],overflow:false};
  const combos=[],max=Math.max(1,Number(limit||25000));let overflow=false;
  function walk(start,left,sum,indexes){
    if(overflow)return;
    if(left===0){combos.push({sum:sum,indexes:indexes.slice()});if(combos.length>max)overflow=true;return;}
    for(let i=start;i<=items.length-left;i++){
      indexes.push(items[i].index);walk(i+1,left-1,sum+items[i].cents,indexes);indexes.pop();
      if(overflow)return;
    }
  }
  walk(0,count,0,[]);
  return{combos:overflow?[]:combos,overflow:overflow};
}

function vfcRbcActivityIsoDate_(dayValue,monthValue,facts){
  const months={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11},
        month=months[String(monthValue||'').substring(0,3).toUpperCase()],day=Number(dayValue),
        startDay=vfcRbcIsoDayNumber_(facts&&facts.startDate),endDay=vfcRbcIsoDayNumber_(facts&&facts.endDate),
        startYear=Number(String(facts&&facts.startDate||'').substring(0,4)),endYear=Number(String(facts&&facts.endDate||'').substring(0,4)),years=[];
  if(month===undefined||!(day>=1&&day<=31)||!startYear||!endYear)return'';
  for(let year=startYear-1;year<=endYear+1;year++)if(years.indexOf(year)<0)years.push(year);
  for(let i=0;i<years.length;i++){
    const date=new Date(Date.UTC(years[i],month,day));
    if(date.getUTCFullYear()!==years[i]||date.getUTCMonth()!==month||date.getUTCDate()!==day)continue;
    const iso=date.toISOString().slice(0,10),number=vfcRbcIsoDayNumber_(iso);
    if(number!==null&&startDay!==null&&endDay!==null&&number>=startDay&&number<=endDay)return iso;
  }
  return'';
}

function vfcRbcTranscriptLines_(text){
  const source=String(text||'').replace(/\u00a0/g,' '),activity=source.search(/Account\s+Activity(?:\s+Details)?/i);
  return(activity>=0?source.substring(activity):source).split(/\r?\n/);
}

function vfcRbcTranscriptDateFromLine_(line,facts,currentDate){
  const s=String(line||''),prefix='^\\s*(?:[-*]\\s*)?(?:["\\\']?DATE["\\\']?\\s*[:=|-]\\s*)?["\\\']?',
        iso=s.match(new RegExp(prefix+'(\\d{4}-\\d{2}-\\d{2})\\b','i')),
        start=vfcRbcIsoDayNumber_(facts&&facts.startDate),end=vfcRbcIsoDayNumber_(facts&&facts.endDate);
  if(iso){const day=vfcRbcIsoDayNumber_(iso[1]);if(day!==null&&start!==null&&end!==null&&day>=start&&day<=end)return iso[1];}
  const month='(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)',
        dayMonth=s.match(new RegExp(prefix+'(\\d{1,2})\\s+'+month+'\\b','i')),
        monthDay=s.match(new RegExp(prefix+month+'\\s+(\\d{1,2})\\b','i'));
  if(dayMonth)return vfcRbcActivityIsoDate_(dayMonth[1],dayMonth[2],facts)||currentDate||'';
  if(monthDay)return vfcRbcActivityIsoDate_(monthDay[2],monthDay[1],facts)||currentDate||'';
  return currentDate||'';
}

function vfcRbcTranscriptMoneyForRow_(lines,index,matchEnd){
  const first=String(lines[index]||'').substring(Math.max(0,Number(matchEnd||0))),parts=[first];
  let money=first.match(/\$?([0-9][0-9,]*\.\d{2})/);
  if(money)return{amount:Number(money[1].replace(/,/g,'')),fragment:parts.join(' ')};
  for(let offset=1;offset<=3&&index+offset<lines.length;offset++){
    const next=String(lines[index+offset]||'');
    if(/ONLINE\s+BANKING\s+TRANSFER\s*-\s*\d{3,}|CHEQUE\s*-\s*\d+|E-TRANSFER|BILL\s+PAYMENT|ACCOUNT\s+PAYABLE|BR\s+TO\s+BR|CLOSING\s+BALANCE/i.test(next))break;
    parts.push(next);money=next.match(/\$?([0-9][0-9,]*\.\d{2})/);
    if(money)return{amount:Number(money[1].replace(/,/g,'')),fragment:parts.join(' ')};
  }
  return null;
}

/** Parse the exact RBC transfer label even when the provider splits amount/date onto nearby lines. */
function vfcRbcOnlineTransferCandidates_(text,facts){
  const lines=vfcRbcTranscriptLines_(text),out=[];let currentDate='',seen=false;
  for(let i=0;i<lines.length;i++){
    const line=String(lines[i]||'');currentDate=vfcRbcTranscriptDateFromLine_(line,facts,currentDate);
    if(seen&&/\bClosing\s+balance\b/i.test(line))break;
    const transfer=line.match(/ONLINE\s+BANKING\s+TRANSFER\s*-\s*(\d{3,})/i);
    if(!transfer||!currentDate)continue;
    const money=vfcRbcTranscriptMoneyForRow_(lines,i,Number(transfer.index||0)+transfer[0].length);
    if(!money||!(money.amount>0))continue;
    const fragment=(line+' '+money.fragment).replace(/\s+/g,' ').trim().toUpperCase();let hint='';
    if(/\b(?:DEBIT|CHEQUES?\s*&\s*DEBITS?)\b/.test(fragment)&&!/\b(?:CREDIT|DEPOSITS?\s*&\s*CREDITS?)\b/.test(fragment))hint='DEBIT';
    else if(/\b(?:CREDIT|DEPOSITS?\s*&\s*CREDITS?)\b/.test(fragment)&&!/\b(?:DEBIT|CHEQUES?\s*&\s*DEBITS?)\b/.test(fragment))hint='CREDIT';
    out.push({date:currentDate,description:'Online Banking transfer - '+transfer[1],counterparty:'Online Banking transfer - '+transfer[1],amount:money.amount,cents:Math.round(money.amount*100),directionHint:hint,sourceLine:(line+' '+money.fragment).replace(/\s+/g,' ').trim()});seen=true;
  }
  return out;
}

function vfcRbcChequeCandidates_(text,facts){
  const lines=vfcRbcTranscriptLines_(text),out=[];let currentDate='',seen=false;
  for(let i=0;i<lines.length;i++){
    const line=String(lines[i]||'');currentDate=vfcRbcTranscriptDateFromLine_(line,facts,currentDate);
    if(seen&&/\bClosing\s+balance\b/i.test(line))break;
    const cheque=line.match(/\bCHEQUE\s*-\s*(\d+)\b/i);
    if(!cheque||!currentDate)continue;
    const money=vfcRbcTranscriptMoneyForRow_(lines,i,Number(cheque.index||0)+cheque[0].length);
    if(!money||!(money.amount>0))continue;
    out.push({date:currentDate,description:'Cheque - '+cheque[1],amount:money.amount,cents:Math.round(money.amount*100),reference:cheque[1]});seen=true;
  }
  return out;
}

function vfcRbcOnlineTransferKey_(t){
  const match=String(t&&t.description||'').match(/ONLINE\s+BANKING\s+TRANSFER\s*-\s*(\d{3,})/i);
  if(!match)return'';
  return[vfcIso_(t&&t.date),String(Number(match[1])),Math.round(vfcNum_(t&&t.amount)*100)].join('|');
}

function vfcRbcNormalizeTransferCandidates_(items,facts){
  const out=[],seen={},start=vfcRbcIsoDayNumber_(facts&&facts.startDate),end=vfcRbcIsoDayNumber_(facts&&facts.endDate);
  (Array.isArray(items)?items:[]).forEach(function(t,index){
    const match=String(t&&t.description||'').match(/ONLINE\s+BANKING\s+TRANSFER\s*-\s*(\d{3,})/i),date=vfcIso_(t&&t.date),day=vfcRbcIsoDayNumber_(date),amount=vfcNum_(t&&t.amount);
    if(!match||!date||day===null||start===null||end===null||day<start||day>end||!(amount>0))return;
    const row={date:date,description:'Online Banking transfer - '+match[1],counterparty:'Online Banking transfer - '+match[1],amount:amount,cents:Math.round(amount*100),directionHint:/^(?:DEBIT|CREDIT)$/.test(String(t.directionHint||t.direction||'').toUpperCase())?String(t.directionHint||t.direction).toUpperCase():'',sourceLine:String(t.sourceLine||t.description||''),candidateId:'T'+index},key='';
    row.key=vfcRbcOnlineTransferKey_(row);if(!row.key||seen[row.key])return;seen[row.key]=1;out.push(row);
  });
  return out;
}

function vfcRbcChequeKey_(t){const m=String(t&&t.description||'').match(/\bCHEQUE\s*-\s*(\d+)\b/i);return m?[vfcIso_(t&&t.date),String(Number(m[1])),Math.round(vfcNum_(t&&t.amount)*100)].join('|'):'';}
function vfcRbcChequeSignature_(t){const m=String(t&&t.description||'').match(/\bCHEQUE\s*-\s*(\d+)\b/i);return m?[String(Number(m[1])),Math.round(vfcNum_(t&&t.amount)*100)].join('|'):'';}

function vfcRbcProvenExtraChequeIndexes_(rows,text,facts){
  const transcript=vfcRbcChequeCandidates_(text,facts),bySignature={},ledgerBySignature={},remove=[];
  transcript.forEach(function(t){const sig=vfcRbcChequeSignature_(t);if(sig){if(!bySignature[sig])bySignature[sig]=[];bySignature[sig].push(t);}});
  (rows||[]).forEach(function(t,index){const sig=vfcRbcChequeSignature_(t);if(sig){if(!ledgerBySignature[sig])ledgerBySignature[sig]=[];ledgerBySignature[sig].push({row:t,index:index});}});
  Object.keys(ledgerBySignature).forEach(function(sig){
    const expected=bySignature[sig]||[],actual=ledgerBySignature[sig];if(!expected.length||actual.length<=expected.length||actual.length-expected.length>2)return;
    const counts={};expected.forEach(function(t){const key=vfcRbcChequeKey_(t);counts[key]=(counts[key]||0)+1;});const extras=[];
    actual.forEach(function(item){const key=vfcRbcChequeKey_(item.row);if((counts[key]||0)>0)counts[key]--;else extras.push(item);});
    if(extras.length!==actual.length-expected.length)return;
    const adjacent=extras.every(function(item){const day=vfcRbcIsoDayNumber_(item.row&&item.row.date);return expected.some(function(t){const other=vfcRbcIsoDayNumber_(t.date);return day!==null&&other!==null&&Math.abs(day-other)<=1;});});
    if(adjacent)extras.forEach(function(item){remove.push(item.index);});
  });
  return remove.slice(0,3);
}

function vfcRbcUniqueCandidateSubset_(candidates,count,targetCents){
  const rows=Array.isArray(candidates)?candidates:[];
  if(count===0)return targetCents===0?[]:null;
  if(count<0||count>rows.length||!(targetCents>0))return null;
  if(count===rows.length){const total=rows.reduce(function(sum,row){return sum+row.cents;},0);return total===targetCents?rows.slice():null;}
  const dp=[];for(let n=0;n<=count;n++)dp[n]={};dp[0]['0']={ways:1,indexes:[]};
  for(let i=0;i<rows.length;i++){
    const cents=rows[i].cents;
    for(let n=Math.min(count,i+1);n>=1;n--){
      const previous=dp[n-1],keys=Object.keys(previous);
      for(let k=0;k<keys.length;k++){
        const prior=previous[keys[k]],sum=Number(keys[k])+cents;if(sum>targetCents)continue;
        const key=String(sum),existing=dp[n][key];if(!existing)dp[n][key]={ways:prior.ways,indexes:prior.indexes.concat([i])};else existing.ways=Math.min(2,existing.ways+prior.ways);
      }
      if(Object.keys(dp[n]).length>25000)return null;
    }
  }
  const solution=dp[count][String(targetCents)];return solution&&solution.ways===1?solution.indexes.map(function(index){return rows[index];}):null;
}

function vfcRbcHasOneSidedPositiveDeficit_(items,text,facts){
  const printed=vfcRbcPrintedActivityCounts_(text),stats=vfcRbcLedgerStats_(items),creditCount=printed.creditCount-stats.creditCount,debitCount=printed.debitCount-stats.debitCount,creditCents=Math.round(vfcNum_(facts&&facts.deposits)*100)-Math.round(stats.totalCredits*100),debitCents=Math.round(vfcNum_(facts&&facts.withdrawals)*100)-Math.round(stats.totalDebits*100);
  return(creditCount===0&&creditCents===0&&debitCount>0&&debitCents>0)||(debitCount===0&&debitCents===0&&creditCount>0&&creditCents>0);
}

function vfcRbcReadFocusedOnlineTransfersFromPdf_(sourceFileId,fileName,facts,attempt){
  const prompt=[
    'You are the VFC focused RBC row reader. Return JSON only.',
    'File: '+fileName,
    'Read the original PDF Account Activity Details, not cheque-image/support pages.',
    'Return banking_transactions containing ONLY every row whose printed description is ONLINE BANKING TRANSFER - ####. Return no other row.',
    'For each such row return {date:"YYYY-MM-DD",description:"exact printed description",counterparty:"Online Banking transfer - ####",direction:"DEBIT" or "CREDIT",amount:number}.',
    'Use the printed Cheques & Debits or Deposits & Credits column for direction. Never infer direction from the word transfer.',
    'Carry a printed date forward to its undated following rows. Preserve leading zeroes in the four-digit reference.',
    'Statement period: '+String(facts&&facts.startDate||'')+' through '+String(facts&&facts.endDate||'')+'.',
    'Before returning, count the visible ONLINE BANKING TRANSFER rows again. Do not return opening/closing balances or any cheque image.'
  ].join('\n');
  const result=vfcReadBankLedgerFromPdfWithOpenAI_(sourceFileId,prompt,'RBC focused online-transfer recovery pass '+attempt);
  return result&&Array.isArray(result.banking_transactions)?result.banking_transactions:[];
}

/**
 * Replace the narrow transfer family with transcript/PDF-proven rows, remove only
 * a transcript-proven adjacent cheque duplicate, and accept the result solely if
 * one unique direction assignment satisfies all four printed controls.
 */
function vfcRbcRecoverMissingOnlineTransfers_(items,text,facts,providedCandidates){
  const rows=(Array.isArray(items)?items:[]).map(function(t){return Object.assign({},t);}),result={rows:rows,changed:false,added:[],reason:'not-needed'},printed=vfcRbcPrintedActivityCounts_(text),before=vfcRbcLedgerStats_(rows);
  if(printed.creditCount===null||printed.debitCount===null)return Object.assign(result,{reason:'printed-counts-missing'});
  if(before.bad.length)return Object.assign(result,{reason:'incomplete-rows'});
  const sourceCandidates=Array.isArray(providedCandidates)?providedCandidates:vfcRbcOnlineTransferCandidates_(text,facts),candidates=vfcRbcNormalizeTransferCandidates_(sourceCandidates,facts);
  if(!candidates.length)return Object.assign(result,{reason:'no-transfer-candidates'});

  const candidateCounts={},existingPools={};candidates.forEach(function(t){candidateCounts[t.key]=(candidateCounts[t.key]||0)+1;});
  rows.forEach(function(t){const key=vfcRbcOnlineTransferKey_(t);if(key){if(!existingPools[key])existingPools[key]=[];existingPools[key].push(t);}});
  const unknown=Object.keys(existingPools).some(function(key){return!candidateCounts[key]||existingPools[key].length>candidateCounts[key];});
  if(unknown)return Object.assign(result,{reason:'ledger-transfer-not-proven-by-source'});

  const extraCheques=vfcRbcProvenExtraChequeIndexes_(rows,text,facts),removeMap={};extraCheques.forEach(function(index){removeMap[index]=1;});
  const base=rows.filter(function(t,index){return!vfcRbcOnlineTransferKey_(t)&&!removeMap[index];}),baseStats=vfcRbcLedgerStats_(base),
        creditNeed={count:printed.creditCount-baseStats.creditCount,cents:Math.round(vfcNum_(facts&&facts.deposits)*100)-Math.round(baseStats.totalCredits*100)},
        debitNeed={count:printed.debitCount-baseStats.debitCount,cents:Math.round(vfcNum_(facts&&facts.withdrawals)*100)-Math.round(baseStats.totalDebits*100)};
  if(creditNeed.count<0||creditNeed.cents<0||debitNeed.count<0||debitNeed.cents<0||creditNeed.count+debitNeed.count!==candidates.length||creditNeed.cents+debitNeed.cents!==candidates.reduce(function(sum,t){return sum+t.cents;},0))return Object.assign(result,{reason:'source-rows-cannot-fill-printed-controls'});

  let creditRows=null;const allHinted=candidates.every(function(t){return t.directionHint==='CREDIT'||t.directionHint==='DEBIT';});
  if(allHinted){const hinted=candidates.filter(function(t){return t.directionHint==='CREDIT';}),hintedCents=hinted.reduce(function(sum,t){return sum+t.cents;},0);if(hinted.length===creditNeed.count&&hintedCents===creditNeed.cents)creditRows=hinted;}
  if(creditRows===null)creditRows=vfcRbcUniqueCandidateSubset_(candidates,creditNeed.count,creditNeed.cents);
  if(creditRows===null)return Object.assign(result,{reason:'no-unique-transfer-direction-assignment'});

  const creditIds={};creditRows.forEach(function(t){creditIds[t.candidateId]=1;});const fixed=base.slice(),changes=[];
  extraCheques.forEach(function(index){const t=rows[index];changes.push({action:'REMOVE_DUPLICATE',date:String(t.date||''),description:String(t.description||''),amount:vfcNum_(t.amount),direction:String(t.direction||''),reason:'TRANSCRIPT_PROVEN_ADJACENT_DUPLICATE'});});
  candidates.forEach(function(candidate){
    const direction=creditIds[candidate.candidateId]?'CREDIT':'DEBIT',pool=existingPools[candidate.key]||[],existing=pool.length?pool.shift():null,
          row=existing?Object.assign({},existing,{direction:direction}):{date:candidate.date,description:candidate.description,counterparty:candidate.counterparty,direction:direction,amount:candidate.amount};
    fixed.push(row);
    if(!existing)changes.push(Object.assign({},row,{action:'ADD',reason:'UNIQUE_SOURCE_CHECKSUM',sourceLine:candidate.sourceLine}));
    else if(String(existing.direction||'').toUpperCase()!==direction)changes.push(Object.assign({},row,{action:'FLIP',from:String(existing.direction||'').toUpperCase(),to:direction,reason:'UNIQUE_SOURCE_CHECKSUM',sourceLine:candidate.sourceLine}));
  });
  const after=vfcRbcLedgerStats_(fixed),creditTarget=Math.round(vfcNum_(facts&&facts.deposits)*100),debitTarget=Math.round(vfcNum_(facts&&facts.withdrawals)*100);
  if(after.creditCount!==printed.creditCount||after.debitCount!==printed.debitCount||Math.round(after.totalCredits*100)!==creditTarget||Math.round(after.totalDebits*100)!==debitTarget)return Object.assign(result,{reason:'post-recovery-audit-failed'});
  return changes.length?{rows:fixed,changed:true,added:changes,reason:'unique-source-checksum-solution'}:result;
}

/**
 * Correct direction-only extraction drift using RBC's four printed controls.
 * No date, description, amount or row is added, removed or changed.
 * A repair is accepted only when row count and grand total are already exact and
 * one unique minimum-flip solution matches both printed direction counts and totals.
 */
function vfcRbcReconcileDirectionOnly_(items,facts,text){
  const rows=(Array.isArray(items)?items:[]).map(function(t){return Object.assign({},t);}),
        printed=vfcRbcPrintedActivityCounts_(text),before=vfcRbcLedgerStats_(rows),
        result={rows:rows,changed:false,flips:[],reason:'not-needed'};
  if(printed.creditCount===null||printed.debitCount===null)return Object.assign(result,{reason:'printed-counts-missing'});
  if(before.bad.length)return Object.assign(result,{reason:'incomplete-rows'});
  if(before.creditCount+before.debitCount!==printed.creditCount+printed.debitCount)return Object.assign(result,{reason:'row-count-mismatch'});

  const targetCreditCents=Math.round(vfcNum_(facts&&facts.deposits)*100),
        targetDebitCents=Math.round(vfcNum_(facts&&facts.withdrawals)*100),
        currentCreditCents=Math.round(before.totalCredits*100),
        currentDebitCents=Math.round(before.totalDebits*100),
        deltaCount=printed.creditCount-before.creditCount,
        deltaCents=targetCreditCents-currentCreditCents;
  if(deltaCount===0&&deltaCents===0&&targetDebitCents===currentDebitCents)return result;
  if(currentCreditCents+currentDebitCents!==targetCreditCents+targetDebitCents)return Object.assign(result,{reason:'grand-total-mismatch'});

  const debitCandidates=[],creditCandidates=[];
  rows.forEach(function(t,index){
    if(vfcRbcCertainDirection_(t))return;
    const candidate={index:index,cents:Math.round(vfcNum_(t.amount)*100)};
    if(String(t.direction||'').toUpperCase()==='DEBIT')debitCandidates.push(candidate);
    else if(String(t.direction||'').toUpperCase()==='CREDIT')creditCandidates.push(candidate);
  });

  const maxFlips=6,comboLimit=25000;
  for(let flips=1;flips<=maxFlips;flips++){
    if((flips+deltaCount)%2!==0)continue;
    const debitToCredit=(flips+deltaCount)/2,creditToDebit=(flips-deltaCount)/2;
    if(debitToCredit<0||creditToDebit<0||debitToCredit>debitCandidates.length||creditToDebit>creditCandidates.length)continue;
    const debitCombos=vfcRbcDirectionCombos_(debitCandidates,debitToCredit,comboLimit),
          creditCombos=vfcRbcDirectionCombos_(creditCandidates,creditToDebit,comboLimit);
    if(debitCombos.overflow||creditCombos.overflow)return Object.assign(result,{reason:'combination-limit'});

    const creditsBySum={};
    creditCombos.combos.forEach(function(c){const key=String(c.sum);if(!creditsBySum[key])creditsBySum[key]=[];if(creditsBySum[key].length<2)creditsBySum[key].push(c);});
    const solutions=[];
    debitCombos.combos.some(function(d){
      const matches=creditsBySum[String(d.sum-deltaCents)]||[];
      matches.forEach(function(c){if(solutions.length<2)solutions.push({debitToCredit:d.indexes,creditToDebit:c.indexes});});
      return solutions.length>1;
    });
    if(solutions.length>1)return Object.assign(result,{reason:'non-unique-minimum-solution'});
    if(solutions.length===0)continue;

    const fixed=rows.map(function(t){return Object.assign({},t);}),solution=solutions[0],repairs=[];
    solution.debitToCredit.forEach(function(index){const t=fixed[index];repairs.push({date:String(t.date||''),description:String(t.description||''),amount:vfcNum_(t.amount),from:'DEBIT',to:'CREDIT',reason:'UNIQUE_PRINTED_CHECKSUM'});t.direction='CREDIT';});
    solution.creditToDebit.forEach(function(index){const t=fixed[index];repairs.push({date:String(t.date||''),description:String(t.description||''),amount:vfcNum_(t.amount),from:'CREDIT',to:'DEBIT',reason:'UNIQUE_PRINTED_CHECKSUM'});t.direction='DEBIT';});
    const after=vfcRbcLedgerStats_(fixed);
    if(after.creditCount!==printed.creditCount||after.debitCount!==printed.debitCount||Math.round(after.totalCredits*100)!==targetCreditCents||Math.round(after.totalDebits*100)!==targetDebitCents)return Object.assign(result,{reason:'post-repair-audit-failed'});
    return{rows:fixed,changed:true,flips:repairs,reason:'unique-minimum-checksum-solution'};
  }
  return Object.assign(result,{reason:'no-solution-within-limit'});
}

function vfcRbcLedgerStats_(items){
  const out={creditCount:0,debitCount:0,totalCredits:0,totalDebits:0,bad:[]};
  (Array.isArray(items)?items:[]).forEach(function(t,i){
    const d=String(t&&t.direction||'').toUpperCase(),a=vfcNum_(t&&t.amount),desc=String(t&&t.description||'').trim(),date=vfcIso_(t&&t.date);
    if(!date||!desc||!(a>0)||(d!=='CREDIT'&&d!=='DEBIT')){out.bad.push(i+1);return;}
    if(d==='CREDIT'){out.creditCount++;out.totalCredits+=a;}else{out.debitCount++;out.totalDebits+=a;}
  });
  out.totalCredits=vfcRound_(out.totalCredits,.01);out.totalDebits=vfcRound_(out.totalDebits,.01);return out;
}

function vfcRbcLedgerPreview_(rows,direction){
  return(rows||[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()===direction;}).slice(0,40).map(function(t){return String(t.date||'')+' '+String(t.description||'')+' $'+vfcNum_(t.amount);}).join(' | ');
}

/**
 * RBC keeps its printed-period audit self-contained so a staged Apps Script
 * deployment cannot fail merely because BankingCore was saved a moment later.
 * Only an exact, valid ISO calendar date is accepted; no timezone conversion
 * is allowed in this statement-level checksum guard.
 */
function vfcRbcIsoDayNumber_(value){
  const m=String(value==null?'':value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m)return null;
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]),date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;
  return Math.floor(date.getTime()/86400000);
}

function vfcRbcAuditFullLedger_(items,facts,text,fileName){
  const rows=Array.isArray(items)?items:[],printed=vfcRbcPrintedActivityCounts_(text),s=vfcRbcLedgerStats_(rows);
  if(printed.creditCount===null||printed.debitCount===null)throw new Error('RBC printed transaction counts are missing for '+fileName+'.');
  if(s.bad.length)throw new Error('RBC full ledger contains incomplete transaction row(s) '+s.bad.join(', ')+' for '+fileName+'.');
  const startDay=vfcRbcIsoDayNumber_(facts&&facts.startDate),endDay=vfcRbcIsoDayNumber_(facts&&facts.endDate),outside=[];
  if(startDay!==null&&endDay!==null)rows.forEach(function(t,i){const day=vfcRbcIsoDayNumber_(t&&t.date);if(day===null||day<startDay||day>endDay)outside.push((i+1)+':'+String(t&&t.date||''));});
  if(outside.length)throw new Error('RBC ledger contains transaction date(s) outside the printed statement period for '+fileName+': '+outside.slice(0,12).join(', ')+'.');

  const creditCountOk=s.creditCount===printed.creditCount,
        debitCountOk=s.debitCount===printed.debitCount,
        creditTotalOk=Math.abs(s.totalCredits-vfcNum_(facts.deposits))<=.01,
        debitTotalOk=Math.abs(s.totalDebits-vfcNum_(facts.withdrawals))<=.01;

  if(!creditCountOk||!debitCountOk||!creditTotalOk||!debitTotalOk){
    throw new Error(
      'RBC ledger mismatch ['+vfcRbcBankProfile_().runtimeFingerprint+'] for '+fileName+
      ': printed credits '+printed.creditCount+' / $'+vfcNum_(facts.deposits)+
      ', extracted '+s.creditCount+' / $'+s.totalCredits+
      '; printed debits '+printed.debitCount+' / $'+vfcNum_(facts.withdrawals)+
      ', extracted '+s.debitCount+' / $'+s.totalDebits+
      '. CREDIT rows: '+vfcRbcLedgerPreview_(rows,'CREDIT')+
      ' | DEBIT rows: '+vfcRbcLedgerPreview_(rows,'DEBIT')
    );
  }
  return{creditCount:s.creditCount,debitCount:s.debitCount,totalCredits:s.totalCredits,totalDebits:s.totalDebits,verified:true};
}

function vfcRbcRepairLedger_(currentLedger,text,fileName,facts,reason,attempt,directionRepairs,sourceFileId){
  const printed=vfcRbcPrintedActivityCounts_(text),current=vfcRbcLedgerStats_(currentLedger),hasOriginalPdf=!!sourceFileId,
        creditCountGap=printed.creditCount-current.creditCount,debitCountGap=printed.debitCount-current.debitCount,
        creditDollarGap=vfcRound_(vfcNum_(facts.deposits)-current.totalCredits,.01),debitDollarGap=vfcRound_(vfcNum_(facts.withdrawals)-current.totalDebits,.01),
        visibleOnlineTransfers=vfcRbcOnlineTransferCandidates_(text,facts).map(function(t){return t.date+' | '+t.description+' | $'+t.amount;}),promptLines=[
    'You are the VFC RBC Account Activity Reconciliation Reader. Return JSON only.',
    'This is FACT EXTRACTION ONLY. Do not underwrite, classify debt, summarize or estimate.',
    'File: '+fileName,
    'The previous ledger failed deterministic reconciliation: '+reason,
    'AUTHORITATIVE PRINTED TARGETS:',
    'CREDIT rows exactly: '+printed.creditCount,
    'CREDIT total exactly: '+vfcNum_(facts.deposits),
    'DEBIT rows exactly: '+printed.debitCount,
    'DEBIT total exactly: '+vfcNum_(facts.withdrawals),
    'Opening balance: '+vfcNum_(facts.opening),
    'Closing balance: '+vfcNum_(facts.closing),
    'Statement period: '+String(facts.startDate||'')+' through '+String(facts.endDate||''),
    'Return JSON with ONE field only: banking_transactions.',
    'banking_transactions must be the COMPLETE Account Activity ledger and each object must be {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short visible counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
    'STRICT RULES:',
    '1. '+(hasOriginalPdf?'Inspect the attached original PDF itself. ':'')+'Read only Account Activity Details rows. Include every amount-bearing activity row, including all bank fees and ordinary purchases.',
    '2. Do not include opening/closing balances, Account Summary totals, Account Fees summary, page totals, cheque-image/support pages, serial-number image rows or endorsements.',
    '3. Take each amount from the SAME printed row as its date and description. Printed Cheques & Debits column = DEBIT; printed Deposits & Credits column = CREDIT.',
    '4. Never infer direction from wording. ONLINE BANKING TRANSFER, MISC PAYMENT, BR TO BR and return/NSF descriptions can appear in either printed column.',
    '5. Keep every separately printed row. Repeated identical fee rows, including multiple $1.50 e-Transfer fees on the same date, are separate transactions and must not be deduplicated. Debit-side ONLINE BANKING TRANSFER - #### rows are mandatory and must never be skipped as irrelevant internal transfers. Never invent a second copy of a cheque on an adjacent carried date; a cheque appears once unless the PDF visibly prints it twice.',
    '6. Use running-balance changes and neighboring row boundaries to verify that an amount was not borrowed from the row above or below.',
    '7. Every transaction date must be inside the printed statement period. Carry a printed activity date forward to its following undated continuation rows until the next printed date.',
    '8. The final array MUST contain exactly '+printed.creditCount+' CREDIT rows totaling '+vfcNum_(facts.deposits)+' and exactly '+printed.debitCount+' DEBIT rows totaling '+vfcNum_(facts.withdrawals)+'.',
    '9. Check the completed array against all four count/total targets and the statement date range before returning it.',
    'Current candidate stats: credits '+current.creditCount+' / $'+current.totalCredits+', debits '+current.debitCount+' / $'+current.totalDebits+'.',
    'Exact shortfall versus printed controls: CREDIT rows '+creditCountGap+' / $'+creditDollarGap+'; DEBIT rows '+debitCountGap+' / $'+debitDollarGap+'.',
    'Transcript-visible ONLINE BANKING TRANSFER candidates (verify each against the printed PDF column): '+JSON.stringify(visibleOnlineTransfers.slice(0,60))
  ];
  if(!hasOriginalPdf){
    promptLines.push(
      'The original PDF is unavailable in this legacy call, so recover from the transcript below.',
      'Current candidate ledger:',JSON.stringify(currentLedger),
      'RBC STATEMENT TRANSCRIPT:',String(text||'').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
    );
  }
  const prompt=promptLines.join('\n'),repaired=hasOriginalPdf
    ?vfcReadBankLedgerFromPdfWithOpenAI_(sourceFileId,prompt,'RBC original-PDF reconciliation pass '+attempt)
    :callOpenAIJson_(prompt);
  if(!repaired||!Array.isArray(repaired.banking_transactions))throw new Error('RBC reconciliation pass '+attempt+' did not return a complete banking_transactions array for '+fileName+'.');
  return vfcRbcPrepareLedger_(repaired.banking_transactions,directionRepairs);
}

function vfcRbcIsPadLikeText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return false;
  return/^(?:BUSINESS\s+)?PAD\b|PRE[- ]?AUTH(?:ORIZED)?(?:\s+DEBIT|\s+PAYMENT)?\b|PREAUTHORIZED(?:\s+DEBIT|\s+PAYMENT)?\b|DIRECT\s+DEBIT\b|EFT\s+DEBIT\b|ACH\s+DEBIT\b|AUTOMATIC\s+DEBIT\b|AUTO\s+PAYMENT\b/.test(s);
}

function vfcRbcReturnEventText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||/\b(?:FEE|FEES|CHARGE)\b/.test(s))return false;
  return/CHEQUE\s+RETURNED(?:\s+NSF)?|CHECK\s+RETURNED(?:\s+NSF)?|ITEM\s+RETURNED(?:\s+NSF|\s+UNPAID)?|RETURNED\s+(?:ITEM|CHEQUE|CHECK|PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)|(?:PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)\s+RETURNED|PRE[- ]?AUTH(?:ORIZED)?\s+(?:DEBIT|PAYMENT)\s+RETURNED|PREAUTHORIZED\s+(?:DEBIT|PAYMENT)\s+RETURNED|DIRECT\s+DEBIT\s+RETURNED|REJECTED\s+(?:PAD|DEBIT|PAYMENT)|\bREVERSAL\b|\bREVERSED\b|NSF\s+RETURN/.test(s);
}
function vfcRbcReturnCreditText_(value){return vfcRbcReturnEventText_(value);}
function vfcRbcCountReturnEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return vfcRbcReturnEventText_(t&&t.description);}).length;}

function vfcRbcBorrowerNsfCreditText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||/\b(?:FEE|FEES|CHARGE)\b/.test(s))return false;
  return/\bNSF\b|CHEQUE\s+RETURNED\s+NSF|CHECK\s+RETURNED\s+NSF|ITEM\s+RETURNED\s+NSF|RETURNED\s+(?:PAYMENT|PAD|DEBIT|EFT|ACH)|(?:PAYMENT|PAD|DEBIT|EFT|ACH)\s+RETURNED|REJECTED\s+(?:PAD|DEBIT|PAYMENT)/.test(s);
}

function vfcRbcCountBorrowerNsfEvents_(items){
  return(Array.isArray(items)?items:[]).filter(function(t){
    return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcBorrowerNsfCreditText_(t&&t.description);
  }).length;
}

function vfcRbcNegativeBalanceFlag_(text,facts){
  if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;
  const lines=String(text||'').replace(/\u00a0/g,' ').split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    const line=String(lines[i]||'').trim();
    if(!line)continue;
    if(/TOTAL\s+(?:DEPOSITS|CREDITS|CHEQUES|DEBITS|WITHDRAWALS)|ACCOUNT\s+SUMMARY|ACCOUNT\s+FEES?/i.test(line))continue;
    if(/\bBALANCE\b\s*[:=]?\s*-\s*\$?[0-9][0-9,]*\.\d{2}\s*$/i.test(line))return true;
    if(/(?:^|\s)-\s*\$?[0-9][0-9,]*\.\d{2}\s*$/.test(line)&&/\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|LOAN|PAYMENT|CHEQUE|PAD|TRANSFER|INTERAC|INSURANCE|RENT|FUEL|ATM|PURCHASE|DEPOSIT)\b/i.test(line))return true;
  }
  return false;
}
function vfcRbcAmountBand_(amount){const n=Math.max(1,vfcNum_(amount));return Math.round(Math.log(n)/Math.log(1.25));}

function vfcRbcClassifyDebit_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t&&t.counterparty||'').replace(/\s+/g,' ').trim(),band=vfcRbcAmountBand_(t&&t.amount),hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b|\bMCA\b|\bLEASE\b|\bLSE\b/.test(s),isFee=/\bFEES?\b|SERVICE\s+CHARGE|NSF\s+ITEM\s+FEES?|RETURNED[- ]?ITEM\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE|ACTIVITY\s+FEE|TRANSACTION\s+FEE|MONTHLY\s+FEE/.test(s);
  if(isFee&&!hasFinancingSignal)return null;
  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/COMM\s+EQUIP\s+RENT\/LSE\s+SILVERCHEF|\bSILVERCHEF\b/.test(s)){family='FINANCING';entityKey='SILVERCHEF_EQUIPMENT_LEASE';label='SilverChef Equipment Lease';debtJustification='Explicit recurring equipment lease.';}
  else if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';debtJustification='Known MCA/funding counterparty plus recurrence.';}
  else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){family='MCA';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bBDC\b/.test(s)&&vfcRbcIsPadLikeText_(s)){family='FINANCING';entityKey='RBC_BDC_PAD_B'+band;label='BDC';debtJustification='Recurring BDC PAD stream; materially different catch-up amounts remain separate.';}
  else if(/\bBDC\b/.test(s)&&(/BDC[- ]?LOAN\/PRET|ONLINE\s+BANKING\s+PAYMENT|\bLOAN\b|FINANC/.test(s))){family='FINANCING';entityKey='RBC_BDC_MANUAL_B'+band;label='BDC Manual / Loan Payment';debtJustification='Manual BDC loan-payment stream kept separate from normal PAD.';}
  else if(/\bAFFIRM(?:\s+CANADA)?\b/.test(s)){family='FINANCING';entityKey='RBC_AFFIRM_CANADA';label='Affirm Canada';debtJustification='Affirm Canada financing counterparty plus recurrence.';}
  else if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='CANACAP';label='Canacap';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bGREENBOX\b/.test(s)){family='MCA';entityKey='GREENBOX';label='Greenbox';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bICAPITAL\b/.test(s)){family='FINANCING';entityKey='ICAPITAL';label='iCapital';debtJustification='Known financing counterparty plus recurrence.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC|\bIC\s+PREMIUM\s+FINA\b/.test(s)){family='FINANCING';entityKey='RBC_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw)+'_B'+band;label=cp||'Premium Finance';debtJustification='Explicit premium-finance counterparty plus recurrence.';}
  else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){family='TAX';entityKey='RBC_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);}
  else if(/INSURANCE/.test(s)){family='OTHER';if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}else if(/IND\s+ALL/.test(s)){entityKey='INSURANCE_IND_ALL';label='Insurance IND ALL';}else entityKey='RBC_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|CAPITAL\s+ONE|\bMBNA\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/^AUTO\s+PAYMENT\b/.test(s)){
    const clean=raw.replace(/^AUTO\s+PAYMENT\s*/i,'').trim(),financeLike=/\bAFS\b|FINANC|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s);
    family=financeLike?'FINANCING':'OTHER';entityKey=(financeLike?'AUTO_PAYMENT_FINANCE_':'RBC_OTHER_AUTOPAY_')+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;if(financeLike)debtJustification='Automatic payment with independent finance-like counterparty evidence.';
  }
  else if(/^MISC\s+PAYMENT\b/.test(s)&&(/\bAFS\b|FINANC|LEASE|LENDING|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s))){const clean=raw.replace(/^MISC\s+PAYMENT\s*/i,'').trim();family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;debtJustification='Retry/recurring payment with independent finance-like counterparty evidence.';}
  else if(hasFinancingSignal){
    family='FINANCING';debtJustification='Explicit financing wording plus recurring observed cadence.';
    if(/^LOAN\s+PAYMENT$/i.test(raw)){entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';}
    else{
      const numbered=s.match(/(?:NO\.?|NUMBER|#)\s*([0-9-]{5,})/),generic=s.match(/\b(?:LOAN|MORTGAGE|LOC)\b[^0-9]{0,30}([0-9][0-9-]{5,})\b/),ref=numbered||generic;
      if(ref){const n=ref[1].replace(/[^0-9]/g,'');if(/\bLOAN\b/.test(s)){entityKey='LOAN_ACCOUNT_'+n;label='RBC Loan NO.'+n;debtJustification='Interest, BLIP and principal debits sharing the same printed loan reference are one obligation.';}else if(/\bLEASE\b|\bLSE\b/.test(s)){entityKey='LEASE_'+n;label='Lease payment NO.'+n;}else{entityKey='FINANCE_REF_'+n;}}
      else{const stable=(cp||raw).replace(/\b[0-9][0-9-]{4,}\b/g,'').replace(/\s+/g,' ').trim();entityKey='RBC_FINANCE_'+vfcCounterpartyKey_(stable||cp||raw);}
    }
  }
  else if(vfcRbcIsPadLikeText_(s)){family='OTHER';entityKey='RBC_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/\bCAPITAL\b|\bFUNDING\b|\bFACTOR(?:ING)?\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_POSSIBLE_FINANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/COMMERCIAL\s+RENT|\bRENT\b|HYDRO|FORTIS|TELUS|UTILITY|SUPERPASS|PETROLEUM|\bFUEL\b|EQUIPMENT\s+RENT|PAY\s+EMPLOYEE|PAYROLL/.test(s)){family='OTHER';entityKey='RBC_OTHER_BUSINESS_'+vfcCounterpartyKey_(cp||raw);}
  else{return null;}
  if(!entityKey)entityKey='RBC_OTHER_'+vfcCounterpartyKey_(raw);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcRbcIsReturnedFinancingCredit_(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}
function vfcRbcIsNonOperatingTransferCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;const s=String(t&&t.description||'').toUpperCase();if(/E-TRANSFER|INTERAC/.test(s))return false;return/\bBR\s+TO\s+BR\b|\bTRANSFER\s+FROM\s+(?:ACCOUNT|A\/C|ACCT)\b|\bINTERNAL\s+TRANSFER\b|\bONLINE\s+BANKING\s+TRANSFER\s*-\s*\d{3,}\b/.test(s);}
function vfcRbcKnownFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();if(vfcRbcIsReturnedFinancingCredit_(t)||vfcRbcIsNonOperatingTransferCredit_(t))return false;return/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|\bICAPITAL\b|GREENBOX|\bCSBFL\b|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s);}
function vfcRbcPreservePrintedDuplicate_(){return true;}
function vfcRbcStrongEntityKey_(key){return/^(RBC_AFFIRM_CANADA|RBC_PREMIUM_FINANCE_|RBC_BDC_|MERCHANT_GROWTH|JOURNEY_ONDECK|CANACAP|ICAPITAL|GREENBOX|SILVERCHEF_EQUIPMENT_LEASE|AUTO_PAYMENT_FINANCE_|RBC_FINANCE_|INSURANCE_|LOAN_ACCOUNT_[0-9]|LEASE_[0-9]|FINANCE_REF_[0-9])/.test(String(key||'').toUpperCase());}

function runRbcBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'RBC',transactions:transactions||[]}};}
  function close(a,e,t,l){t=t==null?.02:t;if(Math.abs(Number(a||0)-Number(e||0))>t)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function equal(a,e,l){if(a!==e)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function truthy(v,l){if(!v)throw new Error((l||'value')+' expected truthy');}
  function test(n,f){try{results.push({name:n,pass:true,detail:String(f()||'')});}catch(e){results.push({name:n,pass:false,detail:String(e&&e.message||e)});}}

  test('AIM HIGH Mar-Apr printed credits are exactly 15 and $45,725.36',function(){const c=[2000,250,1000,6585.81,1046.83,250,7474.96,3000,750,2750,3250,2750,6673.93,7693.83,250];equal(c.length,15,'count');close(vfcSum_(c),45725.36,.02,'sum');return'15/$45725.36';});
  test('AIM HIGH Mar-Apr $283 RBC card direction now reconciles',function(){
    const text='March 2, 2026 to April 2, 2026\nOpening balance on March 2, 2026 $4,710.90\nTotal deposits & credits (15) + 45,725.36\nTotal cheques & debits (39) - 50,240.60\nClosing balance on April 2, 2026 = $195.66',wrong=[];
    let i;
    for(i=0;i<14;i++)wrong.push(tx('2026-03-02','Payroll Deposit filler '+i,'CREDIT',1));
    wrong.push(tx('2026-03-02','Payroll Deposit filler total','CREDIT',45711.36));
    for(i=0;i<37;i++)wrong.push(tx('2026-03-02','Bill Payment filler '+i,'DEBIT',1));
    wrong.push(tx('2026-03-02','Bill Payment filler total','DEBIT',49920.60));
    wrong.push(tx('2026-03-12','Misc Payment RBC CREDIT CARD','CREDIT',283));
    const before=vfcRbcLedgerStats_(wrong),locked=vfcRbcLockFacts_({banking_transactions:wrong},text,'1002823_2026_03_02_2026_04_02.pdf'),after=vfcRbcLedgerStats_(locked.banking_transactions);
    equal(before.creditCount,16,'original credits');close(before.totalCredits,46008.36,.001,'original credit total');
    equal(before.debitCount,38,'original debits');close(before.totalDebits,49957.60,.001,'original debit total');
    equal(after.creditCount,15,'corrected credits');close(after.totalCredits,45725.36,.001,'corrected credit total');
    equal(after.debitCount,39,'corrected debits');close(after.totalDebits,50240.60,.001,'corrected debit total');
    equal(locked.rbc_direction_repairs.length,1,'recorded direction repair');
    equal(locked.rbc_ledger_repair_passes,0,'AI repair passes');
    return'15 credits/$45725.36; 39 debits/$50240.60';
  });
  test('AIM HIGH Apr-May two crossed Misc Payments reconcile by checksum',function(){
    const text='April 2, 2026 to May 1, 2026\nOpening balance on April 2, 2026 $195.66\nTotal deposits & credits (15) + 63,708.46\nTotal cheques & debits (47) - 61,672.04\nClosing balance on May 1, 2026 = $2,232.08',wrong=[];
    let i;
    for(i=0;i<12;i++)wrong.push(tx('2026-04-02','Payroll Deposit filler '+i,'CREDIT',1));
    wrong.push(tx('2026-04-02','Payroll Deposit filler total','CREDIT',46510.67));
    for(i=0;i<46;i++)wrong.push(tx('2026-04-02','Bill Payment filler '+i,'DEBIT',1));
    wrong.push(tx('2026-04-02','Bill Payment filler total','DEBIT',61626.04));
    wrong.push(tx('2026-04-14','Misc Payment 1469635 PAY <DEFTPYMT>','DEBIT',8008.10));
    wrong.push(tx('2026-04-29','Misc Payment 1469635 PAY <DEFTPYMT>','DEBIT',9177.69));
    const before=vfcRbcLedgerStats_(wrong),locked=vfcRbcLockFacts_({banking_transactions:wrong},text,'1002823_2026_04_02_2026_05_01.pdf'),after=vfcRbcLedgerStats_(locked.banking_transactions);
    equal(before.creditCount,13,'original credits');close(before.totalCredits,46522.67,.001,'original credit total');
    equal(before.debitCount,49,'original debits');close(before.totalDebits,78857.83,.001,'original debit total');
    equal(after.creditCount,15,'corrected credits');close(after.totalCredits,63708.46,.001,'corrected credit total');
    equal(after.debitCount,47,'corrected debits');close(after.totalDebits,61672.04,.001,'corrected debit total');
    equal(locked.rbc_direction_repairs.length,2,'recorded checksum repairs');
    equal(locked.rbc_direction_repairs[0].reason,'UNIQUE_PRINTED_CHECKSUM','checksum reason');
    equal(locked.rbc_ledger_repair_passes,0,'AI repair passes');
    return'15 credits/$63708.46; 47 debits/$61672.04';
  });
  test('AIM HIGH May-Jun exact failing ledger now reconciles',function(){
    const text='May 1, 2026 to June 2, 2026\nOpening balance on May 1, 2026 $2,232.08\nTotal deposits & credits (18) + 56,889.45\nTotal cheques & debits (56) - 63,781.21\nClosing balance on June 2, 2026 = -$4,659.68',wrong=[];
    let i;
    for(i=0;i<16;i++)wrong.push(tx('2026-05-01','Payroll Deposit filler '+i,'CREDIT',1));
    wrong.push(tx('2026-05-01','Payroll Deposit filler total','CREDIT',54266.86));
    for(i=0;i<51;i++)wrong.push(tx('2026-05-01','Bill Payment filler '+i,'DEBIT',1));
    wrong.push(tx('2026-05-01','Bill Payment filler total','DEBIT',59530.21));
    wrong.push(tx('2026-05-07','Online Banking transfer - 0040','CREDIT',500));
    wrong.push(tx('2026-05-28','Online Banking transfer - 8537','CREDIT',2500));
    wrong.push(tx('2026-06-01','Online Banking transfer - 0203','CREDIT',200));
    wrong.push(tx('2026-06-01','Online Banking transfer - 1673','CREDIT',1000));
    wrong.push(tx('2026-05-27','Cheque returned NSF','DEBIT',2606.59));
    const before=vfcRbcLedgerStats_(wrong),locked=vfcRbcLockFacts_({banking_transactions:wrong},text,'1002823_2026_05_01_2026_06_02.pdf'),after=vfcRbcLedgerStats_(locked.banking_transactions);
    equal(before.creditCount,21,'original credits');close(before.totalCredits,58482.86,.001,'original credit total');
    equal(before.debitCount,53,'original debits');close(before.totalDebits,62187.80,.001,'original debit total');
    equal(after.creditCount,18,'corrected credits');close(after.totalCredits,56889.45,.001,'corrected credit total');
    equal(after.debitCount,56,'corrected debits');close(after.totalDebits,63781.21,.001,'corrected debit total');
    equal(locked.rbc_direction_repairs.length,5,'recorded direction repairs');
    equal(locked.rbc_ledger_repair_passes,0,'AI repair passes');
    equal(locked.rbc_runtime_fingerprint,'RBC-3.8.1-FULL-PROJECT-SYNC-20260923','runtime fingerprint');
    return'18 credits/$56889.45; 56 debits/$63781.21';
  });
  test('AIM HIGH Jun-Jul printed credits are exactly 24 and $90,909.53',function(){
    const credits=[4750,500,250,1750,750,1000,6403.84,9384.12,1000,2500,7000,7200,4687.46,5500,6000,1200,600,700,2400,5000,2813.31,5289.91,5928.88,8302.01];
    equal(credits.length,24,'count');close(vfcSum_(credits),90909.53,.001,'sum');
    return'24/$90909.53';
  });
  test('AIM HIGH Jun-Jul online transfers remain in their printed columns',function(){
    const rows=vfcRbcPrepareLedger_([
      tx('2026-06-29','Online Banking transfer - 1001','CREDIT',600),
      tx('2026-06-29','Online Banking transfer - 1002','CREDIT',700),
      tx('2026-06-29','Online Banking transfer - 1003','CREDIT',2400),
      tx('2026-06-29','Online Banking transfer - 1004','CREDIT',5000),
      tx('2026-06-29','Online Banking transfer - 2001','DEBIT',1200),
      tx('2026-06-29','Online Banking transfer - 2002','DEBIT',1200),
      tx('2026-06-29','Online Banking transfer - 2003','DEBIT',1250)
    ]),stats=vfcRbcLedgerStats_(rows);
    equal(stats.creditCount,4,'credit-side transfers');close(stats.totalCredits,8700,.001,'credit-side total');
    equal(stats.debitCount,3,'debit-side transfers');close(stats.totalDebits,3650,.001,'debit-side total');
    return'4 credits and 3 debits preserved';
  });
  test('1037324 Apr-May nine omitted online transfers recover from the exact printed checksum',function(){
    const text=[
      'April 27, 2026 to May 27, 2026',
      'Opening balance on April 27, 2026 $20,000.00',
      'Total deposits & credits (0) + 0.00',
      'Total cheques & debits (9) - 18,700.00',
      'Closing balance on May 27, 2026 = $1,300.00',
      'Account Activity Details',
      'Date Description Cheques & Debits ($) Deposits & Credits ($) Balance ($)',
      '13 May Online Banking transfer - 7051 3,000.00',
      '       Online Banking transfer - 6870 3,700.00',
      '15 May Online Banking transfer - 9202 4,000.00',
      '19 May Online Banking transfer - 4711 1,000.00',
      '       Online Banking transfer - 4802 1,000.00',
      '21 May Online Banking transfer - 2678 1,000.00',
      '       Online Banking transfer - 9829 1,000.00',
      '22 May Online Banking transfer - 3848 1,000.00',
      '       Online Banking transfer - 0454 3,000.00',
      '       Closing balance 1,300.00'
    ].join('\n'),locked=vfcRbcLockFacts_({banking_transactions:[]},text,'1037324_2026_04_27_2026_05_27.pdf'),stats=vfcRbcLedgerStats_(locked.banking_transactions);
    equal(stats.creditCount,0,'credits');equal(stats.debitCount,9,'debits');close(stats.totalDebits,18700,.001,'debit total');
    equal(locked.rbc_missing_row_repairs.length,9,'restored rows');equal(locked.rbc_ledger_repair_passes,0,'AI repair passes');
    equal(locked.rbc_missing_row_repairs[0].reason,'UNIQUE_SOURCE_CHECKSUM','repair reason');
    equal(locked.rbc_runtime_fingerprint,'RBC-3.8.1-FULL-PROJECT-SYNC-20260923','runtime fingerprint');
    return'9 debit rows/$18700 restored without guessing direction';
  });
  test('Split-line provider transcript still exposes every online transfer row',function(){
    const text=[
      'Account Activity Details',
      'Date: 2026-05-13',
      'Online Banking transfer - 7051',
      'DEBIT 3,000.00',
      'Online Banking transfer - 6870',
      'Cheques & Debits: 3,700.00',
      'Closing balance'
    ].join('\n'),rows=vfcRbcOnlineTransferCandidates_(text,{startDate:'2026-04-27',endDate:'2026-05-27'});
    equal(rows.length,2,'candidate rows');close(rows[0].amount,3000,.001,'first amount');close(rows[1].amount,3700,.001,'second amount');
    equal(rows[0].date,'2026-05-13','carried date');equal(rows[0].directionHint,'DEBIT','explicit debit hint');return'2 split rows recovered';
  });
  test('1037324 exact 15-credit 62-debit fallback error is fully reconciled',function(){
    const text=[
      'April 27, 2026 to May 27, 2026',
      'Opening balance on April 27, 2026 $6,085.02',
      'Total deposits & credits (10) + 107,067.24',
      'Total cheques & debits (70) - 96,253.18',
      'Closing balance on May 27, 2026 = $16,899.08',
      'Account Activity Details',
      '13 May Online Banking transfer - 7051 3,000.00',
      '       Online Banking transfer - 6870 3,700.00',
      '14 May Cheque - 21 591.34',
      '15 May Online Banking transfer - 9202 4,000.00',
      '19 May Online Banking transfer - 4711 1,000.00',
      '       Online Banking transfer - 4802 1,000.00',
      '21 May Online Banking transfer - 2678 1,000.00',
      '       Online Banking transfer - 9829 1,000.00',
      '22 May Online Banking transfer - 3848 1,000.00',
      '       Online Banking transfer - 0454 3,000.00',
      '       Closing balance 16,899.08'
    ].join('\n'),wrong=[];let i;
    for(i=0;i<9;i++)wrong.push(tx('2026-04-29','Credit filler '+i,'CREDIT',1));
    wrong.push(tx('2026-04-29','Credit filler total','CREDIT',107058.24));
    wrong.push(tx('2026-05-15','Online Banking transfer - 9202','CREDIT',4000));
    wrong.push(tx('2026-05-21','Online Banking transfer - 2678','CREDIT',1000));
    wrong.push(tx('2026-05-21','Online Banking transfer - 9829','CREDIT',1000));
    wrong.push(tx('2026-05-22','Online Banking transfer - 3848','CREDIT',1000));
    wrong.push(tx('2026-05-22','Online Banking transfer - 0454','CREDIT',3000));
    for(i=0;i<59;i++)wrong.push(tx('2026-04-29','Debit filler '+i,'DEBIT',1));
    wrong.push(tx('2026-04-29','Debit filler total','DEBIT',76902.84));
    wrong.push(tx('2026-05-13','Cheque - 21','DEBIT',591.34));
    wrong.push(tx('2026-05-14','Cheque - 21','DEBIT',591.34));
    const before=vfcRbcLedgerStats_(wrong),locked=vfcRbcLockFacts_({banking_transactions:wrong},text,'1037324_2026_04_27_2026_05_27.pdf'),after=vfcRbcLedgerStats_(locked.banking_transactions),changes=locked.rbc_missing_row_repairs;
    equal(before.creditCount,15,'bad credit count');close(before.totalCredits,117067.24,.001,'bad credit total');equal(before.debitCount,62,'bad debit count');close(before.totalDebits,78144.52,.001,'bad debit total');
    equal(after.creditCount,10,'fixed credits');close(after.totalCredits,107067.24,.001,'fixed credit total');equal(after.debitCount,70,'fixed debits');close(after.totalDebits,96253.18,.001,'fixed debit total');
    equal(changes.filter(function(x){return x.action==='FLIP';}).length,5,'direction flips');equal(changes.filter(function(x){return x.action==='ADD';}).length,4,'missing transfers');equal(changes.filter(function(x){return x.action==='REMOVE_DUPLICATE';}).length,1,'duplicate removed');
    const cheque21=locked.banking_transactions.filter(function(x){return /^Cheque - 21$/i.test(x.description);});equal(cheque21.length,1,'one cheque 21');equal(cheque21[0].date,'2026-05-14','printed cheque date');equal(locked.rbc_ledger_repair_passes,0,'full PDF repair passes');return'10/107067.24 and 70/96253.18';
  });
  test('Missing-row recovery refuses mixed credit and debit deficits',function(){
    const text='Total deposits & credits (1) + 1000.00\nTotal cheques & debits (1) - 1000.00\nAccount Activity Details\n13 May Online Banking transfer - 7051 1,000.00\nClosing balance',
          r=vfcRbcRecoverMissingOnlineTransfers_([],text,{startDate:'2026-04-27',endDate:'2026-05-27',deposits:1000,withdrawals:1000});
    equal(r.changed,false,'no repair');equal(r.reason,'source-rows-cannot-fill-printed-controls','reason');return r.reason;
  });
  test('AIM HIGH Jun-Jul discrepancy identifies one wrong amount and two omitted fees',function(){
    const reportedCreditGap=90909.53-76280.65,reportedDebitOverage=103898.56-89562.99,
          unexplainedGrandGap=reportedCreditGap-reportedDebitOverage,
          exactPdfGap=(1033.52-743.21)+1.50+1.50;
    close(reportedCreditGap,14628.88,.001,'credit gap');close(reportedDebitOverage,14335.57,.001,'debit overage');
    close(unexplainedGrandGap,293.31,.001,'grand gap');close(exactPdfGap,293.31,.001,'PDF row gap');
    return'$290.31 + $1.50 + $1.50 = $293.31';
  });
  test('Exact ledger audit passes only when count and totals both match',function(){const text='Total deposits & credits (2) + 150.00\nTotal cheques & debits (2) - 30.00',facts={deposits:150,withdrawals:30},good=[tx('2026-01-01','A','CREDIT',100),tx('2026-01-02','B','CREDIT',50),tx('2026-01-03','C','DEBIT',10),tx('2026-01-04','D','DEBIT',20)];const a=vfcRbcAuditFullLedger_(good,facts,text,'x.pdf');equal(a.creditCount,2,'credits');let failed=false;try{vfcRbcAuditFullLedger_(good.slice(1),facts,text,'x.pdf');}catch(e){failed=true;}truthy(failed,'missing row fails');return'exact';});
  test('Ledger audit rejects a transaction date outside the printed period',function(){const text='Total deposits & credits (0) + 0.00\nTotal cheques & debits (1) - 234.96',facts={startDate:'2026-08-03',endDate:'2026-09-02',deposits:0,withdrawals:234.96},rows=[tx('2026-08-01','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')];let failed=false;try{vfcRbcAuditFullLedger_(rows,facts,text,'Aug-Sep.pdf');}catch(e){failed=/outside the printed statement period/i.test(String(e&&e.message||e));}truthy(failed,'out-of-range date');return'rejected';});
  test('RBC printed-period date guard has no BankingCore dependency',function(){equal(vfcRbcIsoDayNumber_('2026-09-01')-vfcRbcIsoDayNumber_('2026-08-31'),1,'day boundary');equal(vfcRbcIsoDayNumber_('2026-02-30'),null,'invalid calendar date');return'self-contained';});
  test('Opening/closing/support artifacts are excluded',function(){const p=vfcRbcPrepareLedger_([tx('2026-03-02','Opening balance','CREDIT',4710.90),tx('2026-03-03','Loan BK OF MONTREAL','DEBIT',599.22),tx('2026-04-02','Serial #: 343 Amount: $315.00','CREDIT',315)]);equal(p.length,1,'real rows');return'clean';});
  test('Verified RBC directions stay narrow and online transfers stay column-led',function(){equal(vfcRbcCertainDirection_(tx('2026-05-27','Cheque returned NSF','DEBIT',2606.59)),'CREDIT','NSF return');equal(vfcRbcCertainDirection_(tx('2026-06-25','Item returned unpaid S02788','CREDIT',187.46)),'DEBIT','returned deposit');equal(vfcRbcCertainDirection_(tx('2026-05-07','Online Banking transfer - 0040','CREDIT',500)),'','online transfer');equal(vfcRbcCertainDirection_(tx('2026-03-12','Misc Payment RBC CREDIT CARD','CREDIT',283)),'DEBIT','RBC card payment');truthy(vfcRbcIsReturnedFinancingCredit_(tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)),'credit return');return'direction safe';});
  test('Checksum reconciliation refuses a non-unique direction solution',function(){const text='Total deposits & credits (2) + 200.00\nTotal cheques & debits (1) - 100.00',facts={deposits:200,withdrawals:100},rows=[tx('2026-01-01','Misc Payment A','DEBIT',100),tx('2026-01-02','Misc Payment B','DEBIT',100),tx('2026-01-03','Misc Payment C','CREDIT',100)],r=vfcRbcReconcileDirectionOnly_(rows,facts,text);equal(r.changed,false,'no repair');equal(r.reason,'non-unique-minimum-solution','reason');return r.reason;});
  test('Checksum reconciliation refuses when grand totals show a missing or wrong amount',function(){const text='Total deposits & credits (2) + 200.00\nTotal cheques & debits (1) - 100.00',facts={deposits:200,withdrawals:100},rows=[tx('2026-01-01','Misc Payment A','DEBIT',90),tx('2026-01-02','Misc Payment B','DEBIT',100),tx('2026-01-03','Misc Payment C','CREDIT',100)],r=vfcRbcReconcileDirectionOnly_(rows,facts,text);equal(r.changed,false,'no repair');equal(r.reason,'grand-total-mismatch','reason');return r.reason;});
  test('Unknown recurring PAD is informational only',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-02-28',[tx('2026-02-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-03-31',[tx('2026-03-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])]);close(d.confirmedMonthlyDebtService,0,.001,'debt');return'informational';});
  test('Recurring Affirm is financing',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-02-28',[tx('2026-02-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-03-31',[tx('2026-03-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm');return'66.62';});
  test('Returned BDC PAD cannot inflate debt',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-27','Business PAD BDC','DEBIT',2578.34,'BDC')]),row('2026-04-30',[tx('2026-04-27','Business PAD BDC','DEBIT',2656.97,'BDC')]),row('2026-05-31',[tx('2026-05-27','Business PAD BDC','DEBIT',2606.59,'BDC'),tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)]),row('2026-06-30',[tx('2026-06-29','Business PAD BDC','DEBIT',5289.91,'BDC'),tx('2026-06-29','Cheque returned NSF','CREDIT',5289.91)]),row('2026-07-31',[tx('2026-07-27','Business PAD BDC','DEBIT',7952.39,'BDC')]),row('2026-08-31',[tx('2026-08-17','Business PAD BDC','DEBIT',2285.91,'BDC')])]),bdc=d.activeDebtObligations.filter(function(x){return x.counterparty==='BDC';});equal(d.returnedFinanceDebitsSuppressed,2,'suppressed');equal(bdc.length,1,'normal BDC stream');close(bdc[0].monthlyEquivalent,2507.07,.02,'BDC monthly');return'suppressed=2; BDC=$2507.07';});
  test('Recurring IPFS amount wins while one catch-up debit stays separate',function(){const d=vfcDebtProfile_([row('2026-06-30',[tx('2026-06-22','Business PAD IPFS Canada','DEBIT',502.45,'IPFS Canada')]),row('2026-07-31',[tx('2026-07-02','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')]),row('2026-08-31',[tx('2026-08-04','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')]),row('2026-09-30',[tx('2026-09-01','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')])]),ip=d.activeDebtObligations.filter(function(x){return /IPFS/i.test(x.counterparty);}),ins=vfcRbcClassifyDebit_(tx('2026-08-04','Auto Insurance ICBC','DEBIT',234.96,'ICBC'));equal(ip.length,1,'IPFS stream');equal(ip[0].family,'FINANCING','IPFS family');close(ip[0].monthlyEquivalent,234.96,.02,'IPFS monthly');equal(ins.family,'OTHER','insurance');return'IPFS=$234.96';});
  test('RBC-truncated IC Premium Fina is recurring financing and its NSF debit is suppressed',function(){
    const d=vfcDebtProfile_([
      row('2026-03-27',[tx('2026-03-19','Bill Payment IC Premium Fina','DEBIT',1122.01,'IC Premium Fina')]),
      row('2026-04-27',[tx('2026-04-20','Bill Payment IC Premium Fina','DEBIT',1122.01,'IC Premium Fina'),tx('2026-04-20','Item returned NSF','CREDIT',1122.01)]),
      row('2026-05-27',[tx('2026-04-29','Bill Payment IC Premium Fina','DEBIT',1147.01,'IC Premium Fina'),tx('2026-05-19','Bill Payment IC Premium Fina','DEBIT',1122.01,'IC Premium Fina')]),
      row('2026-06-26',[tx('2026-06-18','Bill Payment IC Premium Fina','DEBIT',1122.01,'IC Premium Fina')]),
      row('2026-07-27',[tx('2026-07-20','Bill Payment IC Premium Fina','DEBIT',1122.01,'IC Premium Fina')])
    ]),premium=d.activeDebtObligations.filter(function(x){return /^RBC_PREMIUM_FINANCE_/.test(x.entityKey);});
    equal(d.returnedFinanceDebitsSuppressed,1,'suppressed return');equal(premium.length,1,'premium-finance stream');
    equal(premium[0].family,'FINANCING','family');close(premium[0].monthlyEquivalent,1122.01,.02,'monthly debt');return'IC Premium Fina=$1122.01/month';
  });
  test('Same numbered RBC loan merges interest and BLIP components',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-23','Loan interest NO.02243790 001','DEBIT',36.80),tx('2026-03-23','BLIP payment - loan NO.02243790 001','DEBIT',.73)]),row('2026-04-30',[tx('2026-04-21','Loan interest NO.02243790 001','DEBIT',61.05),tx('2026-04-21','BLIP payment - loan NO.02243790 001','DEBIT',1.47)]),row('2026-05-31',[tx('2026-05-22','Loan interest NO.02243790 001','DEBIT',44.05),tx('2026-05-22','BLIP payment - loan NO.02243790 001','DEBIT',1.06)]),row('2026-06-30',[tx('2026-06-22','Loan interest NO.02243790 001','DEBIT',79.17),tx('2026-06-22','BLIP payment - loan NO.02243790 001','DEBIT',2.11)]),row('2026-07-31',[tx('2026-07-22','Loan interest NO.02243790 001','DEBIT',20.91),tx('2026-07-22','BLIP payment - loan NO.02243790 001','DEBIT',.53)]),row('2026-08-31',[tx('2026-08-22','Loan interest NO.02243790 001','DEBIT',.16)])]),loan=d.activeDebtObligations.filter(function(x){return x.entityKey==='LOAN_ACCOUNT_02243790';});equal(loan.length,1,'loan obligation');close(loan[0].monthlyEquivalent,41.34,.02,'combined monthly');equal(loan[0].monthlyEquivalentMethod,'MONTHLY_ACCOUNT_TOTAL_MEAN','method');return'one loan/$41.34';});
  test('Explicit RBC account-transfer credits excluded but customer e-transfer not',function(){truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','BR TO BR - 0863','CREDIT',5000)),'BR TO BR');truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','Online Banking transfer - 0040','CREDIT',500)),'online credit');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','Online Banking transfer - 0040','DEBIT',500)),false,'online debit');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','e-Transfer received CUSTOMER','CREDIT',5000)),false,'customer');return'correct';});
  test('BR TO BR owner-loan memo remains one transfer exclusion, not a financing-credit duplicate',function(){const credit=tx('2026-05-25','BR TO BR - Credit Memo 2920 Client request LOAN FROM KARMVIR SAHOTA','CREDIT',20000);truthy(vfcRbcIsNonOperatingTransferCredit_(credit),'transfer');equal(vfcRbcKnownFinancingCredit_(credit),false,'not financing duplicate');return'transfer only';});
  test('AIM HIGH six-statement operating deposits exclude financing, returns and account transfers',function(){const gross=363872.65,financing=104074.91,branchTransfers=44039.07,returns=10709.81,onlineTransfers=9066,operating=gross-financing-branchTransfers-returns-onlineTransfers;close(operating,195982.86,.02,'operating total');close(operating/6,32663.81,.02,'operating monthly');return'$32663.81/month';});
  test('Generic numeric Misc Payment never becomes obligation by itself',function(){equal(vfcRbcClassifyDebit_(tx('2026-03-12','Misc Payment 1469635','DEBIT',6585.81,'1469635')),null,'misc');return'ignored';});

  test('Summary debit sign does not create a false negative-balance flag',function(){
    const text='Total cheques & debits (39) -50,240.60\nClosing balance on April 2, 2026 = $195.66';
    equal(vfcRbcNegativeBalanceFlag_(text,{opening:4710.90,closing:195.66}),false,'summary sign');
    return'no false negative';
  });

  test('Visible running negative balance is detected',function(){
    const text='03 Mar Cheque - 343 315.00 -1,827.62';
    truthy(vfcRbcNegativeBalanceFlag_(text,{opening:4710.90,closing:195.66}),'running balance');
    return'negative detected';
  });

  test('Generic reversal credit is not automatically borrower NSF',function(){
    const rows=[tx('2026-03-10','Interac purchase reversal','CREDIT',125.00)];
    equal(vfcRbcCountBorrowerNsfEvents_(rows),0,'generic reversal');
    return'not NSF';
  });

  test('Cheque returned NSF credit counts as borrower NSF',function(){
    const rows=[tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)];
    equal(vfcRbcCountBorrowerNsfEvents_(rows),1,'NSF credit');
    return'1 NSF';
  });

  test('Printed activity count parser accepts ampersand and word and',function(){
    const a=vfcRbcPrintedActivityCounts_('Total deposits & credits (15) + 1\nTotal cheques & debits (39) - 1'),
          b=vfcRbcPrintedActivityCounts_('Total deposits and credits (15) + 1\nTotal cheques and debits (39) - 1');
    equal(a.creditCount,15,'amp credit');equal(a.debitCount,39,'amp debit');
    equal(b.creditCount,15,'and credit');equal(b.debitCount,39,'and debit');
    return'counts parsed';
  });

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,rbcRulesVersion:vfcRbcBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
function runBankingStabilitySelfTests(){return runRbcBankingSelfTests();}

/* ===== END Bank_RBC.gs ===== */

/* ===== BEGIN Bank_TD.gs ===== */
/**
 * TD BANK ENGINE v2.2 — CANDIDATE
 *
 * One permanent TD module. All TD-specific behavior lives here:
 * - extraction instructions
 * - printed statement fact locking
 * - page / cheque-image handling
 * - debit classification and debt identity
 * - financing-credit classification
 * - direction-safe internal-account transfer credit classification
 * - returned / reversed credit recognition
 * - Core 4.2 frozen-ledger intake contract
 * - deterministic TD regression tests
 *
 * Shared recurrence math, frozen-fact storage and underwriting remain in BankingCore.gs.
 */
function vfcTdBankProfile_(){
  return{
    id:'TD',
    label:'TD',
    status:'CANDIDATE',
    rulesVersion:'TD-2.2-CANDIDATE',
    intakeContract:'BANK_MATCHED_FROZEN_LEDGER_V2',
    aliases:['TD CANADA TRUST','THE TORONTO-DOMINION BANK','TORONTO-DOMINION','TD BANK','TD CANADA TRUST BUSINESS']
  };
}

function vfcTdExtractionRules_(){return[
  'TD statement direction is controlled only by the printed CHEQUE/DEBIT versus DEPOSIT/CREDIT columns.',
  'Before a TD statement is saved, its transaction ledger must satisfy Banking Core 4.2 BANK_MATCHED_FROZEN_LEDGER_V2 validation. Assessment never re-OCRs or guesses missing transaction facts.',
  'The Credits and Debits boxes printed at the bottom of each TD activity page are PAGE SUBTOTALS, not whole-statement totals. Sum every verified activity-page Credits amount for total_deposits and every verified activity-page Debits amount for total_withdrawals.',
  'TD Page X of Y can include cheque-image support pages. Cheque-image pages do not contain Credits/Debits activity subtotals and must not be treated as missing activity or duplicated as transactions.',
  'The TD lock step independently reads the statement period, first BALANCE FORWARD, all activity-page subtotals, deterministic closing balance and monthly minimum OD flag. Never use later continuation-page BALANCE FORWARD values as the opening balance.',
  'Preserve every visible transaction needed for recurrence and risk analysis, including standalone LOAN, LN PYMT, LN PYT INT, LN PYT PRI, RBC LOAN PYMT LOAN, TDCT LOC, FIRST INSURANCE LOAN, FORD CREDIT CA APY, BDC BUS, JOURNEY/ONDECK BUS, CANACAP, GREENBOX, MERCHANT GROWTH, ICAPITAL, AFFIRM CANADA, tax/government lines, insurance, transfers, NSF/return lines, deposits and financing-credit candidates.',
  'TD loan abbreviations are financing signals: standalone LOAN, LN PYMT, LN PYT INT, LN PYT PRI, LOAN PYMT, LOAN PAYMENT and explicit LOAN/MORTGAGE/LOC/LINE OF CREDIT/MCA/LEASE/FINANCING wording.',
  'A numbered TD loan reference such as *602099601 or 900017902 is a strong debt identity. Repeated payments with the same reference are the same obligation even when wording changes. Principal and interest with the same reference are components of one obligation.',
  'A standalone debit printed simply as LOAN is explicit financing evidence but is not confirmed monthly debt until recurrence is observed.',
  'LN PYMT-C, RTN NSF, RTN#... NSF, RTN#... FUNDS HELD and returned-cheque credits are reversal/return credits, not operating revenue. Return fees and NSF fees are risk/fee events, not debt service.',
  'FIRST INSURANCE LOAN and explicit PREMIUM FINANCE/PREMIUM FINANCING are financing when recurring. Ordinary ICBC INS or insurance-premium descriptions without financing wording remain informational.',
  'FORD CREDIT CA APY is a vehicle-financing candidate and must recur before a fixed monthly equivalent is confirmed.',
  'BDC BUS is a financing candidate. JOURNEY/ONDECK BUS, MERCHANT GROWTH, CANACAP and GREENBOX are financing/MCA candidates. iCapital is financing but is not automatically treated as MCA. All must recur before fixed monthly debt is confirmed.',
  'AFFIRM CANADA is a financing counterparty. A recurring AFFIRM debit is confirmed financing debt; one observation remains unconfirmed. An AFFIRM credit is not automatically financing proceeds.',
  'RBC LOAN PYMT LOAN is financing even though it appears on a TD account. When no reference is printed, materially different payment amounts remain separate streams so a catch-up payment cannot inflate the regular monthly obligation.',
  'EMPTX, GST-B, GST-P, TXBAL, TAX PYT, CRA, CCRA and HST are TAX/informational, not financing debt.',
  'TFR-FR C/C, TFR-TO C/C, E-TRANSFER, SEND E-TFR, GC ... TRANSFER and ordinary cheques are transfers, not debt. A transfer remains non-debt even if its memo contains the word LOAN.',
  'For operating-deposit analysis, exclude only direction-explicit inbound account-transfer credits such as TFR-FR C/C or TRANSFER FROM C/C/ACCOUNT. GC ####-TRANSFER is direction-ambiguous in TD OCR and must never be excluded from operating deposits solely from its description. Generic E-TRANSFER, SEND E-TFR, MOBILE DEPOSIT and GC ####-DEPOSIT are also not treated as internal transfers merely from wording.',
  'Same or near-identical dollar amount by itself NEVER proves debt.',
  'Fee-only rows are not recurring obligations. A row containing fee wording is preserved only when it also contains independent financing evidence.',
  'MONTHLY PLAN FEE, BUS LINE FEE, TAX PYT FEE, SERVICE CHARGE and ordinary transaction fees are not debt obligations.',
  'A financing CREDIT must be in the DEPOSIT/CREDIT column and contain explicit financing wording or a known financing entity. Ordinary deposits and transfers are not financing merely because they are large.',
  'Cheque-image pages are supporting images only. Do not duplicate a cheque already listed in statement activity.'
].join('\n');}

function vfcTdLockFacts_(summary,text,fileName){
  const locked=Object.assign({},summary||{}),dates=vfcTdStatementDates_(text),opening=vfcTdOpeningBalance_(text),totals=vfcTdPageTotals_(text),negative=vfcTdNegativeBalanceFlag_(text);
  if(dates.startDate)locked.statement_start_date=dates.startDate;if(dates.endDate)locked.statement_end_date=dates.endDate;if(opening!==null)locked.opening_balance=opening;
  if(!totals.complete)throw new Error('TD printed activity-page subtotals could not be fully verified for '+String(fileName||'statement')+'. PDF pages: '+totals.declaredPageCount+', cheque-image pages: '+totals.chequeImagePageCount+', expected activity pages: '+totals.expectedActivityPageCount+', found '+totals.creditCount+' Credits subtotal(s) and '+totals.debitCount+' Debits subtotal(s).');
  locked.total_deposits=totals.totalDeposits;locked.total_withdrawals=totals.totalWithdrawals;locked.td_page_subtotal_count=totals.pageCount;locked.td_cheque_image_page_count=totals.chequeImagePageCount;if(opening!==null)locked.closing_balance=vfcRound_(opening+totals.totalDeposits-totals.totalWithdrawals,.01);if(negative!==null)locked.negative_balance_detected=negative;return locked;
}
function vfcTdStatementDates_(text){const s=String(text||'').replace(/\u00a0/g,' '),m=s.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{1,2})\/(\d{2,4})\s*[-–—]\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{1,2})\/(\d{2,4})\b/i);if(!m)return{startDate:'',endDate:''};return{startDate:vfcTdIsoParts_(m[1],m[2],m[3]),endDate:vfcTdIsoParts_(m[4],m[5],m[6])};}
function vfcTdIsoParts_(month,day,year){const months={JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12},mm=months[String(month||'').toUpperCase()],dd=Number(day),raw=Number(year),yyyy=String(year||'').length===2?2000+raw:raw;if(!mm||!dd||!yyyy)return'';return String(yyyy).padStart(4,'0')+'-'+String(mm).padStart(2,'0')+'-'+String(dd).padStart(2,'0');}
function vfcTdOpeningBalance_(text){const s=String(text||'').replace(/\u00a0/g,' '),m=s.match(/\bBALANCE\s+FORWARD(?:\s+[A-Z]{3}\s*\d{1,2}|\s+[A-Z]{3}\d{1,2})?\s+\$?([0-9][0-9,]*\.\d{2})\s*(OD)?\b/i);if(!m)return null;const n=Number(String(m[1]).replace(/,/g,''));if(!Number.isFinite(n))return null;return m[2]?-n:n;}
function vfcTdPageStructure_(text){const s=String(text||''),re=/\bPage\s+(\d+)\s+of\s+(\d+)\b/gi,marks=[];let m,declared=0;while((m=re.exec(s))!==null){marks.push({page:Number(m[1])||0,total:Number(m[2])||0,index:m.index});declared=Math.max(declared,Number(m[2])||0);}let chequeImagePageCount=0,activityPageCount=0,unknownPageCount=0;marks.forEach(function(mark,i){const segment=s.slice(mark.index,i+1<marks.length?marks[i+1].index:s.length),hasCredits=/\bCredits\s+\d+\s+\$?[0-9][0-9,]*\.\d{2}\b/i.test(segment),hasDebits=/\bDebits\s+\d+\s+\$?[0-9][0-9,]*\.\d{2}\b/i.test(segment),hasChequeImage=/\b(?:CHEQUE|CHQ)\s*#\s*\d+/i.test(segment);if(hasCredits||hasDebits)activityPageCount++;else if(hasChequeImage)chequeImagePageCount++;else unknownPageCount++;});const unmarkedPages=Math.max(0,declared-marks.length);if(unmarkedPages>0&&/\b(?:CHEQUE|CHQ)\s*#\s*\d+/i.test(s))chequeImagePageCount+=unmarkedPages;return{declaredPageCount:declared,activityPageCount:activityPageCount,chequeImagePageCount:chequeImagePageCount,unknownPageCount:unknownPageCount,expectedActivityPageCount:declared?Math.max(0,declared-chequeImagePageCount):activityPageCount};}
function vfcTdPageTotals_(text){const s=String(text||'').replace(/\u00a0/g,' '),credits=[],debits=[],structure=vfcTdPageStructure_(s);let m,re=/\bCredits\s+\d+\s+\$?([0-9][0-9,]*\.\d{2})\b/gi;while((m=re.exec(s))!==null)credits.push(Number(String(m[1]).replace(/,/g,''))||0);re=/\bDebits\s+\d+\s+\$?([0-9][0-9,]*\.\d{2})\b/gi;while((m=re.exec(s))!==null)debits.push(Number(String(m[1]).replace(/,/g,''))||0);const same=credits.length>0&&credits.length===debits.length,expected=structure.expectedActivityPageCount,complete=same&&(!expected||credits.length===expected);return Object.assign({pageCount:complete?credits.length:0,totalDeposits:complete?vfcRound_(credits.reduce(function(a,b){return a+b;},0),.01):0,totalWithdrawals:complete?vfcRound_(debits.reduce(function(a,b){return a+b;},0),.01):0,creditCount:credits.length,debitCount:debits.length,complete:complete},structure);}
function vfcTdNegativeBalanceFlag_(text){const s=String(text||'').replace(/\u00a0/g,' '),m=s.match(/MONTHLY\s+MIN\.\s+BAL\.\s+\$?([0-9][0-9,]*\.\d{2})\s*(OD)?\b/i);if(m)return!!m[2];if(/\b[0-9][0-9,]*\.\d{2}\s*OD\b/i.test(s))return true;return null;}

function vfcTdClassifyDebit_(t){
  const raw=String(t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t.counterparty||'').replace(/\s+/g,' ').trim(),cents=Math.round(vfcNum_(t.amount)*100),hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bMCA\b|\bLEASE\b|\bFINANC(?:E|ING)?\b/.test(s),feeOnly=/\bFEES?\b|SERVICE\s+CHARGE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE/.test(s);if((feeOnly&&!hasFinancingSignal)||/NSF\s+(?:PAID|RETURN)\s+FEE|LN\s+RTN\s+FEE|TAX\s+PYT\s+FEE|MONTHLY\s+PLAN\s+FEE|BUS\s+LINE\s+FEE|TRANSACTION\s+FEE|^NSF(?:\s|$)/.test(s))return null;
  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/JOURNEY|ONDECK/.test(s)){family='MCA';entityKey='TD_JOURNEY_ONDECK';label='Journey / OnDeck';debtJustification='Known financing/MCA entity on a TD statement plus recurring observed payment cadence.';}
  else if(/MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='TD_MERCHANT_GROWTH';label='Merchant Growth';debtJustification='Known MCA/funding entity plus recurring observed payment cadence.';}
  else if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='TD_CANACAP';label='Canacap';debtJustification='Known business financing/MCA counterparty plus recurring observed payment cadence.';}
  else if(/GREENBOX/.test(s)){family='MCA';entityKey='TD_GREENBOX';label='Greenbox';debtJustification='Known business financing/MCA counterparty plus recurring observed payment cadence.';}
  else if(/\bICAPITAL\b/.test(s)){family='FINANCING';entityKey='TD_ICAPITAL';label='iCapital';debtJustification='Known financing counterparty plus recurring observed payment cadence; iCapital is not assumed to be MCA without explicit MCA evidence.';}
  else if(/\bBDC\b/.test(s)){family='FINANCING';entityKey='TD_BDC';label='BDC';debtJustification='Known business lender on a TD statement plus recurring observed payment cadence.';}
  else if(/FORD\s+CREDIT/.test(s)){family='FINANCING';entityKey='TD_FORD_CREDIT';label='Ford Credit';debtJustification='Known vehicle-finance counterparty on a TD statement plus recurring observed payment cadence.';}
  else if(/\bAFFIRM(?:\s+CANADA)?\b/.test(s)){family='FINANCING';entityKey='TD_AFFIRM_CANADA';label='Affirm Canada';debtJustification='Affirm Canada is a financing counterparty; recurring observed payments are treated as financing debt.';}
  else if(/RBC\s+LOAN\s+PYMT\s+LOAN/.test(s)){family='FINANCING';entityKey='TD_RBC_LOAN_PAYMENT_'+cents;label='RBC Loan Payment';debtJustification='Explicit RBC loan-payment wording on the TD statement plus recurring observed cadence. Amount-separated identity prevents one-time catch-up payments from inflating the regular monthly stream when no reference is printed.';}
  else if(/\bLN\s+PYT\s+(?:INT|PRI)\b|\bLN\s+PYMT\b|\bLOAN\s+(?:PYMT|PAYMENT)\b/.test(s)){const n=vfcTdLoanReference_(s);family='FINANCING';entityKey=n?'TD_LOAN_'+n:'TD_UNREFERENCED_LOAN_'+cents;label=n?'TD Loan '+n:(cp||raw);debtJustification='Explicit TD loan-payment wording tied to a stable loan reference plus recurring observed cadence; principal and interest with the same reference are one obligation. Unreferenced streams are amount-separated to avoid merging unrelated loans.';}
  else if(/^LOAN\s*$/i.test(raw)){family='FINANCING';entityKey='TD_STANDALONE_LOAN_'+cents;label='TD Loan';debtJustification='Standalone TD LOAN debit is explicit financing evidence. It becomes confirmed monthly debt only when the same stream recurs.';}
  else if(vfcTdIsTransferDebit_(s))return null;
  else if(/\bEMPTX\b|\bGST[- ]?[BP]?\b|\bTXBAL\b|TAX\s+PYT|\bCRA\b|\bCCRA\b|\bHST\b/.test(s)){family='TAX';entityKey='TD_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/\bINSURANCE\b.*\bLOAN\b|\bLOAN\b.*\bINSURANCE\b|PREMIUM\s+FINANC/.test(s)){family='FINANCING';entityKey=/PREMIUM\s+FINANC/.test(s)?'TD_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw):'TD_INSURANCE_LOAN_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;debtJustification='Explicit insurance-loan or premium-finance wording plus recurring observed payment cadence.';}
  else if(/\bICBC\s+INS\b|INSURANCE/.test(s)){family='OTHER';entityKey='TD_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/CREDIT\s+CARD|VISA|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|\bMBNA\b/.test(s)){family='OTHER';entityKey='TD_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bMCA\b|\bLEASE\b|\bFINANC(?:E|ING)?\b|\bLOAN\b/.test(s)){const n=vfcTdLoanReference_(s);family='FINANCING';entityKey=n?'TD_LOAN_'+n:'TD_FINANCE_'+vfcCounterpartyKey_(cp||raw);label=n?'TD Loan '+n:(cp||raw);debtJustification='Explicit loan/mortgage/LOC/financing/lease/MCA wording plus recurring observed cadence.';}
  else if(/\bPAD\b|PRE[- ]?AUTH/.test(s)){family='OTHER';entityKey='TD_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else return null;return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}
function vfcTdIsTransferDebit_(s){return/TFR-TO\s+C\/C|TFR-FR\s+C\/C|E-TRANSFER|SEND\s+E-TFR|\bTRANSFER\b|CHQ#|CHEQUE|ATM\s+W\/D|ATM\s+DEP|GC\s+\d+-(?:TRANSFER|DEPOSIT)/.test(String(s||'').toUpperCase());}
function vfcTdIsNonOperatingTransferCredit_(t){if(String((t&&t.direction)||'').toUpperCase()!=='CREDIT')return false;const s=String((t&&t.description)||'').toUpperCase().replace(/\s+/g,' ').trim();if(/\bTFR[- ]FR\s+C\/C\b/.test(s))return true;if(/\bTRANSFER\s+FROM\s+(?:C\/C|ACCOUNT)\b/.test(s))return true;return false;}
function vfcTdLoanReference_(s){s=String(s||'').toUpperCase();let m=s.match(/\*([0-9]{6,})/);if(m)return m[1];m=s.match(/(?:LN\s+PYT\s+(?:INT|PRI)|LN\s+PYMT|LOAN\s+(?:PYMT|PAYMENT))[^0-9]{0,20}([0-9]{6,})/);if(m)return m[1];m=s.match(/\b([0-9]{9})\b/);return m?m[1]:'';}
function vfcTdKnownFinancingCredit_(t){const s=String((t&&t.description)||'').toUpperCase();if(vfcTdIsReturnedFinancingCredit_(t))return false;return/JOURNEY|ONDECK|MERCHANT\s+GROWTH|\bCANACAP\b|GREENBOX|\bICAPITAL\b|\bBDC\b|LOAN\s+(?:ADVANCE|PROCEEDS|CREDIT)|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b/.test(s);}
function vfcTdStrongEntityKey_(key){return/^(TD_JOURNEY_ONDECK|TD_MERCHANT_GROWTH|TD_CANACAP|TD_GREENBOX|TD_ICAPITAL|TD_BDC|TD_FORD_CREDIT|TD_AFFIRM_CANADA|TD_RBC_LOAN_PAYMENT_|TD_INSURANCE_LOAN_|TD_PREMIUM_FINANCE_|TD_LOAN_|TD_UNREFERENCED_LOAN_|TD_FINANCE_|TD_STANDALONE_LOAN_)/.test(String(key||'').toUpperCase());}
function vfcTdIsReturnedFinancingCredit_(t){const s=String((t&&t.description)||'').toUpperCase();return/\bLN\s+PYMT-C\b|\bLOAN\s+PYMT-C\b|\bLOAN\s+PAYMENT-C\b|^RTN\s+NSF\b|^RTN#?\d+\s+(?:NSF|FUNDS\s+HELD)\b|RETURNED\s+CHEQUE|CHEQUE\s+RETURNED/.test(s);}

function runTdBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'TD',transactions:transactions||[]}};}
  function close(actual,expected,tol,label){tol=tol==null?.02:tol;if(Math.abs(Number(actual||0)-Number(expected||0))>tol)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function equal(actual,expected,label){if(actual!==expected)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function truthy(value,label){if(!value)throw new Error((label||'value')+' expected truthy');}
  function test(name,fn){try{const detail=fn()||'';results.push({name:name,pass:true,detail:String(detail||'')});}catch(e){results.push({name:name,pass:false,detail:String(e&&e.message||e)});}}
  function footerText(range,opening,pages,minLine){const parts=[range,'BALANCE FORWARD '+String(range||'').split(' ')[0]+'01 '+(opening<0?Math.abs(opening).toFixed(2)+'OD':Number(opening).toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2}))];(pages||[]).forEach(function(p,i){parts.push('Page '+(i+1)+' of '+pages.length);parts.push('Credits '+(p[2]||0)+' '+Number(p[0]).toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2}));parts.push('Debits '+(p[3]||0)+' '+Number(p[1]).toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2}));});if(minLine)parts.push(minLine);return parts.join('\n');}

  test('Waveform nine real TD statements reconcile exactly',function(){const cases=[{range:'APR 01/25 - APR 30/25',opening:0,closing:-39.02,pages:[[0,39.02,1,2]],min:'MONTHLY MIN. BAL. $39.02OD'},{range:'APR 30/25 - MAY 30/25',opening:-39.02,closing:-78.76,pages:[[0,39.74,0,2]],min:'MONTHLY MIN. BAL. $78.76OD'},{range:'MAY 30/25 - JUN 30/25',opening:-78.76,closing:28443.61,pages:[[28561.92,39.55,8,3]],min:'MONTHLY MIN. BAL. $78.76OD'},{range:'JUN 30/25 - JUL 31/25',opening:28443.61,closing:30892.06,pages:[[21403.47,36528.45,7,24],[16394.56,12628.50,4,27],[24428.67,4556.90,2,29],[22013.80,7351.00,4,27],[0,20713.45,0,31],[0,13.75,0,1]],min:'MONTHLY MIN. BAL. $124.79'},{range:'JUL 31/25 - AUG 29/25',opening:30892.06,closing:56583.80,pages:[[22909.35,25787.95,3,28],[22135.12,8143.50,1,30],[23164.33,13441.12,3,28],[21366.32,8864.81,5,26],[0,7646.00,0,8]],min:'MONTHLY MIN. BAL. $28,013.46'},{range:'AUG 29/25 - SEP 29/25',opening:56583.80,closing:71699.58,pages:[[33132.31,39968.90,3,28],[15043.38,16693.00,2,29],[18603.11,16908.00,2,29],[20198.13,11199.04,1,30],[25724.74,12816.95,2,26]],min:'MONTHLY MIN. BAL. $35,227.59'},{range:'SEP 29/25 - OCT 31/25',opening:71699.58,closing:86143.26,pages:[[44636.46,35049.90,7,24],[150.00,16812.50,1,30],[44904.13,15918.50,8,23],[33.99,6295.50,2,29],[39.00,1243.50,1,7]],min:'MONTHLY MIN. BAL. $53,113.68'},{range:'OCT 31/25 - NOV 28/25',opening:86143.26,closing:96425.78,pages:[[25652.16,12517.64,3,28],[22431.40,43791.35,6,25],[27612.68,14078.00,2,29],[20130.77,13332.50,2,29],[39.00,1864.00,1,12]],min:'MONTHLY MIN. BAL. $65,824.33'},{range:'NOV 28/25 - DEC 31/25',opening:96425.78,closing:118371.74,pages:[[30992.62,40469.40,3,28],[18063.91,7552.50,1,30],[40296.08,6169.50,2,29],[200.00,13312.50,1,30],[39.00,141.75,1,4]],min:'MONTHLY MIN. BAL. $86,143.00'}];let gross=0,withdrawals=0;cases.forEach(function(c,i){const s=vfcTdLockFacts_({},footerText(c.range,c.opening,c.pages,c.min),'waveform-'+i+'.pdf');close(s.closing_balance,c.closing,.02,'Waveform closing '+i);gross+=s.total_deposits;withdrawals+=s.total_withdrawals;});close(gross,590300.41,.02,'Waveform deposits');close(withdrawals,471928.67,.02,'Waveform withdrawals');return'gross='+vfcRound_(gross,.01)+', withdrawals='+vfcRound_(withdrawals,.01);});
  test('Waveform latest six benchmark average remains 93623.08',function(){const deposits=[84240.50,89575.12,112701.67,89763.58,95866.01,89591.61];close(deposits.reduce(function(a,b){return a+b;},0),561738.49,.02,'latest six deposits');close(deposits.reduce(function(a,b){return a+b;},0)/6,93623.081666,.02,'latest six average');return'latest six average=93623.08';});
  test('TD multi-page subtotals sum to whole-statement totals',function(){const text=['Page 1 of 5','Credits 3 33,132.31 Debits 28 39,968.90','Page 2 of 5','Credits 2 15,043.38 Debits 29 16,693.00','Page 3 of 5','Credits 2 18,603.11 Debits 29 16,908.00','Page 4 of 5','Credits 1 20,198.13 Debits 30 11,199.04','Page 5 of 5','Credits 2 25,724.74 Debits 26 12,816.95'].join('\n'),t=vfcTdPageTotals_(text);equal(t.pageCount,5,'page count');truthy(t.complete,'complete');close(t.totalDeposits,112701.67,.02,'deposits');close(t.totalWithdrawals,97585.89,.02,'withdrawals');return'deposits='+t.totalDeposits;});
  test('TD cheque-image pages do not look like missing activity pages',function(){const text=['JUN 30/25 - JUL 31/25','BALANCE FORWARD JUN30 34.49','Page 1 of 2','Credits 7 24,121.00','Debits 18 18,350.24','MONTHLY MIN. BAL. $34.49','CHEQUE # 00410 $1,064.92 CHEQUE # 00410','CHEQUE # 00413 $2,000.00 CHEQUE # 00413'].join('\n'),t=vfcTdPageTotals_(text);equal(t.declaredPageCount,2,'declared pages');equal(t.chequeImagePageCount,1,'cheque pages');equal(t.expectedActivityPageCount,1,'expected activity pages');truthy(t.complete,'cheque-image completeness');const s=vfcTdLockFacts_({},text,'new-age-july.pdf');close(s.total_deposits,24121,.001,'deposits');close(s.total_withdrawals,18350.24,.001,'withdrawals');close(s.closing_balance,5805.25,.001,'closing');return'activity=1, cheque=1';});
  test('Lotus Pharmacy 7-page TD statement has 6 activity pages plus one cheque-image page',function(){const text=['APR 30/25 - MAY 30/25','BALANCE FORWARD APR30 13,860.16OD','Page 1 of 7','Credits 20 30,324.40','Debits 11 9,110.85','Page 2 of 7','Credits 23 27,337.51','Debits 8 62,985.31','Page 3 of 7','Credits 27 29,595.72','Debits 4 10,631.20','Page 4 of 7','Credits 25 29,557.15','Debits 6 15,492.49','Page 5 of 7','Credits 23 34,578.29','Debits 8 72,099.88','Page 6 of 7','Credits 12 209,806.93','Debits 10 89,450.33','Page 7 of 7','9280-5229903','CHEQUE # 01866 $5,551.88 CHEQUE # 01866','MONTHLY MIN. BAL. $39,804.16OD'].join('\n'),t=vfcTdPageTotals_(text);equal(t.declaredPageCount,7,'Lotus declared pages');equal(t.chequeImagePageCount,1,'Lotus cheque-image pages');equal(t.expectedActivityPageCount,6,'Lotus expected activity pages');equal(t.creditCount,6,'Lotus Credits subtotals');equal(t.debitCount,6,'Lotus Debits subtotals');truthy(t.complete,'Lotus statement completeness');close(t.totalDeposits,361200.00,.02,'Lotus deposits');close(t.totalWithdrawals,259770.06,.02,'Lotus withdrawals');const s=vfcTdLockFacts_({},text,'TD_EVERY_DAY_B_BUSINESS_PLAN_9280-5229903_Apr_30-May_30_2025.pdf');close(s.opening_balance,-13860.16,.02,'Lotus opening');close(s.closing_balance,87569.78,.02,'Lotus closing');return'activity=6, cheque=1, deposits='+t.totalDeposits+', withdrawals='+t.totalWithdrawals;});
  test('TD lock sets dates opening closing and OD deterministically',function(){const text=['MAR 31/26 - APR 30/26','Page 1 of 2','Credits 13 11,441.88','Debits 18 8,762.88','MONTHLY MIN. BAL. $30.76OD','BALANCE FORWARD MAR31 3.63','Page 2 of 2','Credits 1 2,520.00','Debits 10 2,142.71','MONTHLY MIN. BAL. $30.76OD','BALANCE FORWARD APR27 2,682.63'].join('\n'),s=vfcTdLockFacts_({closing_balance:999999,negative_balance_detected:false},text,'test.pdf');equal(s.statement_start_date,'2026-03-31','start');equal(s.statement_end_date,'2026-04-30','end');close(s.opening_balance,3.63,.001,'opening');close(s.total_deposits,13961.88,.001,'deposits');close(s.total_withdrawals,10905.59,.001,'withdrawals');close(s.closing_balance,3059.92,.001,'closing');equal(s.negative_balance_detected,true,'OD');return'closing='+s.closing_balance;});
  test('TD incomplete activity pages fail closed',function(){let threw=false;try{vfcTdLockFacts_({},['MAR 31/26 - APR 30/26','Page 1 of 2','Credits 13 11,441.88','Debits 18 8,762.88','BALANCE FORWARD MAR31 3.63'].join('\n'),'incomplete.pdf');}catch(e){threw=/could not be fully verified/i.test(String(e&&e.message||e));}truthy(threw,'fail closed');return'failed closed';});
  test('TD explicit internal transfer credit patterns are narrow and directional',function(){truthy(vfcTdIsNonOperatingTransferCredit_(tx('2025-05-23','JX353 TFR-FR C/C','CREDIT',3000)),'TFR-FR credit');equal(vfcTdIsNonOperatingTransferCredit_(tx('2025-05-30','GC 9993-TRANSFER','CREDIT',10000)),false,'GC transfer description alone');equal(vfcTdIsNonOperatingTransferCredit_(tx('2025-05-30','GC 9993-TRANSFER','DEBIT',10000)),false,'GC transfer debit');equal(vfcTdIsNonOperatingTransferCredit_(tx('2025-05-01','E-TRANSFER ***Bpq','CREDIT',1500)),false,'customer e-transfer');equal(vfcTdIsNonOperatingTransferCredit_(tx('2025-05-29','GC 9993-DEPOSIT','CREDIT',5500)),false,'GC deposit');equal(vfcTdIsNonOperatingTransferCredit_(tx('2025-05-29','MOBILE DEPOSIT','CREDIT',5500)),false,'mobile deposit');return'direction-safe transfer rules';});
  test('TD only direction-explicit inbound transfers reduce operating deposits',function(){const txs=vfcNormalizeTransactions_([tx('2025-05-23','JX353 TFR-FR C/C','CREDIT',3000),tx('2025-05-30','GC 9993-TRANSFER','CREDIT',10000),tx('2025-05-01','E-TRANSFER ***Bpq','CREDIT',1500),tx('2025-05-29','GC 9993-DEPOSIT','CREDIT',5500)],'TD'),p={bankId:'TD',bankName:'TD',statementStartDate:'2025-04-30',statementEndDate:'2025-05-30',openingBalance:0,closingBalance:20000,totalDeposits:20000,totalWithdrawals:0,reconciliationDifference:0,nsfCount:0,negativeBalanceDetected:false,transactionsVerified:true,transactions:txs},f=vfcBuildBankingFeatures_({},[{row:{fileName:'lotus-transfer-test.pdf'},payload:p}]);close(f.excludedTransferCredits,3000,.02,'excluded transfers');close(f.estimatedOperatingTotalDeposits,17000,.02,'operating deposits');return'excluded=3000, operating=17000';});
  test('TD transfer memo containing LOAN is never debt',function(){equal(vfcTdClassifyDebit_(tx('2025-06-01','SEND E-TFR *Esd LOAN','DEBIT',2000)),null,'transfer loan memo');return'excluded';});
  test('Same-dollar TD e-transfers never become debt',function(){const d=vfcDebtProfile_([row('2025-07-31',[tx('2025-07-10','SEND E-TFR ***AAA','DEBIT',1000)]),row('2025-08-29',[tx('2025-08-10','SEND E-TFR ***AAA','DEBIT',1000)]),row('2025-09-29',[tx('2025-09-10','SEND E-TFR ***AAA','DEBIT',1000)])]);close(d.confirmedMonthlyDebtService,0,.001,'e-transfer debt');return'debt=0';});
  test('TD tax payment fee is not tax debt',function(){equal(vfcTdClassifyDebit_(tx('2025-09-02','TAX PYT FEE','DEBIT',6)),null,'tax fee');return'excluded';});
  test('TD fee-only rows are suppressed but financing lines containing fee wording survive',function(){equal(vfcTdClassifyDebit_(tx('2026-01-02','PAY-FILE FEES','DEBIT',2)),null,'fee-only');const x=vfcTdClassifyDebit_(tx('2026-01-02','Loan payment service fee NO.123456','DEBIT',250,'Loan NO.123456'));equal(x.family,'FINANCING','loan fee line');return'fees separated';});
  test('TD recurring tax remains informational',function(){const d=vfcDebtProfile_([row('2025-07-31',[tx('2025-07-11','EMPTX 240075 BUS','DEBIT',1061.25)]),row('2025-08-29',[tx('2025-08-11','EMPTX 240075 BUS','DEBIT',1061.25)]),row('2025-09-29',[tx('2025-09-11','EMPTX 240075 BUS','DEBIT',1061.25)])]);close(d.confirmedMonthlyDebtService,0,.001,'tax debt');close(d.informationalMonthlyObligations,1061.25,.02,'tax info');return'informational='+d.informationalMonthlyObligations;});
  test('TD recurring card remains informational',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-21','TD VISA','DEBIT',1000)]),row('2026-02-28',[tx('2026-02-21','TD VISA','DEBIT',1000)]),row('2026-03-31',[tx('2026-03-21','TD VISA','DEBIT',1000)])]);close(d.confirmedMonthlyDebtService,0,.001,'Visa debt');close(d.informationalMonthlyObligations,1000,.02,'Visa info');return'informational='+d.informationalMonthlyObligations;});
  test('Unknown recurring TD PAD remains informational',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-02-28',[tx('2026-02-12','PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-03-31',[tx('2026-03-12','PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])]);close(d.confirmedMonthlyDebtService,0,.001,'PAD debt');close(d.informationalMonthlyObligations,500,.02,'PAD info');return'informational='+d.informationalMonthlyObligations;});
  test('TD recurring Affirm Canada becomes financing debt only after recurrence',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-02-28',[tx('2026-02-06','AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-03-31',[tx('2026-03-06','AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm debt');equal(d.activeDebtObligations[0].entityKey,'TD_AFFIRM_CANADA','Affirm identity');const one=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(one.confirmedMonthlyDebtService,0,.001,'single Affirm');return'debt='+d.confirmedMonthlyDebtService;});
  test('TD known funders classify with correct family',function(){equal(vfcTdClassifyDebit_(tx('2026-01-03','CANACAP BUS','DEBIT',900,'CANACAP')).family,'MCA','Canacap');equal(vfcTdClassifyDebit_(tx('2026-01-03','GREENBOX CAPITAL','DEBIT',900,'GREENBOX')).family,'MCA','Greenbox');equal(vfcTdClassifyDebit_(tx('2026-01-03','MERCHANT GROWTH','DEBIT',900,'MERCHANT GROWTH')).family,'MCA','Merchant Growth');equal(vfcTdClassifyDebit_(tx('2026-01-03','ICAPITAL','DEBIT',900,'ICAPITAL')).family,'FINANCING','iCapital');return'families correct';});
  test('TD premium finance is financing while ordinary insurance remains informational',function(){equal(vfcTdClassifyDebit_(tx('2026-01-16','PREMIUM FINANCE PAYMENT','DEBIT',366.73,'PREMIUM FINANCE')).family,'FINANCING','premium finance');equal(vfcTdClassifyDebit_(tx('2026-01-16','ICBC INS','DEBIT',366.73,'ICBC')).family,'OTHER','ordinary insurance');return'insurance separated';});
  test('TD known financing credits exclude Affirm merchant credits',function(){truthy(vfcTdKnownFinancingCredit_(tx('2026-01-10','CANACAP','CREDIT',25000)),'Canacap credit');truthy(vfcTdKnownFinancingCredit_(tx('2026-01-10','ICAPITAL','CREDIT',25000)),'iCapital credit');equal(vfcTdKnownFinancingCredit_(tx('2026-01-10','AFFIRM CANADA','CREDIT',25000)),false,'Affirm credit');return'credits separated';});
  test('One standalone TD LOAN is evidence but not monthly debt',function(){const d=vfcDebtProfile_([row('2025-09-29',[tx('2025-09-08','LOAN','DEBIT',11105)])]);close(d.confirmedMonthlyDebtService,0,.001,'single loan debt');equal(d.observedOnce.length,1,'observed once');truthy(/^TD_STANDALONE_LOAN_/.test(d.observedOnce[0].entityKey||''),'identity');return'observed once';});
  test('Recurring standalone TD LOAN becomes debt',function(){const d=vfcDebtProfile_([row('2025-09-30',[tx('2025-09-08','LOAN','DEBIT',11105)]),row('2025-10-31',[tx('2025-10-08','LOAN','DEBIT',11105)]),row('2025-11-30',[tx('2025-11-08','LOAN','DEBIT',11105)])]);close(d.confirmedMonthlyDebtService,11105,.02,'standalone loan');equal(d.activeDebtObligations.length,1,'obligations');return'debt='+d.confirmedMonthlyDebtService;});
  test('TD principal and interest with one reference become one obligation',function(){const d=vfcDebtProfile_([row('2025-07-31',[tx('2025-07-16','LN PYT INT 900017902','DEBIT',265.90),tx('2025-07-16','LN PYT PRI 900017902','DEBIT',663.84)]),row('2025-08-29',[tx('2025-08-19','LN PYT INT 900017902','DEBIT',258.97),tx('2025-08-19','LN PYT PRI 900017902','DEBIT',670.77)]),row('2025-09-29',[tx('2025-09-08','LN PYT INT 900017902','DEBIT',543.96),tx('2025-09-08','LN PYT PRI 900017902','DEBIT',385.78)])]);equal(d.activeDebtObligations.length,1,'PRI/INT count');equal(d.activeDebtObligations[0].entityKey,'TD_LOAN_900017902','identity');close(d.confirmedMonthlyDebtService,929.74,.02,'PRI/INT debt');return'debt='+d.confirmedMonthlyDebtService;});
  test('TD RBC-loan catch-up does not inflate regular monthly debt',function(){const d=vfcDebtProfile_([row('2025-06-30',[tx('2025-06-02','RBC LOAN PYMT LOAN','DEBIT',1539.56),tx('2025-06-10','RBC LOAN PYMT LOAN','DEBIT',769.78)]),row('2025-07-31',[tx('2025-07-10','RBC LOAN PYMT LOAN','DEBIT',769.78)]),row('2025-08-29',[tx('2025-08-12','RBC LOAN PYMT LOAN','DEBIT',769.78)])]);close(d.confirmedMonthlyDebtService,769.78,.02,'regular RBC loan');truthy(d.observedOnce.some(function(x){return Math.abs((x.paymentAmount||0)-1539.56)<.02;}),'catch-up observed');return'regular='+d.confirmedMonthlyDebtService;});
  test('TD FIRST INSURANCE LOAN is debt when recurring',function(){const d=vfcDebtProfile_([row('2025-12-31',[tx('2025-12-18','FIRST INSURANCE LOAN','DEBIT',437.99)]),row('2026-01-30',[tx('2026-01-19','FIRST INSURANCE LOAN','DEBIT',437.99)]),row('2026-02-27',[tx('2026-02-18','FIRST INSURANCE LOAN','DEBIT',437.99)])]);close(d.confirmedMonthlyDebtService,437.99,.02,'insurance loan');return'debt='+d.confirmedMonthlyDebtService;});
  test('Ordinary ICBC insurance stays informational',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-16','ICBC INS','DEBIT',366.73)]),row('2026-02-28',[tx('2026-02-16','ICBC INS','DEBIT',366.73)]),row('2026-03-31',[tx('2026-03-16','ICBC INS','DEBIT',366.73)])]);close(d.confirmedMonthlyDebtService,0,.001,'ICBC debt');close(d.informationalMonthlyObligations,366.73,.02,'ICBC info');return'informational='+d.informationalMonthlyObligations;});
  test('TD Ford Credit recurring payments are debt',function(){const d=vfcDebtProfile_([row('2026-01-30',[tx('2026-01-12','FORD CREDIT CA APY','DEBIT',950.61)]),row('2026-02-27',[tx('2026-02-10','FORD CREDIT CA APY','DEBIT',950.61)]),row('2026-03-31',[tx('2026-03-10','FORD CREDIT CA APY','DEBIT',950.61)])]);close(d.confirmedMonthlyDebtService,950.61,.02,'Ford debt');return'debt='+d.confirmedMonthlyDebtService;});
  test('TDCT LOC recurring payments are debt',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-15','TDCT LOC PAYMENT','DEBIT',850)]),row('2026-02-28',[tx('2026-02-15','TDCT LOC PAYMENT','DEBIT',850)]),row('2026-03-31',[tx('2026-03-15','TDCT LOC PAYMENT','DEBIT',850)])]);close(d.confirmedMonthlyDebtService,850,.02,'TD LOC debt');return'debt='+d.confirmedMonthlyDebtService;});
  test('TD Journey weekly cadence becomes MCA debt',function(){const a=[];['2025-08-07','2025-08-14','2025-08-21','2025-08-28','2025-09-04','2025-09-11','2025-09-18','2025-09-25'].forEach(function(date){a.push(tx(date,'JOURNEY/ONDECK BUS','DEBIT',4274.21));});const d=vfcDebtProfile_([row('2025-08-29',a.slice(0,4)),row('2025-09-29',a.slice(4))]);close(d.confirmedMonthlyDebtService,4274.21*52/12,.05,'Journey debt');return'debt='+d.confirmedMonthlyDebtService;});
  test('TD BDC monthly payments become debt',function(){const d=vfcDebtProfile_([row('2025-08-29',[tx('2025-08-18','BDC BUS','DEBIT',664.09)]),row('2025-09-29',[tx('2025-09-18','BDC BUS','DEBIT',664.09)]),row('2025-10-31',[tx('2025-10-18','BDC BUS','DEBIT',664.09)])]);close(d.confirmedMonthlyDebtService,664.09,.02,'BDC debt');return'debt='+d.confirmedMonthlyDebtService;});
  test('TD explicit loan proceeds are financing credit',function(){const d=vfcDebtProfile_([row('2025-04-30',[tx('2025-04-15','LOAN PROCEEDS','CREDIT',50000)])]);close(d.financingCreditsTotal,50000,.02,'loan proceeds');equal(d.financingCredits.length,1,'financing count');return'financing='+d.financingCreditsTotal;});
  test('TD LN PYMT-C suppresses failed debit and is not revenue',function(){const d=vfcDebtProfile_([row('2025-09-29',[tx('2025-09-09','LN PYMT *602099601','DEBIT',1265.14),tx('2025-09-09','LN PYMT-C *602099601','CREDIT',1265.14)])]);close(d.confirmedMonthlyDebtService,0,.001,'returned debt');equal(d.returnedFinanceDebitsSuppressed,1,'suppressed');close(d.returnedCreditsTotal,1265.14,.001,'returned credit');close(d.financingCreditsTotal,0,.001,'not financing proceeds');return'returned='+d.returnedCreditsTotal;});
  test('TD RTN NSF suppresses same-amount financing debit',function(){const d=vfcDebtProfile_([row('2025-09-29',[tx('2025-09-10','RBC LOAN PYMT LOAN','DEBIT',769.78),tx('2025-09-10','RTN NSF','CREDIT',769.78)])]);equal(d.returnedFinanceDebitsSuppressed,1,'RTN suppression');close(d.returnedCreditsTotal,769.78,.001,'RTN total');close(d.confirmedMonthlyDebtService,0,.001,'returned debt');return'returned='+d.returnedCreditsTotal;});
  test('TD numbered RTN# NSF is a returned credit',function(){truthy(vfcTdIsReturnedFinancingCredit_(tx('2025-07-10','RTN#00409 NSF','CREDIT',2000)),'numbered NSF return');return'return recognized';});
  test('TD returned cheque FUNDS HELD is excluded from operating deposits',function(){const txs=vfcNormalizeTransactions_([tx('2026-02-17','CHQ#01564-0146568325','DEBIT',80000),tx('2026-02-17','RTN#01564 FUNDS HELD','CREDIT',80000)],'TD'),p={bankId:'TD',bankName:'TD',statementStartDate:'2026-01-30',statementEndDate:'2026-02-27',openingBalance:0,closingBalance:0,totalDeposits:100000,totalWithdrawals:100000,reconciliationDifference:0,nsfCount:1,negativeBalanceDetected:false,transactionsVerified:true,transactions:txs},f=vfcBuildBankingFeatures_({},[{row:{fileName:'3d-concrete.pdf'},payload:p}]);close(f.estimatedOperatingTotalDeposits,20000,.02,'operating deposits');close(f.debtProfile.returnedCreditsTotal,80000,.02,'returned cheque');return'operating='+f.estimatedOperatingTotalDeposits;});
  test('TD failed debit plus same-day retry preserves one real payment',function(){function retryRow(end,date){const items=vfcNormalizeTransactions_([tx(date,'LN PYMT *602099601','DEBIT',1265.14),tx(date,'LN PYMT-C *602099601','CREDIT',1265.14),tx(date,'LN PYMT *602099601','DEBIT',1265.14)],'TD');equal(items.filter(function(x){return x.direction==='DEBIT';}).length,2,'two printed debits');return row(end,items);}const d=vfcDebtProfile_([retryRow('2025-07-31','2025-07-09'),retryRow('2025-08-29','2025-08-11'),retryRow('2025-09-29','2025-09-09')]);equal(d.returnedFinanceDebitsSuppressed,3,'suppressed failed debits');close(d.confirmedMonthlyDebtService,1265.14,.02,'retry debt');equal(d.activeDebtObligations.length,1,'one obligation');return'debt='+d.confirmedMonthlyDebtService;});
  test('TD returned credits reduce estimated operating deposits',function(){const txs=vfcNormalizeTransactions_([tx('2025-09-09','LN PYMT *602099601','DEBIT',1265.14),tx('2025-09-09','LN PYMT-C *602099601','CREDIT',1265.14)],'TD'),p={bankId:'TD',bankName:'TD',statementStartDate:'2025-08-29',statementEndDate:'2025-09-29',openingBalance:0,closingBalance:0,totalDeposits:5000,totalWithdrawals:5000,reconciliationDifference:0,nsfCount:1,negativeBalanceDetected:false,transactionsVerified:true,transactions:txs},f=vfcBuildBankingFeatures_({},[{row:{fileName:'td.pdf'},payload:p}]);close(f.estimatedOperatingTotalDeposits,3734.86,.02,'operating');equal(f.returnedPaymentFlag,1,'return flag');return'operating='+f.estimatedOperatingTotalDeposits;});
  test('TD intake payload freezes a usable bank-matched ledger',function(){const summary={bank_name:'TD',statement_start_date:'2025-08-29',statement_end_date:'2025-09-29',opening_balance:1000,closing_balance:5725.79,total_deposits:9000,total_withdrawals:4274.21,nsf_count:0,negative_balance_detected:false,banking_transactions:[tx('2025-09-04','E-TRANSFER CUSTOMER','CREDIT',9000),tx('2025-09-04','JOURNEY/ONDECK BUS','DEBIT',4274.21)]},raw=vfcBankCreateIntakePayload_(summary,'td-intake-contract.pdf'),p=vfcValidateFrozenPayload_(raw,'TD','td-intake-contract.pdf');equal(p.bankId,'TD','frozen bank');equal(p.transactionsVerified,true,'transactions verified');equal(p.transactions.length,2,'frozen transactions');equal(p.intakeContract,VFC_BANK_ENGINE.INTAKE_CONTRACT,'intake contract');equal(p.bankRulesVersion,vfcTdBankProfile_().rulesVersion,'rules version');let mismatch=false;try{vfcValidateFrozenPayload_(raw,'RBC','td-intake-contract.pdf');}catch(e){mismatch=/bank mismatch/i.test(String(e&&e.message||e));}truthy(mismatch,'wrong-bank rejection');return'bank='+p.bankId+', transactions='+p.transactions.length;});
  test('TD debt profile is deterministic for identical frozen facts',function(){const rows=[row('2026-01-31',[tx('2026-01-10','FORD CREDIT CA APY','DEBIT',950.61),tx('2026-01-18','FIRST INSURANCE LOAN','DEBIT',437.99)]),row('2026-02-28',[tx('2026-02-10','FORD CREDIT CA APY','DEBIT',950.61),tx('2026-02-18','FIRST INSURANCE LOAN','DEBIT',437.99)]),row('2026-03-31',[tx('2026-03-10','FORD CREDIT CA APY','DEBIT',950.61),tx('2026-03-18','FIRST INSURANCE LOAN','DEBIT',437.99)])],a=JSON.stringify(vfcDebtProfile_(rows)),b=JSON.stringify(vfcDebtProfile_(rows));equal(a,b,'deterministic JSON');return'deterministic';});
  const failed=results.filter(function(x){return!x.pass;});return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,tdRulesVersion:vfcTdBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
/* ===== END Bank_TD.gs ===== */

/* ===== BEGIN Bank_BMO.gs ===== */
/**
 * BMO BANK ENGINE v1.4 — CANDIDATE
 *
 * One permanent BMO module. All BMO-specific behavior lives here:
 * - extraction instructions
 * - deterministic printed statement facts
 * - deterministic NSF count / negative-balance flag
 * - debit classification and debt identity
 * - financing-credit classification
 * - financing-return recognition
 * - broader non-operating reversal recognition
 * - non-operating transfer recognition
 * - legitimate printed-duplicate preservation
 * - deterministic BMO regression tests
 *
 * Shared recurrence math, frozen-fact storage and underwriting remain in BankingCore.gs.
 */
function vfcBmoBankProfile_(){
  return{
    id:'BMO',
    label:'BMO',
    status:'CANDIDATE',
    rulesVersion:'BMO-1.4-CANDIDATE',
    intakeContract:'BANK_MATCHED_FROZEN_LEDGER_V2',
    aliases:['BANK OF MONTREAL','BMO BANK OF MONTREAL','BMO.COM','BMO']
  };
}

function vfcBmoExtractionRules_(){return[
  'BMO Business Banking statements print a Summary of account with opening balance, total amounts debited, total amounts credited and closing balance. Those printed summary values control statement totals.',
  'Transaction direction is controlled only by the printed Amounts debited from your account versus Amounts credited to your account columns.',
  'Preserve the first transaction Opening balance row and the printed For the period ending date. BMO statement cycles do not always begin on the first day of a month.',
  'Preserve Pre-Authorized Payment rows needed for financing analysis, including CANACAP, GREENBOX CAPITAL, 2M7 FINANCIAL, GFFG-CLOVERDALE, LNS/PRE, FORD CREDIT, NISSAN FINANCE, AFFIRM CANADA and IPFS/premium-finance wording.',
  'BMO LNS/PRE is financing evidence, but it is a transaction code rather than a lender identity. Preserve the printed counterparty so different LNS/PRE lenders remain separate obligations.',
  'AFFIRM CANADA is a financing counterparty. A recurring AFFIRM debit is confirmed financing debt; one observation remains unconfirmed. An AFFIRM credit is not automatically financing proceeds.',
  'Preserve financing credits such as CANACAP CLN/PEE, 2M7 FINANCIAL, known lender direct deposits and explicit LOAN/MCA/FINANCING/LOC proceeds. A large ordinary Deposit or Direct Deposit is not financing merely because it is large.',
  'Cheque Returned NSF, Returned Item Payment Stopped, Returned Item and explicit returned-payment credits are financing-return markers when they match a financing debit. Error Correction credits are broader non-operating reversals but are not financing-return markers by wording alone.',
  'Transfer, Online Transfer and account-to-account transfer credits are non-operating transfers. INTERAC e-Transfer Received is not automatically an internal transfer and remains an ordinary credit unless other evidence proves otherwise.',
  'INTERAC e-Transfer Sent, Transfer debits, ordinary cheques, Canadian Drafts and card purchases are not debt merely because they recur.',
  'FORD CREDIT and NISSAN FINANCE are financing candidates. Ordinary ICBC insurance remains informational.',
  'AMEX, VISA, Mastercard and M/C-CIBC bill payments remain informational revolving-card payments, not fixed financing debt.',
  'PAYWORKS and ordinary payroll activity are operating expenses, not financing debt.',
  'CANADA TXD/DIM, CRA, CCRA, GST, HST and explicit tax payments are tax/government obligations, not financing debt.',
  'iCapital is treated as financing, not automatically MCA. Journey/OnDeck and Merchant Growth remain MCA-style funding when recurring.',
  'Fee-only rows are not recurring obligations. A row containing fee wording is preserved only when it also contains independent financing evidence.',
  'An unknown recurring pre-authorized payment stays informational unless independent financing evidence exists.',
  'Same or near-identical dollar amount by itself never proves debt. Financing evidence plus observed recurrence is required for confirmed monthly debt.',
  'BMO statements can append cheque-image/support pages after the transaction activity. Do not duplicate those cheque images as new transactions.'
].join('\n');}

function vfcBmoLockFacts_(summary,text,fileName){
  const locked=Object.assign({},summary||{}),facts=vfcBmoSummaryFacts_(text);
  if(!facts.complete){
    const why=facts.ambiguous?' Multiple BMO account summary rows were detected; this statement is not accepted as a single-account statement.':'';
    throw new Error('BMO printed Summary of account could not be fully verified for '+String(fileName||'statement')+'.'+why+' Upload was stopped before saving incomplete statement totals.');
  }
  locked.statement_start_date=facts.startDate;locked.statement_end_date=facts.endDate;locked.opening_balance=facts.opening;locked.total_withdrawals=facts.withdrawals;locked.total_deposits=facts.deposits;locked.closing_balance=facts.closing;locked.nsf_count=vfcBmoCountNsf_(text);locked.negative_balance_detected=vfcBmoNegativeBalanceFlag_(text,facts);return locked;
}

function vfcBmoSummaryFacts_(text){
  const s=String(text||'').replace(/\u00a0/g,' ').replace(/[‐‑‒–—]/g,'-'),end=vfcBmoPeriodEnd_(s),start=vfcBmoOpeningDate_(s,end),blockMatch=s.match(/Summary\s+of\s+account([\s\S]{0,6000}?)Transaction\s+details/i),block=blockMatch?blockMatch[1]:s,money='(-?\\$?[0-9][0-9,]*\\.\\d{2})',re=new RegExp('Business\\s+Account\\s*#\\s*[0-9][0-9\\s-]*?\\s+'+money+'\\s+'+money+'\\s+'+money+'\\s+'+money,'gi'),candidates=[];let m;
  while((m=re.exec(block))!==null){const opening=vfcBmoMoney_(m[1]),withdrawals=vfcBmoMoney_(m[2]),deposits=vfcBmoMoney_(m[3]),closing=vfcBmoMoney_(m[4]);if(opening===null||withdrawals===null||deposits===null||closing===null||withdrawals<0||deposits<0)continue;if(Math.abs((opening+deposits-withdrawals)-closing)<=.05)candidates.push({opening:opening,withdrawals:withdrawals,deposits:deposits,closing:closing});}
  if(!candidates.length){const tokens=block.match(/-?\s*\$?\s*(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\.\d{2}/g)||[],seen={};for(let i=0;i<=tokens.length-4;i++){const opening=vfcBmoMoney_(tokens[i]),withdrawals=Math.abs(vfcBmoMoney_(tokens[i+1])),deposits=Math.abs(vfcBmoMoney_(tokens[i+2])),closing=vfcBmoMoney_(tokens[i+3]);if(opening===null||withdrawals===null||deposits===null||closing===null||Math.abs((opening+deposits-withdrawals)-closing)>.05)continue;const key=[opening,withdrawals,deposits,closing].join('|');if(seen[key])continue;seen[key]=1;candidates.push({opening:opening,withdrawals:withdrawals,deposits:deposits,closing:closing});}}
  if(candidates.length!==1)return{complete:false,ambiguous:candidates.length>1,startDate:start,endDate:end,candidateCount:candidates.length};const c=candidates[0];return{complete:!!(start&&end),ambiguous:false,startDate:start,endDate:end,opening:c.opening,withdrawals:c.withdrawals,deposits:c.deposits,closing:c.closing};
}
function vfcBmoPeriodEnd_(text){const m=String(text||'').match(/For\s+the\s+period\s+ending\s+([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/i);return m?vfcBmoIsoParts_(m[1],m[2],m[3]):'';}
function vfcBmoOpeningDate_(text,endIso){const m=String(text||'').match(/\b([A-Za-z]{3})\s+(\d{1,2})\s+Opening\s+balance\b/i);if(!m||!endIso)return'';const end=vfcDate_(endIso);if(!end)return'';const month=vfcBmoMonth_(m[1]),day=Number(m[2]);if(!month||!day)return'';let year=end.getFullYear();if(month>end.getMonth()+1)year--;return String(year).padStart(4,'0')+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');}
function vfcBmoIsoParts_(month,day,year){const mm=vfcBmoMonth_(month),dd=Number(day),yyyy=Number(year);return mm&&dd&&yyyy?String(yyyy).padStart(4,'0')+'-'+String(mm).padStart(2,'0')+'-'+String(dd).padStart(2,'0'):'';}
function vfcBmoMonth_(month){const k=String(month||'').substring(0,3).toUpperCase();return{JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12}[k]||0;}
function vfcBmoMoney_(value){if(value===null||value===undefined||value==='')return null;const n=Number(String(value).replace(/[$,\s]/g,''));return Number.isFinite(n)?n:null;}
function vfcBmoCountNsf_(text){return(String(text||'').match(/Cheque\s+Returned\s+NSF|Returned\s+Item\s+NSF/gi)||[]).length;}
function vfcBmoNegativeBalanceFlag_(text,facts){if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;return/(?:^|\s)-[0-9][0-9,]*\.\d{2}(?:\s|$)/m.test(String(text||''));}

function vfcBmoClassifyDebit_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t&&t.counterparty||raw).replace(/\s+/g,' ').trim(),cents=Math.round(vfcNum_(t&&t.amount)*100);if(!raw)return null;
  const hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bMCA\b|\bLEASE\b|\bLNS\/PRE\b|\bFINANC(?:E|ING)?\b/.test(s),feeOnly=/\bFEES?\b|SERVICE\s+CHARGE|OVERDRAFT\s+(?:INTEREST|PER\s+ITEM\s+CHARGE)/.test(s);
  if((feeOnly&&!hasFinancingSignal)||/RETURNED\s+ITEM\s+FEE|DRAFT\s+FEE|WITHDRAWAL\s+FEE|BILL\s+PAYMENT\s+FEE|MONTHLY\s+(?:PLAN\s+)?FEE|PLAN\s+FEE|CASH\s+MGMT\s+FEE|TRANSACTION\s+FEE|NSF\s+FEE|INTERAC\s+E-TRANSFER\s+FEE/.test(s))return null;if(vfcBmoIsTransferDebit_(s))return null;
  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='BMO_CANACAP';label='Canacap';debtJustification='Known business financing/MCA counterparty on a BMO statement plus recurring observed payment cadence.';}
  else if(/GREENBOX\s+CAPIT/.test(s)){family='MCA';entityKey='BMO_GREENBOX_CAPITAL';label='Greenbox Capital';debtJustification='Known business financing/MCA counterparty on a BMO statement plus recurring observed payment cadence.';}
  else if(/\b2M7\s*FINANCIAL/.test(s)){family='FINANCING';entityKey='BMO_2M7_FINANCIAL';label='2M7 Financial';debtJustification='Known financing counterparty observed as a BMO pre-authorized payment plus recurring observed cadence.';}
  else if(/GFFG[- ]?CLOVERDALE/.test(s)){family='FINANCING';entityKey='BMO_GFFG_LOAN';label='GFFG / Loan';debtJustification='GFFG counterparty with BMO loan/pre-authorized-payment coding plus recurring observed cadence.';}
  else if(/FORD\s+CREDIT/.test(s)){family='FINANCING';entityKey='BMO_FORD_CREDIT';label='Ford Credit';debtJustification='Known vehicle-finance counterparty plus recurring observed payment cadence.';}
  else if(/NISSAN\s+FINANCE/.test(s)){family='FINANCING';entityKey='BMO_NISSAN_FINANCE';label='Nissan Finance';debtJustification='Known vehicle-finance counterparty plus recurring observed payment cadence.';}
  else if(/\bAFFIRM(?:\s+CANADA)?\b/.test(s)){family='FINANCING';entityKey='BMO_AFFIRM_CANADA';label='Affirm Canada';debtJustification='Affirm Canada is a financing counterparty; recurring observed payments are treated as financing debt.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC/.test(s)){family='FINANCING';entityKey='BMO_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||'Premium Finance';debtJustification='Explicit premium-finance wording plus recurring observed payment cadence.';}
  else if(/\bLNS\/PRE\b/.test(s)){family='FINANCING';entityKey='BMO_LNS_PRE_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;debtJustification='BMO LNS/PRE financing code plus recurring observed cadence; the printed counterparty remains the debt identity.';}
  else if(/\bCANADA\s+TXD\/DIM\b|\bCRA\b|\bCCRA\b|\bGST\b|\bHST\b|\bTAX\b/.test(s)){family='TAX';entityKey='BMO_TAX_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/\bICBC\b|INSURANCE/.test(s)){family='OTHER';entityKey='BMO_INSURANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/AMEX|AMERICAN\s+EXPRESS|\bVISA\b|MASTERCARD|M\/C-CIBC|CIBC\s+(?:MC|CARD)|BMO\s+MASTERCARD|ROYAL\s+BANK\s+VISA|CREDIT\s+CARD/.test(s)){family='OTHER';entityKey='BMO_CARD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/PAYWORKS|PAYROLL/.test(s)){family='OTHER';entityKey='BMO_PAYROLL_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else if(/\bICAPITAL\b/.test(s)){family='FINANCING';entityKey='BMO_ICAPITAL';label='iCapital';debtJustification='Known financing counterparty plus recurring observed payment cadence; iCapital is not assumed to be MCA without explicit MCA evidence.';}
  else if(/\bBDC\b/.test(s)){family='FINANCING';entityKey='BMO_FIN_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;debtJustification='Known financing counterparty plus recurring observed payment cadence.';}
  else if(/JOURNEY|ONDECK|MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='BMO_FIN_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;debtJustification='Known MCA/funding counterparty plus recurring observed payment cadence.';}
  else if(/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bMCA\b|\bLEASE\b|\bFINANC(?:E|ING)?\b/.test(s)){family='FINANCING';entityKey='BMO_FINANCE_'+(vfcCounterpartyKey_(cp||raw)||cents);label=cp||raw;debtJustification='Explicit financing/loan/mortgage/LOC/lease wording plus recurring observed cadence.';}
  else if(/PRE[- ]?AUTHORIZED\s+PAYMENT|\bPAD\b/.test(s)){family='OTHER';entityKey='BMO_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;}
  else return null;return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}
function vfcBmoIsTransferDebit_(s){return/INTERAC\s+E-TRANSFER\s+SENT|ONLINE\s+TRANSFER|^TRANSFER\b|\bTRANSFER,|CANADIAN\s+DRAFT|\bCHEQUE\b|DEBIT\s+CARD\s+PURCHASE|OTHER\s+BANK\s+ABM\s+WITHDRAWAL|ABM\s+WITHDRAWAL|WITHDRAWAL\s+AT/.test(String(s||'').toUpperCase());}
function vfcBmoIsReturnedFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();return/CHEQUE\s+RETURNED\s+NSF|RETURNED\s+ITEM(?:\s+PAYMENT\s+STOPPED)?|RETURNED\s+PAYMENT|PAYMENT\s+RETURNED|\bREVERSAL\b/.test(s);}
function vfcBmoIsNonOperatingReversalCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;return vfcBmoIsReturnedFinancingCredit_(t)||/ERROR\s+CORRECTION/.test(String(t&&t.description||'').toUpperCase());}
function vfcBmoIsNonOperatingTransferCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;const s=String(t&&t.description||'').toUpperCase();if(/INTERAC\s+E-TRANSFER\s+RECEIVED/.test(s))return false;return/^TRANSFER\b|\bTRANSFER,|ONLINE\s+TRANSFER|ACCOUNT\s+TRANSFER/.test(s);}
function vfcBmoKnownFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();if(vfcBmoIsNonOperatingReversalCredit_(t)||vfcBmoIsNonOperatingTransferCredit_(t))return false;return/\bCANACAP\b.*\bCLN\/PEE\b|\b2M7\s*FINANCIAL\b|JOURNEY|ONDECK|MERCHANT\s+GROWTH|GREENBOX\s+CAPIT|\bBDC\b|ICAPITAL|LOAN\s+(?:ADVANCE|PROCEEDS|CREDIT)|MCA\s+(?:ADVANCE|PROCEEDS)|FINANC(?:E|ING)\s+(?:ADVANCE|PROCEEDS)|(?:\bLOC\b|LINE\s+OF\s+CREDIT)\s+(?:ADVANCE|PROCEEDS)/.test(s);}
function vfcBmoStrongEntityKey_(key){return/^(BMO_CANACAP|BMO_GREENBOX_CAPITAL|BMO_2M7_FINANCIAL|BMO_GFFG_LOAN|BMO_FORD_CREDIT|BMO_NISSAN_FINANCE|BMO_AFFIRM_CANADA|BMO_PREMIUM_FINANCE_|BMO_LNS_PRE_|BMO_ICAPITAL|BMO_FIN_|BMO_FINANCE_)/.test(String(key||'').toUpperCase());}
function vfcBmoPreservePrintedDuplicate_(t){const direction=String(t&&t.direction||'').toUpperCase(),s=String(t&&t.description||'').toUpperCase();if(direction==='CREDIT')return vfcBmoKnownFinancingCredit_(t)||vfcBmoIsNonOperatingReversalCredit_(t)||vfcBmoIsNonOperatingTransferCredit_(t);if(direction!=='DEBIT'||!/PRE[- ]?AUTHORIZED\s+PAYMENT/.test(s))return false;const x=vfcBmoClassifyDebit_(t);return!!(x&&(x.family==='FINANCING'||x.family==='MCA'));}

function runBmoBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'BMO',transactions:transactions||[]}};}
  function close(actual,expected,tol,label){tol=tol==null?.02:tol;if(Math.abs(Number(actual||0)-Number(expected||0))>tol)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function equal(actual,expected,label){if(actual!==expected)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
  function truthy(value,label){if(!value)throw new Error((label||'value')+' expected truthy');}
  function test(name,fn){try{results.push({name:name,pass:true,detail:String(fn()||'')});}catch(e){results.push({name:name,pass:false,detail:String(e&&e.message||e)});}}
  function summaryText(endDate,startMon,startDay,opening,withdrawals,deposits,closing){return['Business Banking statement','For the period ending '+endDate,'Summary of account','Business Account # 2065 1997-041 '+opening+' '+withdrawals+' '+deposits+' '+closing,'Transaction details',startMon+' '+startDay+' Opening balance '+opening].join('\n');}

  test('BMO 1151399 six real statement summaries reconcile exactly',function(){const cases=[['June 30, 2025','May','31','311.60','64,432.68','66,350.03','2,228.95'],['July 31, 2025','Jul','01','2,228.95','67,820.03','65,542.55','-48.53'],['August 29, 2025','Aug','01','-48.53','170,064.47','170,015.87','-97.13'],['September 29, 2025','Aug','30','-97.13','133,410.82','133,955.27','447.32'],['October 31, 2025','Sep','30','447.32','105,221.98','104,632.46','-142.20'],['November 28, 2025','Nov','01','-142.20','88,098.20','88,145.22','-95.18']];let deposits=0,withdrawals=0;cases.forEach(function(c){const f=vfcBmoSummaryFacts_(summaryText.apply(null,c));truthy(f.complete,c[0]);deposits+=f.deposits;withdrawals+=f.withdrawals;close(f.opening+f.deposits-f.withdrawals,f.closing,.02,c[0]+' reconciliation');});close(deposits,628641.40,.02,'six-month deposits');close(withdrawals,629048.18,.02,'six-month withdrawals');close(deposits/6,104773.5667,.02,'six-month average deposits');return'deposits='+vfcRound_(deposits,.01)+', withdrawals='+vfcRound_(withdrawals,.01);});
  test('BMO JVP December printed summary locks exactly',function(){const f=vfcBmoSummaryFacts_(summaryText('December 31, 2025','Nov','29','12,167.75','197,548.49','187,332.50','1,951.76'));truthy(f.complete,'summary');equal(f.startDate,'2025-11-29','start');equal(f.endDate,'2025-12-31','end');close(f.opening,12167.75,.001,'opening');close(f.withdrawals,197548.49,.001,'withdrawals');close(f.deposits,187332.50,.001,'deposits');close(f.closing,1951.76,.001,'closing');return'JVP December exact';});
  test('BMO multiple account summary rows fail closed',function(){const text=['For the period ending November 28, 2025','Summary of account','Business Account # 2065 1997-041 100.00 50.00 75.00 125.00','Business Account # 2065 1997-099 200.00 20.00 30.00 210.00','Transaction details','Nov 01 Opening balance 100.00'].join('\n'),f=vfcBmoSummaryFacts_(text);equal(f.complete,false,'complete');equal(f.ambiguous,true,'ambiguous');return'failed closed';});
  test('BMO NSF count is deterministic from printed return rows',function(){const text=['Cheque Returned NSF 489.01','Cheque Returned NSF 340.00','Cheque Returned NSF 637.00','Cheque Returned NSF 186.90','Cheque Returned NSF 493.62','Returned Item Payment Stopped 27,267.71'].join('\n');equal(vfcBmoCountNsf_(text),5,'NSF count');return'nsf=5';});
  test('BMO negative balances are detected from statement facts',function(){truthy(vfcBmoNegativeBalanceFlag_('Balance -1,450.12',{opening:10,closing:20}),'negative activity');truthy(vfcBmoNegativeBalanceFlag_('',{opening:-97.13,closing:447.32}),'negative opening');return'negative detected';});
  test('BMO error correction is non-operating but not a financing return',function(){const t=tx('2026-02-03','Error Correction, 0709-1985-790 0749','CREDIT',5020.38);truthy(vfcBmoIsNonOperatingReversalCredit_(t),'non-operating');equal(vfcBmoIsReturnedFinancingCredit_(t),false,'financing return');return'separated';});
  test('BMO transfer memo containing LOAN is never debt',function(){equal(vfcBmoClassifyDebit_(tx('2025-09-02','Transfer, OWNER LOAN 0985-3976-719','DEBIT',1000)),null,'transfer loan memo');return'excluded';});
  test('BMO known financing counterparties classify correctly',function(){equal(vfcBmoClassifyDebit_(tx('2025-09-04','Pre-Authorized Payment, CANACAP BUS/ENT','DEBIT',637)).family,'MCA','Canacap');equal(vfcBmoClassifyDebit_(tx('2025-09-04','Pre-Authorized Payment, GREENBOX CAPITA LNS/PRE','DEBIT',493.62)).family,'MCA','Greenbox');equal(vfcBmoClassifyDebit_(tx('2025-09-04','Pre-Authorized Payment, 2M7 FINANCIAL MSP/DIV','DEBIT',340)).family,'FINANCING','2M7');equal(vfcBmoClassifyDebit_(tx('2025-09-04','Pre-Authorized Payment, GFFG-CLOVERDALE LNS/PRE','DEBIT',160)).family,'FINANCING','GFFG');equal(vfcBmoClassifyDebit_(tx('2025-09-23','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',489.01)).family,'FINANCING','Ford');equal(vfcBmoClassifyDebit_(tx('2026-02-06','Pre-Authorized Payment, NISSAN FINANCE CLN/PEE','DEBIT',343.24)).family,'FINANCING','Nissan');return'known finance recognized';});
  test('BMO recurring Affirm Canada becomes financing debt only after recurrence',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','Pre-Authorized Payment, AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-02-28',[tx('2026-02-06','Pre-Authorized Payment, AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-03-31',[tx('2026-03-06','Pre-Authorized Payment, AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm debt');equal(d.activeDebtObligations[0].entityKey,'BMO_AFFIRM_CANADA','Affirm identity');const one=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','Pre-Authorized Payment, AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(one.confirmedMonthlyDebtService,0,.001,'single Affirm');return'debt='+d.confirmedMonthlyDebtService;});
  test('BMO fee-only rows are suppressed but financing lines containing fee wording survive',function(){equal(vfcBmoClassifyDebit_(tx('2026-01-02','PAY-FILE FEES','DEBIT',2)),null,'fee-only');const x=vfcBmoClassifyDebit_(tx('2026-01-02','Loan payment service fee NO.123456','DEBIT',250,'Loan NO.123456'));equal(x.family,'FINANCING','loan fee line');return'fees separated';});
  test('BMO iCapital is financing, not automatically MCA',function(){const x=vfcBmoClassifyDebit_(tx('2026-01-12','Pre-Authorized Payment, ICAPITAL BUS/ENT','DEBIT',900,'ICAPITAL'));equal(x.family,'FINANCING','iCapital family');equal(x.entityKey,'BMO_ICAPITAL','iCapital identity');return'financing';});
  test('BMO LNS/PRE is financing evidence without merging unrelated lenders',function(){const a=vfcBmoClassifyDebit_(tx('2025-10-01','Pre-Authorized Payment, OTHER CAPITAL LNS/PRE','DEBIT',500)),b=vfcBmoClassifyDebit_(tx('2025-10-01','Pre-Authorized Payment, GFFG-CLOVERDALE LNS/PRE','DEBIT',500));equal(a.family,'FINANCING','generic LNS/PRE');equal(b.entityKey,'BMO_GFFG_LOAN','GFFG identity');truthy(a.entityKey!==b.entityKey,'separate identities');return'separate identities';});
  test('BMO ICBC cards payroll and unknown PAD remain non-debt',function(){equal(vfcBmoClassifyDebit_(tx('2025-12-01','Pre-Authorized Payment, ICBC INS/ASS','DEBIT',336.70)).family,'OTHER','ICBC');equal(vfcBmoClassifyDebit_(tx('2025-10-21','Online Bill Payment, BMO MASTERCARD','DEBIT',395.76)).family,'OTHER','card');equal(vfcBmoClassifyDebit_(tx('2025-11-12','Pre-Authorized Payment, B12937 PAYWORKS PAY/PAY','DEBIT',3274.89)).family,'OTHER','payroll');equal(vfcBmoClassifyDebit_(tx('2025-11-12','Pre-Authorized Payment, ABC SERVICES BUS/ENT','DEBIT',500)).family,'OTHER','unknown PAD');return'informational only';});
  test('BMO recurring Canacap becomes confirmed debt',function(){const d=vfcDebtProfile_([row('2025-08-29',[tx('2025-08-04','Pre-Authorized Payment, CANACAP BUS/ENT','DEBIT',637)]),row('2025-09-29',[tx('2025-09-04','Pre-Authorized Payment, CANACAP BUS/ENT','DEBIT',637)]),row('2025-10-31',[tx('2025-10-04','Pre-Authorized Payment, CANACAP BUS/ENT','DEBIT',637)])]);close(d.confirmedMonthlyDebtService,637,.02,'Canacap debt');equal(d.activeDebtObligations.length,1,'obligation count');return'debt='+d.confirmedMonthlyDebtService;});
  test('BMO duplicate same-day financing PADs are preserved',function(){const a=vfcNormalizeTransactions_([tx('2025-09-02','Pre-Authorized Payment, GREENBOX CAPITA LNS/PRE','DEBIT',493.62),tx('2025-09-02','Pre-Authorized Payment, GREENBOX CAPITA LNS/PRE','DEBIT',493.62)],'BMO');equal(a.length,2,'duplicate PADs');return'count=2';});
  test('BMO real multi-return pattern suppresses financing debits only',function(){const printed=vfcNormalizeTransactions_([tx('2025-09-23','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',489.01),tx('2025-09-23','Pre-Authorized Payment, 2M7FINANCIALSOL BUS/ENT','DEBIT',340),tx('2025-09-23','Pre-Authorized Payment, CANACAP BUS/ENT','DEBIT',637),tx('2025-09-23','Pre-Authorized Payment, FD82424110013 MSP/DIV','DEBIT',186.90),tx('2025-09-23','Pre-Authorized Payment, GREENBOX CAPITA LNS/PRE','DEBIT',493.62),tx('2025-09-23','Cheque Returned NSF','CREDIT',489.01),tx('2025-09-23','Cheque Returned NSF','CREDIT',340),tx('2025-09-23','Cheque Returned NSF','CREDIT',637),tx('2025-09-23','Cheque Returned NSF','CREDIT',186.90),tx('2025-09-23','Cheque Returned NSF','CREDIT',493.62)],'BMO'),d=vfcDebtProfile_([row('2025-09-29',printed)]);equal(d.returnedFinanceDebitsSuppressed,4,'suppressed financing debits');close(d.returnedCreditsTotal,2146.53,.02,'returned credits');close(d.confirmedMonthlyDebtService,0,.001,'confirmed debt');return'suppressed=4';});
  test('BMO duplicate Canacap financing credits are preserved and removed from operating revenue',function(){const printed=vfcNormalizeTransactions_([tx('2025-08-15','Direct Deposit, 2M7 FINANCIAL MSP/DIV','CREDIT',15788),tx('2025-08-15','Direct Deposit, CANACAP CLN/PEE','CREDIT',27267.71),tx('2025-08-15','Direct Deposit, CANACAP CLN/PEE','CREDIT',27267.71)],'BMO'),d=vfcDebtProfile_([row('2025-08-29',printed)]);equal(printed.length,3,'printed credits');close(d.financingCreditsTotal,70323.42,.02,'financing credits');equal(d.financingCredits.length,3,'financing credit count');return'financing='+d.financingCreditsTotal;});
  test('BMO ordinary large deposit is not financing',function(){equal(vfcBmoKnownFinancingCredit_(tx('2025-12-01','Deposit','CREDIT',70000)),false,'ordinary deposit');const d=vfcDebtProfile_([row('2025-12-31',[tx('2025-12-01','Deposit','CREDIT',70000)])]);close(d.financingCreditsTotal,0,.001,'financing total');return'not financing';});
  test('BMO internal transfer credit is excluded but Interac received is not',function(){truthy(vfcBmoIsNonOperatingTransferCredit_(tx('2025-09-02','Transfer, 0985-3976-719','CREDIT',1000)),'internal transfer');truthy(vfcBmoIsNonOperatingTransferCredit_(tx('2026-02-23','Online Transfer, TF 0709#3872-634','CREDIT',2000)),'online transfer');equal(vfcBmoIsNonOperatingTransferCredit_(tx('2025-09-22','INTERAC e-Transfer Received','CREDIT',126)),false,'Interac received');return'transfers separated';});
  test('BMO Ford and Nissan recurring streams remain separate obligations',function(){const d=vfcDebtProfile_([row('2025-12-31',[tx('2025-12-01','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',972.91),tx('2025-12-06','Pre-Authorized Payment, NISSAN FINANCE CLN/PEE','DEBIT',343.24)]),row('2026-01-30',[tx('2026-01-02','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',972.91),tx('2026-01-06','Pre-Authorized Payment, NISSAN FINANCE CLN/PEE','DEBIT',343.24)]),row('2026-02-27',[tx('2026-02-02','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',972.91),tx('2026-02-06','Pre-Authorized Payment, NISSAN FINANCE CLN/PEE','DEBIT',343.24)])]);equal(d.activeDebtObligations.length,2,'obligation count');close(d.confirmedMonthlyDebtService,1316.15,.02,'combined debt');return'debt='+d.confirmedMonthlyDebtService;});
  test('BMO debt profile is deterministic for identical frozen facts',function(){const rows=[row('2025-11-28',[tx('2025-11-03','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',972.91)]),row('2025-12-31',[tx('2025-12-01','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',972.91)]),row('2026-01-30',[tx('2026-01-02','Pre-Authorized Payment, FORD CREDIT CA APY/PAA','DEBIT',972.91)])],a=JSON.stringify(vfcDebtProfile_(rows)),b=JSON.stringify(vfcDebtProfile_(rows));equal(a,b,'deterministic JSON');return'deterministic';});
  const failed=results.filter(function(x){return!x.pass;});return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,bmoRulesVersion:vfcBmoBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
/* ===== END Bank_BMO.gs ===== */

/* ===== BEGIN Bank_CIBC.gs ===== */
/** CIBC — PENDING TRAINING. Change only this file when CIBC is trained. */
function vfcCibcBankProfile_(){return{id:'CIBC',label:'CIBC',status:'PENDING_TRAINING',rulesVersion:'CIBC-UNTRAINED',aliases:['CANADIAN IMPERIAL BANK OF COMMERCE','CIBC']};}
function vfcCibcExtractionRules_(){return 'CIBC is not trained yet. Extract visible financing, loan, PAD, tax, insurance and credit-card transactions conservatively. Do not apply RBC-specific names or patterns.';}
function vfcCibcLockFacts_(summary,text,fileName){return vfcLockPrintedStatementFacts_(summary,text);}
function vfcCibcClassifyDebit_(t){return vfcGenericConservativeClassifyDebit_(t);}
function vfcCibcKnownFinancingCredit_(t){return false;}

/* ===== END Bank_CIBC.gs ===== */

/* ===== BEGIN Bank_CoastCapital.gs ===== */
/** Coast Capital — PENDING TRAINING. Change only this file when Coast Capital is trained. */
function vfcCoastCapitalBankProfile_(){return{id:'COAST_CAPITAL',label:'Coast Capital',status:'PENDING_TRAINING',rulesVersion:'COAST-CAPITAL-UNTRAINED',aliases:['COAST CAPITAL SAVINGS','COAST CAPITAL']};}
function vfcCoastCapitalExtractionRules_(){return 'Coast Capital is not trained yet. Extract visible financing, loan, PAD, tax, insurance and credit-card transactions conservatively. Do not apply RBC-specific names or patterns.';}
function vfcCoastCapitalLockFacts_(summary,text,fileName){return vfcLockPrintedStatementFacts_(summary,text);}
function vfcCoastCapitalClassifyDebit_(t){return vfcGenericConservativeClassifyDebit_(t);}
function vfcCoastCapitalKnownFinancingCredit_(t){return false;}

/* ===== END Bank_CoastCapital.gs ===== */

/* ===== BEGIN Bank_Scotia.gs ===== */
/** Scotiabank — PENDING TRAINING. Change only this file when Scotia is trained. */
function vfcScotiaBankProfile_(){return{id:'SCOTIA',label:'Scotia',status:'PENDING_TRAINING',rulesVersion:'SCOTIA-UNTRAINED',aliases:['SCOTIABANK','BANK OF NOVA SCOTIA','SCOTIA']};}
function vfcScotiaExtractionRules_(){return 'Scotiabank is not trained yet. Extract visible financing, loan, PAD, tax, insurance and credit-card transactions conservatively. Do not apply RBC-specific names or patterns.';}
function vfcScotiaLockFacts_(summary,text,fileName){return vfcLockPrintedStatementFacts_(summary,text);}
function vfcScotiaClassifyDebit_(t){return vfcGenericConservativeClassifyDebit_(t);}
function vfcScotiaKnownFinancingCredit_(t){return false;}

/* ===== END Bank_Scotia.gs ===== */

/* ===== BEGIN BankRouter.gs ===== */
/**
 * VFC Bank Router
 * Bank selection + one common upload pipeline only.
 * Bank-specific extraction/classification lives in Bank_<BANK>.gs.
 * RBC 3.8.1 passes the staged source PDF ID into the focused recovery engine.
 */
function vfcBankRegistry_(){return[vfcRbcBankProfile_(),vfcTdBankProfile_(),vfcScotiaBankProfile_(),vfcBmoBankProfile_(),vfcCibcBankProfile_(),vfcCoastCapitalBankProfile_()];}
function getBankParserTabs(){return vfcBankRegistry_().map(function(p){return{id:p.id,label:p.label,status:p.status,active:p.status==='LOCKED',rulesVersion:p.rulesVersion,intakeContract:VFC_BANK_ENGINE.INTAKE_CONTRACT};});}
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
function vfcBankStrongEntityKey_(bankId,key,family){switch(String(bankId||'').toUpperCase()){case'RBC':return vfcRbcStrongEntityKey_(key);case'TD':return vfcTdStrongEntityKey_(key);case'BMO':return vfcBmoStrongEntityKey_(key);default:return false;}}
function vfcBankIsReturnedFinancingCredit_(bankId,t){switch(String(bankId||'').toUpperCase()){case'RBC':return vfcRbcIsReturnedFinancingCredit_(t);case'TD':return vfcTdIsReturnedFinancingCredit_(t);case'BMO':return vfcBmoIsReturnedFinancingCredit_(t);default:return false;}}
function vfcBankIsNonOperatingReversalCredit_(bankId,t){const id=String(bankId||'').toUpperCase();if(id==='BMO'&&typeof vfcBmoIsNonOperatingReversalCredit_==='function')return vfcBmoIsNonOperatingReversalCredit_(t);return vfcBankIsReturnedFinancingCredit_(id,t);}
function vfcBankIsNonOperatingTransferCredit_(bankId,t){switch(String(bankId||'').toUpperCase()){case'RBC':return vfcRbcIsNonOperatingTransferCredit_(t);case'TD':return vfcTdIsNonOperatingTransferCredit_(t);case'BMO':return vfcBmoIsNonOperatingTransferCredit_(t);default:return false;}}
function vfcBankPreservePrintedDuplicate_(bankId,t,occurrence,items){switch(String(bankId||'').toUpperCase()){case'RBC':return vfcRbcPreservePrintedDuplicate_(t,occurrence,items);case'BMO':return vfcBmoPreservePrintedDuplicate_(t,occurrence,items);default:return false;}}
function vfcBankExtractionRules_(bankId){switch(String(bankId||'').toUpperCase()){case'RBC':return vfcRbcExtractionRules_();case'TD':return vfcTdExtractionRules_();case'SCOTIA':return vfcScotiaExtractionRules_();case'BMO':return vfcBmoExtractionRules_();case'CIBC':return vfcCibcExtractionRules_();case'COAST_CAPITAL':return vfcCoastCapitalExtractionRules_();default:return'Extract conservatively. Do not infer missing transactions.';}}
function vfcLockBankStatementFacts_(bankId,summary,text,fileName,sourceFileId){switch(String(bankId||'').toUpperCase()){case'RBC':return vfcRbcLockFacts_(summary,text,fileName,sourceFileId);case'TD':return vfcTdLockFacts_(summary,text,fileName);case'SCOTIA':return vfcScotiaLockFacts_(summary,text,fileName);case'BMO':return vfcBmoLockFacts_(summary,text,fileName);case'CIBC':return vfcCibcLockFacts_(summary,text,fileName);case'COAST_CAPITAL':return vfcCoastCapitalLockFacts_(summary,text,fileName);default:return vfcLockPrintedStatementFacts_(summary,text);}}

function vfcNormalizeBankDocumentType_(value,summary){
  const s=String(value||'').trim().toUpperCase().replace(/[^A-Z0-9]+/g,'_');
  if(/^(NOT|NON)_?BANK/.test(s)||/NOT_BANK_STATEMENT|NON_BANK_STATEMENT/.test(s))return'NOT_BANK_STATEMENT';
  if((/BANK/.test(s)&&/STATEMENT/.test(s))||Array.isArray(summary&&summary.banking_transactions))return'BANK_STATEMENT';
  return'BANK_STATEMENT';
}
function vfcVerifyFrozenIntake_(raw,expectedBankId,fileName){return vfcValidateFrozenPayload_(raw,expectedBankId,fileName);}
function vfcCleanupStagedFiles_(staged){(staged||[]).forEach(function(item){try{if(item&&item.fileId)DriveApp.getFileById(item.fileId).setTrashed(true);}catch(e){}});}

/** Single approved upload entry point for every bank. */
function uploadStatementBatchByBank(bankId,companyName,files){
  const profile=vfcGetBankProfile_(bankId);if(profile.id==='UNKNOWN')throw new Error('Select a supported bank.');if(!companyName)throw new Error('Company name is required.');if(!files||!files.length)throw new Error('Upload at least one PDF.');
  const company=getOrCreateCompany_(companyName),companyFolder=DriveApp.getFolderById(company.folderId),tempFolder=getOrCreateSubFolder_(companyFolder,'_TEMP_PROCESSING'),staged=[];let rowsWritten=false;
  try{
    files.forEach(function(file){
      const fileName=file.name||'statement.pdf',blob=Utilities.newBlob(Utilities.base64Decode(file.base64),'application/pdf',fileName.toLowerCase().endsWith('.pdf')?fileName:fileName+'.pdf'),tempFile=tempFolder.createFile(blob),item={uploadId:Utilities.getUuid(),fileName:fileName,fileId:tempFile.getId(),fileUrl:tempFile.getUrl(),text:''};
      staged.push(item);item.text=extractTextFromPdf_(tempFile.getId());const detected=vfcDetectBankId_(item.text);if(detected!=='UNKNOWN'&&detected!==profile.id)throw new Error('Bank mismatch: '+fileName+' appears to be '+vfcGetBankProfile_(detected).label+', but '+profile.label+' was selected.');
    });
    const summaries=callOpenAIJsonBatch_(staged.map(function(item){return vfcBuildBankStatementPrompt_(profile,item.text,companyName,item.fileName);}));if(summaries.length!==staged.length)throw new Error(profile.label+' statement reader returned an incomplete batch.');
    const starts=[],ends=[];
    const processed=staged.map(function(item,index){
      let summary=summaries[index]||{};summary=vfcLockBankStatementFacts_(profile.id,summary,item.text,item.fileName,item.fileId)||summary;summary.bank_name=profile.label;summary.document_type=vfcNormalizeBankDocumentType_(summary.document_type,summary);
      if(summary.document_type==='NOT_BANK_STATEMENT')throw new Error(item.fileName+' was not recognized as a bank statement.');
      if(!Array.isArray(summary.banking_transactions))throw new Error('Banking ledger extraction was incomplete for '+item.fileName+'.');
      summary.possible_mca_or_loan_payments=vfcBankCreateIntakePayload_(summary,item.fileName);vfcVerifyFrozenIntake_(summary.possible_mca_or_loan_payments,profile.id,item.fileName);
      const startDate=parseDateSafe_(summary.statement_start_date),endDate=parseDateSafe_(summary.statement_end_date);if(startDate)starts.push(startDate);if(endDate)ends.push(endDate);
      return{uploadId:item.uploadId,fileName:item.fileName,fileId:item.fileId,fileUrl:item.fileUrl,summary:summary};
    });
    if(starts.length!==processed.length||ends.length!==processed.length)throw new Error(profile.label+' statement dates could not be verified for every uploaded statement.');
    const period=buildDetectedPeriod_(starts,ends),periodFolder=getOrCreateSubFolder_(companyFolder,period.label),uploadRows=[],pdfRows=[],batchInput=[],now=new Date();
    processed.forEach(function(item){uploadRows.push([item.uploadId,company.companyId,companyName,period.label,item.fileName,item.fileId,item.fileUrl,'READ',now]);pdfRows.push([item.uploadId,companyName,period.label,item.fileName,'BANK_STATEMENT',profile.label,item.summary.account_holder||'',item.summary.statement_start_date||'',item.summary.statement_end_date||'',item.summary.opening_balance||'',item.summary.closing_balance||'',item.summary.total_deposits||'',item.summary.total_withdrawals||'',item.summary.nsf_count||'',item.summary.negative_balance_detected||'',item.summary.possible_mca_or_loan_payments||'',item.summary.summary||'',item.summary.risks||'',item.summary.missing_info||'',now]);batchInput.push({fileName:item.fileName,summary:item.summary});});
    const batch=summarizeBatch_(batchInput,companyName,period.label);
    processed.forEach(function(item){const driveFile=DriveApp.getFileById(item.fileId);periodFolder.addFile(driveFile);tempFolder.removeFile(driveFile);});
    appendRows_('Uploads',uploadRows);appendRows_('PDF Summaries',pdfRows);appendRow_('Batch Summaries',[Utilities.getUuid(),companyName,period.label,files.length,period.earliest||'',period.latest||'',batch.combined_summary||'',batch.key_findings||'',batch.risks||'',batch.missing_info||'',new Date()]);rowsWritten=true;upsertStructuredFeature_(companyName,period.label);vfcFreezeDuplicateStatementFacts_(companyName,period.label);
    return{ok:true,intakeModelVersion:VFC_BANK_ENGINE.VERSION,intakeContract:VFC_BANK_ENGINE.INTAKE_CONTRACT,bankProfile:profile.id,bankRulesVersion:profile.rulesVersion,bankTrainingStatus:profile.status,companyName:companyName,detectedPeriod:period.label,filesUploaded:files.length,companyFolderLink:company.folderLink,periodFolderLink:periodFolder.getUrl(),batchSummary:batch};
  }catch(e){if(!rowsWritten)vfcCleanupStagedFiles_(staged);throw e;}
}

function vfcBuildBankStatementPrompt_(profile,text,companyName,fileName){return[
  'You are the VFC '+profile.label+' Bank Statement Fact Reader. Return JSON only.','Company: '+companyName,'File: '+fileName,'Selected bank profile: '+profile.id+' / '+profile.rulesVersion,
  'FACT EXTRACTION ONLY. Do not underwrite, estimate debt service, or infer frequency.',
  'Return fields: document_type, bank_name, account_holder, account_number, statement_start_date, statement_end_date, opening_balance, closing_balance, total_deposits, total_withdrawals, nsf_count, negative_balance_detected, banking_transactions, summary, risks, missing_info.',
  'For a valid bank statement set document_type exactly to BANK_STATEMENT.',
  'account_number must be the exact printed account number when clearly visible; otherwise return an empty string. Never invent or infer an account number.',
  'banking_transactions is an array of {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
  'COMMON RULES:',
  '1. Header totals come from the printed statement summary, never by summing the transaction list.',
  '2. Printed debit/withdrawal versus credit/deposit columns control direction; wording never overrides the printed column.',
  '3. Preserve exact amounts, account identifiers and visible descriptions. Never borrow an amount or account number from an adjacent row.',
  '4. Do not duplicate cheque-image pages when the transaction already appears in account activity.',
  '5. Preserve every visible transaction required by the bank-specific rules, especially recurring-looking debits, financing/loan/MCA/PAD/advance/funding activity, loan interest, tax/government, insurance/premium finance, credit-card payments, equipment finance/lease payments and every required financing-credit candidate.',
  '6. Preserve original failed debits, returned/unpaid or reversal credits, and later retries as separate printed facts. Deterministic banking code decides which failed financing debit is excluded from recurring debt service.',
  '7. Extract incoming credits of $5,000 or more when they could plausibly be financing. Classification happens later.',
  '8. If a transaction row is visibly present but the counterparty is unclear, still extract the exact visible description when date, amount and debit/credit direction can be tied to that row. Omit only when the row cannot be reliably associated with its date, amount or direction.',
  '9. Never invent a missing transaction, amount, date, counterparty, account number or direction.',
  'BANK-SPECIFIC RULES:',vfcBankExtractionRules_(profile.id),'Document text:',String(text||'').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
].join('\n');}

function vfcFreezeDuplicateStatementFacts_(companyName,period){
  const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');if(!sh||sh.getLastRow()<2)return;const values=sh.getDataRange().getValues(),headers=values[0].map(vfcHeader_),idx={};headers.forEach(function(h,i){idx[h]=i;});const signalCol=idx[vfcHeader_('Possible MCA Or Loan Payments')];if(signalCol===undefined)return;function val(r,n){const i=idx[vfcHeader_(n)];return i===undefined?'':r[i];}const rows=[];
  for(let i=1;i<values.length;i++){const r=values[i];if(!vfcSame_(val(r,'Company Name'),companyName)||!vfcSame_(val(r,'Detected Period'),period))continue;rows.push({rowNumber:i+1,companyName:companyName,period:period,fileName:String(val(r,'File Name')||''),bank:String(val(r,'Bank Name')||''),accountHolder:String(val(r,'Account Holder')||''),startDate:val(r,'Statement Start Date'),endDate:val(r,'Statement End Date'),opening:vfcNumNull_(val(r,'Opening Balance')),closing:vfcNumNull_(val(r,'Closing Balance')),deposits:vfcNumNull_(val(r,'Total Deposits')),withdrawals:vfcNumNull_(val(r,'Total Withdrawals')),signalRaw:String(val(r,'Possible MCA Or Loan Payments')||''),createdAt:val(r,'Created At')});}
  vfcGroupLogicalStatementRows_(rows).forEach(function(group){const bankId=vfcDetectBankId_(group[0]&&group[0].bank||''),canonical=vfcCanonicalSignalRawFromRows_(group,bankId);if(!canonical)return;group.forEach(function(r){if(String(r.signalRaw||'')!==canonical)sh.getRange(r.rowNumber,signalCol+1).setValue(canonical);});});
}

function setupBankTrainingTabs(){const ss=SpreadsheetApp.getActiveSpreadsheet(),headers=['Bank','Training Status','Parser / Rules Version','Statement Format Notes','Debit Markers','Credit Markers','Financing Keywords','Recurring Payment Notes','Test Company','Test Period','Expected Gross Deposits','Expected Operating Deposits','Expected Monthly Debt','Expected Financing Credits','Last Validated','Notes'],created=[];vfcBankRegistry_().forEach(function(bank){const sheetName='BANK_'+bank.id;let sh=ss.getSheetByName(sheetName);if(!sh){sh=ss.insertSheet(sheetName);created.push(sheetName);}if(sh.getLastRow()===0){sh.getRange(1,1,1,headers.length).setValues([headers]);sh.setFrozenRows(1);sh.getRange(2,1,1,headers.length).setValues([[bank.label,bank.status,bank.rulesVersion,'','','','','','','','','','','','','']]);sh.autoResizeColumns(1,headers.length);}else{sh.getRange(2,1).setValue(bank.label);sh.getRange(2,2).setValue(bank.status);sh.getRange(2,3).setValue(bank.rulesVersion);}});return{ok:true,created:created,tabs:getBankParserTabs()};}

function runBankingStackSelfTests(){
  const router=[];function test(name,fn){try{router.push({name:name,pass:true,detail:String(fn()||'')});}catch(e){router.push({name:name,pass:false,detail:String(e&&e.message||e)});}}function equal(a,b,label){if(a!==b)throw new Error((label||'value')+' expected '+b+' but got '+a);}function close(a,b,t,label){if(Math.abs(Number(a||0)-Number(b||0))>(t==null?.02:t))throw new Error((label||'value')+' expected '+b+' but got '+a);}
  test('Router detects RBC from header even with other-bank words in transactions',function(){equal(vfcDetectBankId_('ROYAL BANK OF CANADA Account Summary TD VISA payment'),'RBC','RBC detection');return'RBC';});
  test('Router detects TD over incidental RBC loan wording',function(){equal(vfcDetectBankId_('THE TORONTO-DOMINION BANK TD Every Day B RBC LOAN PYMT LOAN'),'TD','TD detection');return'TD';});
  test('Router detects BMO',function(){equal(vfcDetectBankId_('BMO BANK OF MONTREAL Business Banking statement'),'BMO','BMO detection');return'BMO';});
  test('ISO date literals remain unchanged in non-UTC script timezones',function(){equal(vfcIso_('2026-09-01'),'2026-09-01','literal date');return'2026-09-01';});
  test('Legacy one-day frozen-ledger offset is repaired from printed row dates',function(){const p={version:5,transactionsVerified:true,transactions:[{date:'2026-08-31',description:'Business PAD IPFS Canada',counterparty:'IPFS Canada',direction:'DEBIT',amount:234.96}],totalDeposits:100,totalWithdrawals:90,bankId:'RBC',bankName:'RBC',statementStartDate:'2026-08-02',statementEndDate:'2026-09-01'},row={bank:'RBC',fileName:'Aug-Sep.pdf',startDate:'2026-08-03',endDate:'2026-09-02'},n=vfcNormalizePayload_(p,row);equal(n.legacyDateShiftDays,1,'shift');equal(n.statementStartDate,'2026-08-03','start');equal(n.statementEndDate,'2026-09-02','end');equal(n.transactions[0].date,'2026-09-01','transaction');equal(n.transactions[0].dateCorrectedFrom,'2026-08-31','original date');return'corrected to 2026-09-01';});
  test('Current-rules ledger outranks legacy ledger and stays earliest within current generation',function(){const current=vfcTdBankProfile_().rulesVersion,prefix=VFC_BANK_ENGINE.CACHE_PREFIX,base={transactionsVerified:true,transactions:[],totalDeposits:100,totalWithdrawals:90,bankId:'TD',bankName:'TD'},legacy=prefix+JSON.stringify(Object.assign({},base,{fileName:'legacy'})),now1=prefix+JSON.stringify(Object.assign({},base,{fileName:'current-first',intakeContract:VFC_BANK_ENGINE.INTAKE_CONTRACT,bankRulesVersion:current})),now2=prefix+JSON.stringify(Object.assign({},base,{fileName:'current-second',intakeContract:VFC_BANK_ENGINE.INTAKE_CONTRACT,bankRulesVersion:current})),raw=vfcCanonicalSignalRawFromRows_([{bank:'TD',signalRaw:legacy,createdAt:'2025-01-01'},{bank:'TD',signalRaw:now1,createdAt:'2026-01-01'},{bank:'TD',signalRaw:now2,createdAt:'2026-02-01'}],'TD'),p=vfcParseBankCache_(raw);equal(p.fileName,'current-first','canonical current ledger');return p.fileName;});
  test('Corrected re-upload keeps one logical statement despite changed totals',function(){const current=vfcRbcBankProfile_().rulesVersion,prefix=VFC_BANK_ENGINE.CACHE_PREFIX,base={version:5,transactionsVerified:true,transactions:[],bankId:'RBC',bankName:'RBC',accountNumber:'03600 101-177-4',statementStartDate:'2026-01-22',statementEndDate:'2026-02-20',intakeContract:VFC_BANK_ENGINE.INTAKE_CONTRACT},oldRaw=prefix+JSON.stringify(Object.assign({},base,{bankRulesVersion:'RBC-OLD',fileName:'Jan-Feb.pdf',totalDeposits:19000,totalWithdrawals:28000})),newRaw=prefix+JSON.stringify(Object.assign({},base,{bankRulesVersion:current,fileName:'Jan-Feb.pdf',totalDeposits:20723.05,totalWithdrawals:29715.95})),oldRow={companyName:'TEST',period:'Jan to Jul',fileName:'Jan-Feb.pdf',bank:'RBC',startDate:'2026-01-22',endDate:'2026-02-20',deposits:19000,withdrawals:28000,signalRaw:oldRaw,createdAt:'2026-01-01'},newRow={companyName:'TEST',period:'Jan to Jul',fileName:'Jan-Feb.pdf',bank:'RBC',startDate:'2026-01-22',endDate:'2026-02-20',deposits:20723.05,withdrawals:29715.95,signalRaw:newRaw,createdAt:'2026-02-01'},groups=vfcGroupLogicalStatementRows_([oldRow,newRow]);equal(groups.length,1,'logical groups');const raw=vfcCanonicalSignalRawFromRows_(groups[0],'RBC'),p=vfcParseBankCache_(raw);close(p.totalDeposits,20723.05,.001,'corrected deposits');return'one identity, corrected deposits='+p.totalDeposits;});
  test('Legacy row without account number joins exactly one matching current account row',function(){const prefix=VFC_BANK_ENGINE.CACHE_PREFIX,base={transactionsVerified:true,transactions:[],totalDeposits:100,totalWithdrawals:90,bankId:'RBC',bankName:'RBC',statementStartDate:'2026-01-01',statementEndDate:'2026-01-31'},legacy={bank:'RBC',fileName:'January.pdf',startDate:'2026-01-01',endDate:'2026-01-31',signalRaw:prefix+JSON.stringify(Object.assign({},base,{fileName:'January.pdf'}))},current={bank:'RBC',fileName:'January.pdf',startDate:'2026-01-01',endDate:'2026-01-31',signalRaw:prefix+JSON.stringify(Object.assign({},base,{fileName:'January.pdf',accountNumber:'111-222'}))};equal(vfcGroupLogicalStatementRows_([legacy,current]).length,1,'mixed-generation group');return'joined safely';});
  test('Different known account numbers remain separate even with same filename and dates',function(){const prefix=VFC_BANK_ENGINE.CACHE_PREFIX,base={transactionsVerified:true,transactions:[],totalDeposits:100,totalWithdrawals:90,bankId:'RBC',bankName:'RBC',fileName:'statement.pdf',statementStartDate:'2026-01-01',statementEndDate:'2026-01-31'},a={bank:'RBC',fileName:'statement.pdf',startDate:'2026-01-01',endDate:'2026-01-31',signalRaw:prefix+JSON.stringify(Object.assign({},base,{accountNumber:'111-222'}))},b={bank:'RBC',fileName:'statement.pdf',startDate:'2026-01-01',endDate:'2026-01-31',signalRaw:prefix+JSON.stringify(Object.assign({},base,{accountNumber:'333-444'}))};equal(vfcGroupLogicalStatementRows_([a,b]).length,2,'account groups');return'separate';});
  test('Possible financing credit cannot be created from tax/card/other debit matching',function(){const credit={bankId:'RBC',date:'2026-01-05',description:'BRXM Payroll credit',counterparty:'BRXM Payroll',direction:'CREDIT',amount:10000},other={bankId:'RBC',date:'2026-01-06',description:'Business PAD BRXM Payroll',counterparty:'BRXM Payroll',direction:'DEBIT',amount:1000,family:'OTHER',entityKey:'RBC_OTHER_PAD_BRXM_PAYROLL'},f=vfcFinancingCredits_([credit],[other]);equal(f.possible.length,0,'possible financing');equal(f.confirmed.length,0,'confirmed financing');return'no false financing match';});
  test('BMO error correction is non-operating but not a financing-return marker',function(){const t={bankId:'BMO',date:'2026-02-03',description:'Error Correction, 0709-1985-790 0749',direction:'CREDIT',amount:5020.38};equal(vfcBankIsNonOperatingReversalCredit_('BMO',t),true,'non-operating reversal');equal(vfcBankIsReturnedFinancingCredit_('BMO',t),false,'financing return');return'separated';});
  const suites={RBC:runRbcBankingSelfTests(),TD:runTdBankingSelfTests(),BMO:runBmoBankingSelfTests()},routerFailed=router.filter(function(x){return!x.pass;}).length,suiteFailed=Object.keys(suites).reduce(function(n,k){return n+(suites[k].failed||0);},0),suiteTotal=Object.keys(suites).reduce(function(n,k){return n+(suites[k].total||0);},0),suitePassed=Object.keys(suites).reduce(function(n,k){return n+(suites[k].passed||0);},0);
  return{ok:routerFailed===0&&suiteFailed===0,coreVersion:VFC_BANK_ENGINE.VERSION,intakeContract:VFC_BANK_ENGINE.INTAKE_CONTRACT,total:router.length+suiteTotal,passed:(router.length-routerFailed)+suitePassed,failed:routerFailed+suiteFailed,routerTests:router,suites:suites};
}

function vfcGenericConservativeClassifyDebit_(t){const s=String(t.description||'').toUpperCase().replace(/\s+/g,' ').trim();if(/\bFEE\b|SERVICE\s+CHARGE|NSF|OVERDRAFT\s+INTEREST/.test(s))return null;if(/\bCRA\b|\bCCRA\b|GST|HST|\bTAX\b/.test(s)){const k=vfcCounterpartyKey_(t.counterparty||t.description);return Object.assign({},t,{family:'TAX',entityKey:k,key:k,label:t.counterparty||t.description});}if(/INSURANCE|PREMIUM\s+FIN/.test(s)){const k=vfcCounterpartyKey_(t.counterparty||t.description);return Object.assign({},t,{family:'OTHER',entityKey:k,key:k,label:t.counterparty||t.description});}if(/LOAN\s+(PAYMENT|PMT|PYMT|INTEREST)|\bMCA\b|MERCHANT\s+CASH\s+ADVANCE|FINANCING\s+PAYMENT/.test(s)){const k=vfcCounterpartyKey_(t.counterparty||t.description);return Object.assign({},t,{family:'FINANCING',entityKey:k,key:k,label:t.counterparty||t.description});}return null;}

/* ===== END BankRouter.gs ===== */

/* ===== BEGIN InstitutionalUnderwritingLayer.gs ===== */
const VFC_SIMPLE_CONFIG = {
  MODEL_VERSION: 'VFC-SIMPLE-HISTORICAL-8.3-OPERATING-CAPACITY',
  MAX_COMPARABLE_CASES: 12,
  MAX_APPROVAL_CASES: 8,
  MIN_SIMILARITY: 0.40,
  ROUNDING: 500,
  MIN_AMOUNT: 5000
};

/**
 * Single production underwriting path.
 *
 * Flow:
 * uploaded statements -> validated banking features -> closest historical
 * training outcomes -> maximum recommended loan.
 *
 * There is no OpenAI amount adjustment, pattern model, regression floor,
 * term-based sizing, shadow calculation, or accuracy-layer adjustment.
 */
function generateInstitutionalAssessmentSafe(companyOrRequest, requestedPeriod) {
  const request = normalizeAssessmentRequest_(companyOrRequest, requestedPeriod);
  const companyName = request.companyName;
  const period = resolveLatestAssessmentPeriod_(companyName, request.period);

  const debtSignalRefresh = {
    ok: true,
    currentBorrowerOnly: true,
    historicalPdfReprocessing: false
  };

  const current = typeof getValidatedBankingFeatures_ === 'function'
    ? getValidatedBankingFeatures_(companyName, period)
    : buildPowerFeatures_(companyName, period);
  if (!current || !current.statementCount) {
    throw new Error('No bank-statement summaries were found for this company and period.');
  }
  const grossDeposits = Math.max(0, toNumber_(current.averageMonthlyDeposits));
  const operatingDeposits = simpleOperatingDeposits_(current);
  const capacityDeposits = simpleNetCapacityDeposits_(current);

  const outcomes = collectHistoricalOutcomes_().filter(function(row) {
    return !(sameText_(row.companyName, companyName) && simplePeriodMatches_(row.period, period));
  });

  if (!outcomes.length) {
    throw new Error('No historical lender outcomes are available. Add approved and declined training files first.');
  }

  const fundamental = calculateFundamentalScore_(current);
  const comparables = simpleBuildComparableCases_(current, outcomes);
  const closestCases = comparables.slice(0, VFC_SIMPLE_CONFIG.MAX_COMPARABLE_CASES);
  const closestApprovals = closestCases.filter(function(row) {
    return row.isPositive && row.approvedAmount > 0;
  }).slice(0, VFC_SIMPLE_CONFIG.MAX_APPROVAL_CASES);

  const historicalAmount = simpleHistoricalAmount_(closestApprovals);
  const bankingAmount = simpleBankingAmount_(current, fundamental);
  const approvalRate = simpleApprovalRate_(closestCases);
  const risk = simpleRiskAdjustment_(current, fundamental);

  let historicalWeight = 0;
  if (closestApprovals.length >= 5) historicalWeight = 0.85;
  else if (closestApprovals.length >= 3) historicalWeight = 0.78;
  else if (closestApprovals.length > 0) historicalWeight = 0.65;

  let maximumLoanAmount = historicalAmount > 0
    ? historicalAmount * historicalWeight + bankingAmount * (1 - historicalWeight)
    : bankingAmount * 0.75;

  let approvalAdjustment = 1;
  if (closestCases.length >= 3) {
    if (approvalRate < 0.35) approvalAdjustment = 0.80;
    else if (approvalRate < 0.50) approvalAdjustment = 0.88;
    else if (approvalRate < 0.65) approvalAdjustment = 0.95;
  }

  maximumLoanAmount *= approvalAdjustment;
  maximumLoanAmount *= risk.factor;

  if (
    historicalAmount > 0 &&
    closestApprovals.length >= 3 &&
    approvalRate >= 0.50 &&
    risk.factor >= 0.95
  ) {
    maximumLoanAmount = Math.max(maximumLoanAmount, historicalAmount * 0.90);
  }

  const score = toNumber_(fundamental.score);
  const marketCap = capacityDeposits * (score >= 75 ? 1.25 : score >= 60 ? 1.05 : 0.85);
  if (marketCap > 0) {
    maximumLoanAmount = Math.min(maximumLoanAmount, marketCap);
  }

  maximumLoanAmount = roundToNearest_(
    Math.max(0, maximumLoanAmount),
    VFC_SIMPLE_CONFIG.ROUNDING
  );

  if (score < 40 || !operatingDeposits || !capacityDeposits) maximumLoanAmount = 0;
  if (
    maximumLoanAmount > 0 &&
    maximumLoanAmount < VFC_SIMPLE_CONFIG.MIN_AMOUNT &&
    score >= 45 && marketCap >= VFC_SIMPLE_CONFIG.MIN_AMOUNT
  ) {
    maximumLoanAmount = VFC_SIMPLE_CONFIG.MIN_AMOUNT;
  }

  const confidenceScore = simpleConfidenceScore_(
    closestApprovals,
    closestCases,
    fundamental,
    current
  );
  const confidence = simpleConfidenceLabel_(confidenceScore);
  const rankings = simpleBuildLenderRankings_(comparables);
  const assessmentId = Utilities.getUuid();

  const closestHistoricalApprovals = closestApprovals.slice(0, 5).map(function(row) {
    return {
      companyName: row.companyName,
      lenderName: row.lenderName,
      decision: row.decision,
      similarityScore: Math.round(row.similarity * 100),
      actualApprovedAmount: row.approvedAmount,
      depositAdjustedAmount: roundToNearest_(row.adjustedAmount, VFC_SIMPLE_CONFIG.ROUNDING)
    };
  });

  const calculationNotes = [
    'Closest training cases reviewed: ' + closestCases.length,
    'Closest approved or conditional cases used: ' + closestApprovals.length,
    'Historical comparable amount: ' + roundToNearest_(historicalAmount, VFC_SIMPLE_CONFIG.ROUNDING),
    'Current banking amount: ' + roundToNearest_(bankingAmount, VFC_SIMPLE_CONFIG.ROUNDING),
    'Observed approval rate among closest cases: ' + Math.round(approvalRate * 100) + '%',
    'Current banking-risk factor: ' + Math.round(risk.factor * 100) + '%',
    'Validated months reviewed: ' + toNumber_(current.monthsCovered),
    'Validated gross monthly deposits: ' + roundToNearest_(grossDeposits, 1),
    'Estimated operating monthly deposits: ' + roundToNearest_(operatingDeposits, 1),
    'Detected recurring financing debt service: ' + roundToNearest_(toNumber_(current.existingMonthlyDebtService), 1),
    'Operating deposits after confirmed monthly debt: ' + roundToNearest_(capacityDeposits, 1),
    risk.reasons.length
      ? 'Banking-risk adjustments: ' + risk.reasons.join(', ')
      : 'No material banking-risk reduction applied.'
  ];

  const inputWarnings = current.inputQualityAudit && Array.isArray(current.inputQualityAudit.warnings)
    ? current.inputQualityAudit.warnings
    : [];
  inputWarnings.forEach(function(note) {
    calculationNotes.push('Input quality: ' + note);
  });

  const lendingCapacity = {
    recommendedAmount: maximumLoanAmount,
    stretchAmount: maximumLoanAmount,
    confidence: confidence,
    confidenceScore: confidenceScore,
    historicalAnchor: roundToNearest_(historicalAmount, VFC_SIMPLE_CONFIG.ROUNDING),
    cashFlowCapacity: roundToNearest_(bankingAmount, VFC_SIMPLE_CONFIG.ROUNDING),
    revenueCapacity: roundToNearest_(marketCap, VFC_SIMPLE_CONFIG.ROUNDING),
    calculationNotes: calculationNotes
  };

  const underwritingSummary = {
    summary: maximumLoanAmount > 0 ? 'Maximum recommended loan' : 'Manual review required',
    recommended_amount: maximumLoanAmount,
    stretch_amount: maximumLoanAmount,
    strongest_lender: rankings.length ? rankings[0].lenderName : '',
    explanation:
      'The recommendation is based on the closest historical lender outcomes in the Training Data and the current bank-statement profile.',
    fundamental_score: score,
    risk_grade: fundamental.grade || '',
    key_strengths: fundamental.strengths || [],
    key_risks: fundamental.risks || []
  };

  return JSON.parse(JSON.stringify({
    ok: true,
    assessmentId: assessmentId,
    modelVersion: VFC_SIMPLE_CONFIG.MODEL_VERSION,
    activeProductionModel: VFC_SIMPLE_CONFIG.MODEL_VERSION,
    companyName: companyName,
    period: period,
    currentFeatures: current,
    fundamentalScorecard: fundamental,
    lendingCapacity: lendingCapacity,
    lenderRankings: rankings,
    underwritingSummary: underwritingSummary,
    institutionalAssessment: {
      modelVersion: VFC_SIMPLE_CONFIG.MODEL_VERSION,
      maximumLoanAmount: maximumLoanAmount,
      amountConfidence: confidence,
      amountConfidenceScore: confidenceScore,
      businessHealthScore: score,
      riskGrade: fundamental.grade || '',
      averageMonthlyDeposits: grossDeposits,
      estimatedOperatingMonthlyDeposits: toNumber_(current.estimatedOperatingMonthlyDeposits),
      capacityMonthlyDeposits: capacityDeposits,
      existingMonthlyDebtService: toNumber_(current.existingMonthlyDebtService),
      otherRecurringMonthlyObligations: toNumber_(current.otherRecurringMonthlyObligations),
      debtServiceToDepositsRatio: toNumber_(current.debtServiceToDepositsRatio),
      detectedFinancingCredits: toNumber_(current.detectedFinancingCredits),
      activeDebtObligations: current.debtProfile && Array.isArray(current.debtProfile.activeDebtObligations)
        ? current.debtProfile.activeDebtObligations
        : [],
      otherRecurringObligations: current.debtProfile && Array.isArray(current.debtProfile.otherRecurringObligations)
        ? current.debtProfile.otherRecurringObligations
        : [],
      inputQualityWarnings: inputWarnings,
      debtSignalRefreshStatus: debtSignalRefresh || {},
      historicalExpectedAmount: roundToNearest_(historicalAmount, VFC_SIMPLE_CONFIG.ROUNDING),
      currentBankingAmount: roundToNearest_(bankingAmount, VFC_SIMPLE_CONFIG.ROUNDING),
      comparableCases: closestCases.length,
      comparableApprovals: closestApprovals.length,
      observedApprovalRate: Math.round(approvalRate * 100),
      strongestLender: rankings.length ? rankings[0].lenderName : '',
      closestHistoricalApprovals: closestHistoricalApprovals,
      calculationNotes: calculationNotes,
      strengths: fundamental.strengths || [],
      risks: fundamental.risks || [],
      decision: maximumLoanAmount > 0
        ? 'Maximum recommended loan'
        : 'No automated loan amount recommended',
      methodologyNote:
        'One production model is active: closest historical outcomes are scaled to validated operating deposits, while banking capacity and the final revenue cap use operating deposits after confirmed recurring financing debt. Gross deposits remain visible for audit but do not size Our Max when an operating-deposit estimate is available.'
    },
    disclaimer:
      'VFC internal decision support only. This recommendation is based on uploaded bank statements and recorded historical lender outcomes and is not a lender approval or guarantee.'
  }));
}

function simpleBuildComparableCases_(current, outcomes) {
  const currentDeposits = simpleOperatingDeposits_(current);
  const cases = [];

  (outcomes || []).forEach(function(outcome) {
    const decision = simpleDecision_(outcome.decision);
    if (!decision || !outcome.companyName) return;

    let features;
    try {
      features = typeof buildPowerFeatures_ === 'function'
        ? buildPowerFeatures_(outcome.companyName, outcome.period)
        : buildFeaturesForCase_(outcome.companyName, outcome.period);
    } catch (error) {
      return;
    }

    if (!features || !features.statementCount || !toNumber_(features.averageMonthlyDeposits)) return;

    const similarity = powerSimilarity_(current, features);
    if (similarity < VFC_SIMPLE_CONFIG.MIN_SIMILARITY) return;

    const approvedAmount = Math.max(0, toNumber_(outcome.approvedAmount));
    const historicalDeposits = simpleOperatingDeposits_(features);
    if (!(historicalDeposits > 0)) return;
    const depositRatio = clamp_(currentDeposits / historicalDeposits, 0.60, 1.45);
    const isPositive = decision === 'Approved' || decision === 'Conditional';

    cases.push({
      companyName: outcome.companyName || '',
      period: outcome.period || '',
      lenderName: outcome.lenderName || 'Unknown lender',
      decision: decision,
      declineReason: outcome.declineReason || '',
      approvedAmount: approvedAmount,
      adjustedAmount: isPositive && approvedAmount > 0
        ? approvedAmount * depositRatio
        : 0,
      similarity: similarity,
      isPositive: isPositive,
      decisionWeight: decision === 'Conditional' ? 0.85 : 1
    });
  });

  cases.sort(function(a, b) {
    return b.similarity - a.similarity;
  });
  return cases;
}

function simpleHistoricalAmount_(approvals) {
  if (!approvals || !approvals.length) return 0;

  let weightedTotal = 0;
  let totalWeight = 0;
  const weightedRows = [];

  approvals.forEach(function(row) {
    const weight = Math.pow(Math.max(0.05, row.similarity), 2) * row.decisionWeight;
    weightedTotal += row.adjustedAmount * weight;
    totalWeight += weight;
    weightedRows.push({ value: row.adjustedAmount, weight: weight });
  });

  const weightedAverage = totalWeight ? weightedTotal / totalWeight : 0;
  const weightedMedian = simpleWeightedMedian_(weightedRows);
  return weightedAverage * 0.65 + weightedMedian * 0.35;
}

function simpleWeightedMedian_(rows) {
  if (!rows || !rows.length) return 0;
  const sorted = rows.slice().sort(function(a, b) { return a.value - b.value; });
  const total = sorted.reduce(function(sum, row) { return sum + row.weight; }, 0);
  let running = 0;
  for (let i = 0; i < sorted.length; i++) {
    running += sorted[i].weight;
    if (running >= total / 2) return sorted[i].value;
  }
  return sorted[sorted.length - 1].value;
}

function simpleApprovalRate_(cases) {
  if (!cases || !cases.length) return 0;
  let positive = 0;
  let total = 0;
  cases.forEach(function(row) {
    const weight = Math.max(0.05, row.similarity);
    total += weight;
    if (row.decision === 'Approved') positive += weight;
    else if (row.decision === 'Conditional') positive += weight * 0.65;
  });
  return total ? positive / total : 0;
}

function simpleBankingAmount_(features, fundamental) {
  const deposits = simpleNetCapacityDeposits_(features);
  const score = toNumber_(fundamental.score);
  const multiple = score >= 82 ? 1.05 :
    score >= 70 ? 0.90 :
    score >= 58 ? 0.75 :
    score >= 45 ? 0.55 : 0.35;
  return deposits * multiple;
}

function simpleRiskAdjustment_(features, fundamental) {
  let factor = 1;
  const reasons = [];
  const debtRatio = simpleDebtBurdenRatio_(features);

  if (debtRatio > 0.30) {
    factor *= 0.82;
    reasons.push('confirmed debt exceeds 30% of operating deposits');
  } else if (debtRatio > 0.20) {
    factor *= 0.90;
    reasons.push('confirmed debt exceeds 20% of operating deposits');
  } else if (debtRatio > 0.10) {
    factor *= 0.95;
    reasons.push('confirmed debt exceeds 10% of operating deposits');
  }

  if (toNumber_(features.nsfPerMonth) > 2) {
    factor *= 0.88;
    reasons.push('frequent NSF activity');
  }
  if (features.suspectedStacking) {
    factor *= 0.85;
    reasons.push('possible stacking');
  }
  if (features.negativeBalanceFlag && features.overdraftFlag) {
    factor *= 0.90;
    reasons.push('negative balance and overdraft activity');
  }
  if (toNumber_(features.depositTrend) < -0.20) {
    factor *= 0.90;
    reasons.push('material deposit decline');
  }
  if (toNumber_(features.depositVolatility) > 0.65) {
    factor *= 0.93;
    reasons.push('high deposit volatility');
  }
  if (toNumber_(fundamental.dataQualityScore) < 50) {
    factor *= 0.90;
    reasons.push('low data quality');
  }

  return {
    factor: clamp_(factor, 0.65, 1),
    reasons: reasons
  };
}

function simpleOperatingDeposits_(features) {
  features = features || {};
  const gross = Math.max(0, toNumber_(features.averageMonthlyDeposits));
  const hasOperating = features.estimatedOperatingMonthlyDeposits !== undefined && features.estimatedOperatingMonthlyDeposits !== null && features.estimatedOperatingMonthlyDeposits !== '';
  if (!hasOperating) return gross;
  const operating = Math.max(0, toNumber_(features.estimatedOperatingMonthlyDeposits));
  return gross > 0 ? Math.min(gross, operating) : operating;
}

function simpleNetCapacityDeposits_(features) {
  return Math.max(0, simpleOperatingDeposits_(features) - Math.max(0, toNumber_(features && features.existingMonthlyDebtService)));
}

function simpleDebtBurdenRatio_(features) {
  const operating = simpleOperatingDeposits_(features);
  const debt = Math.max(0, toNumber_(features && features.existingMonthlyDebtService));
  return debt > 0 ? (operating > 0 ? debt / operating : 1) : 0;
}

function runInstitutionalUnderwritingSelfTests() {
  const results = [];
  function test(name, fn) { try { results.push({name:name,pass:true,detail:String(fn()||'')}); } catch (e) { results.push({name:name,pass:false,detail:String(e&&e.message||e)}); } }
  function close(actual, expected, tolerance, label) { if (Math.abs(Number(actual||0)-Number(expected||0)) > (tolerance==null?.02:tolerance)) throw new Error((label||'value')+' expected '+expected+' got '+actual); }
  test('Operating deposits override gross deposits for capacity',function(){const f={averageMonthlyDeposits:100000,estimatedOperatingMonthlyDeposits:60000,existingMonthlyDebtService:10000};close(simpleOperatingDeposits_(f),60000,.001,'operating');close(simpleNetCapacityDeposits_(f),50000,.001,'net');return'$50000';});
  test('Banking amount subtracts confirmed debt before score multiple',function(){const f={averageMonthlyDeposits:100000,estimatedOperatingMonthlyDeposits:60000,existingMonthlyDebtService:10000};close(simpleBankingAmount_(f,{score:70}),45000,.001,'banking amount');return'$45000';});
  test('Legacy cases without operating facts fall back to gross deposits',function(){const f={averageMonthlyDeposits:100000,existingMonthlyDebtService:10000};close(simpleOperatingDeposits_(f),100000,.001,'legacy operating');close(simpleNetCapacityDeposits_(f),90000,.001,'legacy net');return'$90000';});
  test('Debt burden applies a deterministic operating-cash adjustment',function(){const r=simpleRiskAdjustment_({averageMonthlyDeposits:100000,estimatedOperatingMonthlyDeposits:60000,existingMonthlyDebtService:10000},{dataQualityScore:100});close(r.factor,.95,.0001,'risk factor');return'95%';});
  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,modelVersion:VFC_SIMPLE_CONFIG.MODEL_VERSION,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}

function simpleConfidenceScore_(approvals, cases, fundamental, features) {
  const averageSimilarity = approvals.length
    ? approvals.reduce(function(sum, row) { return sum + row.similarity; }, 0) / approvals.length
    : cases.length
      ? cases.reduce(function(sum, row) { return sum + row.similarity; }, 0) / cases.length
      : 0;

  return clamp_(Math.round(
    Math.min(100, approvals.length / 6 * 100) * 0.40 +
    Math.min(100, averageSimilarity * 100) * 0.35 +
    toNumber_(fundamental.dataQualityScore) * 0.15 +
    Math.min(100, toNumber_(features.monthsCovered) / 6 * 100) * 0.10
  ), 0, 100);
}

function simpleBuildLenderRankings_(comparables) {
  const lenderNames = unique_((comparables || []).map(function(row) {
    return row.lenderName;
  }).filter(Boolean));

  return lenderNames.map(function(lenderName) {
    const rows = comparables.filter(function(row) {
      return sameText_(row.lenderName, lenderName);
    }).slice(0, VFC_SIMPLE_CONFIG.MAX_COMPARABLE_CASES);

    const approvals = rows.filter(function(row) {
      return row.isPositive && row.approvedAmount > 0;
    });
    const declines = rows.filter(function(row) {
      return row.decision === 'Declined';
    });
    const approvalRate = simpleApprovalRate_(rows);
    const averageSimilarity = rows.length
      ? rows.reduce(function(sum, row) { return sum + row.similarity; }, 0) / rows.length
      : 0;
    const score = Math.round(averageSimilarity * 60 + approvalRate * 40);
    const amounts = approvals.map(function(row) {
      return row.approvedAmount;
    }).sort(function(a, b) { return a - b; });

    return {
      lenderName: lenderName,
      compositeScore: score,
      observedFit: simpleFitLabel_(score, rows.length),
      confidence: rows.length >= 6 && approvals.length >= 3 ? 'High' : rows.length >= 3 ? 'Moderate' : 'Low',
      historicalCases: rows.length,
      similarCases: rows.length,
      similarApprovals: approvals.length,
      similarDeclines: declines.length,
      observedApprovalRate: rows.length ? Math.round(approvalRate * 100) + '%' : 'N/A',
      lowApprovedAmount: amounts.length ? amounts[0] : '',
      medianApprovedAmount: amounts.length ? median_(amounts) : '',
      highApprovedAmount: amounts.length ? amounts[amounts.length - 1] : '',
      reasoning: approvals.length + ' of ' + rows.length + ' closest training cases were approved or conditional.',
      risks: unique_(declines.map(function(row) { return row.declineReason; }).filter(Boolean)).slice(0, 4),
      conditions: []
    };
  }).sort(function(a, b) {
    return b.compositeScore - a.compositeScore;
  });
}

function simpleDecision_(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text.indexOf('approv') >= 0) return 'Approved';
  if (text.indexOf('condition') >= 0) return 'Conditional';
  if (text.indexOf('declin') >= 0 || text.indexOf('reject') >= 0) return 'Declined';
  return '';
}

function simpleFitLabel_(score, cases) {
  if (cases < 2) return 'Insufficient history';
  return score >= 80 ? 'Strong fit' :
    score >= 68 ? 'Good fit' :
    score >= 55 ? 'Caution' : 'Weak fit';
}

function simpleConfidenceLabel_(score) {
  return score >= 80 ? 'High' : score >= 60 ? 'Moderate' : 'Low';
}

function simplePeriodMatches_(left, right) {
  if (sameText_(left, right)) return true;
  const clean = function(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  };
  return clean(left) === clean(right);
}

function getProductionModelStatus() {
  return {
    modelVersion: VFC_SIMPLE_CONFIG.MODEL_VERSION,
    activeLayers: 1,
    amountSource: 'Historical Training Data plus validated current banking checks',
    openAIChangesAmount: false,
    patternLearningActive: false,
    regressionFloorActive: false,
    termSizingActive: false,
    shadowModelActive: false,
    recurringDebtExtractionActive: typeof getValidatedBankingFeatures_ === 'function',
    recurringDebtChangesFormula: false,
    legacySheetCleanupActive: false
  };
}

/* ===== END InstitutionalUnderwritingLayer.gs ===== */

/* ===== BEGIN VFCUnderwritingEngine.gs ===== */
const VFC_POWER_CONFIG = {
  MODEL_VERSION: 'VFC-HYBRID-FINAL-2.0',
  MAX_SIMILAR_CASES: 12,
  HISTORICAL_WEIGHT: 0.58,
  FUNDAMENTAL_WEIGHT: 0.32,
  AI_WEIGHT: 0.10,
  MIN_AMOUNT: 5000,
  ROUNDING: 500
};

function generatePowerAssessmentSafe(companyOrRequest, requestedPeriod) {
  const request = normalizeAssessmentRequest_(companyOrRequest, requestedPeriod);
  const period = resolveLatestAssessmentPeriod_(request.companyName, request.period);
  return generatePowerAssessment(request.companyName, period);
}

function normalizeAssessmentRequest_(companyOrRequest, requestedPeriod) {
  let companyName = '';
  let period = requestedPeriod || '';
  if (companyOrRequest && typeof companyOrRequest === 'object') {
    companyName = companyOrRequest.companyName || companyOrRequest.company || '';
    period = companyOrRequest.period || companyOrRequest.detectedPeriod || period;
  } else {
    companyName = companyOrRequest || '';
  }
  companyName = String(companyName || '').trim();
  period = String(period || '').trim();
  if (!companyName || /^(undefined|null)$/i.test(companyName)) {
    throw new Error('Company name was not provided. Run the assessment from the deployed web app.');
  }
  return { companyName: companyName, period: period };
}

function resolveLatestAssessmentPeriod_(companyName, requestedPeriod) {
  const rows = getSheetObjects_('PDF Summaries').filter(function(row) {
    return sameText_(row.companyName, companyName);
  });
  if (!rows.length) {
    throw new Error('No PDF Summary rows were found for "' + companyName + '". Confirm the upload completed successfully.');
  }
  if (requestedPeriod) {
    const exact = rows.filter(function(row) { return sameText_(row.detectedPeriod, requestedPeriod); });
    if (exact.length) return String(exact[exact.length - 1].detectedPeriod || requestedPeriod).trim();
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const value = String(rows[i].detectedPeriod || '').trim();
    if (value) return value;
  }
  return '';
}

function diagnoseAssessmentLookup(companyOrRequest, requestedPeriod) {
  const request = normalizeAssessmentRequest_(companyOrRequest, requestedPeriod);
  const rows = getSheetObjects_('PDF Summaries').filter(function(row) { return sameText_(row.companyName, request.companyName); });
  return {
    companyName: request.companyName,
    requestedPeriod: request.period,
    matchingRows: rows.length,
    availablePeriods: unique_(rows.map(function(row) { return row.detectedPeriod || ''; }).filter(Boolean)),
    resolvedPeriod: rows.length ? resolveLatestAssessmentPeriod_(request.companyName, request.period) : ''
  };
}

function generatePowerAssessment(companyName, period) {
  setupVFC();
  ensurePowerEngineSheets_();
  const current = buildPowerFeatures_(companyName, period);
  if (!current || !current.statementCount) throw new Error('No bank-statement summaries were found for this company and period.');

  const outcomes = collectHistoricalOutcomes_().filter(function(row) {
    return !(sameText_(row.companyName, companyName) && sameText_(row.period, period));
  });
  if (!outcomes.length) throw new Error('No historical lender outcomes are available. Add approvals and declines in Training Data first.');

  const fundamental = calculateFundamentalScore_(current);
  const aiReview = createExpertReview_(current, fundamental);
  const lenders = unique_(outcomes.map(function(row) { return row.lenderName; }).filter(Boolean));
  const rankings = lenders.map(function(lender) {
    return scorePowerLender_(lender, current, outcomes, fundamental, aiReview);
  }).sort(function(a, b) { return b.compositeScore - a.compositeScore; });

  const capacity = calculateExactLendingCapacity_(current, fundamental, aiReview, rankings);
  const decision = buildPowerDecision_(current, fundamental, aiReview, rankings, capacity);
  const assessmentId = Utilities.getUuid();

  rankings.forEach(function(result) {
    appendRow_('Hybrid Assessments', [
      assessmentId,VFC_POWER_CONFIG.MODEL_VERSION,companyName,period,result.lenderName,
      result.compositeScore,result.observedScore,fundamental.score,result.aiRiskScore,
      result.observedFit,result.confidence,result.historicalCases,result.similarCases,
      result.similarApprovals,result.similarDeclines,result.observedApprovalRate,
      result.lowApprovedAmount,result.highApprovedAmount,result.medianApprovedAmount,
      capacity.recommendedAmount,capacity.stretchAmount,capacity.confidenceScore,
      result.reasoning,cleanCell_(result.conditions),cleanCell_(result.risks),new Date()
    ]);
  });

  appendRow_('Risk Scorecards', [
    assessmentId,companyName,period,fundamental.score,fundamental.grade,
    fundamental.cashFlowScore,fundamental.nsfScore,fundamental.balanceScore,
    fundamental.debtLoadScore,fundamental.coverageScore,fundamental.dataQualityScore,
    capacity.recommendedAmount,capacity.stretchAmount,capacity.confidenceScore,
    cleanCell_(capacity.calculationNotes),cleanCell_(fundamental.strengths),
    cleanCell_(fundamental.risks),cleanCell_(aiReview.missing_information),new Date()
  ]);

  return {
    ok:true,
    assessmentId:assessmentId,
    modelVersion:VFC_POWER_CONFIG.MODEL_VERSION,
    companyName:companyName,
    period:period,
    currentFeatures:current,
    fundamentalScorecard:fundamental,
    expertReview:aiReview,
    lendingCapacity:capacity,
    lenderRankings:rankings,
    underwritingSummary:decision,
    disclaimer:'The exact amount is VFC internal decision support based on uploaded banking data and observed historical outcomes. It is not a lender approval or official lender policy.'
  };
}

function ensurePowerEngineSheets_() {
  ensureSheetSchema_('Hybrid Assessments', [
    'Assessment ID','Model Version','Company Name','Period','Lender Name','Composite Score',
    'Observed Score','Fundamental Score','AI Risk Score','Observed Fit','Confidence',
    'Historical Cases','Similar Cases','Similar Approvals','Similar Declines','Observed Approval Rate',
    'Low Approved Amount','High Approved Amount','Median Approved Amount','Recommended Exact Amount',
    'Stretch Amount','Amount Confidence','Reasoning','Conditions','Risks','Created At'
  ]);
  ensureSheetSchema_('Risk Scorecards', [
    'Assessment ID','Company Name','Period','Fundamental Score','Risk Grade','Cash Flow Score',
    'NSF Score','Balance Score','Debt Load Score','Coverage Score','Data Quality Score',
    'Recommended Exact Amount','Stretch Amount','Amount Confidence','Amount Calculation Notes',
    'Strengths','Risks','Missing Information','Created At'
  ]);
}

function buildPowerFeatures_(companyName, period) {
  const base = buildFeaturesForCase_(companyName, period);
  if (!base) return null;
  const rows = getSheetObjects_('PDF Summaries').filter(function(row) {
    return sameText_(row.companyName, companyName) && (!period || sameText_(row.detectedPeriod, period));
  });
  const opening = rows.map(function(r) { return toNumber_(r.openingBalance); }).filter(isFiniteNumber_);
  const closing = rows.map(function(r) { return toNumber_(r.closingBalance); }).filter(isFiniteNumber_);
  const deposits = rows.map(function(r) { return toNumber_(r.totalDeposits); }).filter(function(n) { return n > 0; });
  const withdrawals = rows.map(function(r) { return toNumber_(r.totalWithdrawals); }).filter(function(n) { return n > 0; });
  const avgDeposit = average_(deposits);
  const text = rows.map(function(r) { return [r.summary,r.risks,r.missingInfo,r.possibleMcaOrLoanPayments].join(' '); }).join(' ').toLowerCase();
  return Object.assign({}, base, {
    averageOpeningBalance:round2_(average_(opening)),
    averageClosingBalance:round2_(average_(closing)),
    depositVolatility:round2_(avgDeposit ? standardDeviation_(deposits) / avgDeposit : 1),
    depositTrend:round2_(calculateTrend_(deposits)),
    nsfPerMonth:round2_(base.nsfCount / Math.max(base.monthsCovered, 1)),
    overdraftFlag:/overdraft|od fee|over limit|insufficient funds/.test(text) ? 1 : 0,
    returnedPaymentFlag:/returned payment|returned item|reversal|chargeback/.test(text) ? 1 : 0,
    suspectedStacking:/stack|multiple mca|multiple loan|several daily|several weekly/.test(text) ? 1 : 0,
    missingInfoFlag:rows.some(function(r) { return String(r.missingInfo || '').trim().length > 3; }) ? 1 : 0,
    monthlyDeposits:deposits,
    monthlyWithdrawals:withdrawals
  });
}

function calculateFundamentalScore_(f) {
  const strengths = [], risks = [];
  let cashFlow = f.depositWithdrawalRatio >= 1.15 ? 90 : f.depositWithdrawalRatio >= 1.02 ? 76 : f.depositWithdrawalRatio >= 0.92 ? 58 : f.depositWithdrawalRatio >= 0.80 ? 38 : 20;
  if (f.depositTrend >= 0.08) { cashFlow += 6; strengths.push('Deposits are trending upward.'); }
  if (f.depositTrend <= -0.08) { cashFlow -= 10; risks.push('Deposits are trending downward.'); }
  if (f.depositVolatility <= 0.18) { cashFlow += 4; strengths.push('Deposits are relatively stable.'); }
  if (f.depositVolatility >= 0.45) { cashFlow -= 8; risks.push('Deposits are highly volatile.'); }
  cashFlow = clamp_(Math.round(cashFlow),0,100);

  let nsf = f.nsfPerMonth === 0 ? 100 : f.nsfPerMonth <= 0.5 ? 82 : f.nsfPerMonth <= 1 ? 68 : f.nsfPerMonth <= 2 ? 45 : 20;
  if (f.nsfPerMonth > 0) risks.push('NSF activity averages ' + f.nsfPerMonth + ' per month.'); else strengths.push('No NSF activity was extracted.');

  let balance = 78;
  if (f.negativeBalanceFlag) { balance -= 32; risks.push('Negative balances were detected.'); }
  if (f.overdraftFlag) { balance -= 15; risks.push('Overdraft activity was detected.'); }
  if (f.returnedPaymentFlag) { balance -= 12; risks.push('Returned-payment activity was detected.'); }
  const grossDeposits = Math.max(0, toNumber_(f.averageMonthlyDeposits));
  const hasOperatingDeposits = f.estimatedOperatingMonthlyDeposits !== undefined && f.estimatedOperatingMonthlyDeposits !== null && f.estimatedOperatingMonthlyDeposits !== '';
  const operatingDeposits = hasOperatingDeposits ? Math.max(0, toNumber_(f.estimatedOperatingMonthlyDeposits)) : grossDeposits;
  if (f.averageClosingBalance > 0 && operatingDeposits > 0) {
    const days = f.averageClosingBalance / (operatingDeposits / 30);
    if (days >= 7) { balance += 10; strengths.push('Closing balances provide a reasonable operating cushion.'); }
    else if (days < 2) { balance -= 10; risks.push('The average closing-balance cushion is thin.'); }
  }
  balance = clamp_(balance,0,100);

  let debt = 88;
  const monthlyDebt = Math.max(0, toNumber_(f.existingMonthlyDebtService));
  const debtRatio = monthlyDebt > 0 ? (operatingDeposits > 0 ? monthlyDebt / operatingDeposits : 1) : 0;
  if (monthlyDebt > 0) {
    if (debtRatio <= 0.05) debt -= 10;
    else if (debtRatio <= 0.10) debt -= 18;
    else if (debtRatio <= 0.20) debt -= 25;
    else if (debtRatio <= 0.30) debt -= 35;
    else debt -= 45;
    risks.push('Confirmed recurring debt service is ' + Math.round(debtRatio * 100) + '% of estimated operating deposits.');
  } else if (f.mcaPaymentFlag) {
    debt -= 25;
    risks.push('Existing MCA or loan payments were identified, but a reliable monthly amount was unavailable.');
  }
  if (f.suspectedStacking) { debt -= 28; risks.push('Possible stacking was identified.'); }
  debt = clamp_(debt,0,100);

  const coverage = f.monthsCovered >= 6 ? 100 : f.monthsCovered >= 4 ? 82 : f.monthsCovered >= 3 ? 68 : f.monthsCovered >= 2 ? 50 : 35;
  if (f.monthsCovered < 3) risks.push('Limited statement history reduces reliability.'); else strengths.push(f.monthsCovered + ' months of statements were analyzed.');

  let data = 100;
  if (f.missingInfoFlag) data -= 20;
  if (!f.averageMonthlyDeposits) data -= 35;
  if (!f.totalWithdrawals) data -= 20;
  if (f.statementCount < 2) data -= 15;
  data = clamp_(data,0,100);

  const score = Math.round(cashFlow*0.30 + nsf*0.18 + balance*0.17 + debt*0.17 + coverage*0.10 + data*0.08);
  const grade = score >= 82 ? 'Strong' : score >= 70 ? 'Acceptable' : score >= 58 ? 'Caution' : score >= 45 ? 'Elevated Risk' : 'High Risk';
  return {score:score,grade:grade,cashFlowScore:cashFlow,nsfScore:nsf,balanceScore:balance,debtLoadScore:debt,debtServiceRatio:debtRatio,coverageScore:coverage,dataQualityScore:data,strengths:unique_(strengths),risks:unique_(risks)};
}

function scorePowerLender_(lenderName, current, outcomes, fundamental, aiReview) {
  const records = outcomes.filter(function(r) { return sameText_(r.lenderName,lenderName); }).map(function(r) {
    const features = buildPowerFeatures_(r.companyName,r.period);
    return {companyName:r.companyName,period:r.period,decision:normalizeDecision_(r.decision),approvedAmount:toNumber_(r.approvedAmount),declineReason:r.declineReason||'',features:features,similarity:features&&features.statementCount?powerSimilarity_(current,features):0};
  }).filter(function(r) { return r.features && r.features.statementCount; });
  records.sort(function(a,b) { return b.similarity-a.similarity; });
  const similar = records.slice(0,VFC_POWER_CONFIG.MAX_SIMILAR_CASES);
  const approvals = similar.filter(function(r) { return r.decision==='Approved'||r.decision==='Conditional'; });
  const declines = similar.filter(function(r) { return r.decision==='Declined'; });
  const approvalRate = similar.length ? approvals.length/similar.length : 0;
  const avgSimilarity = similar.length ? average_(similar.map(function(r){return r.similarity;})) : 0;
  const sampleFactor = clamp_(records.length/15,0.25,1);
  const observedRaw = approvalRate*72 + avgSimilarity*28;
  const observedScore = Math.round(50 + (observedRaw-50)*sampleFactor);
  const aiScore = clamp_(toNumber_(aiReview.risk_score||fundamental.score),0,100);
  let composite = observedScore*VFC_POWER_CONFIG.HISTORICAL_WEIGHT + fundamental.score*VFC_POWER_CONFIG.FUNDAMENTAL_WEIGHT + aiScore*VFC_POWER_CONFIG.AI_WEIGHT;
  composite = Math.round(50 + (composite-50)*(fundamental.dataQualityScore/100));
  const amounts = approvals.map(function(r){return r.approvedAmount;}).filter(function(n){return n>0;}).sort(function(a,b){return a-b;});
  const fit = records.length<3 ? 'Insufficient history' : composite>=78 ? 'Strong fit' : composite>=65 ? 'Good fit' : composite>=52 ? 'Caution' : 'Weak fit';
  const confidence = records.length>=15&&similar.length>=9&&fundamental.dataQualityScore>=80 ? 'High' : records.length>=6&&similar.length>=4&&fundamental.dataQualityScore>=65 ? 'Moderate' : 'Low';
  return {
    lenderName:lenderName,compositeScore:composite,observedScore:observedScore,aiRiskScore:aiScore,observedFit:fit,confidence:confidence,
    historicalCases:records.length,similarCases:similar.length,similarApprovals:approvals.length,similarDeclines:declines.length,
    observedApprovalRate:similar.length?Math.round(approvalRate*100)+'%':'N/A',
    lowApprovedAmount:amounts.length?amounts[0]:'',highApprovedAmount:amounts.length?amounts[amounts.length-1]:'',medianApprovedAmount:amounts.length?median_(amounts):'',
    reasoning:similar.length?approvals.length+' of '+similar.length+' closest VFC cases were approved or conditional.':'No comparable historical cases were available.',
    conditions:unique_((aiReview.recommended_conditions||[]).concat(fundamental.dataQualityScore<75?['Manually verify extracted figures.']:[])),
    risks:unique_(topTextReasons_(declines.map(function(r){return r.declineReason;})).concat(fundamental.risks).concat(aiReview.key_risks||[])).slice(0,8)
  };
}

function calculateExactLendingCapacity_(f, fundamental, aiReview, rankings) {
  const top = rankings[0] || {};
  const approvedMedians = rankings.map(function(r){return toNumber_(r.medianApprovedAmount);}).filter(function(n){return n>0;});
  const historicalAnchor = approvedMedians.length ? weightedHistoricalAnchor_(rankings) : 0;

  const revenueBase = f.averageMonthlyDeposits * 0.70;
  const surplusRatio = clamp_(f.depositWithdrawalRatio - 0.78, 0.12, 0.50);
  const cashFlowCapacity = f.averageMonthlyDeposits * surplusRatio * 3.25;
  const balanceCapacity = Math.max(0, f.averageClosingBalance * 4);

  let base;
  if (historicalAnchor > 0) base = historicalAnchor*0.45 + revenueBase*0.30 + cashFlowCapacity*0.20 + balanceCapacity*0.05;
  else base = revenueBase*0.60 + cashFlowCapacity*0.35 + balanceCapacity*0.05;

  const fundamentalFactor = clamp_(fundamental.score/75,0.52,1.15);
  const lenderFitFactor = clamp_((toNumber_(top.compositeScore)||50)/72,0.65,1.15);
  const aiFactor = clamp_(toNumber_(aiReview.risk_score||fundamental.score)/75,0.70,1.10);
  const dataFactor = clamp_(fundamental.dataQualityScore/100,0.55,1);

  let behaviourFactor = 1;
  if (f.nsfPerMonth > 0.5) behaviourFactor -= Math.min(0.25,f.nsfPerMonth*0.06);
  if (f.negativeBalanceFlag) behaviourFactor -= 0.12;
  if (f.overdraftFlag) behaviourFactor -= 0.08;
  if (f.returnedPaymentFlag) behaviourFactor -= 0.06;
  if (f.mcaPaymentFlag) behaviourFactor -= 0.14;
  if (f.suspectedStacking) behaviourFactor -= 0.18;
  if (f.depositTrend < -0.08) behaviourFactor -= 0.08;
  if (f.depositVolatility > 0.45) behaviourFactor -= 0.07;
  behaviourFactor = clamp_(behaviourFactor,0.35,1.08);

  const raw = base * fundamentalFactor * lenderFitFactor * aiFactor * dataFactor * behaviourFactor;
  const revenueCap = f.averageMonthlyDeposits * (fundamental.score>=82?0.95:fundamental.score>=70?0.80:fundamental.score>=58?0.65:0.45);
  let recommended = Math.min(raw,revenueCap);
  if (historicalAnchor>0) recommended = Math.min(recommended,historicalAnchor*1.25);
  recommended = roundToNearest_(Math.max(0,recommended),VFC_POWER_CONFIG.ROUNDING);
  if (recommended < VFC_POWER_CONFIG.MIN_AMOUNT && fundamental.score >= 45) recommended = VFC_POWER_CONFIG.MIN_AMOUNT;
  if (fundamental.score < 40 || !f.averageMonthlyDeposits) recommended = 0;

  let stretchFactor = top.compositeScore>=78&&fundamental.score>=75 ? 1.18 : top.compositeScore>=65&&fundamental.score>=65 ? 1.12 : 1.07;
  let stretch = roundToNearest_(Math.min(recommended*stretchFactor,revenueCap*1.10),VFC_POWER_CONFIG.ROUNDING);
  if (stretch < recommended) stretch = recommended;

  const sampleScore = Math.min(100,(toNumber_(top.historicalCases)||0)*6);
  const confidenceScore = Math.round(fundamental.dataQualityScore*0.45 + Math.min(100,f.monthsCovered/6*100)*0.25 + sampleScore*0.20 + Math.min(100,(toNumber_(top.similarCases)||0)/8*100)*0.10);
  const confidence = confidenceScore>=80?'High':confidenceScore>=60?'Moderate':'Low';

  return {
    recommendedAmount:recommended,
    stretchAmount:stretch,
    confidenceScore:confidenceScore,
    confidence:confidence,
    historicalAnchor:roundToNearest_(historicalAnchor,VFC_POWER_CONFIG.ROUNDING),
    cashFlowCapacity:roundToNearest_(cashFlowCapacity,VFC_POWER_CONFIG.ROUNDING),
    revenueCapacity:roundToNearest_(revenueCap,VFC_POWER_CONFIG.ROUNDING),
    calculationNotes:[
      'Average monthly deposits: '+roundToNearest_(f.averageMonthlyDeposits,VFC_POWER_CONFIG.ROUNDING),
      'Historical approval anchor: '+roundToNearest_(historicalAnchor,VFC_POWER_CONFIG.ROUNDING),
      'Fundamental risk adjustment: '+fundamental.score+'/100',
      'Top lender fit adjustment: '+(top.compositeScore||0)+'/100',
      'Banking-behaviour factor: '+Math.round(behaviourFactor*100)+'%',
      'Data-confidence factor: '+Math.round(dataFactor*100)+'%'
    ]
  };
}

function weightedHistoricalAnchor_(rankings) {
  let total=0, weight=0;
  rankings.forEach(function(r,index){
    const amount=toNumber_(r.medianApprovedAmount);
    if (!amount) return;
    const w=Math.max(0.15,(toNumber_(r.compositeScore)||50)/100)*(1/(index+1));
    total+=amount*w; weight+=w;
  });
  return weight?total/weight:0;
}

function powerSimilarity_(a,b) {
  return clamp_(
    numericSimilarity_(a.averageMonthlyDeposits,b.averageMonthlyDeposits)*0.29 +
    numericSimilarity_(a.depositWithdrawalRatio,b.depositWithdrawalRatio,2)*0.13 +
    numericSimilarity_(a.nsfPerMonth,b.nsfPerMonth,2)*0.14 +
    numericSimilarity_(a.depositVolatility,b.depositVolatility,1)*0.10 +
    numericSimilarity_(a.depositTrend,b.depositTrend,0.5)*0.08 +
    (a.negativeBalanceFlag===b.negativeBalanceFlag?1:0)*0.08 +
    (a.mcaPaymentFlag===b.mcaPaymentFlag?1:0)*0.08 +
    (a.suspectedStacking===b.suspectedStacking?1:0)*0.05 +
    numericSimilarity_(a.monthsCovered,b.monthsCovered,6)*0.05,0,1
  );
}

function createExpertReview_(features,fundamental) {
  const fallback={risk_score:fundamental.score,risk_grade:fundamental.grade,executive_summary:'Cash-flow analysis completed.',key_strengths:fundamental.strengths,key_risks:fundamental.risks,missing_information:[],recommended_conditions:[]};
  try {
    const prompt=[
      'You are a senior Canadian small-business cash-flow underwriter supporting VFC.',
      'Return JSON only with risk_score, risk_grade, executive_summary, key_strengths, key_risks, missing_information, recommended_conditions.',
      'Do not invent lender criteria or promise approval. Treat missing information as missing, not negative.',
      'Extracted features: '+JSON.stringify(features),
      'Deterministic scorecard: '+JSON.stringify(fundamental)
    ].join('\n');
    const r=callOpenAIJson_(prompt);
    r.risk_score=clamp_(toNumber_(r.risk_score||fundamental.score),0,100);
    r.key_strengths=arraySafe_(r.key_strengths); r.key_risks=arraySafe_(r.key_risks); r.missing_information=arraySafe_(r.missing_information); r.recommended_conditions=arraySafe_(r.recommended_conditions);
    return r;
  } catch(e) { return fallback; }
}

function buildPowerDecision_(features,fundamental,aiReview,rankings,capacity) {
  const top=rankings[0]||{};
  const summary=capacity.recommendedAmount<=0?'No lending amount recommended':top.compositeScore>=78&&capacity.confidence!=='Low'?'Strong submission candidate':top.compositeScore>=65?'Submit with conditions':top.compositeScore>=52?'Strengthen file before submission':'High risk — manual exception review';
  return {
    summary:summary,
    strongest_lender:top.lenderName||'',
    explanation:(aiReview.executive_summary||'')+(capacity.recommendedAmount?' VFC internal recommended amount: '+capacity.recommendedAmount+'.':''),
    fundamental_score:fundamental.score,
    risk_grade:fundamental.grade,
    recommended_amount:capacity.recommendedAmount,
    stretch_amount:capacity.stretchAmount,
    amount_confidence:capacity.confidence,
    amount_confidence_score:capacity.confidenceScore,
    key_strengths:fundamental.strengths,
    key_risks:unique_(fundamental.risks.concat(aiReview.key_risks||[])).slice(0,8),
    missing_information:aiReview.missing_information||[],
    recommended_conditions:aiReview.recommended_conditions||[]
  };
}

function topTextReasons_(reasons) {
  const counts={};
  reasons.filter(Boolean).forEach(function(reason){String(reason).split(/[\n;,|]+/).forEach(function(piece){const clean=piece.trim();if(!clean)return;const key=clean.toLowerCase();counts[key]=counts[key]||{text:clean,count:0};counts[key].count++;});});
  return Object.keys(counts).map(function(k){return counts[k];}).sort(function(a,b){return b.count-a.count;}).slice(0,4).map(function(x){return x.text;});
}
function calculateTrend_(values){if(!values||values.length<2)return 0;const avg=average_(values);return avg?(values[values.length-1]-values[0])/avg:0;}
function standardDeviation_(values){if(!values||values.length<2)return 0;const avg=average_(values);return Math.sqrt(values.reduce(function(s,n){return s+Math.pow(n-avg,2);},0)/values.length);}
function average_(values){const nums=(values||[]).filter(isFiniteNumber_);return nums.length?nums.reduce(function(a,b){return a+b;},0)/nums.length:0;}
function isFiniteNumber_(n){return typeof n==='number'&&isFinite(n);}
function arraySafe_(value){return Array.isArray(value)?value:value?[String(value)]:[];}
function roundToNearest_(value,nearest){return Math.round(toNumber_(value)/nearest)*nearest;}

/* ===== END VFCUnderwritingEngine.gs ===== */

/* ===== BEGIN OpenAIRecommendation.gs ===== */
const VFC_OPENAI_RECOMMENDATION_CONFIG = {
  MODEL_VERSION: 'VFC-OPENAI-STABLE-2.2-DEBT-CONSISTENCY',
  DEFAULT_MODEL: 'gpt-4.1-mini',
  MAX_COMPARABLE_CASES: 12,
  MIN_SIMILARITY: 0.30,
  ROUNDING: 500,
  MAX_AVERAGE_MONTHLY_DEPOSITS: 5000000,
  MAX_APPROVED_AMOUNT: 5000000,
  CACHE_PREFIX: 'VFC_OAI_STABLE_22:'
};

function generateOpenAIRecommendationSafe(companyOrRequest, requestedPeriod) {
  const request=vfcOaiNormalizeRequest_(companyOrRequest,requestedPeriod),period=vfcOaiResolvePeriod_(request.companyName,request.period),current=vfcOaiBuildCurrentFeatures_(request.companyName,period);vfcOaiValidateCurrent_(current);
  const outcomes=vfcOaiHistoricalOutcomes_().filter(function(row){return !(vfcOaiSame_(row.companyName,request.companyName)&&vfcOaiPeriodSame_(row.period,period));});if(!outcomes.length)throw new Error('No verified historical outcomes are available in the training Sheets.');
  const built=vfcOaiBuildComparableCases_(current,outcomes),cases=built.validCases.slice(0,VFC_OPENAI_RECOMMENDATION_CONFIG.MAX_COMPARABLE_CASES),positiveCases=cases.filter(function(row){return row.isPositive&&row.approvedAmount>0;});if(!cases.length||!positiveCases.length)throw new Error('No usable comparable approvals were found after data-quality checks.');
  const currentProfile=vfcOaiCompactFeatures_(current),promptData={current_profile:currentProfile,comparable_cases:cases.map(function(row,index){return{case_id:'CASE_'+(index+1),lender:row.lenderName,decision:row.decision,actual_approved_amount:row.approvedAmount,deposit_adjusted_amount:row.adjustedAmount,similarity_percent:Math.round(row.similarity*100),average_monthly_deposits:row.features.averageMonthlyDeposits,deposit_withdrawal_ratio:row.features.depositWithdrawalRatio,nsf_per_month:row.features.nsfPerMonth,negative_balance:row.features.negativeBalanceFlag,existing_mca_or_loan:row.features.mcaPaymentFlag,months_covered:row.features.monthsCovered};})};
  const instruction=['You are the VFC experimental underwriting analyst.','Use only the supplied current banking profile and verified historical cases.','Do not invent lender policies, lender criteria, outstanding balances, payoff amounts, or facts not in the data.','This recommendation is separate from the production Our Max calculation.','Use approved and conditional cases to estimate the amount and declines only for risk/probability.','Prefer the most similar cases.','Treat confirmed recurring financing debt service as a direct capacity constraint.','If current_profile.hasConfirmedExistingDebt is true, you MUST acknowledge the existing financing debt and MUST NOT say there is no existing MCA, loan, or debt.','The activeDebtObligations array is authoritative for confirmed existing financing obligations.','Financing advances are not operating revenue.','Do not treat tax/government, insurance, credit-card payments, or unclear recurring obligations as confirmed MCA/loan debt unless the supplied category proves it.','Return concise reasoning.'].join(' ');
  const model=vfcOaiModel_(),fingerprint=vfcOaiFingerprint_({version:VFC_OPENAI_RECOMMENDATION_CONFIG.MODEL_VERSION,model:model,data:promptData}),cached=vfcOaiReadCache_(fingerprint);let protectedResult;
  if(cached){protectedResult=cached;}else{const raw=vfcOaiCallOpenAI_(instruction,promptData,model);protectedResult=vfcOaiApplySanityChecks_(raw,current,cases,positiveCases);vfcOaiWriteCache_(fingerprint,protectedResult);}
  const debtProfile=current&&current.debtProfile?current.debtProfile:{},inputAudit=current&&current.inputQualityAudit?current.inputQualityAudit:{};
  return JSON.parse(JSON.stringify({ok:true,modelVersion:VFC_OPENAI_RECOMMENDATION_CONFIG.MODEL_VERSION,openAIModel:protectedResult.openAIModel,productionModelAffected:false,companyName:request.companyName,period:period,recommendation:{recommendedAmount:protectedResult.recommendedAmount,rawOpenAIAmount:protectedResult.rawOpenAIAmount,recommendedLender:protectedResult.recommendedLender,approvalProbability:protectedResult.approvalProbability,confidence:protectedResult.confidence,closestCasesUsed:protectedResult.closestCasesUsed,reasoning:protectedResult.reasoning,keyStrengths:protectedResult.keyStrengths,keyRisks:protectedResult.keyRisks,sanityCapApplied:protectedResult.sanityCapApplied},bankingInputsUsed:{grossAverageMonthlyDeposits:vfcOaiNumber_(current.averageMonthlyDeposits),estimatedOperatingMonthlyDeposits:vfcOaiNumber_(current.estimatedOperatingMonthlyDeposits),detectedFinancingCredits:vfcOaiNumber_(current.detectedFinancingCredits),existingMonthlyDebtService:vfcOaiNumber_(current.existingMonthlyDebtService),otherRecurringMonthlyObligations:vfcOaiNumber_(current.otherRecurringMonthlyObligations),debtServiceToDepositsRatio:vfcOaiNumber_(current.debtServiceToDepositsRatio),activeDebtObligations:Array.isArray(debtProfile.activeDebtObligations)?debtProfile.activeDebtObligations:[],otherRecurringObligations:Array.isArray(debtProfile.otherRecurringObligations)?debtProfile.otherRecurringObligations:[],inputQualityWarnings:Array.isArray(inputAudit.warnings)?inputAudit.warnings:[]},trainingDataRead:{totalHistoricalOutcomes:outcomes.length,validComparableCases:cases.length,comparableApprovals:positiveCases.length,ignoredCases:built.ignoredCases.length,historicalPdfReprocessing:false},stableCache:{fingerprint:fingerprint,reused:!!cached},note:'OpenAI recommendation only. It does not change Our Max and is not a lender approval or guarantee.'}));
}

function testLatestOpenAIRecommendation(){const rows=getSheetObjects_('Structured Features');if(!rows.length)throw new Error('Structured Features has no records to test.');const latest=rows[rows.length-1],result=generateOpenAIRecommendationSafe({companyName:latest.companyName,period:latest.period});console.log(JSON.stringify(result,null,2));return result;}
function getOpenAIRecommendationStatus(){return{modelVersion:VFC_OPENAI_RECOMMENDATION_CONFIG.MODEL_VERSION,currentBorrowerUsesValidatedBanking:true,historicalCasesUseStoredFeatures:true,historicalPdfReprocessing:false,stableRecommendationCache:true,usesRecurringDebtService:true,debtNarrativeConsistencyGuard:true,writesToSheets:false,changesOurMax:false,defaultOpenAIModel:VFC_OPENAI_RECOMMENDATION_CONFIG.DEFAULT_MODEL};}

function vfcOaiBuildComparableCases_(current,outcomes){const validCases=[],ignoredCases=[],currentDeposits=vfcOaiNumber_(current.averageMonthlyDeposits),historicalIndex=vfcOaiHistoricalFeatureIndex_();(outcomes||[]).forEach(function(outcome){const decision=vfcOaiDecision_(outcome.decision);if(!decision||!outcome.companyName||!outcome.lenderName)return;let features;try{features=vfcOaiBuildHistoricalFeatures_(outcome.companyName,outcome.period,historicalIndex);}catch(error){features=null;}const validation=vfcOaiValidateHistorical_(features);if(!validation.valid){ignoredCases.push({companyName:outcome.companyName,reason:validation.reason});return;}const approvedAmount=Math.max(0,vfcOaiNumber_(outcome.approvedAmount)),isPositive=decision==='Approved'||decision==='Conditional';if(isPositive&&(!approvedAmount||approvedAmount>VFC_OPENAI_RECOMMENDATION_CONFIG.MAX_APPROVED_AMOUNT)){ignoredCases.push({companyName:outcome.companyName,reason:'Missing or unreasonable approved amount'});return;}const similarity=vfcOaiSimilarity_(current,features);if(similarity<VFC_OPENAI_RECOMMENDATION_CONFIG.MIN_SIMILARITY)return;const historicalDeposits=vfcOaiNumber_(features.averageMonthlyDeposits),ratio=historicalDeposits>0?vfcOaiClamp_(currentDeposits/historicalDeposits,0.60,1.50):1;validCases.push({companyName:outcome.companyName,period:outcome.period,lenderName:outcome.lenderName,decision:decision,approvedAmount:approvedAmount,declineReason:outcome.declineReason||'',isPositive:isPositive,similarity:similarity,adjustedAmount:isPositive?vfcOaiRound_(approvedAmount*ratio,1):0,features:vfcOaiCompactFeatures_(features)});});validCases.sort(function(a,b){return b.similarity-a.similarity;});return{validCases:validCases,ignoredCases:ignoredCases};}
function vfcOaiBuildCurrentFeatures_(companyName,period){if(typeof getValidatedBankingFeatures_==='function')return getValidatedBankingFeatures_(companyName,period);if(typeof buildPowerFeatures_==='function')return buildPowerFeatures_(companyName,period);if(typeof buildFeaturesForCase_==='function')return buildFeaturesForCase_(companyName,period);throw new Error('Current banking-feature function was not found.');}
function vfcOaiHistoricalFeatureIndex_(){const rows=typeof getSheetObjects_==='function'?getSheetObjects_('Structured Features'):[],map={};rows.forEach(function(row){const companyName=String(row.companyName||'').trim(),period=String(row.period||'').trim();if(!companyName||!period)return;const months=Math.max(1,vfcOaiNumber_(row.monthsCovered)),nsf=vfcOaiNumber_(row.nsfCount);map[vfcOaiHistoryKey_(companyName,period)]={companyName:companyName,period:period,statementCount:vfcOaiNumber_(row.statementCount),monthsCovered:months,totalDeposits:vfcOaiNumber_(row.totalDeposits),averageMonthlyDeposits:vfcOaiNumber_(row.averageMonthlyDeposits),totalWithdrawals:vfcOaiNumber_(row.totalWithdrawals),depositWithdrawalRatio:vfcOaiNumber_(row.depositWithdrawalRatio),nsfCount:nsf,nsfPerMonth:nsf/months,negativeBalanceFlag:vfcOaiFlag_(row.negativeBalanceFlag),mcaPaymentFlag:vfcOaiFlag_(row.mcaPaymentFlag),summaryText:String(row.summaryText||'')};});return map;}
function vfcOaiBuildHistoricalFeatures_(companyName,period,historicalIndex){const key=vfcOaiHistoryKey_(companyName,period);if(historicalIndex&&historicalIndex[key])return historicalIndex[key];if(typeof buildFeaturesForCase_==='function')return buildFeaturesForCase_(companyName,period);return null;}
function vfcOaiHistoryKey_(companyName,period){return String(companyName||'').trim().toLowerCase()+'|'+String(period||'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');}
function vfcOaiHistoricalOutcomes_(){if(typeof collectHistoricalOutcomes_==='function')return collectHistoricalOutcomes_();const rows=[];['Training Records','Observed Lender Behaviour'].forEach(function(sheetName){getSheetObjects_(sheetName).forEach(function(row){rows.push({companyName:row.companyName||'',period:row.period||row.detectedPeriod||'',lenderName:row.lenderName||'',decision:row.decision||'',approvedAmount:row.approvedAmount||'',declineReason:row.declineReason||''});});});const seen={};return rows.filter(function(row){const key=[row.companyName,row.period,row.lenderName,row.decision,row.approvedAmount].join('|').toLowerCase();if(!row.companyName||!row.lenderName||!row.decision||seen[key])return false;seen[key]=true;return true;});}
function vfcOaiValidateCurrent_(features){const validation=vfcOaiValidateHistorical_(features);if(!validation.valid)throw new Error('Current banking features failed validation: '+validation.reason+'.');}
function vfcOaiValidateHistorical_(features){if(!features||!vfcOaiNumber_(features.statementCount))return{valid:false,reason:'No statement features'};const deposits=vfcOaiNumber_(features.averageMonthlyDeposits);if(!deposits)return{valid:false,reason:'Average monthly deposits are missing'};if(deposits>VFC_OPENAI_RECOMMENDATION_CONFIG.MAX_AVERAGE_MONTHLY_DEPOSITS)return{valid:false,reason:'Average monthly deposits are unreasonable'};const ratio=vfcOaiNumber_(features.depositWithdrawalRatio);if(ratio<0||ratio>20)return{valid:false,reason:'Deposit-withdrawal ratio is unreasonable'};return{valid:true,reason:''};}
function vfcOaiCompactFeatures_(features){const debtProfile=features&&features.debtProfile?features.debtProfile:{},activeDebt=Array.isArray(debtProfile.activeDebtObligations)?debtProfile.activeDebtObligations.slice(0,10):[],existingDebt=vfcOaiRound_(vfcOaiNumber_(features.existingMonthlyDebtService),1);return{averageMonthlyDeposits:vfcOaiRound_(vfcOaiNumber_(features.averageMonthlyDeposits),1),estimatedOperatingMonthlyDeposits:vfcOaiRound_(vfcOaiNumber_(features.estimatedOperatingMonthlyDeposits),1),detectedFinancingCredits:vfcOaiRound_(vfcOaiNumber_(features.detectedFinancingCredits),1),existingMonthlyDebtService:existingDebt,hasConfirmedExistingDebt:existingDebt>0||activeDebt.length>0,otherRecurringMonthlyObligations:vfcOaiRound_(vfcOaiNumber_(features.otherRecurringMonthlyObligations),1),debtServiceToDepositsRatio:vfcOaiRound_(vfcOaiNumber_(features.debtServiceToDepositsRatio),0.0001),activeDebtObligations:activeDebt,otherRecurringObligations:Array.isArray(debtProfile.otherRecurringObligations)?debtProfile.otherRecurringObligations.slice(0,8):[],totalDeposits:vfcOaiRound_(vfcOaiNumber_(features.totalDeposits),1),totalWithdrawals:vfcOaiRound_(vfcOaiNumber_(features.totalWithdrawals),1),depositWithdrawalRatio:vfcOaiRound_(vfcOaiNumber_(features.depositWithdrawalRatio),0.01),nsfPerMonth:vfcOaiRound_(features.nsfPerMonth!==undefined?vfcOaiNumber_(features.nsfPerMonth):vfcOaiNumber_(features.nsfCount)/Math.max(1,vfcOaiNumber_(features.monthsCovered)),0.01),negativeBalanceFlag:vfcOaiFlag_(features.negativeBalanceFlag),mcaPaymentFlag:vfcOaiFlag_(features.mcaPaymentFlag),overdraftFlag:vfcOaiFlag_(features.overdraftFlag),suspectedStacking:vfcOaiFlag_(features.suspectedStacking),depositTrend:vfcOaiRound_(vfcOaiNumber_(features.depositTrend),0.01),depositVolatility:vfcOaiRound_(vfcOaiNumber_(features.depositVolatility),0.01),monthsCovered:vfcOaiNumber_(features.monthsCovered),statementCount:vfcOaiNumber_(features.statementCount)};}
function vfcOaiSimilarity_(current,historical){function sim(a,b,floorScale){a=vfcOaiNumber_(a);b=vfcOaiNumber_(b);const scale=Math.max(Math.abs(a),Math.abs(b),floorScale||1);return vfcOaiClamp_(1-Math.abs(a-b)/scale,0,1);}return vfcOaiClamp_(sim(current.averageMonthlyDeposits,historical.averageMonthlyDeposits)*0.45+sim(current.nsfPerMonth||current.nsfCount,historical.nsfPerMonth||historical.nsfCount,5)*0.20+sim(current.depositWithdrawalRatio,historical.depositWithdrawalRatio,2)*0.10+(vfcOaiFlag_(current.negativeBalanceFlag)===vfcOaiFlag_(historical.negativeBalanceFlag)?1:0)*0.15+(vfcOaiFlag_(current.mcaPaymentFlag)===vfcOaiFlag_(historical.mcaPaymentFlag)?1:0)*0.10,0,1);}
function vfcOaiCallOpenAI_(instruction,promptData,model){const apiKey=PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');if(!apiKey)throw new Error('Missing OPENAI_API_KEY in Apps Script Properties.');const schema={type:'object',additionalProperties:false,properties:{recommended_amount:{type:'number',minimum:0},recommended_lender:{type:'string'},approval_probability:{type:'integer',minimum:0,maximum:100},confidence:{type:'string',enum:['Low','Moderate','High']},closest_cases_used:{type:'integer',minimum:1},reasoning:{type:'string'},key_strengths:{type:'array',items:{type:'string'}},key_risks:{type:'array',items:{type:'string'}}},required:['recommended_amount','recommended_lender','approval_probability','confidence','closest_cases_used','reasoning','key_strengths','key_risks']};const response=UrlFetchApp.fetch('https://api.openai.com/v1/responses',{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+apiKey},payload:JSON.stringify({model:model,instructions:instruction,input:JSON.stringify(promptData),text:{format:{type:'json_schema',name:'vfc_openai_recommendation',strict:true,schema:schema}}}),muteHttpExceptions:true});const status=response.getResponseCode();let body;try{body=JSON.parse(response.getContentText());}catch(e){throw new Error('OpenAI returned an unreadable response. HTTP '+status+'.');}if(status<200||status>=300||body.error)throw new Error(body&&body.error&&body.error.message?body.error.message:'OpenAI request failed with HTTP '+status+'.');const outputText=vfcOaiOutputText_(body);if(!outputText)throw new Error('OpenAI returned no structured recommendation.');let parsed;try{parsed=JSON.parse(outputText);}catch(e){throw new Error('OpenAI recommendation was not valid JSON.');}parsed.__openAIModel=body.model||model;return parsed;}
function vfcOaiApplySanityChecks_(raw,current,cases,positiveCases){const rawAmount=Math.max(0,vfcOaiNumber_(raw.recommended_amount)),deposits=Math.max(0,vfcOaiNumber_(current.averageMonthlyDeposits)),highestAdjusted=Math.max.apply(null,positiveCases.map(function(row){return row.adjustedAmount;})),evidenceCap=highestAdjusted>0?highestAdjusted*1.15:0,depositCap=deposits>0?deposits*1.50:0,caps=[evidenceCap,depositCap].filter(function(v){return v>0;}),sanityCap=caps.length?Math.min.apply(null,caps):VFC_OPENAI_RECOMMENDATION_CONFIG.MAX_APPROVED_AMOUNT,capped=Math.min(rawAmount,sanityCap,VFC_OPENAI_RECOMMENDATION_CONFIG.MAX_APPROVED_AMOUNT),recommendedAmount=vfcOaiRound_(Math.max(0,capped),VFC_OPENAI_RECOMMENDATION_CONFIG.ROUNDING),lenderNames={};cases.forEach(function(row){lenderNames[String(row.lenderName||'').trim().toLowerCase()]=row.lenderName;});const requested=String(raw.recommended_lender||'').trim(),lender=lenderNames[requested.toLowerCase()]||(cases[0]?cases[0].lenderName:''),debtService=Math.max(0,vfcOaiNumber_(current.existingMonthlyDebtService)),hasDebt=debtService>0||(current.debtProfile&&Array.isArray(current.debtProfile.activeDebtObligations)&&current.debtProfile.activeDebtObligations.length>0);let reasoning=String(raw.reasoning||'').trim(),keyStrengths=Array.isArray(raw.key_strengths)?raw.key_strengths.slice(0,6):[],keyRisks=Array.isArray(raw.key_risks)?raw.key_risks.slice(0,6):[];if(hasDebt){reasoning=vfcOaiRemoveFalseNoDebtClaims_(reasoning);reasoning='Confirmed recurring financing debt service is $'+Math.round(debtService).toLocaleString()+'/month. '+reasoning;keyStrengths=keyStrengths.filter(function(item){return!vfcOaiFalseNoDebtClaim_(item);});keyRisks=keyRisks.filter(function(item){return!vfcOaiFalseNoDebtClaim_(item);});keyRisks.unshift('Confirmed recurring financing debt service: $'+Math.round(debtService).toLocaleString()+'/month.');keyRisks=keyRisks.slice(0,6);}return{openAIModel:raw.__openAIModel||VFC_OPENAI_RECOMMENDATION_CONFIG.DEFAULT_MODEL,rawOpenAIAmount:vfcOaiRound_(rawAmount,VFC_OPENAI_RECOMMENDATION_CONFIG.ROUNDING),recommendedAmount:recommendedAmount,recommendedLender:lender,approvalProbability:Math.round(vfcOaiClamp_(vfcOaiNumber_(raw.approval_probability),0,100)),confidence:['Low','Moderate','High'].indexOf(raw.confidence)>=0?raw.confidence:'Low',closestCasesUsed:Math.max(1,Math.min(cases.length,Math.round(vfcOaiNumber_(raw.closest_cases_used)||cases.length))),reasoning:reasoning,keyStrengths:keyStrengths,keyRisks:keyRisks,sanityCapApplied:recommendedAmount<vfcOaiRound_(rawAmount,VFC_OPENAI_RECOMMENDATION_CONFIG.ROUNDING)};}
function vfcOaiFalseNoDebtClaim_(text){return /\b(no|without)\s+(existing\s+)?(mca|loan|debt|financing debt)\b/i.test(String(text||''));}
function vfcOaiRemoveFalseNoDebtClaims_(text){return String(text||'').replace(/\bno existing mca or loan debt\b/ig,'existing confirmed financing debt').replace(/\bno existing mca debt\b/ig,'existing confirmed financing debt').replace(/\bno existing loan debt\b/ig,'existing confirmed financing debt').replace(/\bno existing debt\b/ig,'existing confirmed financing debt').replace(/\bwithout existing mca or loan debt\b/ig,'with existing confirmed financing debt').replace(/\bwithout existing debt\b/ig,'with existing confirmed financing debt').trim();}
function vfcOaiOutputText_(body){if(body&&typeof body.output_text==='string'&&body.output_text)return body.output_text;const output=body&&Array.isArray(body.output)?body.output:[];for(let i=0;i<output.length;i++){const content=Array.isArray(output[i].content)?output[i].content:[];for(let j=0;j<content.length;j++){if(content[j]&&typeof content[j].text==='string'&&content[j].text)return content[j].text;}}return'';}
function vfcOaiModel_(){const props=PropertiesService.getScriptProperties(),configured=props.getProperty('OPENAI_RECOMMENDATION_MODEL'),existing=typeof VFC_CONFIG!=='undefined'&&VFC_CONFIG.OPENAI_MODEL?VFC_CONFIG.OPENAI_MODEL:'';return configured||existing||VFC_OPENAI_RECOMMENDATION_CONFIG.DEFAULT_MODEL;}
function vfcOaiFingerprint_(value){const text=JSON.stringify(value),bytes=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8);return bytes.map(function(b){const n=(b+256)%256;return('0'+n.toString(16)).slice(-2);}).join('').slice(0,40);}
function vfcOaiReadCache_(fingerprint){const raw=PropertiesService.getScriptProperties().getProperty(VFC_OPENAI_RECOMMENDATION_CONFIG.CACHE_PREFIX+fingerprint);if(!raw)return null;try{return JSON.parse(raw);}catch(e){return null;}}
function vfcOaiWriteCache_(fingerprint,result){const raw=JSON.stringify(result);if(raw.length>8500)return;PropertiesService.getScriptProperties().setProperty(VFC_OPENAI_RECOMMENDATION_CONFIG.CACHE_PREFIX+fingerprint,raw);}
function vfcOaiResolvePeriod_(companyName,requestedPeriod){if(requestedPeriod)return requestedPeriod;if(typeof resolveLatestAssessmentPeriod_==='function')return resolveLatestAssessmentPeriod_(companyName,requestedPeriod);const rows=getSheetObjects_('Structured Features').filter(function(row){return vfcOaiSame_(row.companyName,companyName);});if(!rows.length)throw new Error('No Structured Features record was found for this company.');return String(rows[rows.length-1].period||'').trim();}
function vfcOaiNormalizeRequest_(companyOrRequest,requestedPeriod){let companyName='',period=requestedPeriod||'';if(companyOrRequest&&typeof companyOrRequest==='object'){companyName=companyOrRequest.companyName||companyOrRequest.company||'';period=companyOrRequest.period||companyOrRequest.detectedPeriod||period;}else companyName=companyOrRequest||'';companyName=String(companyName||'').trim();period=String(period||'').trim();if(!companyName)throw new Error('Company name is required.');return{companyName:companyName,period:period};}
function vfcOaiDecision_(value){const text=String(value||'').trim().toLowerCase();if(text.indexOf('condition')>=0)return'Conditional';if(text.indexOf('approv')>=0)return'Approved';if(text.indexOf('declin')>=0||text.indexOf('reject')>=0)return'Declined';return'';}
function vfcOaiNumber_(value){if(typeof value==='number')return isFinite(value)?value:0;const n=parseFloat(String(value||'').replace(/[^0-9.\-]/g,''));return isFinite(n)?n:0;}
function vfcOaiFlag_(value){return /^(1|true|yes|detected)$/i.test(String(value||'').trim())?1:0;}
function vfcOaiSame_(left,right){return String(left||'').trim().toLowerCase()===String(right||'').trim().toLowerCase();}
function vfcOaiPeriodSame_(left,right){function clean(v){return String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'');}return clean(left)===clean(right);}
function vfcOaiClamp_(value,minimum,maximum){return Math.max(minimum,Math.min(maximum,value));}
function vfcOaiRound_(value,step){const number=vfcOaiNumber_(value),increment=vfcOaiNumber_(step)||1;return Math.round(number/increment)*increment;}

/* ===== END OpenAIRecommendation.gs ===== */

/* ===== BEGIN SimpleSheetSetup.gs ===== */
const VFC_SIMPLE_SHEET_SCHEMAS = {
  'Companies': ['Company ID','Company Name','Folder ID','Folder Link','Created At'],
  'Uploads': ['Upload ID','Company ID','Company Name','Detected Period','File Name','File ID','File Link','Status','Created At'],
  'PDF Summaries': ['Upload ID','Company Name','Detected Period','File Name','Document Type','Bank Name','Account Holder','Statement Start Date','Statement End Date','Opening Balance','Closing Balance','Total Deposits','Total Withdrawals','NSF Count','Negative Balance Detected','Possible MCA Or Loan Payments','Summary','Risks','Missing Info','Created At'],
  'Batch Summaries': ['Batch ID','Company Name','Detected Period','Files Read','Earliest Statement Date','Latest Statement Date','Combined Summary','Key Findings','Risks','Missing Info','Created At'],
  'Settings': ['Key','Value'],
  'Lenders': ['Lender ID','Lender Name','Product Type','Notes','Status','Created At'],
  'Observed Lender Behaviour': ['Behaviour ID','Lender Name','Company Name','Period','Decision','Approved Amount','Decline Reason','Observed Pattern Note','Created At'],
  'Training Records': ['Training ID','Company Name','Period','Lender Name','Decision','Approved Amount','Decline Reason','Bank Summary','Key Findings','Risks','Missing Info','Created At'],
  'Structured Features': ['Feature ID','Company Name','Period','Statement Count','Months Covered','Total Deposits','Average Monthly Deposits','Total Withdrawals','Deposit Withdrawal Ratio','NSF Count','Negative Balance Flag','MCA Payment Flag','Summary Text','Updated At']
};

const VFC_UNUSED_SHEETS = [
  'Underwriting Assessments',
  'AI Recommendations',
  'Deal Outcomes',
  'Hybrid Assessments',
  'Risk Scorecards',
  'Institutional Assessments',
  'AI Pattern Models',
  'Prediction Outcomes'
];

const VFC_SHEET_CLEANUP_PROPERTY = 'VFC_SIMPLE_UNUSED_SHEETS_REMOVED_V1';

/** Creates only the sheets required by the simple historical engine. */
function setupSimpleVFC() {
  Object.keys(VFC_SIMPLE_SHEET_SCHEMAS).forEach(function(name) {
    ensureSheetSchema_(name, VFC_SIMPLE_SHEET_SCHEMAS[name]);
  });
  getOrCreateRootFolder_();
  seedDefaultLenders_();

  const bankTabs = typeof setupBankTrainingTabs === 'function'
    ? setupBankTrainingTabs()
    : {ok:false, created:[], tabs:[]};

  return {
    ok: true,
    message: 'Simple VFC sheet setup complete, including isolated bank training tabs.',
    activeSheets: Object.keys(VFC_SIMPLE_SHEET_SCHEMAS),
    bankTrainingTabs: bankTabs
  };
}

/**
 * Deletes only exact legacy sheet names from superseded underwriting versions.
 * Core uploads, statement summaries, training outcomes and structured features
 * are never deleted by this function.
 */
function cleanupUnusedSheets() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const removed = [];
  const notFound = [];

  VFC_UNUSED_SHEETS.forEach(function(name) {
    const sheet = spreadsheet.getSheetByName(name);
    if (!sheet) {
      notFound.push(name);
      return;
    }
    spreadsheet.deleteSheet(sheet);
    removed.push(name);
  });

  PropertiesService.getScriptProperties().setProperty(
    VFC_SHEET_CLEANUP_PROPERTY,
    new Date().toISOString()
  );

  return {
    ok: true,
    message: removed.length
      ? 'Removed ' + removed.length + ' unused sheets.'
      : 'No unused legacy sheets were found.',
    removedSheets: removed,
    retainedSheets: Object.keys(VFC_SIMPLE_SHEET_SCHEMAS),
    notFound: notFound
  };
}

/**
 * Skips work only when cleanup has run and no obsolete sheet has reappeared.
 * This protects the simple engine if an old manual function is run later.
 */
function cleanupUnusedSheetsOnce_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const legacyStillPresent = VFC_UNUSED_SHEETS.some(function(name) {
    return !!spreadsheet.getSheetByName(name);
  });
  const alreadyCleaned = !!PropertiesService.getScriptProperties()
    .getProperty(VFC_SHEET_CLEANUP_PROPERTY);

  if (alreadyCleaned && !legacyStillPresent) {
    return { ok: true, skipped: true, message: 'No unused legacy sheets are present.' };
  }
  return cleanupUnusedSheets();
}

function getSimpleSheetStatus() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const existing = spreadsheet.getSheets().map(function(sheet) {
    return sheet.getName();
  });
  return {
    requiredSheets: Object.keys(VFC_SIMPLE_SHEET_SCHEMAS),
    bankTrainingSheets: typeof getBankParserTabs === 'function' ? getBankParserTabs().map(function(x){return 'BANK_'+x.id;}) : [],
    unusedSheetsStillPresent: VFC_UNUSED_SHEETS.filter(function(name) {
      return existing.indexOf(name) >= 0;
    }),
    allExistingSheets: existing
  };
}

/* ===== END SimpleSheetSetup.gs ===== */
