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
