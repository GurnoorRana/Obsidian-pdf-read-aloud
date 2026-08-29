# PDF Read Aloud – Obsidian Plugin

Reads your open PDF files aloud using your device's built-in text-to-speech. No API key, no internet connection, no paid service required.

## Features

- **Follow-along highlighting** — the sentence being read and the word currently being spoken are highlighted right in the PDF, with fully customizable colors and opacity (so it works on any PDF background)
- **Auto-scroll** — the PDF scrolls automatically to keep the highlighted sentence in view
- **Play / Pause / Stop** controls
- **Skip forward / back** by a configurable number of sentences (default 5, adjustable up to 20)
- **Read from click** — enable click mode, then click anywhere in the PDF text layer to start reading from that point
- **Read selection** — highlight any text in the PDF, then press "Read selection" to read only that portion
- **Right-click context menu** — right-click inside any PDF to get quick access to "Read from here" and "Read selected text"
- **Progress bar** — shows how far through the document you are; click to jump to any position
- **Speed control** (0.5× – 2.0×)
- **Voice selector** — uses all voices installed on your system
- **Status bar indicator** — shows current sentence and page number while reading
- **Command Palette** support for all actions

## Installation

### Via Community Plugins (recommended)

1. Open Obsidian **Settings → Community Plugins**
2. Turn on Community Plugins if not already enabled
3. Click **Browse** and search for **PDF Read Aloud**
4. Click **Install**, then **Enable**

### Manual installation

1. Go to your Obsidian vault folder
2. Navigate to `.obsidian/plugins/`
3. Create a folder named `pdf-read-aloud`
4. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/GurnoorRana/Obsidian-pdf-read-aloud/releases/latest) and copy them into that folder
5. In Obsidian: **Settings → Community Plugins** → find **PDF Read Aloud** and enable it

> **macOS tip:** Press **Cmd+Shift+.** in Finder to show hidden folders like `.obsidian`.  
> **Windows tip:** Enable **Show hidden items** in File Explorer.

## How to Use

### Basic playback
1. Open a PDF file in Obsidian
2. Click the 🔊 icon in the left ribbon **or** open the Command Palette and run **PDF Read Aloud: Open control panel**
3. Press ▶ to start reading from the beginning
4. Use ⏸ to pause, ⏹ to stop, ⏮/⏭ to skip sentences

### Read from a specific position
1. Click **Read from click** in the control panel (or run the command)
2. Click anywhere in the PDF text — playback starts from the nearest sentence

### Read only selected text
1. Highlight text in the PDF
2. Click **Read selection** in the control panel, or right-click inside the PDF and choose **Read selected text**

### Right-click menu
Right-click anywhere inside the PDF viewer for quick access to both **Read from here** and **Read selected text**.

## Settings

All settings are available under **Settings → PDF Read Aloud**:

| Setting | Description | Default |
|---|---|---|
| Speech rate | Reading speed (0.5× slow → 2.0× fast) | 1.0× |
| Pitch | Voice pitch | 1.0 |
| Volume | Volume level | 1.0 |
| Skip size | Number of sentences to skip forward/back | 5 |
| Voice | System TTS voice to use | System default |
| Highlight while reading | Color the sentence and word being spoken in the PDF | On |
| Auto-scroll to sentence | Keep the highlighted sentence visible while reading | On |
| Sentence highlight color | Color + opacity of the sentence highlight | Yellow, 30% |
| Word highlight color | Color + opacity of the current-word highlight | Orange, 55% |

Highlight colors can also be changed directly from the control panel.

## Notes

- Works with **text-based PDFs** only. Scanned or image-only PDFs will have no readable text.
- Uses the browser's built-in **Web Speech API** — completely free, works offline, no account needed.
- Voice availability depends on your operating system and installed language packs.

## Changelog

### 1.3.0
- Read **Markdown notes** aloud too — press Play with a note active (markdown syntax is stripped, code blocks skipped)
- **Resume position**: each PDF continues from where you last stopped (toggleable, last 20 files)
- Smarter sentence splitting: abbreviations (Dr., e.g., No. 5), initials and decimals no longer break sentences
- Words hyphenated across line breaks are rejoined ("adven-ture" → "adventure")
- Repeated headers, footers and page numbers are detected and skipped (toggleable)
- Two-column layouts are detected and read in the correct order (toggleable)
- Extracted text is cached per file — replaying an unchanged PDF starts instantly
- Playback stops automatically (saving your position) when the file being read is closed
- Very long sentences are split into clause-sized chunks so voices no longer cut out on them
- Scanned/image-only PDFs now get an OCR tip (detects the Text Extractor plugin)
- Voice lists are sorted best-first, with in-settings tips for installing better system voices
- Marked as desktop-only pending mobile testing

### 1.2.0
- **Follow-along highlighting**: the sentence being read is highlighted in the PDF, and the current word gets a stronger highlight (word-level tracking depends on the selected voice supporting word-boundary events)
- Auto-scroll keeps the highlighted sentence in view, including jumping to not-yet-rendered pages
- Customizable highlight colors and opacity, editable from both the settings tab and the control panel
- Highlighting uses the CSS Custom Highlight API, so the PDF text layer is never modified

### 1.1.0
- Fixed voice dropdown not populating when panel opens before voices are loaded
- Skip size is now configurable (1–20 sentences) from the panel and settings
- Removed all `innerHTML` usage for improved security
- Improved `_deepFind` to skip DOM nodes and avoid false positives
- Better per-page error handling during text extraction — one bad page no longer aborts the whole document
- Context menu items no longer use emoji in titles (per Obsidian style guidelines)

### 1.0.0
- Initial release
