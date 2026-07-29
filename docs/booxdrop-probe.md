# BooxDrop endpoint probe

Task 10 of the implementation plan. BooxDrop's HTTP API is unofficial and
firmware-versioned, so this file records what was verified, when, and how to
re-derive it if a firmware update breaks the push.

## Verified 2026-07-29

- Device: Onyx Boox at `http://<device-ip>:8085` (LAN, BooxDrop app open)
- Server: Vue SPA titled "BOOX Drop"; `GET /` → 200 `text/html`, ~5.4 s response
  time on first load (an e-ink device on Wi-Fi is slow — allow generous timeouts)

### The endpoint

```
POST /api/library/upload
Content-Type: multipart/form-data; boundary=…
form field name: file
```

Success response is `200` with a JSON envelope:

```json
{ "code": 0, "successful": true, "data": { "location": "/storage/emulated/0/Books/<name>.epub", … } }
```

The uploaded file lands in the device's **Books library**
(`/storage/emulated/0/Books/`) and appears in the Library UI without any further
action.

### What was wrong before

`UPLOAD_PATH` shipped as `/api/std/upload` — a guess, not a documented path. It
does not exist on this firmware, so the push failed with **404** while the local
save succeeded (the spec's never-lose-an-export guarantee held).

### Sibling endpoint, deliberately not used

`POST /api/storage/upload` also accepts a file but drops it into general storage
rather than the Books library, so it would not appear as a book.

## How to re-probe after a firmware update

The device serves its own web client, and that client knows the API:

```bash
curl -s -m 60 -o /tmp/boox_app.js "http://<device-ip>:8085/js/app.js"
grep -oE '"/[a-zA-Z0-9_/.-]*"' /tmp/boox_app.js | sort -u | grep -i -E 'upload|library'
grep -oE '.{200}api/library/upload.{300}' /tmp/boox_app.js
```

The relevant call in the SPA is `uploadLibraryFile()`, which posts `FormData` to
the path above. Confirm with a small file before changing the plugin:

```bash
curl -sS -m 90 -X POST \
  -F "file=@/path/to/small.epub;type=application/epub+zip" \
  "http://<device-ip>:8085/api/library/upload"
```

A `"successful":true` body means the plugin's `UPLOAD_PATH` should match that
path. All BooxDrop knowledge lives in `src/booxdrop.ts` — nothing else needs to
change.

## Client behaviour notes

- `push()` treats a 2xx as necessary but not sufficient: it also fails the push
  when the JSON body reports `"successful": false` or a non-zero `"code"`, since
  the device can answer 200 for an application-level rejection (e.g. no space).
- A 2xx body that is not JSON is accepted — the status stands.
- `testConnection()` probes `GET /` and only distinguishes reachable from
  unreachable; it does not validate the upload path.
