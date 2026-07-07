function syncAITrainingFiles(options) {
  options = options || {};
  const folderId = options.folderId || CONFIG.AI_TRAINING_FOLDER_ID;
  if (!folderId || folderId === 'PASTE_AI_TRAINING_FOLDER_ID_HERE') {
    throw new Error('Missing AI_TRAINING_FOLDER_ID. Set it to the Drive folder that contains training files. Admin portal uploads do not need this setting.');
  }

  const processedFileIds = getProcessedTrainingFileIds();
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFiles();
  const limit = Number(options.limit || 25);
  const results = [];

  while (files.hasNext() && results.length < limit) {
    const file = files.next();
    const fileId = file.getId();
    if (processedFileIds[fileId]) continue;
    results.push(processAITrainingFile(file));
  }

  return {
    ok: true,
    processed: results.length,
    results
  };
}

function processAITrainingFile(file) {
  const trainingFileId = 'TRN-' + new Date().getTime() + '-' + Math.floor(Math.random() * 10000);
  const fileId = file.getId();
  const fileName = file.getName();
  const fileUrl = file.getUrl();

  try {
    const text = extractTrainingFileText(file);
    if (!String(text || '').trim()) throw new Error('No readable text found in training file. Use Google Docs, text, CSV, or pasted statement text. For scanned PDFs, upload from Admin Portal so OpenAI can read the PDF file directly.');

    const trainingCase = analyzeTrainingFileWithOpenAI({
      fileName,
      fileUrl,
      trainingText: text
    });
    const normalizedCase = normalizeTrainingCase(trainingCase, fileName, fileUrl);

    appendHistoricalCaseFromTrainingFile(normalizedCase);
    appendTrainingFileLog([
      trainingFileId,
      new Date(),
      fileId,
      fileName,
      fileUrl,
      'Processed',
      normalizedCase.case_id,
      normalizedCase.lender_name,
      normalizedCase.decision,
      '',
      buildTrainingLogNotes(normalizedCase)
    ]);

    return {
      ok: true,
      fileId,
      fileName,
      caseId: normalizedCase.case_id,
      businessName: normalizedCase.business_name,
      ownerName: normalizedCase.owner_name,
      lenderName: normalizedCase.lender_name,
      decision: normalizedCase.decision
    };
  } catch (error) {
    appendTrainingFileLog([
      trainingFileId,
      new Date(),
      fileId,
      fileName,
      fileUrl,
      'Error',
      '',
      '',
      '',
      error.message,
      'OpenAI or file extraction failed. Confirm OPENAI_API_KEY is set and file type is PDF, CSV, TXT, DOCX, or readable Google Doc.'
    ]);

    return {
      ok: false,
      fileId,
      fileName,
      error: error.message
    };
  }
}

function getProcessedTrainingFileIds() {
  const rows = getRows(CONFIG.AI_TRAINING_FILES_TAB);
  if (!rows || rows.length <= 1) return {};

  const processed = {};
  rowsToObjects(rows).forEach(row => {
    if (row.fileId && row.status === 'Processed') processed[row.fileId] = true;
  });
  return processed;
}

function extractTrainingFileText(file) {
  const mimeType = file.getMimeType();
  if (mimeType === MimeType.GOOGLE_DOCS) {
    return DocumentApp.openById(file.getId()).getBody().getText();
  }

  const textMimeTypes = [
    MimeType.CSV,
    MimeType.PLAIN_TEXT,
    'text/csv',
    'text/plain',
    'application/json'
  ];

  if (textMimeTypes.indexOf(mimeType) !== -1 || String(file.getName()).match(/\.(txt|csv|json|md)$/i)) {
    return file.getBlob().getDataAsString();
  }

  return file.getBlob().getDataAsString();
}

function appendHistoricalCaseFromTrainingFile(trainingCase) {
  appendRow(CONFIG.HISTORICAL_CASES_TAB, [
    trainingCase.case_id,
    trainingCase.lender_name,
    trainingCase.decision,
    trainingCase.funded,
    trainingCase.approved_amount,
    trainingCase.requested_amount,
    trainingCase.industry,
    trainingCase.time_in_business,
    trainingCase.credit_score,
    trainingCase.average_monthly_deposits,
    trainingCase.nsf_count,
    trainingCase.negative_days,
    trainingCase.existing_mca_payments,
    trainingCase.revenue_trend,
    trainingCase.reason_approved,
    trainingCase.reason_declined,
    trainingCase.conditions,
    trainingCase.statement_months_reviewed,
    trainingCase.decision_date,
    buildHistoricalCaseNotes(trainingCase)
  ]);
}

