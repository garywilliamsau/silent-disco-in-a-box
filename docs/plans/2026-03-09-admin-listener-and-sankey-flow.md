# Admin Listener Screen & Channel-Switching Visualisation

Date: 2026-03-09

## Feature 1: Admin Listener Screen

### Summary
Full-screen listener experience with an admin overlay bar at the bottom, accessed via `/?admin=1`. Lets the DJ monitor and control from the dance floor without switching to the full admin panel.

### Authentication
- `/?admin=1` triggers a password prompt on first visit
- Token stored in localStorage (same password as admin panel)
- Subsequent visits skip the prompt

### Overlay Bar
Thin semi-transparent bar fixed at the bottom, above the existing track info/channel dots:
- **Listener counts**: "14 listeners - R:6 G:5 B:3" (live via WebSocket)
- **Skip button**: Small pill, only visible when current channel is in playlist mode (hidden for BT/Spotify/line-in)

### Data Flow
- Listener counts: already in every WS `update` message
- Source mode: already in WS update (`alsaMode`, `btMode`, `spotifyMode`)
- Skip: `POST /api/channels/:id/skip` with auth header

### Files Changed
- `web/index.html` - add hidden `#adminOverlay` div
- `web/css/main.css` - overlay bar styles
- `web/js/app.js` - detect `?admin=1`, auth flow, overlay updates, skip handler
- `server/server.js` - add `requireAdmin` to skip endpoint (security fix)

---

## Feature 2: Channel-Switching Visualisation (Sankey Flow)

### Summary
Sankey flow diagram in the Stats tab showing how listeners migrate between channels over time, correlated with what songs were playing. Answers: "which songs made people switch channels?"

### Data Collection (Server-Side)
On each WS `listen` message where `ws.channel` changes, log:

```json
{ "ts": 1709900000000, "from": "red", "to": "green", "songFrom": "Macarena", "songTo": "Bohemian Rhapsody" }
```

Captures what was playing on BOTH channels at the moment of the switch. Stored as append-only JSONL in `music/stats/channel-switches.jsonl`.

### Summary View (Sankey Diagram)
- Three vertical lanes (Red, Green, Blue), timeline top-to-bottom
- Time bucketed into 5-minute windows
- Each lane shows song blocks (narrow, like history Gantt)
- Curved bezier bands flow between lanes showing migration
- Band width = number of switches in that bucket
- Band colour = channel they're leaving
- 5-min bucket labels on left margin

### Drill-Down (Click a Time Bucket)
Clicking a 5-min bucket opens a detail panel:
- What was playing on each channel during that window
- List of switches: "3 left Red ('Macarena') -> Green ('Bohemian Rhapsody')"
- Net gain/loss per channel for that window

### Rendering
Pure canvas, no external libraries. Sankey curves are cubic beziers between lane positions, scaled by switch count.

### Files Changed
- `server/server.js` - log switches in WS handler, new `GET /api/admin/channel-switches` endpoint
- `web/js/admin.js` - Sankey render functions, drill-down panel
- `web/css/admin.css` - Sankey layout styles, drill-down panel
- `web/admin.html` - section in Stats tab for the flow chart
