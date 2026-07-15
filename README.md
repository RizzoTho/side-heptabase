# Side Heptabase

An unofficial Chrome side-panel extension for sending Markdown notes to Heptabase. It can create a new Note Card or append to today's Journal, with the current page title and URL included as the source.

## Install

1. Download this repository and unzip it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the unzipped folder.
5. Click the extension icon to open the side panel.

## Use

1. Connect your Heptabase account in the side panel.
2. Write in Markdown.
3. Choose **Note Card** or **Journal**, then click **Send**. You can also press `Cmd/Ctrl + Enter`.

## Permissions and privacy

- `sidePanel` displays the editor in Chrome's side panel.
- `tabs` reads the active page's title and URL so they can be attached as the note source.
- `storage` keeps the OAuth session and unfinished draft in Chrome.
- Access to `api.heptabase.com` is used for Heptabase authorization and saving notes.

Notes are sent directly from the extension to Heptabase. OAuth tokens stay in Chrome extension storage and are only handled by the background service worker, not the side-panel page. This project does not run an intermediary server.

Side Heptabase is a community project and is not affiliated with or endorsed by Heptabase.
