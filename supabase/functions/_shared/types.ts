export type AttachmentCategory = 'native' | 'convertible' | 'unsupported';

export type GmailAttachmentMeta = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  attachmentId?: string;
};

export type ProcessedAttachment = GmailAttachmentMeta & {
  category: AttachmentCategory;
  convertTo?: string;
  withinLimit: boolean;
};

export type GmailListResponse = {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
};

export type GmailMessageResponse = {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    parts?: GmailPart[];
    mimeType?: string;
    filename?: string;
    body?: { size?: number; attachmentId?: string };
  };
};

export type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  body?: { size?: number; attachmentId?: string };
  parts?: GmailPart[];
};

export type GmailConnection = {
  id: string;
  email: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  last_synced_at: string | null;
};

export type CoreMemoryRow = {
  custom_rules: string[];
  attachment_max_size_kb: number;
  send_attachments_to_ai: boolean;
};

export type ClassifiedEmail = {
  bin: 'emergency' | 'info' | 'maybe';
  summary: string;
  theme: string;
  fromWho: string;
  isCustomized: boolean;
};

export type GmailEmailRow = {
  id: string;
  user_id: string;
  gmail_message_id: string;
  thread_id: string;
  from_name: string;
  from_email: string;
  subject: string;
  summary: string;
  received_at: string | null;
  bin: string;
  ai_theme: string;
  ai_from_who: string;
  has_attachments: boolean;
  attachment_total_kb: number;
  is_customized: boolean;
  synced_at: string;
};

export type BuiltMailItem = {
  id: string;
  bin: string;
  from: string;
  subject: string;
  summary: string;
  aiSummary?: string;
  aiTheme?: string;
  aiFromWho?: string;
  receivedAt: string;
  gmailUrl: string;
  source: string;
  attachments?: Array<{ filename: string; mimeType: string; sizeBytes: number; category: string }>;
  attachmentTotalKb?: number;
  attachmentWithinLimit?: boolean;
  skippedAttachments?: number;
  isCustomized?: boolean;
  hasLargeAttachments?: boolean;
};
