# new yawk

A trip planner for NYC: food spots and events on a map, plus a day-by-day schedule.

## Run it

```bash
npm install
npm run dev     # restarts on server changes; open http://localhost:3000
```

Data is saved in `trip.db` (SQLite) next to `server.js`. Delete that file to start over.

## What's where

- `server.js`: Express server and SQLite tables (`places`, `schedule`, `settings`) with a small JSON API under `/api`.
- `public/index.html`: page layout (top bar, hero, Food & Events, Schedule, dialogs).
- `public/hero.js`: the particle "I ♥ NY" / "NYC" hero. Tuning settings are in `CFG` at the top.
- `public/app.js`: NYC clock, nav, list + filters, maps, add forms and schedule.
- `public/styles.css`: all styling. Colors are CSS variables at the top.

Maps use Leaflet with OpenStreetMap tiles. "Find" looks up addresses with OpenStreetMap's free
Nominatim service (limited to NYC). Neither needs an API key.
