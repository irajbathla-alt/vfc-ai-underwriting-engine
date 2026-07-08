const VFC_CONFIG = {
  ROOT_FOLDER_NAME: 'VFC AI Engine',
  OPENAI_MODEL: 'gpt-4.1-mini'
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('VFC AI Underwriting Engine')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function setupVFC() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tabs = [
    'Companies', 'Uploads', 'PDF Summaries', 'Batch Summaries', 'Settings',
    'Lenders', 'Lender Criteria', 'Lender Decisions', 'AI Recommendations', 'Deal Outcomes'
  ];

  tabs.forEach(name => {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });

  setHeaders_('Companies', ['Company ID', 'Company Name', 'Folder ID', 'Folder Link', 'Created At']);
  setHeaders_('Uploads', ['Upload ID', 'Company ID', 'Company Name', 'Detected Period', 'File Name', 'File ID', 'File Link', 'Status', 'Created At']);
  setHeaders_('PDF Summaries', ['Upload ID', 'Company Name', 'Detected Period', 'File Name', 'Document Type', 'Bank Name', 'Account Holder', 'Statement Start Date', 'Statement End Date', 'Opening Balance', 'Closing Balance', 'Total Deposits', 'Total Withdrawals', 'NSF Count', 'Negative Balance Detected', 'Possible MCA Or Loan Payments', 'Summary', 'Risks', 'Missing Info', 'Created At']);
  setHeaders_('Batch Summaries', ['Batch ID', 'Company Name', 'Detected Period', 'Files Read', 'Earliest Statement Date', 'Latest Statement Date', 'Combined Summary', 'Key Findings', 'Risks', 'Missing Info', 'Created At']);
  setHeaders_('Settings', ['Key', 'Value']);
  setHeaders_('Lenders', ['Lender ID', 'Lender Name', 'Product Type', 'Contact Name', 'Contact Email', 'Notes', 'Status', 'Created At']);
  setHeaders_('Lender Criteria', ['Criteria ID', 'Lender Name', 'Minimum Monthly Revenue', 'Minimum Time In Business Months', 'Province Accepted', 'Industry Restrictions', 'NSF Tolerance', 'Existing MCA Tolerance', 'Required Documents', 'Notes', 'Last Updated']);
  setHeaders_('Lender Decisions', ['Decision ID', 'Company Name', 'Period', 'Lender Name', 'Decision', 'Approved Amount', 'Decline Reason', 'Conditions', 'Payment Frequency', 'Payment Amount', 'Factor Rate Or Interest', 'Term', 'Date Submitted', 'Date Decision Received', 'Notes', 'Created At']);
  setHeaders_('AI Recommendations', ['Recommendation ID', 'Company Name', 'Period', 'Recommended Lender', 'Fit Level', 'Reasoning', 'Risks', 'Missing Info', 'Created At']);
  setHeaders_('Deal Outcomes', ['Outcome ID', 'Company Name', 'Period', 'Selected Lender', 'AI Recommended Lender', 'Final Result', 'Funded Amount', 'Funded Date', 'Why This Lender Won', 'Admin Notes', 'Created At']);

  getOrCreateRootFolder_();
  seedDefaultLenders_();
  return { ok: true, message: 'VFC setup complete with lender engine tabs.' };
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

  files.forEach(file => {
    const fileName = file.name || 'statement.pdf';
    const blob = Utilities.newBlob(
      Utilities.base64Decode(file.base64),
      'application/pdf',
      fileName.toLowerCase().endsWith('.pdf') ? fileName : fileName + '.pdf'
    );

    const tempFile = tempFolder.createFile(blob);
    const text = extractTextFromPdf_(tempFile.getId());
    const summary = summarizeSingleBankStatement_(text, companyName, fileName);

    const startDate = parseDateSafe_(summary.statement_start_date);
    const endDate = parseDateSafe_(summary.statement_end_date);
    if (startDate) startDates.push(startDate);
    if (endDate) endDates.push(endDate);

    processedFiles.push({
      uploadId: Utilities.getUuid(),
      fileName,
      fileId: tempFile.getId(),
      fileUrl: tempFile.getUrl(),
      summary
    });
  });

  const period = buildDetectedPeriod_(startDates, endDates);
  const periodFolder = getOrCreateSubFolder_(companyFolder, period.label);
  const batchInput = [];

  processedFiles.forEach(item => {
    const driveFile = DriveApp.getFileById(item.fileId);
    periodFolder.addFile(driveFile);
    tempFolder.removeFile(driveFile);

    appendRow_('Uploads', [item.uploadId, company.companyId, companyName, period.label, item.fileName, item.fileId, item.fileUrl, item.summary.document_type === 'BANK_STATEMENT' ? 'READ' : 'REVIEW_REQUIRED', new Date()]);
    appendRow_('PDF Summaries', [item.uploadId, companyName, period.label, item.fileName, item.summary.document_type || '', item.summary.bank_name || '', item.summary.account_holder || '', item.summary.statement_start_date || '', item.summary.statement_end_date || '', item.summary.opening_balance || '', item.summary.closing_balance || '', item.summary.total_deposits || '', item.summary.total_withdrawals || '', item.summary.nsf_count || '', item.summary.negative_balance_detected || '', item.summary.possible_mca_or_loan_payments || '', item.summary.summary || '', item.summary.risks || '', item.summary.missing_info || '', new Date()]);
    batchInput.push({ fileName: item.fileName, summary: item.summary });
  });

  const batch = summarizeBatch_(batchInput, companyName, period.label);
  appendRow_('Batch Summaries', [Utilities.getUuid(), companyName, period.label, files.length, period.earliest || '', period.latest || '', batch.combined_summary || '', batch.key_findings || '', batch.risks || '', batch.missing_info || '', new Date()]);

  return {
    ok: true,
    companyName,
    detectedPeriod: period.label,
    filesUploaded: files.length,
    companyFolderLink: company.folderLink,
    periodFolderLink: periodFolder.getUrl(),
    batchSummary: batch
  };
}

