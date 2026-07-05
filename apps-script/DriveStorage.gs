function getUploadFolder() {
  if (!CONFIG.DRIVE_UPLOAD_FOLDER_ID) {
    throw new Error('Missing DRIVE_UPLOAD_FOLDER_ID in CONFIG');
  }
  return DriveApp.getFolderById(CONFIG.DRIVE_UPLOAD_FOLDER_ID);
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

  const folder = getUploadFolder();
  const bytes = Utilities.base64Decode(payload.base64Data);
  const mimeType = payload.mimeType || 'application/octet-stream';
  const safeFileName = sanitizeFileName(payload.applicationId + '-' + payload.fileName);
  const blob = Utilities.newBlob(bytes, mimeType, safeFileName);
  const file = folder.createFile(blob);

  // Keep uploaded files private. Do not set public sharing permissions here.
  return {
    ok: true,
    applicationId: payload.applicationId,
    fileId: file.getId(),
    fileName: file.getName(),
    fileUrl: file.getUrl()
  };
}

function updateApplicationDocumentLinks(applicationId, fileUrl) {
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
      const updated = existing ? existing + '\n' + fileUrl : fileUrl;
      sheet.getRange(i + 1, documentLinksColumn + 1).setValue(updated);
      return { ok: true };
    }
  }

  throw new Error('Application not found: ' + applicationId);
}

function sanitizeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
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
