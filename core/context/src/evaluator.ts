/**
 * Handoff quality evaluator — deterministic, no LLM.
 *
 * Scores a HandoffContext against eight rubric categories:
 *
 *   continuity_accuracy   (20) — does the next session understand where things stand?
 *   state_freshness       ( 5) — is the data grounded in committed memories?
 *   decision_preservation (20) — are key decisions captured and transformed into actions?
 *   actionability         (15) — does the next session know what to do?
 *   noise_control         (10) — is content in the correct sections (no cross-contamination)?
 *   consistency           (15) — is the content internally consistent and non-contradictory?
 *   handoff_readiness     ( 5) — basic structural integrity
 *   relationship_quality  (10) — does the relationship section convey collaboration specifics?
 *
 * Total max: 100. Pass threshold: 60.
 *
 * Two evaluation modes:
 *
 *   evaluateHandoff(ctx)            — pure function, no DB. Scores the artifact text only.
 *                                     Detects wrong content via 4 consistency sub-checks.
 *
 *   evaluateHandoffWithState(db, ctx) — async, queries DB. Topic-fingerprints committed
 *                                     memories and pending proposals, then detects 5 classes
 *                                     of mismatch between DB state and the handoff artifact.
 *                                     Returns HandoffEvalResultV2 with state_consistency block.
 *
 * Fingerprinting (state-aware, deterministic):
 *   topicFingerprint(text) extracts stable keyword tokens from English + CJK text.
 *   - Latin: ≥4 chars, not in TOPIC_STOPWORDS (superset of DOMAIN_STOPWORDS)
 *   - CJK:   kanji/katakana runs ≥2 chars as atomic topic units
 *   - Bigrams: consecutive Latin unigram pairs joined with "_" (e.g., "rate_limiting")
 *   Overlap detection uses token set intersection — requires ≥2 shared tokens (or 1
 *   shared token when either fingerprint has fewer than 2 tokens: short-fingerprint fallback).
 *
 * Mismatch types (state_consistency.mismatches):
 *   missing_policy        — committed policy not reflected in global_policies section
 *   missing_project_state — committed project_state not reflected in active_project section
 *   unresolved_proposal   — pending proposal not surfaced in operational_next_actions or open_loops
 *   stale_loop            — open_loop topic covered by committed settled state (policy, project_state, procedure, or non-deferred decision)
 *   strategic_contradiction — Pursue: action contradicts a committed deferred decision (DB-authoritative)
 */

import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { HandoffContext } from './handoff-generator';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface CategoryScore {
  name: string;
  score: number;
  max: number;
  notes: string[];
}

/** Severity of a detected issue — critical blocks next session, warning degrades quality, info is advisory. */
export type Severity = 'critical' | 'warning' | 'info';

/**
 * Rich failure record — one per detected issue in the handoff artifact.
 * Parallel to the legacy `failures: string[]` field; both are produced from the same
 * conditions so they stay in sync.
 *
 * code:         snake_case machine-readable identifier (stable across evaluator versions)
 * message:      human-readable description (same text as the failures[] entry)
 * severity:     critical → next session is actively harmed; warning → quality degraded; info → advisory
 * fix_hint:     1–2 sentence actionable repair instruction, no LLM required
 * auto_fixable: true when re-running rebuild-context-cache alone is sufficient to fix the issue
 */
export interface FailureDetail {
  code: string;
  message: string;
  severity: Severity;
  fix_hint: string;
  auto_fixable: boolean;
}

export interface HandoffEvalResult {
  eval_id: string;
  context_id: string;
  evaluated_at: string;
  score_total: number;
  score_max: number;
  pass: boolean;
  pass_threshold: number;
  categories: CategoryScore[];
  failures: string[];
  recommendations: string[];
  /** Rich failure records with severity, fix_hint, and auto_fixable flag (v1.0+). */
  failure_details: FailureDetail[];
}

/**
 * A topic fingerprint record built from a single DB row (memory or proposal).
 * fingerprint: stable keyword tokens from content + summary (see topicFingerprint).
 * content_preview: first 100 chars of the source content.
 * deferred: true if this is a 'decision' memory with a deferral signal — set for
 *   strategic_contradiction detection.
 */
export interface TopicRecord {
  id: string;
  type: string;
  fingerprint: string[];
  content_preview: string;
  deferred?: boolean;
}

export type MismatchType =
  | 'missing_policy'
  | 'missing_project_state'
  | 'unresolved_proposal'
  | 'stale_loop'
  | 'strategic_contradiction';

export interface StateMismatch {
  mismatch_type: MismatchType;
  db_id: string;
  db_type: string;
  handoff_section: string;
  detail: string;
  /** v1.0: severity, fix_hint, and auto_fixable populated by mismatchMeta(). */
  severity: Severity;
  fix_hint: string;
  auto_fixable: boolean;
}

export interface HandoffStateConsistency {
  proposal_topics_db: TopicRecord[];
  memory_topics_db: TopicRecord[];
  handoff_topics: {
    global_policies: string[];
    active_project: string[];
    relevant_decisions: string[];
    open_loops: string[];
    operational_next_actions: string[];
  };
  mismatches: StateMismatch[];
}

export interface HandoffEvalResultV2 extends HandoffEvalResult {
  state_consistency: HandoffStateConsistency;
}

export const PASS_THRESHOLD = 60;

// ---------------------------------------------------------------------------
// Signal patterns (deterministic, no LLM)
// ---------------------------------------------------------------------------

/** active_project fallback message written by deriveProjectFallback when no state exists */
const FALLBACK_MSG      = /no committed state recorded yet/i;

/** Identity-like content that should NOT appear in the relationship section */
const IDENTITY_SIGNAL   = /私は.*エンジニア|バックエンドエンジニア|I am a|I'm a.*engineer/i;

/** Policy-like content that should NOT appear in the active_project section */
const POLICY_SIGNAL     = /すべての.*レスポンス|All.*response.*header|X-Request-ID/i;

/** Approval tasks that belong in operational_next_actions, not strategic */
const APPROVAL_SIGNAL   = /^Approve pending/i;

/** Defer/postpone signals in decision memories. Covers explicit deferral words, scope exclusions, and temporal hedges. */
const DEFER_SIGNAL      = /deferred|v1以降|later|後で|postponed|not yet|まだ|out[\s-]of[\s-]scope|\bdefer\b|\bfuture\b|\bbacklog\b|\bv1\b/i;

/** Roadmap/phase language that belongs in strategic, not operational */
const ROADMAP_SIGNAL    = /\bv1\b|A→B|roadmap|milestone|phase\b|staged|世界標準/i;

