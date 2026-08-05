import { Api, type TelegramClient } from 'telegram';

import type { InstantViewPhotoReference } from './instant-view-url';

const EMPTY_RETRY_DELAY_MS = 500;

export interface InstantViewPage {
  title?: string;
  page: Api.Page;
}

type InstantViewClient = Pick<TelegramClient, 'invoke' | 'downloadMedia'>;

const sleep = async (milliseconds: number): Promise<void> =>
  await new Promise(resolve => setTimeout(resolve, milliseconds));

const unwrapInstantView = (result: Api.messages.WebPage): InstantViewPage | undefined => {
  const webpage = result.webpage;
  if (!(webpage instanceof Api.WebPage) || !webpage.cachedPage) return undefined;
  return {
    page: webpage.cachedPage,
    ...(webpage.title ? { title: webpage.title } : {}),
  };
};

export const fetchInstantViewPage = async (
  client: InstantViewClient,
  url: string,
  retryDelayMs = EMPTY_RETRY_DELAY_MS,
): Promise<InstantViewPage | undefined> => {
  const first = await client.invoke(new Api.messages.GetWebPage({ url, hash: 0 }));
  const ready = unwrapInstantView(first);
  if (ready) return ready;

  if (!(first.webpage instanceof Api.WebPageEmpty) && !(first.webpage instanceof Api.WebPagePending))
    return undefined;

  await sleep(retryDelayMs);
  return unwrapInstantView(await client.invoke(new Api.messages.GetWebPage({ url, hash: 0 })));
};

export const downloadInstantViewPhoto = async (
  client: InstantViewClient,
  reference: InstantViewPhotoReference,
): Promise<Buffer> => {
  const instantView = await fetchInstantViewPage(client, reference.pageUrl);
  if (!instantView) throw new Error('Instant View is no longer available for this URL.');

  const photo = instantView.page.photos.find((candidate): candidate is Api.Photo =>
    candidate instanceof Api.Photo && candidate.id.toString() === reference.photoId);
  if (!photo) throw new Error(`Instant View photo ${reference.photoId} was not found.`);

  // GramJS handles Api.Photo at runtime, but its public declaration only accepts
  // message media. Wrap the photo to keep this call on the typed public surface.
  const result = await client.downloadMedia(new Api.MessageMediaPhoto({ photo }), {});
  if (!Buffer.isBuffer(result) || result.length === 0)
    throw new Error(`Failed to download Instant View photo ${reference.photoId}.`);
  return result;
};
