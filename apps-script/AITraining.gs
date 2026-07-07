function syncAITrainingFiles(options) {
  options = options || {};
  const folderId = options.folderId || CONFIG.AI_TRAINING_FOLDER_ID;
  if (!folderId || folderId === 'PASTE_AI_TRAINING_FOLDER_ID_HERE') {
    throw new Error('Missing AI_TRAINING_FOLDER_ID. Set it to the Drive folder that contains training files.');
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
    if (!String(text || '').trim()) throw new Error('No readable text found in training file. Use Google Docs, text, CSV, or pasted statement text.');

    const trainingCase = analyzeTrainingFileWithOpenAI({
      fileName,
      fileUrl,
      trainingText: text
    });
    const normalizedCase = normalizeTrainingCase(trainingCase, fileName);

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
      normalizedCase.notes
    ]);

    return {
      ok: true,
      fileId,
      fileName,
      caseId: normalizedCase.case_id,
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
      ''
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
    trainingCase.notes
  ]);
}

function appendTrainingFileLog(row) {
  appendRow(CONFIG.AI_TRAINING_FILES_TAB, row);
}

function normalizeTrainingCase(result, fileName) {
  result = result || {};
  return {
    case_id: result.case_id || ('CASE-' + new Date().getTime()),
    lender_name: result.lender_name || 'Unknown Lender',
    decision: normalizeDecision(result.decision),
    funded: normalizeYesNo(result.funded),
    approved_amount: Number(result.approved_amount || 0),
    requested_amount: Number(result.requested_amount || 0),
    industry: result.industry || '',
    time_in_business: result.time_in_business || '',
    credit_score: Number(result.credit_score || 0),
    average_monthly_deposits: Number(result.average_monthly_deposits || 0),
    nsf_count: Number(result.nsf_count || 0),
    negative_days: Number(result.negative_days || 0),
    existing_mca_payments: Number(result.existing_mca_payments || 0),
    revenue_trend: result.revenue_trend || 'unknown',
    reason_approved: result.reason_approved || '',
    reason_declined: result.reason_declined || '',
    conditions: Array.isArray(result.conditions) ? result.conditions.join('; ') : (result.conditions || ''),
    statement_months_reviewed: Number(result.statement_months_reviewed || 0),
    decision_date: result.decision_date || '',
    notes: result.notes || ('Created from AI training file: ' + fileName)
  };
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
  }, 'sample.txt');
  Logger.log(JSON.stringify(sample, null, 2));
  return sample;
}
