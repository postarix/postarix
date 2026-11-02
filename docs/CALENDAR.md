# Calendar: invitations, free/busy and sharing

Postarix keeps calendars and address books in Cyrus (CalDAV/CardDAV), and the
webmail reads them over JMAP. This page covers what happens between people.

## Invitations

Inviting is done from the webmail's event dialog (Guests) or through the API:

| Endpoint | What it does |
|---|---|
| `PUT /api/calendar/events/:id/guests` `{ "guests": ["…"] }` | Sets the guests of one of your events and emails them the invitation (or the update). People taken off the list get a cancellation. At most 50 guests. |
| `POST /api/calendar/events/:id/cancel` | Deletes the event and tells its guests. |
| `GET /api/mail/messages/:id/invitation` | What a calendar message in your mail is (invitation, answer, cancellation) and what you can do with it. |
| `POST /api/mail/messages/:id/invitation/respond` `{ "response": "accepted" \| "tentative" \| "declined" }` | Answers an invitation: puts the event in your calendar (or takes it out) and emails the organizer. |
| `POST /api/mail/messages/:id/invitation/apply` | Applies an answer (you organize the event) or a cancellation (you were invited) to your calendar. |

How it works:

- Messages follow iTIP over email (RFC 5546, RFC 6047), so guests can use any
  calendar app (Outlook, Gmail, Apple Calendar, Thunderbird).
- Cyrus' own scheduling stays off (`caldav_allowscheduling: off`): Cyrus never
  sends mail. The API builds each message from Cyrus' iCalendar for the event
  and sends it through Postfix's internal submission port, from your own
  address, counted in your hourly sending limits like any other mail.
- Nothing in your calendar changes because a message arrived. You decide, from
  the message. A cancellation is applied only when it comes from the organizer
  of the event you have; an answer only when it comes from the guest it speaks
  for. Postfix and Rspamd check senders (SPF, DKIM, DMARC) before that.
- Guests and organizers are set only through these endpoints: the webmail's
  JMAP access cannot set them directly.
- CalDAV apps on phones and computers see the guests of an event but do not send
  invitations themselves through Postarix: invite from the webmail.

## Free/busy

`GET /api/calendar/availability?emails=a@…,b@…&from=…&to=…` returns when the
given colleagues are busy (at most 20 people and 62 days). Only times are
returned, never titles or places. Events marked free, cancelled ones and ones
the person declined do not count. Addresses outside your organization (or that
do not exist) are listed as `unavailable`, the same either way, so nothing
about other organizations can be learned.

## Sharing

`GET /api/calendar/sharing` lists your calendars and address book with whom
each is shared; `PUT /api/calendar/sharing/calendars/:id` and
`PUT /api/calendar/sharing/address-books/Default` replace the list
(`{ "shares": [{ "email": "…", "access": "read" | "write" }] }`). People added
must be in your organization. "read" lets them see the events (and your
free/busy) or contacts; "write" also lets them change them.

Shared calendars and contacts appear in the webmail (Calendar → "Shared with
you", and in Contacts) and in CalDAV/CardDAV apps.

Sharing is stored as Cyrus ACLs on the calendar or address book. Cyrus gives
"anyone" the right to read every calendar's free/busy by default; Postarix
removes it for every mailbox (new ones when they are created, existing ones in
the background when the API starts), so free/busy cannot be read across
organizations.
