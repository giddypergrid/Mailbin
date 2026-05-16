import { processAttachments } from './attachment-processor.ts';
import { type GmailAttachmentMeta, type GmailMessageResponse, type GmailPart, type BuiltMailItem } from './types.ts';

export function parseFromHeader(fromValue: string): { name: string; email: string } {
  if (!fromValue) return { name: '', email: '' };
  const match = fromValue.match(/^(?:"?([^"]*)"?\s*)?<([^>]+)>$/);
  if (match) return { name: (match[1]?.trim() || ''), email: match[2].trim() };
  if (fromValue.includes('@')) return { name: '', email: fromValue.trim() };
  return { name: fromValue.trim(), email: '' };
}

const getHeader = (message: GmailMessageResponse, name: string): string => {
  return message.payload?.headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? '';
};

const collectAttachments = (parts: GmailPart[] | undefined): GmailAttachmentMeta[] => {
  if (!parts) return [];

  const results: GmailAttachmentMeta[] = [];

  for (const part of parts) {
    if (part.filename) {
      results.push({
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        sizeBytes: part.body?.size ?? 0,
        attachmentId: part.body?.attachmentId,
      });
    }

    if (part.parts) {
      results.push(...collectAttachments(part.parts));
    }
  }

  return results;
};

const formatDate = (value: string): string => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
};

export function buildMailItem(
  message: GmailMessageResponse,
  maxAttachmentKb: number,
): BuiltMailItem {
  const subject = getHeader(message, 'Subject') || '(No subject)';
  const dateHeader = getHeader(message, 'Date');
  const receivedAt = message.internalDate ? formatDate(message.internalDate) : formatDate(dateHeader);

  const rawAttachments = collectAttachments(message.payload?.parts);

  const attachmentResult = rawAttachments.length > 0
    ? processAttachments(rawAttachments, maxAttachmentKb)
    : null;

  return {
    id: `gmail-${message.id}`,
    bin: 'maybe',
    from: getHeader(message, 'From') || 'Unknown sender',
    subject,
    summary: message.snippet || subject,
    receivedAt,
    gmailUrl: `https://mail.google.com/mail/u/0/#inbox/${message.threadId}`,
    source: 'gmail',
    attachments: attachmentResult?.processed.map((att) => ({
      filename: att.filename,
      mimeType: att.mimeType,
      sizeBytes: att.sizeBytes,
      category: att.category,
    })),
    attachmentTotalKb: attachmentResult?.totalKb,
    attachmentWithinLimit: attachmentResult?.withinLimit,
    skippedAttachments: attachmentResult?.skippedAttachments.length,
    hasLargeAttachments: attachmentResult ? !attachmentResult.withinLimit : false,
  };
}
