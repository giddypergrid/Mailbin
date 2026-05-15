import type { BinConfig, MailItem } from '../types';
import emergencyBin from '../../assets/bins/emergency.png';
import infoBin from '../../assets/bins/info-bin.png';
import maybeBin from '../../assets/bins/maybe-bin.png';

export const bins: BinConfig[] = [
  {
    id: 'emergency',
    title: 'Emergency',
    subtitle: 'Only mail you cannot miss.',
    image: emergencyBin,
    accent: '#d9483f',
  },
  {
    id: 'info',
    title: 'Info',
    subtitle: 'Codes, vouchers, tracking, accounts.',
    image: infoBin,
    accent: '#4f7f4c',
  },
  {
    id: 'maybe',
    title: 'Maybe',
    subtitle: 'Not important right now.',
    image: maybeBin,
    accent: '#b27a3c',
  },
];

export const mails: MailItem[] = [];

export function getBin(id: string | null) {
  return bins.find((bin) => bin.id === id);
}

export function getMailsForBin(id: string | null) {
  return mails.filter((mail) => mail.bin === id);
}
