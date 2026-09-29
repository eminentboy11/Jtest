# Running on Replit

This project is a Node.js 20 WhatsApp bot with a web pairing page. Keep the existing single-process setup; bot data and WhatsApp credentials are saved to the gitignored `data/` and `auth/` directories. Do not run multiple copies against those directories.

The **Start application** workflow runs `PORT=5000 npm start` and serves the pairing page in the Replit web preview at `/`. Use the preview to pair a test WhatsApp account via QR or pairing code; the account owner must complete pairing in WhatsApp. The app does not need a database or credentials to show the pairing page. Optional GitHub cold archiving needs its own configuration and token; it is disabled by default.

Run `npm test` for the test suite. The repository's structure test excludes Replit's injected `.local/` and `.agents/` helpers.