/**
 * Action verbs expected at the start of strategic_next_actions items.
 * These are the verbs produced by transformDecisionToAction() in the generator.
 */
const STRATEGIC_VERB    = /^(Pursue|Maintain|Prioritize|Proceed|Continue|Enforce|Build|Focus|Advance|Complete|Establish|Deliver)/i;

/**
 * Relationship quality signals.
 * STYLE_SIGNAL: explicit collaboration norms — review standards, quality bar, no flattery.
 * AUTHORITY_SIGNAL: who sets direction, who reviews, decision-making clarity.
 * REL_GENERIC: bare "Collaboration on X" boilerplate with no elaboration.
 */
const STYLE_SIGNAL      = /world[\s-]class|no flattery|媚びず|世界トップ/i;
const AUTHORITY_SIGNAL  = /sets\s+(design|direction|architecture)|design.{0,20}direction|レビュー|設計判断/i;
const REL_GENERIC       = /^Collaboration on |^Collaborating on /im;

/**
 * Relationship consistency signals (v0.5).
 * DESIGN_FIRST_SIGNAL: relationship declares design-locked-before-implementation principle.
 * IMPL_VERB: strategic action verbs that indicate implementation work, not design/architecture.
 * When relationship signals design-first AND all strategic actions are impl-heavy → sub-check 5 fires.
 */
const DESIGN_FIRST_SIGNAL = /design.*before.*impl|design.*first|lock.*before|先に.*固め|設計.*優先|design.{0,30}locked/i;
const IMPL_VERB           = /^(Build|Implement|Write|Code|Develop|Create)/i;

// ---------------------------------------------------------------------------
// Stopword lists
// ---------------------------------------------------------------------------

/**
 * Domain-specific stopwords for artifact-level keyword fingerprinting.
 * These terms appear in virtually every memory, decision, and action in Memory OS,
 * so they carry no topic-discriminating signal and would cause false positives.
 */
const DOMAIN_STOPWORDS = new Set([
  'proposal', 'proposals', 'approval', 'approved', 'approve',
  'commit', 'commits', 'committed', 'memory', 'memories',
  'context', 'session', 'sessions', 'handoff',
]);

/**
 * Extended stopwords for state-aware topic fingerprinting.
 * Superset of DOMAIN_STOPWORDS. Also excludes common English function words
 * (4–6 chars) that would pass the length filter but carry no topic identity,
 * causing false-positive overlap between unrelated records.
 */
const TOPIC_STOPWORDS = new Set([
  ...DOMAIN_STOPWORDS,
  'must', 'will', 'have', 'this', 'that', 'with', 'from', 'also',
  'when', 'then', 'only', 'been', 'made', 'used', 'into', 'each',
  'both', 'same', 'more', 'next', 'last', 'note', 'once', 'over',
]);

// ---------------------------------------------------------------------------
// Helpers (artifact-level)
// ---------------------------------------------------------------------------

function nonEmpty(arr: string[] | null | undefined): boolean {
  return Array.isArray(arr) && arr.length > 0;
}

function hasContent(arr: string[] | null | undefined, pattern: RegExp): boolean {
  return (arr ?? []).some(item => pattern.test(item));
}

function scoreCategory(
  name: string,
  max: number,
  fn: () => { score: number; notes: string[] }
): CategoryScore {
  const { score, notes } = fn();
  return { name, score: Math.min(Math.max(0, score), max), max, notes };
}

/**
 * Extracts ASCII keyword tokens (≥4 chars, not domain stopwords) from text.
 * Used by the artifact-level consistency scorer where DOMAIN_STOPWORDS is sufficient.
 * CJK is intentionally stripped here — see topicFingerprint for CJK-aware version.
 */
function keywordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !DOMAIN_STOPWORDS.has(w));
}

function keywordsOverlap(a: string, b: string): boolean {
  const aKeys = keywordsOf(a);
  const bLower = b.toLowerCase();
  return aKeys.some(k => bLower.includes(k));
}

// ---------------------------------------------------------------------------
// Topic fingerprinting (state-aware)
// ---------------------------------------------------------------------------

/**
 * Domain phrase lexicon — recognizes compound domain concepts that span
 * word boundaries or use punctuation (→, -, _, spaces) as separators.
 * Each entry is a [pattern, canonical_token] pair.
 *
 * These phrases would be missed by bigrams alone because:
 *   - "request_id"  → "id" is 2 chars (filtered); bigram never forms
 *   - "api_response" → "api" is 3 chars (filtered); bigram never forms
 *   - "proposal_approval_commit" → all three are in DOMAIN_STOPWORDS; filtered
 *   - "world_standard" → "世界標準" captured as CJK, but the English form is not
 *
 * Patterns use non-global flags — safe to call .test() without resetting lastIndex.
 */
const DOMAIN_PHRASE_PATTERNS: Array<[RegExp, string]> = [
  [/request[-_\s]*id|リクエストid|リクエスト[-_\s]*id/i,                    'request_id'],
  [/api[-_\s]*response|apiレスポンス/i,                                       'api_response'],
  [/handoff[-_\s]*quality/i,                                                   'handoff_quality'],
  [/project[-_\s]*state|プロジェクト[-_\s]*状態/i,                            'project_state'],
  [/proposal\s*[→\-_>]\s*approval\s*[→\-_>]\s*commit|proposal\s+approval\s+commit/i, 'proposal_approval_commit'],
  [/design[-_\s]*first|設計[-_\s]*ファースト|設計を先に/i,                    'design_first'],
  [/world[-_\s]*standard|世界標準/i,                                           'world_standard'],
];

/**
 * Extracts stable topic tokens from English + CJK text for state-aware mismatch
 * detection. Uses TOPIC_STOPWORDS (a strict superset of DOMAIN_STOPWORDS).
 *
 * Latin: lowercase tokens ≥4 chars that are not in TOPIC_STOPWORDS.
 * Bigrams: consecutive Latin unigram pairs joined with "_".
 * Domain phrases: DOMAIN_PHRASE_PATTERNS injected as canonical tokens.
 * CJK: contiguous kanji + katakana runs ≥2 chars, treated as atomic topic units.
 *
 * Result is a deduplicated string[]. Overlap detection uses exact set intersection.
 */
