# Mailbin Test Data

This file documents the fake data used by the first prototype so it can be replaced cleanly later.

## Fake bins

- **Emergency**: urgent or critical messages.
- **Info**: codes, vouchers, tracking, accounts, confirmations.
- **Maybe**: low-priority or not-important messages.

## Fake mail items

| ID | Bin | From | Summary |
| --- | --- | --- | --- |
| `mail-001` | Emergency | University Admissions | University decision: accepted. Reply deadline: May 20. |
| `mail-002` | Emergency | Manager | Boss warning: client issue needs response before 3 PM. |
| `mail-003` | Info | GitHub | Login code from GitHub: 482193. |
| `mail-004` | Info | DHL | DHL tracking number: JD014600006789000000. |
| `mail-005` | Maybe | Store Newsletter | Promo sale email. No action needed. |
| `mail-006` | Maybe | Social App | Routine social recommendation. Safe to ignore. |

## Cleanup later

Replace `src/data/mail.ts` with data from backend endpoints when Gmail OAuth and database integration start.

Expected future endpoints:

- `GET /bins`
- `GET /bins/:bin`
- `GET /emails/:id`

For now, OAuth and database endpoints are intentionally paused.
