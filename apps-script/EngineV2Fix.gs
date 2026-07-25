// VFC Hybrid Engine V2 period-resolution fix.
// Resolves the newest saved PDF Summary period for a company before assessment.

function generatePowerAssessmentSafe(companyName, requestedPeriod) {
  const resolved = resolveLatestAssessmentPeriod_(companyName, requestedPeriod);
  return generatePowerAssessment(companyName, resolved);
}

function resolveLatestAssessmentPeriod_(companyName, requestedPeriod) {
  const rows = getSheetObjects_('PDF Summaries').filter(function(row) {
    return sameText_(row.companyName, companyName);
  });

  if (!rows.length) {
    throw new Error('The statements were uploaded, but no PDF Summary rows were found for "' + companyName + '". Confirm that uploadStatementBatch completed successfully.');
  }

  // Use the requested period when it genuinely exists.
  if (requestedPeriod) {
    const exact = rows.filter(function(row) {
      return sameText_(row.detectedPeriod, requestedPeriod);
    });
    if (exact.length) return exact[exact.length - 1].detectedPeriod || requestedPeriod;
  }

  // Otherwise use the newest summary row written for this company.
  const latest = rows[rows.length - 1];
  const latestPeriod = String(latest.detectedPeriod || '').trim();
  if (latestPeriod) return latestPeriod;

  // Last fallback allows buildFeaturesForCase_ to use all available rows for the company.
  return '';
}

function diagnoseAssessmentLookup(companyName, requestedPeriod) {
  const rows = getSheetObjects_('PDF Summaries').filter(function(row) {
    return sameText_(row.companyName, companyName);
  });
  return {
    companyName: companyName,
    requestedPeriod: requestedPeriod || '',
    matchingRows: rows.length,
    availablePeriods: unique_(rows.map(function(row) { return row.detectedPeriod || ''; }).filter(Boolean)),
    resolvedPeriod: rows.length ? resolveLatestAssessmentPeriod_(companyName, requestedPeriod) : ''
  };
}
