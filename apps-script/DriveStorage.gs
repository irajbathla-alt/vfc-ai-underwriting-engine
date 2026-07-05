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
  if (!payload || !payload.applicationId) {
    throw new Error('Missing applicationId');
  }
  if (!payload.fileName) {
    throw new Error('Missing fileName');
  }
  if (!payload.base64Data) {
    throw new Error('Missing base64Data');
  }

  const folder = getOrCreateApplicationFolder(payload);
  const bytes = Utilities.base64Decode(payload.base64Data);
  const mimeType = payload.mimeType || 'application/octet-stream';
  const safeFileName = sanitizeFileName(payload.fileName);
  const blob = Utilities.newBlob(bytes, mimeType, safeFileName);
  const file = folder.createFile(blob);

  // Keep uploaded files private. Do not set public sharing permissions here.
  return {
    ok: true,
    applicationId: payload.applicationId,
    applicationFolderId: folder.getId(),
    applicationFolderName: folder.getName(),
    applicationFolderUrl: folder.getUrl(),
    fileId: file.getId(),
    fileName: file.getName(),
    fileUrl: file.getUrl()
  };
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
  return String(value).replace(/[\\/:*?"<>|#%{}~&]/g, '_').replace(/\s+/g, ' ').trim();
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
