function clientLogin(payload) {
  const email = String(payload.email || '').trim().toLowerCase();
  const applicationId = String(payload.applicationId || '').trim();

  if (!email || !applicationId) {
    return { ok: false, error: 'Email and Application ID are required.' };
  }

  const application = getApplication(applicationId);
  if (!application.ok) return { ok: false, error: 'Application not found.' };

  const applicationEmail = String(application.data.email || '').trim().toLowerCase();
  if (applicationEmail !== email) {
    return { ok: false, error: 'Login details do not match our records.' };
  }

  updateClientUserFromApplication(application.data);
  return getClientPortalData(applicationId, email);
}

function getClientPortalData(applicationId, email) {
  const application = getApplication(applicationId);
  if (!application.ok) return application;

  const appEmail = String(application.data.email || '').trim().toLowerCase();
  if (email && appEmail !== String(email).trim().toLowerCase()) {
    return { ok: false, error: 'Unauthorized application access.' };
  }

  const latestDecision = getLatestDecisionMap()[applicationId] || {};
  const statusHistory = getApplicationStatusHistory(applicationId);
  const app = buildApplicationCardData(application.data, latestDecision);

  return {
    ok: true,
    application: {
      applicationId: app.applicationId,
      businessName: app.businessName,
      ownerName: app.ownerName,
      email: app.email,
      phone: app.phone,
      industry: app.industry,
      timeInBusiness: app.timeInBusiness,
      creditScore: app.creditScore,
      monthlySalesEstimate: app.monthlySalesEstimate,
      status: app.status,
      finalAmount: app.finalAmount,
      assignedLender: app.assignedLender,
      conditions: app.conditions,
      scenario: app.scenario,
      driveFolderUrl: app.driveFolderUrl,
      statusHistory
    }
  };
}

function uploadClientDocument(payload) {
  const login = clientLogin({
    email: payload.email,
    applicationId: payload.applicationId
  });
  if (!login.ok) return login;

  const uploadResult = saveBase64FileToDrive(payload);
  updateApplicationDocumentLinks(payload.applicationId, uploadResult.fileUrl, uploadResult.applicationFolderUrl);
  appendStatusHistory(payload.applicationId, 'Client Document Uploaded', payload.fileName || 'Client uploaded document');

  return {
    ok: true,
    fileUrl: uploadResult.fileUrl,
    applicationFolderUrl: uploadResult.applicationFolderUrl
  };
}

function updateClientUserFromApplication(app) {
  const clientId = 'CLIENT-' + String(app.applicationId || '').replace(/^APP-/, '');
  const sheet = getOrCreateSheet(CONFIG.CLIENT_USERS_TAB);
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0] || [];
  const emailColumn = headers.indexOf('Email');
  const appIdColumn = headers.indexOf('Latest Application ID');

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][emailColumn]).toLowerCase() === String(app.email || '').toLowerCase()) {
      if (appIdColumn !== -1) sheet.getRange(i + 1, appIdColumn + 1).setValue(app.applicationId || '');
      return;
    }
  }

  appendRow(CONFIG.CLIENT_USERS_TAB, [
    clientId,
    new Date(),
    app.ownerName || '',
    app.businessName || '',
    app.email || '',
    app.phone || '',
    app.applicationId || '',
    'Active'
  ]);
}

function getApplicationStatusHistory(applicationId) {
  const rows = getRows(CONFIG.APPLICATION_STATUS_TAB);
  if (!rows || rows.length <= 1) return [];

  return rowsToObjects(rows)
    .filter(row => String(row.applicationId) === String(applicationId))
    .map(row => ({
      date: row.statusDate || '',
      status: row.status || '',
      note: row.note || ''
    }))
    .reverse();
}
