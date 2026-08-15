const VFC_CONFIG = {
  ROOT_FOLDER_NAME: 'VFC AI Engine',
  OPENAI_MODEL: 'gpt-4.1-mini',
  OCR_RETRY_ATTEMPTS: 5,
  OCR_DELAY_MS: 1800,
  MODEL_VERSION: 'VFC-V1.0',
  MAX_SIMILAR_CASES: 10
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('VFC AI Underwriting Engine')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Safe setup: creates missing sheets/columns without deleting existing data. */
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

  Object.keys(schemas).forEach(name => ensureSheetSchema_(name, schemas[name]));
  getOrCreateRootFolder_();
  seedDefaultLenders_();
  return { ok:true, message:'VFC Underwriting Engine V1 setup complete. Existing data was preserved.' };
}

function uploadStatementBatch(companyName, files) {
  if (!companyName) throw new Error('Company name is required.');
  if (!files || !files.length) throw new Error('Upload at least one PDF.');

  const company = getOrCreateCompany_(companyName);
  const companyFolder = DriveApp.getFolderById(company.folderId);
  const tempFolder = getOrCreateSubFolder_(companyFolder, '_TEMP_PROCESSING');
  const processedFiles = [];
  const startDates = [];
  const endDates = [];

  files.forEach((file, index) => {
    if (index > 0) Utilities.sleep(VFC_CONFIG.OCR_DELAY_MS);
    const fileName = file.name || 'statement.pdf';
    const blob = Utilities.newBlob(
      Utilities.base64Decode(file.base64),
      'application/pdf',
      fileName.toLowerCase().endsWith('.pdf') ? fileName : fileName + '.pdf'
    );

    const tempFile = tempFolder.createFile(blob);
    const text = extractTextFromPdf_(tempFile.getId());
    const summary = summarizeSingleBankStatement_(text, companyName, fileName);
    const documentType = String(summary && summary.document_type || '')
      .trim().toUpperCase().replace(/\s+/g, '_');
    if (summary) summary.document_type = documentType;
    if (documentType === 'BANK_STATEMENT') {
      if (!Array.isArray(summary.banking_transactions)) {
        throw new Error('Banking ledger extraction was incomplete for ' + fileName + '.');
      }
      if (typeof vfcBankCreateIntakePayload_ === 'function') {
        summary.possible_mca_or_loan_payments = vfcBankCreateIntakePayload_(summary, fileName);
      }
    }
    const startDate = parseDateSafe_(summary.statement_start_date);
    const endDate = parseDateSafe_(summary.statement_end_date);
    if (startDate) startDates.push(startDate);
    if (endDate) endDates.push(endDate);

    processedFiles.push({
      uploadId: Utilities.getUuid(),
      fileName:fileName,
      fileId:tempFile.getId(),
      fileUrl:tempFile.getUrl(),
      summary:summary
    });
  });

  const period = buildDetectedPeriod_(startDates, endDates);
  const periodFolder = getOrCreateSubFolder_(companyFolder, period.label);
  const batchInput = [];

  processedFiles.forEach(item => {
    const driveFile = DriveApp.getFileById(item.fileId);
    periodFolder.addFile(driveFile);
    tempFolder.removeFile(driveFile);

    appendRow_('Uploads', [item.uploadId,company.companyId,companyName,period.label,item.fileName,item.fileId,item.fileUrl,item.summary.document_type === 'BANK_STATEMENT' ? 'READ' : 'REVIEW_REQUIRED',new Date()]);
    appendRow_('PDF Summaries', [item.uploadId,companyName,period.label,item.fileName,item.summary.document_type || '',item.summary.bank_name || '',item.summary.account_holder || '',item.summary.statement_start_date || '',item.summary.statement_end_date || '',item.summary.opening_balance || '',item.summary.closing_balance || '',item.summary.total_deposits || '',item.summary.total_withdrawals || '',item.summary.nsf_count || '',item.summary.negative_balance_detected || '',item.summary.possible_mca_or_loan_payments || '',item.summary.summary || '',item.summary.risks || '',item.summary.missing_info || '',new Date()]);
    batchInput.push({ fileName:item.fileName, summary:item.summary });
  });

  const batch = summarizeBatch_(batchInput, companyName, period.label);
  appendRow_('Batch Summaries', [Utilities.getUuid(),companyName,period.label,files.length,period.earliest || '',period.latest || '',batch.combined_summary || '',batch.key_findings || '',batch.risks || '',batch.missing_info || '',new Date()]);
  upsertStructuredFeature_(companyName, period.label);

  return {
    ok:true,
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

  return { ok:true, message:'Historical lender outcome saved to the VFC training dataset.' };
}

/** Builds/rebuilds structured metrics for all historical company-period records. */
function rebuildStructuredFeatures() {
  setupVFC();
  const pairs = {};
  getSheetObjects_('PDF Summaries').forEach(row => {
    const company = row.companyName || '';
    const period = row.detectedPeriod || '';
    if (company) pairs[normalizeKey_(company, period)] = { companyName:company, period:period };
  });
  collectHistoricalOutcomes_().forEach(row => {
    if (row.companyName) pairs[normalizeKey_(row.companyName, row.period)] = { companyName:row.companyName, period:row.period || '' };
  });

  let updated = 0;
  Object.keys(pairs).forEach(key => {
    upsertStructuredFeature_(pairs[key].companyName, pairs[key].period);
    updated++;
  });
  return { ok:true, recordsUpdated:updated, message:'Structured historical features rebuilt.' };
}

/** Main V1 underwriting function. Uses only VFC historical outcomes, not invented lender rules. */
function generateVfcAssessment(companyName, period) {
  setupVFC();
  const current = buildFeaturesForCase_(companyName, period);
  if (!current || !current.statementCount) throw new Error('No bank-statement summaries found for this company and period.');

  const outcomes = collectHistoricalOutcomes_().filter(row => {
    return !(sameText_(row.companyName, companyName) && sameText_(row.period, period));
  });
  if (!outcomes.length) throw new Error('No historical lender outcomes found. Add approvals and declines first.');

  const lenders = unique_(outcomes.map(row => row.lenderName).filter(Boolean));
  const lenderResults = lenders.map(lender => scoreLender_(lender, current, outcomes));
  lenderResults.sort((a,b) => b.observedScore - a.observedScore);

  const explanation = createAssessmentExplanation_(current, lenderResults);
  const assessmentId = Utilities.getUuid();

  lenderResults.forEach(result => {
    appendRow_('Underwriting Assessments', [
      assessmentId,VFC_CONFIG.MODEL_VERSION,companyName,period,result.lenderName,result.observedFit,
      result.observedScore,result.confidence,result.historicalCases,result.similarCases,result.similarApprovals,
      result.similarDeclines,result.observedApprovalRate,result.lowApprovedAmount,result.highApprovedAmount,
      result.medianApprovedAmount,result.reasoning,result.risks,new Date()
    ]);
  });

  return {
    ok:true,
    assessmentId:assessmentId,
    modelVersion:VFC_CONFIG.MODEL_VERSION,
    companyName:companyName,
    period:period,
    currentFeatures:current,
    lenderRankings:lenderResults,
    underwritingSummary:explanation,
    disclaimer:'Observed VFC historical fit only. This is decision support, not a lender approval or official lender criteria.'
  };
}

function scoreLender_(lenderName, current, outcomes) {
  const records = outcomes.filter(row => sameText_(row.lenderName, lenderName)).map(row => {
    const features = buildFeaturesForCase_(row.companyName, row.period);
    return {
      companyName:row.companyName,
      period:row.period,
      decision:normalizeDecision_(row.decision),
      approvedAmount:toNumber_(row.approvedAmount),
      declineReason:row.declineReason || '',
      features:features,
      similarity:features && features.statementCount ? similarityScore_(current, features) : 0
    };
  }).filter(row => row.features && row.features.statementCount);

  records.sort((a,b) => b.similarity - a.similarity);
  const similar = records.slice(0, VFC_CONFIG.MAX_SIMILAR_CASES);
  const approvals = similar.filter(row => row.decision === 'Approved' || row.decision === 'Conditional');
  const declines = similar.filter(row => row.decision === 'Declined');
  const approvalRate = similar.length ? approvals.length / similar.length : 0;
  const averageSimilarity = similar.length ? similar.reduce((sum,row) => sum + row.similarity,0) / similar.length : 0;
  const observedScore = Math.round((approvalRate * 70) + (averageSimilarity * 30));
  const amounts = approvals.map(row => row.approvedAmount).filter(n => n > 0).sort((a,b) => a-b);
  const declineReasons = unique_(declines.map(row => row.declineReason).filter(Boolean)).slice(0,3);

  let fit = 'Weak observed fit';
  if (similar.length < 3) fit = 'Insufficient history';
  else if (approvalRate >= 0.70 && averageSimilarity >= 0.55) fit = 'Strong observed fit';
  else if (approvalRate >= 0.45) fit = 'Moderate observed fit';

  let confidence = 'Low';
  if (records.length >= 15 && similar.length >= 8) confidence = 'High';
  else if (records.length >= 6 && similar.length >= 4) confidence = 'Moderate';

  const reasoning = similar.length
    ? approvals.length + ' of ' + similar.length + ' most similar VFC cases were approved or conditional. Average similarity: ' + Math.round(averageSimilarity * 100) + '%.'
    : 'No comparable historical cases were available for this lender.';

  return {
    lenderName:lenderName,
    observedFit:fit,
    observedScore:observedScore,
    confidence:confidence,
    historicalCases:records.length,
    similarCases:similar.length,
    similarApprovals:approvals.length,
    similarDeclines:declines.length,
    observedApprovalRate:similar.length ? Math.round(approvalRate * 100) + '%' : 'N/A',
    lowApprovedAmount:amounts.length ? amounts[0] : '',
    highApprovedAmount:amounts.length ? amounts[amounts.length - 1] : '',
    medianApprovedAmount:amounts.length ? median_(amounts) : '',
    reasoning:reasoning,
    risks:declineReasons.join('\n'),
    similarCaseDetails:similar.slice(0,5).map(row => ({
      companyName:row.companyName,
      period:row.period,
      decision:row.decision,
      approvedAmount:row.approvedAmount || '',
      similarity:Math.round(row.similarity * 100) + '%'
    }))
  };
}

function similarityScore_(a, b) {
  const depositSimilarity = numericSimilarity_(a.averageMonthlyDeposits, b.averageMonthlyDeposits);
  const nsfSimilarity = numericSimilarity_(a.nsfCount, b.nsfCount, 5);
  const withdrawalSimilarity = numericSimilarity_(a.depositWithdrawalRatio, b.depositWithdrawalRatio, 2);
  const negativeSimilarity = a.negativeBalanceFlag === b.negativeBalanceFlag ? 1 : 0;
  const mcaSimilarity = a.mcaPaymentFlag === b.mcaPaymentFlag ? 1 : 0;
  return clamp_(depositSimilarity * 0.45 + nsfSimilarity * 0.20 + withdrawalSimilarity * 0.10 + negativeSimilarity * 0.15 + mcaSimilarity * 0.10, 0, 1);
}

function numericSimilarity_(a, b, floorScale) {
  a = toNumber_(a); b = toNumber_(b);
  const scale = Math.max(Math.abs(a), Math.abs(b), floorScale || 1);
  return clamp_(1 - Math.abs(a-b)/scale, 0, 1);
}

function buildFeaturesForCase_(companyName, period) {
  const pdfRows = getSheetObjects_('PDF Summaries').filter(row => sameText_(row.companyName, companyName) && (!period || sameText_(row.detectedPeriod, period)));
  const batch = getLatestBatchSummary_(companyName, period) || {};
  if (!pdfRows.length && !batch.companyName) return null;

  const starts = pdfRows.map(row => parseDateSafe_(row.statementStartDate)).filter(Boolean);
  const ends = pdfRows.map(row => parseDateSafe_(row.statementEndDate)).filter(Boolean);
  const monthsCovered = estimateMonthsCovered_(starts, ends, pdfRows.length);
  const totalDeposits = pdfRows.reduce((sum,row) => sum + toNumber_(row.totalDeposits),0);
  const totalWithdrawals = pdfRows.reduce((sum,row) => sum + toNumber_(row.totalWithdrawals),0);
  const nsfCount = pdfRows.reduce((sum,row) => sum + toNumber_(row.nsfCount),0);
  const negativeFlag = pdfRows.some(row => truthyFlag_(row.negativeBalanceDetected)) ? 1 : 0;
  const mcaFlag = pdfRows.some(row => hasMeaningfulMca_(row.possibleMcaOrLoanPayments)) ? 1 : 0;

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
  const features = buildFeaturesForCase_(companyName, period);
  if (!features) return null;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Structured Features');
  const values = sheet.getDataRange().getValues();
  let rowNumber = 0;
  for (let i=1;i<values.length;i++) {
    if (sameText_(values[i][1], companyName) && sameText_(values[i][2], period)) { rowNumber = i+1; break; }
  }
  const row = [Utilities.getUuid(),companyName,period,features.statementCount,features.monthsCovered,features.totalDeposits,features.averageMonthlyDeposits,features.totalWithdrawals,features.depositWithdrawalRatio,features.nsfCount,features.negativeBalanceFlag,features.mcaPaymentFlag,features.summaryText,new Date()].map(cleanCell_);
  if (rowNumber) {
    row[0] = values[rowNumber-1][0] || row[0];
    sheet.getRange(rowNumber,1,1,row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
  return features;
}

function collectHistoricalOutcomes_() {
  let rows = [];
  ['Training Records','Observed Lender Behaviour','Lender Decisions'].forEach(sheetName => {
    getSheetObjects_(sheetName).forEach(row => {
      rows.push({
        companyName:row.companyName || '',
        period:row.period || row.detectedPeriod || '',
        lenderName:row.lenderName || '',
        decision:row.decision || row.finalResult || '',
        approvedAmount:row.approvedAmount || row.fundedAmount || '',
        declineReason:row.declineReason || '',
        createdAt:row.createdAt || ''
      });
    });
  });

  const seen = {};
  return rows.filter(row => row.companyName && row.lenderName && row.decision).filter(row => {
    const key = [row.companyName,row.period,row.lenderName,row.decision,row.approvedAmount,row.declineReason].map(v => String(v).trim().toLowerCase()).join('|');
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function createAssessmentExplanation_(features, rankings) {
  const deterministic = {
    summary:'VFC historical comparison completed.',
    strongest_lender:rankings.length ? rankings[0].lenderName : '',
    explanation:rankings.length ? rankings[0].reasoning : '',
    key_risks:rankings.length ? rankings[0].risks : ''
  };
  try {
    const prompt = 'You are the VFC underwriting analyst. Return JSON only with summary, strongest_lender, explanation, key_risks. ' +
      'Use only the supplied VFC historical observations. Do not invent lender criteria or promise approval. Keep the explanation concise.\n\n' +
      'Current features:\n' + JSON.stringify(features) + '\n\nLender rankings:\n' + JSON.stringify(rankings.slice(0,4));
    return callOpenAIJson_(prompt);
  } catch (e) {
    return deterministic;
  }
}

function extractTextFromPdf_(fileId) {
  const sourceFile = DriveApp.getFileById(fileId);
  const pdfBlob = sourceFile.getBlob().setContentType('application/pdf').setName(sourceFile.getName());
  let lastError = null;

  for (let attempt=1; attempt<=VFC_CONFIG.OCR_RETRY_ATTEMPTS; attempt++) {
    try {
      const converted = Drive.Files.insert({ title:'OCR_' + sourceFile.getName() }, pdfBlob, { convert:true, ocr:true, ocrLanguage:'en' });
      const doc = DocumentApp.openById(converted.id);
      const text = doc.getBody().getText();
      DriveApp.getFileById(converted.id).setTrashed(true);
      return text || '';
    } catch (error) {
      lastError = error;
      const message = String(error && error.message || error);
      const retryable = /rate limit|quota|user rate limit|backend error|internal error/i.test(message);
      if (!retryable || attempt === VFC_CONFIG.OCR_RETRY_ATTEMPTS) break;
      Utilities.sleep(Math.min(60000, VFC_CONFIG.OCR_DELAY_MS * Math.pow(2, attempt)));
    }
  }
  throw new Error('Google Drive OCR is temporarily unavailable after automatic retries. Please wait and upload fewer PDFs. Original error: ' + String(lastError && lastError.message || lastError));
}

function summarizeSingleBankStatement_(text, companyName, fileName) {
  const prompt = [
    'You are the VFC AI Bank Statement Reader. Return JSON only.',
    'Company: ' + companyName,
    'File: ' + fileName,
    '',
    'Return these fields:',
    'document_type, bank_name, account_holder, statement_start_date, statement_end_date, opening_balance, closing_balance, total_deposits, total_withdrawals, nsf_count, negative_balance_detected, possible_mca_or_loan_payments, banking_transactions, summary, risks, missing_info.',
    '',
    'BANKING TRANSACTIONS is an array of factual ledger rows only:',
    '{date:"YYYY-MM-DD", description:"exact visible description", counterparty:"short counterparty", direction:"DEBIT" or "CREDIT", amount:number}.',
    '',
    'Rules:',
    '1. The printed bank column controls direction. Deposits/Credits = CREDIT. Cheques/Debits = DEBIT. Never infer direction from wording.',
    '2. Extract financing/loan/PAD/MCA/advance/funding/capital transactions, loan interest, recurring PADs, tax/government payments, insurance/premium finance and credit-card payments.',
    '3. Also extract incoming credits of $5,000 or more when the description/counterparty could plausibly be financing; classification will be done later by deterministic code.',
    '4. Do not classify or calculate recurrence, monthly debt, or underwriting capacity. Extract facts only.',
    '5. Do not duplicate cheque-image pages. Do not attach a nearby amount to another row.',
    '6. Header totals must come from the statement summary/header, not from transaction summing.',
    '7. Use YYYY-MM-DD dates. Do not invent figures. If uncertain, omit the transaction.',
    '8. If not a bank statement, set document_type to NOT_BANK_STATEMENT and banking_transactions to an empty array.',
    '9. Return risks, missing_info and possible_mca_or_loan_payments as readable strings.',
    '',
    'Document text:',
    String(text || '').substring(0,60000)
  ].join('\n');
  return callOpenAIJson_(prompt);
}

function summarizeBatch_(items, companyName, detectedPeriod) {
  const combined = items.map(item => {
    const source = item.summary || {};
    const slim = {};
    [
      'document_type','bank_name','account_holder','statement_start_date','statement_end_date',
      'opening_balance','closing_balance','total_deposits','total_withdrawals','nsf_count',
      'negative_balance_detected','summary','risks','missing_info'
    ].forEach(key => { if (source[key] !== undefined) slim[key] = source[key]; });
    return 'FILE: ' + item.fileName + '\nSUMMARY: ' + JSON.stringify(slim);
  }).join('\n\n');
  const prompt = 'You are the VFC AI Batch Bank Statement Summarizer. Return JSON only with combined_summary, key_findings, risks, missing_info. ' +
    'Return every field as a readable string, not an array. Do not approve or decline and do not invent figures.\nCompany: ' + companyName + '\nDetected period: ' + detectedPeriod + '\nPDF summaries:\n' + combined;
  return callOpenAIJson_(prompt);
}

function callOpenAIJson_(prompt) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY in Script Properties.');
  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method:'post', contentType:'application/json', headers:{ Authorization:'Bearer ' + apiKey },
    payload:JSON.stringify({ model:VFC_CONFIG.OPENAI_MODEL, input:prompt, text:{ format:{ type:'json_object' } } }), muteHttpExceptions:true
  });
  const body = JSON.parse(response.getContentText());
  if (body.error) throw new Error(body.error.message);
  let outputText = body.output_text || '';
  if (!outputText && body.output && body.output[0] && body.output[0].content && body.output[0].content[0]) outputText = body.output[0].content[0].text || '';
  if (!outputText) throw new Error('OpenAI response text not found.');
  return JSON.parse(outputText);
}

function getLatestBatchSummary_(companyName, period) {
  const rows = getSheetObjects_('Batch Summaries').filter(row => sameText_(row.companyName, companyName) && (!period || sameText_(row.detectedPeriod, period)));
  return rows.length ? rows[rows.length-1] : null;
}

function getSheetObjects_(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(normalizeHeader_);
  return values.slice(1).filter(row => row.some(cell => String(cell).trim() !== '')).map(row => {
    const obj = {};
    headers.forEach((header,index) => obj[header] = row[index]);
    return obj;
  });
}

function ensureSheetSchema_(sheetName, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    return;
  }
  const current = sheet.getRange(1,1,1,Math.max(sheet.getLastColumn(),1)).getValues()[0].map(v => String(v).trim());
  headers.forEach(header => {
    if (current.indexOf(header) === -1) {
      current.push(header);
      sheet.getRange(1,current.length).setValue(header);
    }
  });
}

function appendRow_(sheetName, row) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) throw new Error('Missing sheet: ' + sheetName + '. Run setupVFC first.');
  sheet.appendRow(row.map(cleanCell_));
}

