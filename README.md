# PDF Read Aloud – Obsidian Plugin

Reads your open PDF files aloud using your device's built-in text-to-speech. No API key needed.

## Features
- ▶ Play / ⏸ Pause / ⏹ Stop controls
- ⏮ Skip back / ⏭ Skip forward (5 sentences at a time)
- Progress bar showing how far through the PDF you are
- Speed control (0.5× – 2.0×)
- Voice selector (uses all voices installed on your system)
- Status bar indicator
- Keyboard commands via Command Palette

## Installation

1. Go to your Obsidian vault folder
2. Navigate to `.obsidian/plugins/`
3. Create a new folder named `pdf-read-aloud`
4. Copy **main.js** and **manifest.json** into that folder
5. In Obsidian: **Settings → Community Plugins → turn on Community Plugins** (if not already)
6. Find **PDF Read Aloud** in your installed plugins list and enable it

> On macOS, press **Cmd+Shift+.** in Finder to show hidden folders like `.obsidian`.
> On Windows, enable **Show hidden items** in File Explorer.

## How to Use

1. Open a PDF file in Obsidian
2. Click the 🔊 icon in the left ribbon **or** open the Command Palette and search "PDF Read Aloud"
3. Press ▶ in the control panel to start reading
4. Adjust speed and voice from the panel or Settings

## Notes
- Works with text-based PDFs. Scanned/image PDFs won't have readable text.
- Uses the browser's built-in Web Speech API — completely free, no internet needed.
