// content.js - Content script for ScamRadar Chrome extension
// Runs on web pages to extract text and highlight dangerous sentences
//
// Extraction rules: use window.location.hostname first, then ONLY the
// active/focused panel for that site (never the whole tab unless fallback).

/** Remove AI-only instruction blocks — never show these in the popup. */
function stripInternalExtractHeaders(text) {
  if (!text) return '';
  return text
    .replace(/^=== WhatsApp chat:[\s\S]*?(?=\n\[|\n[A-Za-z0-9]|$)/m, '')
    .replace(/^The lines below are the ONLY messages[\s\S]*?\n\n/m, '')
    .replace(/^Your summary must describe[\s\S]*?\n\n/m, '')
    .replace(/^If payment, QR code, or phishing links[\s\S]*?\n\n/m, '')
    .replace(/^=== LinkedIn (?:conversation|job)[\s\S]*?\n\n/m, '')
    .replace(/^Analyze ONLY these message lines\.\s*\n*/m, '')
    .replace(/^\[[^\]]+\]\s*\n\n/m, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Turn "[You @ 9:00 PM] Hello" into "You: Hello" for the popup. */
function formatChatLineForPreview(line) {
  const trimmed = (line || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';

  const tagged = trimmed.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (tagged) {
    let who = tagged[1].replace(/\s*@\s*.+$/, '').trim();
    if (/^you$/i.test(who)) who = 'You';
    else if (/^contact$/i.test(who)) who = 'Contact';
    return `${who}: ${tagged[2].trim()}`;
  }

  return trimmed;
}

/** Last few chat lines, readable in the popup (no AI headers). */
function buildUserPreview(rawText, opts = {}) {
  const maxLines = opts.maxLines ?? 3;
  const maxChars = opts.maxChars ?? 280;

  const body = stripInternalExtractHeaders(rawText);
  if (!body) return '';

  const lines = body
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1);

  const formatted = lines.map(formatChatLineForPreview).filter(Boolean);
  const tail = formatted.slice(-maxLines);
  if (!tail.length) return '';

  let preview = tail.join('\n');
  if (preview.length > maxChars) {
    preview = preview.slice(0, maxChars);
    const lastBreak = preview.lastIndexOf('\n');
    if (lastBreak > 50) preview = preview.slice(0, lastBreak);
    preview = preview.trim() + '…';
  }
  return preview;
}

function registerScamRadarListeners() {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extractText') {
      const finishExtract = (platformData) => {
        const previewSource =
          platformData.preview_text ||
          stripInternalExtractHeaders(platformData.text || '');
        platformData.extract_preview =
          buildUserPreview(previewSource, { maxLines: 3, maxChars: 280 }) ||
          previewSource.substring(0, 220);
        platformData.message_count = platformData.message_count || 0;
        console.log(
          'ScamRadar extract:',
          platformData.platform,
          platformData.scan_description,
          'chars:',
          (platformData.text || '').length,
          'preview:',
          platformData.extract_preview
        );
        sendResponse(platformData);
      };

      const runExtract = async () => {
        try {
          let platformData = extractPlatformSpecificText();
          if (shouldRetryLinkedInJobExtract(platformData)) {
            for (let attempt = 0; attempt < 12; attempt++) {
              expandLinkedInJobDescription();
              await new Promise((r) => setTimeout(r, 450));
              platformData = extractPlatformSpecificText();
              if (platformData.text?.trim()) break;
            }
          } else if (shouldRetryLinkedInMessagingExtract(platformData)) {
            for (let attempt = 0; attempt < 6; attempt++) {
              await new Promise((r) => setTimeout(r, 350));
              platformData = extractPlatformSpecificText();
              if (platformData.text?.trim()) break;
            }
          }
          finishExtract(platformData);
        } catch (error) {
          console.error('Error extracting text:', error);
          sendResponse({ text: '', error: error.message });
        }
      };

      runExtract();
      return true;
    }

    if (request.action === 'highlightSentences') {
      try {
        const sentences = request.sentences || [];
        const score = request.score || 0;
        highlightSentences(sentences, score);
        sendResponse({ success: true });
      } catch (error) {
        console.error('Error highlighting sentences:', error);
        sendResponse({ error: error.message });
      }
      return true;
    }
  });
}

if (!window.__scamRadarContentScriptReady) {
  window.__scamRadarContentScriptReady = true;
  console.log('ScamRadar content script loaded on:', window.location.href);
  registerScamRadarListeners();
}

function highlightSentences(sentences, score) {
  removeExistingHighlights();
  removeWarningBadge();

  if (!sentences.length) {
    return;
  }

  setTimeout(() => {
    sentences.forEach((sentence) => {
      highlightSentence(sentence);
    });

    if (score >= 60) {
      showWarningBadge(score);
    }
  }, 100);
}

/** True if element lives in the left chat list — never scan this region */
function isInsideWhatsAppSidebar(el) {
  if (!el) return false;
  return !!(
    el.closest('#pane-side') ||
    el.closest('[data-testid="chat-list"]') ||
    el.closest('[data-testid="chatlist"]') ||
    el.closest('[data-testid="chat-list-search"]')
  );
}

/** Right panel only — never motion-main / data-tab wrappers that include the sidebar */
function getWhatsAppMainPanel() {
  return document.querySelector('#main');
}

/** Right edge of the chat list column — bubbles left of this are sidebar previews */
function getWhatsAppSidebarRightEdge() {
  const pane = document.querySelector('#pane-side');
  if (pane) {
    const r = pane.getBoundingClientRect();
    if (r.width > 0) return r.right;
  }
  return Math.floor(window.innerWidth * 0.38);
}

function isInWhatsAppConversationColumn(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.left >= getWhatsAppSidebarRightEdge() + 4 && r.width > 0 && r.height > 0;
}

/** Message is in the open chat area (#main), not the left chat list. */
function isInWhatsAppMainPanel(el) {
  if (!el || isInsideWhatsAppSidebar(el)) return false;
  const main = getWhatsAppMainPanel();
  if (!main || !main.contains(el)) return false;
  if (el.closest('#pane-side')) return false;
  if (el.closest('header') && !el.closest('[data-testid="msg-container"]')) return false;
  if (el.closest('footer') && !el.closest('[data-testid="msg-container"]')) return false;
  if (el.closest('[data-testid="compose-box"]')) return false;
  return isElementVisible(el);
}

/** Sidebar text-matching must not run on #main messages (preview text duplicates active chat). */
function shouldFilterSidebarPreview(msgText, sidebarSnippets, el) {
  if (el && isInWhatsAppMainPanel(el)) return false;
  return isLikelySidebarPreview(msgText, sidebarSnippets);
}

