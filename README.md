# #humdat

#humdat is a room-code party game. Players mark songs they know, take turns recording a hummed clue, and race to name the song.

## Run locally

With Node.js 22 or newer, run `npm start` and open [http://localhost:3000](http://localhost:3000). No dependencies or accounts are required. To play on one computer, create a room in the first tab, then join by code with a different name in a second tab. Use headphones when recording to avoid picking up another tab’s audio.

For play on separate devices, serve the same running Node process behind HTTPS and share that HTTPS URL. Browsers allow microphone access on HTTPS and on localhost. A plain HTTP link to your computer’s LAN address won’t allow recording on a phone. If you use a reverse proxy, disable buffering for the room event stream. Set the `PORT` environment variable to change the server port.

## Host the HTTPS playtest

[Deploy to Render](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Flucas-hhk%2FKCL-first-year-hack) with a Render account that has access to this repository. Approve the free web service and share the HTTPS URL shown on the service dashboard. The service uses the same URL after waking from idle. The first visit after an idle period can take about a minute.

## Play a game

1. Create a room and share the code or invite link. Two to ten people can play.
2. Each player marks songs they know or adds favourites by title and artist. Every song marked by at least two connected players goes into the game.
3. The host starts the game. The singer privately sees a song and records up to 12 seconds. Stopping the recording sends the clue automatically.
4. The clue plays automatically when the shared 20-second guessing timer starts. Correct guesses earn 20–100 points based on speed. The singer earns up to 100 points.
5. After each reveal, the host advances to the next queued song. Singers rotate among players who know the song. Once the queue ends, the host can show the final scores and start a rematch.

Room state and the current recording live in server memory. The recording is dropped when the host advances. Rooms expire after an hour of inactivity and reset when the server restarts.

The host can open **Add a melody reference** in the lobby and hum or provide a short solo melody clip for a song. Use the same section when singing the clue. The game compares the notes while allowing for a different key and some timing variation. If a reference or a usable pitch track is unavailable, the singer earns points based on the share of listeners who guessed correctly.

Run the game-flow checks with `npm test`.
