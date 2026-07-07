function calculateOfferRange(aiResult, application) {
  aiResult = aiResult || {};
  application = application || {};

  const deposits = Number(aiResult.average_monthly_deposits || 0);
  const score = Number(application.creditScore || application.credit_score || 0);
  const nsf = Number(aiResult.nsf_count || 0);
  const negativeDays = Number(aiResult.negative_days || 0);
  const existingMca = Number(aiResult.existing_mca_payments || 0);

  let multiplier = 0.45;
  let riskGrade = 'C';
  const conditions = [];

  if (deposits <= 0) {
    conditions.push('Average monthly deposits missing or zero');
  }

  if (score >= 700 && nsf <= 1 && negativeDays <= 2) {
    multiplier = 1.0;
    riskGrade = 'A';
  } else if (score >= 650 && nsf <= 3 && negativeDays <= 5) {
    multiplier = 0.75;
    riskGrade = 'B';
  } else if (score >= 600 && nsf <= 6) {
    multiplier = 0.50;
    riskGrade = 'C';
  } else {
    multiplier = 0.25;
    riskGrade = 'D';
    conditions.push('Manual senior review required');
  }

  if (existingMca > 0) {
    multiplier = Math.max(0.15, multiplier - 0.15);
    conditions.push('Verify existing MCA obligations and stacking exposure');
  }

  if (aiResult.revenue_trend === 'declining') {
    multiplier = Math.max(0.15, multiplier - 0.10);
    conditions.push('Review declining revenue trend');
  }

  const midpoint = deposits * multiplier;
  const lowOffer = Math.round(midpoint * 0.75 / 1000) * 1000;
  const highOffer = Math.round(midpoint * 1.10 / 1000) * 1000;

  return {
    riskGrade,
    lowOffer: Math.max(0, lowOffer),
    highOffer: Math.max(0, highOffer),
    recommendedAction: riskGrade === 'D' ? 'Manual Review' : 'Review for Conditional Approval',
    conditions
  };
}

function testCalculateOfferRange() {
  const sampleAiResult = {
    average_monthly_deposits: 72500,
    nsf_count: 2,
    negative_days: 3,
    existing_mca_payments: 0,
    revenue_trend: 'stable'
  };

  const sampleApplication = {
    creditScore: 680,
    timeInBusiness: '3 years',
    industry: 'Restaurant'
  };

  const result = calculateOfferRange(sampleAiResult, sampleApplication);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}


function buildUnderwritingRecommendation(aiResult, application) {
  const offer = calculateOfferRange(aiResult, application);
  const training = getTrainedLenderRecommendations(application, aiResult);

  if (training.recommendedLender) {
    offer.recommendedLender = training.recommendedLender;
    offer.lenderRecommendations = training.recommendations;
    offer.trainingSummary = training.summary;
    offer.conditions = offer.conditions.concat(training.conditions || []);
  } else {
    offer.recommendedLender = '';
    offer.lenderRecommendations = [];
    offer.trainingSummary = training.summary;
  }

  return offer;
}

function getTrainedLenderRecommendations(application, aiResult) {
  const cases = loadHistoricalTrainingCases();
  if (!cases.length) {
    return {
      recommendedLender: '',
      recommendations: [],
      conditions: ['No historical case-study training data available yet'],
      summary: 'Add approved and declined lender cases to the Historical Cases tab to activate trained lender-fit recommendations.'
    };
  }

  const profiles = buildLenderTrainingProfiles(cases);
  const recommendations = Object.keys(profiles)
    .map(lenderName => scoreLenderProfile(profiles[lenderName], application || {}, aiResult || {}))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const best = recommendations[0] || null;
  return {
    recommendedLender: best ? best.lenderName : '',
    recommendations,
    conditions: best && best.conditions.length ? ['Training model lender fit: ' + best.conditions.join('; ')] : [],
    summary: 'Training model used ' + cases.length + ' historical cases across ' + Object.keys(profiles).length + ' lender profile(s).'
  };
}

