const CONFIG = {
  SHEET_ID: 'PASTE_GOOGLE_SHEET_ID_HERE',
  APPLICATIONS_TAB: 'Applications',
  ANALYSIS_TAB: 'Statement Analysis',
  RESULTS_TAB: 'Underwriting Results',
  ADMIN_EMAIL: 'admin@vancouverfinancecompany.com',
  DRIVE_UPLOAD_FOLDER_ID: '1OuMVNc5RnLzCPWb5h0dWdsCsHbQNICA1',
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
    if (action === 'runAnalysis') return jsonResponse(runApplicationAnalysis(payload.applicationId));
    if (action === 'finalDecision') return jsonResponse(saveFinalDecision(payload));

    return jsonResponse({ ok: false, error: 'Unknown action' });
  } catch (error) {
    return jsonResponse({ ok: false, error: error.message });
  }
}

function doGet(e) {
  const applicationId = e.parameter.applicationId;
  if (!applicationId) return jsonResponse({ ok: false, error: 'Missing applicationId' });
  return jsonResponse(getApplication(applicationId));
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
  notifyAdminNewApplication(applicationId, payload);
  return { ok: true, applicationId, folder: folderResult };
}

function uploadDocumentForApplication(payload) {
  const uploadResult = saveBase64FileToDrive(payload);
  updateApplicationDocumentLinks(payload.applicationId, uploadResult.fileUrl, uploadResult.applicationFolderUrl);
  return uploadResult;
}

function runApplicationAnalysis(applicationId) {
  const application = getApplication(applicationId);
  if (!application.ok) return application;

  const aiResult = analyzeStatementTextWithOpenAI({
    statementText: 'Paste extracted statement text here in first MVP.',
    creditScore: application.data.creditScore,
    timeInBusiness: application.data.timeInBusiness,
    industry: application.data.industry
  });

  appendRow(CONFIG.ANALYSIS_TAB, [
    applicationId,
    new Date(),
    aiResult.average_monthly_deposits,
    aiResult.nsf_count,
    aiResult.negative_days,
    aiResult.existing_mca_payments,
    aiResult.revenue_trend,
    aiResult.risk_grade,
    aiResult.underwriter_notes
  ]);

  const offer = calculateOfferRange(aiResult, application.data);
  appendRow(CONFIG.RESULTS_TAB, [
    applicationId,
    new Date(),
    offer.riskGrade,
    offer.lowOffer,
    offer.highOffer,
    offer.recommendedAction,
    offer.conditions.join(', ')
  ]);

  return { ok: true, applicationId, aiResult, offer };
}

function saveFinalDecision(payload) {
  appendRow(CONFIG.RESULTS_TAB, [
    payload.applicationId,
    new Date(),
    payload.status,
    payload.finalAmount || '',
    payload.conditions || '',
    payload.notes || '',
    'Manual decision saved'
  ]);

  if (payload.status === 'Approved') sendApprovalEmail(payload);
  else if (payload.status === 'Declined') sendDeclineEmail(payload);
  else if (payload.status === 'More Docs Required') sendMoreDocsEmail(payload);

  return { ok: true };
}

function getApplication(applicationId) {
  const rows = getRows(CONFIG.APPLICATIONS_TAB);
  const headers = rows[0];
  const row = rows.find((r, index) => index > 0 && r[0] === applicationId);
  if (!row) return { ok: false, error: 'Application not found' };

  const data = {};
  headers.forEach((header, index) => data[toCamelCase(header)] = row[index]);
  return { ok: true, data };
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