function cleanCell_(value) {
  if (value === null || value === undefined) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') return value;
  if (Array.isArray(value)) return value.map(cleanCell_).filter(Boolean).join('\n');
  if (typeof value === 'object') return Object.keys(value).map(key => key + ': ' + cleanCell_(value[key])).join('\n');
  return String(value);
}

function getOrCreateCompany_(companyName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Companies');
  const values = sheet.getDataRange().getValues();
  for (let i=1;i<values.length;i++) {
    if (sameText_(values[i][1], companyName)) return { companyId:values[i][0], companyName:values[i][1], folderId:values[i][2], folderLink:values[i][3] };
  }
  const folder = getOrCreateSubFolder_(getOrCreateRootFolder_(), cleanFolderName_(companyName));
  const companyId = Utilities.getUuid();
  sheet.appendRow([companyId,companyName,folder.getId(),folder.getUrl(),new Date()]);
  return { companyId:companyId, companyName:companyName, folderId:folder.getId(), folderLink:folder.getUrl() };
}

function seedDefaultLenders_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Lenders');
  const existing = getSheetObjects_('Lenders').map(row => String(row.lenderName || '').toLowerCase());
  ['Journey Capital','Merchant Growth','iCapital Financing','Canacap Funding'].forEach(name => {
    if (existing.indexOf(name.toLowerCase()) === -1) sheet.appendRow([Utilities.getUuid(),name,'Merchant Cash Advance','','Active',new Date()]);
  });
}

