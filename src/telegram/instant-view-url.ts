export interface InstantViewPhotoReference {
  pageUrl: string;
  photoId: string;
}

const TELEGRAM_PROTOCOL = 'telegram:';
const INSTANT_VIEW_HOST = 'instant-view';
const PHOTO_PATH_PREFIX = '/photo/';
const POSITIVE_DECIMAL = /^[1-9]\d*$/;

const requireHttpUrl = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Instant View page URL must use HTTP or HTTPS.');
  return url.toString();
};

export const formatInstantViewPhotoUrl = ({ pageUrl, photoId }: InstantViewPhotoReference): string => {
  if (!POSITIVE_DECIMAL.test(photoId))
    throw new Error('Instant View photo id must be a positive decimal integer.');

  const url = new URL(`${TELEGRAM_PROTOCOL}//${INSTANT_VIEW_HOST}${PHOTO_PATH_PREFIX}${photoId}`);
  url.searchParams.set('url', requireHttpUrl(pageUrl));
  return url.toString();
};

export const parseInstantViewPhotoUrl = (value: string): InstantViewPhotoReference | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.protocol !== TELEGRAM_PROTOCOL || url.hostname !== INSTANT_VIEW_HOST)
    return undefined;
  if (!url.pathname.startsWith(PHOTO_PATH_PREFIX)) return undefined;

  const photoId = url.pathname.slice(PHOTO_PATH_PREFIX.length);
  if (!POSITIVE_DECIMAL.test(photoId) || url.hash || [...url.searchParams.keys()].some(key => key !== 'url'))
    return undefined;

  const pageUrl = url.searchParams.get('url');
  if (!pageUrl) return undefined;

  try {
    return { pageUrl: requireHttpUrl(pageUrl), photoId };
  } catch {
    return undefined;
  }
};
