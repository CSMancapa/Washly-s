# Washly's app

Customer side and admin side in one app, with Fuel Friend inside it.

- Customers create a free account (it isn't a subscription), see free times and book once-off washes or monthly packages. They can also move or cancel up to the day before, see their loyalty card and check fuel prices.
- The admin side (your account) has bookings, customers, booking for a customer, services and prices, and settings for times, days, loyalty and vehicle-size extras.
- Data lives in your free Supabase project. Prices, discounts, free washes and "one booking per time" are enforced by the database, not the page.

## Files
- `index.html`: the app
- `config.js`: your Supabase Project URL and anon/publishable key, plus contact details
- `vendor/supabase.js`: the Supabase library (kept here so the app doesn't depend on another website)
- `washlys-database.sql` (sent separately): run it once in Supabase's SQL Editor

## Setup (once)
1. Create a free project at supabase.com.
2. In SQL Editor, paste all of `washlys-database.sql` and click Run.
3. Go to Authentication → Sign In / Providers → Email and turn **off** "Confirm email". Then go to Authentication → URL Configuration, set Site URL to your Vercel address (e.g. `https://washlys.vercel.app/`) and add the same address under Redirect URLs.
4. Under Project Settings → API keys, copy the Project URL and the anon (publishable) key into `config.js`.
5. Deploy this folder on Vercel: Add New → Project → import a GitHub repository that contains this folder (or use `vercel deploy` from this folder). Framework preset: **Other**. No build command, no output directory.
6. Open the app, sign up with washlyscarwash@gmail.com, then run this in the SQL Editor:
   `update public.profiles set is_admin = true where email = 'washlyscarwash@gmail.com';`
   Reload the app and the admin tabs appear.

Optional: so "Forgot password" emails reach customers, set up custom SMTP (Authentication → Emails → SMTP Settings) with your Gmail and a Google app password. Supabase's built-in email only reaches your own team.

## Phones (iPhone and Android)
It's an installable web app: no app store needed.
- **Android (Chrome):** the app offers "Install the app", or use ⋮ → Install app / Add to Home screen.
- **iPhone (Safari):** Share → Add to Home Screen. Inside Instagram or Facebook, open the page in Safari first.
Once installed, it opens full-screen with the Washly's icon. If the signal drops, it still opens and shows the saved pages and Fuel Friend, with an "offline" banner; booking needs a connection.
After changing `vendor/` files or icons, raise `VERSION` in `sw.js` (e.g. washlys-v2) so phones fetch the new copies. Changes to `index.html` and `config.js` reach phones automatically.

## Changing things later
- Prices, services and what's included: admin side → Services
- Booking times, open days, how far ahead, loyalty card, SUV and minibus extras: admin side → Settings
- Promo codes: table `promos` in Supabase (Table Editor)