function loadHistoricalTrainingCases() {
  if (typeof getRows !== 'function' || typeof CONFIG === 'undefined' || !CONFIG.HISTORICAL_CASES_TAB) return [];

  const rows = getRows(CONFIG.HISTORICAL_CASES_TAB);
  if (!rows || rows.length <= 1 || typeof rowsToObjects !== 'function') return [];

  return rowsToObjects(rows).map(row => ({
    caseId: row.caseId || '',
    lenderName: row.lenderName || '',
    decision: String(row.decision || '').toLowerCase(),
    funded: String(row.funded || '').toLowerCase(),
    approvedAmount: Number(row.approvedAmount || 0),
    requestedAmount: Number(row.requestedAmount || 0),
    industry: row.industry || row.businessIndustry || '',
    timeInBusinessMonths: parseTimeInBusinessMonths(row.timeInBusiness),
    creditScore: Number(row.creditScore || 0),
    averageMonthlyDeposits: Number(row.averageMonthlyDeposits || 0),
    nsfCount: Number(row.nsfCount || 0),
    negativeDays: Number(row.negativeDays || 0),
    existingMcaPayments: Number(row.existingMcaPayments || 0),
    revenueTrend: row.revenueTrend || 'unknown',
    reasonApproved: row.reasonApproved || '',
    reasonDeclined: row.reasonDeclined || '',
    conditions: row.conditions || ''
  })).filter(row => row.lenderName);
}

function buildLenderTrainingProfiles(cases) {
  const profiles = {};
  cases.forEach(trainingCase => {
    const lenderName = trainingCase.lenderName;
    if (!profiles[lenderName]) {
      profiles[lenderName] = {
        lenderName,
        totalCases: 0,
        approvals: 0,
        declines: 0,
        funded: 0,
        approvedAmounts: [],
        requestedAmounts: [],
        creditScores: [],
        deposits: [],
        nsfCounts: [],
        negativeDays: [],
        tibMonths: [],
        approvedIndustries: {},
        declinedReasons: {},
        commonConditions: {}
      };
    }

    const profile = profiles[lenderName];
    const approved = trainingCase.decision === 'approved' || trainingCase.funded === 'yes';
    profile.totalCases += 1;
    if (approved) profile.approvals += 1;
    else profile.declines += 1;
    if (trainingCase.funded === 'yes') profile.funded += 1;

    addPositiveNumber(profile.approvedAmounts, trainingCase.approvedAmount);
    addPositiveNumber(profile.requestedAmounts, trainingCase.requestedAmount);
    addPositiveNumber(profile.creditScores, trainingCase.creditScore);
    addPositiveNumber(profile.deposits, trainingCase.averageMonthlyDeposits);
    addNonNegativeNumber(profile.nsfCounts, trainingCase.nsfCount);
    addNonNegativeNumber(profile.negativeDays, trainingCase.negativeDays);
    addPositiveNumber(profile.tibMonths, trainingCase.timeInBusinessMonths);

    if (approved && trainingCase.industry) incrementCounter(profile.approvedIndustries, trainingCase.industry);
    if (!approved && trainingCase.reasonDeclined) incrementCounter(profile.declinedReasons, trainingCase.reasonDeclined);
    if (trainingCase.conditions) incrementCounter(profile.commonConditions, trainingCase.conditions);
  });

  Object.keys(profiles).forEach(lenderName => enrichLenderProfile(profiles[lenderName]));
  return profiles;
}

