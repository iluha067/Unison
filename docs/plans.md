# Plans

Unison has two plans. The only difference is how many devices can join a room.

| Plan | Price | Devices per room |
| --- | --- | --- |
| **Free** | $0 | up to 5 |
| **Pro** | $3 / month | unlimited |

Everyone can create rooms and sync for free. Pro simply removes the device cap
for a room, for as long as the license is valid.

## How it works

- Rooms run on the public Unison server. A room is identified by a random name
  (`unison-xxxxxxxxxx`), which is the secret shared in the invite code.
- A **Pro license key** is a signed token: `UNISON-<payload>.<signature>`.
- The server verifies the signature offline with its `LICENSE_SECRET` (no
  database, no callbacks) and upgrades that room to Pro.
- The key is entered once in **Settings -> Unison -> Plan** and is sent on join.

## Selling Pro

1. Create a payment page (Gumroad, Boosty, Stripe, ...) priced at $3 / month
   that delivers a file or message with a license key after purchase.
2. Point the plugin at it: edit `BUY_URL` near the top of `main.js` to your
   payment page, then cut a release. The **Get Pro** button opens that URL.
3. Issue a key for each payment with the bundled tool:

   ```bash
   cd server
   LICENSE_SECRET="your-server-secret" node make-license.js 1 "customer@example.com"
   # -> UNISON-eyJ2IjoxLCJwbGFuIjoicHJvIi... . <signature>
   ```

   The first argument is the duration in months, the second is an optional label.
4. Send the printed key to the customer. They paste it under **Plan**.

Gumroad can generate and email license keys automatically; if you use it, run
`make-license.js` yourself or adapt the script to your webhook.

## Server configuration

| variable | default | meaning |
| --- | --- | --- |
| `LICENSE_SECRET` | _(empty)_ | Secret used to verify license signatures. Required for Pro. |
| `MAX_CLIENTS_PER_ROOM` | `5` | Device cap on the Free plan. |
| `PRO_MAX_CLIENTS` | `1000` | Device cap on the Pro plan (effectively unlimited). |

Keep `LICENSE_SECRET` private and back it up: without it you cannot issue new
keys, and with it anyone could forge them.

## Notes

- Licenses are not tied to a person or a room; a valid key upgrades whichever
  room it is used in, until it expires.
- The Free cap counts connections, so a person on a laptop and a phone uses two
  slots.
- There is no billing in the plugin: you collect payment, then hand out a key.
