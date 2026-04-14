export interface StickerSetMetadata {
  stickerSetId?: string;
  stickerSetName?: string;
}

export const resolveStickerSetMetadata = async (
  metadata: StickerSetMetadata | undefined,
  resolvePackTitle: (setName: string) => Promise<string>,
): Promise<StickerSetMetadata> => {
  const stickerSetId = metadata?.stickerSetId ?? metadata?.stickerSetName;
  if (!stickerSetId) return {};

  return {
    stickerSetId,
    stickerSetName: await resolvePackTitle(stickerSetId),
  };
};

export const normalizeStickerSetMetadata = async <T extends StickerSetMetadata>(
  items: T[] | undefined,
  resolvePackTitle: (setName: string) => Promise<string>,
): Promise<boolean> => {
  if (!items || items.length === 0) return false;

  let changed = false;
  await Promise.all(items.map(async item => {
    const resolved = await resolveStickerSetMetadata(item, resolvePackTitle);
    if (!resolved.stickerSetId) return;

    if (item.stickerSetId !== resolved.stickerSetId || item.stickerSetName !== resolved.stickerSetName) {
      item.stickerSetId = resolved.stickerSetId;
      item.stickerSetName = resolved.stickerSetName;
      changed = true;
    }
  }));
  return changed;
};
