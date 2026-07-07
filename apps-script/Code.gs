const CONFIG = {
  SHEET_ID: '1WOUtede4sE7TvsxrCJqArsT1OHLuFT4dV6b61bX1448',
  APPLICATIONS_TAB: 'Applications',
  ANALYSIS_TAB: 'Statement Analysis',
  RESULTS_TAB: 'Underwriting Results',
  ADMIN_DECISIONS_TAB: 'Admin Decisions',
  HISTORICAL_CASES_TAB: 'Historical Cases',
  AI_TRAINING_FILES_TAB: 'AI Training Files',
  CLIENT_USERS_TAB: 'Client Users',
  APPLICATION_STATUS_TAB: 'Application Status',
  LENDER_CRITERIA_TAB: 'Lender Criteria',
  ADMIN_EMAIL: 'admin@vancouverfinancecompany.com',
  DRIVE_UPLOAD_FOLDER_ID: '1OuMVNc5RnLzCPWb5h0dWdsCsHbQNICA1',
  AI_TRAINING_FOLDER_ID: 'PASTE_AI_TRAINING_FOLDER_ID_HERE',
  GCP_PROJECT_ID: 'project-a528a6b2-3583-415a-bba',
  GCS_BUCKET_NAME: 'vfc-statement-uploads',
  GCS_SERVICE_ACCOUNT_EMAIL: 'vfc-apps-script-storage-43@project-a528a6b2-3583-415a-bba.iam.gserviceaccount.com'
};

function doPost(e) {
  try {
    const request = JSON.parse(e.postData.contents || '{}');
    const action = request.action;
    const payload = request.payload || {};

    if (action === 'submitApplication') return jsonResponse(submitApplication(payload));
    if (action === 'uploadDocument') return jsonResponse(uploadDocumentForApplication(payload));
    if (action === 'uploadClientDocument') return jsonResponse(uploadClientDocument(payload));
    if (action === 'runAnalysis') return jsonResponse(runApplicationAnalysis(payload.applicationId));
    if (action === 'syncAITrainingFiles') return jsonResponse(syncAITrainingFiles(payload || {}));
    if (action === 'finalDecision' || action === 'saveFinalDecision') return jsonResponse(saveFinalDecision(payload));

    return jsonResponse({ ok: false, error: 'Unknown action' });
  } catch (error) {
    return jsonResponse({ ok: false, error: error.message });
  }
}