function scoreLenderProfile(profile, application, aiResult) {
  const creditScore = Number(application.creditScore || application.credit_score || 0);
  const deposits = Number(aiResult.average_monthly_deposits || application.monthlySalesEstimate || 0);
  const nsf = Number(aiResult.nsf_count || 0);
  const negativeDays = Number(aiResult.negative_days || 0);
  const tibMonths = parseTimeInBusinessMonths(application.timeInBusiness || application.time_in_business);
  const industry = String(application.industry || '').toLowerCase();
  const conditions = [];

  let score = 50 + (profile.approvalRate * 30);
  score += scoreMetricFit(creditScore, profile.creditScoreMedian, false, 'credit score', conditions);
  score += scoreMetricFit(deposits, profile.depositMedian, false, 'monthly deposits', conditions);
  score += scoreMetricFit(tibMonths, profile.tibMedian, false, 'time in business', conditions);
  score += scoreMetricFit(nsf, profile.nsfMedian, true, 'NSF count', conditions);
  score += scoreMetricFit(negativeDays, profile.negativeDaysMedian, true, 'negative days', conditions);

  if (industry && profile.topApprovedIndustries.some(item => String(item.value).toLowerCase() === industry)) score += 6;
  if (profile.totalCases < 3) conditions.push('limited training sample for this lender');

  return {
    lenderName: profile.lenderName,
    score: Math.max(0, Math.min(100, Math.round(score))),
    approvalRate: Math.round(profile.approvalRate * 100),
    historicalCases: profile.totalCases,
    medianApprovedAmount: profile.approvedAmountMedian,
    topIndustries: profile.topApprovedIndustries.map(item => item.value),
    conditions
  };
}

function enrichLenderProfile(profile) {
  profile.approvalRate = profile.totalCases ? profile.approvals / profile.totalCases : 0;
  profile.approvedAmountMedian = median(profile.approvedAmounts);
  profile.creditScoreMedian = median(profile.creditScores);
  profile.depositMedian = median(profile.deposits);
  profile.nsfMedian = median(profile.nsfCounts);
  profile.negativeDaysMedian = median(profile.negativeDays);
  profile.tibMedian = median(profile.tibMonths);
  profile.topApprovedIndustries = topCounterValues(profile.approvedIndustries, 3);
}

function scoreMetricFit(actual, benchmark, lowerIsBetter, label, conditions) {
  if (!actual || !benchmark) return 0;
  const ratio = actual / benchmark;
  if (lowerIsBetter) {
    if (actual <= benchmark) return 5;
    if (actual <= benchmark * 1.5) return 1;
    conditions.push(label + ' above this lender historical approval pattern');
    return -5;
  }
  if (ratio >= 1) return 5;
  if (ratio >= 0.8) return 1;
  conditions.push(label + ' below this lender historical approval pattern');
  return -5;
}

function parseTimeInBusinessMonths(value) {
  const text = String(value || '').toLowerCase();
  const years = Number((text.match(/(\d+(?:\.\d+)?)\s*(?:year|yr|y)/) || [])[1] || 0);
  const months = Number((text.match(/(\d+(?:\.\d+)?)\s*(?:month|mo|m)/) || [])[1] || 0);
  if (years || months) return Math.round((years * 12) + months);
  const numeric = Number(value || 0);
  return numeric > 0 && numeric < 20 ? Math.round(numeric * 12) : Math.round(numeric || 0);
}

function addPositiveNumber(values, value) {
  if (Number(value) > 0) values.push(Number(value));
}

function addNonNegativeNumber(values, value) {
  if (Number(value) >= 0) values.push(Number(value));
}

function incrementCounter(counter, value) {
  const key = String(value || '').trim();
  if (!key) return;
  counter[key] = (counter[key] || 0) + 1;
}

function median(values) {
  const sorted = (values || []).filter(value => Number(value) || Number(value) === 0).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function topCounterValues(counter, limit) {
  return Object.keys(counter || {})
    .map(value => ({ value, count: counter[value] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit || 3);
}

function testBuildUnderwritingRecommendation() {
  const sampleAiResult = {
    average_monthly_deposits: 72500,
    nsf_count: 2,
    negative_days: 3,
    existing_mca_payments: 0,
    revenue_trend: 'stable'
  };

  const sampleApplication = {
    creditScore: 680,
    timeInBusiness: '3 years',
    industry: 'Restaurant',
    monthlySalesEstimate: 72000
  };

  const result = buildUnderwritingRecommendation(sampleAiResult, sampleApplication);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