function topicFingerprint(text: string): string[] {
  const tokens = new Set<string>();
  const unigramList: string[] = [];

  // Latin/ASCII: lowercase, non-alnum → space, filter by length + stopwords
  for (const w of text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (w.length >= 4 && !TOPIC_STOPWORDS.has(w)) {
      tokens.add(w);
      unigramList.push(w);
    }
  }

  // Bigrams from consecutive Latin unigrams — capture compound concepts
  // (e.g., "rate_limiting", "request_header", "typescript_strict")
  for (let i = 0; i < unigramList.length - 1; i++) {
    tokens.add(`${unigramList[i]}_${unigramList[i + 1]}`);
  }

  // Domain phrase lexicon — inject canonical tokens for known multi-word concepts
  // that bigrams cannot capture (short components, stopword components, etc.)
  for (const [pattern, phrase] of DOMAIN_PHRASE_PATTERNS) {
    if (pattern.test(text)) tokens.add(phrase);
  }

  // CJK: extract kanji + katakana runs ≥2 chars as topic units
  // Unicode ranges: CJK Unified Ideographs U+4E00-U+9FFF, Katakana U+30A0-U+30FF
  for (const seq of (text.match(/[\u4e00-\u9fff\u30a0-\u30ff]{2,}/g) ?? [])) {
    tokens.add(seq);
  }

  return [...tokens];
}

/**
 * Union fingerprint of all items in a section.
 * Used to build a single fingerprint set representing an entire handoff section,
 * for overlap comparison against individual DB record fingerprints.
 */
function sectionFingerprint(items: string[]): string[] {
  const all = new Set<string>();
  for (const item of items) {
    for (const t of topicFingerprint(item)) all.add(t);
  }
  return [...all];
}

/**
 * Returns true when a and b share at least minShared tokens (default: 2).
 * Short-fingerprint fallback: if either array has fewer than minShared tokens,
 * any single shared token is sufficient — avoids false negatives on tiny fingerprints
 * (e.g., a one-word policy like "CORS" should still match its one-word representation).
 */
function fingerprintOverlap(a: string[], b: string[], minShared = 2): boolean {
  const setB = new Set(b);
  let count = 0;
  for (const t of a) {
    if (setB.has(t) && ++count >= minShared) return true;
  }
  // Short-fingerprint fallback: one shared token is enough if either side is tiny
  return count > 0 && (a.length < minShared || b.length < minShared);
}

// ---------------------------------------------------------------------------
// Category scorers
// ---------------------------------------------------------------------------

function scoreContinuityAccuracy(ctx: HandoffContext): CategoryScore {
  return scoreCategory('continuity_accuracy', 20, () => {
    const s = ctx.sections;
    let score = 0;
    const notes: string[] = [];

    const projectOk = nonEmpty(s.active_project) && !hasContent(s.active_project, FALLBACK_MSG);
    if (projectOk) {
      score += 8;
      notes.push('active_project populated (+8)');
    } else {
      notes.push('active_project empty or contains only fallback message (0/8)');
    }

    if (nonEmpty(s.relevant_decisions)) {
      score += 6;
      notes.push('relevant_decisions populated (+6)');
    } else {
      notes.push('relevant_decisions empty (0/6)');
    }

    if (nonEmpty(s.relationship)) {
      score += 4;
      notes.push('relationship populated (+4)');
    } else {
      notes.push('relationship empty (0/4)');
    }

    if (nonEmpty(s.identity)) {
      score += 2;
      notes.push('identity populated (+2)');
    } else {
      notes.push('identity empty (0/2)');
    }

    return { score, notes };
  });
}

function scoreStateFreshness(ctx: HandoffContext): CategoryScore {
  return scoreCategory('state_freshness', 5, () => {
    const s = ctx.sections;
    let score = 0;
    const notes: string[] = [];

    // Memory count: primary freshness signal (max +3)
    const memCount = ctx.source_memories.length;
    if (memCount >= 5) {
      score += 3;
      notes.push(`source_memories=${memCount} (>=5, +3)`);
    } else if (memCount >= 3) {
      score += 2;
      notes.push(`source_memories=${memCount} (>=3, +2)`);
    } else if (memCount >= 1) {
      score += 1;
      notes.push(`source_memories=${memCount} (>=1, +1)`);
    } else {
      notes.push('source_memories=0 — no committed memories (0/3)');
    }

    // Section population ratio across five key continuity sections (max +2)
    const keySections = [
      'active_project', 'relevant_decisions', 'relationship',
      'strategic_next_actions', 'operational_next_actions',
    ] as const;
    const populated = keySections.filter(k => nonEmpty(s[k])).length;
    const sectionScore = Math.round((populated / keySections.length) * 2);
    score += sectionScore;
    notes.push(`key sections populated: ${populated}/${keySections.length} (+${sectionScore})`);

    if (hasContent(s.active_project, FALLBACK_MSG)) {
      score = Math.max(0, score - 1);
      notes.push('active_project contains fallback message (-1)');
    }

    return { score, notes };
  });
}

function scoreDecisionPreservation(ctx: HandoffContext): CategoryScore {
  return scoreCategory('decision_preservation', 20, () => {
    const s = ctx.sections;
    let score = 0;
    const notes: string[] = [];

    const decisionCount = (s.relevant_decisions ?? []).length;
    if (decisionCount >= 2) {
      score += 10;
      notes.push(`relevant_decisions has ${decisionCount} items (+10)`);
    } else if (decisionCount === 1) {
      score += 6;
      notes.push('relevant_decisions has 1 item (+6)');
    } else {
      notes.push('relevant_decisions empty (0/10)');
    }

    if (nonEmpty(s.strategic_next_actions)) {
      score += 8;
      notes.push('strategic_next_actions populated (+8)');
    } else {
      notes.push('strategic_next_actions empty (0/8)');
    }

    // Transformation check: strategic items must not be verbatim or prefix-only copies
    const decisionTexts = s.relevant_decisions ?? [];
    const strategicTexts = s.strategic_next_actions ?? [];
    if (strategicTexts.length > 0) {
      const verbatimCount = strategicTexts.filter(sa =>
        decisionTexts.some(d => d.trim() === sa.trim())
      ).length;

      const prefixOnlyCount = strategicTexts.filter(sa => {
        const withoutPrefix = sa.replace(
          /^(Pursue|Maintain|Prioritize|Proceed|Continue|Enforce|Build|Focus|Advance|Complete|Establish|Deliver):\s*/i,
          ''
        );
        return withoutPrefix !== sa && decisionTexts.some(d => d.trim() === withoutPrefix.trim());
      }).length;

      if (verbatimCount === 0 && prefixOnlyCount === 0) {
        score += 2;
        notes.push('strategic_next_actions are genuinely transformed — not verbatim or prefix-only copies (+2)');
      } else {
        const parts: string[] = [];
        if (verbatimCount > 0) parts.push(`${verbatimCount} verbatim`);
        if (prefixOnlyCount > 0) parts.push(`${prefixOnlyCount} prefix-only`);
        notes.push(`strategic_next_actions contain untransformed copies (${parts.join(', ')}) (0/2)`);
      }
    }

    return { score, notes };
  });
}

