# Moving to Postarix

This guide moves an organization's mail, calendars and contacts from another
provider (Google Workspace, Microsoft 365, mailcow or any IMAP server) with as
little disruption as possible.

## 1. Prepare Postarix

1. Create the organization and add the domain (Admin → Domains). Publish the
   verification record and press **Verify**. Do not change the MX record yet.
2. Publish the other records the admin panel lists (SPF, DKIM, DMARC, MTA-STS,
   autoconfig). Mail keeps flowing to the old provider until MX changes.
3. Create a mailbox for every person, and aliases for shared addresses.

## 2. Copy the mail (imapsync)

[imapsync](https://imapsync.lamiral.info) copies every folder over IMAP and can be
run again: later runs only copy what changed.

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

- Export each calendar as `.ics` and each address book as `.vcf` from the old
  provider, then import them in a CalDAV/CardDAV client (Thunderbird, Apple
  Calendar/Contacts, DAVx⁵) connected to Postarix (see `CONNECTING-DEVICES.md`).
- From mailcow (SOGo), `sogo-tool backup` produces the same files.

## 4. Switch

1. A day before, lower the MX record's TTL (e.g. 300 s).
2. Change the MX record to the Postarix server (the admin panel shows it).
3. Run imapsync once more for each mailbox to pick up the last messages.
4. Ask people to sign in to the webmail and reconnect their phones and mail
   apps (autoconfig and Autodiscover set most of them up from the address).
5. Keep the old accounts for a couple of weeks: mail sent to the old MX by
   servers with stale DNS still arrives there, and imapsync can copy it over.

## 5. Single sign-on (optional)

If the organization signs in with Microsoft Entra ID, Google Workspace, Okta or
another OpenID Connect provider, connect it in Admin → Single sign-on. People
then sign in to the webmail and the admin panel with their company account;
mail apps keep using app passwords.