function doGet(e) {
  try {
    if (e.parameter.page === 'admin') {
      return HtmlService.createHtmlOutputFromFile('AdminPortal')
        .setTitle('VFC Admin Portal')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    if (e.parameter.page === 'client') {
      return HtmlService.createHtmlOutputFromFile('ClientPortal')
        .setTitle('VFC Client Portal')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    const action = e.parameter.action || '';
    let result;

    if (action === 'syncAITrainingFiles') {
      result = syncAITrainingFiles({ limit: Number(e.parameter.limit || 25) });
    } else if (action === 'listApplications') {
      result = listApplications();
    } else if (action === 'getApplicationDetail') {
      result = getApplicationDetail(e.parameter.applicationId);
    } else if (e.parameter.applicationId) {
      result = getApplicationDetail(e.parameter.applicationId);
    } else {
      result = { ok: true, message: 'VFC AI Underwriting API is running' };
    }

    return outputResponse(result, e);
  } catch (error) {
    return outputResponse({ ok: false, error: error.message }, e);
  }
}

function submitApplication(payload) {
  const applicationId = payload.applicationId || ('APP-' + new Date().getTime());
  payload.applicationId = applicationId;

  const folderResult = createApplicationFolderForPayload(payload);

  const row = [
    applicationId,
    new Date(),
    payload.businessName || '',
    payload.ownerName || '',
    payload.email || '',
    payload.phone || '',
    payload.industry || '',
    payload.timeInBusiness || '',
    payload.creditScore || '',
    payload.monthlySalesEstimate || '',
    'Submitted',
    'Application Folder: ' + folderResult.applicationFolderUrl,
    ''
  ];

  appendRow(CONFIG.APPLICATIONS_TAB, row);
  appendStatusHistory(applicationId, 'Submitted', 'Client submitted application');
  updateClientUserFromApplication(payload);
  notifyAdminNewApplication(applicationId, payload);
  return { ok: true, applicationId, folder: folderResult };
}

function uploadDocumentForApplication(payload) {
  const uploadResult = saveBase64FileToDrive(payload);
  updateApplicationDocumentLinks(payload.applicationId, uploadResult.fileUrl, uploadResult.applicationFolderUrl);
  return uploadResult;
}

function runApplicationAnalysis(applicationId) {
  if (!String(applicationId || '').trim()) return { ok: false, error: 'Missing application ID. Refresh applications and select a valid submitted application.' };
  const application = getApplication(applicationId);
  if (!application.ok) return application;

  const statementFiles = getApplicationStatementFilesForOpenAI(applicationId);
  const aiResult = analyzeApplicationStatementFilesWithOpenAI({
    files: statementFiles,
    businessName: application.data.businessName,
    ownerName: application.data.ownerName,
    creditScore: application.data.creditScore,
    timeInBusiness: application.data.timeInBusiness,
    industry: application.data.industry,
    monthlySalesEstimate: application.data.monthlySalesEstimate
  });

  appendRow(CONFIG.ANALYSIS_TAB, [
    applicationId,
    new Date(),
    aiResult.average_monthly_deposits,
    aiResult.average_monthly_withdrawals,
    aiResult.total_deposits,
    aiResult.total_withdrawals,
    aiResult.statement_months_reviewed,
    aiResult.nsf_count,
    aiResult.negative_days,
    aiResult.existing_mca_payments,
    aiResult.average_daily_balance,
    aiResult.lowest_balance,
    aiResult.revenue_trend,
    aiResult.cash_flow_strength,
    aiResult.risk_grade,
    aiResult.underwriter_notes
  ]);

  const offer = buildUnderwritingRecommendation(aiResult, application.data);
  appendRow(CONFIG.RESULTS_TAB, [
    applicationId,
    new Date(),
    offer.riskGrade,
    offer.lowOffer,
    offer.highOffer,
    offer.recommendedAction + (offer.recommendedLender ? ' | Lender fit: ' + offer.recommendedLender : ''),
    offer.conditions.concat([
      'Estimated affordable daily payment: ' + formatCurrency(offer.estimatedAffordableDailyPayment),
      'Estimated affordable weekly payment: ' + formatCurrency(offer.estimatedAffordableWeeklyPayment)
    ]).join(', ')
  ]);

  updateApplicationStatus(applicationId, 'Ready for Review', offer.recommendedLender || '');
  appendStatusHistory(applicationId, 'AI Analysis Complete', 'OpenAI analyzed uploaded bank statements and generated an affordability estimate.');

  return { ok: true, applicationId, aiResult, offer, filesAnalyzed: statementFiles.length };
}

function listApplications() {
  const rows = getRows(CONFIG.APPLICATIONS_TAB);
  if (!rows || rows.length <= 1) return { ok: true, applications: [] };

  const decisions = getLatestDecisionMap();
  const analyses = getLatestAnalysisMap();
  const results = getLatestResultMap();
  const applications = rowsToObjects(rows)
    .filter(app => String(app.applicationId || '').trim())
    .map(app => {
      const applicationId = app.applicationId;
      const latestDecision = decisions[applicationId] || {};
      return buildApplicationCardData(app, latestDecision, analyses[applicationId] || {}, results[applicationId] || {});
    }).reverse();

  return { ok: true, applications };
}

function getApplicationDetail(applicationId) {
  const application = getApplication(applicationId);
  if (!application.ok) return application;
  const latestDecision = getLatestDecisionMap()[applicationId] || {};
  const latestAnalysis = getLatestAnalysisMap()[applicationId] || {};
  const latestResult = getLatestResultMap()[applicationId] || {};
  return { ok: true, application: buildApplicationCardData(application.data, latestDecision, latestAnalysis, latestResult) };
}

function buildApplicationCardData(app, latestDecision, latestAnalysis, latestResult) {
  const repairedLinks = ensureApplicationFolderLink(app);
  const documentLinks = repairedLinks || app.documentLinks || '';
  const folderUrl = parseDriveFolderUrl(documentLinks);
  latestAnalysis = latestAnalysis || {};
  latestResult = latestResult || {};
  return {
    applicationId: app.applicationId || '',
    dateSubmitted: app.dateSubmitted || '',
    businessName: app.businessName || '',
    ownerName: app.ownerName || '',
    email: app.email || '',
    phone: app.phone || '',
    industry: app.industry || '',
    timeInBusiness: app.timeInBusiness || '',
    creditScore: app.creditScore || '',
    monthlySalesEstimate: app.monthlySalesEstimate || '',
    status: latestDecision.status || app.status || 'Submitted',
    documentLinks,
    driveFolderUrl: folderUrl,
    assignedLender: latestDecision.finalLender || app.assignedLender || '',
    finalAmount: latestDecision.finalAmount || latestResult.lowOfferOrFinalAmount || '',
    conditions: latestDecision.conditions || latestResult.conditionsOrAuditNote || '',
    notes: latestDecision.notes || latestAnalysis.underwriterNotes || '',
    scenario: latestDecision.scenario || buildScenarioSummary(app),
    aiAnalysisDate: latestAnalysis.analysisDate || '',
    averageMonthlyDeposits: latestAnalysis.averageMonthlyDeposits || '',
    averageMonthlyWithdrawals: latestAnalysis.averageMonthlyWithdrawals || '',
    totalDeposits: latestAnalysis.totalDeposits || '',
    totalWithdrawals: latestAnalysis.totalWithdrawals || '',
    statementMonthsReviewed: latestAnalysis.statementMonthsReviewed || '',
    nsfCount: latestAnalysis.nsfCount || '',
    negativeDays: latestAnalysis.negativeDays || '',
    existingMcaPayments: latestAnalysis.existingMcaPayments || '',
    averageDailyBalance: latestAnalysis.averageDailyBalance || '',
    lowestBalance: latestAnalysis.lowestBalance || '',
    revenueTrend: latestAnalysis.revenueTrend || '',
    cashFlowStrength: latestAnalysis.cashFlowStrength || '',
    aiRiskGrade: latestAnalysis.riskGrade || latestResult.riskGradeOrStatus || '',
    aiUnderwriterNotes: latestAnalysis.underwriterNotes || '',
    suggestedLowOffer: latestResult.lowOfferOrFinalAmount || '',
    suggestedHighOffer: latestResult.highOfferOrConditions || '',
    recommendedAction: latestResult.recommendedActionOrNotes || ''
  };
}

function ensureApplicationFolderLink(app) {
  const existingLinks = String(app.documentLinks || '').trim();
  if (parseDriveFolderUrl(existingLinks)) return existingLinks;
  if (!app.applicationId) return existingLinks;

  const folderResult = createApplicationFolderForPayload({
    applicationId: app.applicationId,
    businessName: app.businessName || 'Unknown Business',
    ownerName: app.ownerName || 'Unknown Applicant'
  });

  const folderLine = 'Application Folder: ' + folderResult.applicationFolderUrl;
  const updatedLinks = existingLinks ? folderLine + '\n' + existingLinks : folderLine;
  setApplicationDocumentLinks(app.applicationId, updatedLinks);
  return updatedLinks;
}

function setApplicationDocumentLinks(applicationId, documentLinks) {
  const sheet = getOrCreateSheet(CONFIG.APPLICATIONS_TAB);
  const rows = sheet.getDataRange().getValues();
  if (!rows.length) return;

  const headers = rows[0];
  const idColumn = headers.indexOf('Application ID');
  const documentLinksColumn = headers.indexOf('Document Links');

  if (idColumn === -1 || documentLinksColumn === -1) return;

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][idColumn]) === String(applicationId)) {
      sheet.getRange(i + 1, documentLinksColumn + 1).setValue(documentLinks);
      return;
    }
  }
}


