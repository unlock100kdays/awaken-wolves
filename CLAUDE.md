# Awaken Wolves CRM

Dark-themed startup CRM for aggressive closers. Wolf-branded, red-on-black design.

## Project Structure

- `index.html` — Wolf landing page (animated wolf face SVG, blood moon, starfield)
- `login.html` — Login form (same dark theme, mini wolf logo)
- `dashboard.html` — CRM command center (sidebar, stats, leads table, pipeline)

## Deploy

- GitHub: https://github.com/unlock100kdays/awaken-wolves
- Live URL: https://awaken-wolves.pages.dev
- Push to `main` → GitHub Actions → Cloudflare Pages auto-deploys

## Design System

- Background: `#06060a` (near-black)
- Accent: `#cc1100` (wolf red)
- Blood: `#8b0000`
- Text: `#d8d8e0`
- Font: Palatino / Georgia (landing), system-ui (dashboard)
- Wolf SVG: front-facing snarling wolf head, viewBox 0 0 300 310

## Next Steps (CRM Features to Build)

- Real auth (login → JWT or session)
- Backend API for leads/deals CRUD
- Email integration
- Calendar / activity scheduling
- Reporting charts