function saveLender(payload) {
  appendRow_('Lenders', [
    Utilities.getUuid(),
    payload.lenderName || '',
    payload.productType || 'Merchant Cash Advance',
    payload.contactName || '',
    payload.contactEmail || '',
    payload.notes || '',
    payload.status || 'Active',
    new Date()
  ]);
  return { ok: true, message: 'Lender saved.' };
}

function saveLenderCriteria(payload) {
  appendRow_('Lender Criteria', [
    Utilities.getUuid(),
    payload.lenderName || '',
    payload.minimumMonthlyRevenue || '',
    payload.minimumTimeInBusinessMonths || '',
    payload.provinceAccepted || '',
    payload.industryRestrictions || '',
    payload.nsfTolerance || '',
    payload.existingMcaTolerance || '',
    payload.requiredDocuments || '',
    payload.notes || '',
    new Date()
  ]);
  return { ok: true, message: 'Lender criteria saved.' };
}

function saveLenderDecision(payload) {
  appendRow_('Lender Decisions', [
    Utilities.getUuid(),
    payload.companyName || '',
    payload.period || '',
    payload.lenderName || '',
    payload.decision || '',
    payload.approvedAmount || '',
    payload.declineReason || '',
    payload.conditions || '',
    payload.paymentFrequency || '',
    payload.paymentAmount || '',
    payload.factorRateOrInterest || '',
    payload.term || '',
    payload.dateSubmitted || '',
    payload.dateDecisionReceived || '',
    payload.notes || '',
    new Date()
  ]);
  return { ok: true, message: 'Lender decision saved.' };
}

function saveDealOutcome(payload) {
  appendRow_('Deal Outcomes', [
    Utilities.getUuid(),
    payload.companyName || '',
    payload.period || '',
    payload.selectedLender || '',
    payload.aiRecommendedLender || '',
    payload.finalResult || '',
    payload.fundedAmount || '',
    payload.fundedDate || '',
    payload.whyThisLenderWon || '',
    payload.adminNotes || '',
    new Date()
  ]);
  return { ok: true, message: 'Deal outcome saved.' };
}

