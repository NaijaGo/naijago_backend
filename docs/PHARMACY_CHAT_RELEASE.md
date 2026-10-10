# Customer and pharmacist chat release

## Changes

- Customer entry restores the latest active consultation; an explicit session opens that conversation without starting another or buying access again.
- Sends use authenticated HTTP confirmation. Socket events deliver live updates; REST history recovers missed messages after reconnection or app resume.
- A message carries a random retry identity. Both HTTP and socket handlers persist that identity using MongoDB's existing primary index; retries return the stored message and do not broadcast or notify twice.
- Failed messages remain visible with Retry. Sent means stored by the backend; it does not claim the recipient has read the message.
- Both chat views have sender labels, timestamps, a compact header, connection status and a multiline composer. Your own messages appear on the right in either app.
- Pharmacist inbox cards use Open for assigned consultations and Claim for new ones. Atomic claims prevent simultaneous claims from overwriting assignment.
- The customer and assigned approved pharmacist can read the conversation. Approved pharmacists may preview paid, unassigned open requests before claiming. Unrelated pharmacists cannot read assigned history.
- Closing a chat keeps another authenticated inbox socket online. Explicit offline status stays offline.

## Local verification

Checked 11 October 2026 from local test logs:

| Repository | Full suite passed | Skipped | New chat tests |
| --- | ---: | ---: | ---: |
| naijagomainapp | 189 | 0 | 24 |
| go-vendor | 61 | 0 | 26 |
| naijago_backend | 333 | 8 | 34 |
| Total | 583 | 8 | 84 |

The skipped backend tests require external infrastructure. Local fixtures do not send real chat messages. Targeted Dart analysis reports no issues for both changed app screens, services, widgets and tests; backend syntax and whitespace checks passed. Full regressions include existing checkout, wallet, Squad, inventory, Google authentication and Image Studio fixtures. These results do not establish live provider or device behaviour.

Commands:

- Backend: node --test (without INVENTORY_TEST_MONGO_URI for fixture-only verification).
- Apps: flutter test --no-pub.
- Chat only: node --test test/pharmacyChat.test.js or flutter test --no-pub test/pharmacy_chat_test.dart.

## Deployment order

1. Deploy the updated naijago_backend on Render first. No new database collection, index migration or chat environment variable is required.
2. Build the updated customer and vendor apps in their separate Codemagic workflows. Preserve each app's existing signing, Google client IDs and payment configuration.
3. Install the new builds on two devices/accounts: a customer with chat access and an approved pharmacist.
4. Open an existing consultation and confirm the previous messages appear. Send one message each way and confirm each appears once.
5. Disconnect/reconnect the network, resume the app and refresh. Confirm missed messages appear. Retry a message whose confirmation was interrupted and confirm it is stored once.
6. Return to the pharmacist inbox. Confirm the assigned card says Open and opening it does not reclaim the consultation. Confirm closed consultations cannot send.

Legacy clients remain supported, but safe retry identity requires the new app builds and backend together. Failed messages that were never saved are only retained while that chat screen remains open.

The local patch has not itself verified Render deployment, push delivery or physical-device chat. Complete the two-account check before distributing the release.
