// OneBot 11 protocol types (array message format).
// Reference: https://github.com/botuniverse/onebot-11

// --- Face config entry (from face_config.json) ---

export interface FaceEntry {
  QSid: string;
  QDes: string;
  IQLid: string;
  AQLid: string;
  EMCode: string;
  QHide?: string;
  AniStickerType?: number;
  AniStickerId?: string;
  AniStickerPackId?: string;
  AniStickerPackName?: string;
}

export interface FaceConfigFile {
  sysface: FaceEntry[];
}

// --- Message segments ---

export interface OneBotTextSegment {
  type: 'text';
  data: { text: string };
}

export interface OneBotFaceSegment {
  type: 'face';
  data: { id: string };
}

export interface OneBotImageSegment {
  type: 'image';
  data: {
    file: string;
    url?: string;
    type?: string;
    summary?: string;
    emoji_id?: string;
    emoji_pack_id?: string;
  };
}

export interface OneBotAtSegment {
  type: 'at';
  data: { qq: string; name?: string };
}

export interface OneBotReplySegment {
  type: 'reply';
  data: { id: string };
}

export interface OneBotRecordSegment {
  type: 'record';
  data: { file: string; url?: string };
}

export interface OneBotVideoSegment {
  type: 'video';
  data: { file: string; url?: string };
}

export interface OneBotFileSegment {
  type: 'file';
  data: { file: string; file_id: string; url?: string };
}

export interface OneBotJsonSegment {
  type: 'json';
  data: { data: string };
}

export type OneBotMessageSegment =
  | OneBotTextSegment
  | OneBotFaceSegment
  | OneBotImageSegment
  | OneBotAtSegment
  | OneBotReplySegment
  | OneBotRecordSegment
  | OneBotVideoSegment
  | OneBotFileSegment
  | OneBotJsonSegment;

// --- Sender ---

export interface OneBotSender {
  user_id: number;
  nickname: string;
  card?: string;
  role?: string;
}

// --- Events ---

export interface OneBotMessageEvent {
  post_type: 'message';
  message_type: 'private' | 'group';
  time: number;
  self_id: number;
  user_id: number;
  group_id?: number;
  message_id: number;
  message: OneBotMessageSegment[];
  raw_message: string;
  sender: OneBotSender;
}

export interface OneBotNoticeEvent {
  post_type: 'notice';
  notice_type: string;
  time: number;
  self_id: number;
  group_id?: number;
  user_id?: number;
  operator_id?: number;
  message_id?: number;
}

export interface OneBotMetaEvent {
  post_type: 'meta_event';
  meta_event_type: 'lifecycle' | 'heartbeat';
  sub_type?: string;
  time: number;
  self_id: number;
}

export type OneBotEvent = OneBotMessageEvent | OneBotNoticeEvent | OneBotMetaEvent;

// --- API ---

export interface OneBotApiRequest {
  action: string;
  params: Record<string, unknown>;
  echo?: string;
}

export interface OneBotApiResponse<T = unknown> {
  status: 'ok' | 'failed';
  retcode: number;
  data: T;
  echo?: string;
}

export interface OneBotSendMessageParams {
  message_type: 'private' | 'group';
  user_id?: number;
  group_id?: number;
  message: OneBotMessageSegment[];
}

export interface OneBotSendMessageResult {
  message_id: number;
}

export interface OneBotGetFileResult {
  file?: string;
  url?: string;
  file_size?: string;  // 实则上是数字，但协议里是字符串
  file_name?: string;
  base64?: string;
}

// --- Config ---

export interface OneBotConfig {
  enabled: boolean;
  host: string;
  port: number;
  accessToken: string;
}
