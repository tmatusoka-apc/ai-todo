'use strict';

const https = require('https');

const GEMINI_ENDPOINT = 'generativelanguage.googleapis.com';
const GEMINI_MODEL    = 'gemini-2.0-flash';
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const path = event.rawPath || '/';
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  try {
    if (path === '/suggest') {
      const result = await getAiSuggestion(body.historyJson);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }
    if (path === '/suggest-tasks') {
      const result = await getAiTaskSuggestions(body.historyJson);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

async function getAiSuggestion(historyJson) {
  const history = JSON.parse(historyJson);
  const weekSummary = buildWeekSummary(history.typeCounts || {});

  const prompt =
    'あなたは健康習慣コーチです。ユーザーの今週の活動記録を分析し、今日取り組むべき最適なタスクを1つ推薦してください。\n\n' +
    '今週の達成状況:\n' + weekSummary + '\n\n' +
    '以下のJSON形式のみで回答してください（説明文不要）:\n' +
    '{"type":"exercise|diet|sleep","title":"タスク名（15文字以内）","reason":"推薦理由（40文字以内）"}';

  const result = await callGemini(prompt);
  const match = result.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

async function getAiTaskSuggestions(historyJson) {
  const history = JSON.parse(historyJson);
  const weekSummary = buildWeekSummary(history.typeCounts || {});

  const prompt =
    'あなたは健康習慣コーチです。ユーザーの今週の活動履歴を元に、各カテゴリ2件ずつ計6件のタスクを推薦してください。\n\n' +
    '今週の達成状況:\n' + weekSummary + '\n\n' +
    '以下のJSON配列形式のみで回答してください（説明文不要）:\n' +
    '[{"type":"exercise","title":"タスク名"},{"type":"exercise","title":"タスク名"},' +
    '{"type":"diet","title":"タスク名"},{"type":"diet","title":"タスク名"},' +
    '{"type":"sleep","title":"タスク名"},{"type":"sleep","title":"タスク名"}]';

  const result = await callGemini(prompt);
  const match = result.match(/\[[\s\S]*\]/);
  return match ? match[0] : null;
}

function buildWeekSummary(typeCounts) {
  const labels = { exercise: '運動', diet: '食事', sleep: '睡眠' };
  return Object.entries(labels).map(([type, label]) => {
    const counts = typeCounts[type] || { total: 0, completed: 0 };
    const rate = counts.total > 0 ? Math.round(counts.completed / counts.total * 100) : 0;
    return `- ${label}: ${counts.completed}/${counts.total}件完了（達成率${rate}%）`;
  }).join('\n');
}

function callGemini(prompt) {
  const payload = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 256 }
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: GEMINI_ENDPOINT,
      path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.candidates[0].content.parts[0].text);
        } catch (e) {
          reject(new Error('Gemini parse error: ' + data));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
