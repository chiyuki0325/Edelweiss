import type { InstantViewPhotoReference } from '../../telegram/instant-view-url';
import { parseInstantViewPhotoUrl } from '../../telegram/instant-view-url';
import type { Attachment } from '../../telegram/message/types';
import type { PlatformAdapter } from '../types';

/** Shared file_id → Buffer logic used by download_file and read_image tools. */
export const createAttachmentDownloader = (deps: {
  chatId: string;
  loadMessageAttachments: (chatId: string, messageId: number) => Attachment[] | undefined;
  downloadFile: (fileId: string) => Promise<Buffer>;
  downloadMessageMedia?: (chatId: string, messageId: number) => Promise<Buffer | undefined>;
  downloadInstantViewPhoto?: (reference: InstantViewPhotoReference) => Promise<Buffer>;
  platformAdapter?: PlatformAdapter;
}): (fileId: string) => Promise<Buffer> =>
  async (fileId: string): Promise<Buffer> => {
    const instantViewPhoto = parseInstantViewPhotoUrl(fileId);
    if (instantViewPhoto) {
      if (!deps.downloadInstantViewPhoto)
        throw new Error('Instant View photo download is not available.');
      return await deps.downloadInstantViewPhoto(instantViewPhoto);
    }

    // OneBot path: file-id starts with "ob:" prefix — decode the base64-encoded fileRef
    // and download via the platform adapter.
    if (fileId.startsWith('ob:') && deps.platformAdapter) {
      const fileRef = Buffer.from(fileId.slice(3), 'base64').toString();
      return await deps.platformAdapter.downloadFile(fileRef, deps.chatId);
    }

    // Telegram path: file-id is "messageId:index"
    const colonIdx = fileId.lastIndexOf(':');
    if (colonIdx < 0) throw new Error('Invalid file_id format. Expected "messageId:index".');

    const messageId = parseInt(fileId.slice(0, colonIdx), 10);
    const attachmentIndex = parseInt(fileId.slice(colonIdx + 1), 10);
    if (isNaN(messageId) || isNaN(attachmentIndex) || attachmentIndex < 0)
      throw new Error('Invalid file_id: messageId or index is not a valid number.');

    const attachments = deps.loadMessageAttachments(deps.chatId, messageId);
    if (!attachments || attachments.length === 0)
      throw new Error(`No attachments found for message ${messageId}.`);
    if (attachmentIndex >= attachments.length)
      throw new Error(`Attachment index ${attachmentIndex} out of range (message has ${attachments.length} attachments).`);

    const att = attachments[attachmentIndex]!;

    let buffer: Buffer | undefined;
    if (att.fileId) {
      try { buffer = await deps.downloadFile(att.fileId); } catch { /* fall through to userbot */ }
    }
    if (!buffer && deps.downloadMessageMedia)
      buffer = await deps.downloadMessageMedia(deps.chatId, messageId);
    if (!buffer)
      throw new Error('Failed to download file from Telegram.');

    return buffer;
  };