function scoreActionability(ctx: HandoffContext): CategoryScore {
  return scoreCategory('actionability', 15, () => {
    const s = ctx.sections;
    let score = 0;
    const notes: string[] = [];

    if (nonEmpty(s.strategic_next_actions)) {
      score += 7;
      notes.push('strategic_next_actions populated (+7)');
    } else {
      notes.push('strategic_next_actions empty (0/7)');
    }

    if (nonEmpty(s.operational_next_actions)) {
      score += 6;
      notes.push('operational_next_actions populated (+6)');
    } else {
      notes.push('operational_next_actions empty (0/6)');
    }

    if (nonEmpty(s.strategic_next_actions) && nonEmpty(s.operational_next_actions)) {
      score += 2;
      notes.push('both action sections populated — complete guidance (+2)');
    }

    return { score, notes };
  });
}

function scoreNoiseControl(ctx: HandoffContext): CategoryScore {
  return scoreCategory('noise_control', 10, () => {
    const s = ctx.sections;
    let score = 10;
    const notes: string[] = [];

    if (hasContent(s.relationship, IDENTITY_SIGNAL)) {
      score -= 4;
      notes.push('relationship contains identity-signal content — cross-contamination (-4)');
    } else {
      notes.push('relationship section clean: no identity signals (+4)');
    }

    if (hasContent(s.active_project, POLICY_SIGNAL)) {
      score -= 3;
      notes.push('active_project contains policy-signal content — cross-contamination (-3)');
    } else {
      notes.push('active_project section clean: no policy signals (+3)');
    }

    if (hasContent(s.strategic_next_actions, APPROVAL_SIGNAL)) {
      score -= 3;
      notes.push('strategic_next_actions contains approval tasks — belongs in operational (-3)');
    } else {
      notes.push('strategic_next_actions section clean: no approval tasks (+3)');
    }

    return { score, notes };
  });
}

/**
 * Consistency scorer — detects when handoff content is WRONG, not just incomplete.
 * Operates on the artifact only (no DB). For DB-authoritative checks see detectMismatches().
 *
 * Five sub-checks (deduct from starting score of 15):
 *   1. Strategic action verb conformance — untransformed decisions lack the verb prefix
 *   2. Operational roadmap contamination — phase/v1 language in immediate-task section
 *   3. Stale open loop (artifact) — loop topic covered by a non-deferred decision in the handoff
 *   4. Strategic contradicts deferred decision (artifact) — Pursue: action vs deferred decisions
 *   5. Relationship design-first vs impl-heavy strategic — design principle not reflected in plan
 */
function scoreConsistency(ctx: HandoffContext): CategoryScore {
  return scoreCategory('consistency', 15, () => {
    const s = ctx.sections;
    let score = 15;
    const notes: string[] = [];

    const strategic   = s.strategic_next_actions   ?? [];
    const operational = s.operational_next_actions  ?? [];
    const openLoops   = s.open_loops                ?? [];
    const decisions   = s.relevant_decisions        ?? [];

    // Sub-check 1: strategic action verb conformance
    const nonConforming = strategic.filter(item => !STRATEGIC_VERB.test(item.trim()));
    if (nonConforming.length > 0) {
      const deduction = Math.min(nonConforming.length * 2, 4);
      score -= deduction;
      notes.push(
        `${nonConforming.length} strategic action(s) lack recognized action verb ` +
        `(Pursue/Maintain/Prioritize/Proceed/Continue/…) — may be verbatim copies (-${deduction})`
      );
    } else if (strategic.length > 0) {
      notes.push('all strategic_next_actions start with recognized action verbs (no deduction)');
    }

    // Sub-check 2: operational roadmap contamination
    const misclassified = operational.filter(item => ROADMAP_SIGNAL.test(item));
    if (misclassified.length > 0) {
      const deduction = Math.min(misclassified.length * 2, 4);
      score -= deduction;
      notes.push(
        `${misclassified.length} operational action(s) contain roadmap/phase language ` +
        `— should be in strategic_next_actions (-${deduction})`
      );
    } else if (operational.length > 0) {
      notes.push('operational_next_actions contain no roadmap language (no deduction)');
    }

    // Sub-check 3: stale open loop (artifact-based, using the handoff's own decisions)
    let staleLoopCount = 0;
    for (const loop of openLoops) {
      const isStale = decisions.some(d => !DEFER_SIGNAL.test(d) && keywordsOverlap(loop, d));
      if (isStale) staleLoopCount++;
    }
    if (staleLoopCount > 0) {
      const deduction = Math.min(staleLoopCount * 3, 5);
      score -= deduction;
      notes.push(
        `${staleLoopCount} open loop(s) appear stale — a non-deferred decision ` +
        `covers the same topic but the loop was not cleared (-${deduction})`
      );
    } else if (openLoops.length > 0) {
      notes.push('open_loops are consistent with committed decisions (no deduction)');
    }

    // Sub-check 4: strategic contradicts deferred decision (artifact-based)
    let contradictionCount = 0;
    for (const action of strategic) {
      if (!/^Pursue:/i.test(action)) continue;
      const actionTopic = action.replace(/^Pursue:\s*/i, '');
      const contradicts = decisions.some(d => DEFER_SIGNAL.test(d) && keywordsOverlap(actionTopic, d));
      if (contradicts) contradictionCount++;
    }
    if (contradictionCount > 0) {
      const deduction = Math.min(contradictionCount * 5, 5);
      score -= deduction;
      notes.push(
        `${contradictionCount} "Pursue:" action(s) contradict a deferred decision ` +
        `— strategic direction conflicts with committed deferral (-${deduction})`
      );
    } else if (strategic.length > 0 && decisions.length > 0) {
      notes.push('no strategic actions contradict deferred decisions (no deduction)');
    }

    // Sub-check 5: relationship design-first principle vs implementation-heavy strategic actions
    // Detects when relationship declares "design before implementation" but every strategic
    // action is purely implementation work — the design step is missing from the plan.
    if (nonEmpty(s.relationship) && strategic.length > 0) {
      const relText = (s.relationship ?? []).join('\n');
      if (DESIGN_FIRST_SIGNAL.test(relText)) {
        const allImplHeavy = strategic.every(a => IMPL_VERB.test(a.trim()));
        if (allImplHeavy) {
          score -= 3;
          notes.push(
            'relationship signals design-first principle but all strategic actions are ' +
            'implementation-focused — no design or architecture work planned (-3)'
          );
        } else {
          notes.push('relationship design-first principle consistent with strategic actions (no deduction)');
        }
      }
    }

    if (score === 15) notes.unshift('no consistency issues detected (+15)');

    return { score, notes };
  });
}

