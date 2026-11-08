# Side Heptabase

中文说明: [README.zh.md](README.zh.md)

[![Latest release](https://img.shields.io/github/v/release/RizzoTho/side-heptabase)](https://github.com/RizzoTho/side-heptabase/releases/latest)

<p align="center">
  <img src="assets/readme-hero.png" alt="Side Heptabase — capture into Heptabase without leaving the page">
</p>

I built Side Heptabase for people who read and research in Chromium browsers but want their notes to land in Heptabase without breaking focus. Capturing the thought, preserving its source, and choosing the right destination are small decisions that become friction when repeated all day. The extension offers a side panel and a small floating capture control on web pages.

Side Heptabase is an unofficial Chrome extension that writes through Heptabase's official MCP endpoint with OAuth. It creates Note Cards, appends to Journal, and captures the current page link.

## Install

Side Heptabase is distributed as a zip on the [releases page](https://github.com/RizzoTho/side-heptabase/releases/latest). It has no build step and no package dependencies, so the zip is the whole extension. The floating control has been checked in Dia.

1. Download `side-heptabase-vX.Y.Z.zip` from the latest release and unzip it to a permanent location.
2. Open `chrome://extensions` in Chrome or `dia://extensions` in Dia.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the unzipped `side-heptabase` folder.
5. Click the Side Heptabase extension icon to open the side panel.
6. Select **Connect** and finish authorization in the new tab.

Chrome reads that folder every time the browser starts, so keep it. To update, unzip the newer release over it and click **Reload** on the extension card; drafts and settings survive because they live in Chrome storage. Moving the folder or removing the extension changes the extension ID and requires authorizing Heptabase again.

To work on the extension itself, clone the repository and load the repository folder instead.

## Use

1. Open a web page you want to take notes on.
2. Write in Markdown in the side panel.
3. Choose **Note** or **Journal**.
4. Click **Add**, or press `Cmd/Ctrl + Enter`.

On an ordinary web page, hover the floating Meta control to reveal Journal, Todo, Note, and Link. Hover an icon to preview its editor; click the icon or editor to keep it open. Link copies the current URL and includes `[page title](URL)` in today's Journal. Todo appends an unchecked checklist item to today's Journal; it does **not** create an item in Heptabase's separate Task App, which is not exposed by the current MCP tools. The small X hides the floating control on that page until refresh.

<p align="center">
  <img src="assets/side-heptabase-demo.gif" width="680" alt="Floating Journal capture: reveal the dock, pin the editor, and write a draft">
</p>

The demo ends with a saved local draft; it does not submit anything to Heptabase.

Settings shows the MCP connection status and lets you choose whether a direct Meta click opens the Chrome side panel or reopens the last successfully sent capture type. After a confirmed send, the floating editor unpins itself and closes when the pointer leaves it.

For Note Cards, a note that starts with an H1 (`#`) keeps that heading as the card title. Otherwise, the extension prepends the current page title. The active page title and URL are appended as a source link. Drafts are stored locally across browser restarts. A login interruption preserves the draft and source link; reconnecting never resends automatically. If a delivery result is unknown, check Heptabase before explicitly retrying to avoid duplicates.

## Permissions and privacy

- `sidePanel` displays the editor in Chrome's side panel.
- `tabs` reads the active page's title and URL so they can be attached as the note source.
- `storage` keeps the OAuth session, preferences, and unfinished drafts in Chrome. Content scripts cannot read the token store.
- `scripting` adds the floating control to already-open web tabs when the unpacked extension is installed or reloaded. It does not reload those tabs.
- Access to HTTP and HTTPS pages displays the floating control. The extension does not inject it into the Heptabase OAuth page.
- `clipboardWrite` copies the current page URL when Link is selected.
- Access to `api.heptabase.com` is used for Heptabase authorization and saving notes.

Notes are sent directly from the extension to Heptabase. OAuth tokens stay in Chrome extension storage and are only handled by the background service worker, not the side-panel page. This project does not run an intermediary server.

Side Heptabase is a community project and is not affiliated with or endorsed by Heptabase.

## Project structure

```text
assets/       README screenshots
.github/      Release workflow that packages the zip on tag push
scripts/      Packaging and package verification
icons/        Extension and README logo assets
lib/          OAuth and Heptabase MCP clients
floating/     Page-level capture control, styles, and icons
sidepanel/    Side-panel interface and Markdown editor
background.js Background service worker and message routing
manifest.json Chrome Manifest V3 configuration
tests/        Targeted capture and recovery checks
```

## Limitations

- Installation is manual through Chrome's **Load unpacked** flow: download the zip from GitHub Releases and load the unzipped folder. There is no Chrome Web Store release.
- The extension supports plain Markdown text, not file or image attachments.
- The Todo button writes a Journal checklist item because Heptabase MCP currently has no Task App Todo creation tool.
- Reinstalling the extension or moving it to another folder may change its extension ID and require Heptabase authorization again.
- Chromium side panel and extension storage APIs are required. The floating control has been checked in Dia; the full send flow has not been live-tested there.

## License

[MIT](LICENSE)
