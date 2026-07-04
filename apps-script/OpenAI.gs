function analyzeStatementTextWithOpenAI(input) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY in Apps Script Properties');

  const prompt = [
    'You are a financial document extraction assistant.',
    'Analyze only the supplied statement text and application context.',
    'Do not make a final lending decision.',
    'Return valid JSON only with these keys:',
    'average_monthly_deposits, nsf_count, negative_days, existing_mca_payments, revenue_trend, risk_grade, underwriter_notes.',
    '',
    'Credit score: ' + (input.creditScore || 'unknown'),
    'Time in business: ' + (input.timeInBusiness || 'unknown'),
    'Industry: ' + (input.industry || 'unknown'),
    '',
    'Statement text:',
    input.statementText || ''
  ].join('\n');

  const payload = {
    model: 'gpt-4.1-mini',
    input: prompt
  };

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const body = JSON.parse(response.getContentText());
  if (status < 200 || status >= 300) {
    throw new Error('OpenAI request failed: ' + response.getContentText());
  }

  const text = extractResponseText(body);
  return JSON.parse(stripCodeFences(text));
}

function extractResponseText(body) {
  if (body.output_text) return body.output_text;
  const chunks = [];
  (body.output || []).forEach(item => {
    (item.content || []).forEach(content => {
      if (content.text) chunks.push(content.text);
    });
  });
  return chunks.join('\n');
}

function stripCodeFences(text) {
  return String(text)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}