function scoreHandoffReadiness(ctx: HandoffContext): CategoryScore {
  return scoreCategory('handoff_readiness', 5, () => {
    let score = 0;
    const notes: string[] = [];

    if (ctx.context_id && ctx.context_id.length > 0) {
      score += 2;
      notes.push('context_id present (+2)');
    } else {
      notes.push('context_id missing or empty (0/2)');
    }

    if (ctx.intent === 'handoff') {
      score += 2;
      notes.push('intent=handoff (+2)');
    } else {
      notes.push(`intent=${ctx.intent}, expected handoff (0/2)`);
    }

    if (ctx.token_budget.used > 0) {
      score += 1;
      notes.push('token_budget.used > 0 (+1)');
    } else {
      notes.push('token_budget.used = 0 — context appears empty (0/1)');
    }

    return { score, notes };
  });
}

/**
 * Relationship quality scorer — detects whether the relationship section conveys
 * meaningful collaboration specifics rather than generic boilerplate.
 *
 * Max 10 pts:
 *   +5  STYLE_SIGNAL: explicit collaboration norms (world-class, no flattery, strict review)
 *   +5  AUTHORITY_SIGNAL: decision-making roles clear (user sets direction, who reviews)
 *   +3  fallback: content exists but lacks specific signals (vague but not pure boilerplate)
 *    0  IDENTITY_SIGNAL: relationship contaminated with identity content
 *    0  REL_GENERIC: bare "Collaboration on X" with no elaboration
 */
function scoreRelationshipQuality(ctx: HandoffContext): CategoryScore {
  return scoreCategory('relationship_quality', 10, () => {
    const s = ctx.sections;
    let score = 0;
    const notes: string[] = [];

    if (!nonEmpty(s.relationship)) {
      notes.push('relationship section empty (0/10)');
      return { score, notes };
    }

    const relText = (s.relationship ?? []).join('\n');

    if (IDENTITY_SIGNAL.test(relText)) {
      notes.push('relationship contains identity-signal content — contaminated (0/10)');
      return { score, notes };
    }

    if (STYLE_SIGNAL.test(relText)) {
      score += 5;
      notes.push('collaboration style explicitly described (world-class, no flattery, etc.) (+5)');
    }

    if (AUTHORITY_SIGNAL.test(relText)) {
      score += 5;
      notes.push('decision authority clear (user sets direction, review roles) (+5)');
    }

    if (score === 0) {
      if (REL_GENERIC.test(relText)) {
        notes.push('relationship is generic boilerplate — no collaboration specifics (0/10)');
      } else {
        score = 3;
        notes.push('relationship has content but lacks explicit style/authority signals (+3)');
      }
    }

    return { score, notes };
  });
}

// ---------------------------------------------------------------------------
// Severity, fix hints, auto_fixable (v1.0)
// ---------------------------------------------------------------------------

/**
 * Per-type metadata for state mismatches: severity, fix_hint, auto_fixable.
 * auto_fixable=true means re-running rebuild-context-cache alone resolves the issue
 * because the underlying data is already correct in the DB.
 */
function mismatchMeta(type: MismatchType): Pick<StateMismatch, 'severity' | 'fix_hint' | 'auto_fixable'> {
  switch (type) {
    case 'missing_policy':
      return {
        severity: 'critical',
        fix_hint:
          'Re-run rebuild-context-cache — this committed policy was not assembled into global_policies. ' +
          'Check the scope-planner token budget and section priority order.',
        auto_fixable: true,
      };
    case 'missing_project_state':
      return {
        severity: 'critical',
        fix_hint:
          'Re-run rebuild-context-cache — this committed project_state was not assembled into active_project. ' +
          'Check token budget or increase the active_project section allocation.',
        auto_fixable: true,
      };
    case 'unresolved_proposal':
      return {
        severity: 'warning',
        fix_hint:
          'Approve this proposal (worker approve-proposal <id>) then run commit-approved. ' +
          'Until approved, the next session cannot see this pending work.',
        auto_fixable: false,
      };
    case 'stale_loop':
      return {
        severity: 'warning',
        fix_hint:
          'Remove this open_loop — a committed non-deferred decision covers the same topic. ' +
          'Update the handoff generator to clear resolved loops on context rebuild.',
        auto_fixable: false,
      };
    case 'strategic_contradiction':
      return {
        severity: 'critical',
        fix_hint:
          'Remove or reframe this "Pursue:" action — it contradicts a committed deferred decision. ' +
          'Either update the decision to reflect a direction change, or remove the conflicting strategic action.',
        auto_fixable: false,
      };
  }
}

/**
 * Builds rich FailureDetail records for every artifact-level issue detected by the
 * pure evaluator. Mirrors the conditions in deriveFailures() and appendConsistencyFailures()
 * exactly — both must be updated together when new failure conditions are added.
 */
