# Moving to Postarix

This guide moves an organization's mail, calendars and contacts from another
provider (Google Workspace, Microsoft 365, mailcow or any IMAP server) with as
little disruption as possible and no lost mail.

## 1. Prepare Postarix

1. Create the organization and add the domain (Admin → Domains). Publish the
   verification record and press **Verify**. Do not change the MX record yet.
2. Publish the other records the admin panel lists (SPF, DKIM, DMARC, MTA-STS,
   autoconfig). Mail keeps flowing to the old provider until MX changes.
3. Create a mailbox for every person (same addresses as before), and aliases
   for shared addresses.
4. A day before the switch, lower the MX record's TTL (e.g. 300 s).

## 2. Copy the mail

### Each person, from the webmail

People sign in to the webmail with their new mailbox and open **their menu ›
Import mail from another account**. They enter their old address and password;
Postarix checks the account, then copies every folder in the background
(folders keep their names, special folders such as Sent and Trash map to ours,
read and flagged marks are kept). The webmail can be closed meanwhile; the
dialog shows the progress. Nobody has to hand a password to an administrator.

| Old provider | Server | Password |
| --- | --- | --- |
| Gmail / Google Workspace | `imap.gmail.com` (filled in) | An [app password](https://myaccount.google.com/apppasswords); the account needs 2-step verification. Workspace admins must allow IMAP. |
| Yahoo, iCloud, Fastmail | filled in | An app password. |
| mailcow, Dovecot, other providers | their IMAP server, port 993 (TLS) or 143 (STARTTLS) | The usual password. |
| Microsoft 365, Outlook.com | — | Not supported this way: Microsoft no longer accepts passwords from other apps (OAuth only). Use imapsync (below). |

Notes:

- Gmail's labels appear as folders, so a message with two labels is copied
  into both. "All Mail", "Starred" and "Important" are skipped (they only show
  messages that are already in other folders).
- Messages larger than the server's upload limit (50 MB by default) are
  skipped and counted.
- If the import stops (the mailbox is full, the old provider limits
  downloads), start it again: it resumes where it stopped. Importing the same
  account again later copies only what arrived since.
- The old password is stored encrypted while the import runs and erased when
  it ends.
- Old servers on a private network (not reachable from the Internet) must be
  allowed by the administrator: `MAIL_IMPORT_ALLOWED_HOSTS` (Compose) or
  `api.mailImportAllowedHosts` (Helm). Imports otherwise only reach public
  servers on the standard IMAP ports.

### Administrators, in bulk (imapsync)

For Microsoft 365, or to migrate many mailboxes at once with an admin
account, use [imapsync](https://imapsync.lamiral.info). It copies every folder
over IMAP and can be run again: later runs only copy what changed.

```bash
imapsync \
  --host1 imap.old-provider.example --user1 ana@example.com --password1 'old password' \
  --host2 mail.example.com          --user2 ana@example.com --password2 'Postarix password' \
  --ssl1 --ssl2 --automap --syncinternaldates
```

Use an **app password** on the Postarix side if the account has two-step
verification. `--automap` maps special folders (Sent, Drafts, Trash, Junk) to
Postarix' folders.

- **Google Workspace:** create an app password for each user (or use OAuth with
  `--authmech1 XOAUTH2`), add `--gmail1`, and exclude the "All Mail" and
  "Important" labels to avoid duplicates (`--exclude '\[Gmail\]/All Mail'`).
- **Microsoft 365:** add `--office1`; modern authentication needs OAuth
  (`--authmech1 XOAUTH2 --oauthaccesstoken1 …`).
- **mailcow / Dovecot:** plain IMAP works as shown. A master user
  (`--authuser1`) avoids collecting passwords.

For many mailboxes, put one line per user in a file and loop over it; run the
first copy days before the switch so the final one is quick.

## 3. Calendars and contacts

- **Calendar:** export it from the old provider as an `.ics` file (Google
  Calendar: Settings › Import and export › Export; Outlook: save the calendar
  as iCalendar; mailcow/SOGo: `sogo-tool backup`), then in the webmail's
  Calendar choose **Import events (.ics)**. Events become the person's own;
  guests are not invited again.
- **Contacts:** export them as a `.vcf` (vCard) file (Google Contacts: Export ›
  vCard; Outlook: export to vCard), then in Contacts choose **Import contacts
  (.vcf)**. People already in the address book are skipped.

Files can be imported again: events already there (same UID) and contacts with
a known address are skipped. A CalDAV/CardDAV client (Thunderbird, Apple
Calendar/Contacts, DAVx⁵) connected to Postarix works too (see
`CONNECTING-DEVICES.md`).

## 4. Switch

1. Change the MX record to the Postarix server (the admin panel shows it).
2. The next day, copy the mail once more (**Import mail** again with the same
   old account, or another imapsync run) to pick up the last messages.
3. Ask people to sign in to the webmail and reconnect their phones and mail
   apps (autoconfig and Autodiscover set most of them up from the address).
4. Keep the old accounts for a couple of weeks: mail sent to the old MX by
   servers with stale DNS still arrives there, and another import copies it
   over. Then raise the MX TTL again.

## 5. Single sign-on (optional)

If the organization signs in with Microsoft Entra ID, Google Workspace, Okta or
another OpenID Connect or SAML provider, connect it in Admin → Sign-in. People
then sign in to the webmail and the admin panel with their company account;
mail apps keep using app passwords.
