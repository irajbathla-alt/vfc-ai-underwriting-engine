const VFC_INSTITUTIONAL_CONFIG = {
  MODEL_VERSION: 'VFC-ORIGINAL-12M-MAX-4.0',
  TERM_MONTHS: 12
};

function generateInstitutionalAssessmentSafe(companyOrRequest, requestedPeriod) {
  const base = generatePowerAssessmentSafe(companyOrRequest, requestedPeriod);
  const capacity = base.lendingCapacity || {};
  const fundamental = base.fundamentalScorecard || {};
  const features = base.currentFeatures || {};
  const rankings = base.lenderRankings || [];
  const maxLoan = Math.max(0, toNumber_(capacity.recommendedAmount));
  const stretch = Math.max(maxLoan, toNumber_(capacity.stretchAmount));
  const top = rankings[0] || {};

  base.institutionalAssessment = {
    modelVersion: VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,
    termMonths: VFC_INSTITUTIONAL_CONFIG.TERM_MONTHS,
    maximumLoanAmount: maxLoan,
    stretchAmount: stretch,
    amountConfidence: capacity.confidence || '',
    amountConfidenceScore: toNumber_(capacity.confidenceScore),
    businessHealthScore: toNumber_(fundamental.score),
    riskGrade: fundamental.grade || '',
    averageMonthlyDeposits: toNumber_(features.averageMonthlyDeposits),
    historicalAnchor: toNumber_(capacity.historicalAnchor),
    cashFlowCapacity: toNumber_(capacity.cashFlowCapacity),
    revenueCapacity: toNumber_(capacity.revenueCapacity),
    strongestLender: top.lenderName || '',
    lenderFitScore: toNumber_(top.compositeScore),
    calculationNotes: capacity.calculationNotes || [],
    strengths: fundamental.strengths || [],
    risks: fundamental.risks || [],
    decision: maxLoan > 0 ? 'Maximum 12-month loan recommendation' : 'No automated loan amount recommended',
    methodologyNote: 'This amount is produced by the original VFC hybrid underwriting criteria using historical lender outcomes, lender similarity, business-bank-statement fundamentals, banking behaviour, data quality and AI risk review. No 6-, 9- or 12-month repayment overlay is applied.'
  };

  base.modelVersion = VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION;
  base.disclaimer = 'VFC internal decision support only. The maximum loan amount uses the original underwriting model that was calibrated against actual historical lender outcomes. It is not a lender approval or guarantee.';
  saveOriginalMaximumAssessment_(base);
  return base;
}

function saveOriginalMaximumAssessment_(base) {
  const i = base.institutionalAssessment || {};
  ensureSheetSchema_('Institutional Assessments', [
    'Assessment ID','Model Version','Company Name','Period','Term Months','Maximum Loan Amount',
    'Stretch Amount','Business Health Score','Risk Grade','Average Monthly Deposits',
    'Historical Anchor','Cash Flow Capacity','Revenue Capacity','Amount Confidence',
    'Amount Confidence Score','Strongest Lender','Lender Fit Score','Calculation Notes','Created At'
  ]);
  appendRow_('Institutional Assessments', [
    base.assessmentId,i.modelVersion,base.companyName,base.period,i.termMonths,i.maximumLoanAmount,
    i.stretchAmount,i.businessHealthScore,i.riskGrade,i.averageMonthlyDeposits,
    i.historicalAnchor,i.cashFlowCapacity,i.revenueCapacity,i.amountConfidence,
    i.amountConfidenceScore,i.strongestLender,i.lenderFitScore,cleanCell_(i.calculationNotes),new Date()
  ]);
}