function buildFailureDetails(
  ctx: HandoffContext,
  consistencyCat: CategoryScore,
): FailureDetail[] {
  const s = ctx.sections;
  const details: FailureDetail[] = [];

  if (!nonEmpty(s.active_project) || hasContent(s.active_project, FALLBACK_MSG)) {
    details.push({
      code: 'active_project_empty',
      message: 'active_project is empty or contains only the fallback message',
      severity: 'critical',
      fix_hint:
        'Commit project_state memories (propose → approve-proposal → commit-approved). ' +
        'Without committed project state the next session cannot understand the current work.',
      auto_fixable: false,
    });
  }
  if (!nonEmpty(s.relevant_decisions)) {
    details.push({
      code: 'decisions_empty',
      message: 'relevant_decisions is empty — no committed decisions captured',
      severity: 'critical',
      fix_hint:
        'Commit decision-type memories to drive both Relevant Decisions and Strategic Next Actions. ' +
        'Run: worker propose (memory_type=decision) → approve-proposal → commit-approved.',
      auto_fixable: false,
    });
  }
  if (!nonEmpty(s.strategic_next_actions)) {
    details.push({
      code: 'strategic_empty',
      message: 'strategic_next_actions is empty — strategic direction not surfaced',
      severity: 'critical',
      fix_hint:
        'Ensure committed decision memories exist at t3_committed or above — they are the source for strategic_next_actions. ' +
        'If decisions are already committed, re-run rebuild-context-cache.',
      auto_fixable: false,
    });
  }
  if (!nonEmpty(s.operational_next_actions)) {
    details.push({
      code: 'operational_empty',
      message: 'operational_next_actions is empty — next session has no immediate tasks',
      severity: 'warning',
      fix_hint:
        'Check for pending proposals: run worker approve-proposal + commit-approved. ' +
        'Approved proposals surface as operational_next_actions in the next rebuild.',
      auto_fixable: false,
    });
  }
  if (ctx.source_memories.length === 0) {
    details.push({
      code: 'source_memories_empty',
      message: 'source_memories is empty — no committed memories contributed to this context',
      severity: 'critical',
      fix_hint:
        'The entire handoff is speculative — no committed memories back it. ' +
        'Run worker approve-proposal then commit-approved to build the committed memory base before rebuilding context.',
      auto_fixable: false,
    });
  }
  if (hasContent(s.relationship, IDENTITY_SIGNAL)) {
    details.push({
      code: 'relationship_contaminated',
      message: 'relationship section contains identity content — section mapping contaminated',
      severity: 'warning',
      fix_hint:
        'Move identity content (who the user is, background, skills) from relationship to the identity section. ' +
        'The relationship section should describe collaboration style and authority only.',
      auto_fixable: false,
    });
  }
  if (hasContent(s.active_project, POLICY_SIGNAL)) {
    details.push({
      code: 'active_project_contaminated',
      message: 'active_project contains policy content — section mapping contaminated',
      severity: 'warning',
      fix_hint:
        'Move policy/rule content from active_project to global_policies. ' +
        'Ensure project_state memories describe work-in-progress status, not standing rules or standards.',
      auto_fixable: false,
    });
  }
  if (hasContent(s.strategic_next_actions, APPROVAL_SIGNAL)) {
    details.push({
      code: 'strategic_contaminated',
      message: 'strategic_next_actions contains approval tasks — these belong in operational_next_actions',
      severity: 'warning',
      fix_hint:
        'Move "Approve pending …" items from strategic_next_actions to operational_next_actions. ' +
        'Approval tasks are immediate operational steps, not strategic direction.',
      auto_fixable: false,
    });
  }

  // Consistency failure details — parse the same notes appendConsistencyFailures uses
  for (const note of consistencyCat.notes) {
    if (!note.includes('(-')) continue;

    if (note.includes('action verb')) {
      details.push({
        code: 'consistency_verb_violation',
        message: '[consistency] strategic_next_actions contain items without action verb prefix — likely untransformed decisions',
        severity: 'warning',
        fix_hint:
          'Prefix each strategic_next_action with a recognized action verb: ' +
          'Pursue / Maintain / Prioritize / Proceed / Continue / Enforce / Build / Focus / Advance / Complete / Establish / Deliver.',
        auto_fixable: false,
      });
    } else if (note.includes('roadmap')) {
      details.push({
        code: 'consistency_roadmap_contamination',
        message: '[consistency] operational_next_actions contain roadmap/phase language — misclassified strategic items',
        severity: 'warning',
        fix_hint:
          'Move items with v1 / A→B / roadmap / milestone / phase language from ' +
          'operational_next_actions to strategic_next_actions.',
        auto_fixable: false,
      });
    } else if (note.includes('stale')) {
      details.push({
        code: 'consistency_stale_loop',
        message: '[consistency] open_loops may be stale — non-deferred decisions cover the same topics',
        severity: 'warning',
        fix_hint:
          'Review open_loops and remove items whose underlying decision has been committed without a deferral. ' +
          'Re-run rebuild-context-cache after clearing resolved loops from the generator.',
        auto_fixable: false,
      });
    } else if (note.includes('contradict')) {
      details.push({
        code: 'consistency_contradiction',
        message: '[consistency] strategic_next_actions contradict committed deferred decisions — handoff direction is wrong',
        severity: 'critical',
        fix_hint:
          'Remove "Pursue:" actions that contradict deferred decisions in relevant_decisions. ' +
          'Either update the deferred decision to reflect a direction change, or remove the conflicting strategic action.',
        auto_fixable: false,
      });
    } else if (note.includes('design-first')) {
      details.push({
        code: 'consistency_design_first',
        message: '[consistency] relationship signals design-first principle but all strategic actions are implementation-focused — design step missing',
        severity: 'info',
        fix_hint:
          'Add at least one design or architecture action (e.g., "Establish: architecture review for X before coding starts") ' +
          'to strategic_next_actions to reflect the design-first collaboration principle.',
        auto_fixable: false,
      });
    }
  }

  return details;
}

// ---------------------------------------------------------------------------
// Failures + recommendations (artifact-level)
// ---------------------------------------------------------------------------

function deriveFailures(ctx: HandoffContext): { failures: string[]; recommendations: string[] } {
  const s = ctx.sections;
  const failures: string[] = [];
  const recommendations: string[] = [];

  if (!nonEmpty(s.active_project) || hasContent(s.active_project, FALLBACK_MSG)) {
    failures.push('active_project is empty or contains only the fallback message');
    recommendations.push('Commit project_state memories to populate Active Project');
  }
  if (!nonEmpty(s.relevant_decisions)) {
    failures.push('relevant_decisions is empty — no committed decisions captured');
    recommendations.push('Commit decision-type memories; they drive both Relevant Decisions and Strategic Next Actions');
  }
  if (!nonEmpty(s.strategic_next_actions)) {
    failures.push('strategic_next_actions is empty — strategic direction not surfaced');
    recommendations.push('Ensure committed decision memories exist at t3_committed or above');
  }
  if (!nonEmpty(s.operational_next_actions)) {
    failures.push('operational_next_actions is empty — next session has no immediate tasks');
    recommendations.push('Check for pending proposals: run worker approve-proposal + commit-approved');
  }
  if (ctx.source_memories.length === 0) {
    failures.push('source_memories is empty — no committed memories contributed to this context');
    recommendations.push('Run worker approve-proposal then commit-approved to build the committed memory base');
  }

  if (hasContent(s.relationship, IDENTITY_SIGNAL)) {
    failures.push('relationship section contains identity content — section mapping contaminated');
    recommendations.push('relationship should describe collaboration style; identity content belongs in the identity section');
  }
  if (hasContent(s.active_project, POLICY_SIGNAL)) {
    failures.push('active_project contains policy content — section mapping contaminated');
    recommendations.push('Ensure project_state memories describe project status, not policies or rules');
  }
  if (hasContent(s.strategic_next_actions, APPROVAL_SIGNAL)) {
    failures.push('strategic_next_actions contains approval tasks — these belong in operational_next_actions');
  }

  return { failures, recommendations };
}

