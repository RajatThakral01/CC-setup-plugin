import type { Source } from '@cc-setup-agent/shared';
import { normalizeGithubRepo } from '../sources/github-search.js';
import { normalizeMarketplace, type MarketplacePayload } from '../sources/marketplace.js';
import { normalizeRegistry, type RegistryPayload } from '../sources/registry.js';
import type { CandidateDraft } from '../sources/types.js';

/**
 * Turns a stored raw record into a draft. Returns null for records that are not catalog entities
 * on their own (npm packuments behind seed items, change notes).
 */
export function normalizeRecord(source: Source, payload: unknown): CandidateDraft | null {
  switch (source) {
    case 'github_repo':
      return normalizeGithubRepo(payload);
    case 'mcp_registry':
      return normalizeRegistry(payload as RegistryPayload);
    case 'marketplace':
      return normalizeMarketplace(payload as MarketplacePayload);
    default:
      return null;
  }
}
