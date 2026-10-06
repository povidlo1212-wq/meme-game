# Foreign network reachability probe

This temporary service only checks whether a player's browser can reach an
Amvera application in a foreign region. It is not a payment gateway or game
backend. It does not read or store Telegram data, proxy requests, or connect
to the Russian application.

Deploy this folder as a separate Docker application in the Warsaw region.
Before creating the application, check its hourly tariff. Do not configure
Telegram tokens, payment secrets, Firebase credentials, or a database.

Open the new public HTTPS URL from an iPhone on Wi-Fi and mobile data, both
with and without the VPN used for the game. A successful response is exactly
`Foreign network probe is reachable`. Test the same URL several times, then
stop the application to avoid ongoing charges.

Run the local check with `node --test server.test.js`.
