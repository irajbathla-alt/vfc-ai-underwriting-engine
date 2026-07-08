const VFC_CONFIG = {
  ROOT_FOLDER_NAME: 'VFC AI Engine',
  SHEET_NAME: 'VFC AI Document Engine',
  OPENAI_MODEL: 'gpt-4.1-mini'
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('VFC AI Admin Upload')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function setupVFC() {
  const ss = getSpreadsheet_();

  ['Companies', 'Uploads', 'PDF Summaries', 'Batch Summaries', 'Settings'].forEach(function(name) {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });

  setHeaders_('Companies', [
    'Company ID',
    'Company Name',
    'Folder ID',
    'Folder Link',
    'Created At'
  ]);

  setHeaders_('Uploads', [
    'Upload ID',
    'Company ID',
    'Company Name',
    'Detected Period',
    'File Name',
    'File ID',
    'File Link',
    'Status',
    'Created At'
  ]);

  setHeaders_('PDF Summaries', [
    'Upload ID',
    'Company Name',
    'Detected Period',
    'File Name',
    'Document Type',
    'Bank Name',
    'Account Holder',
    'Statement Start Date',
    'Statement End Date',
    'Opening Balance',
    'Closing Balance',
    'Total Deposits',
    'Total Withdrawals',
    'NSF Count',
    'Negative Balance Detected',
    'Possible MCA Or Loan Payments',
    'Summary',
    'Risks',
    'Missing Info',
    'Created At'
  ]);

  setHeaders_('Batch Summaries', [
    'Batch ID',
    'Company Name',
    'Detected Period',
    'Files Read',
    'Earliest Statement Date',
    'Latest Statement Date',
    'Combined Summary',
    'Key Findings',
    'Risks',
    'Missing Info',
    'Created At'
  ]);

  setHeaders_('Settings', ['Key', 'Value']);
  getOrCreateRootFolder_();

  return {
    ok: true,
    message: 'VFC setup complete. Tabs and root Drive folder are ready.'
  };
}

function uploadStatementBatch(companyName, files) {
  if (!String(companyName || '').trim()) throw new Error('Company name is required.');
  if (!files || !files.length) throw new Error('Upload at least one PDF bank statement.');

  const company = getOrCreateCompany_(companyName);
  const companyFolder = DriveApp.getFolderById(company.folderId);
  const tempFolder = getOrCreateSubFolder_(companyFolder, '_TEMP_PROCESSING');

  const processedFiles = [];
  const startDates = [];
  const endDates = [];

  files.forEach(function(file) {
    const blob = Utilities.newBlob(
      Utilities.base64Decode(file.base64),
      file.mimeType || MimeType.PDF,
      file.name
    );

    const tempFile = tempFolder.createFile(blob);
    const extractedText = extractTextFromPdf_(tempFile.getId());
    const aiSummary = summarizeSingleBankStatement_(extractedText, companyName, file.name);

    const startDate = parseDateSafe_(aiSummary.statement_start_date);
    const endDate = parseDateSafe_(aiSummary.statement_end_date);

    if (startDate) startDates.push(startDate);
    if (endDate) endDates.push(endDate);

    processedFiles.push({
      uploadId: Utilities.getUuid(),
      fileName: file.name,
      fileId: tempFile.getId(),
      fileUrl: tempFile.getUrl(),
      summary: aiSummary,
      statementStartDate: startDate,
      statementEndDate: endDate
    });
  });

  const periodInfo = buildDetectedPeriod_(startDates, endDates);
  const periodFolder = getOrCreateSubFolder_(companyFolder, periodInfo.label);

  const pdfSummariesForBatch = [];

  processedFiles.forEach(function(item) {
    const driveFile = DriveApp.getFileById(item.fileId);
    periodFolder.addFile(driveFile);
    tempFolder.removeFile(driveFile);

    appendRow_('Uploads', [
      item.uploadId,
      company.companyId,
      companyName,
      periodInfo.label,
      item.fileName,
      item.fileId,
      item.fileUrl,
      item.summary.document_type === 'BANK_STATEMENT' ? 'READ' : 'REVIEW_REQUIRED',
      new Date()
    ]);

    appendRow_('PDF Summaries', [
      item.uploadId,
      companyName,
      periodInfo.label,
      item.fileName,
      item.summary.document_type || '',
      item.summary.bank_name || '',
      item.summary.account_holder || '',
      item.summary.statement_start_date || '',
      item.summary.statement_end_date || '',
      item.summary.opening_balance || '',
      item.summary.closing_balance || '',
      item.summary.total_deposits || '',
      item.summary.total_withdrawals || '',
      item.summary.nsf_count || '',
      item.summary.negative_balance_detected || '',
      item.summary.possible_mca_or_loan_payments || '',
      item.summary.summary || '',
      item.summary.risks || '',
      item.summary.missing_info || '',
      new Date()
    ]);

    pdfSummariesForBatch.push({
      fileName: item.fileName,
      summary: item.summary
    });
  });

  const batchSummary = summarizeBatch_(pdfSummariesForBatch, companyName, periodInfo.label);

  appendRow_('Batch Summaries', [
    Utilities.getUuid(),
    companyName,
    periodInfo.label,
    files.length,
    periodInfo.earliest || '',
    periodInfo.latest || '',
    batchSummary.combined_summary || '',
    batchSummary.key_findings || '',
    batchSummary.risks || '',
    batchSummary.missing_info || '',
    new Date()
  ]);

  return {
    ok: true,
    companyName: companyName,
    detectedPeriod: periodInfo.label,
    filesUploaded: files.length,
    companyFolderLink: company.folderLink,
    periodFolderLink: periodFolder.getUrl(),
    batchSummary: batchSummary
  };
}

function extractTextFromPdf_(fileId) {
  const file = DriveApp.getFileById(fileId);
  const blob = file.getBlob();

  const resource = {
    title: 'OCR_' + file.getName(),
    mimeType: MimeType.GOOGLE_DOCS
  };

  const converted = Drive.Files.insert(resource, blob, {
    ocr: true,
    ocrLanguage: 'en'
  });

  const doc = DocumentApp.openById(converted.id);
  const text = doc.getBody().getText();

  DriveApp.getFileById(converted.id).setTrashed(true);
  return text || '';
}

function summarizeSingleBankStatement_(text, companyName, fileName) {
  const prompt = [
    'You are the VFC AI Bank Statement Reader.',
    '',
    'Company: ' + companyName,
    'File Name: ' + fileName,
    '',
    'Read this bank statement text and return JSON only.',
    '',
    'Required JSON:',
    '{',
    '  "document_type": "BANK_STATEMENT",',
    '  "bank_name": "",',
    '  "account_holder": "",',
    '  "statement_start_date": "",',
    '  "statement_end_date": "",',
    '  "opening_balance": "",',
    '  "closing_balance": "",',
    '  "total_deposits": "",',
    '  "total_withdrawals": "",',
    '  "nsf_count": "",',
    '  "negative_balance_detected": "",',
    '  "possible_mca_or_loan_payments": "",',
    '  "summary": "",',
    '  "risks": "",',
    '  "missing_info": ""',
    '}',
    '',
    'Rules:',
    '- Only analyze bank statements.',
    '- If the PDF is not a bank statement, set document_type to NOT_BANK_STATEMENT.',
    '- Use YYYY-MM-DD format for dates.',
    '- Do not invent numbers.',
    '- If a value is not visible, use blank string.',
    '- Read the statement period from the statement itself.',
    '- Mention NSF, returned items, overdraft, negative balance, and possible MCA/loan payments when visible.',
    '- Ignore tax-document logic for now.',
    '',
    'Document text:',
    String(text || '').substring(0, 60000)
  ].join('\n');

  return callOpenAIJson_(prompt);
}

function summarizeBatch_(pdfSummaries, companyName, detectedPeriod) {
  const combinedText = pdfSummaries.map(function(item) {
    return 'FILE: ' + item.fileName + '\nSUMMARY: ' + JSON.stringify(item.summary);
  }).join('\n\n');

  const prompt = [
    'You are the VFC AI Batch Bank Statement Summarizer.',
    '',
    'Company: ' + companyName,
    'Detected Period: ' + detectedPeriod,
    '',
    'Create one combined company-period summary from the uploaded bank statement PDFs.',
    '',
    'Return JSON only:',
    '{',
    '  "combined_summary": "",',
    '  "key_findings": "",',
    '  "risks": "",',
    '  "missing_info": ""',
    '}',
    '',
    'Rules:',
    '- Summarize only bank-statement information.',
    '- Mention whether the period appears complete or if months may be missing.',
    '- Mention underwriting risks and positive signs.',
    '- Do not say approved or declined.',
    '- Do not invent figures.',
    '',
    'PDF summaries:',
    combinedText
  ].join('\n');

  return callOpenAIJson_(prompt);
}

function callOpenAIJson_(prompt) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY in Apps Script Properties.');

  const payload = {
    model: VFC_CONFIG.OPENAI_MODEL,
    input: prompt,
    text: {
      format: {
        type: 'json_object'
      }
    }
  };

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + apiKey
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const responseText = response.getContentText();
  const body = JSON.parse(responseText);

  if (body.error) throw new Error(body.error.message);
  if (!body.output_text) throw new Error('OpenAI response did not include output_text: ' + responseText);

  return JSON.parse(body.output_text);
}