function appendTrainingFileLog(row) {
  appendRow(CONFIG.AI_TRAINING_FILES_TAB, row);
}

function normalizeTrainingCase(result, fileName, fileUrl) {
  result = result || {};
  const businessName = result.business_name || result.businessName || result.company_name || result.client_business_name || '';
  const ownerName = result.owner_name || result.ownerName || result.client_name || result.borrower_name || result.applicant_name || '';
  return {
    case_id: result.case_id || ('CASE-' + new Date().getTime()),
    business_name: businessName,
    owner_name: ownerName,
    lender_name: result.lender_name || result.lenderName || 'Unknown Lender',
    decision: normalizeDecision(result.decision),
    funded: normalizeYesNo(result.funded),
    approved_amount: Number(result.approved_amount || result.approvedAmount || 0),
    requested_amount: Number(result.requested_amount || result.requestedAmount || 0),
    industry: result.industry || '',
    time_in_business: result.time_in_business || result.timeInBusiness || '',
    credit_score: Number(result.credit_score || result.creditScore || 0),
    average_monthly_deposits: Number(result.average_monthly_deposits || result.averageMonthlyDeposits || 0),
    nsf_count: Number(result.nsf_count || result.nsfCount || 0),
    negative_days: Number(result.negative_days || result.negativeDays || 0),
    existing_mca_payments: Number(result.existing_mca_payments || result.existingMcaPayments || 0),
    revenue_trend: result.revenue_trend || result.revenueTrend || 'unknown',
    reason_approved: result.reason_approved || result.reasonApproved || '',
    reason_declined: result.reason_declined || result.reasonDeclined || '',
    conditions: Array.isArray(result.conditions) ? result.conditions.join('; ') : (result.conditions || ''),
    statement_months_reviewed: Number(result.statement_months_reviewed || result.statementMonthsReviewed || 0),
    decision_date: result.decision_date || result.decisionDate || '',
    source_file_url: fileUrl || result.file_url || '',
    notes: result.notes || ('Created from AI training file: ' + fileName)
  };
}

function buildHistoricalCaseNotes(trainingCase) {
  const pieces = [];
  if (trainingCase.business_name) pieces.push('Business: ' + trainingCase.business_name);
  if (trainingCase.owner_name) pieces.push('Owner: ' + trainingCase.owner_name);
  if (trainingCase.source_file_url) pieces.push('Source: ' + trainingCase.source_file_url);
  if (trainingCase.notes) pieces.push(trainingCase.notes);
  return pieces.join(' | ');
}

function buildTrainingLogNotes(trainingCase) {
  return [
    trainingCase.business_name ? 'Business: ' + trainingCase.business_name : '',
    trainingCase.owner_name ? 'Owner: ' + trainingCase.owner_name : '',
    trainingCase.notes || ''
  ].filter(Boolean).join(' | ');
}

function normalizeDecision(value) {
  const decision = String(value || '').toLowerCase();
  if (decision === 'approved') return 'Approved';
  if (decision === 'declined') return 'Declined';
  return 'Unknown';
}

function normalizeYesNo(value) {
  const text = String(value || '').toLowerCase();
  if (text === 'yes' || text === 'true' || text === 'funded') return 'Yes';
  if (text === 'no' || text === 'false' || text === 'not funded') return 'No';
  return 'No';
}

function testSyncAITrainingFileWithSampleText() {
  const sample = normalizeTrainingCase({
    case_id: 'CASE-SAMPLE-001',
    business_name: 'ABC Pizza Ltd',
    owner_name: 'John Smith',
    lender_name: 'Journey Capital',
    decision: 'Approved',
    funded: 'Yes',
    approved_amount: 50000,
    requested_amount: 60000,
    industry: 'Restaurant',
    time_in_business: '3 years',
    credit_score: 680,
    average_monthly_deposits: 70000,
    nsf_count: 2,
    negative_days: 3,
    existing_mca_payments: 0,
    revenue_trend: 'stable',
    reason_approved: 'Strong deposits',
    conditions: ['6 months statements'],
    statement_months_reviewed: 6,
    decision_date: '2026-01-01'
  }, 'sample.txt', 'sample-url');
  Logger.log(JSON.stringify(sample, null, 2));
  return sample;
}