function appendConsistencyFailures(
  consistencyCategory: CategoryScore,
  failures: string[],
  recommendations: string[]
): void {
  for (const note of consistencyCategory.notes) {
    if (!note.includes('(-')) continue;

    if (note.includes('action verb')) {
      failures.push('[consistency] strategic_next_actions contain items without action verb prefix — likely untransformed decisions');
      recommendations.push('Ensure all strategic_next_actions start with: Pursue / Maintain / Prioritize / Proceed / Continue / Enforce / …');
    } else if (note.includes('roadmap')) {
      failures.push('[consistency] operational_next_actions contain roadmap/phase language — misclassified strategic items');
      recommendations.push('Move items with v1 / A→B / roadmap / phase language from operational to strategic_next_actions');
    } else if (note.includes('stale')) {
      failures.push('[consistency] open_loops may be stale — non-deferred decisions cover the same topics');
      recommendations.push('Review open_loops and remove items whose underlying decision has been committed without a deferral');
    } else if (note.includes('contradict')) {
      failures.push('[consistency] strategic_next_actions contradict committed deferred decisions — handoff direction is wrong');
      recommendations.push('Do not pursue topics that relevant_decisions explicitly deferred to v1+; align strategic actions with committed decisions');
    } else if (note.includes('design-first')) {
      failures.push('[consistency] relationship signals design-first principle but all strategic actions are implementation-focused — design step missing');
      recommendations.push('Add at least one design or architecture action to strategic_next_actions to reflect the design-first collaboration principle');
    }
  }
}

// ---------------------------------------------------------------------------
// Main evaluator (pure, no DB)
// ---------------------------------------------------------------------------

export function evaluateHandoff(ctx: HandoffContext): HandoffEvalResult {
  const consistencyCat = scoreConsistency(ctx);

  const categories: CategoryScore[] = [
    scoreContinuityAccuracy(ctx),
    scoreStateFreshness(ctx),
    scoreDecisionPreservation(ctx),
    scoreActionability(ctx),
    scoreNoiseControl(ctx),
    consistencyCat,
    scoreHandoffReadiness(ctx),
    scoreRelationshipQuality(ctx),
  ];

  const scoreTotal = categories.reduce((sum, c) => sum + c.score, 0);
  const scoreMax   = categories.reduce((sum, c) => sum + c.max, 0);
  const pass = scoreTotal >= PASS_THRESHOLD;

  const { failures, recommendations } = deriveFailures(ctx);
  appendConsistencyFailures(consistencyCat, failures, recommendations);
  const failure_details = buildFailureDetails(ctx, consistencyCat);

  return {
    eval_id:        `eval_${randomUUID().replace(/-/g, '').substring(0, 12)}`,
    context_id:     ctx.context_id,
    evaluated_at:   new Date().toISOString(),
    score_total:    scoreTotal,
    score_max:      scoreMax,
    pass,
    pass_threshold: PASS_THRESHOLD,
    categories,
    failures,
    recommendations,
    failure_details,
  };
}

// ---------------------------------------------------------------------------
// Mismatch detection (state-aware, DB-authoritative)
// ---------------------------------------------------------------------------

/**
 * Compares DB topic fingerprints against handoff section fingerprints and emits
 * StateMismatch entries for each detected inconsistency.
 *
 * Rule: missing_policy
 *   A committed policy memory's fingerprint has NO overlap with global_policies.
 *   The policy exists in DB but was silently dropped from the handoff.
 *
 * Rule: missing_project_state
 *   A committed project_state memory's fingerprint has NO overlap with active_project.
 *   Current work state not reflected — next session starts with wrong picture.
 *
 * Rule: unresolved_proposal
 *   A pending/approved proposal's fingerprint has NO overlap with either
 *   operational_next_actions or open_loops. Pending work is invisible to next session.
 *
 * Rule: stale_loop (DB-authoritative) — expanded comparison set
 *   An open_loop item's fingerprint OVERLAPS with any committed active settled state:
 *   policy, project_state, procedure, or non-deferred decision. Deferred decisions
 *   are excluded — they are handled by strategic_contradiction instead.
 *   The loop should have been cleared when the covering memory was committed.
 *   Stronger than the artifact-only check because it tests against ALL committed state,
 *   not just what made it into relevant_decisions.
 *
 * Rule: strategic_contradiction (DB-authoritative)
 *   A "Pursue:" strategic action's topic OVERLAPS with a committed, deferred decision
 *   memory. The strategic section actively contradicts a committed deferral.
 *   Stronger than the artifact-only check for the same reason as above.
 */