function buildDetectedPeriod_(startDates, endDates) {
  const allDates = [];
  (startDates || []).forEach(function(d) { if (d) allDates.push(d); });
  (endDates || []).forEach(function(d) { if (d) allDates.push(d); });

  if (!allDates.length) {
    return {
      label: 'Period Not Detected',
      earliest: '',
      latest: ''
    };
  }

  allDates.sort(function(a, b) { return a.getTime() - b.getTime(); });
  const earliest = allDates[0];
  const latest = allDates[allDates.length - 1];

  return {
    label: formatMonthYear_(earliest) + ' to ' + formatMonthYear_(latest),
    earliest: formatDate_(earliest),
    latest: formatDate_(latest)
  };
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
  const sheet = getSpreadsheet_().getSheetByName('Companies');
  const values = sheet.getDataRange().getValues();
  const normalized = String(companyName || '').trim().toLowerCase();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][1] || '').trim().toLowerCase() === normalized) {
      return {
        companyId: values[i][0],
        companyName: values[i][1],
        folderId: values[i][2],
        folderLink: values[i][3]
      };
    }
  }

  const root = getOrCreateRootFolder_();
  const companyFolder = getOrCreateSubFolder_(root, cleanFolderName_(companyName));
  const companyId = Utilities.getUuid();

  sheet.appendRow([
    companyId,
    companyName,
    companyFolder.getId(),
    companyFolder.getUrl(),
    new Date()
  ]);

  return {
    companyId: companyId,
    companyName: companyName,
    folderId: companyFolder.getId(),
    folderLink: companyFolder.getUrl()
  };
}

function getOrCreateRootFolder_() {
  const folders = DriveApp.getFoldersByName(VFC_CONFIG.ROOT_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(VFC_CONFIG.ROOT_FOLDER_NAME);
}

function getOrCreateSubFolder_(parentFolder, folderName) {
  const cleanName = cleanFolderName_(folderName);
  const folders = parentFolder.getFoldersByName(cleanName);
  if (folders.hasNext()) return folders.next();
  return parentFolder.createFolder(cleanName);
}

function cleanFolderName_(name) {
  return String(name || 'Unknown').replace(/[\\/:*?"<>|]/g, '-').trim();
}

function getSpreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('Open this Apps Script from the VFC AI Document Engine Google Sheet.');
}

function setHeaders_(sheetName, headers) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  sheet.clear();
  sheet.appendRow(headers);
}

function appendRow_(sheetName, row) {
  getSpreadsheet_().getSheetByName(sheetName).appendRow(row);
}
