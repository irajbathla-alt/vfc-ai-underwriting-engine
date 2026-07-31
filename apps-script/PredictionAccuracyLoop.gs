const VFC_ACCURACY_CONFIG = {
  MODEL_VERSION: 'VFC-ACCURACY-LOOP-1.0',
  WITHIN_10: 0.10,
  WITHIN_15: 0.15,
  WITHIN_20: 0.20
};

function ensureAccuracySheets_() {
  ensureSheetSchema_('Prediction Outcomes', [
    'Assessment ID','Company Name','Period','Model Version','Predicted Amount','Actual Decision',
    'Actual Lender','Actual Approved Amount','Dollar Error','Percentage Error','Absolute Percentage Error',
    'Within 10 Percent','Within 15 Percent','Within 20 Percent','Underwriter Notes','Recorded At'
  ]);
}

function saveActualOutcome(request) {
  ensureAccuracySheets_();
  request = request || {};
  const assessmentId = String(request.assessmentId || '').trim();
  const companyName = String(request.companyName || '').trim();
  const period = String(request.period || '').trim();
  const decision = String(request.actualDecision || '').trim();
  const lender = String(request.actualLender || '').trim();
  const predicted = Math.max(0, toNumber_(request.predictedAmount));
  const actual = Math.max(0, toNumber_(request.actualApprovedAmount));
  const notes = String(request.notes || '').trim();

  if (!assessmentId) throw new Error('Assessment ID is required. Run an assessment first.');
  if (!companyName) throw new Error('Company name is required.');
  if (!decision) throw new Error('Actual decision is required.');
  if ((decision === 'Approved' || decision === 'Conditional') && !actual) {
    throw new Error('Enter the actual approved amount.');
  }

  const existing = getSheetObjects_('Prediction Outcomes').filter(function(row) {
    return sameText_(row.assessmentId, assessmentId);
  });
  if (existing.length) throw new Error('An actual outcome has already been recorded for this assessment.');

  const dollarError = actual > 0 ? round2_(predicted - actual) : '';
  const percentageError = actual > 0 ? round2_((predicted - actual) / actual * 100) : '';
  const absolutePercentageError = actual > 0 ? round2_(Math.abs(predicted - actual) / actual * 100) : '';
  const within10 = actual > 0 ? Math.abs(predicted - actual) / actual <= VFC_ACCURACY_CONFIG.WITHIN_10 : '';
  const within15 = actual > 0 ? Math.abs(predicted - actual) / actual <= VFC_ACCURACY_CONFIG.WITHIN_15 : '';
  const within20 = actual > 0 ? Math.abs(predicted - actual) / actual <= VFC_ACCURACY_CONFIG.WITHIN_20 : '';

  appendRow_('Prediction Outcomes', [
    assessmentId,companyName,period,String(request.modelVersion || ''),predicted,decision,lender,actual,
    dollarError,percentageError,absolutePercentageError,within10,within15,within20,notes,new Date()
  ]);

  return {
    ok: true,
    message: 'Actual outcome saved. The prediction error is now included in the accuracy dashboard.',
    dollarError: dollarError,
    percentageError: percentageError,
    absolutePercentageError: absolutePercentageError
  };
}

function getAccuracyDashboard() {
  ensureAccuracySheets_();
  const rows = getSheetObjects_('Prediction Outcomes');
  const amountRows = rows.filter(function(row) {
    return toNumber_(row.actualApprovedAmount) > 0 && toNumber_(row.predictedAmount) > 0;
  });

  const absErrors = amountRows.map(function(row) { return Math.abs(toNumber_(row.dollarError)); });
  const absPctErrors = amountRows.map(function(row) { return Math.abs(toNumber_(row.absolutePercentageError)); });
  const signedPctErrors = amountRows.map(function(row) { return toNumber_(row.percentageError); });

  const byLender = {};
  amountRows.forEach(function(row) {
    const lender = String(row.actualLender || 'Unknown').trim() || 'Unknown';
    byLender[lender] = byLender[lender] || [];
    byLender[lender].push(row);
  });

  const lenderAccuracy = Object.keys(byLender).map(function(lender) {
    const items = byLender[lender];
    const pct = items.map(function(row) { return Math.abs(toNumber_(row.absolutePercentageError)); });
    return {
      lender: lender,
      cases: items.length,
      medianAbsolutePercentageError: round2_(median_(pct)),
      within15Percent: Math.round(items.filter(function(row) { return String(row.within15Percent).toLowerCase() === 'true'; }).length / items.length * 100)
    };
  }).sort(function(a,b) { return a.medianAbsolutePercentageError - b.medianAbsolutePercentageError; });

  const approved = rows.filter(function(row) { return /approved|conditional/i.test(String(row.actualDecision || '')); }).length;
  const declined = rows.filter(function(row) { return /declined/i.test(String(row.actualDecision || '')); }).length;

  return {
    modelVersion: VFC_ACCURACY_CONFIG.MODEL_VERSION,
    totalOutcomes: rows.length,
    amountComparisons: amountRows.length,
    approvedOutcomes: approved,
    declinedOutcomes: declined,
    medianDollarError: round2_(median_(absErrors)),
    medianAbsolutePercentageError: round2_(median_(absPctErrors)),
    averageSignedPercentageError: signedPctErrors.length ? round2_(average_(signedPctErrors)) : 0,
    within10Percent: amountRows.length ? Math.round(amountRows.filter(function(row) { return String(row.within10Percent).toLowerCase() === 'true'; }).length / amountRows.length * 100) : 0,
    within15Percent: amountRows.length ? Math.round(amountRows.filter(function(row) { return String(row.within15Percent).toLowerCase() === 'true'; }).length / amountRows.length * 100) : 0,
    within20Percent: amountRows.length ? Math.round(amountRows.filter(function(row) { return String(row.within20Percent).toLowerCase() === 'true'; }).length / amountRows.length * 100) : 0,
    bias: signedPctErrors.length ? (average_(signedPctErrors) < -5 ? 'Model is generally conservative' : average_(signedPctErrors) > 5 ? 'Model is generally aggressive' : 'Model is broadly balanced') : 'Insufficient outcomes',
    lenderAccuracy: lenderAccuracy,
    recentOutcomes: rows.slice(-10).reverse().map(function(row) {
      return {
        companyName: row.companyName || '',
        predictedAmount: toNumber_(row.predictedAmount),
        actualApprovedAmount: toNumber_(row.actualApprovedAmount),
        actualDecision: row.actualDecision || '',
        actualLender: row.actualLender || '',
        percentageError: row.percentageError === '' ? '' : toNumber_(row.percentageError)
      };
    })
  };
}