function getApplicationStatementFilesForOpenAI(applicationId) {
  const files = listNumberedApplicationFiles(applicationId);
  const statementFiles = files.filter(file => String(file.name || '').match(/statement|bank|pdf|csv|account/i));
  const selectedFiles = statementFiles.length ? statementFiles : files;
  if (!selectedFiles.length) throw new Error('No uploaded bank statement files found for this application.');

  return selectedFiles.map(file => {
    const driveFile = DriveApp.getFileById(file.id);
    const blob = driveFile.getBlob();
    return {
      fileId: file.id,
      fileName: driveFile.getName(),
      mimeType: blob.getContentType() || 'application/pdf',
      base64Data: Utilities.base64Encode(blob.getBytes())
    };
  });
}

function getLatestAnalysisMap() {
  const rows = getRows(CONFIG.ANALYSIS_TAB);
  if (!rows || rows.length <= 1) return {};

  const analyses = {};
  rowsToObjects(rows).forEach(analysis => {
    if (!analysis.applicationId) return;
    analyses[analysis.applicationId] = analysis;
  });
  return analyses;
}

function getLatestResultMap() {
  const rows = getRows(CONFIG.RESULTS_TAB);
  if (!rows || rows.length <= 1) return {};

  const results = {};
  rowsToObjects(rows).forEach(result => {
    if (!result.applicationId) return;
    results[result.applicationId] = result;
  });
  return results;
}

