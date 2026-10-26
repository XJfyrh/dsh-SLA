import { z } from 'zod';
import type { Evaluation } from '../src/data.js';
import { isRecord } from '../src/errors.js';
const datasetSchema = z.object({
  documents: z.array(z.object({ id: z.string(), title: z.string(), text: z.string() })).min(1),
  queries: z.array(z.object({ text: z.string(), relevant: z.array(z.string()).min(1) })).min(1),
});
export type RetrievalDataset = z.infer<typeof datasetSchema>;
export function validateDataset(input: unknown): RetrievalDataset {
  if (!isRecord(input) || !Array.isArray(input.documents) || !input.documents.length || !Array.isArray(input.queries) || !input.queries.length) throw new Error('retrieval-eval.json 需要非空 documents 和 queries');
  const parsed = datasetSchema.safeParse(input);
  if (!parsed.success) throw new Error('检索文档格式错误或检索问题缺少有效且不重复的 relevant 文档 id');
  const value = parsed.data;
  const ids = new Set<string>();
  for (const doc of value.documents) {
    if (!doc.id || ids.has(doc.id)) throw new Error('检索文档格式错误或 id 重复');
    ids.add(doc.id);
  }
  for (const query of value.queries) if (new Set(query.relevant).size !== query.relevant.length || query.relevant.some(id => !ids.has(id))) throw new Error('检索问题缺少有效且不重复的 relevant 文档 id');
  return value;
}

const terms = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
export function evaluateRetrieval(parameters: unknown, dataset: RetrievalDataset): Evaluation {
  const { topK, titleWeight } = isRecord(parameters) ? parameters : {};
  if (typeof topK !== 'number' || typeof titleWeight !== 'number' || !Number.isInteger(topK) || topK < 1 || topK > 5 || !Number.isFinite(titleWeight) || titleWeight < 0 || titleWeight > 8) return { valid: false, summary: 'topK 需为 1–5 的整数，titleWeight 需在 0–8。' };
  const results = dataset.queries.map(query => {
    const words = new Set(terms(query.text));
    const overlap = (text: string) => terms(text).filter(word => words.has(word)).length;
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
