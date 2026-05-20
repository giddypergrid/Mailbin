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
  emergency: 'Nothing urgent. You survived another day.',
  info: 'Zero info. Your brain is safe.',
  maybe: 'Nothing to maybe about. Pure peace.',
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

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const ts = new Date(iso).getTime();
  if (isNaN(ts) || ts <= 0) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
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
  const [isConnectHighlighted, setIsConnectHighlighted] = useState(false);
  const [coreMemory, setCoreMemory] = useState<CoreMemory | null>(null);
  const [showPreferences, setShowPreferences] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);

  const [swipingMailId, setSwipingMailId] = useState<string | null>(null);
  const [feedbackMailId, setFeedbackMailId] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);

  const [onboardingStep, setOnboardingStep] = useState(0);
  const [showSplash, setShowSplash] = useState(true);
  const [splashFading, setSplashFading] = useState(false);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setSplashFading(true), 2200);
    const hideTimer = setTimeout(() => setShowSplash(false), 2500);
    return () => { clearTimeout(fadeTimer); clearTimeout(hideTimer); };
  }, []);

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
            if (!localStorage.getItem('mailbin_onboarded')) {
              setOnboardingStep(1);
            }
          }
        });
      }
      return;
    }

    if (gmail === 'error') {
      setIsConnectingGmail(false);
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
  const dragStartXRef = useRef(0);
  const dragStartYRef = useRef(0);
  const swipeLockedRef = useRef(false);
  const activeSwipeRef = useRef<string | null>(null);
  const cardElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const feedbackMailRef = useRef<MailItem | null>(null);

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
    if (!isGmailConnected) {
      setIsConnectHighlighted(true);
      setTimeout(() => setIsConnectHighlighted(false), 600);
      return;
    }
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
    if (isNative) {
      const nativeOauthUrl = `${supabaseFunctionsUrl}/gmail-oauth-start?redirect_uri=${encodeURIComponent('mailbin://callback')}`;
      Browser.open({ url: nativeOauthUrl }).catch(() => {
        window.location.href = nativeOauthUrl;
      });
    } else {
      window.location.href = `${supabaseFunctionsUrl}/gmail-oauth-start`;
    }
  }

  const SWIPE_THRESHOLD = 160;

  function setRevealColor(card: HTMLElement | null | undefined, color: string | null) {
    const wrapper = card?.parentElement;
    const reveal = wrapper?.querySelector('.swipe-reveal') as HTMLElement | null;
    if (reveal) {
      reveal.style.background = color ?? '';
    }
  }

  function fireMarkReadApi(mailId: string) {
    const gmailMessageId = mailId.replace('gmail-', '');
    const markGmail = coreMemory?.markEmailsAsRead ?? true;
    getAuthHeaders().then((headers) =>
      fetch(`${supabaseFunctionsUrl}/mark-read`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gmailMessageId, markGmail }),
      })
    ).catch(() => { /* best-effort */ });
  }

  function handlePointerDown(e: React.PointerEvent, mailId: string) {
    if (activeSwipeRef.current || feedbackMailId) return;
    const card = e.currentTarget as HTMLElement;
    card.style.transition = 'none';
    activeSwipeRef.current = mailId;
    swipeLockedRef.current = false;
    cardElsRef.current.set(mailId, card);
    dragStartXRef.current = e.clientX;
    dragStartYRef.current = e.clientY;
  }

  function handlePointerMove(e: React.PointerEvent) {
    const activeId = activeSwipeRef.current;
    if (!activeId) return;
    const card = cardElsRef.current.get(activeId);
    if (!card) return;
    const dx = e.clientX - dragStartXRef.current;
    const dy = e.clientY - dragStartYRef.current;

    if (!swipeLockedRef.current) {
      // vertical intent wins — cancel swipe, let browser scroll
      if (Math.abs(dy) > Math.abs(dx) + 4) {
        activeSwipeRef.current = null;
        card.style.transition = '';
        return;
      }
      // horizontal intent — lock in swipe and capture pointer
      if (Math.abs(dx) > 8) {
        swipeLockedRef.current = true;
        card.setPointerCapture(e.pointerId);
        setSwipingMailId(activeId);
      } else {
        return;
      }
    }

    card.style.transform = `translateX(${dx}px)`;
    const progress = Math.min(Math.abs(dx) / SWIPE_THRESHOLD, 1);
    if (dx > 0) {
      setRevealColor(card, `rgba(139, 115, 85, ${progress})`);
    } else if (dx < 0) {
      setRevealColor(card, `rgba(192, 57, 43, ${progress})`);
    } else {
      setRevealColor(card, null);
    }
  }

  function handlePointerUp(e: React.PointerEvent) {
    const activeId = activeSwipeRef.current;
    if (!activeId) return;
    const dx = e.clientX - dragStartXRef.current;
    const card = cardElsRef.current.get(activeId);
    cardElsRef.current.delete(activeId);
    activeSwipeRef.current = null;

    if (dx > SWIPE_THRESHOLD) {
      setSwipingMailId(null);
      fireMarkReadApi(activeId);
      // hide card instantly, then collapse wrapper height over 300ms
      if (card) {
        card.style.opacity = '0';
      }
      const wrapper = card?.parentElement as HTMLElement | null;
      if (wrapper) {
        const height = wrapper.offsetHeight;
        wrapper.style.maxHeight = height + 'px';
        wrapper.style.overflow = 'hidden';
        wrapper.getBoundingClientRect(); // force reflow
        wrapper.style.transition = 'max-height 300ms ease, margin-bottom 300ms ease';
        wrapper.style.maxHeight = '0';
        wrapper.style.marginBottom = '-8px';
      }
      setTimeout(() => {
        setDismissedMailIds((prev) => [...prev, activeId]);
        setRevealColor(card, null);
      }, 300);
    } else if (dx < -SWIPE_THRESHOLD) {
      setRevealColor(card, 'rgba(192, 57, 43, 1)');
      if (card) {
        card.style.transition = '';
        card.style.transform = '';
      }
      const mail = activeMails.find((m) => m.id === activeId);
      if (mail) feedbackMailRef.current = mail;
      setFeedbackMailId(activeId);
      setDismissedMailIds((prev) => (prev.includes(activeId) ? prev : [...prev, activeId]));
      setSwipingMailId(null);
    } else {
      if (card) {
        card.style.transition = 'transform 260ms ease';
        card.style.transform = '';
      }
      setRevealColor(card, null);
      setSwipingMailId(null);
    }
  }

  async function submitFeedback() {
    if (!feedbackMailId || isSubmittingFeedback) return;
    const wordCount = feedbackText.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount > 30) return;
    setIsSubmittingFeedback(true);
    const gmailMessageId = feedbackMailId.replace('gmail-', '');
    try {
      await fetch(`${supabaseFunctionsUrl}/save-feedback`, {
        method: 'POST',
        headers: { ...(await getAuthHeaders()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ gmailMessageId, feedbackText: feedbackText.trim() }),
      });
    } catch { /* best-effort */ }
    setFeedbackMailId(null);
    setFeedbackText('');
    setIsSubmittingFeedback(false);
    setDismissedMailIds((prev) => (prev.includes(feedbackMailId) ? prev : [...prev, feedbackMailId]));
  }

  const feedbackMail = feedbackMailRef.current;
  const emergencyBin = getBin('emergency');

  const splashOverlay = showSplash ? (
    <div className={`splash-overlay${splashFading ? ' is-fading' : ''}`}>
      {emergencyBin ? <img className="splash-bin-image" src={emergencyBin.image} alt="Mailbin" /> : null}
      <span className="splash-title">Mailbin</span>
    </div>
  ) : null;

  const feedbackPanel = feedbackMailId ? (
    <div className="feedback-overlay" onClick={() => { setFeedbackMailId(null); setFeedbackText(''); }}>
      <div className="feedback-panel" onClick={(e) => e.stopPropagation()}>
        <div className="feedback-badge-strip" style={{ background: getBin(feedbackMail?.bin ?? null)?.accent ?? '#888' }} />
        <div className="feedback-body">
          <div className="feedback-header">
            <h2 className="feedback-title">Teach the AI</h2>
            <button className="feedback-close" onClick={() => { setFeedbackMailId(null); setFeedbackText(''); }} type="button">
              <X size={18} />
            </button>
          </div>
          <p className="feedback-summary-label">Email summary</p>
          <div className="feedback-summary-area">
            {feedbackMail?.aiSummary || feedbackMail?.summary || '(no summary)'}
          </div>
          <p className="feedback-input-label">
            Why did you bin this? <span className="feedback-word-count">({Math.max(0, 30 - feedbackText.trim().split(/\s+/).filter(Boolean).length)} words left)</span>
          </p>
          <textarea
            className="feedback-input"
            placeholder="Tell the AI what to learn from this..."
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            maxLength={200}
          />
          <button
            className="feedback-submit"
            type="button"
            disabled={!feedbackText.trim() || isSubmittingFeedback}
            onClick={submitFeedback}
          >
            {isSubmittingFeedback ? 'Saving...' : 'Submit feedback'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const preferencesPanel = showPreferences ? (
    <div className="preferences-overlay" onClick={() => setShowPreferences(false)}>
      <div className="preferences-board" onClick={(e) => e.stopPropagation()}>
        <button className="board-close" onClick={() => setShowPreferences(false)} type="button">
          <X size={22} />
        </button>

        <div className="board-tag">Instructions</div>
        <div className="board-rules">
          <p className="board-rules-hint">Custom classification rules (up to 10, each ≤200 characters)</p>
          {Array.from({ length: 10 }).map((_, index) => (
            <input
              key={index}
              type="text"
              className="board-rule-input"
              placeholder={`Rule ${index + 1} — e.g. "Temu promos → emergency"`}
              value={coreMemory?.customRules[index] ?? ''}
              maxLength={200}
              onChange={(e) => setCoreMemory((prev) => {
                if (!prev) return null;
                const rules = [...prev.customRules];
                rules[index] = e.target.value;
                return { ...prev, customRules: rules };
              })}
            />
          ))}
        </div>

        <div className="board-center" />

        <div className="board-tag">Preferences</div>
        <div className="board-preference-row">
          <label className="board-checkbox-label">
            <input
              type="checkbox"
              checked={coreMemory?.markEmailsAsRead ?? true}
              onChange={(e) => setCoreMemory((prev) => {
                if (!prev) return null;
                return { ...prev, markEmailsAsRead: e.target.checked };
              })}
            />
            <span>Slide email will mark Gmail relevant mails as read?</span>
          </label>
        </div>

        {preferencesError ? <p className="preferences-error">{preferencesError}</p> : null}
        <button
          className="board-save"
          type="button"
          disabled={savingPreferences}
          onClick={() => {
            if (!coreMemory) return;
            saveCoreMemory(coreMemory);
          }}
        >
          {savingPreferences ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  ) : null;

  const onboardingBoard = onboardingStep > 0 ? (
    <div className="preferences-overlay">
      <div className="preferences-board onboarding-board">
        <button className="board-close" onClick={() => { setOnboardingStep(0); localStorage.setItem('mailbin_onboarded', 'true'); }} type="button">
          <X size={22} />
        </button>

        {onboardingStep === 1 ? (
          <>
            <h2 className="onboarding-title">Welcome to Mailbin</h2>
            <p className="onboarding-subtitle">You have three bins:</p>
            <div className="onboarding-bins">
              {bins.map((bin) => (
                <div className="onboarding-bin-row" key={bin.id}>
                  <img className="onboarding-bin-img" src={bin.image} alt={`${bin.title} bin`} />
                  <div className="onboarding-bin-text">
                    <span className="onboarding-bin-name" style={{ color: bin.accent }}>{bin.title}</span>
                    <span className="onboarding-bin-desc">{binSpeech[bin.id]}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {onboardingStep === 2 ? (
          <>
            <h2 className="onboarding-title">How to use</h2>
            <div className="onboarding-swipe-demo">
              <div className="onboarding-swipe-item">
                <div className="onboarding-fake-card">
                  <span className="onboarding-fake-theme">Email</span>
                </div>
                <div className="onboarding-swipe-hint">
                  <span className="onboarding-arrow right">→</span>
                  <span>Swipe right to read an email</span>
                </div>
              </div>
              <div className="onboarding-swipe-item">
                <div className="onboarding-fake-card">
                  <span className="onboarding-fake-theme">Email</span>
                </div>
                <div className="onboarding-swipe-hint">
                  <span className="onboarding-arrow left">←</span>
                  <span>Swipe left if you think email is wrongly binned or summarized!</span>
                </div>
              </div>
            </div>
          </>
        ) : null}

        {onboardingStep === 3 ? (
          <>
            <h2 className="onboarding-title">Check your status!</h2>
            <div className="onboarding-status-demo">
              <div className="onboarding-status-pill-demo is-ready">Server <Check size={12} /></div>
              <div className="onboarding-status-pill-demo is-connected">Gmail <Check size={12} /></div>
            </div>
            <p className="onboarding-status-text">
              This is where you put your instructions! Try it out!
            </p>
            <p className="onboarding-dev-note">
              The app is still under development, write to sunziyuan000@gmail.com!
            </p>
          </>
        ) : null}

        <div className="onboarding-nav">
          {onboardingStep > 1 ? (
            <button className="onboarding-nav-btn" type="button" onClick={() => setOnboardingStep((s) => s - 1)}>
              Previous
            </button>
          ) : <span />}
          {onboardingStep < 3 ? (
            <button className="onboarding-nav-btn primary" type="button" onClick={() => setOnboardingStep((s) => s + 1)}>
              Next
            </button>
          ) : (
            <button className="onboarding-nav-btn primary" type="button" onClick={() => { setOnboardingStep(0); localStorage.setItem('mailbin_onboarded', 'true'); }}>
              Start!
            </button>
          )}
        </div>
      </div>
    </div>
  ) : null;

  if (activeBin) {
    return (
      <>
        {splashOverlay}
        {preferencesPanel}
        {feedbackPanel}
        {onboardingBoard}
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
            {activeMails.map((mail) => {

              return (
                <div className="mail-card-wrapper" key={mail.id}>
                  <div className="swipe-reveal" />
                  <button
                    className="mail-card"
                    onPointerDown={(e) => handlePointerDown(e, mail.id)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    type="button"
                  >
                    <div className="mail-card-header">
                      <span className="mail-theme">{mail.aiTheme || mail.subject}</span>
                      <div className="mail-card-meta">
                        {mail.aiFromWho ? <span className="mail-from-who">{mail.aiFromWho}</span> : null}
                        {mail.isCustomized ? <span className="customized-badge">customized</span> : null}
                        {mail.receivedAt ? <span className="mail-time">{relativeTime(mail.receivedAt)}</span> : null}
                      </div>
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
                  </button>
                </div>
              );
            })}
            {currentBinStatus === 'ready' && binCursors[selectedBin!] ? (
              <p className="mail-list-status">Scroll for more...</p>
            ) : null}
          </section>

          <div className="open-gmail-bar">
            <button
              className="open-gmail-button"
              type="button"
              onClick={() => {
                const url = 'https://mail.google.com';
                if (isNative) {
                  Browser.open({ url }).catch(() => window.open(url, '_blank'));
                } else {
                  window.open(url, '_blank');
                }
              }}
            >
              Open Gmail
            </button>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      {splashOverlay}
      {preferencesPanel}
      {feedbackPanel}
      {onboardingBoard}
      <main className="app-shell home-shell">
        <div className="top-bar">
          {!isGmailConnected ? (
            <button className={`connect-gmail-button${isConnectHighlighted ? ' is-highlighted' : ''}`} onClick={handleConnectGmail} type="button">
              Connect Gmail
            </button>
          ) : <div />}

          <div className="top-right-corner">
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
            <button className="settings-button" type="button" aria-label="Settings" onClick={() => setShowPreferences(true)}>
              <Settings size={36} />
            </button>
          </div>
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

        <section className="bin-stage" aria-label="Mail bins" style={{ position: 'relative' }}>
          {floatingMessage ? (
            <div className="floating-toast">{floatingMessage}</div>
          ) : null}
          {bins.map((bin) => (
            <button
              className={`bin-button bin-${bin.id}${pressedBin === bin.id ? ' is-selected' : ''}`}
              key={bin.id}
              onClick={() => handleBinClick(bin.id)}
              style={{ '--accent': bin.accent } as CSSProperties}
              type="button"
            >
              <img src={bin.image} alt={`${bin.title} bin`} />
            </button>
          ))}
        </section>
      </main>
    </>
  );
}