/** Last-message previews in the left chat list — used to exclude contamination */
function collectWhatsAppSidebarPreviewTexts() {
  const snippets = new Set();
  const pane = document.querySelector('#pane-side');
  if (!pane) return snippets;

  pane.querySelectorAll('span[title], [dir="ltr"] span, .matched-text').forEach((el) => {
    const title = (el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    [title, text].forEach((t) => {
      if (t.length >= 12 && t.length < 400) snippets.add(t.toLowerCase());
    });
  });

  return snippets;
}

function isLikelySidebarPreview(msgText, sidebarSnippets) {
  const norm = msgText.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!norm || norm.length < 8) return false;

  for (const snip of sidebarSnippets) {
    if (snip.length < 12) continue;
    if (norm === snip) return true;
    if (norm.includes(snip) || snip.includes(norm)) {
      const shorter = norm.length <= snip.length ? norm : snip;
      const longer = norm.length > snip.length ? norm : snip;
      if (shorter.length / longer.length >= 0.55) return true;
    }
  }
  return false;
}

/**
 * Open conversation panel in #main (WhatsApp Web 2024+ structure).
 * Ref: conversation-panel > msg-list, Message list region, conversation-panel-messages
 */
function getWhatsAppActiveConversationPanel(main) {
  if (!main) return null;

  const strictSelectors = [
    '[data-testid="conversation-panel"] [data-testid="msg-list"]',
    '[data-testid="conversation-panel-messages"]',
    '[data-testid="conversation-panel-body"]',
    '[data-testid="conversation-panel"]'
  ];

  for (const sel of strictSelectors) {
    const el = main.querySelector(sel);
    if (el && !isInsideWhatsAppSidebar(el) && isInWhatsAppConversationColumn(el)) {
      return el;
    }
  }

  const byAria = Array.from(main.querySelectorAll('[role="region"]')).find((el) =>
    /message list/i.test(el.getAttribute('aria-label') || '')
  );
  if (byAria && isInWhatsAppConversationColumn(byAria)) {
    return byAria;
  }

  return findWhatsAppMessageListByViewport(main);
}

function findWhatsAppMessageListByViewport(main) {
  const xPositions = [0.72, 0.62, 0.82];
  const yPositions = [0.35, 0.5, 0.65];

  for (const xPct of xPositions) {
    for (const yPct of yPositions) {
      const x = Math.floor(window.innerWidth * xPct);
      const y = Math.floor(window.innerHeight * yPct);
      let el = document.elementFromPoint(x, y);
      while (el && el !== document.body) {
        if (main.contains(el) && !isInsideWhatsAppSidebar(el)) {
          const label = el.getAttribute('aria-label') || '';
          if (el.getAttribute('role') === 'region' && /message list/i.test(label)) {
            return el;
          }
          const n = el.querySelectorAll(
            '[data-testid="msg-container"], .message-in, .message-out, [data-pre-plain-text]'
          ).length;
          if (n > 0 && isInWhatsAppConversationColumn(el)) {
            return el;
          }
        }
        el = el.parentElement;
      }
    }
  }
  return null;
}

function getWhatsAppMessageScrollArea(main) {
  return getWhatsAppActiveConversationPanel(main);
}

function isElementVisible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 8 && r.height > 8;
}

function getWhatsAppSelectedChatName(main) {
  const header = main?.querySelector('header');
  if (!header) return getWhatsAppContactName(main);

  const spans = Array.from(header.querySelectorAll('span'));
  const nameSpan = spans.find((el) => {
    if (el.firstElementChild) return false;
    const text = (el.innerText || '').trim();
    if (!text || text.length > 120) return false;
    try {
      const px = parseFloat(getComputedStyle(el).fontSize);
      return px >= 14 && px <= 20;
    } catch {
      return text.length > 0;
    }
  });
  if (nameSpan) return nameSpan.innerText.replace(/\s+/g, ' ').trim();

  return getWhatsAppContactName(main);
}

function isWhatsAppSystemText(text) {
  const t = text.trim();
  if (!t || t.length < 2) return true;
  if (/^(edited|delivered|read|seen|online|typing|forwarded|deleted|this message was deleted)$/i.test(t)) {
    return true;
  }
  if (/^[\d:\s,./APM-]+$/i.test(t) && t.length < 24) return true;
  return false;
}

function parseWhatsAppPrePlainText(preText) {
  if (!preText) return { timestamp: '', sender: '' };
  const match = preText.match(/\[([^\]]+)\]\s*(.+?):\s*$/);
  if (match) {
    return { timestamp: match[1].trim(), sender: match[2].trim() };
  }
  return { timestamp: '', sender: '' };
}

function isWhatsAppOutgoingElement(el) {
  let node = el;
  while (node && node !== document.body) {
    if (node.classList?.contains('message-out')) return true;
    if (node.classList?.contains('message-in')) return false;
    node = node.parentElement;
  }
  const sender = parseWhatsAppPrePlainText(el.getAttribute('data-pre-plain-text')).sender;
  return /^you$/i.test(sender);
}

function isWhatsAppActiveMessageNode(el, main) {
  if (!el || !main?.contains(el)) return false;
  return isInWhatsAppMainPanel(el);
}

function getWhatsAppMessageContainer(el) {
  return (
    el.closest('[data-testid="msg-container"]') ||
    el.closest('.message-in') ||
    el.closest('.message-out') ||
    el
  );
}

function extractWhatsAppBodyFromPreElement(el) {
  const textSelectors = [
    'span[data-testid="selectable-text"]',
    '.selectable-text span',
    '.selectable-text',
    '[data-testid="conversation-text"]',
    'span._ao3e'
  ];

  for (const sel of textSelectors) {
    const nodes = el.querySelectorAll(sel);
    if (!nodes.length) continue;
    let combined = '';
    nodes.forEach((n) => {
      const s = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (s && !isWhatsAppSystemText(s)) combined += `${s} `;
    });
    combined = combined.trim();
    if (combined) return combined;
  }

  const copyable = el.closest('.copyable-text') || el;
  let raw = (copyable.textContent || '').replace(/\s+/g, ' ').trim();
  raw = raw.replace(/^\[[^\]]+\]\s*[^:]+:\s*/, '').trim();
  return isWhatsAppSystemText(raw) ? '' : raw;
}

/**
 * Primary extractor: [data-pre-plain-text] exists only on real chat bubbles in #main.
 * (Used by WhatsApp Web / WA export tools — not on sidebar previews.)
 */
function extractWhatsAppFromPrePlainText(main, panel) {
  const scope = panel || main;
  const sidebarSnippets = collectWhatsAppSidebarPreviewTexts();
  const lines = [];
  const seenContainers = new Set();
  const seenText = new Set();
  let filteredSidebar = 0;

  const preNodes = scope.querySelectorAll('[data-pre-plain-text]');

  preNodes.forEach((el) => {
    if (!isWhatsAppActiveMessageNode(el, main)) return;

    const container = getWhatsAppMessageContainer(el);
    if (seenContainers.has(container)) return;
    seenContainers.add(container);

    const preText = el.getAttribute('data-pre-plain-text') || '';
    const { timestamp, sender } = parseWhatsAppPrePlainText(preText);
    const body = extractWhatsAppBodyFromPreElement(el);
    if (!body) return;

    if (shouldFilterSidebarPreview(body, sidebarSnippets, el)) {
      filteredSidebar += 1;
      return;
    }

    if (seenText.has(body)) return;
    seenText.add(body);

    const isOut = isWhatsAppOutgoingElement(el);
    const label = isOut ? 'You' : sender || 'Contact';
    const line = timestamp ? `[${label} @ ${timestamp}] ${body}` : `[${label}] ${body}`;
    lines.push(line);
  });

  return {
    text: lines.join('\n').trim(),
    filteredSidebar,
    bubbleCount: lines.length,
    method: 'pre-plain-text'
  };
}

