const VFC_CONFIG = {
  ROOT_FOLDER_NAME: 'VFC AI Engine',
  OPENAI_MODEL: 'gpt-4.1-mini',
  PDF_EXTRACTION_MODEL: 'gpt-4.1',
  PDF_REPAIR_MODEL: 'gpt-4.1',

  // PDF intake: OpenAI file input is primary. Google Drive OCR is fallback only.
  PDF_TEXT_PROVIDER: 'OPENAI_FILE_INPUT',
  PDF_TEXT_CACHE_VERSION: 'VFC-PDF-TEXT-4.0-RBC-GENERIC-COLUMNS',
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
  // Rebuild only explicitly labelled lender outcomes; assessment/test uploads are not training cases.
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
      'Prioritize the complete Account Summary and every Account Activity Details page through the Closing balance. These sections must be transcribed in full before anything else.',
      'For tables, preserve row boundaries. If column spacing cannot be preserved, linearize the row and explicitly retain the printed column meaning, for example: DESCRIPTION ... | DEBIT 123.45 | CREDIT | BALANCE -45.67.',
      'Never decide debit/credit direction from the description. Use only the column in which the amount is printed.',
      'Words such as CREDIT, DEBIT, PAYMENT, REFUND or CARD can be part of a transaction description and do not determine direction. For example, RBC CREDIT CARD printed under Cheques & Debits must remain a DEBIT.',
      'Preserve NSF, returned/unpaid/reversal wording exactly when readable.',
      'Do not add Opening balance, Closing balance, summary totals or cheque-image/support-page values as transaction rows when they are not Account Activity.',
      'After the Account Activity Closing balance, omit cheque-image/support pages, marketing pages and boilerplate. They are not inputs to the ledger and must not consume transcription space.',
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
    if(String(VFC_CONFIG.PDF_TEXT_CACHE_VERSION).indexOf('VFC-PDF-TEXT-4.0')!==0)throw new Error('stale PDF cache generation');
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
