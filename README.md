# Christmas Gift Draw (Vercel) - v2

## How it works
1. Organizer logs in (bottom link "Organizer") and adds NAMES only. Each person gets a personal code automatically.
2. Send each person their own code privately.
3. Participants open the site, enter their code, and fill in their own details (wishlist, sizes, color, notes). They can edit anytime.
4. When most people are done, organizer presses "Generate draw".
5. Participants enter their code again and press "Draw my number".
6. The organizer table shows who has drawn and who hasn't, and whose details are complete.

## Updating an existing deployment
Upload api/app.js and public/index.html to your GitHub repo (same folders, they overwrite the old files).
Vercel redeploys automatically. Keep your Upstash database and ADMIN_PASSWORD as they are.
