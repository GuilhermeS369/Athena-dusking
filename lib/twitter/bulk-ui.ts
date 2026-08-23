export function fillTwitterTextFieldsFromClipboard(
  current: string[],
  startIndex: number,
  clipboard: string,
) {
  const values = clipboard
    .replaceAll("\r", "")
    .split(/[\n\t]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length < 2) return null;
  return current.map((text, index) => {
    const sourceIndex = index - startIndex;
    return sourceIndex >= 0 && sourceIndex < values.length
      ? values[sourceIndex]
      : text;
  });
}

export function twitterFormatProgress(published: unknown, scheduled: unknown) {
  const safePublished = Math.max(0, Math.trunc(Number(published) || 0));
  const safeScheduled = Math.max(0, Math.trunc(Number(scheduled) || 0));
  const total = safePublished + safeScheduled;
  return {
    published: safePublished,
    scheduled: safeScheduled,
    total,
    progress: total ? Math.min(100, (safePublished / total) * 100) : 0,
  };
}

export type TwitterImageRotationAsset = { id: string };
export type TwitterImageRotationSet = {
  clientKey: string;
  mediaKind: "images" | "gif" | "video";
  assetIds: string[];
};

export function resolveTwitterImageRotationSets(
  originAssets: TwitterImageRotationAsset[],
  manualSets: TwitterImageRotationSet[],
) {
  if (manualSets.length > 0) return manualSets;
  return originAssets.map((asset) => ({
    clientKey: `origin:images:${asset.id}`,
    mediaKind: "images" as const,
    assetIds: [asset.id],
  }));
}
