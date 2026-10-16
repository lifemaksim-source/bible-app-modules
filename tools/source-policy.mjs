/** A deferred source is kept for later work, but neither built nor published. */
export const unpublished = source => Boolean(source.draft || source.deferred);

export function assertNumberingForPublication(source) {
  if (!unpublished(source) && source.numberingReview === 'custom-map-required') {
    throw new Error(`${source.id}: требуется отдельная таблица соответствий стихов; ${source.numbering} — только основа сравнения. См. docs/numbering-review.md`);
  }
}
