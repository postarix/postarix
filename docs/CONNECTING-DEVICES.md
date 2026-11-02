# Connecting mail, calendar and contacts apps

Postarix works in the browser (the webmail at your server's address) and with
the apps people already use: Thunderbird, Apple Mail and Calendar, Outlook,
DAVx⁵ on Android, and phone mail apps.

## 1. Create an app password

Apps never get your account password. In the admin panel, open **Your account →
App passwords** (from the webmail: your name → *Security and app passwords*)
and create one per app or device:

| The app needs | Choose |
|---|---|
| Reading mail (IMAP, POP3) | Mail |
| Sending mail (SMTP) | Sending |
| Calendars and contacts (CalDAV, CardDAV) | Calendars & contacts |

The password is shown once. Revoke it when a device is lost; nothing else changes.
With two-factor authentication on, app passwords are the only way apps can sign in.

## 2. Server settings

The user name is always your full email address. Replace `mail.example.com`
with your server's name.

| Service | Server | Port | Security |
|---|---|---|---|
| IMAP | mail.example.com | 993 | SSL/TLS |
| IMAP | mail.example.com | 143 | STARTTLS |
| POP3 | mail.example.com | 995 | SSL/TLS |
| SMTP | mail.example.com | 465 | SSL/TLS |
| SMTP | mail.example.com | 587 | STARTTLS |
| CalDAV | `https://mail.example.com/dav/calendars/user/you@example.com/` | 443 | HTTPS |
| CardDAV | `https://mail.example.com/dav/addressbooks/user/you@example.com/` | 443 | HTTPS |

Most calendar and contacts apps only need `https://mail.example.com`: they find
the rest through `/.well-known/caldav` and `/.well-known/carddav`.

Events and contacts created in the webmail and in your apps are the same data:
changes made in one place appear everywhere.
