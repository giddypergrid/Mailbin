export type BinId = 'emergency' | 'info' | 'maybe';

export type MailAttachment = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  category?: string;
};

export type MailItem = {
  id: string;
  bin: BinId;
  from: string;
  subject: string;
  summary: string;
  aiSummary?: string;
  aiTheme?: string;
  aiFromWho?: string;
  receivedAt: string;
  gmailUrl: string;
  attachments?: MailAttachment[];
  attachmentTotalKb?: number;
  attachmentWithinLimit?: boolean;
  skippedAttachments?: number;
  isCustomized?: boolean;
  hasLargeAttachments?: boolean;
};

export type BinConfig = {
  id: BinId;
  title: string;
  subtitle: string;
  image: string;
  sleepyImage: string;
  accent: string;
};

export type CoreMemory = {
  customRules: string[];
  attachmentMaxSizeKb: number;
  sendAttachmentsToAi: boolean;
};
