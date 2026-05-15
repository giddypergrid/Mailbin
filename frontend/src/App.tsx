import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { bins, getBin, getMailsForBin } from './data/mail';
import type { BinId, MailItem, CoreMemory } from './types';
import { supabase } from './supabase';
import { log, logWeird } from './logger';
import { Dropdown } from './Dropdown';
import { Settings, X } from 'lucide-react';

const binSpeech: Record<BinId, string> = {
  emergency: 'I only eat panic mail.',
  info: 'Tiny useful things go here.',
  maybe: 'Meh. I will hold the boring stuff.',
};

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabaseFunctionsUrl = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL;

async function getAuthHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

function getRouteBin(): BinId | null {
  const match = window.location.hash.match(/^#\/bin\/(emergency|info|maybe)$/);
  return match ? (match[1] as BinId) : null;
}

function navigateToBin(id: BinId) {
  window.location.hash = `/bin/${id}`;
}

function navigateHome() {
  window.location.hash = '/';
}

export function App() {
  const [selectedBin, setSelectedBin] = useState<BinId | null>(getRouteBin());
  const [pressedBin, setPressedBin] = useState<BinId | null>(null);
  const [dismissedMailIds, setDismissedMailIds] = useState<string[]>([]);
  const [dismissingMailId, setDismissingMailId] = useState<string | null>(null);
  const [supabaseStatus, setSupabaseStatus] = useState<'missing' | 'checking' | 'ready' | 'error'>('checking');
  const [gmailStatus, setGmailStatus] = useState<string | null>(null);
  const [isGmailConnected, setIsGmailConnected] = useState(false);
  const [gmailMails, setGmailMails] = useState<MailItem[]>([]);
  const [gmailMailStatus, setGmailMailStatus] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle');
  const [isConnectingGmail, setIsConnectingGmail] = useState(false);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [rateLimitNotice, setRateLimitNotice] = useState<string | null>(null);
  const [coreMemory, setCoreMemory] = useState<CoreMemory | null>(null);
  const [showPreferences, setShowPreferences] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);

  useEffect(() => {
    const onHashChange = () => {
      setPressedBin(null);
      setDismissedMailIds([]);
      setDismissingMailId(null);
      setSelectedBin(getRouteBin());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (!supabaseUrl || !supabaseAnonKey || !supabaseFunctionsUrl) {
      setSupabaseStatus('missing');
      return;
    }

    const controller = new AbortController();

    fetch(`${supabaseUrl}/auth/v1/settings`, {
      headers: {
        apikey: supabaseAnonKey,
      },
      signal: controller.signal,
    })
      .then((response) => {
        setSupabaseStatus(response.ok ? 'ready' : 'error');
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setSupabaseStatus('error');
        }
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmail = params.get('gmail');
    const reason = params.get('reason');

    const allParams = [...params.entries()];
    const nonGmailParams = allParams.filter(([k]) => k !== 'gmail' && k !== 'reason' && k !== 'accessToken' && k !== 'refreshToken');
    if (nonGmailParams.length > 0) {
      logWeird('OAuth callback has unexpected query params', Object.fromEntries(nonGmailParams));
    }

    if (gmail === 'connected') {
      const accessToken = params.get('accessToken');
      const refreshToken = params.get('refreshToken');

      if (accessToken && !refreshToken) {
        logWeird('Has accessToken but missing refreshToken', {});
      }
      if (!accessToken && refreshToken) {
        logWeird('Has refreshToken but missing accessToken', {});
      }

      if (accessToken && refreshToken) {
        log('Setting Supabase session from OAuth callback');
        supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        }).then(({ error }) => {
          if (error) {
            setGmailStatus(`Session failed: ${error.message}`);
          } else {
            setGmailStatus('Gmail connected');
            setIsGmailConnected(true);
            loadCoreMemory();
          }
          window.history.replaceState({}, '', window.location.pathname + window.location.hash);
        });
      }
      return;
    }

    if (gmail === 'error') {
      setGmailStatus(`Gmail connect failed: ${reason ?? 'unknown_error'}`);
      window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    }
  }, []);

  useEffect(() => {
    log(`Checking connection status (supabaseFunctionsUrl: ${!!supabaseFunctionsUrl})`);
    if (!supabaseFunctionsUrl) {
      return;
    }

    const controller = new AbortController();

    (async () => {
      const response = await fetch(`${supabaseFunctionsUrl}/gmail-connection-status`, {
        headers: await getAuthHeaders(),
        signal: controller.signal,
      });
      const data = await response.json() as { connected?: boolean };

      if (response.ok && data.connected) {
        setIsGmailConnected(true);
        setGmailStatus('Gmail connected');
        loadCoreMemory();
      }
    })().catch((error) => {
      if (!controller.signal.aborted) {
        logWeird('Connection status check failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return () => controller.abort();
  }, []);

  const gmailFetch = useCallback(async (pageToken?: string) => {
    if (!supabaseFunctionsUrl) return;

    const isInitial = !pageToken;
    if (isInitial) {
      setGmailMailStatus('loading');
    } else {
      setIsLoadingMore(true);
    }

    const controller = new AbortController();

    try {
      const url = new URL(`${supabaseFunctionsUrl}/gmail-mails`);
      url.searchParams.set('limit', '10');
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const response = await fetch(url, {
        headers: await getAuthHeaders(),
        signal: controller.signal,
      });
      const data = await response.json() as {
        messages?: MailItem[];
        status?: string;
        reason?: string;
        nextPageToken?: string | null;
        rateLimited?: boolean;
      };

      if (!response.ok || data.status === 'error') {
        throw new Error(data.reason ?? 'Gmail fetch failed');
      }

      if (data.rateLimited) {
        setRateLimitNotice('Gmail limit reached — please revisit later. Some emails may be missing.');
      }

      const messages = data.messages ?? [];
      setGmailMails((prev) => isInitial ? messages : [...prev, ...messages]);
      setNextPageToken(data.nextPageToken ?? null);

      if (isInitial) {
        setGmailMailStatus(messages.length > 0 ? 'ready' : 'empty');
      }
    } catch (error) {
      if (!isInitial) {
        logWeird('Gmail load more failed', { error: error instanceof Error ? error.message : String(error) });
      } else {
        logWeird('Gmail mails fetch failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        setGmailMails([]);
        setGmailMailStatus('error');
      }
    } finally {
      if (!isInitial) setIsLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (selectedBin !== 'emergency' || !supabaseFunctionsUrl) return;
    setGmailMails([]);
    setNextPageToken(null);
    setRateLimitNotice(null);
    gmailFetch();
  }, [selectedBin, gmailFetch]);

  const loadMoreGmail = useCallback(() => {
    if (!nextPageToken || isLoadingMore || gmailMailStatus !== 'ready') return;
    gmailFetch(nextPageToken);
  }, [nextPageToken, isLoadingMore, gmailMailStatus, gmailFetch]);

  const loadCoreMemory = useCallback(async () => {
    if (!supabaseFunctionsUrl) return;

    try {
      const response = await fetch(`${supabaseFunctionsUrl}/core-memory`, {
        headers: await getAuthHeaders(),
      });

      if (response.ok) {
        const data = await response.json() as CoreMemory;
        setCoreMemory(data);
      }
    } catch {
      // silently skip — preferences load on next app open
    }
  }, []);

  const saveCoreMemory = useCallback(async (updated: CoreMemory) => {
    if (!supabaseFunctionsUrl) return;

    setSavingPreferences(true);
    setPreferencesError(null);

    try {
      const response = await fetch(`${supabaseFunctionsUrl}/core-memory`, {
        method: 'PUT',
        headers: { ...(await getAuthHeaders()), 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });

      if (response.ok) {
        setCoreMemory(updated);
        setShowPreferences(false);
      } else {
        setPreferencesError('Failed to save. Try again.');
      }
    } catch {
      setPreferencesError('Network error. Check connection.');
    } finally {
      setSavingPreferences(false);
    }
  }, []);

  const mailListRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = mailListRef.current;
    if (!el) return;

    const onScroll = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) {
        loadMoreGmail();
      }
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [loadMoreGmail]);

  const activeBin = getBin(selectedBin);
  const sourceMails = isGmailConnected && gmailMails.length > 0 ? gmailMails.filter((mail) => mail.bin === selectedBin) : getMailsForBin(selectedBin);
  const activeMails = sourceMails.filter((mail) => !dismissedMailIds.includes(mail.id));
  const supabaseStatusText = {
    missing: 'Fill .env',
    checking: 'Checking Supabase...',
    ready: 'Supabase connected',
    error: 'Supabase check failed',
  }[supabaseStatus];

  function handleBinClick(id: BinId) {
    setPressedBin(id);
    window.setTimeout(() => navigateToBin(id), 220);
  }

  function handleConnectGmail() {
    if (isGmailConnected) {
      navigateToBin('emergency');
      return;
    }

    if (isConnectingGmail) {
      return;
    }

    if (!supabaseFunctionsUrl) {
      window.alert('Add VITE_SUPABASE_FUNCTIONS_URL to .env first.');
      return;
    }

    setIsConnectingGmail(true);
    window.location.href = `${supabaseFunctionsUrl}/gmail-oauth-start`;
  }

  function handleMailClick(id: string) {
    if (dismissingMailId) {
      return;
    }

    setDismissingMailId(id);
    window.setTimeout(() => {
      setDismissedMailIds((current) => [...current, id]);
      setDismissingMailId(null);
    }, 260);
  }

  const preferencesPanel = showPreferences ? (
    <div className="preferences-overlay" onClick={() => setShowPreferences(false)}>
      <div className="preferences-panel" onClick={(e) => e.stopPropagation()}>
        <div className="preferences-header">
          <h2>Core Memory</h2>
          <button className="preferences-close" onClick={() => setShowPreferences(false)} type="button">
            <X size={18} />
          </button>
        </div>
        <form
          className="preferences-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!coreMemory) return;
            saveCoreMemory(coreMemory);
          }}
        >
          <label className="preferences-label">
            Classification rules
            <textarea
              className="preferences-textarea"
              rows={5}
              placeholder="Describe what goes where — e.g. promos from shops → maybe, bank statements → emergency"
              value={coreMemory?.memoryText ?? ''}
              onChange={(e) => setCoreMemory((prev) => prev ? { ...prev, memoryText: e.target.value } : null)}
            />
          </label>
          <label className="preferences-label">
            Summary word limit
            <input
              type="number"
              className="preferences-input"
              min={1}
              max={100}
              value={coreMemory?.summaryMaxWords ?? 10}
              onChange={(e) => setCoreMemory((prev) => prev ? { ...prev, summaryMaxWords: Number(e.target.value) } : null)}
            />
          </label>
          <label className="preferences-label">
            Attachment size limit (KB) — total across all files. Emails over this get marked important
            <input
              type="number"
              className="preferences-input"
              min={1}
              max={10000}
              value={coreMemory?.attachmentMaxSizeKb ?? 100}
              onChange={(e) => setCoreMemory((prev) => prev ? { ...prev, attachmentMaxSizeKb: Number(e.target.value) } : null)}
            />
          </label>
          <label className="preferences-label preferences-toggle">
            <input
              type="checkbox"
              checked={coreMemory?.sendAttachmentsToAi ?? false}
              onChange={(e) => setCoreMemory((prev) => prev ? { ...prev, sendAttachmentsToAi: e.target.checked } : null)}
            />
            Send attachments to AI
          </label>
          {preferencesError ? <p className="preferences-error">{preferencesError}</p> : null}
          <button className="preferences-save" type="submit" disabled={savingPreferences}>
            {savingPreferences ? 'Saving...' : 'Save'}
          </button>
        </form>
      </div>
    </div>
  ) : null;

  if (activeBin) {
    return (
      <>
        {preferencesPanel}
        <main className="app-shell folder-shell">
          <button className="back-button" onClick={navigateHome} type="button">
            ← Back to bins
          </button>

          <section className="folder-hero">
            <img className="folder-bin-image" src={activeBin.image} alt={`${activeBin.title} bin`} />
            <div className="speech-bubble" style={{ '--accent': activeBin.accent } as CSSProperties}>
              {binSpeech[activeBin.id]}
            </div>
          </section>

          <section className="mail-list" aria-label={`${activeBin.title} mail list`} ref={mailListRef}>
            {selectedBin === 'emergency' && rateLimitNotice ? (
              <Dropdown label="Rate limit notice">
                <p className="dropdown-rate-message">{rateLimitNotice}</p>
              </Dropdown>
            ) : null}
            {selectedBin === 'emergency' && gmailMailStatus === 'loading' ? (
              <p className="mail-list-status">Loading Gmail...</p>
            ) : null}
            {selectedBin === 'emergency' && gmailMailStatus === 'empty' ? (
              <p className="mail-list-status">No Gmail messages loaded yet.</p>
            ) : null}
            {selectedBin === 'emergency' && gmailMailStatus === 'error' ? (
              <p className="mail-list-status is-error">Could not load Gmail messages.</p>
            ) : null}
            {activeMails.map((mail) => (
              <button
                className={`mail-card${dismissingMailId === mail.id ? ' is-dismissing' : ''}`}
                key={mail.id}
                onClick={() => handleMailClick(mail.id)}
                type="button"
              >
              <div>
                <div className="mail-card-header">
                  <span className="mail-theme">{mail.aiTheme || mail.subject}</span>
                  {mail.aiFromWho ? <span className="mail-from-who">{mail.aiFromWho}</span> : null}
                </div>
                <p className="mail-summary">{mail.aiSummary || mail.summary}</p>
                {mail.attachments && mail.attachments.length > 0 ? (
                    <div className="mail-attachments">
                      {mail.attachments.map((att) => (
                        <span key={att.filename} className={`mail-attachment-tag is-${att.category ?? 'native'}`}>
                          {att.filename} ({(att.sizeBytes / 1024).toFixed(0)} KB{att.category !== 'native' ? ` · ${att.category}` : ''})
                        </span>
                      ))}
                      {mail.skippedAttachments ? (
                        <span className="mail-attachment-tag is-skipped">
                          +{mail.skippedAttachments} unsupported
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <span>Done →</span>
              </button>
            ))}
            {selectedBin === 'emergency' && isLoadingMore ? (
              <p className="mail-list-status">Loading more...</p>
            ) : null}
          </section>
        </main>
      </>
    );
  }

  return (
    <>
      {preferencesPanel}
      <main className="app-shell home-shell">
        <button className="settings-button" type="button" aria-label="Settings">
          <Settings size={20} />
        </button>

        {isGmailConnected ? (
          <button className="edit-preferences-button" onClick={() => setShowPreferences(true)} type="button">
            Edit preferences
          </button>
        ) : null}

        <button className="connect-gmail-button" onClick={handleConnectGmail} type="button">
          {isGmailConnected ? 'Open Gmail bin' : 'Connect Gmail'}
        </button>

        <div className={`supabase-status is-${supabaseStatus}`}>
          {supabaseStatusText}
        </div>

        {gmailStatus ? (
          <div className={`gmail-status ${gmailStatus.includes('failed') ? 'is-error' : 'is-ready'}`}>
            {gmailStatus}
          </div>
        ) : null}

        <section className="hero">
          <p>Emails are annoying.</p>
          <h1>Throw them in a bin.</h1>
        </section>

        <section className="bin-stage" aria-label="Mail bins">
          {bins.map((bin) => (
            <button
              className={`bin-button bin-${bin.id}${pressedBin === bin.id ? ' is-selected' : ''}`}
              key={bin.id}
              onClick={() => handleBinClick(bin.id)}
              style={{ '--accent': bin.accent } as CSSProperties}
              type="button"
            >
              <img src={bin.image} alt={`${bin.title} bin`} />
              <span>{bin.title}</span>
            </button>
          ))}
        </section>
      </main>
    </>
  );
}
