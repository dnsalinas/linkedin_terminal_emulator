# linkedin_terminal_emulator

A Chrome extension that turns LinkedIn into a keyboard-first, terminal-style reading mode.

It is built for people who want more text and less feed clutter: fewer autoplaying visuals, less promotional chrome, and a faster way to move through posts, profiles, and comment threads without treating LinkedIn like TikTok.

## What It Does

- Re-skins LinkedIn into a Lynx/Pine/Elm-inspired text mode
- Keeps the useful parts of posts while collapsing most image and video noise
- Adds a persistent top command bar and bottom shortcut bar
- Supports keyboard-first feed navigation with post selection, action mode, and topic view
- Works on the home feed, single-post permalink pages, profiles, and many company/page post views
- Lets you click a post to select it, then continue with the keyboard
- Provides a popup toggle plus a global hotkey

## Highlights

- Text-first post rendering
  - Posts are restyled for readability with terminal-like typography and spacing
  - Headshots are preserved so authors are still recognizable

- Keyboard navigation
  - Browse posts with arrow keys or `j` / `k`
  - Open a selected post with `Right Arrow` or `Enter`
  - Trigger `Like`, `Comment`, `Repost`, and `Send` from the keyboard
  - Expand hidden media and `... more` text with `x`
  - Jump back to the top with `g`

- Topic index
  - Press `t` to group visible posts into a topic-style index
  - Jump back into the feed from the topic view

- Feed continuation
  - End-of-feed `view more` row supports keyboard loading of more posts

- Profile support
  - Reflows LinkedIn profiles into a cleaner text-heavy layout
  - Navigates profile sections with the keyboard

## Installation

This project is currently packaged as an unpacked Chrome extension.

1. Clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the cloned project folder.
6. Open LinkedIn.
7. Toggle the extension from the popup, or use `Alt+Shift+L`.

Optional shell flow:

```bash
git clone https://github.com/dnsalinas/linkedin_terminal_emulator.git
cd linkedin_terminal_emulator
```

## Usage

### Toggle

- Popup switch: enable or disable text mode for LinkedIn
- Keyboard: `Alt+Shift+L`

### Feed / Post Navigation

- `Up` / `Down` or `j` / `k`: move between posts
- `Right Arrow` or `Enter`: enter action mode for the selected post
- `Esc`: clear selection
- `l`: like
- `c`: comment
- `r`: repost
- `s`: send
- `x`: expand hidden media and `... more` text
- `t`: open topic index
- `g`: jump to the top

### Action Mode

- `Left` / `Right`: cycle actions
- `Enter`: activate focused action
- `o`: open author profile
- `x`: expand media or hidden text
- `Esc`: exit action mode

### Topic View

- `t` or `Esc`: close topic view
- `Up` / `Down`: move between topic groups
- `Left` / `Right`: move within posts in the selected topic
- `Enter`: jump to that post in the feed
- `s`: scan for more posts

### Profile View

- `Up` / `Down`: move through detected sections
- `Enter`: open section / show more when available
- `g`: jump to top
- `m`: message
- `c`: connect or follow

### Mouse Support

- Click a post body to select it
- Continue navigating from that post with the keyboard

## Permissions

The extension is intentionally scoped narrowly.

- `host_permissions`
  - `https://www.linkedin.com/*`
- `permissions`
  - `storage` for remembering whether text mode is enabled and the selected font size
  - `activeTab` for tab-level extension interaction

It does not request all-sites access.

## Privacy

- Runs only on LinkedIn
- Stores simple local preferences in Chrome storage
- Does not rely on a backend service
- Does not send LinkedIn page content to a remote API

## Project Structure

```text
manifest.json   Chrome extension manifest
content.js      Main LinkedIn text-mode logic
styles.css      Terminal-style presentation and layout rules
popup.html      Extension popup UI
popup.js        Popup controller
icons/          Extension icons
```

## Current Status

This is a practical, working extension, but it is still heuristic-driven because LinkedIn changes DOM structure frequently.

Known realities:

- Some LinkedIn routes will need occasional selector or layout tuning
- SPA navigation can expose edge cases when LinkedIn rehydrates slowly
- Permalink pages, comments, and media viewers are supported, but those are the most brittle surfaces

If something regresses, open an issue with:

- the exact LinkedIn URL pattern
- a screenshot
- what you expected to happen
- what actually happened

## Development

There is no build step right now. Edit the source files directly and reload the unpacked extension in Chrome.

Useful loop:

1. Make a change
2. Reload the extension in `chrome://extensions`
3. Hard refresh the LinkedIn tab
4. Re-test the route that changed

## Roadmap

- Better permalink/page detection
- Stronger recovery for slow LinkedIn SPA transitions
- Cleaner profile and company-page layouts
- More predictable media expansion behavior
- Optional lighter theme or density presets

## License

MIT. See [LICENSE](LICENSE).
