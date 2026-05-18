import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { bins, getBin, getMailsForBin } from './data/mail';
import type { BinId, MailItem, CoreMemory } from './types';
import { supabase } from './supabase';
import { log, logWeird } from './logger';
import { Dropdown } from './Dropdown';
import { Settings, X, RefreshCw, ArrowUp, Loader2, Check } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { App as CapacitorApp } from '@capacitor/app';

const binSpeech: Record<BinId, string> = {
  emergency: 'I only eat panic mail.',
  info: 'Tiny useful things go here.',
  maybe: 'Meh. I will hold the boring stuff.',
};

const binEmptyMessages: Record<BinId, string> = {
  emergency: 'No unread files. Bin is sleeping — do not wake him up.',
  info: 'No unread files. Bin is sleeping — do not wake him up.',
  maybe: 'No unread files. Bin is sleeping — do not wake him up.',
};

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabaseFunctionsUrl = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL;

const isNative = Capacitor.isNativePlatform();

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
  const [isConnectingGmail, setIsConnectingGmail] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  const [newEmailCount, setNewEmailCount] = useState(0);
  const [floatingMessage, setFloatingMessage] = useState<string | null>(null);
  const [coreMemory, setCoreMemory] = useState<CoreMemory | null>(null);
  const [showPreferences, setShowPreferences] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);

  const [binEmailsMap, setBinEmailsMap] = useState<Record<BinId, MailItem[]>>({
    emergency: [], info: [], maybe: [],
  });
  const [binCursors, setBinCursors] = useState<Record<BinId, string | null>>({
    emergency: null, info: null, maybe: null,
  });
  const [binStatuses, setBinStatuses] = useState<Record<BinId, 'idle' | 'loading' | 'ready' | 'empty' | 'error'>>({
    emergency: 'idle', info: 'idle', maybe: 'idle',
  });

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
      headers: { apikey: supabaseAnonKey },
      signal: controller.signal,
    })
      .then((response) => setSupabaseStatus(response.ok ? 'ready' : 'error'))
      .catch(() => { if (!controller.signal.aborted) setSupabaseStatus('error'); });

    return () => controller.abort();
  }, []);

  function processOAuthParams(params: URLSearchParams) {
    const gmail = params.get('gmail');
    const reason = params.get('reason');

    if (gmail === 'connected') {
      setIsConnectingGmail(false);
      const accessToken = params.get('accessToken');
      const refreshToken = params.get('refreshToken');

      if (accessToken && !refreshToken) logWeird('Has accessToken but missing refreshToken', {});
      if (!accessToken && refreshToken) logWeird('Has refreshToken but missing accessToken', {});

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
            triggerSync();
          }
        });
      }
      return;
    }

    if (gmail === 'error') {
      setGmailStatus(`Gmail connect failed: ${reason ?? 'unknown_error'}`);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    processOAuthParams(params);
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
  }, []);

  useEffect(() => {
    if (!isNative) return;
    CapacitorApp.addListener('appUrlOpen', (event) => {
      const url = new URL(event.url);
      if (url.protocol === 'mailbin:') {
        processOAuthParams(url.searchParams);
      }
    });
  }, []);

  useEffect(() => {
    log(`Checking connection status (supabaseFunctionsUrl: ${!!supabaseFunctionsUrl})`);
    if (!supabaseFunctionsUrl) return;

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
        triggerSync();
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

  const triggerSync = useCallback(async () => {
    if (!supabaseFunctionsUrl || syncActiveRef.current) return;
    syncActiveRef.current = true;
    setIsSyncing(true);
    setSyncProgress(0);
    setNewEmailCount(0);
    try {
      let hasMore = true;
      while (hasMore) {
        const response = await fetch(`${supabaseFunctionsUrl}/gmail-sync`, { headers: await getAuthHeaders() });
        const data = await response.json() as { syncedCount?: number; hasMore?: boolean; isBaseline?: boolean };
        const newlySynced = data.syncedCount ?? 0;
        setSyncProgress((prev) => prev + newlySynced);
        if (newlySynced > 0) setNewEmailCount((prev) => prev + newlySynced);
        hasMore = data.hasMore ?? false;
        if (hasMore) await new Promise((r) => setTimeout(r, 2000));
      }
    } catch {
    } finally {
      syncActiveRef.current = false;
      setIsSyncing(false);
      setSyncProgress(0);
    }
  }, [supabaseFunctionsUrl]);

  const gmailFetch = useCallback(async (binId: BinId, cursor?: string) => {
    if (!supabaseFunctionsUrl) return;

    const isInitial = !cursor;
    setBinStatuses((prev) => ({ ...prev, [binId]: isInitial ? 'loading' : prev[binId] }));

    try {
      const url = new URL(`${supabaseFunctionsUrl}/gmail-mails`);
      url.searchParams.set('bin', binId);
      if (cursor) url.searchParams.set('before', cursor);
      url.searchParams.set('limit', '20');

      const response = await fetch(url, { headers: await getAuthHeaders() });
      const data = await response.json() as { messages?: MailItem[]; nextCursor?: string | null };

      if (!response.ok) throw new Error(data && typeof data === 'object' && 'error' in data ? String((data as Record<string, unknown>).error) : 'fetch_failed');

      const messages = data.messages ?? [];
      setBinEmailsMap((prev) => ({ ...prev, [binId]: isInitial ? messages : [...prev[binId], ...messages] }));
      setBinCursors((prev) => ({ ...prev, [binId]: data.nextCursor ?? null }));

      if (isInitial) {
        setBinStatuses((prev) => ({ ...prev, [binId]: messages.length > 0 ? 'ready' : 'empty' }));
      }
    } catch (error) {
      if (isInitial) {
        logWeird('GMAIL-FETCH', `Failed: ${error instanceof Error ? error.message : String(error)}`);
        setBinEmailsMap((prev) => ({ ...prev, [binId]: [] }));
        setBinStatuses((prev) => ({ ...prev, [binId]: 'error' }));
      }
    }
  }, []);

  useEffect(() => {
    if (!selectedBin || !isSyncing) return;
    gmailFetch(selectedBin);
  }, [syncProgress, selectedBin, isSyncing, gmailFetch]);

  useEffect(() => {
    if (!selectedBin || !isGmailConnected) return;
    gmailFetch(selectedBin);
  }, [selectedBin, isGmailConnected, gmailFetch]);

  const loadMoreGmail = useCallback(() => {
    if (!selectedBin) return;
    const cursor = binCursors[selectedBin];
    const status = binStatuses[selectedBin];
    if (!cursor || status !== 'ready') return;
    gmailFetch(selectedBin, cursor);
  }, [selectedBin, binCursors, binStatuses, gmailFetch]);

  const loadCoreMemory = useCallback(async () => {
    if (!supabaseFunctionsUrl) return;
    try {
      const response = await fetch(`${supabaseFunctionsUrl}/core-memory`, { headers: await getAuthHeaders() });
      if (response.ok) setCoreMemory(await response.json() as CoreMemory);
    } catch {
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
  const syncActiveRef = useRef(false);

  useEffect(() => {
    const el = mailListRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) loadMoreGmail();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [loadMoreGmail]);

  const activeBin = getBin(selectedBin);
  const sourceMails = selectedBin && binEmailsMap[selectedBin].length > 0
    ? binEmailsMap[selectedBin]
    : getMailsForBin(selectedBin);
  const activeMails = sourceMails.filter((mail) => !dismissedMailIds.includes(mail.id));
  const currentBinStatus = selectedBin ? binStatuses[selectedBin] : 'idle';

  function getGmailStatusState(): 'checking' | 'connected' | 'error' | 'idle' {
    if (isConnectingGmail) return 'checking';
    if (isGmailConnected) return 'connected';
    if (gmailStatus && gmailStatus.includes('failed')) return 'error';
    return 'idle';
  }

  const gmailStatusState = getGmailStatusState();

  function handleBinClick(id: BinId) {
    setPressedBin(id);
    window.setTimeout(() => navigateToBin(id), 220);
  }

  function handleConnectGmail() {
    if (isGmailConnected) {
      navigateToBin('emergency');
      return;
    }
    if (isConnectingGmail) return;
    if (!supabaseFunctionsUrl) {
      window.alert('Add VITE_SUPABASE_FUNCTIONS_URL to .env first.');
      return;
    }
    setIsConnectingGmail(true);
    const oauthUrl = `${supabaseFunctionsUrl}/gmail-oauth-start?redirect_uri=mailbin://callback`;
    if (isNative) {
      Browser.open({ url: oauthUrl }).catch(() => {
        window.location.href = oauthUrl;
      });
    } else {
      window.location.href = oauthUrl;
    }
  }

  function handleMailClick(id: string) {
    if (dismissingMailId) return;
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
          <h2>Preferences</h2>
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
          <p className="preferences-section-title">Custom classification rules (up to 5, each ≤20 words)</p>
          {Array.from({ length: 5 }).map((_, index) => (
            <input
              key={index}
              type="text"
              className="preferences-rule-input"
              placeholder={`Rule ${index + 1} — e.g. "Temu promos → emergency"`}
              value={coreMemory?.customRules[index] ?? ''}
              maxLength={20}
              onChange={(e) => setCoreMemory((prev) => {
                if (!prev) return null;
                const rules = [...prev.customRules];
                rules[index] = e.target.value;
                return { ...prev, customRules: rules };
              })}
            />
          ))}

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

          <button
            className="new-emails-button"
            type="button"
            onClick={() => {
              mailListRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
              if (newEmailCount > 0 && selectedBin) {
                setNewEmailCount(0);
                gmailFetch(selectedBin);
              }
            }}
          >
            {isSyncing ? (
              <>
                <RefreshCw size={14} className="sync-spinner" />
                Syncing...
              </>
            ) : newEmailCount > 0 ? (
              <>
                <ArrowUp size={14} />
                New Message
              </>
            ) : (
              <>
                <ArrowUp size={14} />
                Back to top
              </>
            )}
          </button>

          <section className="mail-list" aria-label={`${activeBin.title} mail list`} ref={mailListRef}>
            {currentBinStatus === 'empty' ? (
              <div className="empty-state" onClick={() => { setFloatingMessage('No unread mail — bin is sleeping 😴'); setTimeout(() => setFloatingMessage(null), 1500); }}>
                <img className="empty-state-image" src={activeBin.sleepyImage} alt={`${activeBin.title} bin sleeping`} />
                {floatingMessage ? (
                  <div className="floating-toast">{floatingMessage}</div>
                ) : null}
                <p className="empty-state-message" style={{ '--accent': activeBin.accent } as CSSProperties}>
                  {binEmptyMessages[activeBin.id]}
                </p>
              </div>
            ) : null}
            {currentBinStatus === 'error' ? (
              <p className="mail-list-status is-error">Could not load emails.</p>
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
                  {mail.isCustomized ? <span className="customized-badge">customized</span> : null}
                </div>
                <div className="mail-summary-row">
                  <p className="mail-summary">{mail.aiSummary || mail.summary}</p>
                  <span
                    className="open-gmail"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isNative) {
                        Browser.open({ url: mail.gmailUrl }).catch(() => window.open(mail.gmailUrl, '_blank'));
                      } else {
                        window.open(mail.gmailUrl, '_blank');
                      }
                    }}
                  >
                    Open
                  </span>
                </div>
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
              </button>
            ))}
            {currentBinStatus === 'ready' && binCursors[selectedBin!] ? (
              <p className="mail-list-status">Scroll for more...</p>
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
        <button className="settings-button" type="button" aria-label="Settings" onClick={() => setShowPreferences(true)}>
          <Settings size={28} />
        </button>

        {!isGmailConnected ? (
          <button className="connect-gmail-button" onClick={handleConnectGmail} type="button">
            Connect Gmail
          </button>
        ) : null}

        <div className="status-pills">
          <span className={`status-pill is-${supabaseStatus}`}>
            <span className="status-pill-text">Server{supabaseStatus === 'checking' ? '?' : ''}</span>
            {supabaseStatus === 'checking' ? <Loader2 size={12} className="spinner" /> : null}
            {supabaseStatus === 'ready' ? <Check size={12} /> : null}
            {supabaseStatus === 'error' || supabaseStatus === 'missing' ? <X size={12} /> : null}
          </span>
          <span className={`status-pill is-gmail-${gmailStatusState}`}>
            <span className="status-pill-text">Gmail{gmailStatusState === 'checking' ? '?' : ''}</span>
            {gmailStatusState === 'checking' ? <Loader2 size={12} className="spinner" /> : null}
            {gmailStatusState === 'connected' ? <Check size={12} /> : null}
            {gmailStatusState === 'error' ? <X size={12} /> : null}
          </span>
        </div>

        {isSyncing ? (
          <div className="sync-indicator-home">
            <RefreshCw size={14} className="sync-spinner" />
            {syncProgress > 0 ? `Synced ${syncProgress} emails...` : 'Syncing emails...'}
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
