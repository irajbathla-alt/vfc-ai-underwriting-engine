function notifyAdminNewApplication(applicationId, payload) {
  return {
    ok: true,
    skipped: true,
    reason: 'Outbound email disabled for VFC V1.'
  };
}

function sendStatusEmail(payload) {
  return {
    ok: true,
    skipped: true,
    reason: 'Outbound email disabled for VFC V1.'
  };
}

function sendApprovalEmail(payload) {
  return sendStatusEmail(payload);
}

function sendDeclineEmail(payload) {
  return sendStatusEmail(payload);
}

function sendMoreDocsEmail(payload) {
  return sendStatusEmail(payload);
}