function detectMismatches(
  memories: TopicRecord[],
  proposals: TopicRecord[],
  sectionFPs: Record<string, string[]>,
  ctx: HandoffContext
): StateMismatch[] {
  const mismatches: StateMismatch[] = [];
  const s = ctx.sections;

  for (const mem of memories) {
    // Rule: missing_policy
    if (mem.type === 'policy') {
      if (!fingerprintOverlap(mem.fingerprint, sectionFPs.global_policies)) {
        mismatches.push({
          mismatch_type:   'missing_policy',
          db_id:           mem.id,
          db_type:         mem.type,
          handoff_section: 'global_policies',
          detail:          `Committed policy not reflected in global_policies: "${mem.content_preview}"`,
          ...mismatchMeta('missing_policy'),
        });
      }
    }

    // Rule: missing_project_state
    if (mem.type === 'project_state') {
      if (!fingerprintOverlap(mem.fingerprint, sectionFPs.active_project)) {
        mismatches.push({
          mismatch_type:   'missing_project_state',
          db_id:           mem.id,
          db_type:         mem.type,
          handoff_section: 'active_project',
          detail:          `Committed project_state not reflected in active_project: "${mem.content_preview}"`,
          ...mismatchMeta('missing_project_state'),
        });
      }
    }

    // Rule: stale_loop (DB-authoritative) — expanded comparison set
    // A loop is stale if its topic overlaps with any committed settled state:
    // policy, project_state, procedure, or non-deferred decision.
    // Deferred decisions are excluded (they feed strategic_contradiction below).
    const isSettled =
      mem.type === 'policy' ||
      mem.type === 'project_state' ||
      mem.type === 'procedure' ||
      (mem.type === 'decision' && !mem.deferred);

    if (isSettled) {
      for (const loop of (s.open_loops ?? [])) {
        const loopFP = topicFingerprint(loop);
        if (fingerprintOverlap(loopFP, mem.fingerprint)) {
          mismatches.push({
            mismatch_type:   'stale_loop',
            db_id:           mem.id,
            db_type:         mem.type,
            handoff_section: 'open_loops',
            detail:          `Open loop appears stale — committed ${mem.type} covers same topic: "${loop.substring(0, 100)}"`,
            ...mismatchMeta('stale_loop'),
          });
        }
      }
    }

    // Rule: strategic_contradiction (DB-authoritative)
    // A "Pursue:" strategic action contradicts a committed deferred decision.
    if (mem.type === 'decision' && mem.deferred) {
      for (const action of (s.strategic_next_actions ?? [])) {
        if (!/^Pursue:/i.test(action)) continue;
        const actionTopic = action.replace(/^Pursue:\s*/i, '');
        if (fingerprintOverlap(topicFingerprint(actionTopic), mem.fingerprint)) {
          mismatches.push({
            mismatch_type:   'strategic_contradiction',
            db_id:           mem.id,
            db_type:         mem.type,
            handoff_section: 'strategic_next_actions',
            detail:          `"${action.substring(0, 100)}" contradicts a committed deferred decision: "${mem.content_preview}"`,
            ...mismatchMeta('strategic_contradiction'),
          });
        }
      }
    }
  }

  // Rule: unresolved_proposal
  const resolvedFP = [...sectionFPs.operational_next_actions, ...sectionFPs.open_loops];
  for (const prop of proposals) {
    if (!fingerprintOverlap(prop.fingerprint, resolvedFP)) {
      mismatches.push({
        mismatch_type:   'unresolved_proposal',
        db_id:           prop.id,
        db_type:         prop.type,
        handoff_section: 'operational_next_actions',
        detail:          `Pending ${prop.type} proposal not surfaced in operational_next_actions or open_loops: "${prop.content_preview}"`,
        ...mismatchMeta('unresolved_proposal'),
      });
    }
  }

  return mismatches;
}

// ---------------------------------------------------------------------------
// State-aware evaluator (reads DB, async)
// ---------------------------------------------------------------------------

/**
 * Extends evaluateHandoff() with live DB topic consistency checks.
 *
 * Two DB queries (read-only):
 *   1. Committed memories (policy, project_state, decision) for topic fingerprinting.
 *      Uses direct project_id column on memories — no session join needed.
 *   2. Pending/approved proposals for topic fingerprinting.
 *      Session-joined to scope by project_id.
 *
 * Both queries cap at 50 rows (local dev tool; expected DB sizes are small).
 *
 * The returned state_consistency block contains:
 *   proposal_topics_db  — TopicRecord[] from pending/approved proposals
 *   memory_topics_db    — TopicRecord[] from committed memories (policy/project_state/decision)
 *   handoff_topics      — per-section fingerprints extracted from the handoff artifact
 *   mismatches          — StateMismatch[] from detectMismatches()
 */
export async function evaluateHandoffWithState(
  db: Pool,
  ctx: HandoffContext
): Promise<HandoffEvalResultV2> {
  const base = evaluateHandoff(ctx);

  // Query 1: committed memories relevant to section content checks
  const memoriesRes = await db.query<{
    memory_id: string;
    memory_type: string;
    content: string;
    summary: string | null;
  }>(
    `SELECT memory_id, memory_type, content, summary
     FROM memories
     WHERE trust_level IN ('t3_committed', 't4_validated', 't5_canonical')
       AND status = 'active'
       AND project_id = $1
       AND memory_type IN ('policy', 'project_state', 'decision', 'procedure')
     ORDER BY importance_score DESC NULLS LAST
     LIMIT 50`,
    [ctx.project_id]
  );

  // Query 2: pending/approved proposals for topic matching
  const proposalsRes = await db.query<{
    proposal_id: string;
    memory_type: string;
    content: string;
    status: string;
  }>(
    `SELECT mp.proposal_id, mp.memory_type, mp.proposed_content AS content, mp.status
     FROM memory_proposals mp
     LEFT JOIN sessions s ON mp.session_id = s.session_id
     WHERE mp.status IN ('pending', 'approved')
       AND (s.project_id = $1 OR mp.session_id IS NULL)
     ORDER BY mp.created_at DESC
     LIMIT 50`,
    [ctx.project_id]
  );

  // Build TopicRecord arrays
  const memory_topics_db: TopicRecord[] = memoriesRes.rows.map(row => {
    const fullText = (row.content ?? '') + ' ' + (row.summary ?? '');
    const rec: TopicRecord = {
      id:              row.memory_id,
      type:            row.memory_type,
      fingerprint:     topicFingerprint(fullText),
      content_preview: (row.content ?? '').substring(0, 100),
    };
    if (row.memory_type === 'decision') {
      rec.deferred = DEFER_SIGNAL.test(row.content ?? '');
    }
    return rec;
  });

  const proposal_topics_db: TopicRecord[] = proposalsRes.rows.map(row => ({
    id:              row.proposal_id,
    type:            row.memory_type,
    fingerprint:     topicFingerprint(row.content ?? ''),
    content_preview: (row.content ?? '').substring(0, 100),
  }));

  // Build section fingerprints from the handoff artifact
  const s = ctx.sections;
  const sectionFPs = {
    global_policies:          sectionFingerprint(s.global_policies          ?? []),
    active_project:           sectionFingerprint(s.active_project           ?? []),
    relevant_decisions:       sectionFingerprint(s.relevant_decisions       ?? []),
    open_loops:               sectionFingerprint(s.open_loops               ?? []),
    operational_next_actions: sectionFingerprint(s.operational_next_actions ?? []),
  };

  const mismatches = detectMismatches(memory_topics_db, proposal_topics_db, sectionFPs, ctx);

  const state_consistency: HandoffStateConsistency = {
    proposal_topics_db,
    memory_topics_db,
    handoff_topics: {
      global_policies:          sectionFPs.global_policies,
      active_project:           sectionFPs.active_project,
      relevant_decisions:       sectionFPs.relevant_decisions,
      open_loops:               sectionFPs.open_loops,
      operational_next_actions: sectionFPs.operational_next_actions,
    },
    mismatches,
  };

  return { ...base, state_consistency };
}
