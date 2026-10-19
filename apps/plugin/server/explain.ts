import type { Snapshot } from '@cc-setup-agent/shared';
import { PluginError } from './files.js';

/** Full catalog entry plus alternatives in the same category (UC-03). Accepts an id or a name. */
export function explainItem(snapshot: Snapshot, idOrName: string) {
  const key = idOrName.trim().toLowerCase();
  const item =
    snapshot.items.find((i) => i.id === key) ??
    snapshot.items.find((i) => i.name.toLowerCase() === key);
  if (!item)
    throw new PluginError(
      `"${idOrName}" is not in the catalog (only reviewed items are; candidates are not).`,
    );
  const alternatives = snapshot.items
    .filter(
      (i) =>
        i.id !== item.id &&
        item.category !== null &&
        i.category === item.category &&
        i.status !== 'blocked',
    )
    .map((i) => ({ id: i.id, name: i.name, status: i.status, confidence: i.scorecard.confidence }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { item, alternatives };
}