/** Last resort: any message text visible inside #main (chat open, selectors changed). */
function extractWhatsAppMainFallback(main) {
  if (!main) return { text: '', bubbleCount: 0, method: 'main-fallback' };

  const lines = [];
  const seen = new Set();

  const addLine = (body, isOut) => {
    const t = (body || '').replace(/\s+/g, ' ').trim();
    if (!t || isWhatsAppSystemText(t) || seen.has(t)) return;
    seen.add(t);
    lines.push(`[${isOut ? 'You' : 'Contact'}] ${t}`);
  };

  main.querySelectorAll('[data-pre-plain-text]').forEach((el) => {
    if (!isInWhatsAppMainPanel(el)) return;
    addLine(extractWhatsAppBodyFromPreElement(el), isWhatsAppOutgoingElement(el));
  });

  if (!lines.length) {
    main
      .querySelectorAll(
        '[data-testid="msg-container"], .message-in, .message-out, [role="row"]'
      )
      .forEach((bubble) => {
        if (!isInWhatsAppMainPanel(bubble)) return;
        const msgText = getWhatsAppBubbleText(bubble);
        if (!msgText) return;
        const isOut =
          bubble.classList.contains('message-out') ||
          !!bubble.querySelector('.message-out');
        addLine(msgText, isOut);
      });
  }

  if (!lines.length) {
    main.querySelectorAll('[data-testid="selectable-text"], .selectable-text').forEach((el) => {
      if (!isInWhatsAppMainPanel(el)) return;
      if (el.closest('header') || el.closest('[data-testid="compose-box"]')) return;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 2) return;
      const isOut = !!el.closest('.message-out');
      addLine(t, isOut);
    });
  }

  return {
    text: lines.join('\n').trim(),
    bubbleCount: lines.length,
    method: 'main-fallback'
  };
}

function getWhatsAppMessageBubbles(main) {
  const scrollArea = getWhatsAppMessageScrollArea(main) || main;
  if (!scrollArea) return [];

  let raw = scrollArea.querySelectorAll('[data-testid="msg-container"]');
  if (!raw.length) {
    raw = scrollArea.querySelectorAll('.message-in, .message-out');
  }
  if (!raw.length) {
    raw = scrollArea.querySelectorAll('[data-pre-plain-text]');
  }

  const bubbles = Array.from(raw).filter((bubble) => {
    if (!main.contains(bubble)) return false;
    return isInWhatsAppMainPanel(bubble);
  });

  bubbles.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  return bubbles;
}

function extractWhatsAppChatText(main) {
  const panel = getWhatsAppActiveConversationPanel(main);
  const fromPre = extractWhatsAppFromPrePlainText(main, panel);
  if (fromPre.text) return fromPre;

  const fromMainPre = extractWhatsAppFromPrePlainText(main, main);
  if (fromMainPre.text) return { ...fromMainPre, method: 'pre-plain-text-main' };

  const bubbles = getWhatsAppMessageBubbles(main);
  const sidebarSnippets = collectWhatsAppSidebarPreviewTexts();
  const lines = [];
  const seen = new Set();
  let filteredSidebar = 0;

  bubbles.forEach((bubble) => {
    let msgText = getWhatsAppBubbleText(bubble);
    if (!msgText && bubble.hasAttribute?.('data-pre-plain-text')) {
      msgText = extractWhatsAppBodyFromPreElement(bubble);
    }
    if (!msgText || seen.has(msgText)) return;

    if (shouldFilterSidebarPreview(msgText, sidebarSnippets, bubble)) {
      filteredSidebar += 1;
      return;
    }

    seen.add(msgText);

    let senderLabel = 'Message';
    if (bubble.classList.contains('message-out')) {
      senderLabel = 'You';
    } else if (bubble.classList.contains('message-in')) {
      senderLabel = 'Contact';
    }

    lines.push(`[${senderLabel}] ${msgText}`);
  });

  if (lines.length) {
    return {
      text: lines.join('\n').trim(),
      filteredSidebar,
      bubbleCount: lines.length,
      method: 'bubbles'
    };
  }

  return extractWhatsAppMainFallback(main);
}

