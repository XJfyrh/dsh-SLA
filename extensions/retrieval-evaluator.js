export function validateDataset(value) {
  if (!Array.isArray(value?.documents) || !value.documents.length || !Array.isArray(value.queries) || !value.queries.length) throw new Error('retrieval-eval.json 需要非空 documents 和 queries');
  const ids = new Set();
  for (const doc of value.documents) {
    if (typeof doc.id !== 'string' || !doc.id || ids.has(doc.id) || typeof doc.title !== 'string' || typeof doc.text !== 'string') throw new Error('检索文档格式错误或 id 重复');
    ids.add(doc.id);
  }
  for (const query of value.queries) if (typeof query.text !== 'string' || !Array.isArray(query.relevant) || !query.relevant.length || new Set(query.relevant).size !== query.relevant.length || query.relevant.some(id => !ids.has(id))) throw new Error('检索问题缺少有效且不重复的 relevant 文档 id');
  return structuredClone(value);
}

const terms = text => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
export function evaluateRetrieval(parameters, dataset) {
  const { topK, titleWeight } = parameters;
  if (!Number.isInteger(topK) || topK < 1 || topK > 5 || !Number.isFinite(titleWeight) || titleWeight < 0 || titleWeight > 8) return { valid: false, summary: 'topK 需为 1–5 的整数，titleWeight 需在 0–8。' };
  const results = dataset.queries.map(query => {
    const words = new Set(terms(query.text));
    const overlap = text => terms(text).filter(word => words.has(word)).length;
    const ranked = dataset.documents.map(doc => ({ id: doc.id, score: overlap(doc.text) + titleWeight * overlap(doc.title) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const returned = ranked.slice(0, topK).map(doc => doc.id);
    const found = query.relevant.filter(id => returned.includes(id)).length;
    return { query: query.text, returned, expected: query.relevant, recall: found / query.relevant.length };
  });
  const recall = results.reduce((sum, result) => sum + result.recall, 0) / results.length;
  const returned = results.reduce((sum, result) => sum + result.returned.length, 0) / results.length;
  return { valid: true, recall, returned, display: `召回 ${(recall * 100).toFixed(1)}% · 返回 ${returned.toFixed(1)} 条`,
    summary: `实际评价 ${results.length} 个问题、${dataset.documents.length} 篇文档；先提高平均召回率，再减少返回条数。`, diagnostics: { results } };
}
