import type { Kind, Source } from '@cc-setup-agent/shared';
import type { RepoFacts } from './github.js';

/** One record as fetched from a source, ready for raw_source_records. */
export interface FetchedRecord {
  source: Source;
  externalId: string;
  payload: unknown;
  /** Repo facts known at fetch time, for star tracking. */
  repo?: RepoFacts | null;
}

/** Source-independent view of a record, used by dedupe and the intake filter. */
export interface CandidateDraft {
  name: string;
  description: string | null;
  /** Canonical URL; null when the record has no resolvable GitHub source. */
  sourceUrl: string | null;
  packageName: string | null;
  publisher: string | null;
  kind: Kind | null;
  repo: RepoFacts | null;
  folder?: { path: string; ref: string };
  registry?: { isLatest: boolean; namespace: string; hasRepoUrl: boolean };
}