function getWhatsAppBubbleText(bubble) {
  const spans = bubble.querySelectorAll(
    'span[data-testid="selectable-text"], span[data-pre-key-whitespace], span.selectable-text.copyable-text, span.selectable-text'
  );
  const parts = [];
  spans.forEach((s) => {
    if (isInsideWhatsAppSidebar(s)) return;
    const t = (s.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (parts.length && parts[parts.length - 1] === t) return;
    parts.push(t);
  });

  if (parts.length) {
    return parts.join(' ').trim();
  }

  const copyable = bubble.querySelector('.copyable-text');
  if (copyable) {
    return (copyable.textContent || '').replace(/\s+/g, ' ').trim();
  }

  return '';
}

function getWhatsAppContactName(main) {
  if (!main) return '';

  const header = main.querySelector('header');
  if (!header) return '';

  const titled = header.querySelector('span[title]');
  if (titled) {
    const name = (titled.getAttribute('title') || titled.textContent || '').trim();
    if (name && name.length < 120) return name;
  }

  const infoHeader = header.querySelector('[data-testid="conversation-info-header"]');
  if (infoHeader) {
    const t = infoHeader.textContent?.replace(/\s+/g, ' ').trim();
    if (t && t.length < 120) return t;
  }

  return '';
}

function extractWhatsAppFocused() {
  const main = getWhatsAppMainPanel();

  if (!main || !isElementVisible(main)) {
    return {
      text: '',
      context: '',
      message_count: 0,
      scan_description: 'Open a chat on the right side of WhatsApp Web, then scan again.'
    };
  }

  const contact = getWhatsAppSelectedChatName(main);
  const extracted = extractWhatsAppChatText(main);
  const text = extracted.text;
  const panel = getWhatsAppActiveConversationPanel(main);

  const scan_description = 'WhatsApp · Active chat';

  if (!text) {
    const hasOpenChat = !!(contact || panel || main.querySelector('header'));
    return {
      text: '',
      context: contact ? `chat with ${contact}` : 'active chat',
      message_count: 0,
      scan_description: hasOpenChat
        ? 'No messages found in this chat. Scroll up to load history, then scan again.'
        : 'Open a chat on the right side of WhatsApp Web, then scan again.'
    };
  }

  const normalizedMessages = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  const header =
    `=== WhatsApp chat: "${contact || 'active chat'}" ===\n` +
    `The lines below are the ONLY messages from this open chat (${extracted.method || 'unknown'}). ` +
    `Your summary must describe only what appears in these lines. ` +
    `If payment, QR code, or phishing links are not written below, do not mention them.\n\n`;

  return {
    text: header + normalizedMessages,
    preview_text: buildUserPreview(normalizedMessages, { maxLines: 3 }),
    context: contact ? `chat with ${contact}` : 'active chat',
    message_count: extracted.bubbleCount || 0,
    scan_description,
    scan_source_title: contact || '',
    sidebar_filtered: extracted.filteredSidebar || 0,
    extraction_method: extracted.method || ''
  };
}

/** Gmail: open message body only — not the inbox list */
function extractGmailOpenEmail() {
  const subject = document.querySelector('h2.hP')?.innerText?.replace(/\s+/g, ' ').trim() || '';
  const bodyEl = document.querySelector('div.a3s.aiL');
  const body = bodyEl ? (bodyEl.innerText || '').trim() : '';

  if (!body) {
    return {
      text: '',
      context: '',
      scan_description: 'No open email — open a message in Gmail to scan its body.'
    };
  }

  const combined = (subject ? `Subject: ${subject}\n\n` : '') + body;
  const bodyPreview = body.replace(/\s+/g, ' ').trim();

  return {
    text: combined,
    preview_text: bodyPreview,
    context: subject || 'open email',
    scan_source_title: subject || '',
    scan_description: 'Gmail · Open email'
  };
}

/** LinkedIn: messaging thread, overlay chat, or job post */
function isLinkedInMessagingPage() {
  const path = window.location.pathname || '';
  return (
    path.includes('/messaging') ||
    path.includes('/inbox') ||
    !!document.querySelector(
      '.msg-thread, .msg-s-message-list, .msg-overlay-conversation-bubble--is-active, .msg-s-message-list-container'
    )
  );
}

function isLinkedInJobPage() {
  const path = window.location.pathname || '';
  return (
    /\/jobs(\/|$)/i.test(path) ||
    /\/job[-/]/i.test(path) ||
    !!findLinkedInJobContentElement()
  );
}

function getLinkedInConversationListRightEdge() {
  const list = document.querySelector(
    '.msg-conversations-container__conversations-list, .msg-conversations-container, [class*="msg-conversations-list"], .msg-conversations-container__pillar'
  );
  if (list) {
    const r = list.getBoundingClientRect();
    if (r.width > 0) return r.right;
  }
  return Math.floor(window.innerWidth * 0.36);
}

function isInLinkedInConversationList(el) {
  if (!el) return false;
  if (el.closest('.msg-s-message-list, .msg-thread, .msg-overlay-conversation-bubble')) {
    return false;
  }
  return !!(
    el.closest('.msg-conversations-container__conversations-list') ||
    el.closest('[data-control-name="conversation_list"]') ||
    (el.closest('.msg-conversation-listitem') &&
      !el.closest('.msg-s-message-list-container, .msg-thread'))
  );
}

/** Job description panel — never treat as a message thread. */
function isInsideLinkedInJobPanel(el) {
  if (!el) return false;
  return !!el.closest(
    '.jobs-description__content, .jobs-box__html-content, .jobs-details__main-content, ' +
      '.jobs-details__html-content, .jobs-search__job-details, .job-view-layout, ' +
      '.jobs-description-content, .jobs-description-content__text, .show-more-less-html__markup, ' +
      '#job-details, .jobs-details-top-card, .jobs-details__content, ' +
      '[class*="jobs-description"], [class*="job-details"], article.jobs-description__container'
  );
}

function isLinkedInJobsUrl() {
  const path = window.location.pathname || '';
  return /\/jobs(\/|$)/i.test(path) || /\/job[-/]/i.test(path);
}

function getLinkedInJobIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('currentJobId') || params.get('jobId');
  if (fromQuery) return fromQuery;
  const m = (window.location.pathname || '').match(/\/jobs\/view\/(\d+)/i);
  return m ? m[1] : '';
}

function shouldRetryLinkedInJobExtract(data) {
  if (!window.location.hostname.includes('linkedin.com')) return false;
  if (!isLinkedInJobsUrl()) return false;
  return !data?.text?.trim();
}

function shouldRetryLinkedInMessagingExtract(data) {
  if (!window.location.hostname.includes('linkedin.com')) return false;
  if (data?.text?.trim()) return false;
  if (isLinkedInJobsUrl() && isLinkedInJobContext()) return false;
  return !!(
    window.location.pathname.includes('/messaging') ||
    getLinkedInActiveContactName() ||
    document.querySelector('.msg-s-message-list, .msg-thread')
  );
}

function isLinkedInJobContext() {
  const path = window.location.pathname || '';
  if (path.includes('/messaging')) return false;

  if (isLinkedInJobsUrl()) {
    if (getLinkedInJobIdFromUrl()) return true;
    const body = extractLinkedInJobBodyText(findLinkedInJobContentElement());
    return body.length >= 25;
  }

  const jobEl = findLinkedInJobContentElement();
  if (!jobEl) return false;
  return extractLinkedInJobBodyText(jobEl).length >= 25;
}

/** Click "Show more" so full job description is in the DOM (LinkedIn truncates by default). */
function expandLinkedInJobDescription() {
  const buttons = document.querySelectorAll(
    '.jobs-description__footer-button, ' +
      "[data-tracking-control-name='public_jobs_show-more-html-btn'], " +
      '.jobs-description-content__text button, ' +
      'button[aria-label*="more" i], button[aria-label*="Show more" i]'
  );
  for (const btn of buttons) {
    if (!isElementVisible(btn)) continue;
    try {
      btn.click();
    } catch {
      /* ignore */
    }
  }

  const scope = getLinkedInJobDetailsRoot();
  scope.querySelectorAll('.jobs-description span, .jobs-description-content__text span, #job-details span').forEach((span) => {
    if (span.children.length > 0) return;
    if (/^…?more$/i.test((span.textContent || '').trim())) {
      try {
        (span.parentElement || span).click();
      } catch {
        /* ignore */
      }
    }
  });
}

function getLinkedInJobDetailsRoot() {
  const roots = [
    document.querySelector('.jobs-search__job-details--container'),
    document.querySelector('.jobs-search__job-details'),
    document.querySelector('.jobs-details__main-content'),
    document.querySelector('.jobs-details'),
    document.querySelector('.job-view-layout'),
    document.querySelector('[data-view-name="job-detail-page"]'),
    document.querySelector('div[data-job-id]'),
    document.querySelector('main.scaffold-layout__main'),
    document.querySelector('main')
  ];
  return roots.find((r) => r && isElementVisible(r)) || document;
}

function getLinkedInJobDetailPanels() {
  const seen = new Set();
  const panels = [];
  const selectors = [
    '.jobs-search__job-details--container',
    '.jobs-search__job-details',
    '.jobs-details',
    '.job-view-layout',
    '[data-view-name="job-detail-page"]',
    'div[data-job-id]'
  ];
  selectors.forEach((sel) => {
    document.querySelectorAll(sel).forEach((el) => {
      if (!isElementVisible(el) || seen.has(el)) return;
      seen.add(el);
      panels.push(el);
    });
  });
  if (!panels.length) {
    const root = getLinkedInJobDetailsRoot();
    if (root) panels.push(root);
  }
  return panels;
}

