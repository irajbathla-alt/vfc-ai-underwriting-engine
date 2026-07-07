function getNextDocumentNumber(folder) {
  const files = folder.getFiles();
  let maxNumber = 0;
  while (files.hasNext()) {
    const name = files.next().getName();
    const match = String(name).match(/^(\d{2,4})\s*-/);
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
  }
  return maxNumber + 1;
}

function makeNumberedFileName(number, originalName) {
  return String(number).padStart(2, '0') + ' - ' + sanitizeFileName(originalName || 'document');
}

function saveNumberedApplicationFile(payload) {
  if (!payload || !payload.applicationId) throw new Error('Missing applicationId');
  if (!payload.fileName) throw new Error('Missing fileName');
  if (!payload.base64Data) throw new Error('Missing base64Data');

  const folder = getOrCreateApplicationFolder(payload);
  const number = getNextDocumentNumber(folder);
  const fileName = makeNumberedFileName(number, payload.fileName);
  const blob = Utilities.newBlob(
    Utilities.base64Decode(payload.base64Data),
    payload.mimeType || 'application/octet-stream',
    fileName
  );
  const file = folder.createFile(blob);

  return {
    ok: true,
    applicationId: payload.applicationId,
    fileNumber: number,
    fileName: file.getName(),
    fileUrl: file.getUrl(),
    fileId: file.getId(),
    applicationFolderUrl: folder.getUrl(),
    applicationFolderId: folder.getId(),
    applicationFolderName: folder.getName()
  };
}

function listNumberedApplicationFiles(applicationId) {
  const application = getApplication(applicationId);
  if (!application.ok) return [];

  const app = application.data;
  const folder = getOrCreateApplicationFolder({
    applicationId: applicationId,
    businessName: app.businessName || 'Unknown Business',
    ownerName: app.ownerName || 'Unknown Applicant'
  });

  const files = folder.getFiles();
  const result = [];
  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    const match = String(name).match(/^(\d{2,4})\s*-/);
    result.push({
      number: match ? Number(match[1]) : 9999,
      name: name,
      url: file.getUrl(),
      id: file.getId()
    });
  }

  return result.sort(function(a, b) {
    return a.number - b.number || String(a.name).localeCompare(String(b.name));
  });
}

function getOrCreateCaseStudyFolder() {
  const parent = getUploadFolder();
  const folderName = 'VFC AI Case Studies';
  const existing = parent.getFoldersByName(folderName);
  if (existing.hasNext()) return existing.next();
  return parent.createFolder(folderName);
}

function saveNumberedCaseStudyFile(payload) {
  if (!payload || !payload.fileName) throw new Error('Missing fileName');
  if (!payload.base64Data) throw new Error('Missing base64Data');

  const folder = getOrCreateCaseStudyFolder();
  const number = getNextDocumentNumber(folder);
  const lender = sanitizeFileName(payload.lenderName || 'Unknown Lender');
  const decision = sanitizeFileName(payload.decision || 'Unknown Decision');
  const fileName = makeNumberedFileName(number, lender + ' - ' + decision + ' - ' + payload.fileName);
  const blob = Utilities.newBlob(
    Utilities.base64Decode(payload.base64Data),
    payload.mimeType || 'application/octet-stream',
    fileName
  );
  const file = folder.createFile(blob);

  return {
    ok: true,
    caseNumber: number,
    fileName: file.getName(),
    fileUrl: file.getUrl(),
    fileId: file.getId(),
    caseStudyFolderUrl: folder.getUrl()
  };
}
