// VFC Hybrid Engine V2 assessment lookup and request-normalization fix.
// Accepts either generatePowerAssessmentSafe(companyName, period)
// or generatePowerAssessmentSafe({ companyName, period, uploadResponse }).

function generatePowerAssessmentSafe(requestOrCompanyName, requestedPeriod) {
  const request = normalizeAssessmentRequest_(requestOrCompanyName, requestedPeriod);
  const companyName = request.companyName;
  const period = resolveLatestAssessmentPeriod_(companyName, request.period);
  return generatePowerAssessment(companyName, period);
}

function normalizeAssessmentRequest_(requestOrCompanyName, requestedPeriod) {
  let companyName = '';
  let period = requestedPeriod || '';

  if (requestOrCompanyName && typeof requestOrCompanyName === 'object') {
    companyName = String(
      requestOrCompanyName.companyName ||
      requestOrCompanyName.company ||
      (requestOrCompanyName.uploadResponse && requestOrCompanyName.uploadResponse.companyName) ||
      ''
    ).trim();

    period = String(
      requestOrCompanyName.period ||
      requestOrCompanyName.detectedPeriod ||
      (requestOrCompanyName.uploadResponse && requestOrCompanyName.uploadResponse.detectedPeriod) ||
      period ||
      ''
    ).trim();
  } else {
    companyName = String(requestOrCompanyName || '').trim();
    period = String(period || '').trim();
  }

  if (!companyName || companyName === 'undefined' || companyName === 'null') {
    throw new Error(
      'Company name was not supplied to the assessment. Run the assessment from the web app after uploading statements; do not run generatePowerAssessmentSafe directly from the Apps Script editor.'
    );
  }

  return { companyName: companyName, period: period };
}

function resolveLatestAssessmentPeriod_(companyName, requestedPeriod) {
  const rows = getSheetObjects_('PDF Summaries').filter(function(row) {
    return sameText_(row.companyName, companyName);
  });

  if (!rows.length) {
    throw new Error(
      'No PDF Summary rows were found for "' + companyName + '". Check the PDF Summaries sheet to confirm that uploadStatementBatch completed and that the company name matches.'
    );
  }

  if (requestedPeriod) {
    const exact = rows.filter(function(row) {
      return sameText_(row.detectedPeriod, requestedPeriod);
    });
    if (exact.length) return String(exact[exact.length - 1].detectedPeriod || requestedPeriod).trim();
  }

  // Use the most recently written summary row for this company.
  const latest = rows[rows.length - 1];
  return String(latest.detectedPeriod || '').trim();
}

function diagnoseAssessmentLookup(requestOrCompanyName, requestedPeriod) {
  const request = normalizeAssessmentRequest_(requestOrCompanyName, requestedPeriod);
  const rows = getSheetObjects_('PDF Summaries').filter(function(row) {
    return sameText_(row.companyName, request.companyName);
  });

  return {
    companyName: request.companyName,
    requestedPeriod: request.period,
    matchingRows: rows.length,
    availablePeriods: unique_(rows.map(function(row) {
      return row.detectedPeriod || '';
    }).filter(Boolean)),
    resolvedPeriod: rows.length ? resolveLatestAssessmentPeriod_(request.companyName, request.period) : ''
  };
}