/** Read full description from the job details column (search split-view or /jobs/view/). */
function extractLinkedInJobPanelText(panel) {
  if (!panel) return '';

  const markup = panel.querySelector(
    '.show-more-less-html__markup, .jobs-description-content__text--stretch, .jobs-description-content__text'
  );
  if (markup) {
    const t = (markup.innerText || markup.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length > 15) return t;
  }

  const descBlocks = panel.querySelectorAll(
    '.jobs-description__content, .jobs-box__html-content, .jobs-details-about-the-job-module__content, ' +
      '#job-details, article.jobs-description__container, .core-section-container__content'
  );
  let combined = '';
  descBlocks.forEach((el) => {
    const t = getLinkedInJobTextFromElement(el);
    if (t.length > combined.length) combined = t;
  });
  if (combined.length > 15) return combined;

  const clone = panel.cloneNode(true);
  clone
    .querySelectorAll(
      'button, [role="button"], .jobs-save-button, .job-details-connections__connections-wrapper, ' +
        'nav, header, .msg-overlay-bubble, .jobs-semantic-search-module'
    )
    .forEach((n) => n.remove());

  let raw = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
  const title = getLinkedInJobTitle();
  if (title && raw.toLowerCase().startsWith(title.toLowerCase())) {
    raw = raw.slice(title.length).replace(/^[\s|·-]+/, '').trim();
  }

  const noise =
    /^(about the job|job description|show more|see more|easy apply|save|share|report)$/i;
  if (noise.test(raw)) return '';

  return raw;
}

function extractLinkedInJobBodyText(jobEl) {
  expandLinkedInJobDescription();

  let best = '';

  getLinkedInJobDetailPanels().forEach((panel) => {
    const t = extractLinkedInJobPanelText(panel);
    if (t.length > best.length) best = t;
  });

  const markupSelectors = [
    '.show-more-less-html__markup',
    '.jobs-description-content__text--stretch',
    '.jobs-description-content__text',
    '.jobs-box__html-content',
    '.jobs-description__content',
    '.jobs-details__main-content',
    'article.jobs-description__container',
    '.core-section-container__content',
    '.jobs-description',
    '#job-details',
    '[class*="jobs-description"]'
  ];

  const searchRoots = [jobEl, getLinkedInJobDetailsRoot(), document].filter(Boolean);
  const seenRoots = new Set();

  for (const root of searchRoots) {
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);

    for (const sel of markupSelectors) {
      root.querySelectorAll(sel).forEach((el) => {
        if (!isElementVisible(el)) return;
        const t = getLinkedInJobTextFromElement(el) || (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t.length > best.length) best = t;
      });
    }
  }

  if (best.length >= 12) return best;
  if (jobEl) return getLinkedInJobTextFromElement(jobEl);
  return best;
}

