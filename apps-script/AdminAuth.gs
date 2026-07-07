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


function runAnalysisAdmin(payload) {
  validateAdminToken(payload && payload.adminToken);
  if (!payload || !String(payload.applicationId || '').trim()) {
    return { ok: false, error: 'Missing application ID. Refresh applications and choose a valid submitted application.' };
  }
  return runApplicationAnalysis(payload.applicationId);
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
  const result = uploadCaseStudiesForAi({
    adminToken: payload && payload.adminToken,
    lenderName: payload && payload.lenderName,
    decision: payload && payload.decision,
    approvedAmount: payload && payload.approvedAmount,
    requestedAmount: payload && payload.requestedAmount,
    industry: payload && payload.industry,
    timeInBusiness: payload && payload.timeInBusiness,
    creditScore: payload && payload.creditScore,
    averageMonthlyDeposits: payload && payload.averageMonthlyDeposits,
    nsfCount: payload && payload.nsfCount,
    negativeDays: payload && payload.negativeDays,
    existingMcaPayments: payload && payload.existingMcaPayments,
    revenueTrend: payload && payload.revenueTrend,
    reasonApproved: payload && payload.reasonApproved,
    reasonDeclined: payload && payload.reasonDeclined,
    conditions: payload && payload.conditions,
    statementMonthsReviewed: payload && payload.statementMonthsReviewed,
    files: payload ? [{
      fileName: payload.fileName,
      mimeType: payload.mimeType,
      base64Data: payload.base64Data
    }] : []
  });

  if (!result.ok) return result;
  return result.results[0] || { ok: false, error: 'No file processed.' };
}

function uploadCaseStudiesForAi(payload) {
  validateAdminToken(payload && payload.adminToken);
  const files = payload && Array.isArray(payload.files) ? payload.files : [];
  if (!files.length) throw new Error('Choose at least one historical bank statement or case file.');

  const results = files.map(function(filePayload) {
    return uploadAndTrainCaseStudyFile(payload, filePayload);
  });

  return {
    ok: results.some(function(result) { return result.ok; }),
    processed: results.filter(function(result) { return result.ok; }).length,
    failed: results.filter(function(result) { return !result.ok; }).length,
    results: results
  };
}

function uploadAndTrainCaseStudyFile(metadata, filePayload) {
  const uploadPayload = copyCaseStudyPayload(metadata, filePayload);
  const uploadResult = saveNumberedCaseStudyFile(uploadPayload);
  const trainingFileId = 'TRN-' + new Date().getTime() + '-' + Math.floor(Math.random() * 10000);

  try {
    const aiResult = analyzeTrainingFileUploadWithOpenAI({
      fileName: filePayload.fileName,
      mimeType: filePayload.mimeType || 'application/pdf',
      base64Data: filePayload.base64Data,
      metadata: metadata
    });
    const normalizedCase = normalizeTrainingCase(mergeTrainingMetadata(aiResult, metadata), filePayload.fileName);

    appendHistoricalCaseFromTrainingFile(normalizedCase);
    appendTrainingFileLog([
      trainingFileId,
      new Date(),
      uploadResult.fileId,
      uploadResult.fileName,
      uploadResult.fileUrl,
      'Processed',
      normalizedCase.case_id,
      normalizedCase.lender_name,
      normalizedCase.decision,
      '',
      'OpenAI parsed uploaded historical file. ' + (normalizedCase.notes || '')
    ]);

    return {
      ok: true,
      caseId: normalizedCase.case_id,
      caseNumber: uploadResult.caseNumber,
      fileName: uploadResult.fileName,
      fileUrl: uploadResult.fileUrl,
      caseStudyFolderUrl: uploadResult.caseStudyFolderUrl,
      lenderName: normalizedCase.lender_name,
      decision: normalizedCase.decision,
      message: 'OpenAI read this file and added it to Historical Cases.'
    };
  } catch (error) {
    appendTrainingFileLog([
      trainingFileId,
      new Date(),
      uploadResult.fileId,
      uploadResult.fileName,
      uploadResult.fileUrl,
      'Error',
      '',
      metadata.lenderName || '',
      metadata.decision || '',
      error.message,
      'Upload saved, but OpenAI could not parse the file.'
    ]);

    return {
      ok: false,
      caseNumber: uploadResult.caseNumber,
      fileName: uploadResult.fileName,
      fileUrl: uploadResult.fileUrl,
      caseStudyFolderUrl: uploadResult.caseStudyFolderUrl,
      error: error.message
    };
  }
}

function copyCaseStudyPayload(metadata, filePayload) {
  return {
    lenderName: metadata.lenderName || '',
    decision: metadata.decision || '',
    fileName: filePayload.fileName,
    mimeType: filePayload.mimeType || 'application/pdf',
    base64Data: filePayload.base64Data
  };
}

function mergeTrainingMetadata(aiResult, metadata) {
  aiResult = aiResult || {};
  metadata = metadata || {};
  return Object.assign({}, aiResult, {
    lender_name: aiResult.lender_name || metadata.lenderName || '',
    decision: aiResult.decision || metadata.decision || '',
    approved_amount: aiResult.approved_amount || metadata.approvedAmount || 0,
    requested_amount: aiResult.requested_amount || metadata.requestedAmount || 0,
    industry: aiResult.industry || metadata.industry || '',
    time_in_business: aiResult.time_in_business || metadata.timeInBusiness || '',
    credit_score: aiResult.credit_score || metadata.creditScore || 0,
    average_monthly_deposits: aiResult.average_monthly_deposits || metadata.averageMonthlyDeposits || 0,
    nsf_count: aiResult.nsf_count || metadata.nsfCount || 0,
    negative_days: aiResult.negative_days || metadata.negativeDays || 0,
    existing_mca_payments: aiResult.existing_mca_payments || metadata.existingMcaPayments || 0,
    revenue_trend: aiResult.revenue_trend || metadata.revenueTrend || 'unknown',
    reason_approved: aiResult.reason_approved || metadata.reasonApproved || '',
    reason_declined: aiResult.reason_declined || metadata.reasonDeclined || '',
    conditions: aiResult.conditions || metadata.conditions || '',
    statement_months_reviewed: aiResult.statement_months_reviewed || metadata.statementMonthsReviewed || 0
  });
}