function generateLenderRecommendation(companyName, period) {
  const batch = getLatestBatchSummary_(companyName, period);
  const criteria = getSheetObjects_('Lender Criteria');
  const decisions = getSheetObjects_('Lender Decisions');

  if (!batch) throw new Error('No batch summary found for this company/period. Upload bank statements first.');

  const prompt =
    'You are the VFC AI Lender Fit Engine. Return JSON only with recommendations array. ' +
    'Each recommendation must include recommended_lender, fit_level, reasoning, risks, missing_info. ' +
    'Do not say approved. Do not invent lender criteria. Separate actual criteria from observed decisions.\n\n' +
    'Company: ' + companyName + '\nPeriod: ' + period + '\n\n' +
    'Bank statement batch summary:\n' + JSON.stringify(batch) + '\n\n' +
    'Lender criteria:\n' + JSON.stringify(criteria) + '\n\n' +
    'Historical lender decisions:\n' + JSON.stringify(decisions.slice(-100));

  const ai = callOpenAIJson_(prompt);
  const recs = ai.recommendations || [];

  recs.forEach(rec => {
    appendRow_('AI Recommendations', [
      Utilities.getUuid(),
      companyName,
      period,
      rec.recommended_lender || '',
      rec.fit_level || '',
      rec.reasoning || '',
      rec.risks || '',
      rec.missing_info || '',
      new Date()
    ]);
  });

  return { ok: true, recommendations: recs };
}

function getAppData() {
  return {
    ok: true,
    lenders: getSheetObjects_('Lenders'),
    criteria: getSheetObjects_('Lender Criteria'),
    batchSummaries: getSheetObjects_('Batch Summaries').slice(-50),
    decisions: getSheetObjects_('Lender Decisions').slice(-50),
    recommendations: getSheetObjects_('AI Recommendations').slice(-50)
  };
}

function extractTextFromPdf_(fileId) {
  const sourceFile = DriveApp.getFileById(fileId);
  const pdfBlob = sourceFile.getBlob().setContentType('application/pdf').setName(sourceFile.getName());
  const resource = { title: 'OCR_' + sourceFile.getName() };
  const converted = Drive.Files.insert(resource, pdfBlob, { convert: true, ocr: true, ocrLanguage: 'en' });
  const doc = DocumentApp.openById(converted.id);
  const text = doc.getBody().getText();
  DriveApp.getFileById(converted.id).setTrashed(true);
  return text || '';
}

function summarizeSingleBankStatement_(text, companyName, fileName) {
  const prompt = 'You are the VFC AI Bank Statement Reader. Return JSON only.' +
    '\nCompany: ' + companyName +
    '\nFile: ' + fileName +
    '\nReturn fields: document_type, bank_name, account_holder, statement_start_date, statement_end_date, opening_balance, closing_balance, total_deposits, total_withdrawals, nsf_count, negative_balance_detected, possible_mca_or_loan_payments, summary, risks, missing_info.' +
    '\nRules: only analyze bank statements; if not a bank statement set document_type to NOT_BANK_STATEMENT; use YYYY-MM-DD dates; do not invent numbers; blank string if not visible; ignore tax documents for V1.' +
    '\nDocument text:\n' + String(text || '').substring(0, 60000);
  return callOpenAIJson_(prompt);
}

function summarizeBatch_(items, companyName, detectedPeriod) {
  const combined = items.map(item => 'FILE: ' + item.fileName + '\nSUMMARY: ' + JSON.stringify(item.summary)).join('\n\n');
  const prompt = 'You are the VFC AI Batch Bank Statement Summarizer. Return JSON only with combined_summary, key_findings, risks, missing_info.' +
    '\nCompany: ' + companyName +
    '\nDetected period: ' + detectedPeriod +
    '\nSummarize bank-statement information only. Do not say approved or declined. Do not invent figures.' +
    '\nPDF summaries:\n' + combined;
  return callOpenAIJson_(prompt);
}

