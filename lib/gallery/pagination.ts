export type GalleryPageState = {
  displayed: number;
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export function galleryPageState({ displayed, total, hasMore, nextCursor }: GalleryPageState) {
  const normalizedTotal = Math.max(0, total);
  const normalizedDisplayed = Math.min(Math.max(0, displayed), normalizedTotal);
  const canLoadMore = hasMore && Boolean(nextCursor) && normalizedDisplayed < normalizedTotal;

  return {
    displayed: normalizedDisplayed,
    total: normalizedTotal,
    remaining: Math.max(0, normalizedTotal - normalizedDisplayed),
    canLoadMore,
    reachedEnd: normalizedTotal > 0 && normalizedDisplayed >= normalizedTotal,
  };
}