function getLinkedInJobTextFromElement(el) {
  if (!el) return '';
  const markup =
    el.querySelector?.('.show-more-less-html__markup') ||
    (el.classList?.contains('show-more-less-html__markup') ? el : null);
  return (markup?.innerText || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
}

function isInLinkedInMessagePanel(el) {
  if (!el) return false;
  if (isInsideLinkedInJobPanel(el)) return false;
  if (el.closest('#global-nav, .global-nav, nav.global-nav')) return false;
  if (isInLinkedInConversationList(el)) return false;
  if (el.closest('[contenteditable="true"]') && !el.closest('.msg-s-event-listitem')) {
    return false;
  }
  if (
    el.closest(
      '.msg-thread, .msg-s-message-list, .msg-s-message-list-container, ' +
        '.msg-overlay-conversation-bubble, .msg-conversation-panel, .msg-s-event-listitem'
    )
  ) {
    return isElementVisible(el);
  }
  const r = el.getBoundingClientRect();
  return r.width > 4 && r.left >= getLinkedInConversationListRightEdge() - 24;
}

function isInLinkedInActiveThread(el) {
  return isInLinkedInMessagePanel(el);
}

function isLinkedInUiNoiseLine(line) {
  const t = line.trim();
  if (t.length < 2) return true;
  const noise =
    /^(write a message|write a message\.\.\.|search messages|messaging|linkedin|focused|other|page inboxes|drafts|sent|starred|archived|spam|trash|sponsored|new message|active now|click to reply|reply to conversation)$/i;
  if (noise.test(t)) return true;
  if (/^\d{1,2}:\d{2}\s*(AM|PM)?$/i.test(t)) return true;
  if (/^\d+\s*(min|hr|d|w|mo|yr)s?\s*ago$/i.test(t)) return true;
  if (/^·\s*\d+\s*(min|hr|d|w|mo|yr)/i.test(t)) return true;
  return false;
}

function getLinkedInActiveContactName() {
  const activeListSelectors = [
    '.msg-conversation-listitem--active .msg-conversation-listitem__participant-names',
    '.msg-conversation-listitem--active h3',
    '.msg-conversations-container__conversations-list li[aria-current="true"] h3',
    '.msg-conversations-container__conversations-list li[aria-current="true"] .msg-conversation-listitem__participant-names',
    '.msg-conversations-container__conversations-list li.msg-conversation-listitem--active h3'
  ];
  for (const sel of activeListSelectors) {
    const el = document.querySelector(sel);
    const name = (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    if (name && name.length > 0 && name.length < 120 && !/^messaging$/i.test(name)) return name;
  }

  const headerSelectors = [
    '.msg-thread__link',
    '.msg-title-bar .msg-entity-lockup__entity-title',
    '.msg-entity-lockup__entity-title-wrapper h2',
    '.msg-entity-lockup__entity-title',
    '.msg-entity-lockup__title',
    '.msg-overlay-bubble-header__title h2',
    '.msg-overlay-bubble-header__title',
    '.msg-thread h2',
    '.msg-thread header [title]',
    '[data-control-name="conversation_view"] h2'
  ];
  for (const sel of headerSelectors) {
    const el = document.querySelector(sel);
    const name = (el?.getAttribute?.('title') || el?.innerText || el?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (name && name.length > 0 && name.length < 120 && !/^messaging$/i.test(name)) return name;
  }
  return '';
}

function findLinkedInJobContentElement() {
  expandLinkedInJobDescription();

  let best = null;
  let bestLen = 0;

  getLinkedInJobDetailPanels().forEach((panel) => {
    const t = extractLinkedInJobPanelText(panel);
    if (t.length > bestLen) {
      bestLen = t.length;
      best = panel;
    }
  });

  const selectors = [
    '.show-more-less-html__markup',
    '.jobs-description-content__text',
    '.jobs-description__content',
    '.jobs-box__html-content',
    '#job-details',
    'article.jobs-description__container'
  ];

  const root = getLinkedInJobDetailsRoot();
  for (const sel of selectors) {
    root.querySelectorAll(sel).forEach((el) => {
      if (!isElementVisible(el)) return;
      const t = getLinkedInJobTextFromElement(el);
      if (t.length > bestLen && t.length >= 12) {
        best = el;
        bestLen = t.length;
      }
    });
  }

  return best;
}

function getLinkedInJobTitle() {
  const root = getLinkedInJobDetailsRoot();
  const selectors = [
    '.job-details-jobs-unified-top-card__job-title h1',
    '.job-details-jobs-unified-top-card__job-title',
    '.jobs-unified-top-card__job-title',
    '.jobs-details-top-card__job-title',
    '.jobs-search__job-details h2',
    '.jobs-search__job-details h1',
    '.job-view-layout h1',
    '.jobs-details h1',
    '.jobs-details-top-card__job-title-link',
    'main h1.t-24',
    '[data-job-id] h1',
    '.jobs-details h2'
  ];
  for (const sel of selectors) {
    const el = root.querySelector(sel) || document.querySelector(sel);
    const title = (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    if (
      title &&
      title.length > 2 &&
      title.length < 200 &&
      !/^(linkedin|jobs|job search)$/i.test(title)
    ) {
      return title;
    }
  }
  return '';
}

function getLinkedInMessageSenderLabel(eventEl) {
  const nameEl = eventEl.querySelector(
    '.msg-s-message-group__name, .msg-s-message-group__profile-link span, .msg-s-message-group__author, .msg-s-event-listitem__name'
  );
  let name = (nameEl?.innerText || nameEl?.textContent || '').replace(/\s+/g, ' ').trim();

  const isYou =
    !!eventEl.querySelector(
      '.msg-s-event-listitem--outbound, .msg-s-message-group--self, [data-sender="self"]'
    ) ||
    !!eventEl.closest('.msg-s-message-group--self') ||
    /^you$/i.test(name);

  if (isYou) return 'You';
  if (name && name.length < 80) return name;
  return 'Contact';
}

/** Structured message lines from the open thread (not the left inbox list). */
function extractLinkedInMessageLines(panel) {
  if (!panel) return [];

  const lines = [];
  const seen = new Set();

  const pushLine = (body, sender, el) => {
    const t = (body || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length < 2 || seen.has(t)) return;
    if (!isInLinkedInActiveThread(el)) return;
    if (isLinkedInUiNoiseLine(t)) return;
    seen.add(t);
    const who = sender || 'Contact';
    lines.push(`${who}: ${t}`);
  };

  const events = panel.querySelectorAll(
    '.msg-s-message-list__event, li.msg-s-event-listitem, [data-event-urn*="message"]'
  );

  events.forEach((event) => {
    if (!isInLinkedInActiveThread(event)) return;
    const bodies = event.querySelectorAll(
      '.msg-s-event-listitem__body, .msg-s-event__content, .msg-s-message-group__content p, .msg-s-event-listitem__message-bubble p'
    );
    const sender = getLinkedInMessageSenderLabel(event);
    if (bodies.length) {
      bodies.forEach((bodyEl) => pushLine(bodyEl.innerText || bodyEl.textContent, sender, bodyEl));
      return;
    }
    const fallback = (event.innerText || '').replace(/\s+/g, ' ').trim();
    if (fallback.length > 2 && fallback.length < 2000) {
      pushLine(fallback, sender, event);
    }
  });

  if (lines.length) return lines;

  const bodySelectors = [
    '.msg-s-message-list__event [data-event-urn] p',
    '[data-event-urn] p',
    '.msg-s-event-listitem__body',
    '.msg-s-message-group__content',
    '.msg-s-event__content'
  ];

  for (const sel of bodySelectors) {
    panel.querySelectorAll(sel).forEach((el) => {
      if (!isInLinkedInActiveThread(el)) return;
      pushLine(el.innerText || el.textContent, 'Contact', el);
    });
    if (lines.length) break;
  }

  if (!lines.length && panel.matches?.('.msg-thread, .msg-s-message-list, .msg-s-message-list-container')) {
    panel
      .querySelectorAll(
        '.msg-s-event-listitem__body, .msg-s-event-listitem__message-bubble, .msg-s-event__content, p'
      )
      .forEach((el) => {
        if (el.closest('.msg-conversations-container__conversations-list')) return;
        pushLine(el.innerText || el.textContent, 'Contact', el);
      });
  }

  return lines;
}

/** Last resort: all visible message bodies on page (excluding left inbox list). */
function extractLinkedInMessagesDocumentFallback() {
  const lines = [];
  const seen = new Set();

  const selectors = [
    '.msg-s-event-listitem__body',
    '.msg-s-event-listitem__message-bubble',
    '.msg-s-event__content',
    '.msg-s-message-group__content p',
    '[data-event-urn] p'
  ];

  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach((el) => {
      if (!isInLinkedInMessagePanel(el)) return;
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 2 || t.length > 3000 || seen.has(t)) return;
      if (isLinkedInUiNoiseLine(t)) return;
      seen.add(t);
      lines.push(`Contact: ${t}`);
    });
    if (lines.length) break;
  }

  return lines;
}

/** Fallback: read visible text from the open thread column (sponsored / ad threads). */
function extractLinkedInThreadFallback() {
  if (isLinkedInJobContext()) return '';

  const roots = [
    document.querySelector('.msg-thread'),
    document.querySelector('.msg-s-message-list'),
    document.querySelector('[data-testid="message-thread"]'),
    document.querySelector('.msg-s-message-list-container'),
    document.querySelector('.msg-overlay-conversation-bubble--is-active'),
    document.querySelector('main.scaffold-layout__main'),
    document.querySelector('main')
  ].filter(Boolean);

  const root = roots.find((r) => isElementVisible(r) && extractLinkedInMessageLines(r).length > 0) || roots[0];
  if (!root) return '';

  const structured = extractLinkedInMessageLines(root);
  if (structured.length) return structured.join('\n');

  const lines = [];
  const seen = new Set();

  root.querySelectorAll('p, span[dir="ltr"], div[dir="ltr"]').forEach((el) => {
    if (!isInLinkedInActiveThread(el)) return;
    if (el.closest('footer') || el.closest('[contenteditable="true"]')) return;

    const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length < 8 || t.length > 1500 || seen.has(t)) return;
    if (isLinkedInUiNoiseLine(t)) return;

    seen.add(t);
    lines.push(`Contact: ${t}`);
  });

  return lines.join('\n').trim();
}

function findLinkedInThreadByViewport() {
  const xPositions = [0.68, 0.58, 0.78];
  const yPositions = [0.4, 0.55, 0.7];

  for (const xPct of xPositions) {
    for (const yPct of yPositions) {
      const x = Math.floor(window.innerWidth * xPct);
      const y = Math.floor(window.innerHeight * yPct);
      let el = document.elementFromPoint(x, y);
      while (el && el !== document.body) {
        if (
          el.classList?.contains('msg-s-message-list') ||
          el.classList?.contains('msg-thread') ||
          el.querySelector?.('.msg-s-message-list__event, [data-event-urn]')
        ) {
          const root =
            el.closest('.msg-s-message-list') ||
            el.closest('.msg-thread') ||
            el.closest('main') ||
            el;
          if (isElementVisible(root)) return root;
        }
        el = el.parentElement;
      }
    }
  }
  return null;
}

function getLinkedInMessagingPanel() {
  if (isLinkedInJobContext() && !isLinkedInMessagingPage()) {
    const overlay = document.querySelector(
      '.msg-overlay-conversation-bubble--is-active, .msg-overlay-conversation-bubble'
    );
    if (overlay && extractLinkedInMessageLines(overlay).length > 0) {
      return overlay;
    }
    return null;
  }

  const panelSelectors = [
    '.msg-overlay-conversation-bubble--is-active',
    '.msg-s-message-list--is-visible',
    '.msg-thread--active',
    '.msg-s-message-list',
    '.msg-s-message-list-content',
    '.msg-s-message-list-container',
    '.msg-overlay-conversation-bubble',
    '.msg-convo-wrapper',
    'main .msg-thread',
    '.scaffold-layout__main .msg-thread',
    'div.msg-thread'
  ];

  let best = null;
  let bestCount = 0;

  for (const sel of panelSelectors) {
    document.querySelectorAll(sel).forEach((el) => {
      if (!isElementVisible(el)) return;
      if (isInsideLinkedInJobPanel(el)) return;
      const count = extractLinkedInMessageLines(el).length;
      if (count > bestCount) {
        best = el;
        bestCount = count;
      }
    });
  }

  if (best) return best;

  if (isLinkedInMessagingPage() && !isLinkedInJobContext()) {
    const main = document.querySelector('main.scaffold-layout__main, main');
    if (main && isElementVisible(main) && !isInsideLinkedInJobPanel(main)) {
      const count = extractLinkedInMessageLines(main).length;
      if (count > 0) return main;
    }
  }

  return findLinkedInThreadByViewport();
}

function extractLinkedInMessages(panel) {
  return extractLinkedInMessageLines(panel).join('\n').trim();
}

function detectLinkedInViewMode() {
  const path = window.location.pathname || '';

  if (path.includes('/messaging')) {
    const panel = getLinkedInMessagingPanel();
    const hasMessages = panel ? extractLinkedInMessageLines(panel).length > 0 : false;
    return hasMessages ? 'messaging' : 'messaging-empty';
  }

  if (isLinkedInJobContext() || (isLinkedInJobsUrl() && getLinkedInJobIdFromUrl())) {
    return 'job';
  }

  const panel = getLinkedInMessagingPanel();
  const hasMessages = panel ? extractLinkedInMessageLines(panel).length > 0 : false;
  if (hasMessages) return 'messaging';

  const jobEl = findLinkedInJobContentElement();
  if (jobEl && (jobEl.innerText || '').trim().length > 40) return 'job';

  return 'none';
}

function extractLinkedInJobPost() {
  expandLinkedInJobDescription();

  const jobEl = findLinkedInJobContentElement();
  const jobBody = extractLinkedInJobBodyText(jobEl);
  const minLen = getLinkedInJobIdFromUrl() ? 15 : 25;

  if (jobBody.length < minLen) {
    if (isLinkedInJobsUrl()) {
      const title = getLinkedInJobTitle();
      const hasJobId = !!getLinkedInJobIdFromUrl();
      return {
        text: '',
        context: title ? `job post: ${title}` : '',
        scan_description: 'LinkedIn · Job post',
        scan_source_title: title || '',
        linkedin_content_type: 'job',
        extraction_hint: hasJobId
          ? 'Job is loading. Wait a few seconds, click “Show more” on the description if shown, then scan again.'
          : 'Select a job from the list, wait for the description to load, then scan again.'
      };
    }
    return null;
  }

  const jobTitle = getLinkedInJobTitle();
  const header =
    `=== LinkedIn job${jobTitle ? `: "${jobTitle}"` : ''} ===\n` +
    'Analyze ONLY this job description text.\n\n';

  return {
    text: header + jobBody,
    preview_text: buildUserPreview(jobBody, { maxLines: 2, maxChars: 200 }),
    context: jobTitle ? `job post: ${jobTitle}` : 'job description',
    scan_description: 'LinkedIn · Job post',
    scan_source_title: jobTitle || 'Job description',
    linkedin_content_type: 'job',
    message_count: 0,
    extraction_method: 'job-description'
  };
}

function extractLinkedInMessaging() {
  if (isLinkedInJobContext() && !isLinkedInMessagingPage()) {
    return { text: '', context: '', scan_description: '', linkedin_content_type: 'messaging' };
  }

  const panel = getLinkedInMessagingPanel();
  const contactName = getLinkedInActiveContactName();
  let text = panel ? extractLinkedInMessages(panel) : '';
  let method = 'linkedin-messages';

  if (!text && isLinkedInMessagingPage()) {
    const main = document.querySelector('main.scaffold-layout__main, main');
    if (main && !isInsideLinkedInJobPanel(main)) {
      text = extractLinkedInMessages(main);
      if (text) method = 'linkedin-messages-main';
    }
  }

  if (!text) {
    text = extractLinkedInThreadFallback();
    method = 'linkedin-thread-fallback';
  }

  if (!text) {
    const docLines = extractLinkedInMessagesDocumentFallback();
    if (docLines.length) {
      text = docLines.join('\n');
      method = 'linkedin-document-fallback';
    }
  }

  if (!text) {
    const onMessaging = isLinkedInMessagingPage();
    return {
      text: '',
      context: contactName ? `chat with ${contactName}` : '',
      scan_description: onMessaging
        ? 'LinkedIn · Messages'
        : 'LinkedIn · Messages (not detected)',
      scan_source_title: contactName || '',
      linkedin_content_type: 'messaging',
      extraction_hint:
        'Could not read messages. Click a conversation on the right, scroll the thread, then scan again.'
    };
  }

  const messageLines = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1);

  const normalizedMessages = messageLines.join('\n');

  const header =
    `=== LinkedIn conversation${contactName ? `: "${contactName}"` : ''} ===\n` +
    'Analyze ONLY these message lines.\n\n';

  return {
    text: header + normalizedMessages,
    preview_text: buildUserPreview(normalizedMessages, { maxLines: 3 }),
    context: contactName ? `chat with ${contactName}` : 'messages',
    message_count: messageLines.length,
    scan_description: 'LinkedIn · Messages',
    scan_source_title: contactName || 'Conversation',
    linkedin_content_type: 'messaging',
    extraction_method: method
  };
}

