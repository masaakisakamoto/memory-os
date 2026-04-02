/**
 * Classifier — assigns/refines memory_type from content signals.
 */

export type MemoryType =
  | 'identity'
  | 'relationship'
  | 'goal'
  | 'policy'
  | 'preference'
  | 'project_state'
  | 'procedure'
  | 'episode'
  | 'decision'
  | 'evidence'
  | 'artifact_reference'
  | 'handoff_summary';

export interface ClassificationResult {
  memory_type: MemoryType;
  confidence: number;
  signals: string[];
}

const TYPE_SIGNALS: Record<MemoryType, RegExp[]> = {
  identity:         [/私は.*です/, /I am a/i, /エンジニア|developer|engineer|designer/i],
  relationship:     [/一緒に|チームで|with.*team|collaborated/i],
  goal:             [/目標は|goal is|aim to|を達成したい/],
  policy:           [/この方針で|ポリシー|policy|ルールとして|今後は/],
  preference:       [/好きなのは|prefer|気に入って|好みは/],
  project_state:    [/プロジェクト|進捗|実装中|v0|v1|スコープ/],
  procedure:        [/手順|手順:|やり方|steps?:|方法は/],
  episode:          [/した|しました|ました|was|completed|finished/i],
  decision:         [/決定|決めた|にすることにした|decided|decision/i],
  evidence:         [/証拠|ログ|evidence|log shows|confirmed/i],
  artifact_reference: [/ファイル|file:|github|url:|http/i],
  handoff_summary:  [/引き継ぎ|handoff|next session|次のセッション/],
};

export function classify(content: string): ClassificationResult {
  const scores: Partial<Record<MemoryType, number>> = {};
  const allSignals: string[] = [];

  for (const [type, patterns] of Object.entries(TYPE_SIGNALS) as [MemoryType, RegExp[]][]) {
    let score = 0;
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        score += 1;
        allSignals.push(`${type}:${pattern.source}`);
      }
    }
    if (score > 0) scores[type] = score;
  }

  if (Object.keys(scores).length === 0) {
    return { memory_type: 'episode', confidence: 0.3, signals: [] };
  }

  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  const [topType, topScore] = sorted[0];
  const maxPossible = TYPE_SIGNALS[topType as MemoryType].length;
  const confidence = Math.min(0.95, 0.4 + (topScore / maxPossible) * 0.55);

  return {
    memory_type: topType as MemoryType,
    confidence,
    signals: allSignals,
  };
}
