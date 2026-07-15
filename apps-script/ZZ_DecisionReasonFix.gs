function saveLenderDecision(payload) {
  payload = payload || {};
  const companyName = payload.companyName || '';
  const period = payload.period || '';
  const lenderName = payload.lenderName || '';
  const decision = payload.decision || '';
  const approvedAmount = payload.approvedAmount || '';
  const declineReason = shouldKeepDeclineReason_(decision) ? (payload.declineReason || '') : '';
  const batch = getLatestBatchSummary_(companyName, period) || {};

  appendRow_('Observed Lender Behaviour', [
    Utilities.getUuid(),
    lenderName,
    companyName,
    period,
    decision,
    approvedAmount,
    declineReason,
    payload.notes || 'Saved from VFC intake page.',
    new Date()
  ]);

  appendRow_('Training Records', [
    Utilities.getUuid(),
    companyName,
    period,
    lenderName,
    decision,
    approvedAmount,
    declineReason,
    batch.combinedSummary || batch.combined_summary || '',
    batch.keyFindings || batch.key_findings || '',
    batch.risks || '',
    batch.missingInfo || batch.missing_info || '',
    new Date()
  ]);

  return { ok: true, message: declineReason ? 'Decision saved with decline reason.' : 'Decision saved. Decline reason cleared for approved/non-declined decision.' };
}

function shouldKeepDeclineReason_(decision) {
  const text = String(decision || '').toLowerCase();
  return text.indexOf('declin') !== -1 || text.indexOf('reject') !== -1 || text.indexOf('unable') !== -1;
}

function cleanupApprovedRowsWithDeclineReasons() {
  clearDeclineReasonForApprovedRows_('Observed Lender Behaviour', 'Decision', 'Decline Reason');
  clearDeclineReasonForApprovedRows_('Training Records', 'Decision', 'Decline Reason');
  return { ok: true, message: 'Approved/non-declined rows cleaned.' };
}

function clearDeclineReasonForApprovedRows_(sheetName, decisionHeader, declineReasonHeader) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;

  const headers = values[0].map(function(h) { return String(h || '').trim().toLowerCase(); });
  const decisionCol = headers.indexOf(String(decisionHeader).toLowerCase());
  const reasonCol = headers.indexOf(String(declineReasonHeader).toLowerCase());
  if (decisionCol === -1 || reasonCol === -1) return;

  for (let r = 1; r < values.length; r++) {
    const decision = values[r][decisionCol];
    if (!shouldKeepDeclineReason_(decision) && values[r][reasonCol]) {
      sheet.getRange(r + 1, reasonCol + 1).setValue('');
    }
  }
}