function extractLinkedInFocused() {
  if (isLinkedInJobsUrl()) {
    const job = extractLinkedInJobPost();
    if (job?.text) return job;
    if (job && job.linkedin_content_type === 'job') return job;
  }

  if (isLinkedInJobContext()) {
    const job = extractLinkedInJobPost();
    if (job?.text) return job;
  }

  const mode = detectLinkedInViewMode();

  if (mode === 'job') {
    const job = extractLinkedInJobPost();
    if (job?.text) return job;
    if (job?.linkedin_content_type === 'job') return job;
  }

  const messaging = extractLinkedInMessaging();
  if (messaging.text) return messaging;

  if (mode === 'job') {
    const job = extractLinkedInJobPost();
    if (job?.text) return job;
    if (job?.linkedin_content_type === 'job') return job;
  }

  if (mode === 'messaging' || mode === 'messaging-empty') {
    const contact = getLinkedInActiveContactName();
    const hint = messaging.extraction_hint || '';
    return {
      text: '',
      context: contact ? `chat with ${contact}` : '',
      scan_description: 'LinkedIn · Messages',
      scan_source_title: contact || '',
      linkedin_content_type: 'messaging',
      extraction_hint:
        hint ||
        'Click a conversation on the right, scroll the thread so messages load, then scan again.'
    };
  }

  return {
    text: '',
    context: '',
    scan_description:
      'LinkedIn: open Messaging and select a chat, or open a Job posting, then scan.',
    linkedin_content_type: 'none'
  };
}

