function getUploadFolder() {
  if (!CONFIG.DRIVE_UPLOAD_FOLDER_ID) {
    throw new Error('Missing DRIVE_UPLOAD_FOLDER_ID in CONFIG');
  }
  return DriveApp.getFolderById(CONFIG.DRIVE_UPLOAD_FOLDER_ID);
}

function getOrCreateApplicationFolder(payload) {
  payload = hydrateApplicationFolderPayload(payload || {});

  const parentFolder = getUploadFolder();
  const applicationId = payload.applicationId || 'APP-UNKNOWN';
  const businessName = payload.businessName || 'Unknown Business';
  const ownerName = payload.ownerName || 'Unknown Applicant';
  const folderName = sanitizeFolderName(ownerName + ' - ' + businessName + ' - ' + applicationId);

  const existingFolders = parentFolder.getFoldersByName(folderName);
  if (existingFolders.hasNext()) return existingFolders.next();

  return parentFolder.createFolder(folderName);
}

function createApplicationFolderForPayload(payload) {
  const folder = getOrCreateApplicationFolder(payload);
  return {
    ok: true,
    applicationId: payload.applicationId,
    applicationFolderId: folder.getId(),
    applicationFolderName: folder.getName(),
    applicationFolderUrl: folder.getUrl()
  };
}

function hydrateApplicationFolderPayload(payload) {
  if (payload.businessName && payload.ownerName) return payload;
  if (!payload.applicationId) return payload;

  try {
    const application = getApplication(payload.applicationId);
    if (application && application.ok && application.data) {
      payload.businessName = payload.businessName || application.data.businessName;
      payload.ownerName = payload.ownerName || application.data.ownerName;
    }
  } catch (error) {
    // Keep fallback values if sheet lookup is not available yet.
  }

  return payload;
}

function saveBase64FileToDrive(payload) {
  return saveNumberedApplicationFile(payload);
}

function updateApplicationDocumentLinks(applicationId, fileUrl, folderUrl) {
  const sheet = getOrCreateSheet(CONFIG.APPLICATIONS_TAB);
  const rows = sheet.getDataRange().getValues();
  if (!rows.length) throw new Error('Applications sheet is empty');

  const headers = rows[0];
  const applicationIdColumn = headers.indexOf('Application ID');
  const documentLinksColumn = headers.indexOf('Document Links');

  if (applicationIdColumn === -1 || documentLinksColumn === -1) {
    throw new Error('Required Applications headers are missing');
  }

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][applicationIdColumn]) === String(applicationId)) {
      const existing = String(rows[i][documentLinksColumn] || '').trim();
      const lines = existing ? existing.split('\n').map(line => line.trim()).filter(Boolean) : [];

      if (folderUrl) {
        const folderLine = 'Application Folder: ' + folderUrl;
        if (!lines.includes(folderLine)) lines.unshift(folderLine);
      }

      if (fileUrl) {
        const fileLine = 'Document: ' + fileUrl;
        if (!lines.includes(fileLine)) lines.push(fileLine);
      }

      sheet.getRange(i + 1, documentLinksColumn + 1).setValue(lines.join('\n'));
      return { ok: true };
    }
  }

  throw new Error('Application not found: ' + applicationId);
}

function sanitizeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._ -]/g, '_').trim();
}

function sanitizeFolderName(value) {
  return String(value).replace(/[\/:*?"<>|#%{}~&]/g, '_').replace(/\s+/g, ' ').trim();
}

function testDriveFolderConnection() {
  const folder = getUploadFolder();
  const result = {
    ok: true,
    folderId: folder.getId(),
    folderName: folder.getName()
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function testCreateApplicationFolder() {
  const result = createApplicationFolderForPayload({
    applicationId: 'APP-TEST-123',
    businessName: 'ABC Pizza Ltd',
    ownerName: 'John Smith'
  });
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function repairApplicationsFromDriveFolders() {
  const parent = getUploadFolder();
  const folders = parent.getFolders();
  const existingIds = getExistingApplicationIds();
  const repaired = [];
  const skipped = [];

  while (folders.hasNext()) {
    const folder = folders.next();
    const folderName = folder.getName();
    const applicationId = extractApplicationIdFromFolderName(folderName);
    if (!applicationId) {
      skipped.push({ folderName: folderName, reason: 'No APP ID in folder name' });
      continue;
    }

    if (existingIds[applicationId]) {
      ensureExistingApplicationHasFolderLink(applicationId, folder.getUrl());
      skipped.push({ applicationId: applicationId, folderName: folderName, reason: 'Application already exists' });
      continue;
    }

    const parsed = parseApplicationFolderName(folderName, applicationId);
    appendRow(CONFIG.APPLICATIONS_TAB, [
      applicationId,
      new Date(),
      parsed.businessName,
      parsed.ownerName,
      '',
      '',
      '',
      '',
      '',
      '',
      'Submitted',
      'Application Folder: ' + folder.getUrl(),
      ''
    ]);
    appendStatusHistory(applicationId, 'Submitted', 'Application row repaired from existing Drive folder');
    existingIds[applicationId] = true;
    repaired.push({ applicationId: applicationId, folderName: folderName, folderUrl: folder.getUrl() });
  }

  return {
    ok: true,
    repairedCount: repaired.length,
    skippedCount: skipped.length,
    repaired: repaired,
    skipped: skipped
  };
}

function getExistingApplicationIds() {
  const rows = getRows(CONFIG.APPLICATIONS_TAB);
  const existing = {};
  if (!rows || rows.length <= 1) return existing;

  rowsToObjects(rows).forEach(function(app) {
    if (app.applicationId) existing[String(app.applicationId)] = true;
  });
  return existing;
}

function ensureExistingApplicationHasFolderLink(applicationId, folderUrl) {
  const application = getApplication(applicationId);
  if (!application.ok) return;
  const existingLinks = String(application.data.documentLinks || '');
  if (parseDriveFolderUrl(existingLinks)) return;
  setApplicationDocumentLinks(applicationId, existingLinks ? 'Application Folder: ' + folderUrl + '\n' + existingLinks : 'Application Folder: ' + folderUrl);
}

function extractApplicationIdFromFolderName(folderName) {
  const match = String(folderName || '').match(/APP-[A-Z0-9-]+/i);
  return match ? match[0].toUpperCase() : '';
}

function parseApplicationFolderName(folderName, applicationId) {
  const withoutId = String(folderName || '').replace(applicationId, '').replace(/\s+-\s+$/, '').trim();
  const parts = withoutId.split(' - ').map(function(part) { return part.trim(); }).filter(Boolean);
  return {
    ownerName: parts[0] || 'Unknown Applicant',
    businessName: parts[1] || 'Unknown Business'
  };
}
