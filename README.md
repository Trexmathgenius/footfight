# Footwork & Steel server

The online server for Footwork & Steel. It pairs players (quick match, or a private 4-letter room code)
and passes messages between the two players in a duel. It has no dependencies: plain Node.js 18 or newer.

## Put it on Render (free)

1. **Make a GitHub repository for it.** On github.com, create a new repository (for example
   `footwork-steel-server`), then use **Add file → Upload files** to upload these four files:
   `server.js`, `package.json`, `render.yaml`, `README.md`. Commit.
2. **Create the web service.** On dashboard.render.com choose **New → Web Service**, connect your
   GitHub account if asked, and pick the repository. Use these settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `node server.js`
   - Instance type: **Free**

   Then **Create Web Service**. (Alternatively choose **New → Blueprint** and pick the repository;
   `render.yaml` fills these in for you.)
3. **Check it.** When the deploy finishes, Render shows your address, like
   `https://footwork-steel-server.onrender.com`. Open it in a browser; you should see
   `Footwork & Steel server. 0 players connected.`
4. **Point the game at it.** The game's address is the same with `wss://` in front instead of `https://`,
   for example `wss://footwork-steel-server.onrender.com`. Put that in the game's `config.js` before you
   upload the game (see the game's README), or type it under **Online → Server** in the game.

## Good to know

- Render's free services go to sleep after about 15 minutes with nobody connected. The next player to
  open Online wakes it, which can take up to a minute; the game says so while it waits.
- If you change `NET_VERSION` in `server.js`, change it in the game too, or players will be told to update.

## Run it on your own computer

```
node server.js
```

It listens on port 10000 (or `PORT` if set). In the game, use `ws://localhost:10000` as the server.