function saveFinalDecision(payload) {
  const applicationId = payload.applicationId;
  if (!applicationId) throw new Error('Missing applicationId');

  const application = getApplication(applicationId);
  const app = application.ok ? application.data : {};
  const status = payload.status || 'Manual Review';
  const finalAmount = payload.finalAmount || '';
  const finalLender = payload.finalLender || payload.assignedLender || '';
  const scenario = payload.scenario || '';
  const conditions = payload.conditions || '';
  const notes = payload.notes || '';
  const reviewer = payload.reviewer || 'VFC Admin';

  updateApplicationStatus(applicationId, status, finalLender);

  appendRow(CONFIG.ADMIN_DECISIONS_TAB, [
    'DEC-' + new Date().getTime(),
    applicationId,
    new Date(),
    status,
    finalAmount,
    finalLender,
    scenario,
    conditions,
    notes,
    reviewer
  ]);

  appendRow(CONFIG.RESULTS_TAB, [
    applicationId,
    new Date(),
    status,
    finalAmount,
    conditions,
    finalLender || scenario || notes,
    'Manual decision saved from admin portal'
  ]);

  appendStatusHistory(applicationId, status, notes || conditions || 'Manual decision saved');

  const emailPayload = {
    clientName: app.ownerName || payload.clientName || '',
    clientEmail: app.email || payload.clientEmail || '',
    status,
    finalAmount,
    conditions
  };

  if (emailPayload.clientEmail) {
    if (status === 'Approved' || status === 'Conditionally Approved') sendApprovalEmail(emailPayload);
    else if (status === 'Declined') sendDeclineEmail(emailPayload);
    else if (status === 'More Docs Required') sendMoreDocsEmail(emailPayload);
    else sendStatusEmail(emailPayload);
  }

  return { ok: true, applicationId, status };
}

function getApplication(applicationId) {
  const rows = getRows(CONFIG.APPLICATIONS_TAB);
  const headers = rows[0];
  const row = rows.find((r, index) => index > 0 && String(r[0]) === String(applicationId));
  if (!row) return { ok: false, error: 'Application not found' };

  const data = {};
  headers.forEach((header, index) => data[toCamelCase(header)] = row[index]);
  return { ok: true, data };
}

function updateApplicationStatus(applicationId, status, assignedLender) {
  const sheet = getOrCreateSheet(CONFIG.APPLICATIONS_TAB);
  const rows = sheet.getDataRange().getValues();
  if (!rows.length) return;

  const headers = rows[0];
  const idColumn = headers.indexOf('Application ID');
  const statusColumn = headers.indexOf('Status');
  const lenderColumn = headers.indexOf('Assigned Lender');

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][idColumn]) === String(applicationId)) {
      if (statusColumn !== -1) sheet.getRange(i + 1, statusColumn + 1).setValue(status);
      if (lenderColumn !== -1 && assignedLender) sheet.getRange(i + 1, lenderColumn + 1).setValue(assignedLender);
      return;
    }
  }
}

function appendStatusHistory(applicationId, status, note) {
  appendRow(CONFIG.APPLICATION_STATUS_TAB, [applicationId, new Date(), status, note || '']);
}

function getLatestDecisionMap() {
  const rows = getRows(CONFIG.ADMIN_DECISIONS_TAB);
  if (!rows || rows.length <= 1) return {};

  const decisions = {};
  rowsToObjects(rows).forEach(decision => {
    if (!decision.applicationId) return;
    decisions[decision.applicationId] = decision;
  });
  return decisions;
}

function rowsToObjects(rows) {
  const headers = rows[0] || [];
  return rows.slice(1).filter(row => row.some(cell => String(cell || '').trim() !== '')).map(row => {
    const object = {};
    headers.forEach((header, index) => object[toCamelCase(header)] = row[index]);
    return object;
  });
}

function buildScenarioSummary(app) {
  return [
    'Credit ' + (app.creditScore || 'N/A'),
    'TIB ' + (app.timeInBusiness || 'N/A'),
    'Sales est. ' + formatCurrency(app.monthlySalesEstimate),
    app.industry || 'Industry N/A'
  ].join(' | ');
}

function parseDriveFolderUrl(documentLinks) {
  const match = String(documentLinks || '').match(/Application Folder:\s*(https?:\/\/\S+)/i);
  return match ? match[1] : '';
}

function formatCurrency(value) {
  const number = Number(value || 0);
  if (!number) return '$0';
  return '$' + number.toLocaleString();
}

function outputResponse(data, e) {
  const callback = e && e.parameter && e.parameter.callback;
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + JSON.stringify(data) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return jsonResponse(data);
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