function getOrCreateRootFolder_() {
  const folders = DriveApp.getFoldersByName(VFC_CONFIG.ROOT_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(VFC_CONFIG.ROOT_FOLDER_NAME);
}

function getOrCreateSubFolder_(parent, name) {
  const cleanName = cleanFolderName_(name);
  const folders = parent.getFoldersByName(cleanName);
  return folders.hasNext() ? folders.next() : parent.createFolder(cleanName);
}

function buildDetectedPeriod_(startDates, endDates) {
  const all = (startDates || []).concat(endDates || []).filter(Boolean).sort((a,b) => a.getTime()-b.getTime());
  if (!all.length) return { label:'Period Not Detected', earliest:'', latest:'' };
  return { label:formatMonthYear_(all[0]) + ' to ' + formatMonthYear_(all[all.length-1]), earliest:formatDate_(all[0]), latest:formatDate_(all[all.length-1]) };
}

function estimateMonthsCovered_(starts, ends, fallback) {
  if (starts.length && ends.length) {
    const earliest = new Date(Math.min.apply(null, starts.map(d => d.getTime())));
    const latest = new Date(Math.max.apply(null, ends.map(d => d.getTime())));
    const days = Math.max(1, (latest-earliest)/(1000*60*60*24)+1);
    return Math.max(1, Math.round(days/30.4375));
  }
  return Math.max(1, fallback || 1);
}

function parseDateSafe_(value) { if (!value) return null; const date = new Date(value); return isNaN(date.getTime()) ? null : date; }
function formatMonthYear_(date) { return Utilities.formatDate(date,Session.getScriptTimeZone(),'MMM yyyy'); }
function formatDate_(date) { return Utilities.formatDate(date,Session.getScriptTimeZone(),'yyyy-MM-dd'); }
function cleanFolderName_(name) { return String(name || 'Unknown').replace(/[\\/:*?"<>|]/g,'-').trim(); }
function normalizeHeader_(header) { return String(header || '').trim().replace(/[^a-zA-Z0-9]+(.)/g,(_,chr) => chr.toUpperCase()).replace(/^[A-Z]/,c => c.toLowerCase()); }
function normalizeKey_(company, period) { return String(company || '').trim().toLowerCase() + '|' + String(period || '').trim().toLowerCase(); }
function sameText_(a,b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
function unique_(items) { const seen={}; return items.filter(item => { const key=String(item).trim().toLowerCase(); if (!key || seen[key]) return false; seen[key]=true; return true; }); }
function normalizeDecision_(value) { const text=String(value || '').trim().toLowerCase(); if (text.indexOf('approv')>=0) return 'Approved'; if (text.indexOf('declin')>=0) return 'Declined'; if (text.indexOf('condition')>=0) return 'Conditional'; return value || ''; }
function toNumber_(value) { if (typeof value === 'number') return isFinite(value) ? value : 0; const cleaned=String(value || '').replace(/[^0-9.\-]/g,''); const number=parseFloat(cleaned); return isFinite(number) ? number : 0; }
function truthyFlag_(value) { return /yes|true|detected|negative|1/i.test(String(value || '')); }
function hasMeaningfulMca_(value) { const text=String(cleanCell_(value) || '').trim(); return !!text && !/^(no|none|not detected|false|0)$/i.test(text); }
function clamp_(value,min,max) { return Math.max(min,Math.min(max,value)); }
function round2_(value) { return Math.round((Number(value) || 0)*100)/100; }
function median_(values) { if (!values.length) return ''; const middle=Math.floor(values.length/2); return values.length%2 ? values[middle] : Math.round((values[middle-1]+values[middle])/2*100)/100; }
