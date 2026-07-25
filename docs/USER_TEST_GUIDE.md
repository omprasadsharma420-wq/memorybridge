# MemoryBridge 0.2.1 internal user test guide

This guide assumes no developer tools. Use a new disposable vault and synthetic data first. This
build is an unsigned pre-release for internal testing, not a production release.

## Test A — Install

1. Download `MemoryBridge-0.2.1-x64-Setup.exe` from the
   [v0.2.1 MVP test pre-release](https://github.com/omprasadsharma420-wq/memorybridge/releases/tag/v0.2.1-mvp-test.1).
2. Compare the SHA-256 shown on the release page with `SHA256SUMS.txt` if your organization
   requires checksum verification.
3. Double-click the installer.
4. If Windows SmartScreen says the app is unrecognized, confirm the filename came from that GitHub
   release, choose **More info**, then **Run anyway**. Stop if the source or checksum differs.
5. Choose the install folder if desired and complete setup.
6. Launch **MemoryBridge** from the Start menu or desktop shortcut.

Expected: the welcome screen explains local vault storage and offers **Create a new vault** and
**Open an existing vault**.

## Test B — Internal vault

1. Choose **Create a new vault**.
2. Select a new empty folder on the internal disk.
3. Confirm setup shows the exact folder, writable status, and free space.
4. Choose **Demo mode**, then **Load bundled synthetic demo**.
5. Confirm three conversations are imported and validation says **passed**.
6. Finish setup and open **Vault storage**.
7. Check device free space, total vault size, raw transcripts, index, memory/evidence,
   attachments/import archives, and chat/message/memory counts. Choose **Refresh calculation** and
   **Verify vault location**.
8. Open **Storage decision**, then **Memory**. Open the exact source and confirm the supporting
   message is highlighted.
9. Open **Search**, search `internal storage`, and open a result.
10. Close MemoryBridge normally, reopen it, and repeat the search.

Expected: the same vault and conversations reopen; a normal restart does not rebuild the index.

## Test C — External vault

1. Connect an external SSD or hard drive.
2. Create a new empty folder on that drive and choose it when creating the vault.
3. In **Vault storage**, confirm the displayed path is on that drive. Device classification may say
   **unknown** when Windows does not provide reliable removable-media metadata; the path and
   capacity remain authoritative.
4. Load the synthetic demo and confirm capacity increases.
5. Close MemoryBridge, disconnect the drive, and reopen MemoryBridge.
6. Confirm the banner says **Vault disconnected**, mutation controls are unavailable, and it says
   nothing is saved elsewhere.
7. Reconnect the same drive at the same path.
8. Wait up to a few seconds. MemoryBridge should validate the manifest vault ID, reopen it, and
   restore the conversations. If Windows assigned a different drive letter, choose **Locate vault**
   and select it explicitly.

Expected: there is no hidden fallback vault and the restored vault ID matches the registered one.

## Test D — ChatGPT export

1. Use ChatGPT's data export process or locate an existing official ChatGPT export ZIP. Do not
   unzip or edit it.
2. In MemoryBridge choose **Imports & sync**, then **Choose file**.
3. Review discovered conversation/message counts and warnings before import.
4. Start the import and observe byte/conversation progress.
5. Review added, changed, unchanged, failed, branch, malformed, and warning counts.
6. Choose **Verify imported data**.
7. Open several imported conversations, including any marked for branch review.
8. Search an exact phrase from one conversation and open the exact source.
9. Import the same ZIP again. It should be reported unchanged.

MemoryBridge imports snapshots; it does not silently synchronize the ChatGPT sidebar.

## Test E — Intelligence

### Demo mode

1. Load the bundled demo.
2. Confirm a decision, completed item, and unresolved/project-state example appear.
3. Inspect all evidence and exact sources.
4. Treat these results only as workflow validation; demo extraction is deterministic synthetic
   behavior.

### Configured API provider

1. Open **Vault settings**, choose **OpenAI-compatible**, enter the documented endpoint and model
   names, and save an API key. A ChatGPT subscription is not an API credential.
2. Test authentication, chat, streaming, structured output, embeddings, and model listing
   separately.
3. Do not expect structured extraction if **structured output** is unavailable.
4. Run **Force reprocess selected chat** on copied/test data.
5. Review decisions and completed items, inspect every evidence source, and try confirm, edit, pin,
   reject, merge, supersede, and scope controls.
6. Add a later correction and verify current results supersede the older decision while history is
   still available when requested.

Provider calls can send selected bounded text to the configured endpoint.

## Test F — Failure recovery

1. Start a sizeable test ZIP import and choose **Cancel import**.
2. Confirm completed conversations remain and the import says cancelled/partial.
3. Retry the archive and confirm completed work is skipped.
4. Start processing, cancel it, then use **Resume processing**.
5. Close and reopen after a safe cancellation. Confirm chats and search remain available.
6. Temporarily disconnect an external test drive and follow Test C to verify recovery.

## Diagnostics

In **Vault settings**, choose **Copy diagnostic report** and paste it into a blank text editor before
sharing. Confirm it contains versions, provider/model names, safe status/count metadata, and
content-free events only. It must not contain:

- conversation or message text;
- memory statements or evidence;
- API keys or authorization headers;
- personal data;
- vault paths.

Report a failure with the diagnostic report, the test letter/step, the displayed error, and a
screenshot that contains no private conversation text.
