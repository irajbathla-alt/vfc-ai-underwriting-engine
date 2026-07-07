function createFineTuneJobFromHistoricalCasesAdmin(payload) {
  validateAdminToken(payload && payload.adminToken);

  const exportResult = exportFineTuneJsonlFromHistoricalCases(payload || {});
  if (!exportResult.ok) return exportResult;

  const fileIdMatch = String(exportResult.fileUrl || '').match(/[-\w]{25,}/);
  if (!fileIdMatch) return { ok: false, error: 'Could not read exported Drive file ID.' };

  const uploadResult = uploadDriveJsonlToOpenAI(fileIdMatch[0]);
  if (!uploadResult.ok) return uploadResult;

  const jobResult = createOpenAIFineTuneJob(uploadResult.openaiFileId, payload && payload.model);
  return {
    ok: jobResult.ok,
    jsonlDriveFileUrl: exportResult.fileUrl,
    openaiFileId: uploadResult.openaiFileId,
    fineTuneJobId: jobResult.fineTuneJobId,
    status: jobResult.status,
    raw: jobResult.raw
  };
}

function uploadDriveJsonlToOpenAI(driveFileId) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) return { ok: false, error: 'Missing OPENAI_API_KEY.' };

  const driveFile = DriveApp.getFileById(driveFileId);
  const blob = driveFile.getBlob().setName(driveFile.getName());
  const response = UrlFetchApp.fetch('https://api.openai.com/v1/files', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: {
      purpose: 'fine-tune',
      file: blob
    },
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const bodyText = response.getContentText();
  let body;
  try { body = JSON.parse(bodyText); } catch (error) { return { ok: false, error: bodyText }; }
  if (status < 200 || status >= 300) return { ok: false, error: bodyText };

  return { ok: true, openaiFileId: body.id, raw: body };
}

function createOpenAIFineTuneJob(openaiFileId, model) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) return { ok: false, error: 'Missing OPENAI_API_KEY.' };

  const baseModel = model || PropertiesService.getScriptProperties().getProperty('OPENAI_FINE_TUNE_BASE_MODEL');
  if (!baseModel) {
    return { ok: false, error: 'Missing OPENAI_FINE_TUNE_BASE_MODEL. Set it only after confirming fine-tuning access for that model.' };
  }

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/fine_tuning/jobs', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify({
      training_file: openaiFileId,
      model: baseModel
    }),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const bodyText = response.getContentText();
  let body;
  try { body = JSON.parse(bodyText); } catch (error) { return { ok: false, error: bodyText }; }
  if (status < 200 || status >= 300) return { ok: false, error: bodyText, raw: body };

  return { ok: true, fineTuneJobId: body.id, status: body.status, raw: body };
}

function getFineTuneJobStatusAdmin(payload) {
  validateAdminToken(payload && payload.adminToken);
  const jobId = payload && payload.jobId;
  if (!jobId) return { ok: false, error: 'Missing fine-tune job ID.' };
  return getOpenAIFineTuneJobStatus(jobId);
}

function getOpenAIFineTuneJobStatus(jobId) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) return { ok: false, error: 'Missing OPENAI_API_KEY.' };

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/fine_tuning/jobs/' + encodeURIComponent(jobId), {
    method: 'get',
    headers: { Authorization: 'Bearer ' + apiKey },
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const bodyText = response.getContentText();
  let body;
  try { body = JSON.parse(bodyText); } catch (error) { return { ok: false, error: bodyText }; }
  if (status < 200 || status >= 300) return { ok: false, error: bodyText, raw: body };

  return {
    ok: true,
    fineTuneJobId: body.id,
    status: body.status,
    fineTunedModel: body.fine_tuned_model || '',
    raw: body
  };
}