/** Telegram Web: active chat bubbles only */
function extractTelegramActiveChat() {
  const activeChat =
    document.querySelector('.bubbles-inner') || document.querySelector('.messages-container');
  if (!activeChat) {
    return {
      text: '',
      context: '',
      scan_description: 'Open a Telegram chat to scan messages.'
    };
  }

  const lines = [];
  activeChat.querySelectorAll('.message .text, .im_message_text, .message-text').forEach((el) => {
    const t = (el.innerText || '').trim();
    if (t) lines.push(t);
  });

  const text = lines.join('\n').trim();
  const contactName = document.querySelector('.chat-info .title')?.innerText?.trim() || '';

  const normalizedMessages = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  return {
    text: normalizedMessages,
    preview_text: buildUserPreview(normalizedMessages, { maxLines: 3 }),
    context: contactName ? `chat with ${contactName}` : 'active chat',
    scan_description: 'Telegram · Active chat',
    scan_source_title: contactName || ''
  };
}

/**
 * When no site-specific region applies: approximate "what the user is looking at"
 * using the viewport center, then trim long text to a window around the middle.
 */
function extractViewportFocusedText(maxLen = 4000) {
  const x = Math.floor(window.innerWidth / 2);
  const y = Math.floor(window.innerHeight / 2);
  let el = document.elementFromPoint(x, y);

  if (!el) {
    return trimBodyToWindow((document.body.innerText || '').trim(), maxLen);
  }

  let best = '';
  let node = el;
  while (node && node !== document.documentElement) {
    if (node.nodeType === Node.ELEMENT_NODE && typeof node.innerText === 'string') {
      const t = node.innerText.trim();
      if (t.length > best.length && t.length < 200000) {
        best = t;
      }
    }
    node = node.parentElement;
  }

  if (best.length < 40) {
    best = (document.body.innerText || '').trim();
  }

  return trimBodyToWindow(best, maxLen);
}

function trimBodyToWindow(fullText, maxLen) {
  let t = fullText.replace(/\s\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  const mid = Math.floor(t.length / 2);
  const half = Math.floor(maxLen / 2);
  return t.slice(Math.max(0, mid - half), mid + half).trim();
}

function extractPlatformSpecificText() {
  const host = window.location.hostname || '';
  let text = '';
  let platform = 'Web Page';
  let context = '';
  let scan_description = '';

  if (host.includes('web.whatsapp.com')) {
    platform = 'WhatsApp';
    const wa = extractWhatsAppFocused();
    return { ...wa, platform };
  }

  if (host.includes('mail.google.com')) {
    platform = 'Gmail';
    const g = extractGmailOpenEmail();
    text = g.text.replace(/[ \t\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { ...g, text, platform };
  }

  if (host.includes('linkedin.com')) {
    platform = 'LinkedIn';
    const li = extractLinkedInFocused();
    text = (li.text || '')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { ...li, text, platform };
  }

  if (host.includes('web.telegram.org')) {
    platform = 'Telegram';
    const tg = extractTelegramActiveChat();
    text = tg.text.replace(/[ \t\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { ...tg, text, platform };
  }

  // Other sites: viewport-focused excerpt (not guaranteed "one widget" but better than whole DOM)
  text = extractViewportFocusedText(4500);
  platform = 'Web Page';
  context = (document.title || 'viewport').trim();
  scan_description = `Web page · ${context || 'Visible content'}`;
  text = text.replace(/\s\s+/g, ' ').trim();

  return {
    text,
    platform,
    context,
    scan_description,
    scan_source_title: context,
    preview_text: text
  };
}

function removeExistingHighlights() {
  document.querySelectorAll('.scamradar-highlight').forEach((el) => {
    const parent = el.parentNode;
    if (!parent) return;
    const textNode = document.createTextNode(el.textContent || '');
    parent.replaceChild(textNode, el);
    parent.normalize();
  });
}

function removeWarningBadge() {
  const badge = document.querySelector('.scamradar-warning-badge');
  if (badge) {
    badge.remove();
  }
}

function showWarningBadge(score) {
  const badge = document.createElement('div');
  badge.className = 'scamradar-warning-badge';
  badge.textContent = `WARNING: Risk ${score}`;
  document.body.appendChild(badge);
}

function getHighlightSearchRoot() {
  if (window.location.hostname.includes('web.whatsapp.com')) {
    return getWhatsAppMainPanel() || document.body;
  }
  if (window.location.hostname.includes('linkedin.com')) {
    const job =
      document.querySelector('.jobs-description__content') ||
      document.querySelector('div.jobs-description__content');
    if (job && job.innerText.trim().length > 30) return job;
    return getLinkedInMessagingPanel() || document.body;
  }
  return document.body;
}

function highlightSentence(sentence) {
  const t = (sentence.text || '').trim();
  if (!t) {
    return;
  }

  const root = getHighlightSearchRoot();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
  let node;

  while ((node = walker.nextNode())) {
    const nodeText = node.textContent || '';
    const matchIndex = nodeText.indexOf(t);
    if (matchIndex !== -1) {
      wrapTextNode(node, t, sentence.reason || 'Dangerous content', sentence.manipulation_type || 'Unknown');
      break;
    }
  }
}

function wrapTextNode(textNode, sentenceText, reason, manipulationType) {
  const nodeText = textNode.textContent || '';
  const matchIndex = nodeText.indexOf(sentenceText);
  if (matchIndex === -1) {
    return;
  }

  const beforeText = nodeText.slice(0, matchIndex);
  const afterText = nodeText.slice(matchIndex + sentenceText.length);

  const wrapper = document.createElement('span');
  wrapper.className = 'scamradar-highlight';
  wrapper.textContent = sentenceText;
  wrapper.setAttribute('data-reason', reason);
  wrapper.setAttribute('data-type', manipulationType);

  const tooltip = document.createElement('span');
  tooltip.className = 'scamradar-tooltip';
  tooltip.textContent = `${manipulationType}: ${reason}`;
  wrapper.appendChild(tooltip);

  const fragment = document.createDocumentFragment();
  if (beforeText) {
    fragment.appendChild(document.createTextNode(beforeText));
  }
  fragment.appendChild(wrapper);
  if (afterText) {
    fragment.appendChild(document.createTextNode(afterText));
  }

  textNode.parentNode.replaceChild(fragment, textNode);
}
