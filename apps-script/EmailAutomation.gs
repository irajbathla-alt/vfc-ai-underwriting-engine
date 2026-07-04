function notifyAdminNewApplication(applicationId, payload) {
  const subject = 'New VFC Application - ' + applicationId;
  const body = 'A new application was submitted.\n\nApplication ID: ' + applicationId + '\nBusiness: ' + (payload.businessName || '') + '\n\nReview it in the VFC dashboard.';
  MailApp.sendEmail(CONFIG.ADMIN_EMAIL, subject, body);
}

function sendStatusEmail(payload) {
  const subject = 'Your Application Update';
  const body = 'Hello ' + (payload.clientName || 'there') + ',\n\nYour application status has been updated to: ' + (payload.status || 'Updated') + '.\n\nA member of Vancouver Finance Company Inc. will contact you regarding next steps.\n\nVancouver Finance Company Inc.';
  MailApp.sendEmail(payload.clientEmail, subject, body);
}

function sendApprovalEmail(payload) {
  payload.status = 'Conditionally Approved';
  sendStatusEmail(payload);
}

function sendDeclineEmail(payload) {
  payload.status = 'Unable to Proceed at This Time';
  sendStatusEmail(payload);
}

function sendMoreDocsEmail(payload) {
  payload.status = 'Additional Information Required';
  sendStatusEmail(payload);
}
