/**
 * The Phase 1 failure-triage evaluation corpus (spec §10, plan step 5). Every case is synthetic:
 * note shapes mirror what the dispatcher/reviewer/watcher writers emit (see shapes.ts), the log
 * text is invented or generic tool output, and no credential, proprietary log, or production task
 * id appears. Labels follow the category boundaries in spec §6 — what the evidence establishes —
 * not what the rules happen to return.
 */
import type { FailureTriageCategory } from '../../../../src/types.js';

/** One stored `failure/v1` note, as its writer passes it to buildFailureComment. */
export interface CorpusNote {
  source: 'dispatcher' | 'reviewer' | 'watcher';
  reason: string;
  detail: string;
  attempt?: number;
  maxAttempts?: number;
  body?: string;
}

/** Corpus coverage obligations from spec §10, checked by the corpus-shape test. */
export type CorpusTag =
  | 'ambiguous'            // the evidence does not establish a cause (or points two ways)
  | 'disguised-credential' // a credential failure that surfaces as a build/test/CI failure
  | 'bare-timeout'         // a timeout whose log shows nothing but supervisor/CLI boilerplate
  | 'max-attempts'         // a dispatcher final attempt followed by its log-less max_attempts note
  | 'truncated'            // evidence longer than the scan bound, or cut by the writer
  | 'prompt-like'          // log text that addresses a classifier
  | 'mixed'                // several causes appear; the boundary decides
  | 'missing-log';         // no usable evidence for the current event

export interface CorpusCase {
  id: string;
  /** Scenario family: variants of one incident share a family and never straddle the split. */
  family: string;
  label: FailureTriageCategory;
  /** One line: why this label, in terms of the spec §6 boundaries. */
  why: string;
  tags?: CorpusTag[];
  /** Oldest first; the last note is the current failure event. */
  notes: CorpusNote[];
  /** False when a result / ai-review / restart sits between the last two notes. Default true. */
  sameEpisode?: boolean;
}
