/*
  PDF Read Aloud - Obsidian Plugin
  Features:
  - Play / Pause / Stop / Skip
  - Read from cursor position (click in PDF text layer → "Read from here")
  - Read selection only (select text → "Read selection")
  - Speed, pitch, volume, voice controls
  - Voice dropdown reloads on voiceschanged event
  - Follow-along highlighting: colors the sentence + current word being spoken
  - No innerHTML usage (XSS-safe)
*/

const { Plugin, PluginSettingTab, Setting, Notice, ItemView, Menu } = require('obsidian');

const VIEW_TYPE = 'pdf-read-aloud-controls';

const DEFAULT_SETTINGS = {
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
  voiceURI: '',
  skipSize: 5,
  highlightEnabled: true,
  autoScroll: true,
  sentenceColor: '#ffd000',
  sentenceOpacity: 0.5,
  wordColor: '#ff8200',
  wordOpacity: 0.8,
};

const HL_SENTENCE = 'pdf-read-aloud-sentence';
const HL_WORD = 'pdf-read-aloud-word';

class PdfReadAloudPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.synth = window.speechSynthesis;
    this.utterance = null;
    this.isPaused = false;
    this.isPlaying = false;
    this.sentences = [];
    this.currentIndex = 0;
    this.endIndex = -1;
    this.statusBarEl = null;
    this.mode = 'idle';
    this._pdfDoc = null;
    this._clickHandler = null;
    this._hlMatch = null;          // current sentence match in the text layer (for word highlighting)
    this._fallbackEls = { sentence: [], word: [] };
    this._styleEl = null;
    this._updateHighlightStyles();

    // Reload voice list whenever the browser finishes populating it
    this._voicesChangedHandler = () => this.refreshPanel();
    window.speechSynthesis.addEventListener('voiceschanged', this._voicesChangedHandler);

    this.registerView(VIEW_TYPE, (leaf) => new ControlPanelView(leaf, this));

    this.addRibbonIcon('volume-2', 'PDF Read Aloud', () => this.activateView());

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar('Idle');

    // ── Commands ────────────────────────────────────────────────────────────────
    this.addCommand({ id: 'play',         name: 'Play / Resume',         callback: () => this.play() });
    this.addCommand({ id: 'pause',        name: 'Pause',                 callback: () => this.pause() });
    this.addCommand({ id: 'stop',         name: 'Stop',                  callback: () => this.stop() });
    this.addCommand({ id: 'open-panel',   name: 'Open control panel',    callback: () => this.activateView() });
    this.addCommand({ id: 'read-selection', name: 'Read selected text',  callback: () => this.readSelection() });
    this.addCommand({ id: 'click-to-start', name: 'Enable click-to-start', callback: () => this.enableClickMode() });

    // Listen for right-click in PDF viewer to inject context menu items
    this.registerDomEvent(document, 'contextmenu', (evt) => this._onContextMenu(evt), true);

    this.addSettingTab(new PdfReadAloudSettingTab(this.app, this));
  }

  onunload() {
    this.stop();
    this._clearHighlights();
    if (this._styleEl) {
      this._styleEl.remove();
      this._styleEl = null;
    }
    this._detachClickHandler();
    if (this._voicesChangedHandler) {
      window.speechSynthesis.removeEventListener('voiceschanged', this._voicesChangedHandler);
    }
  }

  // ── View ─────────────────────────────────────────────────────────────────────

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  // ── PDF internals ─────────────────────────────────────────────────────────────

  _deepFind(obj, key, maxDepth = 8, _depth = 0, _seen = new WeakSet()) {
    if (_depth > maxDepth || obj === null || typeof obj !== 'object') return undefined;
    if (_seen.has(obj)) return undefined;
    _seen.add(obj);
    if (key in obj) return obj[key];
    for (const k of Object.keys(obj)) {
      const val = obj[k];
      // Only recurse into plain objects — skip DOM nodes, arrays of primitives, etc.
      if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof HTMLElement)) {
        try {
          const r = this._deepFind(val, key, maxDepth, _depth + 1, _seen);
          if (r !== undefined) return r;
        } catch (_) { /* ignore access errors on restricted properties */ }
      }
    }
  }

  _getPdfView() {
    const activeLeaf = this.app.workspace.activeLeaf;
    const leaves = this.app.workspace.getLeavesOfType('pdf');
    if (activeLeaf?.view?.getViewType?.() === 'pdf') return activeLeaf.view;
    if (leaves.length > 0) return leaves[0].view;
    return null;
  }

  async _getPdfDoc() {
    const view = this._getPdfView();
    if (!view) return null;

    // Try well-known paths first (fast)
    const doc =
      view?.viewer?.pdfViewer?.pdfDocument ||
      view?.viewer?.pdfViewer?._pdfDocument ||
      view?.pdfViewer?.pdfDocument ||
      view?.pdfViewer?._pdfDocument ||
      view?.viewer?.child?.pdfViewer?.pdfDocument ||
      view?.viewer?.child?.pdfViewer?._pdfDocument;
    if (doc) return doc;

    // Fallback: deep search (slower, but handles unusual internal structures)
    return this._deepFind(view, 'pdfDocument') ||
           this._deepFind(view, '_pdfDocument') ||
           null;
  }

  // Extract text from ALL pages, returning array of {pageNum, sentences[]}
  async _extractAllPages() {
    const pdfDoc = await this._getPdfDoc();
    if (!pdfDoc) {
      new Notice('Could not access PDF. Click on the PDF tab and wait for it to load fully.');
      return null;
    }

    new Notice('Extracting PDF text…');
    const numPages = pdfDoc.numPages;
    const allSentences = [];

    for (let i = 1; i <= numPages; i++) {
      try {
        const page = await pdfDoc.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
        if (!pageText) continue;
        const sentences = pageText
          .split(/(?<=[.!?])\s+/)
          .filter(s => s.trim().length > 2)
          .map(s => ({ text: s.trim(), page: i }));
        allSentences.push(...sentences);
      } catch (err) {
        console.warn(`PDF Read Aloud: error reading page ${i}`, err);
      }
    }

    if (allSentences.length === 0) {
      new Notice('No readable text found (may be a scanned/image PDF).');
      return null;
    }
    return allSentences;
  }

  // ── Context Menu injection ────────────────────────────────────────────────────

  _onContextMenu(evt) {
    const target = evt.target;
    if (!target.closest('.pdf-viewer, .pdfViewer, canvas, .textLayer')) return;

    const selection = window.getSelection()?.toString()?.trim();

    setTimeout(() => {
      const menu = new Menu();
      if (selection && selection.length > 0) {
        menu.addItem(item =>
          item.setTitle('Read selected text')
              .setIcon('volume-2')
              .onClick(() => this.readSelection())
        );
      }
      menu.addItem(item =>
        item.setTitle('Read from here')
            .setIcon('play')
            .onClick(() => this._readFromClick(evt))
      );
      menu.showAtMouseEvent(evt);
    }, 10);
  }

  // ── Click-to-start mode ───────────────────────────────────────────────────────

  enableClickMode() {
    new Notice('Click anywhere in the PDF text to start reading from there.', 4000);
    this._detachClickHandler();
    this._clickHandler = (evt) => {
      const target = evt.target;
      if (!target.closest('.pdf-viewer, .pdfViewer, canvas, .textLayer, .page')) return;
      evt.preventDefault();
      evt.stopPropagation();
      this._readFromClick(evt);
      this._detachClickHandler();
    };
    document.addEventListener('click', this._clickHandler, { capture: true, once: false });
  }

  _detachClickHandler() {
    if (this._clickHandler) {
      document.removeEventListener('click', this._clickHandler, true);
      this._clickHandler = null;
    }
  }

  async _readFromClick(evt) {
    let clickedText = '';

    const target = evt.target;
    if (target.tagName === 'SPAN' && target.textContent) {
      clickedText = target.textContent.trim();
    }

    if (!clickedText) {
      clickedText = window.getSelection()?.toString()?.trim() || '';
    }

    const sentences = await this._extractAllPages();
    if (!sentences) return;

    this.sentences = sentences;
    this._pdfDoc = null;

    let startIdx = 0;

    if (clickedText.length > 3) {
      const lower = clickedText.toLowerCase().slice(0, 60);
      let bestIdx = -1;
      let bestScore = 0;
      sentences.forEach((s, i) => {
        const st = s.text.toLowerCase();
        if (st.includes(lower) || lower.includes(st.slice(0, 30))) {
          const score = Math.min(lower.length, st.length);
          if (score > bestScore) { bestScore = score; bestIdx = i; }
        }
      });
      if (bestIdx >= 0) {
        startIdx = bestIdx;
        new Notice(`Starting from: "${sentences[startIdx].text.slice(0, 50)}…"`);
      } else {
        const words = lower.split(/\s+/).slice(0, 5);
        sentences.forEach((s, i) => {
          const st = s.text.toLowerCase();
          const hits = words.filter(w => st.includes(w)).length;
          if (hits > bestScore) { bestScore = hits; bestIdx = i; }
        });
        if (bestIdx >= 0 && bestScore >= 2) {
          startIdx = bestIdx;
          new Notice(`Starting near: "${sentences[startIdx].text.slice(0, 50)}…"`);
        } else {
          new Notice('Could not pinpoint location — starting from beginning of document.');
        }
      }
    } else {
      new Notice('Could not detect click location — starting from beginning.');
    }

    this.endIndex = -1;
    this._startPlayback(startIdx);
  }

  // ── Read Selection ────────────────────────────────────────────────────────────

  async readSelection() {
    const sel = window.getSelection()?.toString()?.trim();
    if (!sel || sel.length < 3) {
      new Notice('No text selected. Highlight some text in the PDF first.');
      return;
    }

    let sentences = this.sentences;
    if (!sentences || sentences.length === 0) {
      sentences = await this._extractAllPages();
      if (!sentences) return;
      this.sentences = sentences;
    }

    const selLower = sel.toLowerCase();
    let startIdx = -1;
    let endIdx = -1;

    const selSentences = sel.split(/(?<=[.!?])\s+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const firstSnippet = selSentences[0]?.slice(0, 40) || selLower.slice(0, 40);
    const lastSnippet  = selSentences[selSentences.length - 1]?.slice(0, 40) || selLower.slice(-40);

    sentences.forEach((s, i) => {
      const st = s.text.toLowerCase();
      if (startIdx === -1 && (st.includes(firstSnippet) || firstSnippet.includes(st.slice(0, 30)))) {
        startIdx = i;
      }
      if (st.includes(lastSnippet) || lastSnippet.includes(st.slice(0, 30))) {
        endIdx = i;
      }
    });

    if (startIdx === -1) {
      new Notice('Reading selected text directly.');
      this.stop();
      const rawSentences = sel
        .replace(/\s+/g, ' ')
        .split(/(?<=[.!?])\s+/)
        .filter(s => s.trim().length > 2)
        .map(s => ({ text: s.trim(), page: 0 }));
      if (rawSentences.length === 0) {
        new Notice('Selection too short to read.');
        return;
      }
      this.sentences = rawSentences;
      this.endIndex = rawSentences.length - 1;
      this._startPlayback(0);
      return;
    }

    if (endIdx === -1 || endIdx < startIdx) endIdx = Math.min(startIdx + selSentences.length + 2, sentences.length - 1);

    new Notice(`Reading ${endIdx - startIdx + 1} sentence(s) from selection.`);
    this.endIndex = endIdx;
    this._startPlayback(startIdx);
  }

  // ── Highlighting (follow along) ───────────────────────────────────────────────
  //
  // Highlights the sentence being spoken (and the current word within it) in the
  // PDF's text layer. Uses the CSS Custom Highlight API so the pdf.js DOM is never
  // mutated; falls back to a class on the text-layer spans on older engines.

  _hexToRgba(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return `rgba(255, 208, 0, ${alpha})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  // (Re)build the style element carrying the user-chosen highlight colors.
  // ::highlight() rules can't reliably read CSS variables, so we write the
  // resolved rgba values directly and let this element override styles.css.
  _updateHighlightStyles() {
    const s = this.settings;
    const sentColor = this._hexToRgba(s.sentenceColor, s.sentenceOpacity);
    const wordColor = this._hexToRgba(s.wordColor, s.wordOpacity);
    if (!this._styleEl) {
      this._styleEl = document.head.createEl('style');
      this._styleEl.setAttribute('data-pdf-read-aloud', 'highlight-colors');
    }
    this._styleEl.textContent = `
      ::highlight(${HL_SENTENCE}) { background-color: ${sentColor}; }
      ::highlight(${HL_WORD})     { background-color: ${wordColor}; }
      .pra-hl-sentence { background-color: ${sentColor} !important; }
      .pra-hl-word     { background-color: ${wordColor} !important; }
    `;
  }

  _findTextLayerForPage(pageNum) {
    const view = this._getPdfView();
    const root = view?.containerEl || document;
    const pageEl = root.querySelector(`.page[data-page-number="${pageNum}"]`);
    const tl = pageEl?.querySelector('.textLayer');
    if (tl && tl.textContent && tl.textContent.trim().length > 0) return tl;
    return null;
  }

  // Walk every text node in the text layer and build a whitespace-free, lowercase
  // string plus a per-character map back to (node, offset). Whitespace-free
  // matching is what makes extracted sentences line up with the rendered spans,
  // since pdf.js splits/joins runs differently than getTextContent().
  _buildDomMap(textLayerEl) {
    const domMap = [];
    let normStr = '';
    const walker = document.createTreeWalker(textLayerEl, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue;
      for (let i = 0; i < text.length; i++) {
        if (/\s/.test(text[i])) continue;
        normStr += text[i].toLowerCase();
        domMap.push({ node, offset: i });
      }
    }
    return { normStr, domMap };
  }

  _rangeFromDomMap(domMap, startIdx, endIdx) {
    if (startIdx < 0 || startIdx >= domMap.length) return null;
    endIdx = Math.min(endIdx, domMap.length);
    if (endIdx <= startIdx) return null;
    const range = document.createRange();
    const first = domMap[startIdx];
    const last = domMap[endIdx - 1];
    try {
      range.setStart(first.node, first.offset);
      range.setEnd(last.node, last.offset + 1);
    } catch (_) {
      return null;
    }
    return range;
  }

  _setHighlight(kind, range, domMap, startIdx, endIdx) {
    const name = kind === 'sentence' ? HL_SENTENCE : HL_WORD;
    if (typeof Highlight !== 'undefined' && CSS.highlights) {
      const hl = new Highlight(range);
      hl.priority = kind === 'word' ? 2 : 1; // word paints on top of sentence
      CSS.highlights.set(name, hl);
    } else {
      this._clearFallback(kind);
      const els = new Set();
      for (let i = startIdx; i < endIdx; i++) {
        const el = domMap[i].node.parentElement;
        if (el) els.add(el);
      }
      const cls = kind === 'sentence' ? 'pra-hl-sentence' : 'pra-hl-word';
      els.forEach(el => el.classList.add(cls));
      this._fallbackEls[kind] = [...els];
    }
  }

  _clearFallback(kind) {
    const cls = kind === 'sentence' ? 'pra-hl-sentence' : 'pra-hl-word';
    (this._fallbackEls[kind] || []).forEach(el => el.classList.remove(cls));
    this._fallbackEls[kind] = [];
  }

  _clearWordHighlight() {
    if (typeof Highlight !== 'undefined' && CSS.highlights) CSS.highlights.delete(HL_WORD);
    this._clearFallback('word');
  }

  _clearHighlights() {
    if (typeof Highlight !== 'undefined' && CSS.highlights) {
      CSS.highlights.delete(HL_SENTENCE);
      CSS.highlights.delete(HL_WORD);
    }
    this._clearFallback('sentence');
    this._clearFallback('word');
    this._hlMatch = null;
  }

  _highlightSentence(index, isRetry) {
    this._clearWordHighlight();
    this._hlMatch = null;

    const sentence = this.sentences[index];
    // page 0 = "read selection directly" (text not tied to a PDF location)
    if (!sentence || !sentence.page) { this._clearHighlights(); return; }

    const textLayer = this._findTextLayerForPage(sentence.page);
    if (!textLayer) {
      this._clearHighlights();
      // Page not rendered yet (pdf.js virtualizes pages) — scroll to it and retry once.
      if (!isRetry && this.settings.autoScroll) {
        this._scrollToPage(sentence.page);
        setTimeout(() => {
          if (this.currentIndex === index && (this.isPlaying || this.isPaused)) {
            this._highlightSentence(index, true);
          }
        }, 500);
      }
      return;
    }

    const { normStr, domMap } = this._buildDomMap(textLayer);
    const target = sentence.text.toLowerCase().replace(/\s+/g, '');
    let start = normStr.indexOf(target);
    let len = target.length;
    if (start === -1 && target.length > 40) {
      // Partial match on the leading chunk (handles hyphenation/ligature quirks)
      start = normStr.indexOf(target.slice(0, 40));
      if (start !== -1) len = Math.min(target.length, normStr.length - start);
    }
    if (start === -1 || len === 0) { this._clearHighlights(); return; }

    this._hlMatch = { start, len, domMap, sentenceText: sentence.text };

    const range = this._rangeFromDomMap(domMap, start, start + len);
    if (!range) { this._clearHighlights(); return; }
    this._setHighlight('sentence', range, domMap, start, start + len);
    if (this.settings.autoScroll) this._scrollRangeIntoView(range);
  }

  // charIndex/charLength come from the utterance's word-boundary event and are
  // offsets into the sentence text itself.
  _highlightWord(charIndex, charLength) {
    const m = this._hlMatch;
    if (!m || charIndex == null || charIndex >= m.sentenceText.length) return;

    const text = m.sentenceText;
    let end = charIndex + (charLength || 0);
    if (!charLength) {
      const rest = text.slice(charIndex).match(/^\s*\S+/);
      end = charIndex + (rest ? rest[0].length : 0);
    }

    // Convert sentence offsets to whitespace-free offsets to index the dom map.
    const nsBefore = text.slice(0, charIndex).replace(/\s+/g, '').length;
    const nsLen = text.slice(charIndex, end).replace(/\s+/g, '').length;
    if (nsLen === 0) return;

    const s = m.start + nsBefore;
    const e = Math.min(s + nsLen, m.start + m.len, m.domMap.length);
    const range = this._rangeFromDomMap(m.domMap, s, e);
    if (range) this._setHighlight('word', range, m.domMap, s, e);
  }

  _scrollToPage(pageNum) {
    const view = this._getPdfView();
    if (!view) return;
    const pdfViewer =
      view?.viewer?.pdfViewer ||
      view?.pdfViewer ||
      view?.viewer?.child?.pdfViewer ||
      this._deepFind(view, 'pdfViewer');
    try {
      if (pdfViewer && typeof pdfViewer.currentPageNumber === 'number') {
        pdfViewer.currentPageNumber = pageNum;
      }
    } catch (_) { /* viewer internals unavailable — skip scrolling */ }
  }

  _scrollRangeIntoView(range) {
    const el = range.startContainer.parentElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < 80 || rect.bottom > window.innerHeight - 80) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  // ── Playback engine ───────────────────────────────────────────────────────────

  async play() {
    if (this.isPaused && this.synth.paused) {
      this.synth.resume();
      this.isPaused = false;
      this.isPlaying = true;
      this.updateStatusBar('Playing…');
      this.refreshPanel();
      return;
    }
    if (this.isPlaying) return;

    const sentences = await this._extractAllPages();
    if (!sentences) return;
    this.sentences = sentences;
    this.endIndex = -1;
    this._startPlayback(0);
  }

  _startPlayback(index) {
    this.synth.cancel();
    this.isPlaying = true;
    this.isPaused = false;
    this.speakFrom(index);
  }

  speakFrom(index) {
    const stopAt = this.endIndex >= 0 ? this.endIndex : this.sentences.length - 1;

    if (index > stopAt || index >= this.sentences.length) {
      this.isPlaying = false;
      this.isPaused = false;
      this._clearHighlights();
      this.updateStatusBar('Finished');
      this.refreshPanel();
      new Notice('PDF Read Aloud: Done ✓');
      return;
    }

    this.currentIndex = index;
    if (this.settings.highlightEnabled) {
      this._highlightSentence(index);
    }
    const sentence = this.sentences[index].text;
    const utt = new SpeechSynthesisUtterance(sentence);
    utt.rate   = this.settings.rate;
    utt.pitch  = this.settings.pitch;
    utt.volume = this.settings.volume;

    if (this.settings.voiceURI) {
      const voice = this.synth.getVoices().find(v => v.voiceURI === this.settings.voiceURI);
      if (voice) utt.voice = voice;
    }

    utt.onboundary = (e) => {
      // Word-boundary events don't fire with every voice — sentence highlight still works.
      if (e.name === 'word' && this.settings.highlightEnabled && this.isPlaying) {
        this._highlightWord(e.charIndex, e.charLength);
      }
    };
    utt.onend = () => {
      if (this.isPlaying && !this.isPaused) this.speakFrom(index + 1);
    };
    utt.onerror = (e) => {
      if (e.error !== 'interrupted' && e.error !== 'canceled') {
        this.isPlaying = false;
        this._clearHighlights();
        this.updateStatusBar('Error');
        this.refreshPanel();
      }
    };

    this.utterance = utt;
    const pg = this.sentences[index]?.page;
    this.updateStatusBar(`▶ ${index + 1}/${this.sentences.length}${pg ? ` (p.${pg})` : ''}`);
    this.refreshPanel();
    this.synth.speak(utt);
  }

  pause() {
    if (!this.isPlaying || this.isPaused) return;
    this.synth.pause();
    this.isPaused = true;
    this.isPlaying = false;
    this.updateStatusBar('Paused');
    this.refreshPanel();
  }

  stop() {
    this.synth.cancel();
    this.isPlaying = false;
    this.isPaused = false;
    this.currentIndex = 0;
    this.endIndex = -1;
    this._clearHighlights();
    this.updateStatusBar('Idle');
    this.refreshPanel();
  }

  skipForward() {
    if (!this.isPlaying && !this.isPaused) return;
    this.synth.cancel();
    this.isPaused = false;
    this.speakFrom(Math.min(this.currentIndex + this.settings.skipSize, this.sentences.length - 1));
  }

  skipBack() {
    if (!this.isPlaying && !this.isPaused) return;
    this.synth.cancel();
    this.isPaused = false;
    this.speakFrom(Math.max(this.currentIndex - this.settings.skipSize, 0));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  updateStatusBar(msg) {
    if (this.statusBarEl) this.statusBarEl.setText(`🔊 ${msg}`);
  }

  refreshPanel() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(leaf => {
      if (leaf.view instanceof ControlPanelView) leaf.view.refresh();
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ── Control Panel ──────────────────────────────────────────────────────────────

class ControlPanelView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return 'PDF Read Aloud'; }
  getIcon()        { return 'volume-2'; }

  async onOpen() { this.render(); }
  refresh()       { this.render(); }

  render() {
    const c = this.containerEl.children[1];
    c.empty();
    c.style.cssText = 'padding:16px;font-family:var(--font-interface);';
    const p = this.plugin;

    // ── Header ────────────────────────────────────────────────────────────────
    const header = c.createEl('h4');
    header.style.marginBottom = '10px';
    header.setText('PDF Read Aloud');

    // ── Status badge ──────────────────────────────────────────────────────────
    const statusEl = c.createEl('div');
    statusEl.style.cssText = 'padding:7px 12px;border-radius:6px;margin-bottom:14px;font-size:12px;background:var(--background-secondary);';
    const pct = p.sentences.length > 0 ? Math.round((p.currentIndex / p.sentences.length) * 100) : 0;
    const pg  = p.sentences[p.currentIndex]?.page;
    const statusText = p.isPlaying
      ? `Playing — sentence ${p.currentIndex + 1} / ${p.sentences.length}${pg ? ' — p.' + pg : ''}`
      : p.isPaused
        ? `Paused at ${p.currentIndex + 1} / ${p.sentences.length}`
        : p.sentences.length > 0
          ? `Stopped (${p.sentences.length} sentences loaded)`
          : 'Idle — open a PDF and press Play';
    statusEl.setText(statusText);

    // ── Progress bar ──────────────────────────────────────────────────────────
    if (p.sentences.length > 0) {
      const bar = c.createEl('div');
      bar.style.cssText = 'height:5px;border-radius:3px;background:var(--background-secondary);overflow:hidden;margin-bottom:14px;cursor:pointer;';
      bar.title = 'Click to jump to position';
      const fill = bar.createEl('div');
      fill.style.cssText = `height:100%;width:${pct}%;background:var(--interactive-accent);transition:width 0.3s;`;
      bar.addEventListener('click', (e) => {
        const ratio = e.offsetX / bar.offsetWidth;
        const idx = Math.floor(ratio * p.sentences.length);
        p.synth.cancel();
        p.isPaused = false;
        p.isPlaying = true;
        p.endIndex = -1;
        p.speakFrom(idx);
      });
    }

    // ── Transport buttons ─────────────────────────────────────────────────────
    const btnRow = c.createEl('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-bottom:14px;';
    const mkBtn = (label, tip, fn, primary) => {
      const b = btnRow.createEl('button', { text: label, title: tip });
      b.style.cssText = `flex:1;padding:8px 2px;border-radius:6px;border:none;cursor:pointer;font-size:15px;
        background:${primary ? 'var(--interactive-accent)' : 'var(--background-secondary)'};
        color:${primary ? 'var(--text-on-accent)' : 'var(--text-normal)'};`;
      b.addEventListener('click', fn);
    };
    mkBtn('⏮', `Back ${p.settings.skipSize} sentences`,    () => p.skipBack(),    false);
    if (!p.isPlaying) {
      mkBtn('▶', 'Play / Resume',                           () => p.play(),        true);
    } else {
      mkBtn('⏸', 'Pause',                                  () => p.pause(),       false);
    }
    mkBtn('⏹', 'Stop',                                     () => p.stop(),        false);
    mkBtn('⏭', `Forward ${p.settings.skipSize} sentences`, () => p.skipForward(), false);

    c.createEl('hr').style.cssText = 'border:none;border-top:1px solid var(--background-modifier-border);margin:12px 0;';

    // ── Click-to-start & Read-selection ───────────────────────────────────────
    const actionRow = c.createEl('div');
    actionRow.style.cssText = 'display:flex;gap:6px;margin-bottom:14px;';

    const clickBtn = actionRow.createEl('button', { text: 'Read from click', title: 'Click anywhere in the PDF to start reading from that point' });
    clickBtn.style.cssText = 'flex:1;padding:7px 4px;border-radius:6px;border:1px solid var(--background-modifier-border);cursor:pointer;font-size:12px;background:var(--background-secondary);color:var(--text-normal);';
    clickBtn.addEventListener('click', () => {
      p.enableClickMode();
      clickBtn.style.background = 'var(--interactive-accent)';
      clickBtn.style.color = 'var(--text-on-accent)';
      clickBtn.setText('Click in PDF…');
      setTimeout(() => this.render(), 5000);
    });

    const selBtn = actionRow.createEl('button', { text: 'Read selection', title: 'Read only the text you have highlighted in the PDF' });
    selBtn.style.cssText = 'flex:1;padding:7px 4px;border-radius:6px;border:1px solid var(--background-modifier-border);cursor:pointer;font-size:12px;background:var(--background-secondary);color:var(--text-normal);';
    selBtn.addEventListener('click', () => p.readSelection());

    c.createEl('hr').style.cssText = 'border:none;border-top:1px solid var(--background-modifier-border);margin:12px 0;';

    // ── Highlight controls ────────────────────────────────────────────────────
    const hlRow = c.createEl('div');
    hlRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';

    const hlCheck = hlRow.createEl('input');
    Object.assign(hlCheck, { type: 'checkbox', checked: p.settings.highlightEnabled, id: 'pra-hl-toggle' });
    hlCheck.style.cssText = 'cursor:pointer;accent-color:var(--interactive-accent);';
    const hlLabel = hlRow.createEl('label', { text: 'Highlight while reading' });
    hlLabel.htmlFor = 'pra-hl-toggle';
    hlLabel.style.cssText = 'font-size:12px;color:var(--text-normal);cursor:pointer;flex:1;';
    hlCheck.addEventListener('change', () => {
      p.settings.highlightEnabled = hlCheck.checked;
      if (!hlCheck.checked) p._clearHighlights();
      p.saveSettings();
      this.render();
    });

    if (p.settings.highlightEnabled) {
      const mkColorRow = (label, colorKey, opacityKey) => {
        const row = c.createEl('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';

        const lbl = row.createEl('span', { text: label });
        lbl.style.cssText = 'font-size:12px;color:var(--text-muted);width:64px;flex-shrink:0;';

        const picker = row.createEl('input');
        Object.assign(picker, { type: 'color', value: p.settings[colorKey] });
        picker.title = `${label} highlight color`;
        picker.style.cssText = 'width:32px;height:24px;padding:0;border:1px solid var(--background-modifier-border);border-radius:4px;cursor:pointer;background:transparent;';
        picker.addEventListener('input', () => {
          p.settings[colorKey] = picker.value;
          p._updateHighlightStyles();
          p.saveSettings();
        });

        const opacity = row.createEl('input');
        Object.assign(opacity, { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(p.settings[opacityKey]) });
        opacity.title = `${label} highlight opacity`;
        opacity.style.cssText = 'flex:1;accent-color:var(--interactive-accent);';
        opacity.addEventListener('input', () => {
          p.settings[opacityKey] = parseFloat(opacity.value);
          p._updateHighlightStyles();
          p.saveSettings();
        });
      };
      mkColorRow('Sentence', 'sentenceColor', 'sentenceOpacity');
      mkColorRow('Word',     'wordColor',     'wordOpacity');
    }

    c.createEl('hr').style.cssText = 'border:none;border-top:1px solid var(--background-modifier-border);margin:12px 0;';

    // ── Speed ─────────────────────────────────────────────────────────────────
    const speedLabel = c.createEl('div');
    speedLabel.style.cssText = 'font-size:12px;color:var(--text-muted);margin-bottom:4px;';
    speedLabel.setText(`Speed: ${p.settings.rate.toFixed(1)}×`);
    const speedSlider = c.createEl('input');
    Object.assign(speedSlider, { type: 'range', min: '0.5', max: '2.0', step: '0.1', value: String(p.settings.rate) });
    speedSlider.style.cssText = 'width:100%;margin-bottom:12px;accent-color:var(--interactive-accent);';
    speedSlider.addEventListener('input', e => {
      p.settings.rate = parseFloat(e.target.value);
      speedLabel.setText(`Speed: ${p.settings.rate.toFixed(1)}×`);
      p.saveSettings();
    });
    c.appendChild(speedSlider);

    // ── Skip size ─────────────────────────────────────────────────────────────
    const skipLabel = c.createEl('div');
    skipLabel.style.cssText = 'font-size:12px;color:var(--text-muted);margin-bottom:4px;';
    skipLabel.setText(`Skip size: ${p.settings.skipSize} sentences`);
    const skipSlider = c.createEl('input');
    Object.assign(skipSlider, { type: 'range', min: '1', max: '20', step: '1', value: String(p.settings.skipSize) });
    skipSlider.style.cssText = 'width:100%;margin-bottom:12px;accent-color:var(--interactive-accent);';
    skipSlider.addEventListener('input', e => {
      p.settings.skipSize = parseInt(e.target.value);
      skipLabel.setText(`Skip size: ${p.settings.skipSize} sentences`);
      p.saveSettings();
    });
    c.appendChild(skipSlider);

    // ── Voice ─────────────────────────────────────────────────────────────────
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      const voiceLabel = c.createEl('div', { text: 'Voice' });
      voiceLabel.style.cssText = 'font-size:12px;color:var(--text-muted);margin-bottom:4px;';
      const sel = c.createEl('select');
      sel.style.cssText = 'width:100%;padding:6px;border-radius:6px;background:var(--background-secondary);color:var(--text-normal);border:1px solid var(--background-modifier-border);font-size:12px;margin-bottom:12px;';
      voices.forEach(v => {
        const opt = sel.createEl('option', { text: `${v.name} (${v.lang})`, value: v.voiceURI });
        if (v.voiceURI === p.settings.voiceURI) opt.selected = true;
      });
      sel.addEventListener('change', e => { p.settings.voiceURI = e.target.value; p.saveSettings(); });
    } else {
      // Voices not yet loaded — show a placeholder; panel will re-render via voiceschanged
      const voicePending = c.createEl('div');
      voicePending.style.cssText = 'font-size:12px;color:var(--text-muted);margin-bottom:12px;';
      voicePending.setText('Voice list loading…');
    }

    // ── Tips ──────────────────────────────────────────────────────────────────
    const tips = c.createEl('div');
    tips.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.6;margin-top:4px;';

    const tipLines = [
      ['Play', '— reads whole PDF from beginning'],
      ['Read from click', '— then click anywhere in PDF text'],
      ['Read selection', '— highlight text first, then click'],
      ['Right-click', '— quick access inside the PDF viewer'],
    ];
    tipLines.forEach(([label, desc]) => {
      const line = tips.createEl('div');
      const bold = line.createEl('b');
      bold.setText(label);
      line.appendText(' ' + desc);
    });
  }
}

// ── Settings Tab ───────────────────────────────────────────────────────────────

class PdfReadAloudSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();

    const slider = (name, desc, key, min, max, step) =>
      new Setting(containerEl).setName(name).setDesc(desc)
        .addSlider(sl => sl.setLimits(min, max, step).setValue(this.plugin.settings[key]).setDynamicTooltip()
          .onChange(async v => { this.plugin.settings[key] = v; await this.plugin.saveSettings(); }));

    slider('Speech rate',  'Speed: 0.5 (slow) → 2.0 (fast)', 'rate',     0.5, 2.0, 0.1);
    slider('Pitch',        'Voice pitch',                      'pitch',    0.5, 2.0, 0.1);
    slider('Volume',       'Volume level',                     'volume',   0.0, 1.0, 0.1);
    slider('Skip size',    'Sentences to skip forward/back',   'skipSize', 1,   20,  1);

    new Setting(containerEl)
      .setName('Highlight while reading')
      .setDesc('Color the sentence (and current word, if your voice supports it) being read aloud in the PDF')
      .addToggle(t => t.setValue(this.plugin.settings.highlightEnabled)
        .onChange(async v => {
          this.plugin.settings.highlightEnabled = v;
          if (!v) this.plugin._clearHighlights();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Auto-scroll to sentence')
      .setDesc('Keep the highlighted sentence visible by scrolling the PDF as reading progresses')
      .addToggle(t => t.setValue(this.plugin.settings.autoScroll)
        .onChange(async v => { this.plugin.settings.autoScroll = v; await this.plugin.saveSettings(); }));

    const colorSetting = (name, desc, colorKey, opacityKey) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addColorPicker(cp => cp.setValue(this.plugin.settings[colorKey])
          .onChange(async v => {
            this.plugin.settings[colorKey] = v;
            this.plugin._updateHighlightStyles();
            await this.plugin.saveSettings();
          }))
        .addSlider(sl => sl.setLimits(0.1, 1.0, 0.05)
          .setValue(this.plugin.settings[opacityKey])
          .setDynamicTooltip()
          .onChange(async v => {
            this.plugin.settings[opacityKey] = v;
            this.plugin._updateHighlightStyles();
            await this.plugin.saveSettings();
          }));
    };

    colorSetting('Sentence highlight color', 'Color and opacity for the sentence being read — pick something that stands out against your PDF background', 'sentenceColor', 'sentenceOpacity');
    colorSetting('Word highlight color', 'Color and opacity for the word currently being spoken', 'wordColor', 'wordOpacity');

    new Setting(containerEl)
      .setName('Reset highlight colors')
      .setDesc('Restore the default yellow sentence / orange word highlight')
      .addButton(b => b.setButtonText('Reset')
        .onClick(async () => {
          const p = this.plugin;
          p.settings.sentenceColor   = DEFAULT_SETTINGS.sentenceColor;
          p.settings.sentenceOpacity = DEFAULT_SETTINGS.sentenceOpacity;
          p.settings.wordColor       = DEFAULT_SETTINGS.wordColor;
          p.settings.wordOpacity     = DEFAULT_SETTINGS.wordOpacity;
          p._updateHighlightStyles();
          await p.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName('Voice')
      .setDesc('Text-to-speech voice (uses voices installed on your system)')
      .addDropdown(drop => {
        const voices = window.speechSynthesis.getVoices();
        voices.forEach(v => drop.addOption(v.voiceURI, `${v.name} (${v.lang})`));
        drop.setValue(this.plugin.settings.voiceURI);
        drop.onChange(async v => { this.plugin.settings.voiceURI = v; await this.plugin.saveSettings(); });
      });
  }
}

module.exports = PdfReadAloudPlugin;

/* nosourcemap */