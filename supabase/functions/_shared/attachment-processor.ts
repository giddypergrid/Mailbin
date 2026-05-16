import { type AttachmentCategory, type GmailAttachmentMeta, type ProcessedAttachment } from './types.ts';

type FileTypeRule = {
  category: AttachmentCategory;
  convertTo?: string;
};

const FILE_TYPE_MAP: Record<string, FileTypeRule> = {
  'application/pdf': { category: 'native' },
  'image/png': { category: 'native' },
  'image/jpeg': { category: 'native' },
  'image/jpg': { category: 'native' },
  'image/webp': { category: 'native' },
  'text/plain': { category: 'native' },
  'text/csv': { category: 'native' },
  'text/html': { category: 'native' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { category: 'convertible', convertTo: 'text/csv' },
  'application/vnd.ms-excel': { category: 'convertible', convertTo: 'text/csv' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { category: 'convertible', convertTo: 'text/plain' },
  'application/msword': { category: 'convertible', convertTo: 'text/plain' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { category: 'convertible', convertTo: 'text/plain' },
  'application/zip': { category: 'convertible', convertTo: 'text/plain' },
  'application/x-zip-compressed': { category: 'convertible', convertTo: 'text/plain' },
};

const EXTENSION_MAP: Record<string, FileTypeRule> = {
  '.pdf': { category: 'native' },
  '.png': { category: 'native' },
  '.jpg': { category: 'native' },
  '.jpeg': { category: 'native' },
  '.webp': { category: 'native' },
  '.txt': { category: 'native' },
  '.csv': { category: 'native' },
  '.html': { category: 'native' },
  '.htm': { category: 'native' },
  '.xlsx': { category: 'convertible', convertTo: 'text/csv' },
  '.xls': { category: 'convertible', convertTo: 'text/csv' },
  '.docx': { category: 'convertible', convertTo: 'text/plain' },
  '.doc': { category: 'convertible', convertTo: 'text/plain' },
  '.pptx': { category: 'convertible', convertTo: 'text/plain' },
  '.zip': { category: 'convertible', convertTo: 'text/plain' },
};

function extension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

export function categorizeAttachment(attachment: GmailAttachmentMeta): AttachmentCategory {
  const byMime = FILE_TYPE_MAP[attachment.mimeType];
  if (byMime) return byMime.category;

  const ext = extension(attachment.filename);
  const byExt = EXTENSION_MAP[ext];
  if (byExt) return byExt.category;

  return 'unsupported';
}

export function getConversionTarget(attachment: GmailAttachmentMeta): string | undefined {
  const byMime = FILE_TYPE_MAP[attachment.mimeType];
  if (byMime?.convertTo) return byMime.convertTo;

  const ext = extension(attachment.filename);
  const byExt = EXTENSION_MAP[ext];
  return byExt?.convertTo;
}

export function processAttachments(
  attachments: GmailAttachmentMeta[],
  maxTotalKb: number,
): {
  processed: ProcessedAttachment[];
  totalKb: number;
  withinLimit: boolean;
  nativeAttachments: ProcessedAttachment[];
  convertibleAttachments: ProcessedAttachment[];
  skippedAttachments: ProcessedAttachment[];
} {
  const processed: ProcessedAttachment[] = attachments.map((att) => {
    const category = categorizeAttachment(att);
    return {
      ...att,
      category,
      convertTo: category === 'convertible' ? (getConversionTarget(att) ?? 'text/plain') : undefined,
      withinLimit: true,
    };
  });

  const totalKb = processed.reduce((sum, att) => sum + att.sizeBytes, 0) / 1024;
  const withinLimit = totalKb <= maxTotalKb;

  const nativeAttachments = processed.filter((att) => att.category === 'native');
  const convertibleAttachments = processed.filter((att) => att.category === 'convertible');
  const skippedAttachments = processed.filter(
    (att) => att.category === 'unsupported' || (withinLimit === false && att.category !== 'native'),
  );

  return {
    processed,
    totalKb: Math.round(totalKb * 100) / 100,
    withinLimit,
    nativeAttachments,
    convertibleAttachments,
    skippedAttachments,
  };
}