function callOpenAIJson_(prompt) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY in Script Properties.');

  const payload = {
    model: VFC_CONFIG.OPENAI_MODEL,
    input: prompt,
    text: { format: { type: 'json_object' } }
  };

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const body = JSON.parse(response.getContentText());
  if (body.error) throw new Error(body.error.message);

  let outputText = '';
  if (body.output_text) outputText = body.output_text;
  else if (body.output && body.output.length && body.output[0].content && body.output[0].content.length && body.output[0].content[0].text) outputText = body.output[0].content[0].text;
  if (!outputText) throw new Error('OpenAI response text not found: ' + response.getContentText());

  return JSON.parse(outputText);
}

function buildDetectedPeriod_(startDates, endDates) {
  const allDates = [];
  (startDates || []).forEach(d => { if (d) allDates.push(d); });
  (endDates || []).forEach(d => { if (d) allDates.push(d); });
  if (!allDates.length) return { label: 'Period Not Detected', earliest: '', latest: '' };
  allDates.sort((a, b) => a.getTime() - b.getTime());
  const earliest = allDates[0];
  const latest = allDates[allDates.length - 1];
  return { label: formatMonthYear_(earliest) + ' to ' + formatMonthYear_(latest), earliest: formatDate_(earliest), latest: formatDate_(latest) };
}

function parseDateSafe_(value) {
  if (!value) return null;
  const date = new Date(value);
  if (isNaN(date.getTime())) return null;
  return date;
}

function formatMonthYear_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'MMM yyyy');
}

function formatDate_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function getOrCreateCompany_(companyName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Companies');
  const values = sheet.getDataRange().getValues();
  const normalized = String(companyName).trim().toLowerCase();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][1]).trim().toLowerCase() === normalized) {
      return { companyId: values[i][0], companyName: values[i][1], folderId: values[i][2], folderLink: values[i][3] };
    }
  }
  const root = getOrCreateRootFolder_();
  const folder = getOrCreateSubFolder_(root, cleanFolderName_(companyName));
  const companyId = Utilities.getUuid();
  sheet.appendRow([companyId, companyName, folder.getId(), folder.getUrl(), new Date()]);
  return { companyId, companyName, folderId: folder.getId(), folderLink: folder.getUrl() };
}

function getLatestBatchSummary_(companyName, period) {
  const rows = getSheetObjects_('Batch Summaries');
  const matches = rows.filter(row => String(row.companyName || '').toLowerCase() === String(companyName || '').toLowerCase() && String(row.detectedPeriod || '') === String(period || ''));
  return matches.length ? matches[matches.length - 1] : null;
}

function getSheetObjects_(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(normalizeHeader_);
  return values.slice(1).filter(row => row.join('').trim() !== '').map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
}

function normalizeHeader_(header) {
  return String(header || '').trim().replace(/[^a-zA-Z0-9]+(.)/g, function(_, chr) { return chr.toUpperCase(); }).replace(/^[A-Z]/, c => c.toLowerCase());
}

function seedDefaultLenders_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Lenders');
  const existing = getSheetObjects_('Lenders').map(l => String(l.lenderName || '').toLowerCase());
  ['Journey Capital', 'Merchant Growth', 'iCapital Financing', 'Canacap Funding'].forEach(name => {
    if (!existing.includes(name.toLowerCase())) {
      sheet.appendRow([Utilities.getUuid(), name, 'Merchant Cash Advance', '', '', '', 'Active', new Date()]);
    }
  });
}

function getOrCreateRootFolder_() {
  const folders = DriveApp.getFoldersByName(VFC_CONFIG.ROOT_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(VFC_CONFIG.ROOT_FOLDER_NAME);
}

function getOrCreateSubFolder_(parent, name) {
  const cleanName = cleanFolderName_(name);
  const folders = parent.getFoldersByName(cleanName);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(cleanName);
}

function cleanFolderName_(name) {
  return String(name || 'Unknown').replace(/[\\/:*?"<>|]/g, '-').trim();
}

function setHeaders_(sheetName, headers) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  sheet.clear();
  sheet.appendRow(headers);
}

function appendRow_(sheetName, row) {
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName).appendRow(row);
}
