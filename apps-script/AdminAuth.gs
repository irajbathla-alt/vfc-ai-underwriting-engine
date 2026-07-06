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
  return listApplications();
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

  const uploadResult = saveBase64FileToDrive(uploadPayload);
  updateApplicationDocumentLinks(payload.applicationId, uploadResult.fileUrl, uploadResult.applicationFolderUrl);
  appendStatusHistory(payload.applicationId, 'Admin Document Uploaded', payload.fileName || 'Admin uploaded document');

  return {
    ok: true,
    fileUrl: uploadResult.fileUrl,
    applicationFolderUrl: uploadResult.applicationFolderUrl
  };
}
