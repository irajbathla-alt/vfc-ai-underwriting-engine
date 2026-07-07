function adminLogin(payload) {
  const password = String(payload.password || '');
  const expectedPassword = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');

  if (!expectedPassword) {
    return { ok: false, error: 'ADMIN_PASSWORD is not set in Apps Script Properties.' };
  }

  if (password !== expectedPassword) {
    return { ok: false, error: 'Invalid admin password.' };
  }

  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('ADMIN_TOKEN_' + token, 'valid', 21600);
  return { ok: true, token: token };
}

function validateAdminToken(token) {
  const value = CacheService.getScriptCache().get('ADMIN_TOKEN_' + String(token || ''));
  if (value !== 'valid') {
    throw new Error('Admin login required.');
  }
  return true;
}

function listApplicationsAdmin(payload) {
  validateAdminToken(payload && payload.adminToken);
  const result = listApplications();
  if (!result.ok) return result;

  result.applications = (result.applications || []).map(function(app) {
    app.documents = listNumberedApplicationFiles(app.applicationId).map(function(file, index) {
      return {
        number: index + 1,
        name: file.name,
        url: file.url,
        id: file.id
      };
    });
    app.suggestedAmount = app.finalAmount || calculateAdminSuggestedAmount(app);
    return app;
  });

  return result;
}

function calculateAdminSuggestedAmount(app) {
  const monthlySales = Number(app.monthlySalesEstimate || 0);
  const creditScore = Number(app.creditScore || 0);
  let multiplier = 0.45;
  if (creditScore >= 700) multiplier = 0.85;
  else if (creditScore >= 650) multiplier = 0.70;
  else if (creditScore >= 600) multiplier = 0.50;
  else multiplier = 0.25;
  return Math.round((monthlySales * multiplier) / 1000) * 1000;
}

function saveFinalDecisionAdmin(payload) {
  validateAdminToken(payload && payload.adminToken);
  return saveFinalDecision(payload);
}

function uploadAdminDocument(payload) {
  validateAdminToken(payload && payload.adminToken);

  const application = getApplication(payload.applicationId);
  if (!application.ok) return application;

  const app = application.data;
  const uploadPayload = {
    applicationId: payload.applicationId,
    businessName: app.businessName || payload.businessName || '',
    ownerName: app.ownerName || payload.ownerName || '',
    fileName: payload.fileName,
    mimeType: payload.mimeType,
    base64Data: payload.base64Data
  };

  const uploadResult = saveNumberedApplicationFile(uploadPayload);
  updateApplicationDocumentLinks(payload.applicationId, uploadResult.fileUrl, uploadResult.applicationFolderUrl);
  appendStatusHistory(payload.applicationId, 'Admin Document Uploaded', uploadResult.fileName || payload.fileName || 'Admin uploaded document');

  return {
    ok: true,
    fileNumber: uploadResult.fileNumber,
    fileName: uploadResult.fileName,
    fileUrl: uploadResult.fileUrl,
    applicationFolderUrl: uploadResult.applicationFolderUrl
  };
}

function uploadCaseStudyForAi(payload) {
  validateAdminToken(payload && payload.adminToken);

  const uploadResult = saveNumberedCaseStudyFile(payload);
  const caseId = 'CASE-' + new Date().getTime();

  appendRow(CONFIG.HISTORICAL_CASES_TAB, [
    caseId,
    payload.lenderName || '',
    payload.decision || '',
    payload.funded || '',
    payload.approvedAmount || '',
    payload.requestedAmount || '',
    payload.industry || '',
    payload.timeInBusiness || '',
    payload.creditScore || '',
    payload.averageMonthlyDeposits || '',
    payload.nsfCount || '',
    payload.negativeDays || '',
    payload.existingMcaPayments || '',
    payload.revenueTrend || '',
    payload.reasonApproved || '',
    payload.reasonDeclined || '',
    payload.conditions || '',
    payload.statementMonthsReviewed || '',
    new Date(),
    'Case file #' + uploadResult.caseNumber + ': ' + uploadResult.fileUrl
  ]);

  return {
    ok: true,
    caseId: caseId,
    caseNumber: uploadResult.caseNumber,
    fileName: uploadResult.fileName,
    fileUrl: uploadResult.fileUrl,
    caseStudyFolderUrl: uploadResult.caseStudyFolderUrl,
    message: 'Case study saved. This is now part of the VFC AI case-study dataset.'
  };
}
