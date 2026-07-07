function doGet(e) {
  try {
    if (e.parameter.page === 'admin') {
      return HtmlService.createHtmlOutputFromFile('AdminPortal')
        .setTitle('VFC Admin Portal')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    if (e.parameter.page === 'client') {
      return HtmlService.createHtmlOutputFromFile('ClientPortal')
        .setTitle('VFC Client Portal')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    const action = e.parameter.action || '';
    let result;

    if (action === 'listApplications') {
      result = listApplications();
    } else if (action === 'getApplicationDetail') {
      result = getApplicationDetail(e.parameter.applicationId);
    } else if (e.parameter.applicationId) {
      result = getApplicationDetail(e.parameter.applicationId);
    } else {
      result = { ok: true, message: 'VFC AI Underwriting API is running' };
    }

    return outputResponse(result, e);
  } catch (error) {
    return outputResponse({ ok: false, error: error.message }, e);
  }
}
